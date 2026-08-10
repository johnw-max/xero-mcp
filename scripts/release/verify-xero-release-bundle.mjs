#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_BASENAME,
  RELEASE_ROOT,
  RELEASE_VERSION,
  forbiddenReleasePathReason,
  parseDeterministicTarGz,
  requiredReleaseFiles,
  scanReleaseContent,
  sha256,
} from "./release-bundle-lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

function parseArguments(argv) {
  const options = {
    archive: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.tar.gz`),
    manifest: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.manifest.json`),
    checksum: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.sha256`),
  };
  const keys = new Map([
    ["--archive", "archive"],
    ["--manifest", "manifest"],
    ["--checksum", "checksum"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index]);
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argv[index]} requires a path.`);
    options[key] = resolve(value);
    index += 1;
  }
  return options;
}

function parseChecksumFile(content) {
  const entries = new Map();
  const lines = content.trimEnd().split("\n");
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match) throw new Error("Checksum file has an invalid line.");
    if (entries.has(match[2])) throw new Error(`Checksum file repeats ${match[2]}.`);
    entries.set(match[2], match[1]);
  }
  if (entries.size !== 2) throw new Error("Checksum file must cover exactly the archive and manifest.");
  return entries;
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Manifest is not an object.");
  if (manifest.schemaVersion !== 1) throw new Error("Manifest schemaVersion must be 1.");
  if (manifest.package?.version !== RELEASE_VERSION || manifest.package?.kind !== "SOURCE_REBUILD") {
    throw new Error("Manifest package version or kind is incorrect.");
  }
  if (manifest.archive?.root !== RELEASE_ROOT || !Array.isArray(manifest.files)) {
    throw new Error("Manifest archive root or file list is incorrect.");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [archive, manifestContent, checksumContent] = await Promise.all([
    readFile(options.archive),
    readFile(options.manifest),
    readFile(options.checksum, "utf8"),
  ]);
  const checksums = parseChecksumFile(checksumContent);
  const archiveName = basename(options.archive);
  const manifestName = basename(options.manifest);
  const archiveSha256 = sha256(archive);
  const manifestSha256 = sha256(manifestContent);
  if (checksums.get(archiveName) !== archiveSha256) throw new Error("Archive checksum does not match.");
  if (checksums.get(manifestName) !== manifestSha256) throw new Error("Manifest checksum does not match.");

  const manifest = JSON.parse(manifestContent.toString("utf8"));
  assertManifestShape(manifest);
  if (manifest.archive.filename !== archiveName || manifest.archive.sha256 !== archiveSha256 || manifest.archive.sizeBytes !== archive.length) {
    throw new Error("Manifest archive metadata does not match the archive.");
  }
  const manifestFindings = scanReleaseContent(manifestName, manifestContent);
  if (manifestFindings.length > 0) throw new Error(`Manifest scan failed: ${JSON.stringify(manifestFindings)}`);

  const archiveEntries = parseDeterministicTarGz(archive);
  const manifestFiles = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || manifestFiles.has(file.path)) {
      throw new Error("Manifest contains an invalid or duplicate file path.");
    }
    manifestFiles.set(file.path, file);
  }
  if (archiveEntries.length !== manifestFiles.size || manifest.summary?.fileCount !== archiveEntries.length) {
    throw new Error("Archive and manifest file counts differ.");
  }

  const findings = [];
  const observed = new Set();
  const rootPrefix = `${RELEASE_ROOT}/`;
  for (const entry of archiveEntries) {
    if (!entry.path.startsWith(rootPrefix)) throw new Error(`Archive entry is outside ${RELEASE_ROOT}: ${entry.path}`);
    const relativePath = entry.path.slice(rootPrefix.length);
    if (!relativePath) throw new Error("Archive contains a root-only file entry.");
    const forbiddenReason = forbiddenReleasePathReason(relativePath);
    if (forbiddenReason) findings.push({ path: relativePath, rule: forbiddenReason });
    findings.push(...scanReleaseContent(relativePath, entry.content));
    const expected = manifestFiles.get(relativePath);
    if (!expected) throw new Error(`Archive contains an unmanifested file: ${relativePath}`);
    if (expected.sha256 !== sha256(entry.content) || expected.sizeBytes !== entry.size) {
      throw new Error(`Archive file digest or size mismatch: ${relativePath}`);
    }
    const expectedMode = Number.parseInt(expected.mode, 8);
    if (expectedMode !== entry.mode) throw new Error(`Archive file mode mismatch: ${relativePath}`);
    observed.add(relativePath);
  }
  if (findings.length > 0) throw new Error(`Release archive scan failed: ${JSON.stringify(findings)}`);
  for (const required of requiredReleaseFiles()) {
    if (!observed.has(required)) throw new Error(`Archive omitted required runtime source: ${required}`);
  }
  for (const path of manifestFiles.keys()) {
    if (!observed.has(path)) throw new Error(`Manifested file is missing from the archive: ${path}`);
  }
  if (manifest.policy?.secretFindingCount !== 0 || manifest.policy?.legacyDomainFindingCount !== 0) {
    throw new Error("Manifest does not declare a clean release scan.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    version: RELEASE_VERSION,
    archivePath: options.archive,
    archiveSizeBytes: archive.length,
    fileCount: archiveEntries.length,
    archiveSha256,
    manifestSha256,
    secretFindings: 0,
    legacyDomainFindings: 0,
    forbiddenPathFindings: 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});

