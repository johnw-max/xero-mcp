#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTITY_DIRECTORY = ".accepted-release";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

function normalizedMode(statMode) {
  return (statMode & 0o111) === 0 ? "0644" : "0755";
}

function assertSafeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\") ||
      posix.isAbsolute(path) || posix.normalize(path) !== path ||
      path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`ACCEPTED_BUILD_CONTEXT_PATH_INVALID:${String(path)}`);
  }
}

function exactIdentityShape(identity) {
  const expected = [
    "acceptanceSourceSha256",
    "releaseAttestationHash",
    "releaseSourceManifestSha256",
    "releaseVersion",
    "requiredMigration",
    "schemaVersion",
    "sourceArchiveSha256",
    "sourceBundleManifestSha256",
    "toolsetHash",
  ];
  return identity && typeof identity === "object" && !Array.isArray(identity) &&
    JSON.stringify(Object.keys(identity).sort()) === JSON.stringify(expected);
}

async function collectFiles(root, directory = "") {
  const absolute = resolve(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    const relative = directory ? posix.join(directory, entry.name) : entry.name;
    if (relative === IDENTITY_DIRECTORY || relative === "node_modules") continue;
    if (entry.isSymbolicLink()) throw new Error(`ACCEPTED_BUILD_CONTEXT_SYMLINK:${relative}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`ACCEPTED_BUILD_CONTEXT_UNSUPPORTED_ENTRY:${relative}`);
  }
  return files;
}

async function inspectAcceptedBuildContext(options, includeSealedEntries) {
  const root = resolve(options.root);
  const manifestPath = resolve(options.manifestPath ?? resolve(root, IDENTITY_DIRECTORY, "manifest.json"));
  const buildIdentityPath = resolve(
    options.buildIdentityPath ?? resolve(root, IDENTITY_DIRECTORY, "build-identity.json"),
  );
  const archivePath = resolve(options.archivePath ?? resolve(root, IDENTITY_DIRECTORY, "source.tar.gz"));
  const checksumPath = resolve(options.checksumPath ?? resolve(root, IDENTITY_DIRECTORY, "checksums.sha256"));
  const [manifestContent, buildIdentityContent, archiveContent, checksumContent] = await Promise.all([
    readFile(manifestPath),
    readFile(buildIdentityPath),
    readFile(archivePath),
    readFile(checksumPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  const identity = JSON.parse(buildIdentityContent.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) ||
      !SHA256.test(manifest?.acceptanceSource?.sha256 ?? "") ||
      !SHA256.test(manifest?.archive?.sha256 ?? "")) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_MANIFEST_INVALID");
  }
  if (!exactIdentityShape(identity)) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_IDENTITY_INVALID");
  }
  for (const field of [
    "acceptanceSourceSha256",
    "releaseSourceManifestSha256",
    "sourceArchiveSha256",
    "sourceBundleManifestSha256",
    "toolsetHash",
    "releaseAttestationHash",
  ]) {
    if (!SHA256.test(identity[field] ?? "")) throw new Error(`ACCEPTED_BUILD_CONTEXT_IDENTITY_HASH_INVALID:${field}`);
  }
  const manifestHash = sha256(manifestContent);
  const archiveHash = sha256(archiveContent);
  const buildIdentityFileHash = sha256(buildIdentityContent);
  const checksumEntries = new Map();
  for (const line of checksumContent.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match || checksumEntries.has(match[2])) throw new Error("ACCEPTED_BUILD_CONTEXT_CHECKSUM_INVALID");
    checksumEntries.set(match[2], match[1]);
  }
  if (checksumEntries.size !== 3 ||
      checksumEntries.get(manifest.archive.filename) !== archiveHash ||
      !manifest.archive.filename.endsWith(".tar.gz") ||
      checksumEntries.get(`${manifest.archive.filename.slice(0, -".tar.gz".length)}.manifest.json`) !== manifestHash ||
      checksumEntries.get(`${manifest.archive.filename.slice(0, -".tar.gz".length)}.build-identity.json`) !==
        buildIdentityFileHash) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_CHECKSUM_MISMATCH");
  }
  const semanticBuildIdentityHash = sha256(stableStringify(identity));
  const releaseSourceEntries = manifest.files.map((file) => ({
    path: file.path,
    size_bytes: file.sizeBytes,
    mode: file.mode,
    sha256: file.sha256,
  }));
  const releaseSourceManifestSha256 = sha256(Buffer.from(JSON.stringify(releaseSourceEntries), "utf8"));
  if (identity.acceptanceSourceSha256 !== manifest.acceptanceSource.sha256 ||
      identity.releaseSourceManifestSha256 !== releaseSourceManifestSha256 ||
      identity.sourceArchiveSha256 !== manifest.archive.sha256 || identity.sourceArchiveSha256 !== archiveHash ||
      identity.sourceBundleManifestSha256 !== manifestHash) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_ARTIFACT_BINDING_MISMATCH");
  }
  if (options.expectedBuildIdentityHash && semanticBuildIdentityHash !== options.expectedBuildIdentityHash) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_SEMANTIC_IDENTITY_MISMATCH");
  }
  if (options.expectedAcceptanceSourceSha256 &&
      identity.acceptanceSourceSha256 !== options.expectedAcceptanceSourceSha256) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_ACCEPTANCE_SOURCE_MISMATCH");
  }
  if (options.expectedSourceArchiveSha256 && identity.sourceArchiveSha256 !== options.expectedSourceArchiveSha256) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_SOURCE_ARCHIVE_MISMATCH");
  }

  const expectedPaths = manifest.files.map((file) => file.path);
  const observedPaths = (await collectFiles(root)).sort((left, right) => left.localeCompare(right, "en"));
  const sortedExpectedPaths = [...expectedPaths].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(observedPaths) !== JSON.stringify(sortedExpectedPaths)) {
    const expectedSet = new Set(sortedExpectedPaths);
    const observedSet = new Set(observedPaths);
    const missing = sortedExpectedPaths.filter((path) => !observedSet.has(path)).slice(0, 10);
    const extra = observedPaths.filter((path) => !expectedSet.has(path)).slice(0, 10);
    throw new Error(`ACCEPTED_BUILD_CONTEXT_FILE_SET_MISMATCH:missing=${JSON.stringify(missing)}:extra=${JSON.stringify(extra)}`);
  }
  const seen = new Set();
  const sealedEntries = [];
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path);
    if (seen.has(file.path) || !SHA256.test(file.sha256 ?? "") || !["0644", "0755"].includes(file.mode)) {
      throw new Error(`ACCEPTED_BUILD_CONTEXT_FILE_MANIFEST_INVALID:${String(file.path)}`);
    }
    seen.add(file.path);
    const absolute = resolve(root, file.path);
    const [content, stat] = await Promise.all([readFile(absolute), lstat(absolute)]);
    if (!stat.isFile() || stat.isSymbolicLink() || content.length !== file.sizeBytes ||
        sha256(content) !== file.sha256 || normalizedMode(stat.mode) !== file.mode) {
      throw new Error(`ACCEPTED_BUILD_CONTEXT_FILE_MISMATCH:${file.path}`);
    }
    if (includeSealedEntries) {
      sealedEntries.push(Object.freeze({
        path: file.path,
        content: Buffer.from(content),
        mode: Number.parseInt(file.mode, 8),
      }));
    }
  }
  if (manifest.summary?.fileCount !== manifest.files.length) {
    throw new Error("ACCEPTED_BUILD_CONTEXT_FILE_COUNT_MISMATCH");
  }
  const result = {
    semanticBuildIdentityHash,
    acceptanceSourceSha256: identity.acceptanceSourceSha256,
    sourceArchiveSha256: identity.sourceArchiveSha256,
    sourceBundleManifestSha256: manifestHash,
    releaseSourceManifestSha256,
    fileCount: manifest.files.length,
  };
  if (!includeSealedEntries) return Object.freeze(result);
  sealedEntries.push(
    Object.freeze({
      path: `${IDENTITY_DIRECTORY}/source.tar.gz`,
      content: Buffer.from(archiveContent),
      mode: 0o644,
    }),
    Object.freeze({
      path: `${IDENTITY_DIRECTORY}/manifest.json`,
      content: Buffer.from(manifestContent),
      mode: 0o644,
    }),
    Object.freeze({
      path: `${IDENTITY_DIRECTORY}/build-identity.json`,
      content: Buffer.from(buildIdentityContent),
      mode: 0o644,
    }),
    Object.freeze({
      path: `${IDENTITY_DIRECTORY}/checksums.sha256`,
      content: Buffer.from(checksumContent, "utf8"),
      mode: 0o644,
    }),
  );
  return Object.freeze({
    ...result,
    sealedEntries: Object.freeze(sealedEntries),
  });
}

export async function verifyAcceptedBuildContext(options) {
  return inspectAcceptedBuildContext(options, false);
}

/**
 * Captures every verified context byte into memory exactly once. Callers must
 * build from these returned buffers, never re-read the mutable context path.
 */
export async function sealAcceptedBuildContext(options) {
  return inspectAcceptedBuildContext(options, true);
}

function parseArguments(argv) {
  const options = { root: undefined, manifestPath: undefined, buildIdentityPath: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? "argument"} requires a value`);
    if (flag === "--root") options.root = value;
    else if (flag === "--manifest") options.manifestPath = value;
    else if (flag === "--build-identity") options.buildIdentityPath = value;
    else if (flag === "--expected-build-identity-hash") options.expectedBuildIdentityHash = value;
    else if (flag === "--expected-acceptance-source-sha256") options.expectedAcceptanceSourceSha256 = value;
    else if (flag === "--expected-source-archive-sha256") options.expectedSourceArchiveSha256 = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.root) throw new Error("--root is required");
  return options;
}

async function main() {
  const result = await verifyAcceptedBuildContext(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ status: "PASS", ...result })}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
