import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../harness/fixtures/xero/${name}`, import.meta.url)), "utf8")) as T;
}

interface GoldenExpected {
  artifactCount: number;
  sourceUnitCount: number;
  factRequirementCount: number;
  eventCount: number;
  operationCount: number;
  eligibleOperations: Record<string, number>;
  eventDispositions: Record<string, string>;
  nonPostingSourceUnits: string[];
  requiredBankSourceUnits: string[];
  amountBridges: Record<string, { currency: string; net: string; tax: string; gross: string }>;
}

const input = fixture<PrepareAccountingCaseInput>("golden-14-case.v1.json");
const expected = fixture<GoldenExpected>("golden-14-expected.v1.json");

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const copy = [...values];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex]!, copy[index]!];
  }
  return copy;
}

describe("golden-14 Accounting Case", () => {
  it("turns all supplied source units into bounded events without pretending every image is a posting", () => {
    const compiled = compileAccountingCase(input);
    expect(compiled.sources).toHaveLength(expected.artifactCount);
    expect(compiled.coverage).toMatchObject({
      expectedArtifactCount: expected.artifactCount,
      expectedSourceUnitCount: expected.sourceUnitCount,
      expectedFactRequirementCount: expected.factRequirementCount,
      satisfiedFactRequirementCount: expected.factRequirementCount,
      missingFactRequirements: [],
      submittedFactsProcessed: true,
      allLedgerMutationsVerified: false,
    });
    expect(compiled.events).toHaveLength(expected.eventCount);
    expect(compiled.operations).toHaveLength(expected.operationCount);
    expect(compiled.status).toBe("PLANNED_WITH_EXCEPTIONS");
    expect(compiled.completionClaim).toEqual({
      suppliedSetCoverage: "COMPLETE",
      ledgerWrite: "NOT_WRITTEN",
      wholeBusinessCompleteness: "NOT_ASSERTED",
    });

    expect(Object.fromEntries(compiled.events.map((event) => [event.eventKey, event.disposition])))
      .toEqual(expected.eventDispositions);
    expect(compiled.operations.reduce<Record<string, number>>((counts, operation) => {
      counts[operation.actionId] = (counts[operation.actionId] ?? 0) + 1;
      return counts;
    }, {})).toEqual(expected.eligibleOperations);
  });

  it("keeps PO, GRN, remittance and embedded receipt as evidence instead of duplicate Xero writes", () => {
    const compiled = compileAccountingCase(input);
    expect(compiled.operations.some((operation) => operation.actionId.includes("purchase_order"))).toBe(false);
    for (const sourceUnit of expected.nonPostingSourceUnits) {
      expect(compiled.events.some((event) => event.sourceUnitIds.includes(sourceUnit))).toBe(true);
      expect(compiled.operations.some((operation) => {
        const event = compiled.events.find((candidate) => candidate.eventId === operation.eventId);
        return event?.sourceUnitIds.includes(sourceUnit);
      })).toBe(sourceUnit === "doc-03");
    }
    expect(compiled.events.find((event) => event.eventKey === "ar-customer-receipt")?.sourceUnitIds)
      .toEqual(["doc-07:customer-receipt", "doc-08"]);
    expect(compiled.events.find((event) => event.eventKey === "expense-alice-july")?.sourceUnitIds)
      .toEqual(["doc-11", "doc-12"]);
  });

  it("preserves the source amounts, native routes, tax semantics and separate FX dates/rates", () => {
    const compiled = compileAccountingCase(input);
    for (const [eventKey, amount] of Object.entries(expected.amountBridges)) {
      const event = compiled.events.find((candidate) => candidate.eventKey === eventKey);
      const operation = compiled.operations.find((candidate) => candidate.eventId === event?.eventId);
      expect(operation?.amountBridge).toMatchObject({
        currency: amount.currency,
        sourceNet: amount.net,
        sourceTax: amount.tax,
        sourceGross: amount.gross,
        canonicalNet: amount.net,
        canonicalTax: amount.tax,
        canonicalGross: amount.gross,
      });
    }

    const cloudBill = compiled.activeFacts.find((fact) => fact.factId === "fact-cloudhost-bill-v1");
    const settlement = compiled.activeFacts.find((fact) => fact.factId === "fact-cloudhost-settlement-v1");
    expect(cloudBill).toMatchObject({
      kind: "NATIVE_DOCUMENT",
      invoiceRate: "1.3500",
      lines: [expect.objectContaining({ accountCode: "485", taxType: "NONE" })],
    });
    const cloudOperation = compiled.operations.find((operation) => operation.eventId ===
      compiled.events.find((event) => event.eventKey === "ap-cloudhost-bill")?.eventId);
    expect(cloudOperation?.canonicalPayload).toMatchObject({
      taxSemantics: "NONE",
      taxType: "NONE",
      lines: [expect.objectContaining({ accountingCategory: "485", taxClass: "NONE" })],
    });
    expect(settlement).toMatchObject({
      kind: "FX_SETTLEMENT",
      settlementRate: "1.3650",
      principalBase: "1365.00",
      bankFeeBase: "15.00",
    });
    expect(compiled.events.find((event) => event.eventKey === "ap-cloudhost-settlement")?.disposition)
      .toBe("BLOCKED_UNSUPPORTED");
  });

  it("is invariant to source and fact arrival order", () => {
    const baseline = compileAccountingCase(input);
    const variants: PrepareAccountingCaseInput[] = [
      { ...input, sources: [...input.sources].reverse(), facts: [...input.facts].reverse() },
      { ...input, sources: deterministicShuffle(input.sources, 7), facts: deterministicShuffle(input.facts, 11) },
      { ...input, sources: deterministicShuffle(input.sources, 29), facts: deterministicShuffle(input.facts, 31) },
    ];
    const projection = (value: ReturnType<typeof compileAccountingCase>) => ({
      sourceRevisionHash: value.sourceRevisionHash,
      events: value.events,
      operations: value.operations.map((operation) => ({
        operationId: operation.operationId,
        eventId: operation.eventId,
        actionId: operation.actionId,
        canonicalPayloadHash: operation.canonicalPayloadHash,
      })),
      coverage: value.coverage,
    });
    for (const variant of variants) expect(projection(compileAccountingCase(variant))).toEqual(projection(baseline));
  });

  it.each(["doc-07:opening", "doc-07:customer-receipt", "doc-07:supplier-payment", "doc-07:bank-fee", "doc-07:prepayment"])(
    "blocks supplied-set completion when %s has no typed fact",
    (sourceUnit) => {
      const mutated: PrepareAccountingCaseInput = {
        ...input,
        facts: input.facts.filter((fact) => !fact.sourceUnitIds.includes(sourceUnit)),
      };
      const compiled = compileAccountingCase(mutated);
      expect(compiled.status).toBe("BLOCKED_COVERAGE");
      expect(compiled.coverage.missingFactRequirements).toContainEqual(expect.objectContaining({ sourceUnitId: sourceUnit }));
      expect(compiled.completionClaim.suppliedSetCoverage).toBe("INCOMPLETE");
      expect(compiled.completionClaim.ledgerWrite).toBe("NOT_WRITTEN");
    },
  );

  it("accounts for every expected bank-statement sub-event", () => {
    const compiled = compileAccountingCase(input);
    const covered = new Set(compiled.events.flatMap((event) => event.sourceUnitIds));
    for (const sourceUnit of expected.requiredBankSourceUnits) expect(covered.has(sourceUnit)).toBe(true);
  });
});
