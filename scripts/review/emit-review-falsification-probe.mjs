#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createIndependentReviewFalsificationProbeReceipt,
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
      throw new Error("Every falsification probe option must occur exactly once with one value");
    }
    values.set(name, value);
  }
  const expected = [
    "--file",
    "--nonce",
    "--requirement",
    "--probe-nonce",
    "--target",
    "--test",
    "--literal",
    "--replacement",
    "--counterexample",
  ];
  if (stableReviewStringify([...values.keys()].sort()) !== stableReviewStringify([...expected].sort())) {
    throw new Error("The fixed falsification probe option set is required");
  }
  const documentPath = resolve(repoRoot, values.get("--file"));
  const relativeDocument = relative(repoRoot, documentPath);
  if (!relativeDocument || relativeDocument === ".." || relativeDocument.startsWith(`..${sep}`)) {
    throw new Error("--file must remain inside the repository");
  }
  return {
    documentPath,
    requirementId: values.get("--requirement"),
    inspectionNonce: values.get("--nonce"),
    probe: {
      probe_nonce: values.get("--probe-nonce"),
      counterexample: values.get("--counterexample"),
      target_path: values.get("--target"),
      test_path: values.get("--test"),
      literal: values.get("--literal"),
      replacement: values.get("--replacement"),
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceBefore = await fingerprintAcceptanceSource(repoRoot);
  const document = JSON.parse(await readFile(options.documentPath, "utf8"));
  const receipt = await createIndependentReviewFalsificationProbeReceipt({
    document,
    requirementId: options.requirementId,
    repoRoot,
    documentPath: options.documentPath,
    sourceFingerprint: sourceBefore.sha256,
    inspectionNonce: options.inspectionNonce,
    probe: options.probe,
  });
  const sourceAfter = await fingerprintAcceptanceSource(repoRoot);
  if (stableReviewStringify(sourceAfter) !== stableReviewStringify(sourceBefore)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_SOURCE_CHANGED");
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
