#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_SOURCE_DATE_EPOCH,
  RELEASE_BASENAME,
  RELEASE_ROOT,
  RELEASE_VERSION,
  createDeterministicTarGz,
  createDeterministicTar,
  enumerateReleaseFiles,
  normalizedMode,
  scanReleaseContent,
  sha256,
} from "./release-bundle-lib.mjs";
import { fingerprintAcceptanceSource } from "./local-acceptance-gate-lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

function parseArguments(argv) {
  const options = {
    outputDirectory: resolve(repoRoot, "artifacts/release"),
    sourceDateEpoch: Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? String(DEFAULT_SOURCE_DATE_EPOCH), 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir requires a path.");
      options.outputDirectory = resolve(value);
      index += 1;
    } else if (argument === "--source-date-epoch") {
      const value = argv[index + 1];
      if (!value) throw new Error("--source-date-epoch requires an integer.");
      options.sourceDateEpoch = Number.parseInt(value, 10);
      index += 1;
    } else if (argument === "--artifact-stream-fd") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/u.test(value) || Number.parseInt(value, 10) < 3) {
        throw new Error("--artifact-stream-fd requires an inherited file descriptor >= 3.");
      }
      options.artifactStreamFd = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.sourceDateEpoch) || options.sourceDateEpoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return options;
}

function writeAll(fd, content) {
  let offset = 0;
  while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
}

async function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const acceptanceSourceBefore = await fingerprintAcceptanceSource(repoRoot);
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  if (packageJson.version !== RELEASE_VERSION) {
    throw new Error(`Expected package version ${RELEASE_VERSION}, received ${String(packageJson.version)}.`);
  }

  const selectedPaths = await enumerateReleaseFiles(repoRoot);
  const sourceEntries = [];
  const findings = [];
  for (const relativePath of selectedPaths) {
    const absolutePath = resolve(repoRoot, relativePath);
    const [content, stat] = await Promise.all([readFile(absolutePath), lstat(absolutePath)]);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input changed type: ${relativePath}`);
    findings.push(...scanReleaseContent(relativePath, content));
    sourceEntries.push({
      path: relativePath,
      content,
      mode: normalizedMode(stat.mode),
      size: content.length,
      sha256: sha256(content),
    });
  }
  if (findings.length > 0) {
    throw new Error(`Release source scan failed: ${JSON.stringify(findings)}`);
  }
  const acceptanceSourceAfter = await fingerprintAcceptanceSource(repoRoot);
  if (acceptanceSourceAfter.sha256 !== acceptanceSourceBefore.sha256) {
    throw new Error("Release source changed while the bundle inputs were being captured.");
  }

  const archiveEntries = sourceEntries.map((entry) => ({
    path: `${RELEASE_ROOT}/${entry.path}`,
    content: entry.content,
    mode: entry.mode,
  }));
  const archive = createDeterministicTarGz(archiveEntries, { sourceDateEpoch: options.sourceDateEpoch });
  const archiveName = `${RELEASE_BASENAME}.tar.gz`;
  const manifestName = `${RELEASE_BASENAME}.manifest.json`;
  const buildIdentityName = `${RELEASE_BASENAME}.build-identity.json`;
  const checksumName = `${RELEASE_BASENAME}.sha256`;
  const archiveSha256 = sha256(archive);
  const manifest = {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      version: RELEASE_VERSION,
      kind: "SOURCE_REBUILD",
    },
    acceptanceSource: {
      algorithm: acceptanceSourceAfter.algorithm,
      sha256: acceptanceSourceAfter.sha256,
      fileCount: acceptanceSourceAfter.file_count,
      roots: acceptanceSourceAfter.roots,
    },
    reproducibility: {
      sourceDateEpoch: options.sourceDateEpoch,
      gzipMtime: 0,
      normalizedFileModes: true,
      sortedEntries: true,
    },
    archive: {
      filename: archiveName,
      root: RELEASE_ROOT,
      sha256: archiveSha256,
      sizeBytes: archive.length,
    },
    policy: {
      allowlistMode: true,
      excludesBuildOutputs: true,
      excludesPopulatedLocalEnvironmentFiles: true,
      includesPlaceholderEnvironmentTemplates: ["config/.env.example", "deploy/env.vps.example"],
      excludesGitAndEvidence: true,
      excludesLegacyPersonalDomainConfig: true,
      secretFindingCount: 0,
      legacyDomainFindingCount: 0,
    },
    summary: {
      fileCount: sourceEntries.length,
      uncompressedSourceBytes: sourceEntries.reduce((total, entry) => total + entry.size, 0),
    },
    files: sourceEntries.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.size,
      mode: entry.mode.toString(8).padStart(4, "0"),
      sha256: entry.sha256,
    })),
  };
  const manifestContent = Buffer.from(stableJson(manifest), "utf8");
  const manifestFindings = scanReleaseContent(manifestName, manifestContent);
  if (manifestFindings.length > 0) {
    throw new Error(`Release manifest scan failed: ${JSON.stringify(manifestFindings)}`);
  }
  const manifestSha256 = sha256(manifestContent);
  const runtimeContractPath = resolve(repoRoot, "dist/xeroRelease.js");
  const runtimeContractStat = await lstat(runtimeContractPath).catch(() => undefined);
  if (!runtimeContractStat?.isFile() || runtimeContractStat.isSymbolicLink()) {
    throw new Error("The compiled runtime contract is missing; run npm run build before creating a release bundle.");
  }
  const runtimeContract = await import(`${pathToFileURL(runtimeContractPath).href}?bundle=${acceptanceSourceAfter.sha256}`);
  if (typeof runtimeContract.createXeroBuildIdentity !== "function" ||
      typeof runtimeContract.xeroBuildIdentityHash !== "function") {
    throw new Error("The compiled runtime does not expose the approved build identity contract.");
  }
  const releaseSourceManifestSha256 = sha256(Buffer.from(JSON.stringify(
    sourceEntries.map((entry) => ({
      path: entry.path,
      size_bytes: entry.size,
      mode: entry.mode.toString(8).padStart(4, "0"),
      sha256: entry.sha256,
    })),
  ), "utf8"));
  const buildIdentity = runtimeContract.createXeroBuildIdentity({
    acceptanceSourceSha256: acceptanceSourceAfter.sha256,
    releaseSourceManifestSha256,
    sourceArchiveSha256: archiveSha256,
    sourceBundleManifestSha256: manifestSha256,
  });
  const buildIdentityContent = Buffer.from(stableJson(buildIdentity), "utf8");
  const buildIdentitySha256 = sha256(buildIdentityContent);
  const semanticBuildIdentityHash = runtimeContract.xeroBuildIdentityHash(buildIdentity);
  const checksumContent = Buffer.from(
    `${archiveSha256}  ${archiveName}\n${manifestSha256}  ${manifestName}\n${buildIdentitySha256}  ${buildIdentityName}\n`,
    "utf8",
  );

  await mkdir(options.outputDirectory, { recursive: true });
  const archivePath = resolve(options.outputDirectory, archiveName);
  const manifestPath = resolve(options.outputDirectory, manifestName);
  const buildIdentityPath = resolve(options.outputDirectory, buildIdentityName);
  const checksumPath = resolve(options.outputDirectory, checksumName);
  await atomicWrite(archivePath, archive);
  await atomicWrite(manifestPath, manifestContent);
  await atomicWrite(buildIdentityPath, buildIdentityContent);
  await atomicWrite(checksumPath, checksumContent);

  const acceptedBuildContext = resolve(options.outputDirectory, "accepted-build-context");
  await rm(acceptedBuildContext, { recursive: true, force: true });
  for (const entry of sourceEntries) {
    const destination = resolve(acceptedBuildContext, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, { mode: entry.mode });
  }
  const identityDirectory = resolve(acceptedBuildContext, ".accepted-release");
  await mkdir(identityDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(identityDirectory, "source.tar.gz"), archive, { mode: 0o600 }),
    writeFile(resolve(identityDirectory, "manifest.json"), manifestContent, { mode: 0o600 }),
    writeFile(resolve(identityDirectory, "build-identity.json"), buildIdentityContent, { mode: 0o600 }),
    writeFile(resolve(identityDirectory, "checksums.sha256"), checksumContent, { mode: 0o600 }),
  ]);

  if (options.artifactStreamFd !== undefined) {
    writeAll(options.artifactStreamFd, createDeterministicTar([
      { path: "source.tar.gz", content: archive, mode: 0o400 },
      { path: "manifest.json", content: manifestContent, mode: 0o400 },
      { path: "build-identity.json", content: buildIdentityContent, mode: 0o400 },
      { path: "checksums.sha256", content: checksumContent, mode: 0o400 },
    ], { sourceDateEpoch: 0 }));
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    version: RELEASE_VERSION,
    archivePath,
    manifestPath,
    buildIdentityPath,
    checksumPath,
    archiveSizeBytes: archive.length,
    fileCount: sourceEntries.length,
    archiveSha256,
    manifestSha256,
    buildIdentitySha256,
    semanticBuildIdentityHash,
    acceptedBuildContext,
    secretFindings: 0,
    legacyDomainFindings: 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
