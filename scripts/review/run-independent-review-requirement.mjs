#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveIndependentReviewPlan } from "./independent-review-plan-lib.mjs";
import {
  assertIndependentReviewExecutionRuntimeUnchanged,
  assertIndependentReviewSourceSnapshotUnchanged,
  createIndependentReviewSanitizedEnvironment,
  loadIndependentReviewLiveSourceSnapshotContext,
  reviewSha256,
} from "./independent-review-evidence-lib.mjs";
import {
  assertIndependentReviewLivePlanBinding,
  normalizeIndependentReviewLiveContext,
  verifyIndependentReviewAggregateClosure,
  verifyIndependentReviewShardArtifact,
} from "./independent-review-shard-evidence-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = await realpath(resolve(dirname(scriptPath), "../.."));
const roundDirectory = resolve(repoRoot, "artifacts/ledger-kernel-review/round-2026-08-13-local");
const defaultTraceabilityPath = resolve(roundDirectory, "requirements-traceability.json");
const shardRunnerPath = resolve(dirname(scriptPath), "run-independent-review-shard.mjs");
const aggregateRunnerPath = resolve(dirname(scriptPath), "aggregate-independent-review-shards.mjs");

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Every independent requirement review option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = ["--requirement", "--live-context"];
  const allowed = new Set([...expected, "--file", "--shard-dir", "--evidence"]);
  if (expected.some((name) => !values.has(name)) ||
      [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("--requirement and --live-context are required; --file, --shard-dir and --evidence are optional");
  }
  const requirementId = values.get("--requirement");
  const safeId = /^[A-Z0-9-]+$/u.test(requirementId ?? "") ? requirementId : null;
  if (!safeId) throw new Error("INDEPENDENT_REVIEW_REQUIREMENT_ID_INVALID");
  return {
    requirementId,
    documentPath: values.has("--file") ? resolve(values.get("--file")) : defaultTraceabilityPath,
    shardDirectory: values.has("--shard-dir") ? resolve(values.get("--shard-dir")) : undefined,
    evidencePath: values.has("--evidence") ? resolve(values.get("--evidence")) : undefined,
    liveContextPath: resolve(values.get("--live-context")),
  };
}

function assertContained(base, path, label) {
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label}_MUST_BE_INSIDE_BOUNDARY`);
  }
}

function assertReviewOutputPath(outputRoot, outputPath, label) {
  assertContained(outputRoot, outputPath, label);
}

async function runNode(script, args, label, childRepoRoot = repoRoot) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: childRepoRoot,
    env: createIndependentReviewSanitizedEnvironment(),
    shell: false,
    stdio: "inherit",
  });
  const outcome = await new Promise((accept) => {
    child.once("error", (error) => accept({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => accept({ code, signal, error: null }));
  });
  if (outcome.code !== 0) {
    throw new Error(`${label}_FAILED:code=${outcome.code ?? "null"}:signal=${outcome.signal ?? "none"}:` +
      `error=${outcome.error ?? "none"}`);
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function immutableWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertContained(repoRoot, options.documentPath, "INDEPENDENT_REVIEW_REQUIREMENT_TRACEABILITY");
  const documentRelativePath = relative(repoRoot, options.documentPath).replaceAll(sep, "/");
  const captured = await loadIndependentReviewLiveSourceSnapshotContext({
    liveContextPath: options.liveContextPath,
    documentRelativePath,
  });
  const {
    liveContextBytes, liveContext, document, sourceSnapshotContext, hostContextReceipt,
    repoRoot: reviewRepoRoot, documentPath: reviewDocumentPath, outputRoot,
  } = captured;
  options.shardDirectory ??= resolve(outputRoot, `independent-review-${options.requirementId}-shards`);
  options.evidencePath ??= resolve(outputRoot, `independent-review-${options.requirementId}-aggregate.json`);
  assertReviewOutputPath(outputRoot, options.shardDirectory,
    "INDEPENDENT_REVIEW_REQUIREMENT_SHARD_OUTPUT");
  assertReviewOutputPath(outputRoot, options.evidencePath,
    "INDEPENDENT_REVIEW_REQUIREMENT_EVIDENCE_OUTPUT");
  if (repoRoot !== reviewRepoRoot) {
    throw new Error("INDEPENDENT_REVIEW_REQUIREMENT_RUNNER_OUTSIDE_HOST_SNAPSHOT");
  }
  const liveBinding = normalizeIndependentReviewLiveContext(liveContext);
  const assertFrozenExecutionBoundary = async () => {
    await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
    await assertIndependentReviewExecutionRuntimeUnchanged({
      repoRoot: reviewRepoRoot,
      sourceSnapshotContext,
      approvedReviewRuntimeSha256: liveBinding.approved_review_runtime_sha256,
    });
  };
  await assertFrozenExecutionBoundary();
  const requirement = document.requirements?.find((item) =>
    item?.requirement_id === options.requirementId);
  if (!requirement || !["FIXED_PENDING_REVIEW", "CLOSED"].includes(requirement.status)) {
    throw new Error(`INDEPENDENT_REVIEW_REQUIREMENT_NOT_READY:${options.requirementId}`);
  }
  const sourceBefore = {
    algorithm: "host-attested-gate-source-fingerprint-v1",
    file_count: sourceSnapshotContext.source_entries.length,
    sha256: liveBinding.source_fingerprint_sha256,
    roots: sourceSnapshotContext.roots,
  };
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
  const manifestPath = `${options.shardDirectory}.manifest.json`;
  const manifest = {
    schema_version: "1.0",
    kind: "INDEPENDENT_REVIEW_REQUIREMENT_RESUME_MANIFEST",
    requirement_id: options.requirementId,
    source_fingerprint: sourceBefore.sha256,
    plan_sha256: plan.plan_sha256,
    live_binding: liveBinding,
    live_context_sha256: reviewSha256(liveContextBytes),
    shard_assignments: plan.shards.map((shard) => ({
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
    })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const priorManifest = await readIfPresent(manifestPath);
  if (priorManifest) {
    if (!priorManifest.equals(manifestBytes)) {
      throw new Error("INDEPENDENT_REVIEW_REQUIREMENT_RESUME_IDENTITY_DIVERGED");
    }
  } else {
    await immutableWrite(manifestPath, manifestBytes);
  }
  await mkdir(options.shardDirectory, { mode: 0o700 });
  for (const shard of plan.shards) {
    await assertFrozenExecutionBoundary();
    const evidencePath = resolve(options.shardDirectory, `${shard.shard_id}.json`);
    const existing = await readIfPresent(evidencePath);
    if (existing) {
      await verifyIndependentReviewShardArtifact({
        document, documentPath: reviewDocumentPath, requirementId: options.requirementId,
        claimId: shard.claim_id, shardId: shard.shard_id, artifactPath: evidencePath,
        expectedArtifactSha256: reviewSha256(existing), expectedSourceFingerprint: sourceBefore.sha256,
        repoRoot: reviewRepoRoot, expectedLiveReviewContext: liveContext,
        sourceSnapshotContext, hostContextReceipt,
        liveContextPath: options.liveContextPath,
      });
    } else {
      await runNode(resolve(reviewRepoRoot, relative(repoRoot, shardRunnerPath)), [
        "--file", options.documentPath,
        "--requirement", options.requirementId,
        "--claim", shard.claim_id,
        "--shard", shard.shard_id,
        "--evidence", evidencePath,
        "--live-context", options.liveContextPath,
      ], `INDEPENDENT_REVIEW_REQUIREMENT_SHARD_${shard.shard_id}`, reviewRepoRoot);
    }
    await assertFrozenExecutionBoundary();
  }
  const existingAggregate = await readIfPresent(options.evidencePath);
  if (existingAggregate) {
    const aggregate = JSON.parse(existingAggregate.toString("utf8"));
    await verifyIndependentReviewAggregateClosure({
      document, requirement,
      closure: {
        implementation_execution_id: aggregate.implementation_execution_id,
        reviewer_execution_id: aggregate.reviewer_execution_id,
        reviewed_at: aggregate.captured_at,
        decision: "CLOSED",
        source_fingerprint: sourceBefore.sha256,
        review_subject_sha256: plan.review_subject_sha256,
        review_inputs_sha256: plan.review_inputs_sha256,
      },
      reviewArtifactPath: options.evidencePath,
      expectedReviewArtifactSha256: reviewSha256(existingAggregate),
      expectedSourceFingerprint: sourceBefore.sha256,
      repoRoot: reviewRepoRoot,
      documentPath: reviewDocumentPath,
      expectedLiveReviewContext: liveContext,
      approvedReviewRuntimeSha256: liveBinding.approved_review_runtime_sha256,
      sourceSnapshotContext,
      hostContextReceipt,
      liveContextPath: options.liveContextPath,
    });
  } else {
    await assertFrozenExecutionBoundary();
    await runNode(resolve(reviewRepoRoot, relative(repoRoot, aggregateRunnerPath)), [
      "--file", options.documentPath,
      "--requirement", options.requirementId,
      "--shard-dir", options.shardDirectory,
      "--evidence", options.evidencePath,
      "--live-context", options.liveContextPath,
    ], "INDEPENDENT_REVIEW_REQUIREMENT_AGGREGATE", reviewRepoRoot);
    await assertFrozenExecutionBoundary();
  }
  process.stdout.write(`${JSON.stringify({
    status: "REQUIREMENT_REVIEW_AGGREGATED_NOT_ATTACHED",
    requirement_id: options.requirementId,
    shard_count: plan.shards.length,
    shard_directory: relative(repoRoot, options.shardDirectory),
    evidence: relative(repoRoot, options.evidencePath),
    source_fingerprint: sourceBefore.sha256,
    plan_sha256: plan.plan_sha256,
    note: `Review artifacts are immutable inputs; update traceability separately only after ${basename(options.evidencePath)} verifies CLOSED.`,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
