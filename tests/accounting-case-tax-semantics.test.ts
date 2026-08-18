import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectXeroAccountingCaseCompilerInput } from "../src/policy/xeroAccountingCaseProviderContract.js";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { NativeDocumentFact } from "../src/domain/accountingCase.js";
import {
  prepareAccountingCaseSchema,
  type PrepareAccountingCaseInput,
} from "../src/domain/accountingCaseSchemas.js";

const input = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;
const providerNeutralInput = projectXeroAccountingCaseCompilerInput(input).input;

function cloudBill(): NativeDocumentFact {
  const fact = input.facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.factId === "fact-cloudhost-bill-v1" && candidate.kind === "NATIVE_DOCUMENT");
  if (!fact) throw new Error("CloudHost bill is missing");
  return fact;
}

function standardInvoice(): NativeDocumentFact {
  const fact = input.facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.factId === "fact-sales-invoice-v1" && candidate.kind === "NATIVE_DOCUMENT");
  if (!fact) throw new Error("Sales invoice is missing");
  return fact;
}

function compileStandardVariant(patch: Partial<NativeDocumentFact>) {
  const original = standardInvoice();
  const fact: NativeDocumentFact = { ...original, ...patch };
  const compiled = compileAccountingCase({
    ...input,
    // The receipt is a separate economic event whose dates/amounts intentionally
    // remain fixed in the golden pack; omit it while mutating the invoice tax
    // period so this test isolates the compiler's tax decision.
    facts: input.facts
      .filter((candidate) => candidate.factId !== "fact-lion-city-receipt-v1")
      .map((candidate) => candidate.factId === original.factId ? fact : candidate),
  });
  return {
    fact,
    compiled,
    event: compiled.events.find((candidate) => candidate.eventKey === fact.eventKey),
    operation: compiled.operations.find((candidate) => candidate.eventId ===
      compiled.events.find((event) => event.eventKey === fact.eventKey)?.eventId),
  };
}

function compileTaxVariant(patch: Partial<NativeDocumentFact>) {
  const original = cloudBill();
  const fact: NativeDocumentFact = {
    ...original,
    ...patch,
    declaredTax: "0.00",
    declaredGross: original.declaredNet,
    lines: original.lines.map((line) => ({ ...line, sourceTax: "0.00" })),
  };
  const compiled = compileAccountingCase({
    ...input,
    facts: input.facts
      .filter((candidate) => patch.counterpartyRole !== "CUSTOMER" || candidate.factId !== "fact-cloudhost-settlement-v1")
      .map((candidate) => candidate.factId === original.factId ? fact : candidate),
    sources: patch.counterpartyRole !== "CUSTOMER"
      ? input.sources
      : input.sources.filter((source) => source.artifactId !== "doc-14"),
  });
  const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
  const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
  if (!operation) throw new Error(`No operation for ${String(patch.taxClass)}`);
  return operation;
}

describe("Accounting Case Singapore tax semantics", () => {
  it.each([
    ["NO_TAX", "NONE", "NO_TAX", "NO_TAX"],
    ["ZERO_RATED", "ZERORATEDINPUT", "ZERO_RATED_INPUT", "EXCLUSIVE"],
    ["EXEMPT", "EPINPUT", "EXEMPT_INPUT", "EXCLUSIVE"],
    ["OUT_OF_SCOPE", "OPINPUT", "OUT_OF_SCOPE_INPUT", "EXCLUSIVE"],
  ] as const)("keeps supplier %s distinct as Xero %s", (taxClass, taxType, taxSemantics, lineAmountType) => {
    const operation = compileTaxVariant({ taxClass, lineAmountType });
    expect(operation.canonicalPayload).toMatchObject({ taxClass, taxType, taxSemantics, lineAmountType });
  });

  it.each([
    ["REGULATION_33", "ES33OUTPUT", "EXEMPT_OUTPUT_REGULATION_33"],
    ["NON_REGULATION_33", "ESN33OUTPUT", "EXEMPT_OUTPUT_NON_REGULATION_33"],
  ] as const)("requires and preserves customer exemption class %s", (exemptClassification, taxType, taxSemantics) => {
    const original = cloudBill();
    const operation = compileTaxVariant({
      counterpartyRole: "CUSTOMER",
      accountingCategory: "CONSULTING_REVENUE",
      taxClass: "EXEMPT",
      exemptClassification,
      lineAmountType: "EXCLUSIVE",
      contactName: "Exempt Customer Pte. Ltd.",
      documentKind: "INVOICE",
    });
    expect(operation.canonicalPayload).toMatchObject({ exemptClassification, taxType, taxSemantics });
    expect(operation.canonicalPayloadHash).not.toBe(compileTaxVariant({
      ...original,
      taxClass: "NO_TAX",
      lineAmountType: "NO_TAX",
    }).canonicalPayloadHash);
  });

  it("lets the injected Singapore policy block an ambiguous customer EXEMPT fact", () => {
    const original = providerNeutralInput.facts.find((candidate): candidate is NativeDocumentFact =>
      candidate.factId === "fact-cloudhost-bill-v1" && candidate.kind === "NATIVE_DOCUMENT");
    if (!original) throw new Error("provider-neutral CloudHost bill is missing");
    const ambiguous: NativeDocumentFact = {
      ...original,
      counterpartyRole: "CUSTOMER",
      accountingCategory: "CONSULTING_REVENUE",
      taxClass: "EXEMPT",
      lineAmountType: "EXCLUSIVE",
      contactName: "Exempt Customer Pte. Ltd.",
    };
    const compiled = compileAccountingCase({
      ...input,
      facts: input.facts
        .filter((candidate) => candidate.factId !== "fact-cloudhost-settlement-v1")
        .map((candidate) => candidate.factId === original.factId ? ambiguous : candidate),
      sources: input.sources.filter((source) => source.artifactId !== "doc-14"),
    });
    expect(compiled.events.find((event) => event.eventKey === ambiguous.eventKey)).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["ACCOUNTING_TAX_EXEMPT_CLASSIFICATION_REQUIRED"]),
    });
  });

  it("lets the injected Singapore policy block numeric tax on a zero-tax treatment", () => {
    const original = providerNeutralInput.facts.find((candidate): candidate is NativeDocumentFact =>
      candidate.factId === "fact-cloudhost-bill-v1" && candidate.kind === "NATIVE_DOCUMENT");
    if (!original) throw new Error("provider-neutral CloudHost bill is missing");
    const compiled = compileAccountingCase({
      ...input,
      facts: input.facts.map((candidate) => candidate.factId === original.factId
        ? {
            ...original,
            taxClass: "ZERO_RATED",
            lineAmountType: "EXCLUSIVE",
            declaredTax: "90.00",
            declaredGross: "1090.00",
            lines: original.lines.map((line) => ({ ...line, sourceTax: "90.00" })),
          }
        : candidate),
    });
    expect(compiled.events.find((event) => event.eventKey === original.eventKey)).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["ZERO_RATED_REQUIRES_ZERO_TAX"]),
    });
  });

  it("produces different canonical hashes for No Tax, zero-rated, exempt and out-of-scope treatments", () => {
    const variants = [
      compileTaxVariant({ taxClass: "NO_TAX", lineAmountType: "NO_TAX" }),
      compileTaxVariant({ taxClass: "ZERO_RATED", lineAmountType: "EXCLUSIVE" }),
      compileTaxVariant({ taxClass: "EXEMPT", lineAmountType: "EXCLUSIVE" }),
      compileTaxVariant({ taxClass: "OUT_OF_SCOPE", lineAmountType: "EXCLUSIVE" }),
    ];
    expect(new Set(variants.map((operation) => operation.canonicalPayloadHash)).size).toBe(variants.length);
  });

  it.each([
    ["2022-06-30", 700, "280.00", "4280.00"],
    ["2023-06-30", 800, "320.00", "4320.00"],
    ["2027-01-01", 900, "360.00", "4360.00"],
  ] as const)("blocks unsupported Singapore tax-policy period %s before an operation exists", (
    documentDate,
    effectiveTaxRateBps,
    sourceTax,
    declaredGross,
  ) => {
    const result = compileStandardVariant({
      documentDate,
      dueDate: documentDate,
      effectiveTaxRateBps,
      lines: standardInvoice().lines.map((line) => ({ ...line, sourceTax })),
      declaredTax: sourceTax,
      declaredGross,
    });
    expect(result.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["SG_TAX_POLICY_PERIOD_UNSUPPORTED"]),
    });
    expect(result.operation).toBeUndefined();
  });

  it("blocks a transitional supply instead of deciding GST from invoice date alone", () => {
    const result = compileStandardVariant({ taxPolicyBasis: "TRANSITION_REVIEW_REQUIRED" });
    expect(result.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["SG_GST_TRANSITION_REVIEW_REQUIRED"]),
    });
    expect(result.operation).toBeUndefined();
  });

  it("allows an explicitly non-transitional 2024 document only at the released 9% rate", () => {
    const allowed = compileStandardVariant({ documentDate: "2024-02-01", dueDate: "2024-02-01" });
    expect(allowed.event?.disposition).toBe("AUTO_EXECUTE");
    expect(allowed.operation?.canonicalPayload).toMatchObject({
      effectiveTaxRateBps: 900,
      taxPolicyPeriodId: "SG_GST_9_2024_TO_2026H2",
      taxType: "OUTPUTY24",
    });

    const wrongRate = compileStandardVariant({
      documentDate: "2024-02-01",
      dueDate: "2024-02-01",
      effectiveTaxRateBps: 800,
      lines: standardInvoice().lines.map((line) => ({ ...line, sourceTax: "320.00" })),
      declaredTax: "320.00",
      declaredGross: "4320.00",
    });
    expect(wrongRate.event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["SG_EFFECTIVE_TAX_RATE_MISMATCH"]),
    });
    expect(wrongRate.operation).toBeUndefined();
  });

  it("uses the original transaction period for a credit note and blocks unsupported 8% history", () => {
    const original = input.facts.find((candidate): candidate is NativeDocumentFact =>
      candidate.factId === "fact-customer-credit-v1" && candidate.kind === "NATIVE_DOCUMENT");
    if (!original) throw new Error("Customer credit is missing");
    const historical: NativeDocumentFact = {
      ...original,
      originalDocumentDate: "2023-07-02",
      effectiveTaxRateBps: 800,
      lines: original.lines.map((line) => ({ ...line, sourceTax: "32.00" })),
      declaredTax: "32.00",
      declaredGross: "432.00",
    };
    const compiled = compileAccountingCase({
      ...input,
      facts: input.facts.map((candidate) => candidate.factId === original.factId ? historical : candidate),
    });
    const event = compiled.events.find((candidate) => candidate.eventKey === historical.eventKey);
    expect(event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["SG_TAX_POLICY_PERIOD_UNSUPPORTED"]),
    });
    expect(compiled.operations.some((operation) => operation.eventId === event?.eventId)).toBe(false);
  });

  it("requires credit-note original transaction evidence at the public schema", () => {
    const credit = providerNeutralInput.facts.find((candidate): candidate is NativeDocumentFact =>
      candidate.factId === "fact-customer-credit-v1" && candidate.kind === "NATIVE_DOCUMENT");
    if (!credit) throw new Error("Customer credit is missing");
    const {
      originalDocumentEventKey: _event,
      originalDocumentReference: _reference,
      originalDocumentDate: _date,
      ...missingEvidence
    } = credit;
    expect(() => prepareAccountingCaseSchema.parse({
      ...providerNeutralInput,
      facts: providerNeutralInput.facts.map((candidate) => candidate.factId === credit.factId ? missingEvidence : candidate),
    })).toThrow(/original document/u);
  });

  it("blocks a credit note whose claimed tax basis does not match the linked original transaction", () => {
    const credit = input.facts.find((candidate): candidate is NativeDocumentFact =>
      candidate.factId === "fact-customer-credit-v1" && candidate.kind === "NATIVE_DOCUMENT");
    if (!credit) throw new Error("Customer credit is missing");
    const mismatched: NativeDocumentFact = { ...credit, originalDocumentReference: "INV-NOT-THE-ORIGINAL" };
    const compiled = compileAccountingCase({
      ...input,
      facts: input.facts.map((candidate) => candidate.factId === credit.factId ? mismatched : candidate),
    });
    const event = compiled.events.find((candidate) => candidate.eventKey === credit.eventKey);
    expect(event).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["CREDIT_ORIGINAL_TRANSACTION_NOT_FOUND"]),
    });
    expect(compiled.operations.some((operation) => operation.eventId === event?.eventId)).toBe(false);
  });

  it("binds the supported tax-policy period and rate into the canonical operation hash", () => {
    const baseline = compileStandardVariant({});
    expect(baseline.operation?.canonicalPayload).toMatchObject({
      taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
      effectiveTaxRateBps: 900,
      taxPolicyPeriodId: "SG_GST_9_2024_TO_2026H2",
      taxType: "OUTPUTY24",
    });
    expect(baseline.operation?.canonicalPayloadHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("blocks standard GST when the Xero organisation is not GST registered", () => {
    const compiled = compileAccountingCase({
      ...input,
      target: { ...input.target, paysTax: false },
    });
    expect(compiled.events.find((event) => event.eventKey === "ar-sales-invoice")).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["ORGANISATION_NOT_GST_REGISTERED"]),
    });
    expect(compiled.operations.some((operation) => operation.nativeRoute === "SALES_INVOICE")).toBe(false);
  });

  it("blocks document dates in either Xero lock period", () => {
    for (const lock of [
      { periodLockDate: "2026-07-31" },
      { endOfYearLockDate: "2026-07-31" },
    ]) {
      const compiled = compileAccountingCase({
        ...input,
        target: { ...input.target, ...lock },
      });
      expect(compiled.events.find((event) => event.eventKey === "ar-sales-invoice")).toMatchObject({
        disposition: "BLOCKED_VALIDATION",
        reasonCodes: expect.arrayContaining([
          "periodLockDate" in lock ? "DOCUMENT_DATE_IN_PERIOD_LOCK" : "DOCUMENT_DATE_IN_END_OF_YEAR_LOCK",
        ]),
      });
      expect(compiled.operations.some((operation) => operation.nativeRoute === "SALES_INVOICE")).toBe(false);
    }
  });
});
