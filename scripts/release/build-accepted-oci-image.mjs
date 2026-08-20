#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sealAcceptedBuildContext } from "../verify-accepted-build-context.mjs";
import {
  ociManifestDigestFromArtifact,
  verifyOciLayoutArtifact,
} from "../verify-accepted-oci-release.mjs";
import { createDeterministicTar } from "./release-bundle-lib.mjs";
import { resolveTrustedLocalDocker } from "./system-docker.mjs";
import { assertApprovedLocalBuilderReceipt } from "../approved-local-builder-contract.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    context: undefined,
    output: undefined,
    metadata: undefined,
    receipt: undefined,
    artifactStreamFd: undefined,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? "argument"} requires a value`);
    if (flag === "--context") options.context = resolve(value);
    else if (flag === "--output") options.output = resolve(value);
    else if (flag === "--metadata") options.metadata = resolve(value);
    else if (flag === "--receipt") options.receipt = resolve(value);
    else if (flag === "--artifact-stream-fd" && /^\d+$/u.test(value) && Number.parseInt(value, 10) >= 3) {
      options.artifactStreamFd = Number.parseInt(value, 10);
    }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.context || !options.output || !options.metadata || !options.receipt) {
    throw new Error("--context, --output, --metadata, and --receipt are required");
  }
  return options;
}

function writeAll(fd, content) {
  let offset = 0;
  while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
}

function run(command, args, cwd, environment, stdin, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: environment,
    });
    const stdout = [];
    const stderr = [];
    let stdinWriteError;
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (!options.captureStdout) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr.push(chunk); process.stderr.write(chunk); });
    if (stdin) {
      child.stdin.on("error", (error) => { stdinWriteError = error; });
      child.stdin.end(stdin);
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (stdinWriteError) {
        reject(new Error(`BUILD_CONTEXT_STDIN_WRITE_FAILED:${stdinWriteError.message}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim() || signal || code}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const verified = await sealAcceptedBuildContext({
    root: options.context,
  });
  const buildContextTar = createDeterministicTar(verified.sealedEntries, { sourceDateEpoch: 0 });
  const sealedByPath = new Map(verified.sealedEntries.map((entry) => [entry.path, entry.content]));
  const dockerTrust = await resolveTrustedLocalDocker({ workspaceRoot: options.context, requireBuilder: true });
  const docker = dockerTrust.executable;
  const identityRaw = sealedByPath.get(".accepted-release/build-identity.json")?.toString("utf8");
  if (!identityRaw) throw new Error("SEALED_BUILD_IDENTITY_MISSING");
  const buildIdentity = JSON.parse(identityRaw);
  const dockerfile = sealedByPath.get("deploy/Dockerfile");
  const lockfile = sealedByPath.get("package-lock.json");
  if (!dockerfile || !lockfile) throw new Error("SEALED_BUILD_INPUT_MISSING");
  if (/^\s*#\s*syntax=/mu.test(dockerfile.toString("utf8"))) {
    throw new Error("MUTABLE_DOCKERFILE_FRONTEND_FORBIDDEN");
  }
  const buildResult = await run(docker, [
      "--context", dockerTrust.contextName,
      "buildx", "build", "--builder", dockerTrust.builder.name,
      "--progress=plain",
      "--platform", "linux/amd64",
      "--provenance=false",
      "--build-arg", `XERO_BUILD_IDENTITY_JSON=${identityRaw.trimEnd()}`,
      "--build-arg", `XERO_BUILD_IDENTITY_HASH=${verified.semanticBuildIdentityHash}`,
      "--build-arg", `XERO_ACCEPTANCE_SOURCE_SHA256=${verified.acceptanceSourceSha256}`,
      "--build-arg", `XERO_SOURCE_ARCHIVE_SHA256=${verified.sourceArchiveSha256}`,
      "--output", "type=oci,dest=-,tar=true,name=zcloak/xero-accounting-mcp:accepted",
      "--no-cache",
      "-f", "deploy/Dockerfile",
      "-",
    ], options.context, dockerTrust.environment, buildContextTar, { captureStdout: true });
  const oci = buildResult.stdout;
  const ociManifestDigest = ociManifestDigestFromArtifact(oci);
  const dockerTrustAfterBuild = await resolveTrustedLocalDocker({
    workspaceRoot: options.context,
    requireBuilder: true,
  });
  const builderBefore = assertApprovedLocalBuilderReceipt(dockerTrust.builderReceipt);
  const builderAfter = assertApprovedLocalBuilderReceipt(dockerTrustAfterBuild.builderReceipt);
  if (builderBefore.approvedContractSha256 !== builderAfter.approvedContractSha256 ||
      builderBefore.observationSha256 !== builderAfter.observationSha256) {
    throw new Error("LOCAL_BUILDER_CHANGED_DURING_BUILD");
  }
  const verifiedOci = verifyOciLayoutArtifact(oci, {
    ociManifestDigest,
    semanticBuildIdentityHash: verified.semanticBuildIdentityHash,
    acceptanceSourceSha256: verified.acceptanceSourceSha256,
    sourceArchiveSha256: verified.sourceArchiveSha256,
  });
  const metadataRaw = `${JSON.stringify({
    schemaVersion: "xero-captured-oci-build-metadata:v1",
    ociManifestDigest,
    ociConfigDigest: verifiedOci.configDigest,
    ociLayerDigests: verifiedOci.layerDigests,
    builderContractSha256: builderAfter.approvedContractSha256,
    builderObservationSha256: builderAfter.observationSha256,
  }, null, 2)}\n`;
  const receipt = {
    schemaVersion: "xero-accepted-oci-build-receipt:v2",
    releaseVersion: buildIdentity.releaseVersion,
    releaseAttestationHash: buildIdentity.releaseAttestationHash,
    requiredMigration: buildIdentity.requiredMigration,
    toolsetHash: buildIdentity.toolsetHash,
    semanticBuildIdentityHash: verified.semanticBuildIdentityHash,
    acceptanceSourceSha256: verified.acceptanceSourceSha256,
    sourceArchiveSha256: verified.sourceArchiveSha256,
    sourceBundleManifestSha256: verified.sourceBundleManifestSha256,
    releaseSourceManifestSha256: verified.releaseSourceManifestSha256,
    buildContextTarSha256: sha256(buildContextTar),
    buildContextTarSizeBytes: buildContextTar.length,
    buildContextEntryCount: verified.sealedEntries.length,
    dockerfileSha256: sha256(dockerfile),
    lockfileSha256: sha256(lockfile),
    builder: dockerTrust.builderReceipt,
    ociArtifact: { filename: basename(options.output), sha256: sha256(oci), sizeBytes: oci.length },
    ociManifestDigest,
    ociConfigDigest: verifiedOci.configDigest,
    ociLayerDigests: verifiedOci.layerDigests,
    buildMetadata: { filename: basename(options.metadata), sha256: sha256(Buffer.from(metadataRaw, "utf8")) },
  };
  const receiptContent = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await atomicWrite(options.output, oci);
  await atomicWrite(options.metadata, metadataRaw);
  await atomicWrite(options.receipt, receiptContent);
  if (options.artifactStreamFd !== undefined) {
    writeAll(options.artifactStreamFd, createDeterministicTar([
      { path: "oci.tar", content: oci, mode: 0o400 },
      { path: "metadata.json", content: Buffer.from(metadataRaw, "utf8"), mode: 0o400 },
      { path: "receipt.json", content: receiptContent, mode: 0o400 },
    ], { sourceDateEpoch: 0 }));
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", ...receipt }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
