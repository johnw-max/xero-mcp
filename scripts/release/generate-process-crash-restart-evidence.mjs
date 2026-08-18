#!/usr/bin/env node

/**
 * Generates fail-closed local evidence for four real OS process crash windows.
 *
 * Each scenario runs the production Accounting Case -> AccountingService ->
 * XeroMutationService stack against an isolated PostgreSQL database.  A parent
 * process observes a reviewed lifecycle milestone, sends SIGKILL, waits for the
 * kernel-reported signal exit, and starts a distinct child PID against the same
 * durable rows.  The provider SDK test double stores both objects and calls in
 * PostgreSQL.  Scenario summaries are recomputed exclusively from raw JSONL.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  fingerprintAcceptanceSource,
  REQUIRED_CRASH_SCENARIO_IDS,
  sha256Buffer,
  validateProcessCrashRestartEvidence,
  verifyEvidenceArtifactFiles,
} from "./local-acceptance-gate-lib.mjs";
import {
  hashCrashEvidenceObject as hashObject,
  parseCrashScenarioJsonl,
  recomputeCrashScenario,
  runtimeAttestationFromCrashRaw,
} from "./process-crash-evidence-lib.mjs";

const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const workerPath = resolve(repoRoot, "harness/lifecycle/process-crash-worker.ts");
const releaseVersion = "0.4.0-rc.1";
const generatorVersion = "1.0.0";
const postgresImage = "postgres:16-alpine";
const crashHarnessConsultingRevenueAccountId = "33333333-3333-4333-8333-333333333333";
const defaultEvidencePath = resolve(
  repoRoot,
  "artifacts/ledger-kernel-review/round-2026-08-13-local/process-crash-restart.json",
);

function parseArguments(argv) {
  let evidencePath = defaultEvidencePath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--evidence") throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value) throw new Error("--evidence requires a path");
    evidencePath = resolve(value);
    index += 1;
  }
  return { evidencePath };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function pretty(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveDocker() {
  const candidates = [
    process.env.DOCKER_CLI_PATH,
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) if (await executable(candidate)) return resolve(candidate);
  throw new Error("PROCESS_CRASH_DOCKER_EXECUTABLE_NOT_FOUND");
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (options.allowFailure || (code === 0 && signal === null)) resolvePromise(result);
      else rejectPromise(new Error(
        `${options.label ?? "COMMAND"}_FAILED:${code ?? "null"}:${signal ?? "none"}:` +
        result.stderr.trim().slice(0, 500),
      ));
    });
  });
}

function parseJsonLines(text, label) {
  const events = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}_JSONL_INVALID_AT_${index + 1}`);
    }
  }
  return events;
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createMetadata(scenario, token) {
  const anchor = new Date();
  const prefix = scenario.toLowerCase().replaceAll("_", "-").slice(0, 30);
  const runId = `${prefix}-${token}`;
  return {
    schema_version: "1.0",
    run_id: runId,
    scenario_id: scenario,
    tenant_id: randomUUID(),
    contact_id: randomUUID(),
    // Must equal the server-owned CONSULTING_REVENUE CoA profile used by the
    // worker. Randomising a governed master-data ID makes preflight correctly
    // reject the synthetic Provider account list before any crash window.
    account_id: crashHarnessConsultingRevenueAccountId,
    invoice_id: randomUUID(),
    case_id: `crash-case-${token}-${prefix}`,
    workspace_id: `workspace-${runId}`,
    subject_id: `user-${runId}`,
    agent_id: `agent-${runId}`,
    installation_id: `installation-${runId}`,
    binding_id: `binding-${runId}`,
    connection_id: `connection-${runId}`,
    authorization_id: `authorization-${runId}`,
    target_session_id: `target-${runId}`,
    target_session_hash: hashObject({ kind: "process-crash-target", runId }),
    execution_request_id: `execute-${token}`,
    anchor_at: anchor.toISOString(),
    target_expires_at: new Date(anchor.getTime() + 4 * 60 * 60_000).toISOString(),
  };
}

function workerArguments(scenario, phase, metadataPath) {
  return [
    "--import",
    "tsx",
    workerPath,
    "--scenario",
    scenario,
    "--phase",
    phase,
    "--metadata",
    metadataPath,
  ];
}

async function queryRawSnapshot(databaseUrl, metadata) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const [version, operations, mutations, postings, providerLedger, providerEvents, migrations] = await Promise.all([
      pool.query(
        `SELECT case_id, version, state, preflight_request_id, preflight_receipt_hash,
                execution_request_id, compiled_plan_hash, terminal_summary IS NOT NULL AS has_terminal_summary
         FROM accounting_case_versions WHERE case_id = $1 AND version = 1`,
        [metadata.case_id],
      ),
      pool.query(
        `SELECT operation_id, ordinal, action_id, state, preparation_id, mutation_request_id,
                xero_object_id, write_receipt IS NOT NULL AS has_write_receipt,
                readback_snapshot IS NOT NULL AS has_readback_snapshot
         FROM accounting_case_operations WHERE case_id = $1 AND case_version = 1 ORDER BY ordinal`,
        [metadata.case_id],
      ),
      pool.query(
        `SELECT mutation_request_id, preparation_id, request_id, state, xero_object_id,
                write_receipt IS NOT NULL AS has_write_receipt,
                readback_snapshot IS NOT NULL AS has_readback_snapshot,
                readback_status
         FROM xero_mutation_requests WHERE tenant_id = $1 ORDER BY created_at`,
        [metadata.tenant_id],
      ),
      pool.query(
        `SELECT posting_request_id, request_id, state, xero_invoice_id,
                write_receipt IS NOT NULL AS has_write_receipt,
                readback_snapshot IS NOT NULL AS has_readback_snapshot
         FROM posting_requests WHERE tenant_id = $1 ORDER BY created_at`,
        [metadata.tenant_id],
      ),
      pool.query(
        `SELECT run_id, idempotency_key, object_id,
                receipt ->> 'providerRequestId' AS provider_request_id,
                document ->> 'status' AS status,
                document ->> 'invoiceId' AS readback_object_id
         FROM crash_harness_provider_ledger WHERE run_id = $1 ORDER BY accepted_at`,
        [metadata.run_id],
      ),
      pool.query(
        `SELECT sequence_id::text, process_pid, operation, object_id, details
         FROM crash_harness_provider_events WHERE run_id = $1 ORDER BY sequence_id`,
        [metadata.run_id],
      ),
      pool.query("SELECT version FROM schema_migrations ORDER BY version"),
    ]);
    const createAttempts = providerEvents.rows.filter((event) => event.operation === "CREATE_ATTEMPT").length;
    const createAccepts = providerEvents.rows.filter((event) => event.operation === "CREATE_ACCEPTED").length;
    const gets = providerEvents.rows.filter((event) => event.operation === "GET").length;
    return {
      postgres: {
        storage_mode: "POSTGRES",
        migration_head: migrations.rows.at(-1)?.version ?? null,
        applied_migrations: migrations.rowCount,
      },
      case_versions: version.rows,
      case_operations: operations.rows,
      mutation_requests: mutations.rows,
      posting_requests: postings.rows,
      provider_ledger: providerLedger.rows,
      provider_events: providerEvents.rows,
      provider_counts: {
        create_attempts: createAttempts,
        create_accepts: createAccepts,
        gets,
      },
    };
  } finally {
    await pool.end();
  }
}

class RawScenarioLog {
  #sequence = 0;

  constructor(scenario, metadata) {
    this.scenario = scenario;
    this.metadata = metadata;
    this.records = [];
  }

  add({ source, pid = null, event, state = null, providerWriteCount = null, providerGetCount = null,
    requestId = this.metadata.execution_request_id, objectId = null, details = {} }) {
    this.records.push({
      schema_version: "1.0",
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      scenario_id: this.scenario,
      source,
      pid,
      event,
      state,
      provider_write_count: providerWriteCount,
      provider_get_count: providerGetCount,
      request_id: requestId,
      object_id: objectId,
      details,
    });
  }

  child(childEvent, phase) {
    this.add({
      source: `CHILD_${phase.toUpperCase()}`,
      pid: Number.isInteger(childEvent.pid) ? childEvent.pid : null,
      event: typeof childEvent.event === "string" ? childEvent.event : "CHILD_EVENT",
      state: childEvent.case_state ?? childEvent.result_state ?? childEvent.mutation_state ?? null,
      objectId: childEvent.provider_object_id ?? null,
      details: childEvent,
    });
  }

  serialize() {
    return `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  }
}

async function startInitialWorker({ scenario, metadataPath, databaseUrl, raw }) {
  const args = workerArguments(scenario, "initial", metadataPath);
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    shell: false,
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  raw.add({ source: "PARENT", pid: child.pid ?? null, event: "INITIAL_PROCESS_SPAWNED", details: {
    parent_pid: process.pid,
    command: "node --import tsx harness/lifecycle/process-crash-worker.ts",
  } });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let buffer = "";
  const milestone = new Promise((resolvePromise, rejectPromise) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          raw.child(event, "initial");
          if (event.event === "CRASH_WINDOW_REACHED" && event.scenario_id === scenario) resolvePromise(event);
          if (event.event === "PROCESS_ERROR") rejectPromise(new Error(`INITIAL_WORKER_ERROR:${event.error_message}`));
        } catch (error) {
          rejectPromise(error);
        }
      }
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (signal !== "SIGKILL") rejectPromise(new Error(
        `INITIAL_WORKER_EXITED_BEFORE_SIGKILL:${code ?? "null"}:${signal ?? "none"}:` +
        Buffer.concat(stderr).toString("utf8").trim().slice(0, 500),
      ));
    });
  });
  try {
    await withTimeout(milestone, 60_000, `INITIAL_WORKER_MILESTONE_TIMEOUT:${scenario}`);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { child, args, stderr };
}

async function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function runRestartWorker({ scenario, metadataPath, databaseUrl, raw }) {
  const args = workerArguments(scenario, "restart", metadataPath);
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    shell: false,
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  raw.add({ source: "PARENT", pid: child.pid ?? null, event: "RESTART_PROCESS_SPAWNED", details: {
    parent_pid: process.pid,
    command: "node --import tsx harness/lifecycle/process-crash-worker.ts",
  } });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let exit;
  try {
    exit = await withTimeout(waitForExit(child), 60_000, `RESTART_WORKER_TIMEOUT:${scenario}`);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const events = parseJsonLines(Buffer.concat(stdout).toString("utf8"), "RESTART_WORKER");
  for (const event of events) raw.child(event, "restart");
  raw.add({ source: "PARENT", pid: child.pid ?? null, event: "RESTART_PROCESS_EXIT", state: exit.code === 0 ? "PASS" : "FAIL", details: exit });
  if (exit.code !== 0 || exit.signal !== null) {
    const processError = events.find((event) => event.event === "PROCESS_ERROR");
    const diagnostic = typeof processError?.error_message === "string"
      ? processError.error_message
      : Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
    throw new Error(`RESTART_WORKER_FAILED:${exit.code ?? "null"}:${exit.signal ?? "none"}:` +
      diagnostic);
  }
  const result = events.find((event) => event.event === "PROCESS_RESULT");
  const ready = events.find((event) => event.event === "PROCESS_READY");
  if (!result || !ready) throw new Error("RESTART_WORKER_EVIDENCE_INCOMPLETE");
  return { pid: child.pid, result, ready };
}

async function runScenario({ scenario, databaseUrl, rawDirectory, token, runtimeInput }) {
  const metadata = createMetadata(scenario, token);
  const metadataPath = resolve(rawDirectory, `${scenario}.metadata.json`);
  await atomicWrite(metadataPath, pretty(metadata));
  const raw = new RawScenarioLog(scenario, metadata);
  raw.add({ source: "PARENT", event: "SCENARIO_START", state: "RUNNING", details: {
    database_name: new URL(databaseUrl).pathname.slice(1),
    storage_mode: "POSTGRES",
  } });
  raw.add({ source: "PARENT", event: "RUNTIME_ATTESTATION_INPUT", state: "CAPTURED", details: runtimeInput });
  const initial = await startInitialWorker({ scenario, metadataPath, databaseUrl, raw });
  const snapshotBeforeKill = await queryRawSnapshot(databaseUrl, metadata);
  raw.add({
    source: "PARENT_POSTGRES",
    pid: initial.child.pid ?? null,
    event: "POSTGRES_DURABLE_SNAPSHOT_BEFORE_KILL",
    state: snapshotBeforeKill.case_versions[0]?.state ?? null,
    providerWriteCount: snapshotBeforeKill.provider_counts.create_attempts,
    providerGetCount: snapshotBeforeKill.provider_counts.gets,
    objectId: snapshotBeforeKill.provider_ledger[0]?.object_id ?? null,
    details: snapshotBeforeKill,
  });
  raw.add({
    source: "PARENT",
    pid: initial.child.pid ?? null,
    event: "PARENT_KILL_INVOKED",
    state: "SIGKILL_REQUESTED",
    providerWriteCount: snapshotBeforeKill.provider_counts.create_attempts,
    providerGetCount: snapshotBeforeKill.provider_counts.gets,
    objectId: snapshotBeforeKill.provider_ledger[0]?.object_id ?? null,
    details: { parent_pid: process.pid, signal: "SIGKILL", target_pid: initial.child.pid },
  });
  const exitPromise = waitForExit(initial.child);
  const killReturned = initial.child.kill("SIGKILL");
  const initialExit = await exitPromise;
  raw.add({
    source: "PARENT",
    pid: initial.child.pid ?? null,
    event: "INITIAL_PROCESS_EXIT",
    state: initialExit.signal === "SIGKILL" ? "KILLED" : "UNEXPECTED_EXIT",
    details: { ...initialExit, kill_returned: killReturned },
  });
  if (!killReturned || initialExit.code !== null || initialExit.signal !== "SIGKILL") {
    throw new Error(`${scenario}_REAL_SIGKILL_FAILED`);
  }
  const restart = await runRestartWorker({ scenario, metadataPath, databaseUrl, raw });
  const snapshotAfterRestart = await queryRawSnapshot(databaseUrl, metadata);
  raw.add({
    source: "PARENT_POSTGRES",
    pid: restart.pid ?? null,
    event: "POSTGRES_DURABLE_SNAPSHOT_AFTER_RESTART",
    state: snapshotAfterRestart.case_versions[0]?.state ?? null,
    providerWriteCount: snapshotAfterRestart.provider_counts.create_attempts,
    providerGetCount: snapshotAfterRestart.provider_counts.gets,
    objectId: snapshotAfterRestart.provider_ledger[0]?.object_id ?? null,
    details: snapshotAfterRestart,
  });
  raw.add({
    source: "PARENT_POSTGRES",
    pid: restart.pid ?? null,
    event: "PROVIDER_DURABLE_LEDGER_AFTER_RESTART",
    state: snapshotAfterRestart.provider_ledger.length === 0 ? "NO_OBJECT" : "OBJECT_DURABLE",
    providerWriteCount: snapshotAfterRestart.provider_counts.create_attempts,
    providerGetCount: snapshotAfterRestart.provider_counts.gets,
    objectId: snapshotAfterRestart.provider_ledger[0]?.object_id ?? null,
    details: {
      provider_ledger: snapshotAfterRestart.provider_ledger,
      provider_events: snapshotAfterRestart.provider_events,
    },
  });

  const rawPath = resolve(rawDirectory, `${scenario}.jsonl`);
  await rm(metadataPath, { force: true });
  return { metadata, raw, rawPath, restartReady: restart.ready };
}

async function rawArtifact(path, evidenceDirectory, scenarioId) {
  const content = await readFile(path);
  return {
    artifact_type: "CRASH_SCENARIO_JSONL",
    scenario_id: scenarioId,
    path: relative(evidenceDirectory, path),
    sha256: sha256Buffer(content),
    size_bytes: content.length,
  };
}

async function main() {
  const { evidencePath } = parseArguments(process.argv.slice(2));
  const evidenceDirectory = dirname(evidencePath);
  const rawDirectory = resolve(evidenceDirectory, "process-crash-restart.raw");
  await rm(rawDirectory, { recursive: true, force: true });
  await mkdir(rawDirectory, { recursive: true });
  const sourceBefore = await fingerprintAcceptanceSource(repoRoot);
  const docker = await resolveDocker();
  const token = randomBytes(5).toString("hex");
  const containerName = `xero-mcp-crash-${token}`;
  const databaseUser = `harness_${token}`;
  const databasePassword = randomBytes(32).toString("base64url");
  const credentialDirectory = await mkdtemp(resolve(tmpdir(), "xero-mcp-crash-postgres-"));
  const credentialPath = resolve(credentialDirectory, "postgres.env");
  let containerStarted = false;
  let finalOutput;
  try {
    await atomicWrite(credentialPath, [
      `POSTGRES_USER=${databaseUser}`,
      `POSTGRES_PASSWORD=${databasePassword}`,
      "POSTGRES_DB=postgres",
      "",
    ].join("\n"));
    try {
      await runCommand(docker, [
        "run", "-d", "--rm", "--name", containerName,
        "--env-file", credentialPath,
        "-p", "127.0.0.1::5432",
        postgresImage,
      ], { label: "POSTGRES_CONTAINER_START" });
    } finally {
      await rm(credentialPath, { force: true });
    }
    containerStarted = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await runCommand(docker, [
        // The official image briefly starts a socket-only bootstrap
        // postmaster and then shuts it down. Probe TCP so bootstrap readiness
        // cannot be mistaken for the final server.
        "exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", databaseUser, "-d", "postgres",
      ], { allowFailure: true });
      if (ready.code === 0) break;
      if (attempt === 59) throw new Error("PROCESS_CRASH_POSTGRES_NOT_READY");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    const portResult = await runCommand(docker, ["port", containerName, "5432/tcp"], {
      label: "POSTGRES_PORT_DISCOVERY",
    });
    const portMatch = portResult.stdout.trim().match(/:(\d+)$/u);
    if (!portMatch) throw new Error("PROCESS_CRASH_POSTGRES_PORT_INVALID");
    const port = Number(portMatch[1]);
    const imageResult = await runCommand(docker, ["inspect", "--format", "{{.Image}}", containerName], {
      label: "POSTGRES_IMAGE_INSPECT",
    });
    const imageDigest = imageResult.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) throw new Error("PROCESS_CRASH_POSTGRES_IMAGE_ID_INVALID");
    const runtimeInput = {
      source_fingerprint: sourceBefore.sha256,
      storage_mode: "POSTGRES",
      postgres_image: postgresImage,
      postgres_image_digest: imageDigest,
      node_version: process.version,
    };

    const runs = [];
    for (const [index, scenario] of REQUIRED_CRASH_SCENARIO_IDS.entries()) {
      const databaseName = `xero_mcp_test_crash_${token}_${index + 1}`;
      await runCommand(docker, ["exec", containerName, "createdb", "-U", databaseUser, databaseName], {
        label: "POSTGRES_DATABASE_CREATE",
      });
      const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}` +
        `@127.0.0.1:${port}/${databaseName}`;
      runs.push(await runScenario({
        scenario,
        databaseUrl,
        rawDirectory,
        token: `${token}${index + 1}`,
        runtimeInput,
      }));
    }

    const sourceAfter = await fingerprintAcceptanceSource(repoRoot);
    if (sourceAfter.sha256 !== sourceBefore.sha256) throw new Error("PROCESS_CRASH_SOURCE_CHANGED_DURING_RUN");

    for (const run of runs) {
      const ready = run.restartReady;
      if (ready.release_version !== releaseVersion ||
          ready.postgres_readiness?.requiredMigrationStatus !== "APPLIED" ||
          ready.postgres_readiness?.migrationHead !== ready.release_attestation?.requiredMigration ||
          ready.postgres_readiness?.activeAccountingCaseRecoveryProjection?.status !== "COMPATIBLE") {
        throw new Error("PROCESS_CRASH_RUNTIME_ATTESTATION_INVALID");
      }
      const runtimeAttestation = {
        release_version: ready.release_version,
        release_attestation: ready.release_attestation,
        release_attestation_hash: ready.release_attestation_hash,
        source_fingerprint: sourceBefore.sha256,
        storage_mode: runtimeInput.storage_mode,
        repository_ready: ready.postgres_readiness.ready,
        required_migration: ready.postgres_readiness.requiredMigration,
        required_migration_status: ready.postgres_readiness.requiredMigrationStatus,
        migration_head: ready.postgres_readiness.migrationHead,
        active_accounting_case_recovery_projection:
          ready.postgres_readiness.activeAccountingCaseRecoveryProjection,
        postgres_runtime: { image: postgresImage, image_digest: imageDigest },
        node_version: process.version,
      };
      run.raw.add({
        source: "PARENT",
        event: "RUNTIME_ATTESTATION",
        state: "VERIFIED",
        details: {
          runtime_attestation: runtimeAttestation,
          runtime_attestation_hash: hashObject(runtimeAttestation),
        },
      });
    }

    // Persist raw logs first, then deterministically parse only those bytes.
    for (const run of runs) await atomicWrite(run.rawPath, run.raw.serialize());
    const rawArtifacts = await Promise.all(runs.map((run) =>
      rawArtifact(run.rawPath, evidenceDirectory, run.metadata.scenario_id)));
    const scenarios = [];
    for (const [index, run] of runs.entries()) {
      const rawText = await readFile(run.rawPath, "utf8");
      const records = parseCrashScenarioJsonl(rawText, run.metadata.scenario_id);
      scenarios.push(recomputeCrashScenario(records, run.metadata.scenario_id, rawArtifacts[index].path));
    }
    const firstRaw = parseCrashScenarioJsonl(
      await readFile(runs[0].rawPath, "utf8"),
      runs[0].metadata.scenario_id,
    );
    const runtimeAttestation = runtimeAttestationFromCrashRaw(firstRaw, runs[0].metadata.scenario_id);
    const executablePath = relative(repoRoot, scriptPath);
    const evidence = {
      schema_version: "1.0",
      status: "PASS",
      captured_at: new Date().toISOString(),
      release_version: releaseVersion,
      runtime_attestation_hash: hashObject(runtimeAttestation),
      source_fingerprint: sourceBefore.sha256,
      generator: {
        kind: "PROCESS_CRASH_RESTART_HARNESS",
        command: `node ${executablePath}`,
        version: generatorVersion,
        executable_path: executablePath,
        executable_sha256: sha256Buffer(await readFile(scriptPath)),
      },
      raw_artifacts: rawArtifacts,
      scenarios,
    };
    validateProcessCrashRestartEvidence(evidence, { expectedSourceFingerprint: sourceBefore.sha256 });
    await atomicWrite(evidencePath, pretty(evidence));
    await verifyEvidenceArtifactFiles(evidence, evidencePath, repoRoot);
    finalOutput = {
      status: "PASS",
      evidence_boundary: "LOCAL",
      evidence: evidencePath,
      source_fingerprint: sourceBefore.sha256,
      runtime_attestation_hash: evidence.runtime_attestation_hash,
      scenarios: scenarios.map((scenario) => ({
        scenario_id: scenario.scenario_id,
        pid_before: scenario.server_pid_before,
        pid_after: scenario.server_pid_after,
        termination_signal: scenario.termination_signal,
        provider_write_count: scenario.provider_write_count_after_restart,
        recovery_outcome: scenario.recovery_outcome,
      })),
      postgres_container_removed: true,
    };
  } finally {
    try {
      if (containerStarted) {
        const removed = await runCommand(docker, ["rm", "-f", containerName], { allowFailure: true });
        if (removed.code !== 0) throw new Error("PROCESS_CRASH_POSTGRES_CONTAINER_REMOVE_FAILED");
        const remains = await runCommand(docker, ["inspect", containerName], { allowFailure: true });
        if (remains.code === 0) throw new Error("PROCESS_CRASH_POSTGRES_CONTAINER_CLEANUP_FAILED");
      }
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true });
    }
  }
  if (!finalOutput) throw new Error("PROCESS_CRASH_EVIDENCE_NOT_PRODUCED");
  process.stdout.write(pretty(finalOutput));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
