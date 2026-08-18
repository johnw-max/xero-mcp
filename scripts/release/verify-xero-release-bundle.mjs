#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { fingerprintAcceptanceSource } from "./local-acceptance-gate-lib.mjs";
import { assertProductionDeploymentArtifactMap } from "./production-deployment-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

function parseArguments(argv) {
  const options = {
    archive: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.tar.gz`),
    manifest: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.manifest.json`),
    buildIdentity: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.build-identity.json`),
    checksum: resolve(repoRoot, `artifacts/release/${RELEASE_BASENAME}.sha256`),
    approvedControlCatalogSha256: undefined,
  };
  const keys = new Map([
    ["--archive", "archive"],
    ["--manifest", "manifest"],
    ["--build-identity", "buildIdentity"],
    ["--checksum", "checksum"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--approved-control-catalog-sha256") {
      const value = argv[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error("--approved-control-catalog-sha256 requires a SHA-256 digest.");
      }
      options.approvedControlCatalogSha256 = value;
      index += 1;
      continue;
    }
    const key = keys.get(argv[index]);
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argv[index]} requires a path.`);
    options[key] = resolve(value);
    index += 1;
  }
  if (!options.approvedControlCatalogSha256) {
    throw new Error("--approved-control-catalog-sha256 is required from the host acceptance boundary.");
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
  if (entries.size !== 3) throw new Error("Checksum file must cover exactly the archive, manifest, and build identity.");
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
  if (manifest.acceptanceSource?.algorithm !== "sha256-path-size-executable-content-v2" ||
      !/^[a-f0-9]{64}$/u.test(manifest.acceptanceSource?.sha256 ?? "") ||
      !Number.isInteger(manifest.acceptanceSource?.fileCount) || manifest.acceptanceSource.fileCount < 1 ||
      !Array.isArray(manifest.acceptanceSource?.roots) || manifest.acceptanceSource.roots.length < 1) {
    throw new Error("Manifest acceptance source identity is missing or invalid.");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [archive, manifestContent, buildIdentityContent, checksumContent] = await Promise.all([
    readFile(options.archive),
    readFile(options.manifest),
    readFile(options.buildIdentity),
    readFile(options.checksum, "utf8"),
  ]);
  const checksums = parseChecksumFile(checksumContent);
  const archiveName = basename(options.archive);
  const manifestName = basename(options.manifest);
  const buildIdentityName = basename(options.buildIdentity);
  const archiveSha256 = sha256(archive);
  const manifestSha256 = sha256(manifestContent);
  const buildIdentitySha256 = sha256(buildIdentityContent);
  if (checksums.get(archiveName) !== archiveSha256) throw new Error("Archive checksum does not match.");
  if (checksums.get(manifestName) !== manifestSha256) throw new Error("Manifest checksum does not match.");
  if (checksums.get(buildIdentityName) !== buildIdentitySha256) throw new Error("Build identity checksum does not match.");

  const manifest = JSON.parse(manifestContent.toString("utf8"));
  assertManifestShape(manifest);
  const currentAcceptanceSource = await fingerprintAcceptanceSource(repoRoot);
  if (manifest.acceptanceSource.sha256 !== currentAcceptanceSource.sha256 ||
      manifest.acceptanceSource.fileCount !== currentAcceptanceSource.file_count ||
      JSON.stringify(manifest.acceptanceSource.roots) !== JSON.stringify(currentAcceptanceSource.roots)) {
    throw new Error("Manifest acceptance source identity does not match the verifying source snapshot.");
  }
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
  assertProductionDeploymentArtifactMap(new Map(
    archiveEntries.map((entry) => [entry.path.slice(rootPrefix.length), entry.content]),
  ));
  const runtimeContractPath = resolve(repoRoot, "dist/xeroRelease.js");
  const runtimeContract = await import(`${pathToFileURL(runtimeContractPath).href}?verify=${manifestSha256}`);
  if (typeof runtimeContract.parseXeroBuildIdentity !== "function" ||
      typeof runtimeContract.xeroBuildIdentityHash !== "function") {
    throw new Error("The compiled runtime does not expose the approved build identity contract.");
  }
  const buildIdentity = runtimeContract.parseXeroBuildIdentity(buildIdentityContent.toString("utf8"));
  const releaseSourceManifestSha256 = sha256(Buffer.from(JSON.stringify(
    manifest.files.map((file) => ({
      path: file.path,
      size_bytes: file.sizeBytes,
      mode: file.mode,
      sha256: file.sha256,
    })),
  ), "utf8"));
  const semanticBuildIdentityHash = runtimeContract.xeroBuildIdentityHash(buildIdentity);
  if (buildIdentity.acceptanceSourceSha256 !== manifest.acceptanceSource.sha256 ||
      buildIdentity.releaseSourceManifestSha256 !== releaseSourceManifestSha256 ||
      buildIdentity.sourceArchiveSha256 !== archiveSha256 ||
      buildIdentity.sourceBundleManifestSha256 !== manifestSha256) {
    throw new Error("Build identity is not bound to this exact accepted source bundle.");
  }
  if (buildIdentity.approvedControlCatalogSha256 !== options.approvedControlCatalogSha256) {
    throw new Error("Build identity is not bound to the host-approved control catalog.");
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
    buildIdentitySha256,
    semanticBuildIdentityHash,
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
