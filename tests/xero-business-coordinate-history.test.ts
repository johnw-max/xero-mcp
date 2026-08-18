import { describe, expect, it, vi } from "vitest";
import type {
  AccountingCaseOperation,
  AccountingCaseTarget,
  NativeDocumentFact,
  NativeDocumentRoute,
} from "../src/domain/accountingCase.js";
import type {
  CreditNoteListResult,
  CreditNoteSnapshot,
  InvoiceListResult,
  InvoiceSnapshot,
} from "../src/providers/types.js";
import {
  lookupXeroProviderBusinessCoordinate,
  type XeroBusinessCoordinateHistoryReadPort,
} from "../src/services/xeroBusinessCoordinateHistory.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { createXeroAccountingCaseProviderContract } from "../src/policy/xeroAccountingCaseProviderContract.js";
import {
  parseXeroAccountingCaseBusinessAuthorityProfiles,
  xeroDocumentCoordinateAuthority,
} from "../src/policy/xeroBusinessCoordinateAuthority.js";
import { bindXeroDeclaredLedger, type XeroDeclaredLedgerBinding } from "../src/policy/xeroDeclaredLedgerBinding.js";
import type { AccountSummary, TaxRateSummary } from "../src/providers/types.js";
import { hashObject } from "../src/security/hash.js";

const contactId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const context = Object.freeze({ actorId: "history-test" }) as RequestContext;

// ADR-002: the caller declares the exact live Xero account/tax coordinate and
// the server verifies it against the tenant's own chart of accounts and tax
// rates, so a "contract" here just needs one small, internally consistent
// live ledger binding rather than a semantic category profile.
const TEST_LEDGER_ACCOUNTS: readonly AccountSummary[] = [
  { accountId: "44444444-4444-4444-8444-444444444444", code: "400", name: "Consulting Revenue", status: "ACTIVE", type: "REVENUE", class: "REVENUE" },
];
const TEST_LEDGER_TAX_RATES: readonly TaxRateSummary[] = [
  { taxType: "OUTPUTY24", name: "GST on Income", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true },
];
function testLedgerBinding(tenantId: string): XeroDeclaredLedgerBinding {
  return bindXeroDeclaredLedger({
    tenantId,
    jurisdiction: "SG",
    accountCodes: TEST_LEDGER_ACCOUNTS.map((account) => account.code!),
    taxTypes: TEST_LEDGER_TAX_RATES.map((taxRate) => taxRate.taxType),
    accounts: TEST_LEDGER_ACCOUNTS,
    taxRates: TEST_LEDGER_TAX_RATES,
  });
}

function operation(route: NativeDocumentRoute): AccountingCaseOperation {
  const credit = route === "CUSTOMER_CREDIT" || route === "SUPPLIER_CREDIT";
  const reference = `${credit ? "CN" : "INV"}-HISTORY-001`;
  const authority = xeroDocumentCoordinateAuthority(route, "FORMAL_DOCUMENT_NUMBER");
  const canonicalPayload = {
    reference,
    referenceKind: "FORMAL_DOCUMENT_NUMBER",
    documentDate: "2026-07-20",
    dueDate: "2026-08-20",
    currency: "SGD",
    xeroContactId: contactId,
    authoritativeProviderField: authority.authoritativeProviderField,
    uniquenessAuthority: authority.uniquenessAuthority,
    lineAmountType: "EXCLUSIVE",
    net: "100.0000",
    tax: "9.0000",
    gross: "109.0000",
    lines: [{
      description: "Consulting",
      quantity: "1.0000",
      unitAmount: "100.0000",
      net: "100.0000",
      tax: "9.0000",
      accountId: "44444444-4444-4444-8444-444444444444",
      accountCode: "400",
      taxType: "OUTPUTY24",
    }],
  };
  return {
    actionId: route === "SALES_INVOICE"
      ? "customer_invoice.create_draft"
      : route === "SUPPLIER_BILL"
        ? "supplier_bill.create_draft"
        : "credit_note.create_draft",
    nativeRoute: route,
    target: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      environment: "PRODUCTION",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      organisationStatus: "ACTIVE",
    },
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    businessReservation: {
      schemaVersion: "accounting-case-business-reservation:v1",
      providerId: "xero",
      kind: "LEDGER_DOCUMENT_OCCURRENCE",
      canonicalFields: {
        route,
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        authoritativeProviderField: authority.authoritativeProviderField,
        uniquenessAuthority: authority.uniquenessAuthority,
        normalizationVersion: "xero-reference-coordinate:v1",
        reference,
        ...(authority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER" ? { contactId } : {}),
      },
      coordinateHash: "a".repeat(64),
      scope: "ALL_OCCURRENCES",
    },
  } as unknown as AccountingCaseOperation;
}

function completePagination(returned: number) {
  return {
    page: 1,
    pageSize: 100,
    returned,
    providerPageCount: 1,
    providerItemCount: returned,
    hasNextPage: false,
    hasNextPageIsEstimated: false,
    omittedInvalid: 0,
  };
}

function invoiceSnapshot(type: "ACCREC" | "ACCPAY", reference: string): InvoiceSnapshot {
  return {
    invoiceId: objectId,
    tenantId: "11111111-1111-4111-8111-111111111111",
    type,
    status: "DRAFT",
    contact: { contactId },
    invoiceDate: "2026-07-20",
    dueDate: "2026-08-20",
    currency: "SGD",
    invoiceNumber: reference,
    reference: "supplementary-reference-must-not-authorise-provider-identifier",
    subTotal: "100.0000",
    totalTax: "9.0000",
    total: "109.0000",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Consulting",
      quantity: "1.0000",
      unitAmount: "100.0000",
      lineAmount: "100.0000",
      taxAmount: "9.0000",
      accountId: "44444444-4444-4444-8444-444444444444",
      accountCode: "400",
      taxType: "OUTPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
  };
}

function creditSnapshot(type: "ACCRECCREDIT" | "ACCPAYCREDIT", reference: string): CreditNoteSnapshot {
  return {
    creditNoteId: objectId,
    tenantId: "11111111-1111-4111-8111-111111111111",
    type,
    status: "DRAFT",
    contact: { contactId },
    creditNoteDate: "2026-07-20",
    dueDate: "2026-08-20",
    currency: "SGD",
    creditNoteNumber: reference,
    ...(type === "ACCRECCREDIT"
      ? { reference: "supplementary-reference-must-not-authorise-provider-identifier" }
      : {}),
    subTotal: "100.0000",
    totalTax: "9.0000",
    total: "109.0000",
    attachmentsKnown: true,
    associatedInvoiceIds: [],
    associatedInvoiceIdCount: 0,
    associatedInvoiceIdsTruncated: false,
    lineAmountType: "Exclusive",
    lines: [{
      description: "Consulting",
      quantity: "1.0000",
      unitAmount: "100.0000",
      lineAmount: "100.0000",
      taxAmount: "9.0000",
      accountId: "44444444-4444-4444-8444-444444444444",
      accountCode: "400",
      taxType: "OUTPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
  };
}

function readerFor(route: NativeDocumentRoute): XeroBusinessCoordinateHistoryReadPort {
  const credit = route === "CUSTOMER_CREDIT" || route === "SUPPLIER_CREDIT";
  const reference = `${credit ? "CN" : "INV"}-HISTORY-001`;
  const invoiceType = route === "SUPPLIER_BILL" ? "ACCPAY" as const : "ACCREC" as const;
  const creditType = route === "SUPPLIER_CREDIT" ? "ACCPAYCREDIT" as const : "ACCRECCREDIT" as const;
  return {
    listInvoices: vi.fn(async (): Promise<InvoiceListResult> => ({
      invoices: credit ? [] : [{ ...invoiceSnapshot(invoiceType, reference), lines: [] }],
      pagination: completePagination(credit ? 0 : 1),
    })),
    listCreditNotes: vi.fn(async (): Promise<CreditNoteListResult> => ({
      creditNotes: credit ? [{ ...creditSnapshot(creditType, reference), lines: [] }] : [],
      pagination: completePagination(credit ? 1 : 0),
    })),
    getInvoice: vi.fn(async () => invoiceSnapshot(invoiceType, reference)),
    getCreditNote: vi.fn(async () => creditSnapshot(creditType, reference)),
  };
}

describe("Xero provider business-coordinate history", () => {
  for (const route of [
    "SALES_INVOICE",
    "SUPPLIER_BILL",
    "CUSTOMER_CREDIT",
    "SUPPLIER_CREDIT",
  ] as const) {
    it(`returns exact canonical/economic provider evidence for ${route} even when local DB is empty`, async () => {
      const result = await lookupXeroProviderBusinessCoordinate({
        reader: readerFor(route),
        principal: context,
        operation: operation(route),
      });
      expect(result).toMatchObject({
        state: "EXACT_ONE",
        providerObjectId: objectId,
        canonicalEconomicMatch: true,
      });
    });
  }

  it("fails closed as INCOMPLETE when provider pagination cannot prove exhaustion", async () => {
    const reader = readerFor("SALES_INVOICE");
    vi.mocked(reader.listInvoices).mockResolvedValueOnce({
      invoices: [],
      pagination: {
        page: 1,
        pageSize: 100,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: true,
        omittedInvalid: 0,
      },
    });
    await expect(lookupXeroProviderBusinessCoordinate({
      reader,
      principal: context,
      operation: operation("SALES_INVOICE"),
    })).resolves.toMatchObject({ state: "INCOMPLETE" });
    expect(reader.getInvoice).not.toHaveBeenCalled();
  });

  it("returns AMBIGUOUS without exact GET when two provider objects own the coordinate", async () => {
    const reader = readerFor("SUPPLIER_BILL");
    const first = invoiceSnapshot("ACCPAY", "INV-HISTORY-001");
    vi.mocked(reader.listInvoices).mockResolvedValueOnce({
      invoices: [
        { ...first, lines: [] },
        { ...first, invoiceId: "55555555-5555-4555-8555-555555555555", lines: [] },
      ],
      pagination: completePagination(2),
    });
    await expect(lookupXeroProviderBusinessCoordinate({
      reader,
      principal: context,
      operation: operation("SUPPLIER_BILL"),
    })).resolves.toMatchObject({ state: "AMBIGUOUS" });
    expect(reader.getInvoice).not.toHaveBeenCalled();
  });

  it("keeps an exact coordinate with different economics as zero-write mismatch evidence", async () => {
    const reader = readerFor("SALES_INVOICE");
    vi.mocked(reader.getInvoice).mockResolvedValueOnce({
      ...invoiceSnapshot("ACCREC", "INV-HISTORY-001"),
      total: "999.0000",
    });
    await expect(lookupXeroProviderBusinessCoordinate({
      reader,
      principal: context,
      operation: operation("SALES_INVOICE"),
    })).resolves.toMatchObject({
      state: "EXACT_ONE",
      canonicalEconomicMatch: false,
      mismatchReasons: expect.arrayContaining(["TOTAL_MISMATCH"]),
    });
  });

  it.each([
    ["SALES_INVOICE", "INVOICE_NUMBER", "PROVIDER_ENFORCED_UNIQUE"],
    ["SUPPLIER_BILL", "INVOICE_NUMBER", "NON_UNIQUE_EXCLUSIVE_WRITER"],
    ["CUSTOMER_CREDIT", "CREDIT_NOTE_NUMBER", "PROVIDER_ENFORCED_UNIQUE"],
    ["SUPPLIER_CREDIT", "CREDIT_NOTE_NUMBER", "NON_UNIQUE_EXCLUSIVE_WRITER"],
  ] as const)("seals the route-specific FORMAL coordinate for %s", (route, field, uniqueness) => {
    expect(operation(route).canonicalPayload).toMatchObject({
      authoritativeProviderField: field,
      uniquenessAuthority: uniqueness,
    });
    expect(operation(route).businessReservation.canonicalFields).toMatchObject({
      authoritativeProviderField: field,
      uniquenessAuthority: uniqueness,
    });
  });

  it.each([
    ["SALES_INVOICE", "REFERENCE"],
    ["SUPPLIER_BILL", "INVOICE_NUMBER"],
    ["CUSTOMER_CREDIT", "REFERENCE"],
    ["SUPPLIER_CREDIT", "CREDIT_NOTE_NUMBER"],
  ] as const)("seals the route-native GENERIC coordinate for %s", (route, field) => {
    expect(xeroDocumentCoordinateAuthority(route, "GENERIC_RECURRING_REFERENCE")).toEqual({
      authoritativeProviderField: field,
      uniquenessAuthority: "NON_UNIQUE_EXCLUSIVE_WRITER",
    });
  });

  it("scans an AR provider-unique formal number tenant-wide and blocks a different-contact owner", async () => {
    const reader = readerFor("SALES_INVOICE");
    const differentContactId = "66666666-6666-4666-8666-666666666666";
    const owned = invoiceSnapshot("ACCREC", "INV-HISTORY-001");
    vi.mocked(reader.listInvoices).mockResolvedValueOnce({
      invoices: [{ ...owned, contact: { contactId: differentContactId }, lines: [] }],
      pagination: completePagination(1),
    });
    vi.mocked(reader.getInvoice).mockResolvedValueOnce({
      ...owned,
      contact: { contactId: differentContactId },
    });
    await expect(lookupXeroProviderBusinessCoordinate({
      reader,
      principal: context,
      operation: operation("SALES_INVOICE"),
    })).resolves.toMatchObject({
      state: "EXACT_ONE",
      canonicalEconomicMatch: false,
      mismatchReasons: expect.arrayContaining(["CONTACT_ID_MISMATCH"]),
    });
    expect(reader.listInvoices).toHaveBeenCalledWith(context, expect.not.objectContaining({
      contact_id: expect.anything(),
    }));
  });

  it("scans a customer-credit provider-unique formal number tenant-wide and blocks a different-contact owner", async () => {
    const reader = readerFor("CUSTOMER_CREDIT");
    const differentContactId = "66666666-6666-4666-8666-666666666666";
    const owned = creditSnapshot("ACCRECCREDIT", "CN-HISTORY-001");
    vi.mocked(reader.listCreditNotes).mockResolvedValueOnce({
      creditNotes: [{ ...owned, contact: { contactId: differentContactId }, lines: [] }],
      pagination: completePagination(1),
    });
    vi.mocked(reader.getCreditNote).mockResolvedValueOnce({
      ...owned,
      contact: { contactId: differentContactId },
    });
    await expect(lookupXeroProviderBusinessCoordinate({
      reader,
      principal: context,
      operation: operation("CUSTOMER_CREDIT"),
    })).resolves.toMatchObject({
      state: "EXACT_ONE",
      canonicalEconomicMatch: false,
      mismatchReasons: expect.arrayContaining(["CONTACT_ID_MISMATCH"]),
    });
    expect(reader.listCreditNotes).toHaveBeenCalledWith(context, expect.not.objectContaining({
      contact_id: expect.anything(),
    }));
  });

  it.each([
    ["SALES_INVOICE", "REFERENCE"],
    ["CUSTOMER_CREDIT", "REFERENCE"],
  ] as const)("fails closed when the sealed %s route claims wrong field %s", async (route, wrongField) => {
    const mismatched = structuredClone(operation(route));
    (mismatched.canonicalPayload as Record<string, unknown>).authoritativeProviderField = wrongField;
    mismatched.canonicalPayloadHash = hashObject(mismatched.canonicalPayload);
    (mismatched.businessReservation.canonicalFields as Record<string, unknown>).authoritativeProviderField =
      wrongField;
    await expect(lookupXeroProviderBusinessCoordinate({
      reader: readerFor(route),
      principal: context,
      operation: mismatched,
    })).resolves.toMatchObject({
      state: "INCOMPLETE",
      reasonCodes: ["BUSINESS_COORDINATE_AUTHORITY_PROJECTION_INVALID"],
    });
  });
});

describe("Xero reference-scope authority projection", () => {
  const target = Object.freeze({
    tenantId: "11111111-1111-4111-8111-111111111111",
    environment: "PRODUCTION",
    baseCurrency: "SGD",
    taxJurisdiction: "SG",
    organisationStatus: "ACTIVE",
  }) satisfies AccountingCaseTarget;
  const recurringFact = (date: string): NativeDocumentFact => ({
    factId: `fact-${date}`,
    kind: "NATIVE_DOCUMENT",
    documentKind: "INVOICE",
    counterpartyRole: "CUSTOMER",
    reference: "MONTHLY-RETAINER",
    referenceKind: "GENERIC_RECURRING_REFERENCE",
    documentDate: date,
    origin: "MODEL_EXTRACTED",
  } as NativeDocumentFact);
  const bindings = new Map([
    ["fact-2026-07-20", { contactId }],
    ["fact-2026-08-20", { contactId }],
  ]);

  it("keeps model-extracted generic references ALL_OCCURRENCES without server recurring authority", () => {
    const contract = createXeroAccountingCaseProviderContract(bindings, testLedgerBinding(target.tenantId));
    expect(contract.businessIdentity(recurringFact("2026-07-20"), target).reservation.scope)
      .toBe("ALL_OCCURRENCES");
    expect(contract.businessIdentity(recurringFact("2026-08-20"), target).reservation.scope)
      .toBe("ALL_OCCURRENCES");
  });

  it("permits dated occurrences only when an exact server-owned recurring-series authority is sealed", () => {
    const authority = parseXeroAccountingCaseBusinessAuthorityProfiles([{
      tenant_id: target.tenantId,
      writer_authority: {
        mode: "EXCLUSIVE_GOVERNED_WRITER",
        authority_id: "writer-authority-1",
        revision: 1,
        covers_all_tenant_writers: true,
        verification_receipt_sha256: "b".repeat(64),
      },
      recurring_series_authorities: [{
        authority_id: "series-authority-1",
        revision: 3,
        route: "SALES_INVOICE",
        contact_id: contactId,
        reference: "MONTHLY-RETAINER",
        authoritative_provider_field: "REFERENCE",
        normalization_version: "xero-reference-coordinate:v1",
        occurrence_key: "DOCUMENT_DATE",
        verification_receipt_sha256: "c".repeat(64),
      }],
    }])[0]!;
    const contract = createXeroAccountingCaseProviderContract(
      bindings,
      testLedgerBinding(target.tenantId),
      undefined,
      authority,
    );
    const july = contract.businessIdentity(recurringFact("2026-07-20"), target);
    const august = contract.businessIdentity(recurringFact("2026-08-20"), target);
    expect(july.reservation).toMatchObject({ scope: "DATED_OCCURRENCE", occurrenceDate: "2026-07-20" });
    expect(august.reservation).toMatchObject({ scope: "DATED_OCCURRENCE", occurrenceDate: "2026-08-20" });
    expect(july.canonicalFields).toMatchObject({
      recurringSeriesAuthority: {
        authorityId: "series-authority-1",
        revision: 3,
        occurrenceKey: "DOCUMENT_DATE",
      },
    });
  });

  it.each([
    ["SUPPLIER_BILL", "INVOICE_NUMBER"],
    ["SUPPLIER_CREDIT", "CREDIT_NOTE_NUMBER"],
  ] as const)("requires the route-native AP provider property for recurring %s authority", (route, field) => {
    const base = {
      authority_id: `series-${route.toLowerCase()}`,
      revision: 1,
      route,
      contact_id: contactId,
      reference: "MONTHLY-AP-TOKEN",
      normalization_version: "xero-reference-coordinate:v1" as const,
      occurrence_key: "DOCUMENT_DATE" as const,
      verification_receipt_sha256: "d".repeat(64),
    };
    expect(() => parseXeroAccountingCaseBusinessAuthorityProfiles([{
      tenant_id: target.tenantId,
      writer_authority: { mode: "NONE" },
      recurring_series_authorities: [{ ...base, authoritative_provider_field: field }],
    }])).not.toThrow();
    expect(() => parseXeroAccountingCaseBusinessAuthorityProfiles([{
      tenant_id: target.tenantId,
      writer_authority: { mode: "NONE" },
      recurring_series_authorities: [{ ...base, authoritative_provider_field: "REFERENCE" }],
    }])).toThrow();
  });
});
