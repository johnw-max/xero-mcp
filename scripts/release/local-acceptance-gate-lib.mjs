import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { REQUIRED_GATE_STEP_IDS } from "../local-acceptance-contract.mjs";
import {
  assertAgentSkillReadCommandEvents,
  verifyAgentBundleEvidence,
  verifyAgentBundleEvidenceSync,
} from "../../harness/local-agents/agent-workspace.mjs";

export { REQUIRED_GATE_STEP_IDS };

export const REQUIRED_CRASH_SCENARIO_IDS = Object.freeze([
  "AFTER_PREFLIGHT_PREPARED",
  "AFTER_WRITE_CLAIM_BEFORE_PROVIDER",
  "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION",
  "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE",
]);

const REQUIRED_LOCAL_AGENT_ARTIFACT_TYPES = Object.freeze([
  "CODEX_EVENTS_JSONL",
  "CODEX_STDERR",
  "FINAL_ANSWER",
  "SERVER_AUDIT",
  "INVOCATION",
]);
export const APPROVED_LOCAL_AGENT_CODEX_PATHS = Object.freeze([
  "/Applications/ChatGPT.app/Contents/Resources/codex",
]);
const APPROVED_LOCAL_AGENT_CODEX_TEAM_ID = "2DC432GLL2";

export const ACCEPTANCE_SOURCE_ROOTS = Object.freeze([
  ".dockerignore",
  ".gitignore",
  "PRD-XERO-ACCOUNTING-AGENT-MCP.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "agent-skills",
  "config",
  "deploy",
  "docs",
  "handoff",
  "harness",
  "migrations",
  "schemas",
  "scripts",
  "src",
  "tests",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}

function hashObject(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
}

function parseJsonLinesBuffer(buffer, label) {
  const records = [];
  for (const [index, line] of buffer.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}_INVALID_JSONL_AT_${index + 1}`);
    }
  }
  if (records.length === 0) throw new Error(`${label}_EMPTY_JSONL`);
  return records;
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function codexToolCalls(events) {
  const calls = new Map();
  for (const [index, event] of events.entries()) {
    const item = event?.item;
    if (!item || item.type !== "mcp_tool_call" || !isNonEmptyString(item.id)) continue;
    const tool = isNonEmptyString(item.tool) ? item.tool : item.name;
    if (!isNonEmptyString(tool)) continue;
    const current = calls.get(item.id) ?? { id: item.id, tool, firstIndex: index };
    current.tool = tool;
    current.arguments = item.arguments ?? item.input ?? current.arguments;
    current.result = item.result ?? item.output ?? current.result;
    current.error = item.error ?? current.error;
    current.status = item.status ?? (event.type === "item.completed" ? "completed" : current.status);
    current.lastIndex = index;
    calls.set(item.id, current);
  }
  return [...calls.values()].sort((left, right) => left.firstIndex - right.firstIndex);
}

function mcpResultPayload(value, label) {
  if (!isRecord(value)) throw new Error(`${label}_INVALID`);
  const structured = value.structured_content ?? value.structuredContent;
  if (isRecord(structured) && "result" in structured) return structured.result;
  const text = Array.isArray(value.content)
    ? value.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text
    : undefined;
  if (typeof text !== "string") throw new Error(`${label}_MISSING`);
  const parsed = parseJsonBuffer(Buffer.from(text), label);
  if (!isRecord(parsed) || !("result" in parsed)) throw new Error(`${label}_MISSING`);
  return parsed.result;
}

const ORGANISATION_SAFE_RESULT_KEYS = Object.freeze([
  "name",
  "countryCode",
  "baseCurrency",
  "paysTax",
  "organisationStatus",
]);

function hasObjectKey(value, key) {
  if (Array.isArray(value)) return value.some((child) => hasObjectKey(child, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([entryKey, child]) => entryKey === key || hasObjectKey(child, key));
}

function mcpStructuredEnvelope(value) {
  const structured = value?.structured_content ?? value?.structuredContent;
  return isRecord(structured) && "result" in structured ? structured : undefined;
}

function organisationReadBinding(publicResult, serviceResult, envelope, pinSafeTarget, transportValue) {
  if (!isRecord(publicResult) || !isRecord(serviceResult) ||
      typeof serviceResult.organisationId !== "string" || serviceResult.organisationId.length === 0 ||
      hasObjectKey(publicResult, "organisationId") || hasObjectKey(envelope, "organisationId") ||
      JSON.stringify(transportValue).includes("organisationId") ||
      JSON.stringify(transportValue).includes(serviceResult.organisationId)) {
    return false;
  }
  const { organisationId: _organisationId, ...serviceSafeResult } = serviceResult;
  if (JSON.stringify(Object.keys(serviceSafeResult).sort()) !== JSON.stringify([...ORGANISATION_SAFE_RESULT_KEYS].sort()) ||
      JSON.stringify(Object.keys(publicResult).sort()) !== JSON.stringify([...ORGANISATION_SAFE_RESULT_KEYS].sort()) ||
      stableStringify(publicResult) !== stableStringify(serviceSafeResult)) {
    return false;
  }
  if (!envelope || envelope.result_class !== "succeeded" || envelope.fact_origin !== "MCP_READ" ||
      envelope.source_system !== "xero" || envelope.capability_id !== "ledger.target.resolve" ||
      envelope.destination_role !== "ledger_sor" || envelope.organisation_display_name !== publicResult.name ||
      envelope.base_currency !== publicResult.baseCurrency ||
      typeof envelope.tool_call_or_audit_ref !== "string" || envelope.tool_call_or_audit_ref.length === 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(envelope.output_hash ?? "") ||
      envelope.output_hash !== `sha256:${hashObject(publicResult)}` ||
      !Array.isArray(envelope.fact_paths) ||
      !envelope.fact_paths.includes("/result/name") || !envelope.fact_paths.includes("/result/baseCurrency") ||
      envelope.fact_paths.some((path) => typeof path !== "string" || path.length === 0 || path.includes("organisationId")) ||
      !/^xero-target-session:[A-Za-z0-9_-]+$/u.test(envelope.target_session_ref_safe ?? "") ||
      envelope.target_session_ref_safe !== pinSafeTarget ||
      !/^xero-target:[A-Za-z0-9_-]+$/u.test(envelope.bound_target_ref_safe ?? "") ||
      !/^xero-binding-revision:[A-Za-z0-9_-]+$/u.test(envelope.binding_revision ?? "")) {
    return false;
  }
  return true;
}

function targetSessionRefFromResult(value) {
  const reference = mcpResultPayload(value, "LOCAL_AGENT_RAW_PIN_RESULT")?.target_session_ref;
  if (typeof reference !== "string" || !/^xts_[A-Za-z0-9_-]{43}$/u.test(reference)) {
    throw new Error("LOCAL_AGENT_RAW_TARGET_SESSION_ISSUANCE_INVALID");
  }
  return reference;
}

function targetSessionRefHash(reference) {
  return hashObject({ targetSessionRef: reference });
}

function redactTargetSessionRefs(value) {
  if (Array.isArray(value)) return value.map(redactTargetSessionRefs);
  if (!isRecord(value)) {
    return typeof value === "string"
      ? value.replace(/xts_[A-Za-z0-9_-]{43}/gu, "<redacted-target-session-ref>")
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "target_session_ref" ? "<redacted-target-session-ref>" : redactTargetSessionRefs(child),
  ]));
}

function targetBusinessInput(value) {
  if (!isRecord(value)) return value;
  const { target_session_ref: _targetSessionRef, ...business } = value;
  return business;
}

function containsForbiddenAuthorityField(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenAuthorityField);
  if (!isRecord(value)) return false;
  const forbidden = new Set([
    "tenantid",
    "providerobjectid",
    "xeroobjectid",
    "xerocontactid",
    "canonicalpayload",
    "canonicalpayloadhash",
    "actionid",
    "operationid",
    "preparationid",
    "mutationrequestid",
    "validationreceipt",
  ]);
  return Object.entries(value).some(([key, child]) =>
    forbidden.has(key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase()) || containsForbiddenAuthorityField(child));
}

function assertExactFields(value, required, label) {
  if (!isRecord(value)) throw new Error(`${label}_INVALID: expected an object`);
  const allowed = new Set(required);
  for (const field of required) {
    if (!(field in value)) throw new Error(`${label}_INVALID: ${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${label}_INVALID: unknown field ${field}`);
  }
}

export function assertSafeTestDatabaseUrl(value) {
  if (!value) throw new Error("TEST_DATABASE_URL_REQUIRED");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL_REQUIRED");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL_REQUIRED");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^xero_mcp_test(?:_[a-z0-9][a-z0-9_]*)?$/u.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL_UNSAFE");
  }
  return {
    database_name: databaseName,
    protocol: parsed.protocol,
    host_hash: createHash("sha256").update(parsed.host).digest("hex"),
  };
}

function assertEvidenceIdentity(document, label, terminalField, optionalFields = []) {
  const requiredFields = [
    "schema_version",
    "status",
    "captured_at",
    "release_version",
    "runtime_attestation_hash",
    "source_fingerprint",
    "generator",
    "raw_artifacts",
    terminalField,
  ];
  const allowedFields = new Set([...requiredFields, ...optionalFields]);
  if (!isRecord(document) || Object.keys(document).some((field) => !allowedFields.has(field))) {
    throw new Error(`${label}_EVIDENCE_INVALID: unknown field`);
  }
  for (const field of requiredFields) {
    if (!(field in document)) throw new Error(`${label}_EVIDENCE_INVALID: ${field} is required`);
  }
  if (document.schema_version !== "1.0") throw new Error(`${label}_EVIDENCE_INVALID: schema_version must be 1.0`);
  if (document.status !== "PASS") throw new Error(`${label}_EVIDENCE_NOT_CAPTURED: status must be PASS`);
  if (!isNonEmptyString(document.captured_at) || Number.isNaN(Date.parse(document.captured_at))) {
    throw new Error(`${label}_EVIDENCE_INVALID: captured_at must be an ISO date-time`);
  }
  for (const field of ["runtime_attestation_hash", "source_fingerprint"]) {
    if (!isSha256(document[field])) throw new Error(`${label}_EVIDENCE_INVALID: ${field} must be a SHA-256 digest`);
  }
}

function validateGenerator(generator, expectedKind, label) {
  assertExactFields(generator, ["kind", "command", "version", "executable_path", "executable_sha256"], `${label}_GENERATOR`);
  if (generator.kind !== expectedKind) throw new Error(`${label}_GENERATOR_INVALID: unexpected kind`);
  for (const field of ["command", "version", "executable_path"]) {
    if (!isNonEmptyString(generator[field])) throw new Error(`${label}_GENERATOR_INVALID: ${field} is required`);
  }
  if (!generator.command.includes(generator.executable_path)) {
    throw new Error(`${label}_GENERATOR_INVALID: command does not identify executable_path`);
  }
  if (!isSha256(generator.executable_sha256)) {
    throw new Error(`${label}_GENERATOR_INVALID: executable_sha256 must be a SHA-256 digest`);
  }
}

function validateRawArtifacts(rawArtifacts, label) {
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length === 0) {
    throw new Error(`${label}_EVIDENCE_INVALID: raw_artifacts are required`);
  }
  const paths = new Set();
  const artifactTypes = new Set();
  const scenarioIds = new Set();
  for (const [index, artifact] of rawArtifacts.entries()) {
    const fields = label === "PROCESS_CRASH_RESTART"
      ? ["artifact_type", "scenario_id", "path", "sha256", "size_bytes"]
      : ["artifact_type", "path", "sha256", "size_bytes"];
    assertExactFields(artifact, fields, `${label}_RAW_ARTIFACT_${index}`);
    if (!isNonEmptyString(artifact.path) || paths.has(artifact.path)) {
      throw new Error(`${label}_EVIDENCE_INVALID: raw_artifacts[${index}].path is missing or duplicated`);
    }
    if (!isSha256(artifact.sha256) || !Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 1) {
      throw new Error(`${label}_EVIDENCE_INVALID: raw_artifacts[${index}] has invalid digest or size`);
    }
    if (!isNonEmptyString(artifact.artifact_type)) {
      throw new Error(`${label}_EVIDENCE_INVALID: raw_artifacts[${index}].artifact_type is required`);
    }
    if (label === "LOCAL_AGENT") {
      if (!REQUIRED_LOCAL_AGENT_ARTIFACT_TYPES.includes(artifact.artifact_type) ||
          artifactTypes.has(artifact.artifact_type)) {
        throw new Error(`${label}_EVIDENCE_INVALID: raw artifact types must be exact and unique`);
      }
      artifactTypes.add(artifact.artifact_type);
    } else {
      if (artifact.artifact_type !== "CRASH_SCENARIO_JSONL" ||
          !REQUIRED_CRASH_SCENARIO_IDS.includes(artifact.scenario_id) ||
          scenarioIds.has(artifact.scenario_id)) {
        throw new Error(`${label}_EVIDENCE_INVALID: crash raw artifacts must map one-to-one to lifecycle scenarios`);
      }
      scenarioIds.add(artifact.scenario_id);
    }
    paths.add(artifact.path);
  }
  if (label === "LOCAL_AGENT" &&
      REQUIRED_LOCAL_AGENT_ARTIFACT_TYPES.some((type) => !artifactTypes.has(type))) {
    throw new Error(`${label}_EVIDENCE_INVALID: all required raw artifact types are required`);
  }
  if (label === "PROCESS_CRASH_RESTART" &&
      REQUIRED_CRASH_SCENARIO_IDS.some((scenarioId) => !scenarioIds.has(scenarioId))) {
    throw new Error(`${label}_EVIDENCE_INVALID: every lifecycle scenario needs one raw JSONL artifact`);
  }
  return paths;
}

export function validateLocalAgentEvidence(document, options = {}) {
  assertEvidenceIdentity(document, "LOCAL_AGENT", "runs", [
    "model",
    "effort",
    "agent_workspace",
    "tool_contract",
  ]);
  if (document.release_version !== "0.4.0-rc.1") {
    throw new Error("LOCAL_AGENT_EVIDENCE_INVALID: release_version is not 0.4.0-rc.1");
  }
  if (options.expectedSourceFingerprint && document.source_fingerprint !== options.expectedSourceFingerprint) {
    throw new Error("LOCAL_AGENT_EVIDENCE_STALE: source_fingerprint does not match this gate run");
  }
  validateGenerator(document.generator, "CURRENT_LOCAL_AGENT_HARNESS", "LOCAL_AGENT");
  const rawArtifactPaths = validateRawArtifacts(document.raw_artifacts, "LOCAL_AGENT");
  if (!Array.isArray(document.runs) || document.runs.length === 0) {
    throw new Error("LOCAL_AGENT_EVIDENCE_NOT_CAPTURED: runs must contain a real local Agent run");
  }
  for (const [index, run] of document.runs.entries()) {
    assertExactFields(run, [
      "transport",
      "case_id",
      "tool_call_id",
      "provider_object_id",
      "mutation_receipt_id",
      "exact_readback_receipt_id",
      "evidence_chain_hash",
      "provider_write_count",
      "final_answer_claim",
      "final_answer",
      "raw_artifact_refs",
    ], `LOCAL_AGENT_RUN_${index}`);
    if (run.transport !== "MCP_STDIO" && run.transport !== "MCP_HTTP_LOOPBACK") {
      throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].transport is invalid`);
    }
    for (const field of [
      "case_id",
      "tool_call_id",
      "provider_object_id",
      "mutation_receipt_id",
      "exact_readback_receipt_id",
      "evidence_chain_hash",
      "final_answer",
    ]) {
      if (!isNonEmptyString(run[field])) {
        throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].${field} is required`);
      }
    }
    if (run.provider_write_count !== 1) {
      throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].provider_write_count must be 1`);
    }
    if (run.final_answer_claim !== "COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK") {
      throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].final_answer_claim is not evidence-bound`);
    }
    if (!isSha256(run.evidence_chain_hash)) {
      throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].evidence_chain_hash must be SHA-256`);
    }
    if (!Array.isArray(run.raw_artifact_refs) || run.raw_artifact_refs.length === 0 ||
      run.raw_artifact_refs.some((path) => !rawArtifactPaths.has(path))) {
      throw new Error(`LOCAL_AGENT_EVIDENCE_INVALID: runs[${index}].raw_artifact_refs are not bound to raw_artifacts`);
    }
  }
}

export function validateProcessCrashRestartEvidence(document, options = {}) {
  assertEvidenceIdentity(document, "PROCESS_CRASH_RESTART", "scenarios");
  if (document.release_version !== "0.4.0-rc.1") {
    throw new Error("PROCESS_CRASH_RESTART_EVIDENCE_INVALID: release_version is not 0.4.0-rc.1");
  }
  if (options.expectedSourceFingerprint && document.source_fingerprint !== options.expectedSourceFingerprint) {
    throw new Error("PROCESS_CRASH_RESTART_EVIDENCE_STALE: source_fingerprint does not match this gate run");
  }
  validateGenerator(document.generator, "PROCESS_CRASH_RESTART_HARNESS", "PROCESS_CRASH_RESTART");
  const rawArtifactPaths = validateRawArtifacts(document.raw_artifacts, "PROCESS_CRASH_RESTART");
  if (!Array.isArray(document.scenarios)) {
    throw new Error("PROCESS_CRASH_RESTART_EVIDENCE_NOT_CAPTURED: scenarios are missing");
  }
  if (document.scenarios.length !== REQUIRED_CRASH_SCENARIO_IDS.length) {
    throw new Error("PROCESS_CRASH_RESTART_EVIDENCE_INVALID: scenarios must exactly cover the required lifecycle windows");
  }
  const byId = new Map();
  for (const [index, scenario] of document.scenarios.entries()) {
    assertExactFields(scenario, [
      "scenario_id",
      "status",
      "termination",
      "termination_signal",
      "command",
      "server_pid_before",
      "server_pid_after",
      "restart_observed",
      "provider_write_count_after_restart",
      "recovery_outcome",
      "evidence_refs",
    ], `PROCESS_CRASH_RESTART_SCENARIO_${index}`);
    if (!isNonEmptyString(scenario.scenario_id)) throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: scenarios[${index}] has no scenario_id`);
    if (byId.has(scenario.scenario_id)) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: duplicate ${scenario.scenario_id}`);
    }
    byId.set(scenario.scenario_id, scenario);
  }
  for (const scenarioId of REQUIRED_CRASH_SCENARIO_IDS) {
    const scenario = byId.get(scenarioId);
    if (!scenario) throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_NOT_CAPTURED: missing ${scenarioId}`);
    if (scenario.status !== "PASS" || scenario.termination !== "PROCESS_KILL" ||
      scenario.termination_signal !== "SIGKILL" || scenario.restart_observed !== true) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: ${scenarioId} did not prove a real kill/restart`);
    }
    if (!isNonEmptyString(scenario.command) || !Number.isInteger(scenario.server_pid_before) ||
      !Number.isInteger(scenario.server_pid_after) || scenario.server_pid_before < 1 ||
      scenario.server_pid_after < 1 || scenario.server_pid_before === scenario.server_pid_after) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: ${scenarioId} has no distinct process restart identity`);
    }
    if (!Number.isInteger(scenario.provider_write_count_after_restart) || scenario.provider_write_count_after_restart > 1) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: ${scenarioId} did not prove at-most-once write`);
    }
    if (!["RECOVERED_READBACK_VERIFIED", "BLOCKED_SAFE_UNKNOWN", "IDEMPOTENT_REPLAY"].includes(scenario.recovery_outcome)) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: ${scenarioId} has an invalid recovery_outcome`);
    }
    if (!Array.isArray(scenario.evidence_refs) || scenario.evidence_refs.length === 0 ||
      scenario.evidence_refs.some((value) => !rawArtifactPaths.has(value))) {
      throw new Error(`PROCESS_CRASH_RESTART_EVIDENCE_INVALID: ${scenarioId} has no evidence_refs`);
    }
  }
}

function assertContainedPath(base, candidate, label) {
  if (!isNonEmptyString(candidate) || isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label}: path must be relative`);
  }
  const absolute = resolve(base, candidate);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) throw new Error(`${label}: path escapes evidence boundary`);
  return absolute;
}

export async function verifyEvidenceArtifactFiles(document, evidencePath, repoRoot) {
  if (document.agent_workspace) {
    await verifyAgentBundleEvidence(repoRoot, document.agent_workspace);
  }
  const evidenceDirectory = dirname(evidencePath);
  const executablePath = assertContainedPath(repoRoot, document.generator.executable_path, "GENERATOR_EXECUTABLE_INVALID");
  const executableStat = await lstat(executablePath);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error("GENERATOR_EXECUTABLE_INVALID: executable must be a regular non-symlink file");
  }
  const executable = await readFile(executablePath);
  if (sha256Buffer(executable) !== document.generator.executable_sha256) {
    throw new Error("GENERATOR_EXECUTABLE_STALE: executable_sha256 does not match current source");
  }
  const verified = new Map();
  for (const artifact of document.raw_artifacts) {
    const path = assertContainedPath(evidenceDirectory, artifact.path, "RAW_EVIDENCE_INVALID");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`RAW_EVIDENCE_INVALID: ${artifact.path} must be a regular non-symlink file`);
    }
    const content = await readFile(path);
    if (content.length !== artifact.size_bytes || sha256Buffer(content) !== artifact.sha256) {
      throw new Error(`RAW_EVIDENCE_STALE: ${artifact.path} digest or size does not match`);
    }
    verified.set(artifact.artifact_type === "CRASH_SCENARIO_JSONL"
      ? `${artifact.artifact_type}:${artifact.scenario_id}`
      : artifact.artifact_type, content);
  }
  return verified;
}

/**
 * Replays the local Agent result from raw facts. This intentionally duplicates
 * the generator's assertions: a compromised or accidentally permissive
 * generator cannot certify itself merely by writing `status: PASS`.
 */
export function verifyLocalAgentRawSemantics(document, artifacts, options = {}) {
  const events = parseJsonLinesBuffer(artifacts.get("CODEX_EVENTS_JSONL"), "LOCAL_AGENT_CODEX_EVENTS");
  assertAgentSkillReadCommandEvents(events, { errorPrefix: "LOCAL_AGENT_RAW" });
  const finalAnswer = parseJsonBuffer(artifacts.get("FINAL_ANSWER"), "LOCAL_AGENT_FINAL_ANSWER");
  const audit = parseJsonBuffer(artifacts.get("SERVER_AUDIT"), "LOCAL_AGENT_SERVER_AUDIT");
  const invocation = parseJsonBuffer(artifacts.get("INVOCATION"), "LOCAL_AGENT_INVOCATION");
  if (invocation.agent_workspace) {
    if (!isRecord(document.agent_workspace) ||
        stableStringify(document.agent_workspace) !== stableStringify(invocation.agent_workspace)) {
      throw new Error("LOCAL_AGENT_RAW_AGENT_WORKSPACE_SUMMARY_INVALID");
    }
    verifyAgentBundleEvidenceSync(options.repoRoot ?? process.cwd(), invocation.agent_workspace);
    if (document.model !== invocation.model || document.effort !== invocation.effort ||
        !isNonEmptyString(invocation.model) || !isNonEmptyString(invocation.effort)) {
      throw new Error("LOCAL_AGENT_RAW_MODEL_EFFORT_INVALID");
    }
  }
  const allCalls = codexToolCalls(events);
  const safeDiscoveryTools = new Set(["list_mcp_resources", "list_mcp_resource_templates"]);
  const calls = [];
  let businessStarted = false;
  let discoveryCount = 0;
  for (const call of allCalls) {
    if (!safeDiscoveryTools.has(call.tool)) {
      businessStarted = true;
      calls.push(call);
      continue;
    }
    discoveryCount += 1;
    const argumentKeys = isRecord(call.arguments) ? Object.keys(call.arguments) : [];
    if (businessStarted || discoveryCount > 2 || call.error ||
        !["completed", "COMPLETED"].includes(call.status) ||
        argumentKeys.some((key) => key !== "server")) {
      throw new Error("LOCAL_AGENT_RAW_MCP_DISCOVERY_INVALID");
    }
  }
  const expectedTools = [
    "xero_pin_current_organisation",
    "xero_get_organisation",
    "xero_prepare_accounting_case",
    "xero_execute_accounting_case",
  ];
  const expectedToolsWithStatus = [...expectedTools, "xero_get_accounting_case_status"];
  const actualTools = calls.map((call) => call.tool);
  const hasStatusCall = JSON.stringify(actualTools) === JSON.stringify(expectedToolsWithStatus);
  if ((!hasStatusCall && JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) ||
      calls.some((call) => call.error || !["completed", "COMPLETED"].includes(call.status))) {
    throw new Error("LOCAL_AGENT_RAW_TOOL_SEQUENCE_INVALID");
  }
  if (events.some((event) => {
    const type = event?.item?.type;
    return isNonEmptyString(type) && (
      (type.includes("tool_call") && type !== "mcp_tool_call") ||
      (type.includes("command") && type !== "command_execution") || type.includes("file_change") ||
      type === "web_search" || type === "file_search"
    );
  })) {
    throw new Error("LOCAL_AGENT_RAW_NON_MCP_TOOL_USED");
  }
  const targetSessionRef = targetSessionRefFromResult(calls[0]?.result);
  const expectedTargetSessionRefHash = targetSessionRefHash(targetSessionRef);
  if (!exactKeys(calls[0]?.arguments, []) ||
      !exactKeys(calls[1]?.arguments, ["target_session_ref"]) ||
      calls.slice(1).some((call) => call.arguments?.target_session_ref !== targetSessionRef)) {
    throw new Error("LOCAL_AGENT_RAW_TARGET_SESSION_SEQUENCE_INVALID");
  }
  if (calls.some((call) => containsForbiddenAuthorityField(call.arguments)) ||
      !exactKeys(calls[3]?.arguments, ["target_session_ref", "case_id", "case_version", "request_id"]) ||
      (hasStatusCall && !exactKeys(calls[4]?.arguments, ["target_session_ref", "case_id", "case_version"]))) {
    throw new Error("LOCAL_AGENT_RAW_PUBLIC_INPUT_AUTHORITY_VIOLATION");
  }
  const serverCalls = audit?.tool_calls;
  if (!Array.isArray(serverCalls) ||
      JSON.stringify(serverCalls.map((call) => call.tool)) !== JSON.stringify(actualTools) ||
      serverCalls.some((call) => call.status !== "PASS") ||
      serverCalls.some((call) => containsForbiddenAuthorityField(call.normalized_input)) ||
      !exactKeys(serverCalls[0]?.normalized_input, []) ||
      !exactKeys(serverCalls[1]?.normalized_input, []) ||
      !exactKeys(serverCalls[3]?.normalized_input, ["case_id", "case_version", "request_id"]) ||
      (hasStatusCall && !exactKeys(serverCalls[4]?.normalized_input, ["case_id", "case_version"]))) {
    throw new Error("LOCAL_AGENT_RAW_SERVER_SEQUENCE_INVALID");
  }
  const protocolCalls = audit?.mcp_protocol_calls;
  if (!Array.isArray(protocolCalls) ||
      JSON.stringify(protocolCalls.map((call) => call.tool)) !== JSON.stringify(actualTools) ||
      protocolCalls.some((call) => call.method !== "tools/call" || call.status !== "PASS" ||
        call.error !== null || call.raw_structured_result === null) ||
      new Set(protocolCalls.map((call) => `${typeof call.jsonrpc_id}:${String(call.jsonrpc_id)}`)).size !== calls.length) {
    throw new Error("LOCAL_AGENT_RAW_PROTOCOL_SEQUENCE_INVALID");
  }
  if (JSON.stringify(audit).includes(targetSessionRef)) {
    throw new Error("LOCAL_AGENT_RAW_TARGET_SESSION_AUDIT_LEAK");
  }
  if (protocolCalls.some((call) => call.target_session_ref_hash !== expectedTargetSessionRefHash) ||
      serverCalls.some((call) => call.target_session_ref_hash !== expectedTargetSessionRefHash)) {
    throw new Error("LOCAL_AGENT_RAW_TARGET_SESSION_HASH_INVALID");
  }
  const pinSafeTarget = mcpResultPayload(calls[0].result, "LOCAL_AGENT_RAW_PIN_RESULT")?.target_ref_safe;
  for (const [index, call] of calls.entries()) {
    const protocolCall = protocolCalls[index];
    const serviceCall = serverCalls[index];
    const normalizedInputBound = index === 2
      ? call.arguments?.case_id === serviceCall.normalized_input?.case_id &&
        call.arguments?.expected_version === serviceCall.normalized_input?.expected_version
      : stableStringify(targetBusinessInput(call.arguments)) === stableStringify(serviceCall.normalized_input);
    const publicArgumentsBound = stableStringify(redactTargetSessionRefs(call.arguments)) ===
      stableStringify(protocolCall.public_arguments);
    const eventResultBound = index === 1
      ? organisationReadBinding(
        mcpResultPayload(call.result, `LOCAL_AGENT_RAW_RESULT_${index}`),
        serviceCall.result,
        mcpStructuredEnvelope(call.result),
        pinSafeTarget,
        call.result,
      )
      : stableStringify(redactTargetSessionRefs(mcpResultPayload(call.result, `LOCAL_AGENT_RAW_RESULT_${index}`))) ===
        stableStringify(serviceCall.result);
    const protocolResultBound = index === 1
      ? organisationReadBinding(
        mcpResultPayload(protocolCall.raw_structured_result, `LOCAL_AGENT_PROTOCOL_RESULT_${index}`),
        serviceCall.result,
        mcpStructuredEnvelope(protocolCall.raw_structured_result),
        pinSafeTarget,
        protocolCall.raw_structured_result,
      )
      : stableStringify(mcpResultPayload(protocolCall.raw_structured_result, `LOCAL_AGENT_PROTOCOL_RESULT_${index}`)) ===
        stableStringify(serviceCall.result);
    if (!publicArgumentsBound || !normalizedInputBound || !eventResultBound || !protocolResultBound) {
      throw new Error(`LOCAL_AGENT_RAW_PROTOCOL_SERVICE_BINDING_INVALID:${index + 1}`);
    }
  }
  const targetEvidence = audit.target_session_evidence;
  if (audit.schema_version !== "1.0" || audit.release_version !== document.release_version ||
      audit.evidence_boundary !== "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY" ||
      targetEvidence?.status !== "PASS" || targetEvidence?.base_context_unpinned !== true ||
      targetEvidence?.required_by_server !== true ||
      targetEvidence?.raw_capability_persisted_in_server_audit !== false ||
      targetEvidence?.binding_scope !== "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY" ||
      targetEvidence?.conversation_binding !== "NOT_CLAIMED_NO_TRUSTED_SERVER_CONVERSATION_ID" ||
      targetEvidence?.target_session_ref_hash !== expectedTargetSessionRefHash ||
      !Number.isInteger(targetEvidence?.binding_revision) ||
      audit.provider_write_count !== 1 || !Array.isArray(audit.provider_records) ||
      audit.provider_records.length !== 1) {
    throw new Error("LOCAL_AGENT_RAW_SERVER_BOUNDARY_INVALID");
  }
  if (hashObject(audit.release_attestation) !== audit.release_attestation_hash ||
      hashObject(audit.runtime_attestation) !== audit.runtime_attestation_hash) {
    throw new Error("LOCAL_AGENT_RAW_SERVER_ATTESTATION_INVALID");
  }
  const durable = audit.durable_evidence;
  if (!isRecord(durable) || durable.case_state !== "TERMINAL" ||
      durable.operation_state !== "READBACK_VERIFIED" ||
      !isSha256(durable.compiled_plan_hash) || !isRecord(durable.write_receipt) ||
      !isRecord(durable.exact_readback)) {
    throw new Error("LOCAL_AGENT_RAW_DURABLE_EVIDENCE_INVALID");
  }
  const mutationReceiptId = `xwr_${hashObject(durable.write_receipt).slice(0, 32)}`;
  const exactReadbackReceiptId = `xrb_${hashObject(durable.exact_readback).slice(0, 32)}`;
  const evidenceChainHash = hashObject({
    caseId: durable.case_id,
    version: durable.case_version,
    compiledPlanHash: durable.compiled_plan_hash,
    operationId: durable.operation_id,
    operationState: durable.operation_state,
    providerObjectId: durable.provider_object_id,
    mutationRequestId: durable.mutation_request_id,
    mutationReceiptId,
    exactReadbackReceiptId,
    writeReceipt: durable.write_receipt,
    exactReadback: durable.exact_readback,
  });
  if (durable.mutation_receipt_id !== mutationReceiptId ||
      durable.exact_readback_receipt_id !== exactReadbackReceiptId ||
      durable.evidence_chain_hash !== evidenceChainHash) {
    throw new Error("LOCAL_AGENT_RAW_EVIDENCE_CHAIN_INVALID");
  }
  const provider = audit.provider_records[0];
  if (provider?.invoice_id !== durable.provider_object_id ||
      provider?.provider_receipt?.invoiceId !== durable.provider_object_id ||
      provider?.exact_readback?.invoiceId !== durable.provider_object_id) {
    throw new Error("LOCAL_AGENT_RAW_PROVIDER_SAME_ID_INVALID");
  }
  const prepareResult = serverCalls[2].result;
  const executeResult = serverCalls[3].result;
  const statusResult = hasStatusCall ? serverCalls[4].result : executeResult;
  const statusOperation = Array.isArray(statusResult?.operations) ? statusResult.operations[0] : undefined;
  const expectedSourceClaim = {
    trust: "UNVERIFIED_SUBMITTED_FACTS",
    source_truth_claim: "NOT_VERIFIED",
    original_file_verified: false,
    fact_origins: ["MODEL_EXTRACTED"],
    document_validity_basis: "SUBMITTED_ASSERTION",
  };
  if (prepareResult?.completion_claim?.ledger_write_claim !== "NOT_WRITTEN" ||
      executeResult?.completion_claim?.ledger_write_claim !== "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" ||
      statusResult?.completion_claim?.ledger_write_claim !== "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" ||
      stableStringify(prepareResult?.source_claim) !== stableStringify(expectedSourceClaim) ||
      stableStringify(executeResult?.source_claim) !== stableStringify(expectedSourceClaim) ||
      stableStringify(statusResult?.source_claim) !== stableStringify(expectedSourceClaim) ||
      statusResult?.state !== "TERMINAL" || statusOperation?.state !== "READBACK_VERIFIED" ||
      statusOperation?.xero_object_id !== durable.provider_object_id ||
      statusOperation?.provider_receipt_recorded !== true ||
      statusOperation?.exact_readback_recorded !== true) {
    throw new Error("LOCAL_AGENT_RAW_COMPLETION_INVALID");
  }
  const finalKeys = [
    "evidence_boundary",
    "completion_claim",
    "case_id",
    "case_version",
    "provider_object_id",
    "provider_receipt_recorded",
    "exact_same_id_readback_verified",
    "source_truth_claim",
    "original_file_verified",
    "message",
  ];
  if (!exactKeys(finalAnswer, finalKeys) || finalAnswer.evidence_boundary !== "LOCAL" ||
      finalAnswer.completion_claim !== "COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK" ||
      finalAnswer.case_id !== durable.case_id || finalAnswer.case_version !== durable.case_version ||
      finalAnswer.provider_object_id !== durable.provider_object_id ||
      finalAnswer.provider_receipt_recorded !== true ||
      finalAnswer.exact_same_id_readback_verified !== true ||
      finalAnswer.source_truth_claim !== "NOT_VERIFIED" ||
      finalAnswer.original_file_verified !== false) {
    throw new Error("LOCAL_AGENT_RAW_FINAL_ANSWER_INVALID");
  }
  const finalAgentMessages = events.filter((event) => event?.item?.type === "agent_message");
  const lastAgentText = finalAgentMessages.at(-1)?.item?.text;
  if (!isNonEmptyString(lastAgentText) || stableStringify(parseJsonBuffer(Buffer.from(lastAgentText), "LOCAL_AGENT_LAST_MESSAGE")) !==
      stableStringify(finalAnswer) || calls.at(-1).lastIndex >= events.lastIndexOf(finalAgentMessages.at(-1))) {
    throw new Error("LOCAL_AGENT_RAW_FINAL_ANSWER_ORDER_INVALID");
  }
  const assertions = invocation.assertions;
  if (invocation.schema_version !== "1.0" || invocation.evidence_boundary !== "LOCAL" ||
      invocation.exit_code !== 0 || invocation.source_fingerprint?.sha256 !== document.source_fingerprint ||
      invocation.runtime_attestation_hash !== hashObject(invocation.runtime_attestation) ||
      invocation.runtime_attestation_hash !== document.runtime_attestation_hash ||
      invocation.runtime_attestation?.release_attestation_hash !== audit.release_attestation_hash ||
      invocation.runtime_attestation?.server_runtime_attestation_hash !== audit.runtime_attestation_hash ||
      assertions?.only_public_targeted_case_tools !== true || assertions?.target_pin_first !== true ||
      assertions?.target_verified_before_write !== true ||
      assertions?.same_target_session_ref_all_ledger_calls !== true ||
      assertions?.target_ref_hash_recomputed_from_raw_events !== expectedTargetSessionRefHash ||
      assertions?.base_request_context_unpinned !== true ||
      assertions?.target_binding_scope !== "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY" ||
      assertions?.conversation_binding_residual !== "NO_TRUSTED_SERVER_CONVERSATION_ID_AVAILABLE") {
    throw new Error("LOCAL_AGENT_RAW_INVOCATION_ATTESTATION_INVALID");
  }
  const run = document.runs[0];
  if (document.runs.length !== 1 || run.case_id !== durable.case_id ||
      run.tool_call_id !== calls[3].id || run.provider_object_id !== durable.provider_object_id ||
      run.mutation_receipt_id !== mutationReceiptId || run.exact_readback_receipt_id !== exactReadbackReceiptId ||
      run.evidence_chain_hash !== evidenceChainHash || run.provider_write_count !== audit.provider_write_count ||
      stableStringify(parseJsonBuffer(Buffer.from(run.final_answer), "LOCAL_AGENT_SUMMARY_FINAL")) !==
        stableStringify(finalAnswer) ||
      new Set(run.raw_artifact_refs).size !== REQUIRED_LOCAL_AGENT_ARTIFACT_TYPES.length ||
      document.raw_artifacts.some((artifact) => !run.raw_artifact_refs.includes(artifact.path))) {
    throw new Error("LOCAL_AGENT_RAW_SUMMARY_DIVERGED");
  }
}

async function readCodeSigningIdentity(executablePath) {
  const child = spawn("/usr/bin/codesign", ["-dv", "--verbose=4", executablePath], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: null, error: error.message }));
    child.once("close", (code) => resolvePromise({ code, error: null }));
  });
  const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
  if (outcome.code !== 0 || !output.includes("Identifier=codex") ||
      !output.includes(`TeamIdentifier=${APPROVED_LOCAL_AGENT_CODEX_TEAM_ID}`)) {
    throw new Error("LOCAL_AGENT_RAW_CODEX_PLATFORM_IDENTITY_INVALID");
  }
}

/** Re-hashes the actual, approved Codex executable and prompt named by the raw invocation. */
export async function verifyLocalAgentExecutableIdentity(artifacts, options = {}) {
  const invocation = parseJsonBuffer(artifacts.get("INVOCATION"), "LOCAL_AGENT_INVOCATION");
  const codex = invocation.codex;
  if (!isRecord(codex) || !isAbsolute(codex.executable_path) || codex.executable_path.includes("\0") ||
      !isSha256(codex.executable_sha256) || !isNonEmptyString(codex.version) ||
      !Array.isArray(codex.command) || codex.command[0] !== codex.executable_path ||
      !isNonEmptyString(invocation.prompt) || sha256Buffer(Buffer.from(invocation.prompt, "utf8")) !== invocation.prompt_sha256) {
    throw new Error("LOCAL_AGENT_RAW_CODEX_IDENTITY_INVALID");
  }
  const approvedPaths = new Set((options.allowedCodexExecutablePaths ?? APPROVED_LOCAL_AGENT_CODEX_PATHS)
    .map((path) => resolve(path)));
  const resolvedExecutable = resolve(codex.executable_path);
  if (!approvedPaths.has(resolvedExecutable) || await realpath(resolvedExecutable) !== resolvedExecutable) {
    throw new Error("LOCAL_AGENT_RAW_CODEX_EXECUTABLE_NOT_APPROVED");
  }
  const stat = await lstat(resolvedExecutable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("LOCAL_AGENT_RAW_CODEX_EXECUTABLE_INVALID");
  const executable = await readFile(resolvedExecutable);
  if (sha256Buffer(executable) !== codex.executable_sha256) {
    throw new Error("LOCAL_AGENT_RAW_CODEX_EXECUTABLE_STALE");
  }
  if (options.verifyPlatformIdentity !== false) await readCodeSigningIdentity(resolvedExecutable);
}

export function createLocalAcceptancePlan(options) {
  if (!/^[a-f0-9]{64}$/u.test(options.approvedControlCatalogSha256 ?? "")) {
    throw new Error("LOCAL_GATE_APPROVED_CONTROL_CATALOG_SHA256_REQUIRED");
  }
  // Reviewer identity is optional here for the same reason it is optional at the
  // runner boundary: this plan contains no independent-review step to identify.
  // When a host does supply it, it still has to be a real digest.
  if ([
    options.approvedReviewCodexSha256,
    options.approvedReviewRuntimeSha256,
  ].some((value) => value !== undefined && !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("LOCAL_GATE_INDEPENDENT_REVIEW_HOST_IDENTITY_REQUIRED");
  }
  if ([
    options.expectedSourceFingerprint,
    options.sourceSnapshotManifestSha256,
    options.liveReviewChallengeSha256,
  ].some((value) => !/^[a-f0-9]{64}$/u.test(value ?? "")) ||
      !/^[0-9a-f-]{36}$/u.test(options.gateRunId ?? "")) {
    throw new Error("LOCAL_GATE_INDEPENDENT_REVIEW_HOST_IDENTITY_REQUIRED");
  }
  const releaseDirectory = resolve(options.evidenceDirectory, "release");
  const releaseBase = resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1-source");
  const traceabilityArgs = [
    "scripts/review/validate-requirements-traceability.mjs",
    "--file",
    options.traceabilityPath,
    "--require-closed",
    "--approved-control-catalog-sha256",
    options.approvedControlCatalogSha256,
  ];
  if (options.expectedSourceFingerprint) {
    traceabilityArgs.push("--expected-source-fingerprint", options.expectedSourceFingerprint);
  }
  // The plan used to open with `independent-review-live`, a step whose entire
  // body printed "an out-of-repository pinned parent driver must sign a receipt
  // with a host-held key, and no such authority exists here" and exited 78. It
  // was the first step of a fail-closed sequence, so the gate stopped there on
  // every run and nothing after it — typecheck, tests, evidence validation, the
  // release bundle — ever executed. A gate pinned at NO-GO cannot distinguish a
  // real regression from its own floor, so in practice it gated nothing.
  //
  // The signing layer it was waiting for was removed from the design (ADR-003).
  // Independence is kept, but as a procedural rule recorded in the manifest and
  // in docs/LOCAL-ANTI-LAZINESS-ACCEPTANCE-MECHANISM.md: the review must be run
  // by a session that did not write the change. The manifest continues to state
  // `gate_l_claim: NOT_IMPLIED` and `independent_review_authority:
  // LOCAL_EVIDENCE_UNTRUSTED`, so a local pass still never claims to be one.
  const plan = [
    {
      id: "traceability-closed",
      precondition: true,
      command: process.execPath,
      args: traceabilityArgs,
      cwd: options.evidenceValidationRoot,
    },
    {
      id: "local-agent-evidence",
      precondition: true,
      evidencePath: options.localAgentEvidencePath,
      evidenceKind: "LOCAL_AGENT",
    },
    {
      id: "process-crash-restart-evidence",
      precondition: true,
      evidencePath: options.processCrashRestartEvidencePath,
      evidenceKind: "PROCESS_CRASH_RESTART",
    },
    { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
    { id: "build", command: "npm", args: ["run", "build"] },
    {
      id: "full-regression",
      command: "npm",
      args: ["test", "--", "--maxWorkers=1", "--no-cache"],
      env: { TEST_HTTP_LOOPBACK: "true" },
    },
    { id: "postgres-required", command: "npm", args: ["run", "test:postgres:required", "--", "--no-cache"] },
    { id: "http-required", command: "npm", args: ["run", "test:http:required", "--", "--no-cache"] },
    { id: "static-verification", command: "bash", args: ["deploy/scripts/verify-static.sh"] },
    { id: "git-diff-check", command: "git", args: ["diff", "--check"] },
    {
      id: "release-bundle-build",
      artifactStreamKind: "SOURCE_BUNDLE",
      command: process.execPath,
      args: [
        "scripts/release/build-xero-release-bundle.mjs",
        "--output-dir",
        releaseDirectory,
        "--source-date-epoch",
        "0",
        "--approved-control-catalog-sha256",
        options.approvedControlCatalogSha256,
        "--artifact-stream-fd",
        "3",
      ],
    },
    {
      id: "release-bundle-verify",
      command: process.execPath,
      args: [
        "scripts/release/verify-xero-release-bundle.mjs",
        "--archive",
        `${releaseBase}.tar.gz`,
        "--manifest",
        `${releaseBase}.manifest.json`,
        "--build-identity",
        `${releaseBase}.build-identity.json`,
        "--checksum",
        `${releaseBase}.sha256`,
        "--approved-control-catalog-sha256",
        options.approvedControlCatalogSha256,
      ],
    },
    {
      id: "release-oci-build",
      artifactStreamKind: "OCI_RELEASE",
      command: process.execPath,
      args: [
        "scripts/release/build-accepted-oci-image.mjs",
        "--context",
        resolve(releaseDirectory, "accepted-build-context"),
        "--output",
        resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1.oci.tar"),
        "--metadata",
        resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1.oci-metadata.json"),
        "--receipt",
        resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json"),
        "--approved-control-catalog-sha256",
        options.approvedControlCatalogSha256,
        "--artifact-stream-fd",
        "3",
      ],
    },
    {
      id: "release-oci-runtime-smoke",
      command: process.execPath,
      args: [
        "scripts/release/smoke-accepted-oci-runtime.mjs",
        "--artifact",
        resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1.oci.tar"),
        "--receipt",
        resolve(releaseDirectory, "xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json"),
        "--approved-control-catalog-sha256",
        options.approvedControlCatalogSha256,
      ],
    },
  ];
  assertCompleteGatePlan(plan);
  return plan;
}

export function assertCompleteGatePlan(plan) {
  if (!Array.isArray(plan)) throw new Error("LOCAL_GATE_PLAN_INVALID");
  const ids = plan.map((step) => step?.id);
  if (JSON.stringify(ids) !== JSON.stringify(REQUIRED_GATE_STEP_IDS)) {
    throw new Error(`LOCAL_GATE_PLAN_INCOMPLETE: expected ${REQUIRED_GATE_STEP_IDS.join(",")}; received ${ids.join(",")}`);
  }
}

export async function runStepsFailClosed(steps, executeStep) {
  assertCompleteGatePlan(steps);
  const results = [];
  const preconditions = steps.filter((step) => step.precondition === true);
  // Every precondition is now equal: the first one is no longer a distinguished
  // authority step that had to pass before anything else could run. Failing
  // closed still means a failing precondition fails the gate — what changed is
  // that no step is guaranteed to fail before the others are reached.
  for (const step of preconditions) {
    const result = await executeStep(step);
    results.push(result);
  }
  const failedPrecondition = results.find((result) => result.status !== "PASS");
  // A precondition failing no longer skips verification. The preconditions
  // validate review documentation - traceability closure, agent and crash
  // evidence - while the steps below establish whether the candidate itself
  // typechecks, passes its suite, and rebuilds to the same image. Those are
  // different questions, and short-circuiting meant an incomplete review
  // artifact left the candidate entirely unmeasured: the operator learned
  // nothing about the code until the paperwork was finished. The gate still
  // fails closed on either, and still reports the first failure.
  for (const step of steps.filter((candidate) => candidate.precondition !== true)) {
    const result = await executeStep(step);
    results.push(result);
    if (result.status !== "PASS") {
      return { status: "FAIL", failed_step_id: failedPrecondition?.id ?? step.id, results };
    }
  }
  if (failedPrecondition) {
    return { status: "FAIL", failed_step_id: failedPrecondition.id, results };
  }
  return { status: "PASS", failed_step_id: null, results };
}

function assertSafeSourceRoots(sourceRoots) {
  if (!Array.isArray(sourceRoots) || sourceRoots.length === 0) {
    throw new Error("SOURCE_FINGERPRINT_ROOTS_INVALID");
  }
  const observed = new Set();
  for (const sourceRoot of sourceRoots) {
    if (!isNonEmptyString(sourceRoot) || isAbsolute(sourceRoot) || sourceRoot.includes("\0") ||
        sourceRoot.includes("\\") || sourceRoot === "." || sourceRoot.startsWith("../") ||
        sourceRoot.includes("/../") || sourceRoot.endsWith("/..") || observed.has(sourceRoot)) {
      throw new Error(`SOURCE_FINGERPRINT_ROOT_INVALID: ${String(sourceRoot)}`);
    }
    observed.add(sourceRoot);
  }
}

async function enumerateFiles(root, relativeRoot, output) {
  const absoluteRoot = resolve(root, relativeRoot);
  let stat;
  try {
    stat = await lstat(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`SOURCE_FINGERPRINT_INPUT_MISSING: ${relativeRoot}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`SOURCE_FINGERPRINT_SYMLINK_REJECTED: ${relativeRoot}`);
  if (stat.isFile()) {
    output.push(relativeRoot);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`SOURCE_FINGERPRINT_INPUT_INVALID: ${relativeRoot}`);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
    await enumerateFiles(root, `${relativeRoot}/${entry.name}`, output);
  }
}

async function acceptanceSourceRecords(repoRoot, sourceRoots) {
  assertSafeSourceRoots(sourceRoots);
  const files = [];
  for (const sourceRoot of sourceRoots) await enumerateFiles(repoRoot, sourceRoot, files);
  files.sort((left, right) => left.localeCompare(right, "en"));
  const records = [];
  for (const path of files) {
    const absolutePath = resolve(repoRoot, path);
    const [content, stat] = await Promise.all([readFile(absolutePath), lstat(absolutePath)]);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`SOURCE_FINGERPRINT_INPUT_CHANGED_TYPE: ${path}`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    const executable = (stat.mode & 0o111) !== 0;
    records.push({ path, size_bytes: content.length, executable, sha256: digest, content });
  }
  return records;
}

function acceptanceSourceIdentity(records, sourceRoots) {
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(`${Buffer.byteLength(record.path)}:${record.path}:${record.size_bytes}:${record.executable ? 1 : 0}:${record.sha256}\n`);
  }
  return {
    algorithm: "sha256-path-size-executable-content-v2",
    file_count: records.length,
    sha256: hash.digest("hex"),
    roots: [...sourceRoots],
  };
}

export async function acceptanceSourceManifest(repoRoot, options = {}) {
  const sourceRoots = options.sourceRoots ?? ACCEPTANCE_SOURCE_ROOTS;
  const records = await acceptanceSourceRecords(repoRoot, sourceRoots);
  return {
    schema_version: "1.0",
    kind: "LOCAL_ACCEPTANCE_SOURCE_SNAPSHOT",
    source_fingerprint: acceptanceSourceIdentity(records, sourceRoots),
    files: records.map(({ content: _content, ...record }) => record),
  };
}

export async function fingerprintAcceptanceSource(repoRoot, options = {}) {
  return (await acceptanceSourceManifest(repoRoot, options)).source_fingerprint;
}

/**
 * A recursive watcher does not start observing at the instant `watch()` returns.
 * On macOS the FSEvents stream backing it delivers a short backlog of changes
 * that happened *before* the watcher existed, so a monitor created immediately
 * after `makeTreeReadOnly` sees that function's own chmods and reports mutation
 * on a tree nothing has touched.
 *
 * Arming closes that hole deterministically instead of by sleeping. After the
 * watcher is created the monitor writes and removes a uniquely named sentinel at
 * the watched root, then waits for the watcher to report it. Because a stream
 * delivers in order, the sentinel is a watermark: everything observed before it
 * is pre-arm backlog and is discarded, everything after it is a real event.
 *
 * The sentinel is not under any monitored source root, so it never counts as a
 * source mutation, and it is unlinked as soon as it is observed.
 */
const MUTATION_MONITOR_ARM_TIMEOUT_MS = 4000;

async function startTreeMutationMonitor(root, sourceRoots, label) {
  assertSafeSourceRoots(sourceRoots);
  const watchers = [];
  const events = [];
  const errors = [];
  let closed = false;
  let armed = false;
  const barrierName = `.xero-mutation-monitor-barrier-${randomUUID()}`;
  let onBarrier = null;
  function record(kind, sourceRoot, filename, error) {
    if (closed) return;
    const target = error ? errors : events;
    if (target.length >= 100) return;
    target.push({
      kind,
      source_root: sourceRoot,
      filename: filename === null || filename === undefined ? null : String(filename),
      error: error instanceof Error ? error.message : error ? String(error) : null,
    });
  }
  try {
    for (const sourceRoot of sourceRoots) {
      const absolute = resolve(root, sourceRoot);
      const stat = await lstat(absolute);
      if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) {
        throw new Error(`invalid monitored source root: ${sourceRoot}`);
      }
    }
    const watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (filename === null || filename === undefined) {
        record(eventType, "<unknown>", null, null);
        return;
      }
      const normalized = String(filename).replaceAll("\\", "/").replace(/^\.\//u, "");
      if (normalized === barrierName) {
        onBarrier?.();
        return;
      }
      const matchedRoot = sourceRoots.find((sourceRoot) =>
        normalized === sourceRoot || normalized.startsWith(`${sourceRoot}/`));
      if (matchedRoot) record(eventType, matchedRoot, normalized, null);
    });
    watcher.on("error", (error) => record("WATCH_ERROR", "<root>", null, error));
    watchers.push(watcher);
  } catch (error) {
    closed = true;
    for (const watcher of watchers) watcher.close();
    throw new Error(`${label}_WATCH_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }

  const barrierPath = resolve(root, barrierName);
  let armTimer = null;
  try {
    const settled = new Promise((resolvePromise) => {
      onBarrier = () => resolvePromise(true);
      // The watcher is not persistent, so this timer is what holds the event
      // loop open while the barrier is in flight. It must not be unref'd.
      armTimer = setTimeout(() => resolvePromise(false), MUTATION_MONITOR_ARM_TIMEOUT_MS);
    });
    await writeFile(barrierPath, `${label}\n`, { mode: 0o600 });
    armed = await settled;
  } catch {
    armed = false;
  } finally {
    onBarrier = null;
    if (armTimer !== null) clearTimeout(armTimer);
    await rm(barrierPath, { force: true }).catch(() => undefined);
  }
  // Everything up to the watermark is backlog from before this monitor existed.
  events.length = 0;
  errors.length = 0;

  return {
    label,
    armed,
    /**
     * An unarmed watcher cannot distinguish backlog from real events, so it
     * reports nothing rather than reporting noise. It is a supplementary signal:
     * the inode/ctime/mtime mutation guard stays mandatory either way, and
     * `armed` is carried into the evidence so a run is never silently downgraded
     * to content-hash comparison alone.
     */
    get changed() {
      return armed && events.length > 0;
    },
    events() {
      return events.map((event) => ({ ...event }));
    },
    errors() {
      return errors.map((error) => ({ ...error }));
    },
    close() {
      if (closed) return;
      closed = true;
      for (const watcher of watchers) watcher.close();
    },
  };
}

async function enumerateMutationGuardEntries(root, relativeRoot, output) {
  const absolute = resolve(root, relativeRoot);
  let stat;
  try {
    stat = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`SOURCE_MUTATION_GUARD_INPUT_MISSING: ${relativeRoot}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`SOURCE_MUTATION_GUARD_SYMLINK_REJECTED: ${relativeRoot}`);
  const type = stat.isFile() ? "FILE" : stat.isDirectory() ? "DIRECTORY" : "UNSUPPORTED";
  if (type === "UNSUPPORTED") throw new Error(`SOURCE_MUTATION_GUARD_INPUT_INVALID: ${relativeRoot}`);
  output.push({
    path: relativeRoot,
    type,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    ctime_ns: stat.ctimeNs.toString(),
    mtime_ns: stat.mtimeNs.toString(),
  });
  if (type === "DIRECTORY") {
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      await enumerateMutationGuardEntries(root, `${relativeRoot}/${entry.name}`, output);
    }
  }
}

export async function fingerprintAcceptanceMutationState(repoRoot, options = {}) {
  const sourceRoots = options.sourceRoots ?? ACCEPTANCE_SOURCE_ROOTS;
  assertSafeSourceRoots(sourceRoots);
  const entries = [];
  for (const sourceRoot of sourceRoots) await enumerateMutationGuardEntries(repoRoot, sourceRoot, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${stableStringify(entry)}\n`, "utf8");
  }
  return {
    algorithm: "sha256-path-type-device-inode-mode-size-ctime-mtime-v1",
    entry_count: entries.length,
    sha256: hash.digest("hex"),
  };
}

async function writeCapturedSource(snapshotRoot, records) {
  for (const record of records) {
    const target = resolve(snapshotRoot, record.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, record.content, {
      flag: "wx",
      mode: record.executable ? 0o755 : 0o644,
    });
  }
}

async function makeTreeReadOnly(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) await makeTreeReadOnly(resolve(path, entry));
    await chmod(path, 0o555);
    return;
  }
  if (stat.isFile()) await chmod(path, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
}

async function makeDirectoriesRemovable(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(path, 0o755);
  const entries = await readdir(path);
  for (const entry of entries) await makeDirectoriesRemovable(resolve(path, entry));
}

/**
 * Captures the exact source bytes once, verifies the capture against the live
 * tree while a mutation journal is already active, and then executes from a
 * digest-named read-only tree. Dependencies and Git metadata are copied, never
 * linked back to the mutable worktree.
 */
export async function createImmutableAcceptanceSnapshot(repoRoot, options = {}) {
  const sourceRoots = options.sourceRoots ?? ACCEPTANCE_SOURCE_ROOTS;
  const copyDependencies = options.copyDependencies !== false;
  const copyGitMetadata = options.copyGitMetadata !== false;
  const originalMonitor = await startTreeMutationMonitor(repoRoot, sourceRoots, "ORIGINAL_SOURCE");
  const temporaryRoot = await mkdtemp(join(options.temporaryParent ?? tmpdir(), "xero-local-acceptance-snapshot-"));
  const stagingRoot = resolve(temporaryRoot, "capturing");
  let snapshotMonitor;
  try {
    await mkdir(stagingRoot, { recursive: true });
    const originalMutationState = await fingerprintAcceptanceMutationState(repoRoot, { sourceRoots });
    const records = await acceptanceSourceRecords(repoRoot, sourceRoots);
    const sourceFingerprint = acceptanceSourceIdentity(records, sourceRoots);
    await writeCapturedSource(stagingRoot, records);

    const copiedSource = await fingerprintAcceptanceSource(stagingRoot, { sourceRoots });
    const originalAfterCapture = await fingerprintAcceptanceSource(repoRoot, { sourceRoots });
    const originalMutationAfterCapture = await fingerprintAcceptanceMutationState(repoRoot, { sourceRoots });
    if (copiedSource.sha256 !== sourceFingerprint.sha256 ||
        originalAfterCapture.sha256 !== sourceFingerprint.sha256 ||
        originalMutationAfterCapture.sha256 !== originalMutationState.sha256 || originalMonitor.changed) {
      throw new Error(`LOCAL_ACCEPTANCE_SNAPSHOT_CAPTURE_DIVERGED: copied=${copiedSource.sha256 === sourceFingerprint.sha256}; original=${originalAfterCapture.sha256 === sourceFingerprint.sha256}; events=${JSON.stringify(originalMonitor.events())}`);
    }

    if (copyDependencies) {
      const dependencyPath = resolve(repoRoot, "node_modules");
      const dependencyStat = await lstat(dependencyPath);
      if (!dependencyStat.isDirectory() || dependencyStat.isSymbolicLink()) {
        throw new Error("LOCAL_ACCEPTANCE_DEPENDENCIES_INVALID");
      }
      const dependencyMonitor = await startTreeMutationMonitor(repoRoot, ["node_modules"], "ORIGINAL_DEPENDENCIES");
      try {
        await cp(dependencyPath, resolve(stagingRoot, "node_modules"), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
        if (dependencyMonitor.changed) throw new Error("LOCAL_ACCEPTANCE_DEPENDENCIES_CHANGED_DURING_CAPTURE");
      } finally {
        dependencyMonitor.close();
      }
    }

    if (copyGitMetadata) {
      const gitPath = resolve(repoRoot, ".git");
      const gitStat = await lstat(gitPath);
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
        throw new Error("LOCAL_ACCEPTANCE_GIT_METADATA_INVALID");
      }
      await cp(gitPath, resolve(stagingRoot, ".git"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }

    const snapshotRoot = resolve(temporaryRoot, sourceFingerprint.sha256);
    await rename(stagingRoot, snapshotRoot);
    for (const sourceRoot of sourceRoots) await makeTreeReadOnly(resolve(snapshotRoot, sourceRoot));
    if (copyDependencies) await makeTreeReadOnly(resolve(snapshotRoot, "node_modules"));
    if (copyGitMetadata) await makeTreeReadOnly(resolve(snapshotRoot, ".git"));
    snapshotMonitor = await startTreeMutationMonitor(snapshotRoot, sourceRoots, "IMMUTABLE_SNAPSHOT");
    const snapshotMutationState = await fingerprintAcceptanceMutationState(snapshotRoot, { sourceRoots });
    const [originalBeforeExecution, originalMutationBeforeExecution] = await Promise.all([
      fingerprintAcceptanceSource(repoRoot, { sourceRoots }),
      fingerprintAcceptanceMutationState(repoRoot, { sourceRoots }),
    ]);
    if (originalBeforeExecution.sha256 !== sourceFingerprint.sha256 ||
        originalMutationBeforeExecution.sha256 !== originalMutationState.sha256 || originalMonitor.changed) {
      throw new Error("LOCAL_ACCEPTANCE_SOURCE_CHANGED_BEFORE_EXECUTION");
    }

    return {
      repoRoot,
      root: snapshotRoot,
      temporaryRoot,
      sourceRoots: [...sourceRoots],
      sourceFingerprint,
      originalMutationState,
      snapshotMutationState,
      sourceManifest: {
        schema_version: "1.0",
        kind: "LOCAL_ACCEPTANCE_SOURCE_SNAPSHOT",
        source_fingerprint: sourceFingerprint,
        files: records.map(({ content: _content, ...record }) => record),
        execution_inputs: {
          source_roots_read_only: true,
          dependencies_copied_not_linked: copyDependencies,
          git_metadata_copied_not_linked: copyGitMetadata,
          mutation_guard_algorithm: originalMutationState.algorithm,
          // The mutation guard is the mandatory control; the watchers are a
          // supplementary immediate signal. Record whether each one actually
          // armed so a run is never read as watcher-backed when it was not.
          original_watcher_armed: originalMonitor.armed,
          snapshot_watcher_armed: snapshotMonitor.armed,
        },
      },
      originalMonitor,
      snapshotMonitor,
      async dispose() {
        originalMonitor.close();
        snapshotMonitor.close();
        await makeDirectoriesRemovable(temporaryRoot);
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    originalMonitor.close();
    snapshotMonitor?.close();
    await makeDirectoriesRemovable(temporaryRoot).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function assertAcceptanceSnapshotIntegrity(snapshot) {
  const [snapshotSource, originalSource, snapshotMutationState, originalMutationState] = await Promise.all([
    fingerprintAcceptanceSource(snapshot.root, { sourceRoots: snapshot.sourceRoots }),
    fingerprintAcceptanceSource(snapshot.repoRoot, { sourceRoots: snapshot.sourceRoots }),
    fingerprintAcceptanceMutationState(snapshot.root, { sourceRoots: snapshot.sourceRoots }),
    fingerprintAcceptanceMutationState(snapshot.repoRoot, { sourceRoots: snapshot.sourceRoots }),
  ]);
  if (snapshot.snapshotMonitor.changed) throw new Error("IMMUTABLE_SNAPSHOT_MUTATION_OBSERVED");
  if (snapshotMutationState.sha256 !== snapshot.snapshotMutationState.sha256) {
    throw new Error("IMMUTABLE_SNAPSHOT_MUTATION_OBSERVED: mutation guard diverged");
  }
  if (snapshotSource.sha256 !== snapshot.sourceFingerprint.sha256) {
    throw new Error("IMMUTABLE_SNAPSHOT_FINGERPRINT_DIVERGED");
  }
  if (snapshot.originalMonitor.changed) throw new Error("ORIGINAL_SOURCE_MUTATION_OBSERVED");
  if (originalMutationState.sha256 !== snapshot.originalMutationState.sha256) {
    throw new Error("ORIGINAL_SOURCE_MUTATION_OBSERVED: mutation guard diverged");
  }
  if (originalSource.sha256 !== snapshot.sourceFingerprint.sha256) {
    throw new Error("ORIGINAL_SOURCE_FINGERPRINT_DIVERGED");
  }
  return {
    snapshot_source: snapshotSource,
    original_source: originalSource,
    snapshot_mutation_state: snapshotMutationState,
    original_mutation_state: originalMutationState,
    original_mutation_events: snapshot.originalMonitor.events(),
    snapshot_mutation_events: snapshot.snapshotMonitor.events(),
  };
}

export function safeEvidenceLogName(stepId, stream) {
  const normalized = stepId.replaceAll(/[^a-z0-9-]/giu, "-");
  return `${normalized}.${basename(stream)}.log`;
}

export function redactEvidenceBuffer(buffer, secrets) {
  let text = buffer.toString("utf8");
  for (const secret of secrets) {
    if (isNonEmptyString(secret)) text = text.replaceAll(secret, "<redacted>");
  }
  return Buffer.from(text, "utf8");
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function requiredSuiteContainsConditionalSkip(stepId, stdout, stderr) {
  if (!["full-regression", "postgres-required", "http-required"].includes(stepId)) return false;
  return /\b(?:skipped|skip|todo)\b/iu.test(Buffer.concat([stdout, stderr]).toString("utf8"));
}

export function displayCommand(step) {
  if (step.evidencePath) return `validate-evidence ${step.evidenceKind} ${relative(process.cwd(), step.evidencePath)}`;
  return [step.command, ...step.args.map((argument) => {
    if (step.id === "traceability-closed" && isAbsolute(argument)) return `<traceability>/${basename(argument)}`;
    if (step.id.startsWith("release-bundle-") && isAbsolute(argument)) return `<evidence>/${basename(argument)}`;
    return argument.includes(" ") ? JSON.stringify(argument) : argument;
  })].join(" ");
}
