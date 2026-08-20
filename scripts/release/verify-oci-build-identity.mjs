#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const OCI_LABELS = Object.freeze({
  buildIdentityHash: "io.zcloak.xero.build-identity-hash",
  acceptanceSourceSha256: "io.zcloak.xero.acceptance-source-sha256",
  sourceArchiveSha256: "io.zcloak.xero.source-archive-sha256",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    mode: "runtime",
    buildIdentity: undefined,
    image: undefined,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? "argument"} requires a value`);
    if (flag === "--mode") options.mode = value;
    else if (flag === "--build-identity") options.buildIdentity = resolve(value);
    else if (flag === "--image") options.image = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.buildIdentity || !["contract-only", "runtime"].includes(options.mode)) {
    throw new Error("--build-identity and a supported --mode are required");
  }
  if (options.mode === "runtime" && !options.image) throw new Error("--image is required in runtime mode");
  return options;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim() || signal || code}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const raw = await readFile(options.buildIdentity, "utf8");
  const runtimeContract = await import(`${pathToFileURL(resolve("dist/xeroRelease.js")).href}?oci=${sha256(raw)}`);
  const identity = runtimeContract.parseXeroBuildIdentity(raw);
  const semanticHash = runtimeContract.xeroBuildIdentityHash(identity);
  if (options.mode === "contract-only") {
    process.stdout.write(`${JSON.stringify({ status: "PASS", mode: options.mode, semanticBuildIdentityHash: semanticHash })}\n`);
    return;
  }
  if (!/^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u.test(options.image)) {
    throw new Error("OCI_IMAGE_REFERENCE_MUST_USE_REPO_DIGEST");
  }
  const inspection = JSON.parse(await run("docker", ["image", "inspect", options.image, "--format", "{{json .}}"]));
  const repoDigests = inspection.RepoDigests;
  if (!Array.isArray(repoDigests) || !repoDigests.includes(options.image)) {
    throw new Error("OCI_RUNNING_IMAGE_REPODIGEST_MISMATCH");
  }
  const labels = inspection.Config?.Labels ?? {};
  const expectedLabels = {
    [OCI_LABELS.buildIdentityHash]: semanticHash,
    [OCI_LABELS.acceptanceSourceSha256]: identity.acceptanceSourceSha256,
    [OCI_LABELS.sourceArchiveSha256]: identity.sourceArchiveSha256,
  };
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (labels[key] !== value) throw new Error(`OCI_IMAGE_LABEL_MISMATCH:${key}`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    mode: options.mode,
    image: options.image,
    semanticBuildIdentityHash: semanticHash,
    acceptanceSourceSha256: identity.acceptanceSourceSha256,
    sourceArchiveSha256: identity.sourceArchiveSha256,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
