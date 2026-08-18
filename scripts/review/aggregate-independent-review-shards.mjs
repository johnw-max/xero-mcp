#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { link, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertIndependentReviewExecutionRuntimeUnchanged,
  assertIndependentReviewSourceSnapshotUnchanged,
  loadIndependentReviewLiveSourceSnapshotContext,
  reviewSha256,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";
import { deriveIndependentReviewPlan } from "./independent-review-plan-lib.mjs";
import {
  assertIndependentReviewLivePlanBinding,
  verifyIndependentReviewAggregateClosure,
  verifyIndependentReviewShardArtifact,
  normalizeIndependentReviewLiveContext,
} from "./independent-review-shard-evidence-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = await realpath(resolve(dirname(scriptPath), "../.."));
const defaultTraceabilityPath = resolve(
  repoRoot,
  "artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json",
);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Every independent aggregate option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = ["--evidence", "--requirement", "--shard-dir", "--live-context"];
  const allowed = new Set([...expected, "--file"]);
  if (expected.some((name) => !values.has(name)) || [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("--evidence, --requirement, --shard-dir and --live-context are required; --file is optional");
  }
  return {
    documentPath: values.has("--file") ? resolve(values.get("--file")) : defaultTraceabilityPath,
    evidencePath: resolve(values.get("--evidence")),
    requirementId: values.get("--requirement"),
    shardDirectory: resolve(values.get("--shard-dir")),
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

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(path, content) {
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
  assertContained(repoRoot, options.documentPath, "INDEPENDENT_REVIEW_AGGREGATE_TRACEABILITY");
  if (resolve(options.evidencePath) === resolve(options.documentPath) ||
      resolve(options.evidencePath) === resolve(options.shardDirectory) ||
      resolve(options.shardDirectory) === resolve(options.documentPath)) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_PATHS_MUST_BE_DISTINCT");
  }
  const documentRelativePath = relative(repoRoot, options.documentPath).replaceAll(sep, "/");
  const captured = await loadIndependentReviewLiveSourceSnapshotContext({
    liveContextPath: options.liveContextPath,
    documentRelativePath,
  });
  const {
    liveContext, document, sourceSnapshotContext, hostContextReceipt,
    repoRoot: reviewRepoRoot, documentPath: reviewDocumentPath, outputRoot,
  } = captured;
  assertReviewOutputPath(outputRoot, options.evidencePath,
    "INDEPENDENT_REVIEW_AGGREGATE_EVIDENCE_OUTPUT");
  assertReviewOutputPath(outputRoot, options.shardDirectory,
    "INDEPENDENT_REVIEW_AGGREGATE_SHARD_OUTPUT");
  if (repoRoot !== reviewRepoRoot) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_RUNNER_OUTSIDE_HOST_SNAPSHOT");
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
  const requirement = document.requirements?.find((item) => item?.requirement_id === options.requirementId);
  if (!requirement || !["FIXED_PENDING_REVIEW", "CLOSED"].includes(requirement.status)) {
    throw new Error(`INDEPENDENT_REVIEW_AGGREGATE_REQUIREMENT_NOT_READY:${options.requirementId}`);
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
  const expectedFiles = new Set(plan.shards.map((shard) => `${shard.shard_id}.json`));
  const entries = await readdir(options.shardDirectory, { withFileTypes: true });
  const actualFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (stableReviewStringify(actualFiles) !== stableReviewStringify([...expectedFiles].sort())) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_SHARD_FILE_SET_INVALID");
  }
  for (const entry of entries) {
    if (entry.isFile()) continue;
    if (!entry.isDirectory() || !entry.name.endsWith(".raw") ||
        !expectedFiles.has(`${entry.name.slice(0, -4)}.json`)) {
      throw new Error(`INDEPENDENT_REVIEW_AGGREGATE_UNEXPECTED_ENTRY:${entry.name}`);
    }
  }
  const verified = [];
  const shards = [];
  for (const shard of plan.shards) {
    await assertFrozenExecutionBoundary();
    const artifactPath = resolve(options.shardDirectory, `${shard.shard_id}.json`);
    const bytes = await readFile(artifactPath);
    const sha256 = reviewSha256(bytes);
    const result = await verifyIndependentReviewShardArtifact({
      document,
      documentPath: reviewDocumentPath,
      requirementId: options.requirementId,
      claimId: shard.claim_id,
      shardId: shard.shard_id,
      artifactPath,
      expectedArtifactSha256: sha256,
      expectedSourceFingerprint: sourceBefore.sha256,
      repoRoot: reviewRepoRoot,
      expectedLiveReviewContext: liveContext,
      sourceSnapshotContext,
      hostContextReceipt,
      liveContextPath: options.liveContextPath,
    });
    verified.push(result);
    shards.push({
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
      artifact: relative(dirname(options.evidencePath), artifactPath),
      sha256,
    });
    await assertFrozenExecutionBoundary();
  }
  const implementationExecutionId = `atomic-review-controllers:${reviewSha256(stableReviewStringify(
    verified.map((item) => item.implementationExecutionId).sort(),
  ))}`;
  const reviewerExecutionId = `atomic-reviewers:${reviewSha256(stableReviewStringify(
    verified.map((item) => item.reviewerExecutionId).sort(),
  ))}`;
  const capturedAt = new Date().toISOString();
  if (!verified.every((item) => item.summary.decision === "CLOSED")) {
    throw new Error("INDEPENDENT_REVIEW_AGGREGATE_REOPENED");
  }
  const aggregate = {
    schema_version: "3.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_AGGREGATE",
    captured_at: capturedAt,
    source_fingerprint: sourceBefore.sha256,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    plan_sha256: plan.plan_sha256,
    requirement_id: options.requirementId,
    implementation_execution_id: implementationExecutionId,
    reviewer_execution_id: reviewerExecutionId,
    decision: "CLOSED",
    live_binding: liveBinding,
    shards,
  };
  await atomicWrite(options.evidencePath, stableJson(aggregate));
  const aggregateSha256 = reviewSha256(await readFile(options.evidencePath));
  if (aggregate.decision === "CLOSED") {
    await assertFrozenExecutionBoundary();
    await verifyIndependentReviewAggregateClosure({
      document,
      requirement,
      closure: {
        implementation_execution_id: implementationExecutionId,
        reviewer_execution_id: reviewerExecutionId,
        reviewed_at: capturedAt,
        decision: "CLOSED",
        source_fingerprint: sourceBefore.sha256,
        review_subject_sha256: plan.review_subject_sha256,
        review_inputs_sha256: plan.review_inputs_sha256,
      },
      reviewArtifactPath: options.evidencePath,
      expectedReviewArtifactSha256: aggregateSha256,
      expectedSourceFingerprint: sourceBefore.sha256,
      repoRoot: reviewRepoRoot,
      documentPath: reviewDocumentPath,
      expectedLiveReviewContext: liveContext,
      approvedReviewRuntimeSha256: liveBinding.approved_review_runtime_sha256,
      sourceSnapshotContext,
      hostContextReceipt,
      liveContextPath: options.liveContextPath,
    });
    await assertFrozenExecutionBoundary();
  }
  process.stdout.write(stableJson({
    status: aggregate.decision === "CLOSED" ? "REVIEW_CLOSED_NOT_ATTACHED" : "REVIEW_REOPENED",
    evidence: options.evidencePath,
    review_artifact_sha256: aggregateSha256,
    source_fingerprint: sourceBefore.sha256,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    plan_sha256: plan.plan_sha256,
    implementation_execution_id: implementationExecutionId,
    reviewer_execution_id: reviewerExecutionId,
    reviewed_at: capturedAt,
    decision: aggregate.decision,
    note: "This aggregator never mutates traceability status or closure fields.",
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
