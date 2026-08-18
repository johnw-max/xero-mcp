import { describe, expect, it } from "vitest";
import {
  compileTestXeroAccountingCase as compileAccountingCase,
  TEST_XERO_TENANT_ID,
} from "./helpers/xeroTenantCoaProfile.js";
import { projectXeroAccountingCaseCompilerInput } from "../src/policy/xeroAccountingCaseProviderContract.js";
import type { NativeDocumentFact } from "../src/domain/accountingCase.js";
import { prepareAccountingCaseSchema } from "../src/domain/accountingCaseSchemas.js";

// Historical note: this file used to exercise the retired Singapore
// jurisdiction policy -- a server-owned table mapping three semantic
// categories (CONSULTING_REVENUE/OFFICE_SUPPLIES/CLOUD_SUBSCRIPTIONS) and
// five semantic tax classes (SG_STANDARD_RATED/NO_TAX/ZERO_RATED/
// OUT_OF_SCOPE/EXEMPT) onto Xero account codes and TaxTypes, with a
// jurisdiction tax-period/rate table and organisation-GST-registration gate.
//
// ADR-002 deleted that whole engine: the MCP no longer holds any jurisdiction
// rule set, category vocabulary or tax-semantics mapping. The caller now
// declares the exact live Xero `account_code` + `tax_type` for every line and
// the server only *verifies* the declaration against the target tenant's live
// chart of accounts / tax-rate table (`xeroDeclaredLedgerPolicy.ts`,
// `xeroDeclaredLedgerBinding.ts`). This file is repointed at that new
// declared-value verification subject instead of being deleted, because the
// underlying invariant it protects -- "the compiler will not silently accept
// or fabricate a tax treatment" -- still matters, just against a different
// authority (live tenant data instead of a jurisdiction table).
//
// Two sub-tests survive unmodified in spirit because the kernel-level
// invariants they cover were never part of the retired jurisdiction policy:
// period-lock dates are a target-level (not jurisdiction) rule, and credit
// notes requiring original-transaction evidence is a public-schema rule.
//
// Removed entirely, with no replacement, because ADR-002 deleted the
// behaviour itself (there is nothing left in the MCP to test):
// organisation-not-GST-registered, SG tax-policy period/transition review,
// and exempt-classification requirements.

const CUSTOMER_CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const SUPPLIER_CONTACT_ID = "33333333-3333-4333-8333-333333333333";

function invoiceFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    factId: "fact-doc",
    lineageKey: "lineage-doc",
    eventKey: "event-doc",
    sourceUnitIds: ["unit-doc"],
    origin: "MODEL_EXTRACTED",
    revision: 1,
    kind: "NATIVE_DOCUMENT",
    documentKind: "INVOICE",
    counterpartyRole: "CUSTOMER",
    reference: "INV-DECLARED-VALUE",
    referenceKind: "FORMAL_DOCUMENT_NUMBER",
    documentDate: "2026-07-20",
    dueDate: "2026-08-20",
    currency: "SGD",
    contactName: "Declared Value Customer",
    xeroContactId: CUSTOMER_CONTACT_ID,
    lineAmountType: "EXCLUSIVE",
    lines: [{
      lineId: "line-1",
      description: "Declared-value line",
      quantity: "1",
      unitAmount: "1000",
      sourceTax: "90",
      accountCode: "200",
      taxType: "OUTPUTY24",
    }],
    declaredNet: "1000",
    declaredTax: "90",
    declaredGross: "1090",
    documentValidity: "TEST_OR_NOT_VALID",
    ...overrides,
  };
}

function caseWithFact(fact: Record<string, unknown>, targetOverrides: Record<string, unknown> = {}) {
  return {
    caseId: "declared-ledger-verification",
    expectedVersion: 0,
    target: {
      tenantId: TEST_XERO_TENANT_ID,
      environment: "TEST",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      paysTax: true,
      organisationStatus: "ACTIVE",
      ...targetOverrides,
    },
    sources: [{
      artifactId: "source-doc",
      label: "Declared-ledger verification source",
      units: [{ unitId: "unit-doc", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [fact],
  };
}

describe("Accounting Case Xero declared-ledger verification", () => {
  it("rejects a declared account code absent from the tenant's live chart of accounts", () => {
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      lines: [{
        lineId: "line-1",
        description: "Unknown account",
        quantity: "1",
        unitAmount: "1000",
        sourceTax: "90",
        accountCode: "999",
        taxType: "OUTPUTY24",
      }],
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["DECLARED_ACCOUNT_NOT_FOUND"]),
    });
  });

  it("rejects a declared tax type absent from the tenant's live tax rates", () => {
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      lines: [{
        lineId: "line-1",
        description: "Unknown tax type",
        quantity: "1",
        unitAmount: "1000",
        sourceTax: "90",
        accountCode: "200",
        taxType: "MADEUPTAX",
      }],
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["DECLARED_TAX_TYPE_NOT_FOUND"]),
    });
  });

  it("rejects a real tenant tax type that does not apply to the declared account's class", () => {
    // OUTPUTY24 is the tenant's live 9% rate, but it only applies to REVENUE
    // accounts. Declaring it against the EXPENSE account 453 is a real,
    // resolvable pair that is still not a legal combination on this tenant.
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      documentKind: "INVOICE",
      counterpartyRole: "SUPPLIER",
      reference: "BILL-DECLARED-VALUE",
      contactName: "Declared Value Supplier",
      xeroContactId: SUPPLIER_CONTACT_ID,
      lines: [{
        lineId: "line-1",
        description: "Office supplies mistakenly taxed as output",
        quantity: "1",
        unitAmount: "800",
        sourceTax: "72",
        accountCode: "453",
        taxType: "OUTPUTY24",
      }],
      declaredNet: "800",
      declaredTax: "72",
      declaredGross: "872",
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["DECLARED_TAX_TYPE_NOT_APPLICABLE_TO_ACCOUNT_CLASS"]),
    });
  });

  it("substitutes the tenant's live tax rate for the caller's claim and rejects a tax amount that does not match it", () => {
    // The declared net/tax are internally self-consistent (1000 + 100 = 1100)
    // and would have passed the old "is this arithmetic self-consistent"
    // check on its own. The server now recomputes tax from the tenant's real
    // OUTPUTY24 rate (9%, i.e. 90.00) rather than trusting the caller's 10%,
    // so this is still rejected -- just for a live-rate mismatch, not a
    // jurisdiction-period mismatch.
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      lines: [{
        lineId: "line-1",
        description: "Wrong tax rate claimed",
        quantity: "1",
        unitAmount: "1000",
        sourceTax: "100",
        accountCode: "200",
        taxType: "OUTPUTY24",
      }],
      declaredNet: "1000",
      declaredTax: "100",
      declaredGross: "1100",
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["SOURCE_LINE_TAX_MISMATCH"]),
    });
  });

  it("blocks a No-Tax line-amount type when the declared tax type carries a live nonzero rate", () => {
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      lineAmountType: "NO_TAX",
      lines: [{
        lineId: "line-1",
        description: "No-tax claimed over a taxable rate",
        quantity: "1",
        unitAmount: "1000",
        sourceTax: "0",
        accountCode: "200",
        taxType: "OUTPUTY24",
      }],
      declaredNet: "1000",
      declaredTax: "0",
      declaredGross: "1000",
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["DOCUMENT_LINE_AMOUNT_TYPE_MISMATCH"]),
    });
  });

  it("carries distinct declared account/tax coordinates through as opaque values with distinct canonical hashes", () => {
    const taxed = compileAccountingCase(caseWithFact(invoiceFact()));
    const zeroRated = compileAccountingCase(caseWithFact(invoiceFact({
      lines: [{
        lineId: "line-1",
        description: "Declared-value line",
        quantity: "1",
        unitAmount: "1000",
        sourceTax: "0",
        accountCode: "200",
        taxType: "NONE",
      }],
      declaredTax: "0",
      declaredGross: "1000",
    })));
    expect(taxed.operations).toHaveLength(1);
    expect(zeroRated.operations).toHaveLength(1);
    expect(taxed.operations[0]?.canonicalPayload).toMatchObject({
      taxSemantics: "OUTPUTY24",
      taxType: "OUTPUTY24",
      lines: [expect.objectContaining({ accountingCategory: "200", taxClass: "OUTPUTY24" })],
    });
    expect(zeroRated.operations[0]?.canonicalPayload).toMatchObject({
      taxSemantics: "NONE",
      taxType: "NONE",
      lines: [expect.objectContaining({ accountingCategory: "200", taxClass: "NONE" })],
    });
    expect(taxed.operations[0]?.canonicalPayloadHash).not.toBe(zeroRated.operations[0]?.canonicalPayloadHash);
  });

  it("blocks document dates in either Xero lock period", () => {
    for (const lock of [
      { periodLockDate: "2026-07-31" },
      { endOfYearLockDate: "2026-07-31" },
    ]) {
      const compiled = compileAccountingCase(caseWithFact(invoiceFact(), lock));
      expect(compiled.events[0]).toMatchObject({
        disposition: "BLOCKED_VALIDATION",
        reasonCodes: expect.arrayContaining([
          "periodLockDate" in lock ? "DOCUMENT_DATE_IN_PERIOD_LOCK" : "DOCUMENT_DATE_IN_END_OF_YEAR_LOCK",
        ]),
      });
      expect(compiled.operations).toEqual([]);
    }
  });

  it("requires credit-note original transaction evidence at the public schema", () => {
    const raw = caseWithFact(invoiceFact({
      documentKind: "CREDIT_NOTE",
      dueDate: undefined,
      counterpartyRole: "SUPPLIER",
      reference: "OH-260701-CREDIT",
      contactName: "OfficeHub Singapore Pte. Ltd.",
      xeroContactId: SUPPLIER_CONTACT_ID,
      allocationStatus: "UNALLOCATED",
      originalDocumentReference: "OH-260701",
      originalDocumentReferenceKind: "FORMAL_DOCUMENT_NUMBER",
      originalDocumentDate: "2026-07-03",
      lines: [{
        lineId: "line-1",
        description: "Undelivered carton",
        quantity: "1",
        unitAmount: "80",
        sourceTax: "7.20",
        accountCode: "453",
        taxType: "INPUTY24",
      }],
      declaredNet: "80",
      declaredTax: "7.20",
      declaredGross: "87.20",
    }));
    const projected = projectXeroAccountingCaseCompilerInput(raw).input;
    const credit = projected.facts[0] as NativeDocumentFact;
    const {
      originalDocumentReference: _reference,
      originalDocumentReferenceKind: _kind,
      originalDocumentDate: _date,
      ...missingEvidence
    } = credit;
    expect(() => prepareAccountingCaseSchema.parse({
      ...projected,
      facts: [missingEvidence],
    })).toThrow(/original document/u);
  });

  it("blocks a credit note whose claimed original reference matches no live original transaction", () => {
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      documentKind: "CREDIT_NOTE",
      dueDate: undefined,
      counterpartyRole: "SUPPLIER",
      reference: "OH-260701-CREDIT",
      contactName: "OfficeHub Singapore Pte. Ltd.",
      xeroContactId: SUPPLIER_CONTACT_ID,
      allocationStatus: "UNALLOCATED",
      originalDocumentReference: "INV-NOT-THE-ORIGINAL",
      originalDocumentReferenceKind: "FORMAL_DOCUMENT_NUMBER",
      originalDocumentDate: "2026-07-03",
      lines: [{
        lineId: "line-1",
        description: "Undelivered carton",
        quantity: "1",
        unitAmount: "80",
        sourceTax: "7.20",
        accountCode: "453",
        taxType: "INPUTY24",
      }],
      declaredNet: "80",
      declaredTax: "7.20",
      declaredGross: "87.20",
    })));
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["CREDIT_ORIGINAL_TRANSACTION_NOT_FOUND"]),
    });
  });

  it("accepts a credit note whose claimed original reference matches the live original transaction", () => {
    const compiled = compileAccountingCase(caseWithFact(invoiceFact({
      documentKind: "CREDIT_NOTE",
      dueDate: undefined,
      counterpartyRole: "SUPPLIER",
      reference: "OH-260701-CREDIT",
      contactName: "OfficeHub Singapore Pte. Ltd.",
      xeroContactId: SUPPLIER_CONTACT_ID,
      allocationStatus: "UNALLOCATED",
      originalDocumentReference: "OH-260701",
      originalDocumentReferenceKind: "FORMAL_DOCUMENT_NUMBER",
      originalDocumentDate: "2026-07-03",
      lines: [{
        lineId: "line-1",
        description: "Undelivered carton",
        quantity: "1",
        unitAmount: "80",
        sourceTax: "7.20",
        accountCode: "453",
        taxType: "INPUTY24",
      }],
      declaredNet: "80",
      declaredTax: "7.20",
      declaredGross: "87.20",
    })));
    expect(compiled.events.find((event) => event.eventKey === "event-doc")).toMatchObject({
      disposition: "AUTO_EXECUTE",
    });
    expect(compiled.operations.filter((operation) => operation.eventId ===
      compiled.events.find((event) => event.eventKey === "event-doc")?.eventId)).toHaveLength(1);
  });
});
