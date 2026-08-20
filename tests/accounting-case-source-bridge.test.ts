import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileTestXeroAccountingCase as compileAccountingCase,
  validateTestXeroCompiledOperationAgainstSource as validateCompiledOperationAgainstSource,
} from "./helpers/xeroTenantCoaProfile.js";
import type {
  AccountingCaseOperation,
  NativeDocumentFact,
} from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";

const input = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

function supplierCredit(): {
  operation: AccountingCaseOperation;
  fact: NativeDocumentFact;
  policyProjection: Readonly<Record<string, unknown>>;
} {
  const compiled = compileAccountingCase(input);
  const fact = compiled.activeFacts.find((candidate): candidate is NativeDocumentFact =>
    candidate.factId === "fact-supplier-credit-v1" && candidate.kind === "NATIVE_DOCUMENT");
  if (!fact) throw new Error("supplier credit fact missing");
  const event = compiled.events.find((candidate) => candidate.eventKey === fact.eventKey);
  const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
  if (!operation) throw new Error("supplier credit operation missing");
  return { operation, fact, policyProjection: compiled.policyProjection };
}

describe("Accounting Case source amount bridge", () => {
  it("accepts the genuine OfficeHub SGD 80 + 7.20 = 87.20 supplier credit", () => {
    const { operation, fact, policyProjection } = supplierCredit();
    expect(validateCompiledOperationAgainstSource(operation, fact, policyProjection)).toEqual([]);
  });

  it("rejects the observed 80-to-800 mutation even when the attacker makes 807.20 formally self-consistent", () => {
    const { operation, fact, policyProjection } = supplierCredit();
    const mutated: AccountingCaseOperation = {
      ...operation,
      amountBridge: {
        ...operation.amountBridge!,
        canonicalNet: "800.0000",
        canonicalTax: "7.2000",
        canonicalGross: "807.2000",
      },
      canonicalPayload: {
        ...operation.canonicalPayload,
        net: "800.0000",
        tax: "7.2000",
        gross: "807.2000",
      },
    };
    expect(validateCompiledOperationAgainstSource(mutated, fact, policyProjection)).toEqual(expect.arrayContaining([
      "AMOUNT_BRIDGE_MISMATCH",
      "CANONICAL_PAYLOAD_HASH_MISMATCH",
      "CANONICAL_PAYLOAD_MISMATCH",
      "SOURCE_GROSS_MISMATCH",
      "SOURCE_NET_MISMATCH",
    ]));
  });

  it("rejects a lying total and a native-route-to-manual-journal style fallback", () => {
    const { operation, fact, policyProjection } = supplierCredit();
    const lyingTotal: AccountingCaseOperation = {
      ...operation,
      amountBridge: {
        ...operation.amountBridge!,
        canonicalNet: "800.0000",
        canonicalTax: "7.2000",
        canonicalGross: "87.2000",
      },
      canonicalPayload: {
        ...operation.canonicalPayload,
        net: "800.0000",
        tax: "7.2000",
        gross: "87.2000",
      },
    };
    expect(validateCompiledOperationAgainstSource(lyingTotal, fact, policyProjection)).toEqual(expect.arrayContaining([
      "AMOUNT_BRIDGE_MISMATCH",
      "CANONICAL_TOTAL_MISMATCH",
      "SOURCE_NET_MISMATCH",
    ]));

    const wrongRoute = { ...operation, nativeRoute: "SUPPLIER_BILL" as const };
    expect(validateCompiledOperationAgainstSource(wrongRoute, fact, policyProjection)).toEqual(["NATIVE_ROUTE_REQUIRED"]);

    const manualJournalFallback = {
      ...operation,
      actionId: "manual_journal.create_draft",
    } as unknown as AccountingCaseOperation;
    expect(validateCompiledOperationAgainstSource(manualJournalFallback, fact, policyProjection)).toContain("ACTION_ROUTE_MISMATCH");
  });

  it("changes the source revision and operation identity after a genuine source correction", () => {
    const baseline = compileAccountingCase(input);
    const original = input.facts.find((fact): fact is NativeDocumentFact =>
      fact.factId === "fact-supplier-credit-v1" && fact.kind === "NATIVE_DOCUMENT");
    if (!original) throw new Error("supplier credit source fact missing");
    const correctedFact: NativeDocumentFact = {
      ...original,
      factId: "fact-supplier-credit-v2",
      revision: 2,
      supersedesFactId: original.factId,
      lines: [{
        ...original.lines[0]!,
        quantity: "10",
        unitAmount: "80.00",
        sourceTax: "72.00",
      }],
      declaredNet: "800.00",
      declaredTax: "72.00",
      declaredGross: "872.00",
    };
    const correctedInput: PrepareAccountingCaseInput = {
      ...input,
      expectedVersion: 1,
      facts: [...input.facts, correctedFact],
    };
    const corrected = compileAccountingCase(correctedInput);
    const oldOperation = baseline.operations.find((operation) => operation.nativeRoute === "SUPPLIER_CREDIT");
    const newOperation = corrected.operations.find((operation) => operation.nativeRoute === "SUPPLIER_CREDIT");
    expect(corrected.version).toBe(2);
    expect(corrected.sourceRevisionHash).not.toBe(baseline.sourceRevisionHash);
    expect(newOperation?.operationId).not.toBe(oldOperation?.operationId);
    expect(newOperation?.sourceRevisionHash).toBe(corrected.sourceRevisionHash);
  });

  it("does not let a self-consistent MODEL_EXTRACTED credit exceed the server-resolved original line semantics", () => {
    const consistentlyWrong: PrepareAccountingCaseInput = {
      ...input,
      facts: input.facts.map((fact) => fact.factId === "fact-supplier-credit-v1" && fact.kind === "NATIVE_DOCUMENT"
        ? {
            ...fact,
            origin: "MODEL_EXTRACTED" as const,
            lines: [{ ...fact.lines[0]!, unitAmount: "800.00", sourceTax: "72.00" }],
            declaredNet: "800.00",
            declaredTax: "72.00",
            declaredGross: "872.00",
          }
        : fact),
    };
    const compiled = compileAccountingCase(consistentlyWrong);
    const operation = compiled.operations.find((candidate) => candidate.nativeRoute === "SUPPLIER_CREDIT");
    expect(operation).toBeUndefined();
    expect(compiled.events.find((event) => event.eventKey === "ap-supplier-credit")).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["CREDIT_LINE_NOT_A_CONSUMABLE_ORIGINAL_SUBSET"]),
    });
    expect(compiled.activeFacts.find((fact) => fact.factId === "fact-supplier-credit-v1")?.origin)
      .toBe("MODEL_EXTRACTED");
  });
});
