import { describe, expect, it } from "vitest";
import { oracleRunSchema } from "../harness/lib/oracleResultRuntimeSchema.js";
import {
  executeP0ReadOnlySuite,
  meaningfulTrialBalanceBound,
} from "../harness/runners/run-p0-readonly.js";
import {
  boundXeroTrialBalanceForAgent,
  createXeroTrialBalanceCallToolResult,
} from "../src/services/xeroTrialBalanceBounds.js";

describe("local P0 read-only scenario runner", () => {
  it("executes the selected manifest cases through production MCP/service boundaries with hard evidence", async () => {
    const result = await executeP0ReadOnlySuite({
      runId: "p0-readonly-vitest-001",
      writeArtifacts: false,
    });

    expect(() => oracleRunSchema.parse(result.report)).not.toThrow();
    expect(result.report.case_results.map((item) => item.case_id)).toEqual([
      "DC-CONNECTION-001",
      "DC-LEDGER-002",
      "DC-HISTORY-003",
      "DC-MATCH-004",
      "DC-PAYMENT-005",
      "DC-CREDIT-006",
      "DC-VERSION-008",
    ]);
    expect(result.report.summary).toMatchObject({ total: 7, pass: 7, fail: 0 });
    expect(result.providerWriteAttempts).toBe(0);
    expect(result.report.environment).toMatchObject({
      target: "IN_MEMORY",
      data_class: "SYNTHETIC_ONLY",
      write_gate_start: "CLOSED",
      write_gate_end: "CLOSED",
      secrets_redacted: true,
    });
    expect(result.report.case_results.every((item) =>
      item.actual_status === "PASS" && item.hard_gate_passed && !item.expected_red_observed)).toBe(true);
    expect(result.report.case_results.every((item) =>
      item.oracle_results.every((oracle) => oracle.status === "PASS" && oracle.evidence_refs.length > 0))).toBe(true);

    const ledger = result.report.case_results.find((item) => item.case_id === "DC-LEDGER-002");
    expect(ledger).toMatchObject({ baseline_expectation: "EXPECTED_RED", actual_status: "PASS" });
    expect(ledger?.oracle_results.find((item) => item.oracle_id === "tb_explicit_bound")).toMatchObject({
      status: "PASS",
      observed: expect.objectContaining({
        contentOnly: true,
        structuredContentPresent: false,
        mcpTruncated: true,
        contractPinned: true,
        independentlyMeasuredBudgets: true,
        validVisitedNodeBound: true,
        honestSourceMeasurement: true,
        validTruncation: true,
        honestProviderCompleteness: true,
      }),
    });

    const history = result.report.case_results.find((item) => item.case_id === "DC-HISTORY-003");
    expect(history?.oracle_results.find((item) => item.oracle_id === "all_ap_payment_types_seen")?.observed)
      .toEqual(expect.arrayContaining([
        "ACCPAYPAYMENT",
        "APCREDITPAYMENT",
        "APPREPAYMENTPAYMENT",
        "APOVERPAYMENTPAYMENT",
      ]));

    const evidenceKinds = new Set(result.evidence.map((item) => item.kind));
    expect(evidenceKinds).toEqual(new Set([
      "STATE_PROBE",
      "TOOL_OUTPUT",
      "TOOL_CALL",
      "PROVIDER_CALL",
      "REPOSITORY_STATE",
      "NETWORK_RECEIPT",
    ]));
    expect(result.evidence.some((item) => item.label === "read_only_write_probe:provider-calls" &&
      JSON.stringify(item.payload).includes('"providerWriteAttempts":0'))).toBe(true);
  });

  it("rejects any attempt to turn an observed expected red into PASS", () => {
    const invalid = {
      schema_version: "1.0",
      run_id: "invalid-red-run",
      suite_id: "xero-deterministic-contract-p0",
      layer: "DETERMINISTIC_CONTRACT",
      started_at: "2026-08-06T00:00:00.000Z",
      finished_at: "2026-08-06T00:00:01.000Z",
      environment: {
        target: "IN_MEMORY",
        data_class: "SYNTHETIC_ONLY",
        write_gate_start: "CLOSED",
        write_gate_end: "CLOSED",
        secrets_redacted: true,
      },
      case_results: [{
        case_id: "DC-LEDGER-002",
        persona_id: "protocol_security_agent",
        baseline_expectation: "EXPECTED_RED",
        actual_status: "PASS",
        hard_gate_passed: true,
        expected_red_observed: true,
        oracle_results: [{
          oracle_id: "tb_explicit_bound",
          strength: "HARD",
          status: "FAIL",
          observed: { paginationPresent: false },
          evidence_refs: ["evidence.jsonl#ev_00001"],
        }],
        evidence_refs: ["evidence.jsonl#ev_00001"],
      }],
      summary: {
        total: 1,
        pass: 1,
        fail: 0,
        blocked_model_provider: 0,
        blocked_env: 0,
        blocked_test_data: 0,
        unsupported: 0,
        flaky: 0,
        not_run: 0,
      },
      claim_guardrail_violations: [],
    };

    expect(oracleRunSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects forged Trial Balance byte and completeness metadata", () => {
    const bounded = boundXeroTrialBalanceForAgent({
      reports: [{
        reportName: "Trial Balance",
        reportDate: "6 August 2026",
        rows: [{ rowType: "Row", cells: [{ value: "485" }, { value: "100.00" }, { value: "0.00" }] }],
      }],
    });
    const honest = createXeroTrialBalanceCallToolResult(bounded);

    expect(meaningfulTrialBalanceBound(honest).passed).toBe(true);

    const forgedCompleteness = JSON.parse(JSON.stringify(honest)) as {
      content: Array<{ type: string; text: string }>;
    };
    const forgedPayload = JSON.parse(forgedCompleteness.content[0]!.text) as {
      result: {
        pagination: {
          providerCompleteness: { status: string; auditCompleteness: string };
        };
      };
    };
    forgedPayload.result.pagination.providerCompleteness.status = "COMPLETE";
    forgedPayload.result.pagination.providerCompleteness.auditCompleteness = "ESTABLISHED";
    forgedCompleteness.content[0]!.text = JSON.stringify(forgedPayload);
    const completenessVerdict = meaningfulTrialBalanceBound(forgedCompleteness);

    expect(completenessVerdict.passed).toBe(false);
    expect(completenessVerdict.observed.honestProviderCompleteness).toBe(false);

    const forgedBytes = JSON.parse(JSON.stringify(honest)) as {
      content: Array<{ type: string; text: string }>;
    };
    const bytePayload = JSON.parse(forgedBytes.content[0]!.text) as {
      result: {
        pagination: { modelTextUtf8Bytes: number; callToolResultUtf8Bytes: number };
      };
    };
    bytePayload.result.pagination.modelTextUtf8Bytes = 1;
    bytePayload.result.pagination.callToolResultUtf8Bytes = 1;
    forgedBytes.content[0]!.text = JSON.stringify(bytePayload);
    const byteVerdict = meaningfulTrialBalanceBound(forgedBytes);

    expect(byteVerdict.passed).toBe(false);
    expect(byteVerdict.observed.independentlyMeasuredBudgets).toBe(false);

    const duplicated = JSON.parse(JSON.stringify(honest)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    duplicated.structuredContent = JSON.parse(duplicated.content[0]!.text);
    const duplicationVerdict = meaningfulTrialBalanceBound(duplicated);

    expect(duplicationVerdict.passed).toBe(false);
    expect(duplicationVerdict.observed.contentOnly).toBe(false);
    expect(duplicationVerdict.observed.structuredContentPresent).toBe(true);
  });
});
