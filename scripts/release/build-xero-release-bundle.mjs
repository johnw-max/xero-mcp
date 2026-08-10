#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOURCE_DATE_EPOCH,
  RELEASE_BASENAME,
  RELEASE_ROOT,
  RELEASE_VERSION,
  createDeterministicTarGz,
  enumerateReleaseFiles,
  normalizedMode,
  scanReleaseContent,
  sha256,
} from "./release-bundle-lib.mjs";

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
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.sourceDateEpoch) || options.sourceDateEpoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return options;
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

  const archiveEntries = sourceEntries.map((entry) => ({
    path: `${RELEASE_ROOT}/${entry.path}`,
    content: entry.content,
    mode: entry.mode,
  }));
  const archive = createDeterministicTarGz(archiveEntries, { sourceDateEpoch: options.sourceDateEpoch });
  const archiveName = `${RELEASE_BASENAME}.tar.gz`;
  const manifestName = `${RELEASE_BASENAME}.manifest.json`;
  const checksumName = `${RELEASE_BASENAME}.sha256`;
  const archiveSha256 = sha256(archive);
  const manifest = {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      version: RELEASE_VERSION,
      kind: "SOURCE_REBUILD",
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
  const checksumContent = Buffer.from(
    `${archiveSha256}  ${archiveName}\n${manifestSha256}  ${manifestName}\n`,
    "utf8",
  );

  await mkdir(options.outputDirectory, { recursive: true });
  const archivePath = resolve(options.outputDirectory, archiveName);
  const manifestPath = resolve(options.outputDirectory, manifestName);
  const checksumPath = resolve(options.outputDirectory, checksumName);
  await atomicWrite(archivePath, archive);
  await atomicWrite(manifestPath, manifestContent);
  await atomicWrite(checksumPath, checksumContent);

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    version: RELEASE_VERSION,
    archivePath,
    manifestPath,
    checksumPath,
    archiveSizeBytes: archive.length,
    fileCount: sourceEntries.length,
    archiveSha256,
    manifestSha256,
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
