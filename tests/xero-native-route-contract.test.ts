import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { NativeDocumentFact } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import { evaluateXeroNativeRouteContract } from "../src/policy/xeroNativeRouteContract.js";

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
