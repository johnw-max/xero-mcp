import { describe, expect, it } from "vitest";
import {
  parseCrashScenarioJsonl,
  recomputeCrashScenario,
} from "../scripts/release/process-crash-evidence-lib.mjs";

const scenario = "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE";

function rawRecords() {
  const records: Array<Record<string, unknown>> = [];
  const add = (
    source: string,
    pid: number | null,
    event: string,
    details: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) => records.push({
    schema_version: "1.0",
    sequence: records.length + 1,
    timestamp: `2026-08-13T12:00:${String(records.length).padStart(2, "0")}.000Z`,
    scenario_id: scenario,
    source,
    pid,
    event,
    state: null,
    provider_write_count: null,
    provider_get_count: null,
    request_id: "execute-replay-test",
    object_id: null,
    details,
    ...overrides,
  });
  add("PARENT", 101, "INITIAL_PROCESS_SPAWNED", { parent_pid: 7 });
  add("CHILD_INITIAL", 101, "CRASH_WINDOW_REACHED", { scenario_id: scenario }, { state: "TERMINAL" });
  const providerEvents = [
    { sequence_id: "1", process_pid: 101, operation: "CREATE_ATTEMPT", object_id: "invoice-1", details: {} },
    { sequence_id: "2", process_pid: 101, operation: "CREATE_ACCEPTED", object_id: "invoice-1", details: {} },
    { sequence_id: "3", process_pid: 101, operation: "GET", object_id: "invoice-1", details: {} },
  ];
  const snapshot = {
    case_versions: [{ state: "TERMINAL" }],
    case_operations: [{
      state: "READBACK_VERIFIED",
      xero_object_id: "invoice-1",
      has_write_receipt: true,
      has_readback_snapshot: true,
    }],
    mutation_requests: [{
      state: "READBACK_VERIFIED",
      xero_object_id: "invoice-1",
      has_write_receipt: true,
      has_readback_snapshot: true,
      readback_status: "DRAFT",
    }],
    posting_requests: [{
      state: "DRAFT_READBACK_VERIFIED",
      xero_invoice_id: "invoice-1",
      has_write_receipt: true,
      has_readback_snapshot: true,
    }],
    provider_ledger: [{ object_id: "invoice-1", status: "DRAFT", readback_object_id: "invoice-1" }],
    provider_events: providerEvents,
    provider_counts: { create_attempts: 1, create_accepts: 1, gets: 1 },
    postgres: { storage_mode: "POSTGRES", migration_head: "032_ledger_authority_snapshots.sql" },
  };
  add("PARENT_POSTGRES", 101, "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL", structuredClone(snapshot), {
    state: "TERMINAL",
    provider_write_count: 1,
    provider_get_count: 1,
    object_id: "invoice-1",
  });
  add("PARENT", 101, "PARENT_KILL_INVOKED", { parent_pid: 7, signal: "SIGKILL", target_pid: 101 }, {
    provider_write_count: 1,
    provider_get_count: 1,
  });
  add("PARENT", 101, "INITIAL_PROCESS_EXIT", { code: null, signal: "SIGKILL", kill_returned: true });
  add("PARENT", 202, "RESTART_PROCESS_SPAWNED", { parent_pid: 7 });
  add("CHILD_RESTART", 202, "PROCESS_RESULT", { result_state: "TERMINAL" });
  add("PARENT_POSTGRES", 202, "POSTGRES_DURABLE_SNAPSHOT_AFTER_RESTART", snapshot, {
    state: "TERMINAL",
    provider_write_count: 1,
    provider_get_count: 1,
    object_id: "invoice-1",
  });
  add("PARENT_POSTGRES", 202, "PROVIDER_DURABLE_LEDGER_AFTER_RESTART", {
    provider_ledger: snapshot.provider_ledger,
    provider_events: providerEvents,
  }, {
    state: "OBJECT_DURABLE",
    provider_write_count: 1,
    provider_get_count: 1,
    object_id: "invoice-1",
  });
  return records;
}

describe("process crash raw-evidence replay", () => {
  it("derives terminal idempotent replay only from structured raw lifecycle facts", () => {
    const parsed = parseCrashScenarioJsonl(
      `${rawRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
      scenario,
    );
    expect(recomputeCrashScenario(parsed, scenario, "raw/scenario.jsonl")).toEqual({
      scenario_id: scenario,
      status: "PASS",
      termination: "PROCESS_KILL",
      termination_signal: "SIGKILL",
      command: "node --import tsx harness/lifecycle/process-crash-worker.ts",
      server_pid_before: 101,
      server_pid_after: 202,
      restart_observed: true,
      provider_write_count_after_restart: 1,
      recovery_outcome: "IDEMPOTENT_REPLAY",
      evidence_refs: ["raw/scenario.jsonl"],
    });
  });

  it("fails closed when the raw kill signal or sequence is tampered", () => {
    const signalTamper = rawRecords();
    const killed = signalTamper.find((record) => record.event === "INITIAL_PROCESS_EXIT")!;
    (killed.details as Record<string, unknown>).signal = "SIGTERM";
    expect(() => recomputeCrashScenario(signalTamper, scenario, "raw/scenario.jsonl"))
      .toThrow(/SIGKILL_NOT_PROVED/u);

    const sequenceTamper = rawRecords();
    sequenceTamper[5]!.sequence = 99;
    expect(() => parseCrashScenarioJsonl(
      `${sequenceTamper.map((record) => JSON.stringify(record)).join("\n")}\n`,
      scenario,
    )).toThrow(/RAW_RECORD_INVALID/u);
  });

  it("fails closed when a restart issues a second Provider create", () => {
    const duplicated = rawRecords();
    const afterRestart = duplicated.find((record) =>
      record.event === "POSTGRES_DURABLE_SNAPSHOT_AFTER_RESTART")!;
    const snapshot = (afterRestart.details as Record<string, unknown>);
    const events = snapshot.provider_events as Array<Record<string, unknown>>;
    events.push({
      sequence_id: "3",
      process_pid: 202,
      operation: "CREATE_ATTEMPT",
      object_id: "invoice-1",
      details: {},
    });
    expect(() => recomputeCrashScenario(duplicated, scenario, "raw/scenario.jsonl"))
      .toThrow(/PROVIDER_AT_MOST_ONCE_FAILED/u);
  });

  it("requires a durable pre-kill snapshot between the crash hook and SIGKILL", () => {
    const missing = rawRecords().filter((record) => record.event !== "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL");
    expect(() => recomputeCrashScenario(missing, scenario, "raw/scenario.jsonl"))
      .toThrow(/POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL_COUNT_0/u);

    const reordered = rawRecords();
    const preKillIndex = reordered.findIndex((record) => record.event === "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL");
    const killIndex = reordered.findIndex((record) => record.event === "PARENT_KILL_INVOKED");
    [reordered[preKillIndex], reordered[killIndex]] = [reordered[killIndex]!, reordered[preKillIndex]!];
    expect(() => recomputeCrashScenario(reordered, scenario, "raw/scenario.jsonl"))
      .toThrow(/LIFECYCLE_EVENT_ORDER_INVALID/u);
  });

  it("rejects a self-labelled crash window whose pre-kill durable state disagrees", () => {
    const tampered = rawRecords();
    const preKill = tampered.find((record) => record.event === "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL")!;
    const operations = (preKill.details as { case_operations: Array<Record<string, unknown>> }).case_operations;
    operations[0]!.state = "PREPARED";
    expect(() => recomputeCrashScenario(tampered, scenario, "raw/scenario.jsonl"))
      .toThrow(/PRE_KILL_DURABLE_COMPLETION_NOT_PROVED/u);
  });

  it("rejects deletion or rewriting of provider history across restart", () => {
    const rewritten = rawRecords();
    const afterRestart = rewritten.find((record) =>
      record.event === "POSTGRES_DURABLE_SNAPSHOT_AFTER_RESTART")!;
    const events = (afterRestart.details as { provider_events: Array<Record<string, unknown>> }).provider_events;
    events[0]!.object_id = "different-object";
    expect(() => recomputeCrashScenario(rewritten, scenario, "raw/scenario.jsonl"))
      .toThrow(/PROVIDER_EVENT_DURABLE_HISTORY_REWRITTEN/u);
  });
});
