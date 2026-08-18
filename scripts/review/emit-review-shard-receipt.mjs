#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIndependentReviewShardChunkReceipt,
  createIndependentReviewShardReceipt,
} from "./independent-review-plan-lib.mjs";
import {
  loadIndependentReviewLiveSourceSnapshotContext,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";
import { fingerprintAcceptanceSource } from "../release/local-acceptance-gate-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Every shard receipt option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = ["--file", "--nonce", "--requirement", "--claim", "--shard", "--chunk-index"];
  const allowed = new Set([...expected, "--live-context"]);
  if (expected.some((name) => !values.has(name)) || [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("The fixed shard receipt option set is required");
  }
  const documentPath = resolve(repoRoot, values.get("--file"));
  const relativeDocument = relative(repoRoot, documentPath);
  if (!relativeDocument || relativeDocument === ".." || relativeDocument.startsWith(`..${sep}`)) {
    throw new Error("--file must remain inside the repository");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(values.get("--chunk-index") ?? "")) {
    throw new Error("--chunk-index requires a non-negative integer");
  }
  return {
    documentPath,
    nonce: values.get("--nonce"),
    requirementId: values.get("--requirement"),
    claimId: values.get("--claim"),
    shardId: values.get("--shard"),
    chunkIndex: Number(values.get("--chunk-index")),
    liveContextPath: values.get("--live-context"),
    documentRelativePath: relativeDocument.replaceAll(sep, "/"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const captured = options.liveContextPath
    ? await loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: options.liveContextPath,
        documentRelativePath: options.documentRelativePath,
      })
    : null;
  const executionRepoRoot = captured?.repoRoot ?? repoRoot;
  const executionDocumentPath = captured?.documentPath ?? options.documentPath;
  const sourceSnapshotContext = captured?.sourceSnapshotContext;
  if (captured && repoRoot !== executionRepoRoot) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RECEIPT_RUNNER_OUTSIDE_HOST_SNAPSHOT");
  }
  const sourceBefore = captured
    ? { sha256: captured.liveContext.source_fingerprint_sha256 }
    : await fingerprintAcceptanceSource(repoRoot);
  const document = captured?.document ?? JSON.parse(await readFile(options.documentPath, "utf8"));
  const { receipt } = await createIndependentReviewShardReceipt({
    document,
    requirementId: options.requirementId,
    claimId: options.claimId,
    shardId: options.shardId,
    repoRoot: executionRepoRoot,
    documentPath: executionDocumentPath,
    sourceFingerprint: sourceBefore.sha256,
    nonce: options.nonce,
    sourceSnapshotContext,
  });
  const output = createIndependentReviewShardChunkReceipt(receipt, options.chunkIndex);
  const sourceAfter = captured ? sourceBefore : await fingerprintAcceptanceSource(repoRoot);
  if (!captured && stableReviewStringify(sourceAfter) !== stableReviewStringify(sourceBefore)) {
    throw new Error("INDEPENDENT_REVIEW_SHARD_RECEIPT_SOURCE_CHANGED");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
