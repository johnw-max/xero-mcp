import { describe, expect, it } from "vitest";
import { oracleRunSchema } from "../harness/lib/oracleResultRuntimeSchema.js";
import { executeP0AccountingCaseSuite } from "../harness/runners/run-p0-accounting-case.js";

describe("current Accounting Case controlled-write release runner", () => {
  it("proves the 28-tool Case surface, prepare-without-write and receipt/readback-bounded autonomous execute", async () => {
    const result = await executeP0AccountingCaseSuite({
      runId: "p0-accounting-case-vitest-001",
      writeArtifacts: false,
    });

    expect(() => oracleRunSchema.parse(result.report)).not.toThrow();
    expect(result.report.case_results.map((item) => item.case_id)).toEqual([
      "AC-SURFACE-001",
      "AC-CASE-PREPARE-002",
      "AC-DELEGATION-003",
    ]);
    expect(
      result.report.summary,
      JSON.stringify(result.report.case_results, null, 2),
    ).toMatchObject({ total: 3, pass: 3, fail: 0 });
    expect(result.report.environment).toMatchObject({
      target: "IN_MEMORY",
      data_class: "SYNTHETIC_ONLY",
      write_gate_start: "CLOSED",
      write_gate_end: "CLOSED",
      secrets_redacted: true,
      mcp_server_version: "0.4.0-rc.1",
    });

    const surface = result.report.case_results.find((item) => item.case_id === "AC-SURFACE-001");
    expect(surface).toMatchObject({ actual_status: "PASS", hard_gate_passed: true });
    expect(surface?.oracle_results.find((item) => item.oracle_id === "exact_28_tools")).toMatchObject({
      status: "PASS",
      observed: { expectedCount: 28, actualCount: 28 },
    });
    expect(surface?.oracle_results.find((item) => item.oracle_id === "legacy_mutation_tools_absent"))
      .toMatchObject({ status: "PASS", observed: { advertised: false, directCallRejected: true } });
    expect(surface?.oracle_results.find((item) => item.oracle_id === "execute_payload_injection_rejected"))
      .toMatchObject({ status: "PASS", observed: { rejected: true, caseServiceExecuteCalls: 0 } });

    const prepared = result.report.case_results.find((item) => item.case_id === "AC-CASE-PREPARE-002");
    expect(prepared?.oracle_results.find((item) => item.oracle_id === "prepare_not_written")).toMatchObject({
      status: "PASS",
      observed: {
        providerWriteAttemptsBefore: 0,
        providerWriteAttemptsAfter: 0,
        ledgerWriteClaim: "NOT_WRITTEN",
      },
    });

    const executed = result.report.case_results.find((item) => item.case_id === "AC-DELEGATION-003");
    for (const oracleId of [
      "execute_identity_only",
      "standing_delegation_preflight",
      "durable_mutation_projection",
      "terminal_requires_receipt_and_readback",
      "same_request_idempotent_replay",
      "status_preserves_terminal_evidence",
      "write_gate_closed_after_run",
    ]) {
      expect(executed?.oracle_results.find((item) => item.oracle_id === oracleId)).toMatchObject({ status: "PASS" });
    }
    expect(result.standingDelegationPreflights).toEqual([["customer_invoice.create_draft"]]);
    expect(result.providerWriteAttempts).toBe(1);
    expect(result.providerRecords).toEqual([expect.objectContaining({
      status: "DRAFT",
      provider_receipt: expect.objectContaining({ providerRequestId: "provider-request-case-001" }),
      exact_readback: expect.objectContaining({ status: "DRAFT" }),
    })]);

    const executeCalls = result.toolCalls.filter((call) => call.tool === "xero_execute_accounting_case");
    const acceptedExecuteCalls = executeCalls.filter((call) => !Object.hasOwn(call.input, "payload"));
    expect(acceptedExecuteCalls).toHaveLength(2);
    for (const call of acceptedExecuteCalls) {
      expect(Object.keys(call.input).sort()).toEqual(["case_id", "case_version", "request_id"]);
      expect(call.input).not.toHaveProperty("tenant_id");
      expect(call.input).not.toHaveProperty("operation_id");
      expect(call.input).not.toHaveProperty("confirmation_phrase");
      expect(call.input).not.toHaveProperty("user_confirmation");
    }
    expect(result.toolCalls.some((call) => call.tool === "xero_create_draft_supplier_bill")).toBe(true);
  });

  it("fails closed when provider GET returns self-consistent but wrong tax economics and never writes again", async () => {
    const result = await executeP0AccountingCaseSuite({
      runId: "p0-accounting-case-wrong-economics-001",
      writeArtifacts: false,
      providerEconomicMutation: "SELF_CONSISTENT_WRONG_TAX_AND_TOTAL",
    });

    expect(() => oracleRunSchema.parse(result.report)).not.toThrow();
    expect(result.report.summary).toMatchObject({ total: 3, pass: 2, fail: 1 });
    expect(result.finalCaseState).toBe("RECOVERY_REQUIRED");
    expect(
      result.finalOperationStates,
      JSON.stringify(result.report.case_results, null, 2),
    ).toEqual(["READBACK_MISMATCH"]);
    expect(result.providerWriteAttempts).toBe(1);
    expect(result.providerRecords).toEqual([expect.objectContaining({
      exact_readback: expect.objectContaining({
        subTotal: "100.0000",
        totalTax: "7.2000",
        total: "107.2000",
        lines: [expect.objectContaining({ lineAmount: "100.0000", taxAmount: "7.2000" })],
      }),
    })]);

    // The suite itself calls execute twice. Recovery may perform exact GET,
    // but the consumed one-shot provider create is never reopened.
    const acceptedExecuteCalls = result.toolCalls.filter((call) =>
      call.tool === "xero_execute_accounting_case" && !Object.hasOwn(call.input, "payload"));
    expect(acceptedExecuteCalls).toHaveLength(2);
    expect(result.providerWriteAttempts).toBe(1);
    const executeCase = result.report.case_results.find((item) => item.case_id === "AC-DELEGATION-003");
    expect(executeCase).toMatchObject({ actual_status: "FAIL", hard_gate_passed: false });
    expect(executeCase?.oracle_results.find((item) => item.oracle_id === "terminal_requires_receipt_and_readback"))
      .toMatchObject({ status: "FAIL" });
  });
});
