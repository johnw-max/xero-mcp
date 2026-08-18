import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS,
  buildIndependentReviewCodexCommand,
  buildIndependentReviewObligationProbeCommand,
  createIndependentReviewSanitizedEnvironment,
  createIndependentReviewObligationProbeReceipt,
  fingerprintIndependentReviewInputs,
  independentReviewEnvironmentPolicy,
  INDEPENDENT_REVIEW_CODEX_IDENTIFIER,
  INDEPENDENT_REVIEW_CODEX_TEAM_ID,
  INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
  INDEPENDENT_REVIEW_MODEL,
  INDEPENDENT_REVIEW_REASONING_EFFORT,
  reviewSha256,
  runIndependentReviewTestPlan,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";
import {
  buildIndependentReviewShardInspectionCommands,
  createIndependentReviewShardChunkReceipt,
  createIndependentReviewShardReceipt,
  deriveIndependentReviewPlan,
} from "./independent-review-plan-lib.mjs";

const SUMMARY_FIELDS = [
  "schema_version", "evidence_boundary", "captured_at", "source_fingerprint",
  "review_subject_sha256", "review_inputs_sha256", "plan_sha256", "requirement_id",
  "claim_id", "shard_id", "implementation_execution_id", "reviewer_execution_id",
  "decision", "generator", "raw_artifacts",
];
const LIVE_SUMMARY_FIELDS = [...SUMMARY_FIELDS, "live_binding"];
const RAW_ARTIFACT_TYPES = ["CODEX_EVENTS_JSONL", "CODEX_STDERR", "FINAL_VERDICT", "INVOCATION"];
const REVIEW_AXIS_FIELDS = [
  "mcp_layer", "provider_neutrality", "durable_state", "concurrency_recovery",
  "test_evidence", "adversarial_counterexample",
];
const LIVE_CONTEXT_FIELDS = [
  "schema_version", "mode", "gate_run_id", "live_challenge", "source_fingerprint_sha256",
  "source_snapshot_sha256", "source_snapshot_manifest_sha256", "source_snapshot_attestation_sha256",
  "supplemental_inputs_sha256", "supplemental_manifest_sha256",
  "approved_review_codex_sha256", "approved_review_runtime_sha256",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function sha(value) {
  return /^[a-f0-9]{64}$/u.test(value ?? "");
}

export function normalizeIndependentReviewLiveContext(context) {
  exactFields(context, LIVE_CONTEXT_FIELDS, "INDEPENDENT_REVIEW_LIVE_CONTEXT");
  if (context.schema_version !== "1.0" || context.mode !== "LOCAL_ACCEPTANCE_GATE_LIVE" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(context.gate_run_id ?? "") || !/^[a-f0-9]{64}$/u.test(context.live_challenge ?? "") ||
      [
        context.source_fingerprint_sha256,
        context.source_snapshot_sha256,
        context.source_snapshot_manifest_sha256,
        context.source_snapshot_attestation_sha256,
        context.supplemental_inputs_sha256,
        context.supplemental_manifest_sha256,
        context.approved_review_codex_sha256,
        context.approved_review_runtime_sha256,
      ].some((value) => !sha(value))) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_CONTEXT_IDENTITY_INVALID");
  }
  return {
    schema_version: "1.0",
    mode: context.mode,
    gate_run_id: context.gate_run_id,
    live_challenge_sha256: reviewSha256(context.live_challenge),
    source_fingerprint_sha256: context.source_fingerprint_sha256,
    source_snapshot_sha256: context.source_snapshot_sha256,
    source_snapshot_manifest_sha256: context.source_snapshot_manifest_sha256,
    source_snapshot_attestation_sha256: context.source_snapshot_attestation_sha256,
    supplemental_inputs_sha256: context.supplemental_inputs_sha256,
    supplemental_manifest_sha256: context.supplemental_manifest_sha256,
    approved_review_codex_sha256: context.approved_review_codex_sha256,
    approved_review_runtime_sha256: context.approved_review_runtime_sha256,
  };
}

/**
 * Binds a mechanically derived plan to the exact Gate-frozen dual-root
 * context. A self-consistent plan is not sufficient: its source and
 * supplemental identities must be the identities approved by the live host
 * binding.
 */
export function assertIndependentReviewLivePlanBinding({
  plan,
  liveBinding,
  sourceSnapshotContext,
  hostContextReceipt,
}) {
  if (!isRecord(plan) || !isRecord(liveBinding) || !isRecord(sourceSnapshotContext) ||
      plan.source_snapshot_sha256 !== liveBinding.source_snapshot_sha256 ||
      plan.supplemental_inputs_sha256 !== liveBinding.supplemental_inputs_sha256 ||
      sourceSnapshotContext.source_snapshot_sha256 !== liveBinding.source_snapshot_sha256 ||
      sourceSnapshotContext.supplemental_inputs_sha256 !== liveBinding.supplemental_inputs_sha256) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_PLAN_SOURCE_CONTEXT_DIVERGED");
  }
  const testOnlyUnverifiedHostFixture = process.env.NODE_ENV === "test" &&
    sourceSnapshotContext.synthetic_supplement_for_tests === true &&
    sourceSnapshotContext.host_snapshot_protection?.mechanism ===
      "TEST_ONLY_UNVERIFIED_HOST_SNAPSHOT";
  if (sourceSnapshotContext.host_snapshot_protection_verified !== true &&
      !testOnlyUnverifiedHostFixture) {
    throw new Error("INDEPENDENT_REVIEW_HOST_SNAPSHOT_PROTECTION_UNVERIFIED");
  }
  if (hostContextReceipt !== undefined &&
      (!isRecord(hostContextReceipt) ||
       hostContextReceipt.source_snapshot_sha256 !== liveBinding.source_snapshot_sha256 ||
       hostContextReceipt.source_snapshot_manifest_sha256 !==
         liveBinding.source_snapshot_manifest_sha256 ||
       hostContextReceipt.source_snapshot_attestation_sha256 !==
         liveBinding.source_snapshot_attestation_sha256 ||
       hostContextReceipt.supplemental_inputs_sha256 !== liveBinding.supplemental_inputs_sha256 ||
       hostContextReceipt.supplemental_manifest_sha256 !==
         liveBinding.supplemental_manifest_sha256 ||
       hostContextReceipt.gate_run_id !== liveBinding.gate_run_id ||
       hostContextReceipt.live_challenge_sha256 !== liveBinding.live_challenge_sha256)) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_HOST_CONTEXT_RECEIPT_DIVERGED");
  }
  if (hostContextReceipt !== undefined &&
      (hostContextReceipt.host_snapshot_protection_sha256 !==
        sourceSnapshotContext.host_snapshot_protection?.sha256 ||
       hostContextReceipt.host_snapshot_protection_verified !==
        sourceSnapshotContext.host_snapshot_protection_verified ||
       hostContextReceipt.fixed_host_input_protection_sha256 !==
        sourceSnapshotContext.fixed_host_input_protection?.sha256 ||
       hostContextReceipt.fixed_host_input_protection_verified !==
        sourceSnapshotContext.fixed_host_input_protection?.verified ||
       hostContextReceipt.host_output_boundary_protection_sha256 !==
        sourceSnapshotContext.host_output_boundary_protection?.sha256)) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_HOST_SNAPSHOT_PROTECTION_RECEIPT_DIVERGED");
  }
  return true;
}

function assertLiveBinding(actual, expected, label) {
  if (!isRecord(actual) || !isRecord(expected) ||
      stableReviewStringify(actual) !== stableReviewStringify(expected)) {
    throw new Error(`${label}_LIVE_BINDING_INVALID`);
  }
}

function exactFields(value, fields, label) {
  if (!isRecord(value) || stableReviewStringify(Object.keys(value).sort()) !==
      stableReviewStringify([...fields].sort())) {
    throw new Error(`${label}: fields differ from the fixed schema`);
  }
}

function containedPath(base, relativePath, label) {
  if (!nonEmpty(relativePath) || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`${label}: unsafe path`);
  }
  const resolved = resolve(base, relativePath);
  const rel = relative(base, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label}: path escapes boundary`);
  }
  return resolved;
}

async function regularBytes(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}: regular non-symlink file required`);
  return readFile(path);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

function parseJsonLines(bytes, label) {
  const output = [];
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      output.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}: invalid JSONL at line ${index + 1}`);
    }
  }
  if (output.length === 0) throw new Error(`${label}: empty JSONL`);
  return output;
}

async function executableIdentity(path, repoRoot, allowedPaths) {
  const approved = new Set((allowedPaths ?? APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS)
    .map((candidate) => resolve(candidate)));
  if (!isAbsolute(path) || !approved.has(resolve(path)) || await realpath(path) !== resolve(path)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_NOT_APPROVED");
  }
  return regularBytes(path, "INDEPENDENT_REVIEW_SHARD_CODEX");
}

async function captureProcess(executable, args, cwd, label, { allowStderr = false } = {}) {
  const child = spawn(executable, args, {
    cwd,
    env: createIndependentReviewSanitizedEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let size = 0;
  let overflow = false;
  const collect = (target) => (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const outcome = await new Promise((accept) => {
    child.once("error", (error) => accept({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => accept({ code, signal, error: null }));
  });
  clearTimeout(timeout);
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  if (overflow || outcome.code !== 0 || (!allowStderr && stderrBytes.length > 64 * 1024)) {
    throw new Error(`${label}:${outcome.code ?? outcome.signal ?? outcome.error ?? "invalid-output"}`);
  }
  return { stdout: stdoutBytes, stderr: stderrBytes };
}

async function codexVersion(path, cwd) {
  const run = await captureProcess(path, ["--version"], cwd,
    "INDEPENDENT_REVIEW_SHARD_CODEX_VERSION_FAILED");
  const version = run.stdout.toString("utf8").trim();
  if (!version) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_VERSION_INVALID");
  }
  return version;
}

async function codexPlatformSignature(path, cwd) {
  await captureProcess("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", path], cwd,
    "INDEPENDENT_REVIEW_SHARD_CODEX_SIGNATURE_VERIFY_FAILED", { allowStderr: true });
  const display = await captureProcess(
    "/usr/bin/codesign", ["-dvvv", "--requirements", "-", path], cwd,
    "INDEPENDENT_REVIEW_SHARD_CODEX_SIGNATURE_READ_FAILED", { allowStderr: true },
  );
  const text = Buffer.concat([display.stdout, display.stderr]).toString("utf8");
  const identifier = /^Identifier=(\S+)$/mu.exec(text)?.[1];
  const teamIdentifier = /^TeamIdentifier=(\S+)$/mu.exec(text)?.[1];
  const cdhash = /^CDHash=([a-f0-9]{40})$/mu.exec(text)?.[1];
  const designatedRequirement = /^designated => (.+)$/mu.exec(text)?.[1]?.trim();
  if (identifier !== INDEPENDENT_REVIEW_CODEX_IDENTIFIER ||
      teamIdentifier !== INDEPENDENT_REVIEW_CODEX_TEAM_ID || !cdhash || !designatedRequirement ||
      !designatedRequirement.includes("identifier codex") ||
      !designatedRequirement.includes(`subject.OU] = \"${INDEPENDENT_REVIEW_CODEX_TEAM_ID}\"`)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_SIGNATURE_IDENTITY_INVALID");
  }
  return {
    identifier,
    team_identifier: teamIdentifier,
    cdhash,
    designated_requirement: designatedRequirement,
  };
}

export async function inspectIndependentReviewCodexIdentity({
  codexPath,
  repoRoot,
  approvedExecutableSha256,
  allowedCodexExecutablePaths,
  verifyPlatformIdentity = true,
}) {
  const bytes = await executableIdentity(codexPath, repoRoot, allowedCodexExecutablePaths);
  const executableSha256 = reviewSha256(bytes);
  if (!sha(approvedExecutableSha256) || executableSha256 !== approvedExecutableSha256) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_APPROVED_DIGEST_DIVERGED");
  }
  return {
    executable_path: resolve(codexPath),
    executable_sha256: executableSha256,
    approved_executable_sha256: approvedExecutableSha256,
    version: await codexVersion(codexPath, repoRoot),
    platform_signature: verifyPlatformIdentity
      ? await codexPlatformSignature(codexPath, repoRoot)
      : null,
    model: INDEPENDENT_REVIEW_MODEL,
    reasoning_effort: INDEPENDENT_REVIEW_REASONING_EFFORT,
    host_context_token_limit: INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT,
    environment_policy_sha256: independentReviewEnvironmentPolicy().sha256,
  };
}

function commandMatches(actual, expected) {
  return actual === expected;
}

function expectedEvidence(shard, reviewInputs) {
  return shard.content_selections.map((selection) => ({
    path: `${selection.path}#bytes=${selection.start_offset_bytes}-${selection.end_offset_bytes}` +
      `;semantic=${selection.semantic_unit_id};role=${selection.role}`,
    sha256: selection.sha256,
  }));
}

export function buildIndependentReviewShardPrompt({
  implementationExecutionId,
  sourceFingerprint,
  plan,
  shard,
  claim,
  reviewerRole,
  inspectionCommands,
  probeCommands,
  evidenceChecked,
  liveBinding,
}) {
  return `You are an independent local release reviewer in a separate read-only Codex execution.\n\n` +
    `Never edit, stage, commit, push, deploy, publish, call external services, use web/browser/MCP/apps/plugins, or delegate. ` +
    `Run only the exact commands listed below. Existing PASS/CLOSED prose is not evidence.\n\n` +
    `Frozen identity:\n` +
    `implementation_execution_id=${implementationExecutionId}\n` +
    `source_fingerprint=${sourceFingerprint}\n` +
    `review_subject_sha256=${plan.review_subject_sha256}\n` +
    `review_inputs_sha256=${plan.review_inputs_sha256}\n` +
    `plan_sha256=${plan.plan_sha256}\n` +
    (liveBinding
      ? `gate_run_id=${liveBinding.gate_run_id}\nlive_challenge_sha256=${liveBinding.live_challenge_sha256}\n` +
        `source_snapshot_sha256=${liveBinding.source_snapshot_sha256}\n` +
        `supplemental_inputs_sha256=${liveBinding.supplemental_inputs_sha256}\n` +
        `approved_review_runtime_sha256=${liveBinding.approved_review_runtime_sha256}\n`
      : "") +
    `requirement_id=${shard.requirement_id}\nclaim_id=${shard.claim_id}\nshard_id=${shard.shard_id}\n` +
    `reviewer_role=${reviewerRole}\nclaim_control=${JSON.stringify(claim.control)}\n\n` +
    `Run every content command exactly once, in order, and inspect every emitted byte:\n` +
    inspectionCommands.map((command, index) => `${index + 1}. ${command}`).join("\n") + "\n\n" +
    `Then run every fixed atomic mutation command exactly once, in order. The controller chose no mutation: ` +
    `each target, anchor, operator, literal, test and expected failing assertion comes from the host-bound control obligation:\n` +
    (probeCommands.length > 0
      ? probeCommands.map((command, index) => `${index + 1}. ${command}`).join("\n")
      : "(no probe is assigned to this peripheral edge-cover shard)") + "\n\n" +
    `Review the correct MCP layer, provider-neutrality, durable state, concurrency/recovery, actual test evidence, ` +
    `and a concrete adversarial counterexample. Return only JSON conforming to the supplied schema. ` +
    `Echo every frozen identity. evidence_checked must exactly equal ${JSON.stringify(evidenceChecked)}. ` +
    `dependency_edges_checked must exactly equal ${JSON.stringify(shard.dependency_edges.map(({ importer, dependency }) => ({ importer, dependency })))}. ` +
    `probe_obligations_checked must exactly equal ${JSON.stringify(shard.probe_obligation_ids)}. ` +
    `Mark CLOSED only if the entire atomic claim shard is correctly enforced and no P0/P1 remains; otherwise REOPEN.`;
}

export function validateIndependentReviewShardVerdict(verdict, context) {
  exactFields(verdict, [
    "schema_version", "implementation_execution_id", "source_fingerprint",
    "review_subject_sha256", "review_inputs_sha256", "plan_sha256", "requirement_id",
    "claim_id", "shard_id", "reviewer_role", "decision", "evidence_checked",
    "dependency_edges_checked", "probe_obligations_checked", "review_axes", "rationale",
    "residual_risk",
  ], "INDEPENDENT_REVIEW_SHARD_VERDICT");
  if (verdict.schema_version !== "2.0" ||
      verdict.implementation_execution_id !== context.implementationExecutionId ||
      verdict.source_fingerprint !== context.sourceFingerprint ||
      verdict.review_subject_sha256 !== context.plan.review_subject_sha256 ||
      verdict.review_inputs_sha256 !== context.plan.review_inputs_sha256 ||
      verdict.plan_sha256 !== context.plan.plan_sha256 ||
      verdict.requirement_id !== context.shard.requirement_id ||
      verdict.claim_id !== context.shard.claim_id || verdict.shard_id !== context.shard.shard_id ||
      verdict.reviewer_role !== context.reviewerRole || !["CLOSED", "REOPEN"].includes(verdict.decision)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_VERDICT_IDENTITY_INVALID");
  }
  if (stableReviewStringify(verdict.evidence_checked) !== stableReviewStringify(context.evidenceChecked) ||
      stableReviewStringify(verdict.dependency_edges_checked) !==
        stableReviewStringify(context.shard.dependency_edges.map(({ importer, dependency }) => ({ importer, dependency }))) ||
      stableReviewStringify(verdict.probe_obligations_checked) !==
        stableReviewStringify(context.shard.probe_obligation_ids)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_VERDICT_COVERAGE_INVALID");
  }
  exactFields(verdict.review_axes, REVIEW_AXIS_FIELDS, "INDEPENDENT_REVIEW_SHARD_VERDICT.review_axes");
  if ([...REVIEW_AXIS_FIELDS, "rationale", "residual_risk"].some((field) =>
    field in verdict.review_axes ? !nonEmpty(verdict.review_axes[field]) : !nonEmpty(verdict[field]))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_VERDICT_PROSE_INCOMPLETE");
  }
  return verdict;
}

function reviewerExecution(events, reviewerProcessId) {
  const threads = events.filter((event) => event?.type === "thread.started");
  const completed = events.filter((event) => event?.type === "turn.completed");
  if (threads.length !== 1 || !nonEmpty(threads[0]?.thread_id) || completed.length !== 1 ||
      !Number.isInteger(completed[0]?.usage?.input_tokens) || completed[0].usage.input_tokens <= 1 ||
      !Number.isInteger(completed[0]?.usage?.output_tokens) || completed[0].usage.output_tokens <= 1) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RAW_EXECUTION_INVALID");
  }
  return `codex-thread:${threads[0].thread_id}:pid:${reviewerProcessId}`;
}

export async function verifyIndependentReviewShardArtifact({
  document,
  documentPath,
  requirementId,
  claimId,
  shardId,
  artifactPath,
  expectedArtifactSha256,
  expectedSourceFingerprint,
  repoRoot,
  allowedCodexExecutablePaths,
  expectedLiveReviewContext,
  verifyCodexPlatformIdentity = true,
  sourceSnapshotContext,
  hostContextReceipt,
  liveContextPath,
}) {
  const summaryBytes = await regularBytes(artifactPath, "INDEPENDENT_REVIEW_SHARD_ARTIFACT");
  if (reviewSha256(summaryBytes) !== expectedArtifactSha256) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_ARTIFACT_HASH_DIVERGED");
  }
  const summary = parseJson(summaryBytes, "INDEPENDENT_REVIEW_SHARD_ARTIFACT");
  const expectedLiveBinding = expectedLiveReviewContext
    ? normalizeIndependentReviewLiveContext(expectedLiveReviewContext)
    : null;
  if (expectedLiveBinding && (!nonEmpty(liveContextPath) || !isAbsolute(liveContextPath))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_LIVE_CONTEXT_PATH_REQUIRED");
  }
  exactFields(summary, expectedLiveBinding ? LIVE_SUMMARY_FIELDS : SUMMARY_FIELDS,
    "INDEPENDENT_REVIEW_SHARD_ARTIFACT");
  const plan = await deriveIndependentReviewPlan({
    document, requirementId, repoRoot, documentPath, sourceSnapshotContext,
  });
  if (expectedLiveBinding) {
    assertIndependentReviewLivePlanBinding({
      plan, liveBinding: expectedLiveBinding, sourceSnapshotContext, hostContextReceipt,
    });
  }
  const shard = plan.shards.find((item) => item.claim_id === claimId && item.shard_id === shardId);
  const requirement = document.requirements.find((item) => item.requirement_id === requirementId);
  const claim = ["GLOBAL_PERIPHERAL_COVERAGE", "DOCUMENT_GLOBAL_PERIPHERAL_COVERAGE"]
    .includes(shard?.scope_kind)
    ? {
        claim_id: claimId,
        control: "Mechanically assigned release-critical peripheral paths and dependency edges are reviewed bottom-up.",
        probe_obligations: [],
      }
    : requirement?.control_claims?.find((item) => item.claim_id === claimId);
  if (!shard || !claim || summary.schema_version !== (expectedLiveBinding ? "3.0" : "2.0") ||
      summary.evidence_boundary !== "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW" ||
      summary.source_fingerprint !== expectedSourceFingerprint ||
      summary.review_subject_sha256 !== plan.review_subject_sha256 ||
      summary.review_inputs_sha256 !== plan.review_inputs_sha256 ||
      summary.plan_sha256 !== plan.plan_sha256 || summary.requirement_id !== requirementId ||
      summary.claim_id !== claimId || summary.shard_id !== shardId ||
      !["CLOSED", "REOPEN"].includes(summary.decision)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_ARTIFACT_IDENTITY_INVALID");
  }
  if (expectedLiveBinding) {
    assertLiveBinding(summary.live_binding, expectedLiveBinding, "INDEPENDENT_REVIEW_SHARD_ARTIFACT");
  }
  exactFields(summary.generator,
    ["kind", "command", "version", "executable_path", "executable_sha256"],
    "INDEPENDENT_REVIEW_SHARD_GENERATOR");
  const generatorPath = containedPath(repoRoot, summary.generator.executable_path,
    "INDEPENDENT_REVIEW_SHARD_GENERATOR");
  if (summary.generator.kind !== "INDEPENDENT_ATOMIC_CLAIM_SHARD_REVIEW" ||
      summary.generator.version !== "4.0.0" ||
      summary.generator.command !== `node ${summary.generator.executable_path}` ||
      reviewSha256(await regularBytes(generatorPath, "INDEPENDENT_REVIEW_SHARD_GENERATOR")) !==
        summary.generator.executable_sha256) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_GENERATOR_INVALID");
  }
  if (!Array.isArray(summary.raw_artifacts) || summary.raw_artifacts.length !== RAW_ARTIFACT_TYPES.length) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT_SET_INVALID");
  }
  const raw = new Map();
  const rawPaths = new Map();
  for (const artifact of summary.raw_artifacts) {
    exactFields(artifact, ["artifact_type", "path", "sha256", "size_bytes"],
      "INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT");
    if (!RAW_ARTIFACT_TYPES.includes(artifact.artifact_type) || raw.has(artifact.artifact_type) ||
        !sha(artifact.sha256) || !Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 1) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT_INVALID");
    }
    const path = containedPath(dirname(artifactPath), artifact.path, "INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT");
    const bytes = await regularBytes(path, "INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT");
    if (bytes.length !== artifact.size_bytes || reviewSha256(bytes) !== artifact.sha256) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_RAW_ARTIFACT_STALE");
    }
    raw.set(artifact.artifact_type, bytes);
    rawPaths.set(artifact.artifact_type, path);
  }
  const invocation = parseJson(raw.get("INVOCATION"), "INDEPENDENT_REVIEW_SHARD_INVOCATION");
  exactFields(invocation, [
    "schema_version", "evidence_boundary", "started_at", "finished_at", "exit_code",
    "controller_process_id", "reviewer_process_id", "implementation_execution_id",
    "traceability_path", "requirement_id", "claim_id", "shard_id", "source_fingerprint_before",
    "source_fingerprint_after", "review_subject_sha256", "review_inputs_sha256", "plan_sha256",
    "inspection_nonce", "inspection_commands", "probe_nonces", "probe_commands", "prompt",
    "prompt_sha256", "output_schema", "codex",
    ...(expectedLiveBinding ? ["live_binding"] : []),
  ], "INDEPENDENT_REVIEW_SHARD_INVOCATION");
  if (invocation.schema_version !== (expectedLiveBinding ? "3.0" : "2.0") || invocation.exit_code !== 0 ||
      invocation.evidence_boundary !== "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW" ||
      invocation.requirement_id !== requirementId || invocation.claim_id !== claimId ||
      invocation.shard_id !== shardId || invocation.source_fingerprint_before?.sha256 !== expectedSourceFingerprint ||
      stableReviewStringify(invocation.source_fingerprint_before) !==
        stableReviewStringify(invocation.source_fingerprint_after) ||
      invocation.review_subject_sha256 !== plan.review_subject_sha256 ||
      invocation.review_inputs_sha256 !== plan.review_inputs_sha256 ||
      invocation.plan_sha256 !== plan.plan_sha256 ||
      invocation.implementation_execution_id !== summary.implementation_execution_id ||
      invocation.controller_process_id === invocation.reviewer_process_id) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_INVOCATION_IDENTITY_INVALID");
  }
  if (expectedLiveBinding) {
    assertLiveBinding(invocation.live_binding, expectedLiveBinding, "INDEPENDENT_REVIEW_SHARD_INVOCATION");
  }
  const traceabilityPath = relative(repoRoot, resolve(documentPath));
  const { receipt } = await createIndependentReviewShardReceipt({
    document, requirementId, claimId, shardId, repoRoot, documentPath,
    sourceFingerprint: expectedSourceFingerprint, nonce: invocation.inspection_nonce,
    sourceSnapshotContext,
  });
  const expectedInspectionCommands = buildIndependentReviewShardInspectionCommands({
    traceabilityPath, nonce: invocation.inspection_nonce, requirementId, claimId, shardId,
    chunkCount: receipt.content_chunk_count,
    liveContextPath: expectedLiveBinding ? liveContextPath : undefined,
  });
  if (stableReviewStringify(invocation.inspection_commands) !== stableReviewStringify(expectedInspectionCommands)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_INSPECTION_PLAN_INVALID");
  }
  if (!Array.isArray(invocation.probe_nonces) || invocation.probe_nonces.length !==
      shard.probe_obligation_ids.length) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_PROBE_NONCES_INVALID");
  }
  const nonces = new Set();
  const expectedProbeCommands = shard.probe_obligation_ids.map((obligationId, index) => {
    const item = invocation.probe_nonces[index];
    if (item?.obligation_id !== obligationId || !/^[a-f0-9]{32}$/u.test(item?.probe_nonce ?? "") ||
        item.probe_nonce === invocation.inspection_nonce || nonces.has(item.probe_nonce)) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_PROBE_NONCES_INVALID");
    }
    nonces.add(item.probe_nonce);
    return buildIndependentReviewObligationProbeCommand({
      traceabilityPath, inspectionNonce: invocation.inspection_nonce, requirementId, claimId,
      obligationId, probeNonce: item.probe_nonce,
      liveContextPath: expectedLiveBinding ? liveContextPath : undefined,
    });
  });
  if (stableReviewStringify(invocation.probe_commands) !== stableReviewStringify(expectedProbeCommands)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_PROBE_COMMANDS_INVALID");
  }
  const reviewInputs = await fingerprintIndependentReviewInputs({
    document, requirementIds: [requirementId], repoRoot, documentPath, sourceSnapshotContext,
  });
  const evidenceChecked = expectedEvidence(shard, reviewInputs);
  const expectedPrompt = buildIndependentReviewShardPrompt({
    implementationExecutionId: invocation.implementation_execution_id,
    sourceFingerprint: expectedSourceFingerprint, plan, shard, claim,
    reviewerRole: requirement.reviewer, inspectionCommands: expectedInspectionCommands,
    probeCommands: expectedProbeCommands, evidenceChecked, liveBinding: expectedLiveBinding,
  });
  if (invocation.prompt !== expectedPrompt || invocation.prompt_sha256 !== reviewSha256(expectedPrompt)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_PROMPT_INVALID");
  }
  exactFields(invocation.output_schema, ["path", "sha256"], "INDEPENDENT_REVIEW_SHARD_OUTPUT_SCHEMA");
  const outputSchemaPath = containedPath(repoRoot, invocation.output_schema.path,
    "INDEPENDENT_REVIEW_SHARD_OUTPUT_SCHEMA");
  if (reviewSha256(await regularBytes(outputSchemaPath, "INDEPENDENT_REVIEW_SHARD_OUTPUT_SCHEMA")) !==
      invocation.output_schema.sha256) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_OUTPUT_SCHEMA_STALE");
  }
  const expectedCodexFields = expectedLiveBinding
    ? [
        "executable_path", "executable_sha256", "approved_executable_sha256", "version",
        "platform_signature", "model", "reasoning_effort", "host_context_token_limit",
        "environment_policy_sha256", "command",
      ]
    : ["executable_path", "executable_sha256", "version", "command"];
  exactFields(invocation.codex, expectedCodexFields, "INDEPENDENT_REVIEW_SHARD_CODEX");
  const codexIdentity = expectedLiveBinding
    ? await inspectIndependentReviewCodexIdentity({
        codexPath: invocation.codex.executable_path,
        repoRoot,
        approvedExecutableSha256: expectedLiveBinding.approved_review_codex_sha256,
        allowedCodexExecutablePaths,
        verifyPlatformIdentity: verifyCodexPlatformIdentity,
      })
    : null;
  const codexBytes = expectedLiveBinding ? null : await executableIdentity(
    invocation.codex.executable_path, repoRoot, allowedCodexExecutablePaths,
  );
  const recordedCodexIdentity = expectedLiveBinding
    ? Object.fromEntries(Object.entries(invocation.codex).filter(([key]) => key !== "command"))
    : null;
  if ((expectedLiveBinding
        ? stableReviewStringify(recordedCodexIdentity) !== stableReviewStringify(codexIdentity)
        : reviewSha256(codexBytes) !== invocation.codex.executable_sha256 ||
          await codexVersion(invocation.codex.executable_path, repoRoot) !== invocation.codex.version) ||
      stableReviewStringify(invocation.codex.command) !== stableReviewStringify(buildIndependentReviewCodexCommand({
        codexPath: invocation.codex.executable_path,
        repoRoot,
        outputSchemaPath,
        finalVerdictPath: rawPaths.get("FINAL_VERDICT"),
      }))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_IDENTITY_INVALID");
  }
  const events = parseJsonLines(raw.get("CODEX_EVENTS_JSONL"), "INDEPENDENT_REVIEW_SHARD_EVENTS");
  if (events.some((event) => ["file_change", "mcp_tool_call", "computer_tool_call", "web_search",
    "file_search", "image_generation", "dynamic_tool_call", "collab_agent_tool_call"]
    .includes(event?.item?.type))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_FORBIDDEN_TOOL_EVENT");
  }
  const commandEvents = events.filter((event) => event?.item?.type === "command_execution");
  if (events.some((event) => event?.type === "turn.failed") || commandEvents.some((event) =>
    event?.type !== "item.completed" || event.item?.status !== "completed" ||
      event.item?.exit_code !== 0 || !nonEmpty(event.item?.command))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RAW_COMMAND_FAILED");
  }
  const reviewerExecutionId = reviewerExecution(events, invocation.reviewer_process_id);
  if (reviewerExecutionId !== summary.reviewer_execution_id ||
      reviewerExecutionId === summary.implementation_execution_id) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_REVIEWER_IDENTITY_INVALID");
  }
  const commands = events.filter((event) => event?.item?.type === "command_execution" &&
    event.item?.status === "completed" && event.item?.exit_code === 0 && nonEmpty(event.item.command));
  if (commands.length !== expectedInspectionCommands.length + expectedProbeCommands.length) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_COMMAND_SET_INVALID");
  }
  let priorIndex = -1;
  for (const [index, command] of expectedInspectionCommands.entries()) {
    const matches = commands.filter((event) => commandMatches(event.item.command, command));
    if (matches.length !== 1 || events.indexOf(matches[0]) <= priorIndex) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_INSPECTION_EVENT_INVALID");
    }
    priorIndex = events.indexOf(matches[0]);
    const actual = parseJson(Buffer.from(matches[0].item.aggregated_output ?? ""),
      "INDEPENDENT_REVIEW_SHARD_INSPECTION_OUTPUT");
    if (stableReviewStringify(actual) !==
        stableReviewStringify(createIndependentReviewShardChunkReceipt(receipt, index))) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_INSPECTION_OUTPUT_DIVERGED");
    }
  }
  const probeReceipts = [];
  for (const [index, command] of expectedProbeCommands.entries()) {
    const matches = commands.filter((event) => commandMatches(event.item.command, command));
    if (matches.length !== 1 || events.indexOf(matches[0]) <= priorIndex) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_PROBE_EVENT_INVALID");
    }
    priorIndex = events.indexOf(matches[0]);
    const expected = await createIndependentReviewObligationProbeReceipt({
      document, requirementId, claimId, obligationId: shard.probe_obligation_ids[index],
      repoRoot, documentPath, sourceFingerprint: expectedSourceFingerprint,
      inspectionNonce: invocation.inspection_nonce,
      probeNonce: invocation.probe_nonces[index].probe_nonce,
      sourceSnapshotContext,
      approvedReviewRuntimeSha256: expectedLiveBinding?.approved_review_runtime_sha256,
    });
    const actual = parseJson(Buffer.from(matches[0].item.aggregated_output ?? ""),
      "INDEPENDENT_REVIEW_SHARD_PROBE_OUTPUT");
    if (stableReviewStringify(actual) !== stableReviewStringify(expected)) {
      throw new Error("INDEPENDENT_REVIEW_SHARD_PROBE_OUTPUT_DIVERGED");
    }
    probeReceipts.push(expected);
  }
  if (commands.some((event) => ![...expectedInspectionCommands, ...expectedProbeCommands]
    .some((command) => commandMatches(event.item.command, command)))) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_UNEXPECTED_COMMAND");
  }
  const finalVerdict = parseJson(raw.get("FINAL_VERDICT"), "INDEPENDENT_REVIEW_SHARD_FINAL_VERDICT");
  validateIndependentReviewShardVerdict(finalVerdict, {
    implementationExecutionId: invocation.implementation_execution_id,
    sourceFingerprint: expectedSourceFingerprint, plan, shard, reviewerRole: requirement.reviewer,
    evidenceChecked,
  });
  const messages = events.filter((event) => event?.item?.type === "agent_message");
  if (messages.length === 0 || stableReviewStringify(parseJson(
    Buffer.from(messages.at(-1)?.item?.text ?? ""), "INDEPENDENT_REVIEW_SHARD_FINAL_MESSAGE",
  )) !== stableReviewStringify(finalVerdict) || events.indexOf(messages.at(-1)) <= priorIndex) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_FINAL_MESSAGE_INVALID");
  }
  if (summary.decision !== finalVerdict.decision) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_DECISION_DIVERGED");
  }
  return {
    summary,
    finalVerdict,
    plan,
    shard,
    reviewInputs,
    reviewerExecutionId,
    implementationExecutionId: invocation.implementation_execution_id,
    inspectionNonce: invocation.inspection_nonce,
    probeNonces: invocation.probe_nonces.map((item) => item.probe_nonce),
    probeReceipts,
  };
}

export async function verifyIndependentReviewAggregateClosure({
  document,
  requirement,
  closure,
  reviewArtifactPath,
  expectedReviewArtifactSha256,
  expectedSourceFingerprint,
  repoRoot,
  documentPath,
  allowedCodexExecutablePaths,
  reviewTestExecutor,
  reviewExecutionReceipts,
  expectedLiveReviewContext,
  approvedReviewRuntimeSha256,
  sourceSnapshotContext,
  hostContextReceipt,
  liveContextPath,
  verifyCodexPlatformIdentity = true,
}) {
  const bytes = await regularBytes(reviewArtifactPath, "INDEPENDENT_REVIEW_AGGREGATE");
  if (reviewSha256(bytes) !== expectedReviewArtifactSha256) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_HASH_DIVERGED");
  }
  const aggregate = parseJson(bytes, "INDEPENDENT_REVIEW_AGGREGATE");
  const expectedLiveBinding = expectedLiveReviewContext
    ? normalizeIndependentReviewLiveContext(expectedLiveReviewContext)
    : null;
  if (expectedLiveBinding && (!nonEmpty(liveContextPath) || !isAbsolute(liveContextPath))) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_LIVE_CONTEXT_PATH_REQUIRED");
  }
  exactFields(aggregate, [
    "schema_version", "evidence_boundary", "captured_at", "source_fingerprint",
    "review_subject_sha256", "review_inputs_sha256", "plan_sha256", "requirement_id",
    "implementation_execution_id", "reviewer_execution_id", "decision", "shards",
    ...(expectedLiveBinding ? ["live_binding"] : []),
  ], "INDEPENDENT_REVIEW_AGGREGATE");
  const plan = await deriveIndependentReviewPlan({
    document, requirementId: requirement.requirement_id, repoRoot, documentPath, sourceSnapshotContext,
  });
  if (expectedLiveBinding) {
    assertIndependentReviewLivePlanBinding({
      plan, liveBinding: expectedLiveBinding, sourceSnapshotContext, hostContextReceipt,
    });
  }
  if (aggregate.schema_version !== (expectedLiveBinding ? "3.0" : "2.0") ||
      aggregate.evidence_boundary !== "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_AGGREGATE" ||
      aggregate.source_fingerprint !== expectedSourceFingerprint ||
      aggregate.review_subject_sha256 !== plan.review_subject_sha256 ||
      aggregate.review_inputs_sha256 !== plan.review_inputs_sha256 ||
      aggregate.plan_sha256 !== plan.plan_sha256 || aggregate.requirement_id !== requirement.requirement_id ||
      aggregate.decision !== "CLOSED" || closure.decision !== "CLOSED" ||
      closure.source_fingerprint !== expectedSourceFingerprint ||
      closure.review_subject_sha256 !== plan.review_subject_sha256 ||
      closure.review_inputs_sha256 !== plan.review_inputs_sha256 ||
      closure.implementation_execution_id !== aggregate.implementation_execution_id ||
      closure.reviewer_execution_id !== aggregate.reviewer_execution_id ||
      closure.reviewed_at !== aggregate.captured_at) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_IDENTITY_INVALID");
  }
  if (expectedLiveBinding) {
    assertLiveBinding(aggregate.live_binding, expectedLiveBinding, "INDEPENDENT_REVIEW_AGGREGATE");
    if (approvedReviewRuntimeSha256 !== expectedLiveBinding.approved_review_runtime_sha256) {
      throw new Error("INDEPENDENT_REVIEW_AGGREGATE_APPROVED_RUNTIME_DIVERGED");
    }
  }
  const expectedTuples = plan.shards.map((shard) => `${shard.claim_id}:${shard.shard_id}`).sort();
  if (!Array.isArray(aggregate.shards) || stableReviewStringify(aggregate.shards.map((item) =>
    `${item?.claim_id}:${item?.shard_id}`).sort()) !== stableReviewStringify(expectedTuples)) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_SHARD_COVERAGE_INVALID");
  }
  const artifactPaths = new Set();
  const artifactHashes = new Set();
  const implementationIds = new Set();
  const reviewerIds = new Set();
  const inspectionNonces = new Set();
  const probeNonces = new Set();
  const verified = [];
  for (const item of aggregate.shards) {
    exactFields(item, ["claim_id", "shard_id", "artifact", "sha256"],
      "INDEPENDENT_REVIEW_AGGREGATE_SHARD");
    if (artifactPaths.has(item.artifact) || artifactHashes.has(item.sha256)) {
      throw new Error("INDEPENDENT_REVIEW_AGGREGATE_DUPLICATE_ARTIFACT");
    }
    artifactPaths.add(item.artifact);
    artifactHashes.add(item.sha256);
    const artifactPath = containedPath(dirname(reviewArtifactPath), item.artifact,
      "INDEPENDENT_REVIEW_AGGREGATE_SHARD");
    const result = await verifyIndependentReviewShardArtifact({
      document, documentPath, requirementId: requirement.requirement_id,
      claimId: item.claim_id, shardId: item.shard_id, artifactPath,
      expectedArtifactSha256: item.sha256, expectedSourceFingerprint, repoRoot,
      allowedCodexExecutablePaths,
      expectedLiveReviewContext,
      sourceSnapshotContext,
      hostContextReceipt,
      liveContextPath,
      verifyCodexPlatformIdentity,
    });
    if (result.summary.decision !== "CLOSED") {
      throw new Error("INDEPENDENT_REVIEW_AGGREGATE_REOPENED_SHARD");
    }
    for (const [value, set, label] of [
      [result.implementationExecutionId, implementationIds, "IMPLEMENTATION_EXECUTION"],
      [result.reviewerExecutionId, reviewerIds, "REVIEWER_EXECUTION"],
      [result.inspectionNonce, inspectionNonces, "INSPECTION_NONCE"],
    ]) {
      if (set.has(value)) throw new Error(`INDEPENDENT_REVIEW_AGGREGATE_DUPLICATE_${label}`);
      set.add(value);
    }
    for (const nonce of result.probeNonces) {
      if (probeNonces.has(nonce)) throw new Error("INDEPENDENT_REVIEW_AGGREGATE_DUPLICATE_PROBE_NONCE");
      probeNonces.add(nonce);
    }
    verified.push(result);
  }
  const derivedImplementationId = `atomic-review-controllers:${reviewSha256(stableReviewStringify(
    [...implementationIds].sort(),
  ))}`;
  const derivedReviewerId = `atomic-reviewers:${reviewSha256(stableReviewStringify(
    [...reviewerIds].sort(),
  ))}`;
  if (aggregate.implementation_execution_id !== derivedImplementationId ||
      aggregate.reviewer_execution_id !== derivedReviewerId || derivedImplementationId === derivedReviewerId) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_EXECUTION_IDENTITY_INVALID");
  }
  const coveredPaths = [...new Set(verified.flatMap((item) => item.shard.paths))].sort();
  const coveredEdges = [...new Set(verified.flatMap((item) =>
    item.shard.dependency_edges.map((edge) => edge.id)))].sort();
  const coveredObligations = [...new Set(verified.flatMap((item) =>
    item.shard.probe_obligation_ids))].sort();
  const ownedDependencyEdges = verified.flatMap((item) => item.shard.owned_dependency_edge_ids);
  const uniqueOwnedDependencyEdges = [...new Set(ownedDependencyEdges)].sort();
  const ownedContentUnits = verified.flatMap((item) => item.shard.owned_content_unit_ids);
  const ownedTransportChunks = verified.flatMap((item) => item.shard.owned_transport_chunk_ids);
  const coveredContentUnits = [...new Set(ownedContentUnits)].sort();
  const coveredTransportChunks = [...new Set(ownedTransportChunks)].sort();
  if (stableReviewStringify(coveredPaths) !== stableReviewStringify(plan.expected_paths) ||
      stableReviewStringify(coveredEdges) !== stableReviewStringify(plan.expected_dependency_edges) ||
      stableReviewStringify(coveredObligations) !== stableReviewStringify(plan.expected_probe_obligations) ||
      ownedDependencyEdges.length !== uniqueOwnedDependencyEdges.length ||
      stableReviewStringify(uniqueOwnedDependencyEdges) !==
        stableReviewStringify(plan.expected_owned_dependency_edge_ids) ||
      ownedContentUnits.length !== coveredContentUnits.length ||
      ownedTransportChunks.length !== coveredTransportChunks.length ||
      stableReviewStringify(coveredContentUnits) !==
        stableReviewStringify(plan.expected_owned_content_unit_ids) ||
      stableReviewStringify(coveredTransportChunks) !==
        stableReviewStringify(plan.expected_owned_transport_chunk_ids)) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_EXACT_UNION_INVALID");
  }
  const testReceipts = await runIndependentReviewTestPlan({
    document, requirementIds: [requirement.requirement_id], repoRoot,
    documentPath,
    executor: reviewTestExecutor, sourceFingerprint: expectedSourceFingerprint,
    reviewSubjectSha256: plan.review_subject_sha256,
    reviewInputsSha256: plan.review_inputs_sha256,
    approvedReviewRuntimeSha256,
    sourceSnapshotContext,
  });
  if (Array.isArray(reviewExecutionReceipts)) reviewExecutionReceipts.push(...testReceipts);
  return {
    reviewerExecutionId: aggregate.reviewer_execution_id,
    finalVerdict: aggregate,
    record: { requirement_id: requirement.requirement_id, decision: "CLOSED" },
    testExecutionReceipts: testReceipts,
    plan,
    reviewInputs: verified[0]?.reviewInputs ?? await fingerprintIndependentReviewInputs({
      document, requirementIds: [requirement.requirement_id], repoRoot, documentPath, sourceSnapshotContext,
    }),
  };
}
