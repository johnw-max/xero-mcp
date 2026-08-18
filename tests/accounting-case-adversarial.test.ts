import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileTestXeroAccountingCase as compileAccountingCase,
  validateTestXeroCompiledOperationAgainstSource as validateCompiledOperationAgainstSource,
} from "./helpers/xeroTenantCoaProfile.js";
import type { AccountingCaseOperation, NativeDocumentFact } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import { hashObject } from "../src/security/hash.js";
import type { XeroAccountingCaseBusinessAuthorityProfile } from "../src/policy/xeroBusinessCoordinateAuthority.js";

const input = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

function clone(): PrepareAccountingCaseInput {
  return structuredClone(input);
}

function supplierCredit(): {
  operation: AccountingCaseOperation;
  fact: NativeDocumentFact;
  policyProjection: Readonly<Record<string, unknown>>;
} {
  const compiled = compileAccountingCase(input);
  const fact = compiled.activeFacts.find((candidate): candidate is NativeDocumentFact =>
    candidate.kind === "NATIVE_DOCUMENT" && candidate.factId === "fact-supplier-credit-v1");
  const event = compiled.events.find((candidate) => candidate.eventKey === "ap-supplier-credit");
  const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
  if (!fact || !operation) throw new Error("supplier credit fixture is incomplete");
  return { fact, operation, policyProjection: compiled.policyProjection };
}

describe("Accounting Case adversarial graph and policy gates", () => {
  it("rejects duplicate planned provider business identities before any preflight", () => {
    const mutated = clone();
    const sales = mutated.facts.find((fact): fact is NativeDocumentFact =>
      fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-sales-invoice-v1");
    if (!sales) throw new Error("sales invoice missing");
    mutated.sources.push({
      artifactId: "duplicate-sales-artifact",
      label: "Duplicate sales invoice",
      units: [{ unitId: "duplicate-sales-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    });
    const duplicate = {
      ...structuredClone(sales),
      factId: "fact-sales-invoice-duplicate",
      lineageKey: "sales-invoice-duplicate",
      eventKey: "sales-invoice-duplicate-event",
      sourceUnitIds: ["duplicate-sales-unit"],
    };
    duplicate.lines[0]!.unitAmount = "201.00";
    duplicate.lines[0]!.sourceTax = "361.80";
    duplicate.declaredNet = "4020.00";
    duplicate.declaredTax = "361.80";
    duplicate.declaredGross = "4381.80";
    mutated.facts.push(duplicate);

    expect(() => compileAccountingCase(mutated)).toThrow(/overlapping provider business reservations/u);
  });

  it("blocks recurring documents without exact server recurring-series authority", () => {
    const mutated = clone();
    const sales = mutated.facts.find((fact): fact is NativeDocumentFact =>
      fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-sales-invoice-v1");
    if (!sales) throw new Error("sales invoice missing");
    mutated.sources.push({
      artifactId: "recurring-sales-artifact",
      label: "Next-period recurring sales invoice",
      units: [{ unitId: "recurring-sales-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    });
    mutated.facts.push({
      ...structuredClone(sales),
      factId: "fact-sales-invoice-next-period",
      lineageKey: "sales-invoice-next-period",
      eventKey: "sales-invoice-next-period-event",
      sourceUnitIds: ["recurring-sales-unit"],
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      documentDate: "2026-09-01",
      dueDate: "2026-09-30",
      lines: sales.lines.map((line) => ({ ...line, description: `${line.description} - September` })),
    });
    sales.referenceKind = "GENERIC_RECURRING_REFERENCE";

    expect(() => compileAccountingCase(mutated)).toThrow(/overlapping provider business reservations/u);
  });

  it("allows recurring documents across dates only with exact server recurring-series authority", () => {
    const mutated = clone();
    const sales = mutated.facts.find((fact): fact is NativeDocumentFact =>
      fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-sales-invoice-v1");
    if (!sales) throw new Error("sales invoice missing");
    mutated.sources.push({
      artifactId: "trusted-recurring-sales-artifact",
      label: "Next-period trusted recurring sales invoice",
      units: [{ unitId: "trusted-recurring-sales-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    });
    mutated.facts.push({
      ...structuredClone(sales),
      factId: "fact-sales-invoice-trusted-next-period",
      lineageKey: "sales-invoice-trusted-next-period",
      eventKey: "sales-invoice-trusted-next-period-event",
      sourceUnitIds: ["trusted-recurring-sales-unit"],
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      documentDate: "2026-09-01",
      dueDate: "2026-09-30",
      lines: sales.lines.map((line) => ({ ...line, description: `${line.description} - September` })),
    });
    sales.referenceKind = "GENERIC_RECURRING_REFERENCE";
    const authority = {
      tenant_id: mutated.target.tenantId,
      writer_authority: {
        mode: "EXCLUSIVE_GOVERNED_WRITER",
        authority_id: "adversarial-exclusive-writer",
        revision: 1,
        covers_all_tenant_writers: true,
        verification_receipt_sha256: "e".repeat(64),
      },
      recurring_series_authorities: [{
        authority_id: "adversarial-recurring-series",
        revision: 1,
        route: "SALES_INVOICE",
        contact_id: "22222222-2222-4222-8222-222222222222",
        reference: sales.reference,
        authoritative_provider_field: "REFERENCE",
        normalization_version: "xero-reference-coordinate:v1",
        occurrence_key: "DOCUMENT_DATE",
        verification_receipt_sha256: "d".repeat(64),
      }],
    } as XeroAccountingCaseBusinessAuthorityProfile;
    const compiled = compileAccountingCase(mutated, authority);
    expect(compiled.operations.filter((operation) => operation.actionId === "customer_invoice.create_draft"))
      .toHaveLength(2);
  });

  it.each(["0.00", "0.0000"])("rejects alternate zero encodings (%s) for positive accounting amounts", (zero) => {
    const mutated = clone();
    const fact = mutated.facts.find((candidate) => candidate.factId === "fact-supplier-credit-v1");
    if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("supplier credit missing");
    fact.declaredNet = zero;
    expect(() => compileAccountingCase(mutated)).toThrow();
  });

  it("rejects duplicate artifact, source-unit and fact identities before compilation", () => {
    const duplicateArtifact = clone();
    duplicateArtifact.sources.push(structuredClone(duplicateArtifact.sources[0]!));
    expect(() => compileAccountingCase(duplicateArtifact)).toThrow(/artifact IDs must be globally unique/u);

    const duplicateUnit = clone();
    duplicateUnit.sources[1]!.units[0]!.unitId = duplicateUnit.sources[0]!.units[0]!.unitId;
    expect(() => compileAccountingCase(duplicateUnit)).toThrow(/source unit IDs must be globally unique/u);

    const duplicateFact = clone();
    duplicateFact.facts.push(structuredClone(duplicateFact.facts[0]!));
    expect(() => compileAccountingCase(duplicateFact)).toThrow(/fact IDs must be globally unique/u);
  });

  it("rejects cross-kind, rollback and branched supersession instead of deleting an active invoice", () => {
    const crossKind = clone();
    crossKind.facts.push({
      factId: "fact-sales-invoice-attack-v2",
      lineageKey: "sales-invoice",
      eventKey: "ar-sales-invoice",
      sourceUnitIds: ["doc-04"],
      origin: "AGENT_ASSERTED",
      revision: 2,
      supersedesFactId: "fact-sales-invoice-v1",
      kind: "EVIDENCE",
      evidenceRole: "CONTROL_SUPPORT",
      note: "attempt to erase invoice",
    });
    expect(() => compileAccountingCase(crossKind)).toThrow(/supersedes must be the immediately prior fact/u);

    const branched = clone();
    const original = branched.facts.find((fact): fact is NativeDocumentFact =>
      fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-supplier-credit-v1");
    if (!original) throw new Error("supplier credit missing");
    branched.facts.push(
      { ...structuredClone(original), factId: "credit-revision-a", revision: 2, supersedesFactId: original.factId },
      { ...structuredClone(original), factId: "credit-revision-b", revision: 2, supersedesFactId: original.factId },
    );
    expect(() => compileAccountingCase(branched)).toThrow(/cannot have multiple successors/u);
  });

  it("rejects event-key collisions that would hide an unsupported payment behind an invoice", () => {
    const mutated = clone();
    const payment = mutated.facts.find((fact) => fact.factId === "fact-lion-city-receipt-v1");
    if (!payment || payment.kind !== "PAYMENT") throw new Error("customer receipt missing");
    payment.eventKey = "ar-sales-invoice";
    expect(() => compileAccountingCase(mutated)).toThrow(/multiple primary effects/u);
  });

  it("does not allow one generic Evidence fact to cover the full source set", () => {
    const mutated = clone();
    const evidence = mutated.facts.find((fact) => fact.kind === "EVIDENCE");
    if (!evidence) throw new Error("evidence fixture missing");
    evidence.sourceUnitIds = mutated.sources.flatMap((source) => source.units.map((unit) => unit.unitId));
    expect(() => compileAccountingCase(mutated)).toThrow();
  });

  it("reconstructs the full operation and rejects action, reference, currency, account and tax tampering", () => {
    const { fact, operation, policyProjection } = supplierCredit();
    const canonicalPayload = {
      ...operation.canonicalPayload,
      reference: "ATTACKED",
      currency: "USD",
      accountCode: "999",
      taxType: "NONE",
    };
    const tampered = {
      ...operation,
      actionId: "manual_journal.create_draft",
      canonicalPayload,
      canonicalPayloadHash: hashObject(canonicalPayload),
    } as unknown as AccountingCaseOperation;
    expect(validateCompiledOperationAgainstSource(tampered, fact, policyProjection)).toEqual(expect.arrayContaining([
      "ACTION_ROUTE_MISMATCH",
      "CANONICAL_PAYLOAD_MISMATCH",
      "EXPECTED_PAYLOAD_HASH_MISMATCH",
    ]));
  });

  it("requires an explicit document-validity state and blocks the whole plan before any operation", () => {
    for (const invalidValue of [undefined, null] as const) {
      const invalid = clone();
      const fact = invalid.facts.find((candidate) => candidate.kind === "NATIVE_DOCUMENT");
      if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("native document missing");
      if (invalidValue === undefined) {
        Reflect.deleteProperty(fact as unknown as Record<string, unknown>, "documentValidity");
      } else {
        (fact as unknown as Record<string, unknown>).documentValidity = null;
      }
      expect(() => compileAccountingCase(invalid)).toThrow();
    }

    const unknown = clone();
    const unknownDocument = unknown.facts.find((candidate) => candidate.kind === "NATIVE_DOCUMENT");
    if (!unknownDocument || unknownDocument.kind !== "NATIVE_DOCUMENT") throw new Error("native document missing");
    unknownDocument.documentValidity = "UNKNOWN";
    const unknownPlan = compileAccountingCase(unknown);
    expect(unknownPlan.status).toBe("BLOCKED_VALIDATION");
    expect(unknownPlan.operations).toEqual([]);
    expect(unknownPlan.events.some((event) => event.reasonCodes.includes("DOCUMENT_VALIDITY_UNKNOWN"))).toBe(true);

    const production = clone();
    production.target.environment = "PRODUCTION";
    const blocked = compileAccountingCase(production);
    expect(blocked.status).toBe("BLOCKED_VALIDATION");
    expect(blocked.events.filter((event) => event.reasonCodes.includes("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT")))
      .toHaveLength(5);
    expect(blocked.operations).toEqual([]);

    const testCase = compileAccountingCase(input);
    const native = testCase.operations.filter((operation) => operation.nativeRoute !== "CONTACT_CREATE");
    expect(native).toHaveLength(5);
    expect(native.every((operation) => operation.canonicalPayload.documentValidity === "TEST_OR_NOT_VALID" &&
      operation.canonicalPayload.liveBooksEligible === false &&
      operation.canonicalPayload.testTenantOnly === true)).toBe(true);

    const liveProduction = clone();
    liveProduction.target.environment = "PRODUCTION";
    for (const fact of liveProduction.facts) {
      if (fact.kind === "NATIVE_DOCUMENT") fact.documentValidity = "VALID_FOR_LIVE_BOOKS";
    }
    const livePlan = compileAccountingCase(liveProduction);
    expect(livePlan.status).toBe("PLANNED_WITH_EXCEPTIONS");
    expect(livePlan.operations).toHaveLength(5);
    expect(livePlan.operations.filter((operation) => operation.nativeRoute !== "CONTACT_CREATE").every((operation) =>
      operation.canonicalPayload.documentValidity === "VALID_FOR_LIVE_BOOKS" &&
      operation.canonicalPayload.liveBooksEligible === true &&
      operation.canonicalPayload.testTenantOnly === false)).toBe(true);
  });

  it("keeps pending OfficeHub bank verification hard-blocked across the related event graph", () => {
    const baseline = compileAccountingCase(input);
    const contact = baseline.activeFacts.find((fact) => fact.factId === "fact-contact-officehub-v1");
    expect(contact).toMatchObject({
      kind: "CONTACT_CANDIDATE",
      origin: "AGENT_ASSERTED",
      bankVerification: "PENDING_CALLBACK",
    });
    const contactEvent = baseline.events.find((event) => event.eventKey === "contact-officehub");
    expect(contactEvent?.reasonCodes).toContain(
      "CONTROL_BANK_DETAILS_VERIFICATION_BLOCK_NEW_PAYMENT_OR_BANK_CHANGE",
    );
    expect(contactEvent?.disposition).toBe("EVIDENCE_ONLY");
    expect(baseline.operations.some((operation) => operation.eventId === contactEvent?.eventId)).toBe(false);

    const existingPayment = baseline.events.find((event) => event.eventKey === "ap-officehub-payment");
    expect(existingPayment).toMatchObject({ disposition: "BLOCKED_UNSUPPORTED" });
    expect(existingPayment?.reasonCodes).toContain("NATIVE_WRITE_ROUTE_NOT_RELEASED");
    expect(existingPayment?.reasonCodes).not.toContain(
      "CONTROL_BANK_DETAILS_VERIFICATION_BLOCK_NEW_PAYMENT_OR_BANK_CHANGE",
    );

    const upgraded = clone();
    const pending = upgraded.facts.find((fact) => fact.factId === "fact-contact-officehub-v1");
    if (!pending || pending.kind !== "CONTACT_CANDIDATE") throw new Error("OfficeHub contact missing");
    upgraded.facts.push({
      ...structuredClone(pending),
      factId: "fact-contact-officehub-v2-unverified-upgrade",
      revision: 2,
      supersedesFactId: pending.factId,
      bankVerification: "VERIFIED",
    });
    expect(() => compileAccountingCase(upgraded)).toThrow(/AGENT_ASSERTED facts cannot upgrade/u);

    const future = clone();
    const oldBill = future.facts.find((fact): fact is NativeDocumentFact =>
      fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-officehub-bill-v1");
    const oldPayment = future.facts.find((fact) => fact.factId === "fact-officehub-payment-v1");
    if (!oldBill || !oldPayment || oldPayment.kind !== "PAYMENT") throw new Error("OfficeHub graph missing");
    future.sources.push(
      {
        artifactId: "doc-future-officehub-bill",
        label: "Future OfficeHub bill",
        units: [{ unitId: "doc-future-officehub-bill", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
      },
      {
        artifactId: "doc-future-officehub-payment",
        label: "Future OfficeHub payment",
        units: [{ unitId: "doc-future-officehub-payment", expectedFactKinds: ["PAYMENT"] }],
      },
    );
    future.facts.push(
      {
        ...structuredClone(oldBill),
        factId: "fact-future-officehub-bill-v1",
        lineageKey: "future-officehub-bill",
        eventKey: "ap-future-officehub-bill",
        sourceUnitIds: ["doc-future-officehub-bill"],
        reference: "OH-FUTURE-001",
      },
      {
        ...structuredClone(oldPayment),
        factId: "fact-future-officehub-payment-v1",
        lineageKey: "future-officehub-payment",
        eventKey: "ap-future-officehub-payment",
        sourceUnitIds: ["doc-future-officehub-payment"],
        reference: "OH-FUTURE-001",
        relatedEventKey: "ap-future-officehub-bill",
        cleared: false,
      },
    );
    const futurePlan = compileAccountingCase(future);
    const futurePayment = futurePlan.events.find((event) => event.eventKey === "ap-future-officehub-payment");
    expect(futurePayment).toMatchObject({ disposition: "BLOCKED_UNSUPPORTED" });
    expect(futurePayment?.reasonCodes).toContain(
      "CONTROL_BANK_DETAILS_VERIFICATION_BLOCK_NEW_PAYMENT_OR_BANK_CHANGE",
    );
    expect(futurePlan.operations.some((operation) => operation.eventId === futurePayment?.eventId)).toBe(false);
  });

  it("blocks broken bank roll-forward, FX, expense and goods-receipt equations", () => {
    for (const mutation of ["bank", "fx", "expense", "grn"] as const) {
      const mutated = clone();
      if (mutation === "bank") {
        const fact = mutated.facts.find((candidate) => candidate.kind === "BANK_STATEMENT_SUMMARY");
        if (!fact || fact.kind !== "BANK_STATEMENT_SUMMARY") throw new Error("bank summary missing");
        fact.closingBalance = "14554.00";
      } else if (mutation === "fx") {
        const fact = mutated.facts.find((candidate) => candidate.kind === "FX_SETTLEMENT");
        if (!fact || fact.kind !== "FX_SETTLEMENT") throw new Error("FX settlement missing");
        fact.cashBase = "1365.00";
      } else if (mutation === "expense") {
        const fact = mutated.facts.find((candidate) => candidate.kind === "EMPLOYEE_EXPENSE");
        if (!fact || fact.kind !== "EMPLOYEE_EXPENSE") throw new Error("expense missing");
        fact.lines[1]!.tax = "3.47";
        fact.lines[1]!.taxSemantics = "NONE";
      } else {
        const fact = mutated.facts.find((candidate) => candidate.kind === "GOODS_RECEIPT_CONTROL");
        if (!fact || fact.kind !== "GOODS_RECEIPT_CONTROL") throw new Error("GRN missing");
        fact.receivedQuantity = "8";
      }
      const compiled = compileAccountingCase(mutated);
      expect(compiled.status).toBe("BLOCKED_VALIDATION");
      expect(compiled.events.some((event) => event.disposition === "BLOCKED_VALIDATION")).toBe(true);
    }
  });

  it("rejects impossible calendar dates and due dates", () => {
    const impossible = clone();
    const invoice = impossible.facts.find((fact) => fact.factId === "fact-sales-invoice-v1");
    if (!invoice || invoice.kind !== "NATIVE_DOCUMENT") throw new Error("invoice missing");
    invoice.documentDate = "2026-02-31";
    expect(() => compileAccountingCase(impossible)).toThrow(/real calendar date/u);

    const reversed = clone();
    const bill = reversed.facts.find((fact) => fact.factId === "fact-officehub-bill-v1");
    if (!bill || bill.kind !== "NATIVE_DOCUMENT") throw new Error("bill missing");
    bill.dueDate = "2026-07-01";
    expect(() => compileAccountingCase(reversed)).toThrow(/must not be before documentDate/u);
  });
});
