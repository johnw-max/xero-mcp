#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIndependentReviewInputReceipt,
  createIndependentReviewInputChunkReceipt,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";
import { fingerprintAcceptanceSource } from "../release/local-acceptance-gate-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function parseArguments(argv) {
  let documentPath;
  let nonce;
  let chunkIndex;
  const requirementIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--file") {
      if (!value) throw new Error("--file requires a repository-relative path");
      documentPath = resolve(repoRoot, value);
      index += 1;
    } else if (argument === "--nonce") {
      if (!value || !/^[a-f0-9]{32}$/u.test(value)) throw new Error("--nonce requires 32 lowercase hex characters");
      nonce = value;
      index += 1;
    } else if (argument === "--chunk-index") {
      if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("--chunk-index requires a non-negative integer");
      chunkIndex = Number(value);
      index += 1;
    } else if (argument === "--requirement") {
      if (!value || !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}$/u.test(value)) {
        throw new Error("--requirement requires a stable requirement ID");
      }
      requirementIds.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!documentPath || !nonce || !Number.isSafeInteger(chunkIndex) || requirementIds.length === 0 ||
      new Set(requirementIds).size !== requirementIds.length) {
    throw new Error("--file, --nonce and unique --requirement values are required");
  }
  const relativeDocument = relative(repoRoot, documentPath);
  if (!relativeDocument || relativeDocument === ".." || relativeDocument.startsWith(`..${sep}`)) {
    throw new Error("--file must remain inside the repository");
  }
  return {
    documentPath,
    nonce,
    chunkIndex,
    requirementIds: requirementIds.sort((left, right) => left.localeCompare(right, "en")),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceBefore = await fingerprintAcceptanceSource(repoRoot);
  const document = JSON.parse(await readFile(options.documentPath, "utf8"));
  const receipt = await createIndependentReviewInputReceipt({
    document,
    requirementIds: options.requirementIds,
    repoRoot,
    documentPath: options.documentPath,
    sourceFingerprint: sourceBefore.sha256,
    nonce: options.nonce,
  });
  const chunkReceipt = createIndependentReviewInputChunkReceipt(receipt, options.chunkIndex);
  const sourceAfter = await fingerprintAcceptanceSource(repoRoot);
  if (stableReviewStringify(sourceAfter) !== stableReviewStringify(sourceBefore)) {
    throw new Error("INDEPENDENT_REVIEW_INPUT_RECEIPT_SOURCE_CHANGED");
  }
  process.stdout.write(`${JSON.stringify(chunkReceipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
