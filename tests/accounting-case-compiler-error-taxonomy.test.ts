import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AccountingCaseCompilationError,
} from "../src/control-kernel/accountingCaseCompiler.js";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

function cloneFixture(): PrepareAccountingCaseInput {
  return structuredClone(fixture);
}

function reasonFrom(run: () => unknown): AccountingCaseCompilationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountingCaseCompilationError);
    return error as AccountingCaseCompilationError;
  }
  throw new Error("expected deterministic Accounting Case compilation to fail");
}

describe("Accounting Case compiler error taxonomy", () => {
  it.each([
    {
      name: "payment amount bridge",
      mutate(input: PrepareAccountingCaseInput) {
        const fact = input.facts.find((candidate) => candidate.kind === "PAYMENT");
        if (!fact || fact.kind !== "PAYMENT") throw new Error("payment fixture missing");
        fact.amount = "1.00";
      },
      reason: "PAYMENT_DOCUMENT_BRIDGE_MISMATCH",
    },
    {
      name: "FX relation",
      mutate(input: PrepareAccountingCaseInput) {
        const fact = input.facts.find((candidate) => candidate.kind === "FX_SETTLEMENT");
        if (!fact || fact.kind !== "FX_SETTLEMENT") throw new Error("FX fixture missing");
        fact.invoiceEventKey = "missing-invoice-event";
      },
      reason: "FX_SUPPLIER_INVOICE_RELATION_MISSING",
    },
    {
      name: "evidence relation",
      mutate(input: PrepareAccountingCaseInput) {
        const fact = input.facts.find((candidate) => candidate.kind === "EVIDENCE" && candidate.relatedEventKey);
        if (!fact || fact.kind !== "EVIDENCE") throw new Error("evidence fixture missing");
        fact.relatedEventKey = "missing-evidence-event";
      },
      reason: "EVIDENCE_EVENT_RELATION_MISSING",
    },
    {
      name: "control relation",
      mutate(input: PrepareAccountingCaseInput) {
        const fact = input.facts.find((candidate) => candidate.kind === "CONTROL_FINDING" && candidate.relatedEventKey);
        if (!fact || fact.kind !== "CONTROL_FINDING") throw new Error("control fixture missing");
        fact.relatedEventKey = "missing-control-event";
      },
      reason: "CONTROL_EVENT_RELATION_MISSING",
    },
    {
      name: "source fact declaration",
      mutate(input: PrepareAccountingCaseInput) {
        const fact = input.facts.find((candidate) => candidate.kind === "EVIDENCE");
        if (!fact) throw new Error("evidence fixture missing");
        const unit = input.sources.flatMap((source) => source.units)
          .find((candidate) => candidate.unitId === fact.sourceUnitIds[0]);
        if (!unit) throw new Error("source unit missing");
        unit.expectedFactKinds = ["CONTACT_CANDIDATE"];
      },
      reason: "SOURCE_FACT_KIND_UNDECLARED",
    },
  ])("emits a stable non-provider diagnostic for $name", ({ mutate, reason }) => {
    const input = cloneFixture();
    mutate(input);
    const error = reasonFrom(() => compileAccountingCase(input));
    expect(error).toMatchObject({ reasonCode: reason });
    expect(error.path).not.toBe("");
  });
});
