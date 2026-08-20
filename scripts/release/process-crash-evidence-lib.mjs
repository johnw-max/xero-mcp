import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const PROCESS_CRASH_SCENARIO_IDS = Object.freeze([
  "AFTER_PREFLIGHT_PREPARED",
  "AFTER_WRITE_CLAIM_BEFORE_PROVIDER",
  "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION",
  "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function stableCrashEvidenceString(value) {
  return JSON.stringify(canonical(value));
}

export function hashCrashEvidenceObject(value) {
  return createHash("sha256").update(stableCrashEvidenceString(value), "utf8").digest("hex");
}

export function parseCrashScenarioJsonl(text, expectedScenario) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${expectedScenario}_RAW_JSONL_INVALID_AT_${index + 1}`);
    }
    records.push(record);
  }
  for (const [index, record] of records.entries()) {
    if (record.schema_version !== "1.0" || record.sequence !== index + 1 ||
        record.scenario_id !== expectedScenario || !Number.isFinite(Date.parse(record.timestamp)) ||
        typeof record.source !== "string" || !record.source ||
        typeof record.event !== "string" || !record.event ||
        !("pid" in record) || !("state" in record) ||
        !("provider_write_count" in record) || !("provider_get_count" in record) ||
        !("request_id" in record) || !("object_id" in record) ||
        !record.details || typeof record.details !== "object" || Array.isArray(record.details)) {
      throw new Error(`${expectedScenario}_RAW_RECORD_INVALID_AT_${index + 1}`);
    }
  }
  if (records.length === 0) throw new Error(`${expectedScenario}_RAW_JSONL_EMPTY`);
  return records;
}

function one(records, event, source) {
  const matches = records.filter((record) => record.event === event && (!source || record.source === source));
  if (matches.length !== 1) throw new Error(`${records[0]?.scenario_id ?? "UNKNOWN"}_${event}_COUNT_${matches.length}`);
  return matches[0];
}

function eventPosition(records, event, source) {
  const record = one(records, event, source);
  return { record, index: records.indexOf(record) };
}

function requireSnapshotShape(snapshot, scenario, phase) {
  for (const field of [
    "case_versions",
    "case_operations",
    "mutation_requests",
    "posting_requests",
    "provider_ledger",
    "provider_events",
  ]) {
    if (!Array.isArray(snapshot?.[field])) {
      throw new Error(`${scenario}_${phase}_SNAPSHOT_${field.toUpperCase()}_INVALID`);
    }
  }
  if (!snapshot.provider_counts || typeof snapshot.provider_counts !== "object") {
    throw new Error(`${scenario}_${phase}_SNAPSHOT_PROVIDER_COUNTS_INVALID`);
  }
}

function assertPrefix(before, after, scenario, field) {
  if (before.length > after.length) {
    throw new Error(`${scenario}_${field}_DURABLE_HISTORY_SHRANK`);
  }
  for (let index = 0; index < before.length; index += 1) {
    if (stableCrashEvidenceString(before[index]) !== stableCrashEvidenceString(after[index])) {
      throw new Error(`${scenario}_${field}_DURABLE_HISTORY_REWRITTEN_AT_${index}`);
    }
  }
}

function assertPreKillWindow(snapshot, crash, scenario) {
  const caseState = snapshot.case_versions[0]?.state;
  const operation = snapshot.case_operations[0];
  const mutation = snapshot.mutation_requests[0];
  const posting = snapshot.posting_requests[0];
  const writes = snapshot.provider_events.filter((event) => event.operation === "CREATE_ATTEMPT").length;
  const accepts = snapshot.provider_events.filter((event) => event.operation === "CREATE_ACCEPTED").length;
  const gets = snapshot.provider_events.filter((event) => event.operation === "GET").length;
  if (snapshot.provider_counts.create_attempts !== writes ||
      snapshot.provider_counts.create_accepts !== accepts ||
      snapshot.provider_counts.gets !== gets ||
      crash.state !== ({
        AFTER_PREFLIGHT_PREPARED: "PREFLIGHTED",
        AFTER_WRITE_CLAIM_BEFORE_PROVIDER: "WRITE_IN_FLIGHT",
        AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION: "WRITE_IN_FLIGHT",
        AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE: "TERMINAL",
      })[scenario]) {
    throw new Error(`${scenario}_PRE_KILL_COUNTER_OR_WINDOW_DIVERGED`);
  }

  if (scenario === "AFTER_PREFLIGHT_PREPARED") {
    if (caseState !== "PREFLIGHTED" || operation?.state !== "PREPARED" ||
        snapshot.mutation_requests.length !== 0 || snapshot.posting_requests.length !== 0 ||
        writes !== 0 || accepts !== 0 || gets !== 0 || snapshot.provider_ledger.length !== 0) {
      throw new Error(`${scenario}_PRE_KILL_PREFLIGHT_NOT_PROVED`);
    }
    return;
  }
  if (scenario === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER") {
    if (caseState !== "EXECUTING" || operation?.state !== "PREPARED" ||
        mutation?.state !== "WRITE_IN_FLIGHT" || mutation.xero_object_id !== null ||
        mutation.has_write_receipt !== false || mutation.has_readback_snapshot !== false ||
        posting?.state !== "VALIDATED" || posting.xero_invoice_id !== null ||
        posting.has_write_receipt !== false || posting.has_readback_snapshot !== false ||
        writes !== 0 || accepts !== 0 || gets !== 0 || snapshot.provider_ledger.length !== 0) {
      throw new Error(`${scenario}_PRE_KILL_WRITE_CLAIM_NOT_PROVED`);
    }
    return;
  }
  if (scenario === "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION") {
    const ledger = snapshot.provider_ledger[0];
    if (caseState !== "EXECUTING" || operation?.state !== "PREPARED" ||
        mutation?.state !== "WRITE_IN_FLIGHT" || mutation.xero_object_id !== null ||
        mutation.has_write_receipt !== false || mutation.has_readback_snapshot !== false ||
        posting?.state !== "WRITE_RESULT_UNKNOWN" || !posting.xero_invoice_id ||
        posting.has_write_receipt !== true || posting.has_readback_snapshot !== false ||
        writes !== 1 || accepts !== 1 || gets !== 0 || snapshot.provider_ledger.length !== 1 ||
        ledger?.object_id !== posting.xero_invoice_id || ledger?.status !== "DRAFT") {
      throw new Error(`${scenario}_PRE_KILL_PROVIDER_ACCEPT_NOT_PROVED`);
    }
    return;
  }
  if (scenario === "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE") {
    const ledger = snapshot.provider_ledger[0];
    if (caseState !== "TERMINAL" || operation?.state !== "READBACK_VERIFIED" ||
        operation.xero_object_id !== ledger?.object_id || operation.has_write_receipt !== true ||
        operation.has_readback_snapshot !== true || mutation?.state !== "READBACK_VERIFIED" ||
        mutation.xero_object_id !== ledger?.object_id || mutation.has_write_receipt !== true ||
        mutation.has_readback_snapshot !== true || posting?.state !== "DRAFT_READBACK_VERIFIED" ||
        posting.xero_invoice_id !== ledger?.object_id || posting.has_write_receipt !== true ||
        posting.has_readback_snapshot !== true || writes !== 1 || accepts !== 1 || gets !== 1 ||
        snapshot.provider_ledger.length !== 1 || ledger?.status !== "DRAFT") {
      throw new Error(`${scenario}_PRE_KILL_DURABLE_COMPLETION_NOT_PROVED`);
    }
  }
}

export function runtimeAttestationFromCrashRaw(records, scenario) {
  const parent = one(records, "RUNTIME_ATTESTATION_INPUT", "PARENT").details;
  const ready = one(records, "PROCESS_READY", "CHILD_RESTART").details;
  const captured = one(records, "RUNTIME_ATTESTATION", "PARENT").details;
  const releaseAttestationHash = hashCrashEvidenceObject(ready.release_attestation);
  if (ready.release_attestation_hash !== releaseAttestationHash ||
      ready.release_version !== "0.4.0-rc.1" ||
      ready.postgres_readiness?.storageMode !== "POSTGRES" ||
      ready.postgres_readiness?.ready !== true ||
      ready.postgres_readiness?.requiredMigrationStatus !== "APPLIED" ||
      ready.postgres_readiness?.migrationHead !== ready.release_attestation?.requiredMigration ||
      ready.postgres_readiness?.activeAccountingCaseRecoveryProjection?.status !== "COMPATIBLE" ||
      parent.storage_mode !== "POSTGRES" ||
      !/^[a-f0-9]{64}$/u.test(parent.source_fingerprint) ||
      !/^sha256:[a-f0-9]{64}$/u.test(parent.postgres_image_digest)) {
    throw new Error(`${scenario}_RUNTIME_ATTESTATION_INVALID`);
  }
  const runtimeAttestation = {
    release_version: ready.release_version,
    release_attestation: ready.release_attestation,
    release_attestation_hash: ready.release_attestation_hash,
    source_fingerprint: parent.source_fingerprint,
    storage_mode: parent.storage_mode,
    repository_ready: ready.postgres_readiness.ready,
    required_migration: ready.postgres_readiness.requiredMigration,
    required_migration_status: ready.postgres_readiness.requiredMigrationStatus,
    migration_head: ready.postgres_readiness.migrationHead,
    active_accounting_case_recovery_projection:
      ready.postgres_readiness.activeAccountingCaseRecoveryProjection,
    postgres_runtime: {
      image: parent.postgres_image,
      image_digest: parent.postgres_image_digest,
    },
    node_version: parent.node_version,
  };
  const runtimeAttestationHash = hashCrashEvidenceObject(runtimeAttestation);
  if (stableCrashEvidenceString(captured.runtime_attestation) !==
      stableCrashEvidenceString(runtimeAttestation) ||
      captured.runtime_attestation_hash !== runtimeAttestationHash) {
    throw new Error(`${scenario}_RUNTIME_ATTESTATION_RECORD_DIVERGED`);
  }
  return runtimeAttestation;
}

export function recomputeCrashScenario(records, scenario, rawArtifactPath) {
  const crashPosition = eventPosition(records, "CRASH_WINDOW_REACHED");
  const preKillPosition = eventPosition(records, "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL", "PARENT_POSTGRES");
  const killPosition = eventPosition(records, "PARENT_KILL_INVOKED", "PARENT");
  const killedPosition = eventPosition(records, "INITIAL_PROCESS_EXIT", "PARENT");
  const initialSpawnPosition = eventPosition(records, "INITIAL_PROCESS_SPAWNED", "PARENT");
  const restartSpawnPosition = eventPosition(records, "RESTART_PROCESS_SPAWNED", "PARENT");
  const processResultPosition = eventPosition(records, "PROCESS_RESULT", "CHILD_RESTART");
  const pgSnapshotPosition = eventPosition(records, "POSTGRES_DURABLE_SNAPSHOT_AFTER_RESTART", "PARENT_POSTGRES");
  const { record: crash } = crashPosition;
  const { record: kill } = killPosition;
  const { record: killed } = killedPosition;
  const { record: initialSpawn } = initialSpawnPosition;
  const { record: restartSpawn } = restartSpawnPosition;
  const { record: pgSnapshot } = pgSnapshotPosition;
  if (!(initialSpawnPosition.index < crashPosition.index &&
      crashPosition.index < preKillPosition.index &&
      preKillPosition.index < killPosition.index &&
      killPosition.index < killedPosition.index &&
      killedPosition.index < restartSpawnPosition.index &&
      restartSpawnPosition.index < processResultPosition.index &&
      processResultPosition.index < pgSnapshotPosition.index)) {
    throw new Error(`${scenario}_LIFECYCLE_EVENT_ORDER_INVALID`);
  }
  if (crash.details.scenario_id !== scenario) throw new Error(`${scenario}_WRONG_CRASH_WINDOW`);
  const beforePid = initialSpawn.pid;
  const afterPid = restartSpawn.pid;
  if (!Number.isInteger(beforePid) || !Number.isInteger(afterPid) || beforePid < 1 || afterPid < 1 ||
      beforePid === afterPid) {
    throw new Error(`${scenario}_PROCESS_IDENTITY_INVALID`);
  }
  const parentPid = initialSpawn.details.parent_pid;
  if (!Number.isInteger(parentPid) || parentPid < 1 ||
      restartSpawn.details.parent_pid !== parentPid || kill.details.parent_pid !== parentPid ||
      parentPid === beforePid || parentPid === afterPid) {
    throw new Error(`${scenario}_PARENT_PROCESS_IDENTITY_INVALID`);
  }
  if (kill.pid !== beforePid || kill.details.target_pid !== beforePid || killed.pid !== beforePid ||
      killed.details.signal !== "SIGKILL" ||
      killed.details.code !== null || killed.details.kill_returned !== true) {
    throw new Error(`${scenario}_SIGKILL_NOT_PROVED`);
  }
  const beforeSnapshot = preKillPosition.record.details;
  const snapshot = pgSnapshot.details;
  requireSnapshotShape(beforeSnapshot, scenario, "PRE_KILL");
  requireSnapshotShape(snapshot, scenario, "AFTER_RESTART");
  assertPreKillWindow(beforeSnapshot, crash, scenario);
  if (preKillPosition.record.provider_write_count !== beforeSnapshot.provider_counts.create_attempts ||
      preKillPosition.record.provider_get_count !== beforeSnapshot.provider_counts.gets ||
      kill.provider_write_count !== preKillPosition.record.provider_write_count ||
      kill.provider_get_count !== preKillPosition.record.provider_get_count) {
    throw new Error(`${scenario}_PRE_KILL_DURABLE_COUNTERS_DIVERGED`);
  }
  assertPrefix(beforeSnapshot.provider_events, snapshot.provider_events, scenario, "PROVIDER_EVENT");
  assertPrefix(beforeSnapshot.provider_ledger, snapshot.provider_ledger, scenario, "PROVIDER_LEDGER");
  const providerEvents = snapshot.provider_events;
  const createEvents = providerEvents.filter((event) => event.operation === "CREATE_ATTEMPT");
  const acceptedEvents = providerEvents.filter((event) => event.operation === "CREATE_ACCEPTED");
  const getEvents = providerEvents.filter((event) => event.operation === "GET");
  if (createEvents.length > 1 || acceptedEvents.length > 1 || snapshot.provider_ledger.length > 1 ||
      acceptedEvents.length !== snapshot.provider_ledger.length) {
    throw new Error(`${scenario}_PROVIDER_AT_MOST_ONCE_FAILED`);
  }
  const writesByRestart = createEvents.filter((event) => Number(event.process_pid) === afterPid);
  const latestProviderSummary = one(records, "PROVIDER_DURABLE_LEDGER_AFTER_RESTART", "PARENT_POSTGRES");
  if (latestProviderSummary.provider_write_count !== createEvents.length ||
      latestProviderSummary.provider_get_count !== getEvents.length ||
      latestProviderSummary.object_id !== (snapshot.provider_ledger[0]?.object_id ?? null)) {
    throw new Error(`${scenario}_RAW_PROVIDER_COUNTERS_DIVERGED`);
  }
  if (scenario === "AFTER_PREFLIGHT_PREPARED") {
    const restartCaseClaim = one(records, "RESTART_DURABLE_CASE_CLAIM", "CHILD_RESTART");
    if (restartCaseClaim.details.claim_mode !== "CLAIMED" || restartCaseClaim.state !== "EXECUTING") {
      throw new Error(`${scenario}_DURABLE_PREFLIGHT_RESTART_CLAIM_NOT_PROVED`);
    }
  }
  if ([
    "AFTER_WRITE_CLAIM_BEFORE_PROVIDER",
    "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION",
    "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE",
  ].includes(scenario) && writesByRestart.length !== 0) {
    throw new Error(`${scenario}_RESTART_ISSUED_PROVIDER_CREATE`);
  }
  if (scenario === "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION" &&
      !getEvents.some((event) => Number(event.process_pid) === afterPid)) {
    throw new Error(`${scenario}_GET_ONLY_RECOVERY_NOT_PROVED`);
  }
  const caseState = snapshot.case_versions[0]?.state;
  const operationStates = snapshot.case_operations.map((operation) => operation.state);
  let recoveryOutcome;
  if (scenario === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER") {
    const mutation = snapshot.mutation_requests[0];
    const posting = snapshot.posting_requests[0];
    if (createEvents.length !== 0 || caseState !== "RECOVERY_REQUIRED" ||
        !operationStates.some((state) => state === "WRITE_IN_FLIGHT" || state === "WRITE_UNCERTAIN") ||
        mutation?.state !== "WRITE_UNCERTAIN" || mutation.xero_object_id !== null ||
        mutation.has_write_receipt !== false || mutation.has_readback_snapshot !== false ||
        posting?.state !== "VALIDATED" || posting.xero_invoice_id !== null ||
        posting.has_write_receipt !== false || posting.has_readback_snapshot !== false) {
      throw new Error(`${scenario}_SAFE_UNKNOWN_NOT_PROVED`);
    }
    recoveryOutcome = "BLOCKED_SAFE_UNKNOWN";
  } else {
    const operation = snapshot.case_operations[0];
    const mutation = snapshot.mutation_requests[0];
    const posting = snapshot.posting_requests[0];
    const ledger = snapshot.provider_ledger[0];
    const accepted = acceptedEvents[0];
    if (createEvents.length !== 1 || acceptedEvents.length !== 1 || caseState !== "TERMINAL" ||
        operationStates.length !== 1 || operationStates.some((state) => state !== "READBACK_VERIFIED") ||
        !ledger || ledger.status !== "DRAFT" || ledger.object_id !== ledger.readback_object_id ||
        accepted?.object_id !== ledger.object_id ||
        operation?.xero_object_id !== ledger.object_id || operation.has_write_receipt !== true ||
        operation.has_readback_snapshot !== true ||
        mutation?.state !== "READBACK_VERIFIED" || mutation.xero_object_id !== ledger.object_id ||
        mutation.has_write_receipt !== true || mutation.has_readback_snapshot !== true ||
        mutation.readback_status !== "DRAFT" ||
        posting?.state !== "DRAFT_READBACK_VERIFIED" || posting.xero_invoice_id !== ledger.object_id ||
        posting.has_write_receipt !== true || posting.has_readback_snapshot !== true) {
      throw new Error(`${scenario}_READBACK_COMPLETION_NOT_PROVED`);
    }
    recoveryOutcome = scenario === "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE"
      ? "IDEMPOTENT_REPLAY"
      : "RECOVERED_READBACK_VERIFIED";
  }
  return {
    scenario_id: scenario,
    status: "PASS",
    termination: "PROCESS_KILL",
    termination_signal: "SIGKILL",
    command: "node --import tsx harness/lifecycle/process-crash-worker.ts",
    server_pid_before: beforePid,
    server_pid_after: afterPid,
    restart_observed: true,
    provider_write_count_after_restart: createEvents.length,
    recovery_outcome: recoveryOutcome,
    evidence_refs: [rawArtifactPath],
  };
}

function contained(base, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error("PROCESS_CRASH_RAW_PATH_INVALID");
  }
  const resolvedBase = resolve(base);
  const absolute = resolve(resolvedBase, relativePath);
  if (absolute !== resolvedBase && !absolute.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error("PROCESS_CRASH_RAW_PATH_ESCAPE");
  }
  return absolute;
}

/** Recomputes every summary and runtime identity from the hashed raw JSONL. */
export async function recomputeProcessCrashEvidenceFromRaw(document, evidencePath) {
  const artifacts = new Map(document.raw_artifacts.map((artifact) => [artifact.scenario_id, artifact]));
  const scenarios = [];
  const runtimeAttestations = [];
  for (const scenario of PROCESS_CRASH_SCENARIO_IDS) {
    const artifact = artifacts.get(scenario);
    if (!artifact || artifact.artifact_type !== "CRASH_SCENARIO_JSONL") {
      throw new Error(`PROCESS_CRASH_RAW_MISSING:${scenario}`);
    }
    const path = contained(dirname(evidencePath), artifact.path);
    const records = parseCrashScenarioJsonl(await readFile(path, "utf8"), scenario);
    scenarios.push(recomputeCrashScenario(records, scenario, artifact.path));
    runtimeAttestations.push(runtimeAttestationFromCrashRaw(records, scenario));
  }
  const runtimeIdentity = stableCrashEvidenceString(runtimeAttestations[0]);
  if (runtimeAttestations.some((value) => stableCrashEvidenceString(value) !== runtimeIdentity)) {
    throw new Error("PROCESS_CRASH_RUNTIME_ATTESTATION_DIVERGED");
  }
  const runtimeAttestation = runtimeAttestations[0];
  if (runtimeAttestation.source_fingerprint !== document.source_fingerprint) {
    throw new Error("PROCESS_CRASH_RAW_SOURCE_FINGERPRINT_DIVERGED");
  }
  const runtimeAttestationHash = hashCrashEvidenceObject(runtimeAttestation);
  if (runtimeAttestationHash !== document.runtime_attestation_hash) {
    throw new Error("PROCESS_CRASH_RAW_RUNTIME_ATTESTATION_DIVERGED");
  }
  if (stableCrashEvidenceString(scenarios) !== stableCrashEvidenceString(document.scenarios)) {
    throw new Error("PROCESS_CRASH_RAW_SUMMARY_DIVERGED");
  }
  return { scenarios, runtime_attestation: runtimeAttestation, runtime_attestation_hash: runtimeAttestationHash };
}
