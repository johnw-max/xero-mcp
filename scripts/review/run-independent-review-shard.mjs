#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS,
  assertIndependentReviewExecutionRuntimeUnchanged,
  assertIndependentReviewSourceSnapshotUnchanged,
  buildIndependentReviewCodexCommand,
  buildIndependentReviewObligationProbeCommand,
  createIndependentReviewSanitizedEnvironment,
  loadIndependentReviewLiveSourceSnapshotContext,
  reviewSha256,
} from "./independent-review-evidence-lib.mjs";
import {
  buildIndependentReviewShardInspectionCommands,
  createIndependentReviewShardReceipt,
  deriveIndependentReviewPlan,
} from "./independent-review-plan-lib.mjs";
import {
  assertIndependentReviewLivePlanBinding,
  buildIndependentReviewShardPrompt,
  inspectIndependentReviewCodexIdentity,
  normalizeIndependentReviewLiveContext,
  validateIndependentReviewShardVerdict,
  verifyIndependentReviewShardArtifact,
} from "./independent-review-shard-evidence-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = await realpath(resolve(dirname(scriptPath), "../.."));
const defaultTraceabilityPath = resolve(
  repoRoot,
  "artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json",
);
const outputSchemaPath = resolve(repoRoot, "schemas/independent-review-shard-verdict.schema.json");
const generatorVersion = "4.0.0";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Every independent shard option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = ["--evidence", "--requirement", "--claim", "--shard", "--live-context"];
  const allowed = new Set([...expected, "--file"]);
  if (expected.some((name) => !values.has(name)) || [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("--evidence, --requirement, --claim, --shard and --live-context are required; --file is optional");
  }
  return {
    documentPath: values.has("--file") ? resolve(values.get("--file")) : defaultTraceabilityPath,
    evidencePath: resolve(values.get("--evidence")),
    requirementId: values.get("--requirement"),
    claimId: values.get("--claim"),
    shardId: values.get("--shard"),
    liveContextPath: resolve(values.get("--live-context")),
  };
}

function assertContained(base, path, label) {
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label}_MUST_BE_INSIDE_BOUNDARY`);
  }
  return rel;
}

function assertReviewOutputPath(outputRoot, outputPath, label) {
  assertContained(outputRoot, outputPath, label);
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertAbsent(path) {
  try {
    await access(path);
    throw new Error(`INDEPENDENT_REVIEW_SHARD_OUTPUT_ALREADY_EXISTS:${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("INDEPENDENT_REVIEW_SHARD_OUTPUT_ALREADY_EXISTS:")) {
      throw error;
    }
    if (error?.code !== "ENOENT") throw error;
  }
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile() && await realpath(path) === resolve(path);
  } catch {
    return false;
  }
}

async function resolveCodexExecutable() {
  for (const candidate of APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS) {
    if (await executable(candidate)) return resolve(candidate);
  }
  throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_EXECUTABLE_NOT_FOUND");
}

async function runReviewer(command, prompt, reviewRepoRoot) {
  const startedAt = new Date().toISOString();
  const child = spawn(command[0], command.slice(1), {
    cwd: reviewRepoRoot,
    env: createIndependentReviewSanitizedEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!Number.isInteger(child.pid) || child.pid < 1 || child.pid === process.pid) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_REVIEWER_PROCESS_INVALID");
  }
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${prompt}\n`);
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
  const outcome = await new Promise((accept) => {
    child.once("error", (error) => accept({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => accept({ exitCode, signal, error: null }));
  });
  clearTimeout(timeout);
  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    reviewerProcessId: child.pid,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    ...outcome,
  };
  if (result.exitCode !== 0) {
    throw new Error(
      `INDEPENDENT_REVIEW_SHARD_CODEX_FAILED:${result.exitCode ?? result.signal ?? result.error ?? "unknown"}`,
    );
  }
  return result;
}

function parseJsonLines(content) {
  const events = [];
  for (const [index, line] of content.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_SHARD_CODEX_EVENTS_INVALID_AT_${index + 1}`);
    }
  }
  if (events.length === 0) throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_EVENTS_EMPTY");
  return events;
}

function reviewerThreadId(events) {
  const started = events.filter((event) => event?.type === "thread.started");
  if (started.length !== 1 || typeof started[0]?.thread_id !== "string" || !started[0].thread_id.trim()) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_CODEX_THREAD_ID_MISSING");
  }
  return started[0].thread_id;
}

async function rawArtifact(path, evidenceDirectory, artifactType) {
  const content = await readFile(path);
  return {
    artifact_type: artifactType,
    path: relative(evidenceDirectory, path),
    sha256: reviewSha256(content),
    size_bytes: content.length,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const traceabilityRelative = assertContained(repoRoot, options.documentPath,
    "INDEPENDENT_REVIEW_SHARD_TRACEABILITY");
  const captured = await loadIndependentReviewLiveSourceSnapshotContext({
    liveContextPath: options.liveContextPath,
    documentRelativePath: traceabilityRelative.replaceAll(sep, "/"),
  });
  const {
    liveContext, document, sourceSnapshotContext, hostContextReceipt,
    repoRoot: reviewRepoRoot, documentPath: reviewDocumentPath, outputRoot,
  } = captured;
  assertReviewOutputPath(outputRoot, options.evidencePath,
    "INDEPENDENT_REVIEW_SHARD_EVIDENCE_OUTPUT");
  if (repoRoot !== reviewRepoRoot) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RUNNER_OUTSIDE_HOST_SNAPSHOT");
  }
  const liveBinding = normalizeIndependentReviewLiveContext(liveContext);
  const requirement = document.requirements?.find((item) => item?.requirement_id === options.requirementId);
  if (!requirement || !["FIXED_PENDING_REVIEW", "CLOSED"].includes(requirement.status)) {
    throw new Error(`INDEPENDENT_REVIEW_SHARD_REQUIREMENT_NOT_READY:${options.requirementId}`);
  }
  const plan = await deriveIndependentReviewPlan({
    document,
    requirementId: options.requirementId,
    repoRoot: reviewRepoRoot,
    documentPath: reviewDocumentPath,
    sourceSnapshotContext,
  });
  assertIndependentReviewLivePlanBinding({
    plan, liveBinding, sourceSnapshotContext, hostContextReceipt,
  });
  const shard = plan.shards.find((item) =>
    item.claim_id === options.claimId && item.shard_id === options.shardId);
  if (!shard) throw new Error("INDEPENDENT_REVIEW_SHARD_ASSIGNMENT_NOT_FOUND");
  const claim = shard.scope_kind === "ATOMIC_CLAIM"
    ? requirement.control_claims.find((item) => item.claim_id === options.claimId)
    : {
        claim_id: options.claimId,
        control: "Mechanically assigned release-critical peripheral paths and dependency edges are reviewed bottom-up.",
        probe_obligations: [],
      };
  if (!claim) throw new Error("INDEPENDENT_REVIEW_SHARD_CLAIM_NOT_FOUND");

  const evidenceDirectory = dirname(options.evidencePath);
  const rawDirectory = resolve(evidenceDirectory, `${basename(options.evidencePath, ".json")}.raw`);
  const eventsPath = resolve(rawDirectory, "codex-events.jsonl");
  const stderrPath = resolve(rawDirectory, "codex-stderr.log");
  const finalVerdictPath = resolve(rawDirectory, "final-verdict.json");
  const invocationPath = resolve(rawDirectory, "invocation.json");
  await Promise.all([assertAbsent(options.evidencePath), assertAbsent(rawDirectory)]);
  await mkdir(rawDirectory, { mode: 0o700 });

  const sourceBefore = {
    algorithm: "host-attested-gate-source-fingerprint-v1",
    file_count: sourceSnapshotContext.source_entries.length,
    sha256: liveBinding.source_fingerprint_sha256,
    roots: sourceSnapshotContext.roots,
  };
  const implementationExecutionId = `controller-process:${process.pid}:run:${randomUUID()}`;
  const inspectionNonce = randomBytes(16).toString("hex");
  const { receipt } = await createIndependentReviewShardReceipt({
    document,
    requirementId: options.requirementId,
    claimId: options.claimId,
    shardId: options.shardId,
    repoRoot: reviewRepoRoot,
    documentPath: reviewDocumentPath,
    sourceFingerprint: sourceBefore.sha256,
    nonce: inspectionNonce,
    sourceSnapshotContext,
  });
  if (receipt.plan_sha256 !== plan.plan_sha256) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_PLAN_CHANGED_BEFORE_RUN");
  }
  const inspectionCommands = buildIndependentReviewShardInspectionCommands({
    traceabilityPath: traceabilityRelative,
    nonce: inspectionNonce,
    requirementId: options.requirementId,
    claimId: options.claimId,
    shardId: options.shardId,
    chunkCount: receipt.content_chunk_count,
    liveContextPath: options.liveContextPath,
  });
  const probeNonces = shard.probe_obligation_ids.map((obligationId) => ({
    obligation_id: obligationId,
    probe_nonce: randomBytes(16).toString("hex"),
  }));
  const probeCommands = probeNonces.map((item) => buildIndependentReviewObligationProbeCommand({
    traceabilityPath: traceabilityRelative,
    inspectionNonce,
    requirementId: options.requirementId,
    claimId: options.claimId,
    obligationId: item.obligation_id,
    probeNonce: item.probe_nonce,
    liveContextPath: options.liveContextPath,
  }));
  const evidenceChecked = shard.paths.map((path) => {
    const identity = receipt.files.find((item) => item.path === path);
    if (!identity) throw new Error(`INDEPENDENT_REVIEW_SHARD_EVIDENCE_IDENTITY_MISSING:${path}`);
    return { path, sha256: identity.sha256 };
  });
  const prompt = buildIndependentReviewShardPrompt({
    implementationExecutionId,
    sourceFingerprint: sourceBefore.sha256,
    plan,
    shard,
    claim,
    reviewerRole: requirement.reviewer,
    inspectionCommands,
    probeCommands,
    evidenceChecked,
    liveBinding,
  });
  const codexPath = await resolveCodexExecutable();
  const codexIdentity = await inspectIndependentReviewCodexIdentity({
    codexPath,
    repoRoot: reviewRepoRoot,
    approvedExecutableSha256: liveBinding.approved_review_codex_sha256,
  });
  const reviewOutputSchemaPath = resolve(
    reviewRepoRoot,
    relative(repoRoot, outputSchemaPath),
  );
  const command = buildIndependentReviewCodexCommand({
    codexPath,
    repoRoot: reviewRepoRoot,
    outputSchemaPath: reviewOutputSchemaPath,
    finalVerdictPath,
  });
  await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: reviewRepoRoot,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256: liveBinding.approved_review_runtime_sha256,
  });
  const run = await runReviewer(command, prompt, reviewRepoRoot);
  await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: reviewRepoRoot,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256: liveBinding.approved_review_runtime_sha256,
  });
  await Promise.all([
    atomicWrite(eventsPath, run.stdout),
    atomicWrite(stderrPath, run.stderr.length > 0 ? run.stderr : Buffer.from("<empty>\n")),
  ]);
  const events = parseJsonLines(run.stdout);
  const reviewerExecutionId = `codex-thread:${reviewerThreadId(events)}:pid:${run.reviewerProcessId}`;
  const finalVerdict = JSON.parse(await readFile(finalVerdictPath, "utf8"));
  validateIndependentReviewShardVerdict(finalVerdict, {
    implementationExecutionId,
    sourceFingerprint: sourceBefore.sha256,
    plan,
    shard,
    reviewerRole: requirement.reviewer,
    evidenceChecked,
  });

  const sourceAfter = { ...sourceBefore, roots: [...sourceBefore.roots] };
  const invocation = {
    schema_version: "3.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW",
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    exit_code: run.exitCode,
    controller_process_id: process.pid,
    reviewer_process_id: run.reviewerProcessId,
    implementation_execution_id: implementationExecutionId,
    traceability_path: traceabilityRelative,
    requirement_id: options.requirementId,
    claim_id: options.claimId,
    shard_id: options.shardId,
    source_fingerprint_before: sourceBefore,
    source_fingerprint_after: sourceAfter,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    plan_sha256: plan.plan_sha256,
    inspection_nonce: inspectionNonce,
    inspection_commands: inspectionCommands,
    probe_nonces: probeNonces,
    probe_commands: probeCommands,
    prompt,
    prompt_sha256: reviewSha256(prompt),
    output_schema: {
      path: relative(reviewRepoRoot, reviewOutputSchemaPath),
      sha256: reviewSha256(await readFile(reviewOutputSchemaPath)),
    },
    codex: {
      ...codexIdentity,
      command,
    },
    live_binding: liveBinding,
  };
  await atomicWrite(invocationPath, stableJson(invocation));
  const rawArtifacts = await Promise.all([
    rawArtifact(eventsPath, evidenceDirectory, "CODEX_EVENTS_JSONL"),
    rawArtifact(stderrPath, evidenceDirectory, "CODEX_STDERR"),
    rawArtifact(finalVerdictPath, evidenceDirectory, "FINAL_VERDICT"),
    rawArtifact(invocationPath, evidenceDirectory, "INVOCATION"),
  ]);
  const summary = {
    schema_version: "3.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW",
    captured_at: new Date().toISOString(),
    source_fingerprint: sourceBefore.sha256,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    plan_sha256: plan.plan_sha256,
    requirement_id: options.requirementId,
    claim_id: options.claimId,
    shard_id: options.shardId,
    implementation_execution_id: implementationExecutionId,
    reviewer_execution_id: reviewerExecutionId,
    decision: finalVerdict.decision,
    live_binding: liveBinding,
    generator: {
      kind: "INDEPENDENT_ATOMIC_CLAIM_SHARD_REVIEW",
      command: `node ${relative(repoRoot, scriptPath)}`,
      version: generatorVersion,
      executable_path: relative(repoRoot, scriptPath),
      executable_sha256: reviewSha256(sourceSnapshotContext.contentByPath.get(
        relative(repoRoot, scriptPath).replaceAll(sep, "/"),
      )),
    },
    raw_artifacts: rawArtifacts,
  };
  await atomicWrite(options.evidencePath, stableJson(summary));
  const artifactSha256 = reviewSha256(await readFile(options.evidencePath));
  await verifyIndependentReviewShardArtifact({
    document,
    documentPath: reviewDocumentPath,
    requirementId: options.requirementId,
    claimId: options.claimId,
    shardId: options.shardId,
    artifactPath: options.evidencePath,
    expectedArtifactSha256: artifactSha256,
    expectedSourceFingerprint: sourceBefore.sha256,
    repoRoot: reviewRepoRoot,
    allowedCodexExecutablePaths: [codexPath],
    expectedLiveReviewContext: liveContext,
    sourceSnapshotContext,
    hostContextReceipt,
    liveContextPath: options.liveContextPath,
  });
  process.stdout.write(stableJson({
    status: finalVerdict.decision === "CLOSED" ? "SHARD_CLOSED_NOT_AGGREGATED" : "SHARD_REOPENED",
    evidence: options.evidencePath,
    sha256: artifactSha256,
    requirement_id: options.requirementId,
    claim_id: options.claimId,
    shard_id: options.shardId,
    source_fingerprint: sourceBefore.sha256,
    plan_sha256: plan.plan_sha256,
    decision: finalVerdict.decision,
    note: "This generator never mutates traceability status or closure fields.",
  }));
  if (finalVerdict.decision !== "CLOSED") process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
