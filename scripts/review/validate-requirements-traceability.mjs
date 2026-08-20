#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTraceabilityDocument,
  validateTraceabilityReferences,
} from "./traceability-validator-lib.mjs";
import { fingerprintAcceptanceSource } from "../release/local-acceptance-gate-lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const defaultTraceability = resolve(
  repoRoot,
  "artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json",
);

function parseArguments(argv) {
  let file = defaultTraceability;
  let requireClosed = false;
  let expectedSourceFingerprint;
  let expectedControlCatalogSha256;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-closed") {
      requireClosed = true;
    } else if (argument === "--file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--file requires a path");
      file = resolve(value);
      index += 1;
    } else if (argument === "--expected-source-fingerprint") {
      const value = argv[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error("--expected-source-fingerprint requires a SHA-256 digest");
      }
      expectedSourceFingerprint = value;
      index += 1;
    } else if (argument === "--approved-control-catalog-sha256") {
      const value = argv[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error("--approved-control-catalog-sha256 requires a SHA-256 digest");
      }
      expectedControlCatalogSha256 = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (expectedControlCatalogSha256 === undefined) {
    throw new Error(
      "--approved-control-catalog-sha256 is required from the host acceptance boundary",
    );
  }
  return { file, requireClosed, expectedSourceFingerprint, expectedControlCatalogSha256 };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const document = JSON.parse(await readFile(options.file, "utf8"));
  const expectedSourceFingerprint = options.expectedSourceFingerprint ??
    (await fingerprintAcceptanceSource(repoRoot)).sha256;
  const reviewExecutionReceipts = [];
  const errors = [
    ...validateTraceabilityDocument(document, {
      requireClosed: options.requireClosed,
      expectedSourceFingerprint,
    }),
    ...await validateTraceabilityReferences(document, {
      repoRoot,
      documentPath: options.file,
      expectedSourceFingerprint,
      reviewExecutionReceipts,
      requireClosed: options.requireClosed,
      expectedControlCatalogSha256: options.expectedControlCatalogSha256,
    }),
  ];
  if (errors.length > 0) {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      file: options.file,
      require_closed: options.requireClosed,
      errors,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    file: options.file,
    require_closed: options.requireClosed,
    requirement_count: document.requirements.length,
    approved_control_catalog_sha256: options.expectedControlCatalogSha256 ?? null,
    independent_review_test_receipts: reviewExecutionReceipts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
