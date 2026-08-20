import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { CommercialDocumentFact, NativeDocumentFact } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import {
  evaluateXeroCommercialDocumentRouteContract,
  evaluateXeroNativeRouteContract,
} from "../src/policy/xeroNativeRouteContract.js";
import {
  AGENT_REACHABLE_WRITE_ACTIONS,
  CASE_EXECUTOR_PENDING_ACTIONS,
} from "../src/domain/xeroWriteActions.js";

const input = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

function nativeFact(factId: string): NativeDocumentFact {
  const fact = input.facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.factId === factId && candidate.kind === "NATIVE_DOCUMENT");
  if (!fact) throw new Error(`Missing native fact ${factId}`);
  return fact;
}

function compiledEvent(facts: PrepareAccountingCaseInput["facts"], eventKey: string) {
  const compiled = compileAccountingCase({ ...input, facts });
  return {
    event: compiled.events.find((candidate) => candidate.eventKey === eventKey),
    operation: compiled.operations.find((candidate) =>
      candidate.eventId === compiled.events.find((event) => event.eventKey === eventKey)?.eventId),
  };
}

// A minimal, self-contained COMMERCIAL_DOCUMENT fact plus the source unit it
// requires, appended to a clone of the golden-14 case (which has none).
// xeroContactId/currency/accountCode/taxType are reused verbatim from
// fact-sales-invoice-v1 / fact-officehub-bill-v1 in the same fixture, so
// they are already known-good coordinates under the test tenant's COA.
// `xeroContactId` is the same test-only fixture convenience the golden-14
// facts already use (stripped by legacyBindingFromRecord before schema
// validation, see projectXeroAccountingCaseCompilerInput) -- not part of the
// CommercialDocumentFact type, hence the loosely-typed literal here.
function commercialDocumentCase(
  fact: CommercialDocumentFact & { xeroContactId: string },
): PrepareAccountingCaseInput {
  return {
    ...input,
    sources: [
      ...input.sources,
      {
        artifactId: `${fact.factId}-artifact`,
        label: `Commercial document - ${fact.factId}`,
        units: [{ unitId: fact.sourceUnitIds[0]!, expectedFactKinds: ["COMMERCIAL_DOCUMENT"] }],
      },
    ],
    facts: [...input.facts, fact] as PrepareAccountingCaseInput["facts"],
  };
}

function quoteFact(
  overrides: Partial<CommercialDocumentFact> = {},
): CommercialDocumentFact & { xeroContactId: string } {
  return {
    factId: "fact-quote-route-contract-v1",
    lineageKey: "quote-route-contract-v1",
    eventKey: "quote-route-contract-v1",
    sourceUnitIds: ["quote-route-contract-unit"],
    origin: "MODEL_EXTRACTED",
    revision: 1,
    kind: "COMMERCIAL_DOCUMENT",
    documentKind: "QUOTE",
    counterpartyRole: "CUSTOMER",
    reference: "QU-2026-0001",
    documentDate: "2026-07-02",
    expiryDate: "2026-08-01",
    currency: "SGD",
    contactName: "Lion City Digital Pte. Ltd.",
    xeroContactId: "22222222-2222-4222-8222-222222222222",
    lineAmountType: "EXCLUSIVE",
    lines: [{
      lineId: "consulting-hours",
      description: "Consulting services - August 2026",
      quantity: "10",
      unitAmount: "200.00",
      accountCode: "200",
      taxType: "OUTPUTY24",
    }],
    documentValidity: "TEST_OR_NOT_VALID",
    ...overrides,
  };
}

function purchaseOrderFact(
  overrides: Partial<CommercialDocumentFact> = {},
): CommercialDocumentFact & { xeroContactId: string } {
  return {
    factId: "fact-po-route-contract-v1",
    lineageKey: "po-route-contract-v1",
    eventKey: "po-route-contract-v1",
    sourceUnitIds: ["po-route-contract-unit"],
    origin: "MODEL_EXTRACTED",
    revision: 1,
    kind: "COMMERCIAL_DOCUMENT",
    documentKind: "PURCHASE_ORDER",
    counterpartyRole: "SUPPLIER",
    reference: "PO-2026-0001",
    documentDate: "2026-07-03",
    currency: "SGD",
    contactName: "OfficeHub Singapore Pte. Ltd.",
    xeroContactId: "33333333-3333-4333-8333-333333333333",
    lineAmountType: "EXCLUSIVE",
    lines: [{
      lineId: "paper-cartons",
      description: "Premium copier paper",
      quantity: "5",
      unitAmount: "80.00",
      accountCode: "453",
      taxType: "INPUTY24",
    }],
    documentValidity: "TEST_OR_NOT_VALID",
    ...overrides,
  };
}

describe("Xero native-route capability contract", () => {
  it.each([
    ["invoice without due date", {
      documentKind: "INVOICE", counterpartyRole: "CUSTOMER", currency: "SGD",
    }, ["INVOICE_DUE_DATE_REQUIRED"]],
    ["foreign invoice without recognition rate", {
      documentKind: "INVOICE", counterpartyRole: "SUPPLIER", dueDate: "2026-08-01", currency: "USD",
    }, ["FOREIGN_INVOICE_RATE_REQUIRED"]],
    ["credit with a due date", {
      documentKind: "CREDIT_NOTE", counterpartyRole: "CUSTOMER", dueDate: "2026-08-01", currency: "SGD",
    }, ["CREDIT_NOTE_DUE_DATE_UNSUPPORTED"]],
    ["credit with a currency rate", {
      documentKind: "CREDIT_NOTE", counterpartyRole: "SUPPLIER", currency: "SGD", invoiceRate: "1.3500",
    }, ["CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED"]],
    ["foreign credit", {
      documentKind: "CREDIT_NOTE", counterpartyRole: "SUPPLIER", currency: "USD",
    }, ["FOREIGN_CREDIT_NOTE_UNSUPPORTED"]],
  ] as const)("rejects %s before adapter preparation", (_label, fact, expected) => {
    expect(evaluateXeroNativeRouteContract(fact, { baseCurrency: "SGD" })).toMatchObject({
      adapterCanPrepare: false,
      reasonCodes: expect.arrayContaining(expected),
    });
  });

  it("admits only released invoice and same-currency credit shapes", () => {
    expect(evaluateXeroNativeRouteContract({
      documentKind: "INVOICE",
      counterpartyRole: "CUSTOMER",
      dueDate: "2026-08-01",
      currency: "SGD",
    }, { baseCurrency: "SGD" })).toMatchObject({ adapterCanPrepare: true, reasonCodes: [] });
    expect(evaluateXeroNativeRouteContract({
      documentKind: "CREDIT_NOTE",
      counterpartyRole: "SUPPLIER",
      currency: "SGD",
    }, { baseCurrency: "SGD" })).toMatchObject({ adapterCanPrepare: true, reasonCodes: [] });
  });

  it("never emits an invoice operation when its adapter-required due date is absent", () => {
    const original = nativeFact("fact-sales-invoice-v1");
    const withoutDueDate = { ...original };
    delete withoutDueDate.dueDate;
    const result = compiledEvent(
      input.facts.map((fact) => fact.factId === original.factId ? withoutDueDate : fact),
      original.eventKey,
    );
    expect(result.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["INVOICE_DUE_DATE_REQUIRED"]),
    });
    expect(result.operation).toBeUndefined();
  });

  it.each([
    ["due date", { dueDate: "2026-08-01" }, "CREDIT_NOTE_DUE_DATE_UNSUPPORTED"],
    ["currency rate", { invoiceRate: "1.3500" }, "CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED"],
  ] as const)("never emits a credit operation containing unsupported %s", (_label, patch, reasonCode) => {
    const original = nativeFact("fact-supplier-credit-v1");
    const result = compiledEvent(
      input.facts.map((fact) => fact.factId === original.factId ? { ...original, ...patch } : fact),
      original.eventKey,
    );
    expect(result.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining([reasonCode]),
    });
    expect(result.operation).toBeUndefined();
  });

  it("blocks a foreign credit instead of dropping its rate at the Xero adapter", () => {
    const credit = nativeFact("fact-supplier-credit-v1");
    const facts = input.facts.map((fact) => fact.factId === credit.factId
      ? { ...credit, currency: "USD", invoiceRate: "1.3500" }
      : fact);
    const result = compiledEvent(facts, credit.eventKey);
    expect(result.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining([
        "FOREIGN_CREDIT_NOTE_UNSUPPORTED",
        "CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED",
      ]),
    });
    expect(result.operation).toBeUndefined();
  });
});

describe("Xero commercial-document (quote/purchase order) route contract", () => {
  // proves: quote.create_draft and purchase_order.create_draft are reachable
  // from the case executor today, not still stuck behind the pending-action
  // gate that made six built-and-tested actions uncallable.
  it("lists quote.create_draft and purchase_order.create_draft as agent-reachable and not executor-pending", () => {
    expect(AGENT_REACHABLE_WRITE_ACTIONS).toContain("quote.create_draft");
    expect(AGENT_REACHABLE_WRITE_ACTIONS).toContain("purchase_order.create_draft");
    expect(CASE_EXECUTOR_PENDING_ACTIONS).not.toContain("quote.create_draft");
    expect(CASE_EXECUTOR_PENDING_ACTIONS).not.toContain("purchase_order.create_draft");
  });

  it.each([
    ["quote to a supplier", { documentKind: "QUOTE", counterpartyRole: "SUPPLIER" }, ["QUOTE_COUNTERPARTY_MUST_BE_CUSTOMER"]],
    ["purchase order to a customer", { documentKind: "PURCHASE_ORDER", counterpartyRole: "CUSTOMER" }, ["PURCHASE_ORDER_COUNTERPARTY_MUST_BE_SUPPLIER"]],
    ["quote without an expiry date", { documentKind: "QUOTE", counterpartyRole: "CUSTOMER" }, ["QUOTE_EXPIRY_DATE_REQUIRED"]],
  ] as const)("rejects %s before adapter preparation", (_label, fact, expected) => {
    expect(evaluateXeroCommercialDocumentRouteContract(fact)).toMatchObject({
      route: fact.documentKind,
      adapterCanPrepare: false,
      reasonCodes: expect.arrayContaining(expected),
    });
  });

  it("admits only released quote and purchase-order shapes", () => {
    expect(evaluateXeroCommercialDocumentRouteContract({
      documentKind: "QUOTE", counterpartyRole: "CUSTOMER", expiryDate: "2026-08-01",
    })).toMatchObject({ route: "QUOTE", adapterCanPrepare: true, reasonCodes: [] });
    expect(evaluateXeroCommercialDocumentRouteContract({
      documentKind: "PURCHASE_ORDER", counterpartyRole: "SUPPLIER",
    })).toMatchObject({ route: "PURCHASE_ORDER", adapterCanPrepare: true, reasonCodes: [] });
  });

  // proves: a QUOTE billed to a supplier does not silently compile as
  // something plausible (for example falling through into the
  // PURCHASE_ORDER×SUPPLIER shape it would resemble) -- it is rejected by
  // name, and the case never emits a dispatchable operation for it.
  it("rejects a QUOTE billed to a SUPPLIER explicitly, and emits no operation", () => {
    const fact = quoteFact({ counterpartyRole: "SUPPLIER" });
    const compiled = compileAccountingCase(commercialDocumentCase(fact));
    const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
    expect(event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      route: "QUOTE",
      reasonCodes: expect.arrayContaining(["QUOTE_COUNTERPARTY_MUST_BE_CUSTOMER"]),
    });
    expect(compiled.operations.find((candidate) => candidate.eventId === event?.eventId)).toBeUndefined();
  });

  // proves: a PURCHASE_ORDER billed to a customer does not silently compile
  // as something plausible either -- same explicit-rejection guarantee, the
  // other direction.
  it("rejects a PURCHASE_ORDER billed to a CUSTOMER explicitly, and emits no operation", () => {
    const fact = purchaseOrderFact({ counterpartyRole: "CUSTOMER" });
    const compiled = compileAccountingCase(commercialDocumentCase(fact));
    const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
    expect(event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      route: "PURCHASE_ORDER",
      reasonCodes: expect.arrayContaining(["PURCHASE_ORDER_COUNTERPARTY_MUST_BE_SUPPLIER"]),
    });
    expect(compiled.operations.find((candidate) => candidate.eventId === event?.eventId)).toBeUndefined();
  });

  // proves: a well-formed quote and purchase order actually reach a
  // dispatchable operation -- the positive half of "reachable", not just
  // "rejected when wrong". Each carries the explicit
  // EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE reason code rather than
  // silently omitting the pre-write duplicate check the way invoices get it.
  it("compiles a well-formed quote into an AUTO_EXECUTE quote.create_draft operation", () => {
    const fact = quoteFact();
    const compiled = compileAccountingCase(commercialDocumentCase(fact));
    const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
    expect(event).toMatchObject({
      disposition: "AUTO_EXECUTE",
      route: "QUOTE",
      reasonCodes: expect.arrayContaining(["EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE"]),
    });
    const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
    expect(operation).toMatchObject({
      actionId: "quote.create_draft",
      nativeRoute: "QUOTE",
      terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    });
  });

  it("compiles a well-formed purchase order into an AUTO_EXECUTE purchase_order.create_draft operation", () => {
    const fact = purchaseOrderFact();
    const compiled = compileAccountingCase(commercialDocumentCase(fact));
    const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
    expect(event).toMatchObject({
      disposition: "AUTO_EXECUTE",
      route: "PURCHASE_ORDER",
      reasonCodes: expect.arrayContaining(["EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE"]),
    });
    const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
    expect(operation).toMatchObject({
      actionId: "purchase_order.create_draft",
      nativeRoute: "PURCHASE_ORDER",
      terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    });
  });
});
