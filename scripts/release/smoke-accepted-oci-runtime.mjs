#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOciLayoutArtifact } from "../verify-accepted-oci-release.mjs";
import { resolveTrustedLocalDocker } from "./system-docker.mjs";

const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? "argument"} requires a value`);
    if (flag === "--artifact") options.artifact = resolve(value);
    else if (flag === "--receipt") options.receipt = resolve(value);
    else if (flag === "--approved-control-catalog-sha256") options.approvedControlCatalogSha256 = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.artifact || !options.receipt ||
      !/^[a-f0-9]{64}$/u.test(options.approvedControlCatalogSha256 ?? "")) {
    throw new Error("--artifact, --receipt, and --approved-control-catalog-sha256 are required");
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (options.allowFailure || (code === 0 && signal === null)) resolvePromise(result);
      else rejectPromise(new Error(
        `${options.label ?? "OCI_RUNTIME_COMMAND"}_FAILED:${code ?? "null"}:${signal ?? "none"}:` +
        result.stderr.trim().slice(0, 1_000),
      ));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OCI_RUNTIME_RESPONSE_NOT_JSON:${response.status}`);
  }
  return { response, body };
}

function assertRuntimeIdentity(body, receipt, endpoint) {
  if (body?.buildIdentityHash !== receipt.semanticBuildIdentityHash ||
      body?.acceptanceSourceSha256 !== receipt.acceptanceSourceSha256 ||
      body?.sourceArchiveSha256 !== receipt.sourceArchiveSha256) {
    throw new Error(`OCI_RUNTIME_${endpoint}_BUILD_IDENTITY_MISMATCH`);
  }
  if (body?.approvedControlCatalogSha256 !== receipt.approvedControlCatalogSha256) {
    throw new Error(`OCI_RUNTIME_${endpoint}_CONTROL_CATALOG_MISMATCH`);
  }
}

export function localDockerImageIdForOci(verified) {
  const manifestDigest = verified?.ociManifestDigest;
  const configDigest = verified?.configDigest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(manifestDigest ?? "") ||
      !/^sha256:[a-f0-9]{64}$/u.test(configDigest ?? "")) {
    throw new Error("OCI_RUNTIME_IMAGE_DESCRIPTOR_INVALID");
  }
  // Docker imports this single-manifest OCI archive with the manifest digest
  // as the immutable local image ID. The config digest identifies the config
  // blob inside the manifest and is not an image reference accepted by Docker.
  return manifestDigest;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [artifactStat, receiptStat, artifact, receiptRaw] = await Promise.all([
    lstat(options.artifact),
    lstat(options.receipt),
    readFile(options.artifact),
    readFile(options.receipt, "utf8"),
  ]);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink() ||
      !receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error("OCI_RUNTIME_ARTIFACT_TYPE_INVALID");
  }
  const receipt = JSON.parse(receiptRaw);
  if (receipt.approvedControlCatalogSha256 !== options.approvedControlCatalogSha256) {
    throw new Error("OCI_RUNTIME_CONTROL_CATALOG_MISMATCH");
  }
  const verified = verifyOciLayoutArtifact(artifact, receipt);
  const loadedImageId = localDockerImageIdForOci(verified);
  if (receipt.schemaVersion !== "xero-accepted-oci-build-receipt:v2" ||
      !/^[a-f0-9]{64}$/u.test(receipt.buildContextTarSha256 ?? "") ||
      !Number.isSafeInteger(receipt.buildContextTarSizeBytes) || receipt.buildContextTarSizeBytes <= 0 ||
      !Number.isSafeInteger(receipt.buildContextEntryCount) || receipt.buildContextEntryCount <= 4 ||
      verified.configDigest !== receipt.ociConfigDigest ||
      JSON.stringify(verified.layerDigests) !== JSON.stringify(receipt.ociLayerDigests)) {
    throw new Error("OCI_RUNTIME_RECEIPT_DESCRIPTOR_MISMATCH");
  }

  const dockerTrust = await resolveTrustedLocalDocker({ workspaceRoot: process.cwd() });
  const docker = dockerTrust.executable;
  const dockerArgs = (...args) => ["--context", dockerTrust.contextName, ...args];
  const dockerOptions = (options = {}) => ({ ...options, env: dockerTrust.environment });
  const token = randomBytes(6).toString("hex");
  const containerName = `xero-mcp-runtime-smoke-${token}`;
  const postgresContainerName = `xero-mcp-runtime-pg-${token}`;
  const networkName = `xero-mcp-runtime-${token}`;
  const databaseUser = `smoke_${token}`;
  const databasePassword = randomBytes(32).toString("base64url");
  const databaseName = `xero_mcp_test_oci_${token}`;
  const databaseUrl = `postgresql://${databaseUser}:${databasePassword}` +
    `@${postgresContainerName}:5432/${databaseName}`;
  const mcpToken = `runtime-smoke-${randomBytes(32).toString("base64url")}`;
  const tokenKey = Buffer.alloc(32, 0x31).toString("base64");
  const confirmationKey = Buffer.alloc(32, 0x32).toString("base64");
  let containerStarted = false;
  let postgresStarted = false;
  let networkCreated = false;
  try {
    await run(docker, dockerArgs("image", "load", "--input", options.artifact), dockerOptions({ label: "OCI_RUNTIME_IMAGE_LOAD" }));
    const image = await run(docker, dockerArgs("image", "inspect", loadedImageId, "--format", "{{.Id}}"), dockerOptions({
      label: "OCI_RUNTIME_IMAGE_INSPECT",
    }));
    if (image.stdout.trim() !== loadedImageId) throw new Error("OCI_RUNTIME_IMAGE_MANIFEST_ID_MISMATCH");

    await run(docker, dockerArgs("network", "create", networkName), dockerOptions({ label: "OCI_RUNTIME_NETWORK_CREATE" }));
    networkCreated = true;
    await run(docker, dockerArgs(
      "run", "-d", "--rm", "--name", postgresContainerName,
      "--network", networkName,
      "-e", `POSTGRES_USER=${databaseUser}`,
      "-e", `POSTGRES_PASSWORD=${databasePassword}`,
      "-e", `POSTGRES_DB=${databaseName}`,
      POSTGRES_IMAGE,
    ), dockerOptions({ label: "OCI_RUNTIME_POSTGRES_START" }));
    postgresStarted = true;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await run(docker, dockerArgs(
        "exec", postgresContainerName, "pg_isready", "-U", databaseUser, "-d", databaseName,
      ), dockerOptions({ allowFailure: true }));
      if (ready.code === 0) break;
      if (attempt === 119) throw new Error("OCI_RUNTIME_POSTGRES_READY_TIMEOUT");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    const postgresImageInspect = await run(docker, dockerArgs(
      "image", "inspect", POSTGRES_IMAGE, "--format", "{{json .RepoDigests}} {{.Id}}",
    ), dockerOptions({ label: "OCI_RUNTIME_POSTGRES_IMAGE_INSPECT" }));
    if (!postgresImageInspect.stdout.includes(
      "postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
    )) {
      throw new Error("OCI_RUNTIME_POSTGRES_IMAGE_DIGEST_MISMATCH");
    }
    await run(docker, dockerArgs(
      "run", "--rm", "--network", networkName,
      "-e", `DATABASE_URL=${databaseUrl}`,
      loadedImageId,
      "npm", "run", "migrate",
    ), dockerOptions({ label: "OCI_RUNTIME_MIGRATION" }));

    const challenge = await run(docker, dockerArgs(
      "run", "--rm", "--entrypoint", "node", loadedImageId,
      "--input-type=module", "--eval",
      "import { XERO_RELEASE_ATTESTATION, XERO_RELEASE_VERSION, parseXeroBuildIdentity, xeroBuildIdentityHash } from './dist/xeroRelease.js';" +
      "import { ledgerAuthoritySnapshotHash } from './dist/domain/ledgerAuthority.js';" +
      "import { TOOL_ALLOWLIST } from './dist/mcp/toolNames.js';" +
      "import { hashObject } from './dist/security/hash.js';" +
      "const identity=parseXeroBuildIdentity(process.env.XERO_BUILD_IDENTITY_JSON);" +
      "const readOnlyAuthoritySnapshotHash=ledgerAuthoritySnapshotHash({providerId:'xero',revision:1,writeKillSwitchEnabled:false,standingDelegations:[]});" +
      "process.stdout.write(JSON.stringify({releaseVersion:XERO_RELEASE_VERSION,releaseAttestationHash:hashObject(XERO_RELEASE_ATTESTATION),requiredMigration:XERO_RELEASE_ATTESTATION.requiredMigration,toolCount:TOOL_ALLOWLIST.length,toolsetHash:hashObject(TOOL_ALLOWLIST),buildIdentityHash:xeroBuildIdentityHash(identity),acceptanceSourceSha256:identity.acceptanceSourceSha256,sourceArchiveSha256:identity.sourceArchiveSha256,approvedControlCatalogSha256:identity.approvedControlCatalogSha256,approvedControlCatalogEnvironmentSha256:process.env.XERO_APPROVED_CONTROL_CATALOG_SHA256,readOnlyAuthoritySnapshotHash}));",
    ), dockerOptions({ label: "OCI_RUNTIME_SOURCE_CHALLENGE" }));
    const challengeResult = JSON.parse(challenge.stdout);
    if (challengeResult.releaseVersion !== receipt.releaseVersion ||
        challengeResult.releaseAttestationHash !== receipt.releaseAttestationHash ||
        challengeResult.requiredMigration !== receipt.requiredMigration ||
        challengeResult.toolCount !== 30 ||
        challengeResult.toolsetHash !== receipt.toolsetHash ||
        challengeResult.buildIdentityHash !== receipt.semanticBuildIdentityHash ||
        challengeResult.acceptanceSourceSha256 !== receipt.acceptanceSourceSha256 ||
        challengeResult.sourceArchiveSha256 !== receipt.sourceArchiveSha256) {
      throw new Error("OCI_RUNTIME_SOURCE_CHALLENGE_MISMATCH");
    }
    if (!/^[a-f0-9]{64}$/u.test(challengeResult.readOnlyAuthoritySnapshotHash ?? "")) {
      throw new Error("OCI_RUNTIME_READ_ONLY_AUTHORITY_SNAPSHOT_INVALID");
    }
    if (challengeResult.approvedControlCatalogSha256 !== receipt.approvedControlCatalogSha256 ||
        challengeResult.approvedControlCatalogEnvironmentSha256 !== receipt.approvedControlCatalogSha256) {
      throw new Error("OCI_RUNTIME_SOURCE_CHALLENGE_CONTROL_CATALOG_MISMATCH");
    }

    const standingDelegationsJson = "[]";
    const standingDelegationsConfigSha256 = createHash("sha256")
      .update(standingDelegationsJson)
      .digest("hex");
    await run(docker, dockerArgs(
      "run", "-d", "--rm", "--name", containerName,
      "--network", networkName,
      "-p", "127.0.0.1::3000",
      "-e", "PUBLIC_BASE_URL=https://runtime-smoke.invalid",
      "-e", `DATABASE_URL=${databaseUrl}`,
      "-e", `MCP_BEARER_TOKEN=${mcpToken}`,
      "-e", "MCP_ALLOWED_ORIGINS=https://runtime-smoke.invalid",
      "-e", "MCP_ALLOWED_HOSTS=runtime-smoke.invalid,127.0.0.1,localhost",
      "-e", "XERO_CLIENT_ID=runtime-smoke-client",
      "-e", "XERO_CLIENT_SECRET=runtime-smoke-secret",
      "-e", "XERO_SCOPES=openid profile email offline_access accounting.settings.read accounting.settings accounting.contacts.read accounting.contacts accounting.invoices.read accounting.invoices accounting.payments.read accounting.manualjournals.read accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read",
      "-e", "XERO_WRITE_ENABLED=false",
      "-e", "XERO_AUTHORITY_REVISION=1",
      "-e", `XERO_STANDING_DELEGATIONS_JSON=${standingDelegationsJson}`,
      "-e", `XERO_STANDING_DELEGATIONS_CONFIG_SHA256=${standingDelegationsConfigSha256}`,
      "-e", `XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256=${challengeResult.readOnlyAuthoritySnapshotHash}`,
      "-e", "XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256=NOT_REQUIRED",
      "-e", `TOKEN_ENCRYPTION_KEY_B64=${tokenKey}`,
      "-e", `XERO_MUTATION_CONFIRMATION_KEY_B64=${confirmationKey}`,
      "-e", "XERO_TARGET_SESSION_REQUIRED=true",
      "-e", "MCP_OAUTH_BROKER_ENABLED=false",
      "-e", "PERSONAL_POC_ONLY=true",
      loadedImageId,
    ), dockerOptions({ label: "OCI_RUNTIME_CONTAINER_START" }));
    containerStarted = true;
    const portResult = await run(docker, dockerArgs("port", containerName, "3000/tcp"), dockerOptions({
      label: "OCI_RUNTIME_PORT_DISCOVERY",
    }));
    const portMatch = portResult.stdout.trim().match(/:(\d+)$/u);
    if (!portMatch) throw new Error("OCI_RUNTIME_PORT_INVALID");
    const origin = `http://127.0.0.1:${portMatch[1]}`;

    let ready;
    let lastReadyObservation;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const running = await run(docker, dockerArgs("inspect", containerName, "--format", "{{.State.Running}} {{.Image}}"), dockerOptions({
        allowFailure: true,
      }));
      if (running.code !== 0 || running.stdout.trim() !== `true ${loadedImageId}`) {
        const logs = await run(docker, dockerArgs("logs", containerName), dockerOptions({ allowFailure: true }));
        throw new Error(`OCI_RUNTIME_CONTAINER_EXITED:${logs.stderr.slice(-2_000)}${logs.stdout.slice(-2_000)}`);
      }
      try {
        const candidate = await fetchJson(`${origin}/readyz`);
        lastReadyObservation = { status: candidate.response.status, body: candidate.body };
        if (candidate.response.status === 200 && candidate.body?.status === "ready") {
          ready = candidate.body;
          break;
        }
      } catch (error) {
        lastReadyObservation = {
          error: error instanceof Error ? error.message : String(error),
        };
        // The exact same loaded artifact is still starting; bounded retry only.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!ready) {
      const logs = await run(docker, dockerArgs("logs", containerName), dockerOptions({ allowFailure: true }));
      throw new Error(
        `OCI_RUNTIME_READY_TIMEOUT:${JSON.stringify(lastReadyObservation ?? null).slice(0, 2_000)}:` +
        `${logs.stderr.slice(-2_000)}${logs.stdout.slice(-2_000)}`,
      );
    }
    const health = await fetchJson(`${origin}/healthz`);
    if (health.response.status !== 200 || health.body?.status !== "ok" ||
        ready.writeMode !== "READ_ONLY" || ready.processWriteGateEnabled !== false ||
        ready.authorityWriteKillSwitchEnabled !== false ||
        ready.requiredMigrationStatus !== "APPLIED" || ready.migrationHead !== ready.requiredMigration ||
        ready.activeAccountingCaseRecoveryProjection?.status !== "COMPATIBLE" ||
        health.body?.toolCount !== 30 || health.body?.toolsetHash !== ready.toolsetHash) {
      throw new Error("OCI_RUNTIME_HEALTH_READINESS_CONTRACT_INVALID");
    }
    assertRuntimeIdentity(health.body, receipt, "HEALTH");
    assertRuntimeIdentity(ready, receipt, "READY");

    const anonymous = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://runtime-smoke.invalid" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    if (anonymous.status !== 401) throw new Error(`OCI_RUNTIME_ANONYMOUS_MCP_NOT_REJECTED:${anonymous.status}`);
    const malformed = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        origin: "https://runtime-smoke.invalid",
      },
      body: "{",
    });
    const malformedBody = await malformed.text();
    if (malformed.status < 400 || malformed.status >= 500) {
      throw new Error(
        `OCI_RUNTIME_MALFORMED_MCP_NOT_REJECTED:${malformed.status}:${malformedBody.slice(0, 1_000)}`,
      );
    }
    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      evidence_boundary: "LOADED_ACCEPTED_OCI_ARTIFACT",
      image_config_digest: verified.configDigest,
      oci_manifest_digest: verified.ociManifestDigest,
      build_identity_hash: receipt.semanticBuildIdentityHash,
      acceptance_source_sha256: receipt.acceptanceSourceSha256,
      source_archive_sha256: receipt.sourceArchiveSha256,
      approved_control_catalog_sha256: receipt.approvedControlCatalogSha256,
      postgres_image: POSTGRES_IMAGE,
      required_migration: ready.requiredMigration,
      tool_count: health.body.toolCount,
      anonymous_mcp_status: anonymous.status,
      malformed_mcp_status: malformed.status,
    }, null, 2)}\n`);
  } finally {
    if (containerStarted) {
      await run(docker, dockerArgs("stop", "--time", "5", containerName), dockerOptions({ allowFailure: true }));
    }
    if (postgresStarted) {
      await run(docker, dockerArgs("stop", "--time", "5", postgresContainerName), dockerOptions({ allowFailure: true }));
    }
    if (networkCreated) await run(docker, dockerArgs("network", "rm", networkName), dockerOptions({ allowFailure: true }));
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
