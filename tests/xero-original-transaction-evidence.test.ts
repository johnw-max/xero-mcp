import { describe, expect, it, vi } from "vitest";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import { resolveSupportedAccountingMonetaryRule } from "../src/control-kernel/accountingMonetary.js";
import type { NativeDocumentFact } from "../src/domain/accountingCase.js";
import { createXeroAccountingCaseProviderContract } from "../src/policy/xeroAccountingCaseProviderContract.js";
import {
  createXeroOriginalTransactionEvidence,
  XeroOriginalTransactionEvidenceError,
} from "../src/policy/xeroOriginalTransactionEvidence.js";
import { createXeroDeclaredLedgerPolicy } from "../src/policy/xeroDeclaredLedgerPolicy.js";
import { bindXeroDeclaredLedger, type XeroDeclaredLedgerBinding } from "../src/policy/xeroDeclaredLedgerBinding.js";
import { lookupXeroOriginalTransaction } from "../src/services/xeroBusinessCoordinateHistory.js";
import type { AccountSummary, InvoiceSnapshot, TaxRateSummary } from "../src/providers/types.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "44444444-4444-4444-8444-444444444444";

// ADR-002: the caller declares the exact live Xero account/tax coordinate and
// the server verifies it against the tenant's own chart of accounts and tax
// rates. These fixtures stand in for that live tenant data.
const TEST_LEDGER_ACCOUNTS: readonly AccountSummary[] = [
  { accountId: "33333333-3333-4333-8333-333333333333", code: "200", name: "Consulting Revenue", status: "ACTIVE", type: "REVENUE", class: "REVENUE" },
  { accountId: "33333333-3333-4333-8333-333333333353", code: "453", name: "Office Supplies", status: "ACTIVE", type: "EXPENSE", class: "EXPENSE" },
];
const TEST_LEDGER_TAX_RATES: readonly TaxRateSummary[] = [
  { taxType: "OUTPUTY24", name: "GST on Income", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true },
  { taxType: "INPUTY24", name: "GST on Expenses", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToExpenses: true },
];
function testLedgerBinding(forTenantId: string): XeroDeclaredLedgerBinding {
  return bindXeroDeclaredLedger({
    tenantId: forTenantId,
    jurisdiction: "SG",
    accountCodes: TEST_LEDGER_ACCOUNTS.map((account) => account.code!),
    taxTypes: TEST_LEDGER_TAX_RATES.map((taxRate) => taxRate.taxType),
    accounts: TEST_LEDGER_ACCOUNTS,
    taxRates: TEST_LEDGER_TAX_RATES,
  });
}

function credit(overrides: Partial<NativeDocumentFact> = {}): NativeDocumentFact {
  return {
    factId: "credit-fact",
    lineageKey: "credit-lineage",
    eventKey: "credit-event",
    sourceUnitIds: ["credit-unit"],
    origin: "MODEL_EXTRACTED",
    revision: 1,
    kind: "NATIVE_DOCUMENT",
    documentKind: "CREDIT_NOTE",
    counterpartyRole: "CUSTOMER",
    reference: "CN-001",
    referenceKind: "FORMAL_DOCUMENT_NUMBER",
    documentDate: "2027-01-15",
    currency: "SGD",
    contactName: "Historical Customer",
    taxPolicyBasis: "ORIGINAL_TRANSACTION",
    originalDocumentReference: "INV-OLD-001",
    originalDocumentReferenceKind: "FORMAL_DOCUMENT_NUMBER",
    originalDocumentDate: "2026-07-01",
    lineAmountType: "EXCLUSIVE",
    lines: [{
      lineId: "credit-line-1",
      description: "Partial service credit",
      quantity: "1",
      unitAmount: "100.00",
      sourceTax: "9.00",
      accountCode: "200",
      taxType: "OUTPUTY24",
    }],
    declaredNet: "100.00",
    declaredTax: "9.00",
    declaredGross: "109.00",
    allocationStatus: "UNALLOCATED",
    documentValidity: "VALID_FOR_LIVE_BOOKS",
    ...overrides,
  };
}

function original(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    invoiceId,
    tenantId,
    type: "ACCREC",
    status: "AUTHORISED",
    contact: { contactId, name: "Historical Customer" },
    invoiceDate: "2026-07-01",
    currency: "SGD",
    invoiceNumber: " inv-old-001 ",
    reference: "supplementary-reference-must-not-authorise-formal-number",
    subTotal: "200.0000",
    totalTax: "18.0000",
    total: "218.0000",
    amountDue: "218.0000",
    amountPaid: "0.0000",
    amountCredited: "0.0000",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Original service",
      quantity: "2.0000",
      unitAmount: "100.0000",
      lineAmount: "200.0000",
      taxAmount: "18.0000",
      accountId: "33333333-3333-4333-8333-333333333333",
      accountCode: "200",
      taxType: "OUTPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
    ...overrides,
  };
}

function supplierCredit(): NativeDocumentFact {
  return credit({
    factId: "supplier-credit-fact",
    lineageKey: "supplier-credit-lineage",
    eventKey: "supplier-credit-event",
    counterpartyRole: "SUPPLIER",
    reference: "SCN-001",
    contactName: "Historical Supplier",
    originalDocumentReference: "BILL-SUPPLIER-001",
    lines: [{
      lineId: "credit-line-1",
      description: "Partial service credit",
      quantity: "1",
      unitAmount: "100.00",
      sourceTax: "9.00",
      accountCode: "453",
      taxType: "INPUTY24",
    }],
  });
}

function originalBill(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return original({
    type: "ACCPAY",
    contact: { contactId, name: "Historical Supplier" },
    invoiceNumber: " bill-supplier-001 ",
    reference: "supplementary-reference-must-not-authorise-provider-identifier",
    lines: [{
      ...original().lines[0]!,
      accountId: "33333333-3333-4333-8333-333333333353",
      accountCode: "453",
      taxType: "INPUTY24",
    }],
    ...overrides,
  });
}

function resolvedEvidence(rawCredit = credit(), snapshot = original()) {
  const accountingPolicy = createXeroDeclaredLedgerPolicy({
    jurisdiction: "SG",
    paysTax: true,
    ledgerBinding: testLedgerBinding(tenantId),
  });
  const monetary = resolveSupportedAccountingMonetaryRule(accountingPolicy, rawCredit.currency);
  if (!monetary.rule) throw new Error("test monetary rule missing");
  return createXeroOriginalTransactionEvidence({
    credit: rawCredit,
    snapshot,
    expectedTenantId: tenantId,
    expectedContactId: contactId,
    checkedObjectCount: 1,
    accounts: TEST_LEDGER_ACCOUNTS,
    taxRates: TEST_LEDGER_TAX_RATES,
    monetaryRule: monetary.rule,
  });
}

function compileCredit(rawCredit: NativeDocumentFact, snapshot = original()) {
  const resolved = resolvedEvidence(rawCredit, snapshot);
  const sealedCredit = { ...rawCredit, originalTransactionEvidenceHash: resolved.evidence.evidenceHash };
  const policy = createXeroDeclaredLedgerPolicy({
    jurisdiction: "SG",
    paysTax: true,
    ledgerBinding: testLedgerBinding(tenantId),
  });
  return compileAccountingCase({
    caseId: "historical-credit-case",
    expectedVersion: 0,
    target: {
      tenantId,
      environment: "PRODUCTION",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      organisationStatus: "ACTIVE",
    },
    sources: [{
      artifactId: "credit-source",
      label: "Historical credit",
      units: [{ unitId: "credit-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [sealedCredit, resolved.evidence],
  }, policy, createXeroAccountingCaseProviderContract(
    new Map([[sealedCredit.factId, { contactId }]]),
    testLedgerBinding(tenantId),
    undefined,
    undefined,
    new Map([[resolved.evidence.evidenceHash, resolved.binding]]),
  ));
}

describe("Xero historical original-transaction evidence", () => {
  it("seals a provider-neutral creditable original and accepts a partial line subset at the original period rate", () => {
    const resolved = resolvedEvidence();
    expect(JSON.stringify(resolved.evidence)).not.toContain(invoiceId);
    expect(resolved.evidence).not.toHaveProperty("counterpartyRole");
    expect(resolved.evidence).toMatchObject({
      authoritativeProviderField: "INVOICE_NUMBER",
      reference: "INV-OLD-001",
    });
    expect(resolved.evidence.lines[0]).toMatchObject({
      quantity: "2.0000",
      accountCode: "200",
      taxType: "OUTPUTY24",
      effectiveTaxRateBps: 900,
      taxSemantics: "OUTPUTY24",
    });
    const compiled = compileCredit(credit());
    expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(compiled.operations).toHaveLength(1);
    expect(compiled.operations[0]).toMatchObject({
      nativeRoute: "CUSTOMER_CREDIT",
      actionId: "credit_note.create_draft",
    });
    expect(compiled.activeFacts.filter((fact) => fact.kind === "ORIGINAL_TRANSACTION_EVIDENCE"))
      .toHaveLength(1);
  });

  it("uses InvoiceNumber as the authoritative formal coordinate for an historical supplier bill", async () => {
    const rawCredit = supplierCredit();
    const resolved = resolvedEvidence(rawCredit, originalBill());
    expect(resolved.evidence).toMatchObject({
      originalRoute: "SUPPLIER_BILL",
      authoritativeProviderField: "INVOICE_NUMBER",
      reference: "BILL-SUPPLIER-001",
    });
    expect(resolved.evidence.lines[0]).toMatchObject({
      accountCode: "453",
      taxType: "INPUTY24",
      taxSemantics: "INPUTY24",
    });

    const reader = {
      listInvoices: vi.fn(async (_principal, input) => ({
        invoices: [{ ...originalBill(), lines: [] }],
        pagination: {
          page: 1,
          pageSize: 100,
          returned: 1,
          providerPageCount: 1,
          providerItemCount: 1,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
          omittedOverflow: 0,
        },
      })),
      getInvoice: vi.fn(async () => originalBill()),
      listCreditNotes: vi.fn(),
      getCreditNote: vi.fn(),
    };
    await expect(lookupXeroOriginalTransaction({
      reader,
      principal: {} as never,
      originalRoute: "SUPPLIER_BILL",
      contactId,
      reference: "BILL-SUPPLIER-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-01",
    })).resolves.toMatchObject({ state: "EXACT_ONE", providerObjectId: invoiceId });
    expect(reader.listInvoices).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "ACCPAY",
      contact_id: contactId,
    }));
  });

  it("consumes original lines as a multiset and rejects two credit lines that reuse one original quantity", () => {
    const duplicated = credit({
      lines: [{
        lineId: "credit-line-1",
        description: "First credit",
        quantity: "1",
        unitAmount: "100.00",
        sourceTax: "9.00",
        accountCode: "200",
        taxType: "OUTPUTY24",
      }, {
        lineId: "credit-line-2",
        description: "Second credit",
        quantity: "1",
        unitAmount: "100.00",
        sourceTax: "9.00",
        accountCode: "200",
        taxType: "OUTPUTY24",
      }],
      declaredNet: "200.00",
      declaredTax: "18.00",
      declaredGross: "218.00",
    });
    const compiled = compileCredit(duplicated, original({
      subTotal: "100.0000",
      totalTax: "9.0000",
      total: "109.0000",
      lines: [{ ...original().lines[0]!, quantity: "1.0000", lineAmount: "100.0000", taxAmount: "9.0000" }],
    }));
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.events[0]?.reasonCodes).toContain("CREDIT_LINE_NOT_A_CONSUMABLE_ORIGINAL_SUBSET");
    expect(compiled.operations).toEqual([]);
  });

  it("uses the original transaction date, not the later credit date, to admit the credit", () => {
    expect(compileCredit(credit({ documentDate: "2027-12-31" })).status).toBe("PLANNED_NEEDS_PREFLIGHT");
  });

  // ADR-002: the MCP holds no jurisdiction rate-period table, so an original
  // transaction is no longer rejected merely for being historic. The tenant's
  // live tax rate is proven directly against the declared line amounts
  // instead; ORIGINAL_TAX_POLICY_PERIOD_UNSUPPORTED no longer exists.
  it("does not reject an historic original solely for its transaction date", () => {
    const historic = credit({ originalDocumentDate: "2023-06-01" });
    expect(() => resolvedEvidence(historic, original({ invoiceDate: "2023-06-01" }))).not.toThrow();
  });

  it.each(["DRAFT", "SUBMITTED", "DELETED", "VOIDED", "UNKNOWN"])(
    "rejects non-posted provider status %s",
    (status) => {
      expect(() => resolvedEvidence(credit(), original({ status })))
        .toThrowError(XeroOriginalTransactionEvidenceError);
    },
  );

  it("fails closed on complete-history ambiguity and never relies on exact GET alone", async () => {
    const first = original();
    const second = original({ invoiceId: "55555555-5555-4555-8555-555555555555" });
    const reader = {
      listInvoices: vi.fn(async () => ({
        invoices: [first, second],
        pagination: {
          page: 1,
          pageSize: 100,
          returned: 2,
          providerPageCount: 1,
          providerItemCount: 2,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
          omittedOverflow: 0,
        },
      })),
      getInvoice: vi.fn(),
      listCreditNotes: vi.fn(),
      getCreditNote: vi.fn(),
    };
    await expect(lookupXeroOriginalTransaction({
      reader,
      principal: {} as never,
      originalRoute: "SALES_INVOICE",
      contactId,
      reference: "INV-OLD-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-01",
    })).resolves.toMatchObject({ state: "AMBIGUOUS", checkedObjectCount: 2 });
    expect(reader.getInvoice).not.toHaveBeenCalled();
  });

  it("does not hide a tenant-wide AR formal-number owner behind a different contact filter", async () => {
    const otherContact = "66666666-6666-4666-8666-666666666666";
    const owned = original({ contact: { contactId: otherContact, name: "Different Customer" } });
    const reader = {
      listInvoices: vi.fn(async () => ({
        invoices: [{ ...owned, lines: [] }],
        pagination: {
          page: 1,
          pageSize: 100,
          returned: 1,
          providerPageCount: 1,
          providerItemCount: 1,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
          omittedOverflow: 0,
        },
      })),
      getInvoice: vi.fn(async () => owned),
      listCreditNotes: vi.fn(),
      getCreditNote: vi.fn(),
    };
    await expect(lookupXeroOriginalTransaction({
      reader,
      principal: {} as never,
      originalRoute: "SALES_INVOICE",
      contactId,
      reference: "INV-OLD-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-01",
    })).resolves.toMatchObject({
      state: "INCOMPLETE",
      reasonCodes: ["EXACT_PROVIDER_GET_CONTACT_MISMATCH"],
    });
    expect(reader.listInvoices).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({
      contact_id: expect.anything(),
    }));
  });

  it.each([
    ["NONE", [], {
      page: 1,
      pageSize: 100,
      returned: 0,
      providerPageCount: 1,
      providerItemCount: 0,
      hasNextPage: false,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
      omittedOverflow: 0,
    }],
    ["INCOMPLETE", [original()], {
      page: 1,
      pageSize: 100,
      returned: 1,
      hasNextPage: false,
      hasNextPageIsEstimated: true,
      omittedInvalid: 0,
      omittedOverflow: 0,
    }],
  ] as const)("returns %s without exact GET when original history cannot prove EXACT_ONE", async (state, invoices, pagination) => {
    const reader = {
      listInvoices: vi.fn(async () => ({ invoices: structuredClone([...invoices]), pagination })),
      getInvoice: vi.fn(),
      listCreditNotes: vi.fn(),
      getCreditNote: vi.fn(),
    };
    await expect(lookupXeroOriginalTransaction({
      reader,
      principal: {} as never,
      originalRoute: "SALES_INVOICE",
      contactId,
      reference: "INV-OLD-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-01",
    })).resolves.toMatchObject({ state });
    expect(reader.getInvoice).not.toHaveBeenCalled();
  });
});
