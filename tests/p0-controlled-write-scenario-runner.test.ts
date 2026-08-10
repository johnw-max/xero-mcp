import { describe, expect, it } from "vitest";
import { oracleRunSchema } from "../harness/lib/oracleResultRuntimeSchema.js";
import { executeP0ControlledWriteSuite } from "../harness/runners/run-p0-controlled-write.js";

describe("local P0 controlled-write scenario runner", () => {
  it("captures the six manifest cases with exact Provider, gate, recovery, and duplicate evidence", async () => {
    const result = await executeP0ControlledWriteSuite({
      runId: "p0-controlled-write-vitest-001",
      writeArtifacts: false,
    });

    expect(() => oracleRunSchema.parse(result.report)).not.toThrow();
    expect(result.report.case_results.map((item) => item.case_id)).toEqual([
      "DC-IDEMPOTENCY-012",
      "DC-CONCURRENT-012B",
      "DC-DUPLICATE-013",
      "DC-RECOVERY-014",
      "DC-READBACK-014B",
      "DC-REPOSITORY-014C",
    ]);
    expect(result.report.summary).toMatchObject({ total: 6, pass: 6, fail: 0 });
    expect(result.providerWriteAttempts).toBe(6);
    expect(result.providerRecords).toHaveLength(6);
    expect(result.providerRecords.every((record) => record.status === "DRAFT" && record.bill.status === "DRAFT"))
      .toBe(true);
    expect(result.providerAuthoriseAttempts).toBe(0);
    expect(result.report.environment).toMatchObject({
      target: "IN_MEMORY",
      data_class: "SYNTHETIC_ONLY",
      write_gate_start: "CLOSED",
      write_gate_end: "CLOSED",
      secrets_redacted: true,
    });

    const expectedPasses = [
      "DC-IDEMPOTENCY-012",
      "DC-CONCURRENT-012B",
      "DC-DUPLICATE-013",
      "DC-RECOVERY-014",
      "DC-READBACK-014B",
      "DC-REPOSITORY-014C",
    ];
    expect(result.report.case_results.filter((item) => item.actual_status === "PASS").map((item) => item.case_id))
      .toEqual(expectedPasses);

    const concurrent = result.report.case_results.find((item) => item.case_id === "DC-CONCURRENT-012B");
    expect(concurrent).toMatchObject({ actual_status: "PASS", hard_gate_passed: true });
    expect(concurrent?.oracle_results.find((item) => item.oracle_id === "two_mcp_calls_completed"))
      .toMatchObject({
        status: "PASS",
        observed: { firstIsError: false, secondIsError: false },
      });
    expect(concurrent?.oracle_results.find((item) => item.oracle_id === "concurrent_one_provider_write"))
      .toMatchObject({ status: "PASS", observed: 1 });
    expect(concurrent?.oracle_results.find((item) => item.oracle_id === "concurrent_one_provider_record"))
      .toMatchObject({ status: "PASS", observed: 1 });
    expect(concurrent?.oracle_results.find((item) => item.oracle_id === "concurrent_one_preparation"))
      .toMatchObject({ status: "PASS" });

    const idempotency = result.report.case_results.find((item) => item.case_id === "DC-IDEMPOTENCY-012");
    expect(idempotency?.oracle_results.find((item) => item.oracle_id === "one_time_confirmation_readback_verified"))
      .toMatchObject({
        status: "PASS",
        observed: { state: "READBACK_VERIFIED" },
      });

    const duplicate = result.report.case_results.find((item) => item.case_id === "DC-DUPLICATE-013");
    expect(duplicate).toMatchObject({ baseline_expectation: "EXPECTED_RED", actual_status: "PASS" });
    expect(duplicate?.oracle_results.find((item) => item.oracle_id === "rejected_still_blocks_new_request"))
      .toMatchObject({ status: "PASS", observed: "CONFLICT" });

    for (const caseId of ["DC-RECOVERY-014", "DC-REPOSITORY-014C"]) {
      const recovery = result.report.case_results.find((item) => item.case_id === caseId);
      expect(recovery?.oracle_results.some((item) =>
        ["recovery_readback_only", "completion_recovery_readback_only"].includes(item.oracle_id) &&
        item.status === "PASS")).toBe(true);
    }

    expect(result.gateEvents).toHaveLength(24);
    for (const caseId of result.report.case_results.map((item) => item.case_id)) {
      const events = result.gateEvents.filter((event) => event.caseId === caseId);
      expect(events.map((event) => [event.action, event.state])).toEqual([
        ["START", "CLOSED"],
        ["OPEN", "OPEN"],
        ["CLOSE", "CLOSED"],
        ["END", "CLOSED"],
      ]);
      expect(events.every((event) => event.authoriseForbidden === true && event.paymentForbidden === true)).toBe(true);
    }

    const evidenceKinds = new Set(result.evidence.map((item) => item.kind));
    expect(evidenceKinds).toEqual(new Set([
      "STATE_PROBE",
      "REPOSITORY_STATE",
      "TOOL_CALL",
      "TOOL_OUTPUT",
      "PROVIDER_CALL",
      "PROVIDER_RECORD",
    ]));

    const toolCalls = result.evidence
      .filter((item) => item.kind === "TOOL_CALL")
      .map((item) => item.payload as { tool?: string; input?: Record<string, unknown> });
    const prepareCalls = toolCalls.filter((item) => item.tool === "xero_prepare_supplier_bill_draft");
    const executeCalls = toolCalls.filter((item) => item.tool === "xero_create_draft_supplier_bill");
    expect(new Set(result.report.case_results.map((item) => item.case_id))).toEqual(
      new Set(result.evidence
        .filter((item) => item.kind === "TOOL_CALL" &&
          (item.payload as { tool?: string }).tool === "xero_prepare_supplier_bill_draft")
        .map((item) => item.case_id)),
    );
    expect(prepareCalls.length).toBeGreaterThanOrEqual(6);
    expect(executeCalls.length).toBeGreaterThanOrEqual(6);
    for (const call of executeCalls) {
      expect(Object.keys(call.input ?? {}).sort()).toEqual([
        "confirmation_phrase",
        "preparation_id",
        "request_id",
      ]);
      expect(call.input).not.toHaveProperty("contact_id");
      expect(call.input).not.toHaveProperty("lines");
      expect(call.input).not.toHaveProperty("reference");
      expect(call.input).not.toHaveProperty("source_sha256");
      expect(call.input).not.toHaveProperty("user_confirmation");
    }

    const preparationOutputs = result.evidence
      .filter((item) => item.kind === "TOOL_OUTPUT" &&
        (item.payload as { tool?: string }).tool === "xero_prepare_supplier_bill_draft")
      .map((item) => (item.payload as {
        structuredContent?: { result?: Record<string, unknown> };
      }).structuredContent?.result);
    expect(preparationOutputs).toHaveLength(prepareCalls.length);
    expect(preparationOutputs.every((output) =>
      output?.technicallyReady === true &&
      typeof output.preparation_id === "string" &&
      typeof output.confirmation_phrase === "string" &&
      output.executionAllowed === false)).toBe(true);

    const auditRecords = result.evidence
      .filter((item) => item.kind === "REPOSITORY_STATE" && item.label.endsWith(":audit-records"))
      .flatMap((item) => {
        const payload = item.payload as { audits?: Array<Record<string, unknown>> };
        return payload.audits ?? [];
      });
    expect(auditRecords.some((record) => record.toolName === "xero_prepare_supplier_bill_draft")).toBe(true);
    expect(auditRecords.some((record) => record.toolName === "xero_create_draft_supplier_bill")).toBe(true);
    expect(auditRecords.every((record) =>
      typeof record.actorId === "string" &&
      typeof record.requestHash === "string" &&
      typeof record.resultStatus === "string")).toBe(true);
  });
});
