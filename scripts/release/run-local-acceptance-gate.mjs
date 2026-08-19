#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertSafeTestDatabaseUrl,
  assertAcceptanceSnapshotIntegrity,
  createImmutableAcceptanceSnapshot,
  createLocalAcceptancePlan,
  displayCommand,
  fingerprintAcceptanceSource,
  redactEvidenceBuffer,
  requiredSuiteContainsConditionalSkip,
  runStepsFailClosed,
  safeEvidenceLogName,
  sha256Buffer,
  validateLocalAgentEvidence,
  validateProcessCrashRestartEvidence,
  verifyLocalAgentExecutableIdentity,
  verifyLocalAgentRawSemantics,
  verifyEvidenceArtifactFiles,
  REQUIRED_GATE_STEP_IDS,
} from "./local-acceptance-gate-lib.mjs";
import { recomputeProcessCrashEvidenceFromRaw } from "./process-crash-evidence-lib.mjs";
import { verifyOciLayoutArtifact } from "../verify-accepted-oci-release.mjs";
import {
  createDeterministicTar,
  enumerateReleaseFiles,
  normalizedMode,
  parseDeterministicTarGz,
  parseTarArchive,
  RELEASE_ROOT,
  sha256 as releaseSha256,
} from "./release-bundle-lib.mjs";
import { assertApprovedLocalBuilderReceipt } from "../approved-local-builder-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");

function timestampSlug() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function parseArguments(argv) {
  const roundDirectory = resolve(repoRoot, "artifacts/ledger-kernel-review/round-2026-08-13-local");
  const options = {
    evidenceDirectory: resolve(repoRoot, `artifacts/local-acceptance/${timestampSlug()}`),
    localAgentEvidencePath: resolve(roundDirectory, "local-agent-run.json"),
    processCrashRestartEvidencePath: resolve(roundDirectory, "process-crash-restart.json"),
  };
  // `--traceability` was removed with the traceability-closed gate step: the
  // requirements-traceability document it used to point at is no longer read
  // by this command at all, and a flag that silently did nothing would be its
  // own small dishonesty. The document is still checked - on demand, via
  // `npm run validate:traceability -- --file <path>` - just not from here.
  const keys = new Map([
    ["--evidence-dir", "evidenceDirectory"],
    ["--local-agent-evidence", "localAgentEvidencePath"],
    ["--process-crash-restart-evidence", "processCrashRestartEvidencePath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    if ([
      "--approved-control-catalog-sha256",
      "--approved-review-codex-sha256",
      "--approved-review-runtime-sha256",
    ].includes(argv[index])) {
      const value = argv[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error(`${argv[index]} requires a SHA-256 digest`);
      }
      const field = new Map([
        ["--approved-control-catalog-sha256", "approvedControlCatalogSha256"],
        ["--approved-review-codex-sha256", "approvedReviewCodexSha256"],
        ["--approved-review-runtime-sha256", "approvedReviewRuntimeSha256"],
      ]).get(argv[index]);
      options[field] = value;
      index += 1;
      continue;
    }
    const key = keys.get(argv[index]);
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argv[index]} requires a path`);
    options[key] = resolve(value);
    index += 1;
  }
  // The reviewer identity hashes pin which Codex build and runtime performed an
  // independent review. This gate no longer runs one - the manifest says so
  // outright with independent_review_authority LOCAL_EVIDENCE_UNTRUSTED - so
  // demanding them forces an operator to invent a digest for a reviewer that was
  // never invoked, and the receipt then carries an attestation nobody earned.
  // A host that does run the review may still supply them and have them pinned.
  if ([
    options.approvedControlCatalogSha256,
  ].some((value) => value === undefined)) {
    throw new Error(
      "--approved-control-catalog-sha256 is required from the host acceptance boundary",
    );
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

async function releaseArtifactIdentity(
  acceptedBuildContextRoot,
  ociArtifactRoot,
  sourceSnapshotRoot,
  expectedSourceFingerprint,
  approvedControlCatalogSha256,
) {
  const [archive, bundleManifest, buildIdentity, checksum, ociArtifact, ociMetadata, ociReceiptContent] = await Promise.all([
    readFile(resolve(acceptedBuildContextRoot, ".accepted-release/source.tar.gz")),
    readFile(resolve(acceptedBuildContextRoot, ".accepted-release/manifest.json")),
    readFile(resolve(acceptedBuildContextRoot, ".accepted-release/build-identity.json")),
    readFile(resolve(acceptedBuildContextRoot, ".accepted-release/checksums.sha256")),
    readFile(resolve(ociArtifactRoot, "oci.tar")),
    readFile(resolve(ociArtifactRoot, "metadata.json")),
    readFile(resolve(ociArtifactRoot, "receipt.json")),
  ]);
  const checksumText = checksum.toString("utf8").trim();
  const declaredArchiveHash = checksumText.split(/\s+/u)[0];
  const archiveHash = sha256Buffer(archive);
  if (declaredArchiveHash !== archiveHash) throw new Error("LOCAL_GATE_RELEASE_CHECKSUM_DIVERGED");
  const parsedManifest = JSON.parse(bundleManifest.toString("utf8"));
  const parsedBuildIdentity = JSON.parse(buildIdentity.toString("utf8"));
  const parsedOciReceipt = JSON.parse(ociReceiptContent.toString("utf8"));
  assertApprovedLocalBuilderReceipt(parsedOciReceipt.builder);
  if (parsedManifest.acceptanceSource?.sha256 !== expectedSourceFingerprint) {
    throw new Error("LOCAL_GATE_RELEASE_SOURCE_FINGERPRINT_DIVERGED");
  }
  const selectedPaths = await enumerateReleaseFiles(sourceSnapshotRoot);
  if (!Array.isArray(parsedManifest.files) || parsedManifest.files.length !== selectedPaths.length ||
      JSON.stringify(parsedManifest.files.map((file) => file.path)) !== JSON.stringify(selectedPaths)) {
    throw new Error("LOCAL_GATE_RELEASE_SOURCE_SELECTION_DIVERGED");
  }
  const releaseSourceEntries = [];
  const trustedBuildContextEntries = [];
  for (const [index, path] of selectedPaths.entries()) {
    const absolute = resolve(acceptedBuildContextRoot, path);
    const sourceAbsolute = resolve(sourceSnapshotRoot, path);
    const [content, stat, sourceContent, sourceStat] = await Promise.all([
      readFile(absolute),
      lstat(absolute),
      readFile(sourceAbsolute),
      lstat(sourceAbsolute),
    ]);
    const expected = parsedManifest.files[index];
    const mode = normalizedMode(stat.mode).toString(8).padStart(4, "0");
    const sourceMode = normalizedMode(sourceStat.mode).toString(8).padStart(4, "0");
    const sha256 = releaseSha256(content);
    if (!stat.isFile() || stat.isSymbolicLink() || expected.sha256 !== sha256 ||
        expected.sizeBytes !== content.length || expected.mode !== mode ||
        !sourceStat.isFile() || sourceStat.isSymbolicLink() || !content.equals(sourceContent) || mode !== sourceMode) {
      throw new Error(`LOCAL_GATE_RELEASE_SOURCE_BYTES_DIVERGED: ${path}`);
    }
    releaseSourceEntries.push({ path, size_bytes: content.length, mode, sha256 });
    trustedBuildContextEntries.push({
      path,
      content: Buffer.from(content),
      mode: Number.parseInt(mode, 8),
    });
  }
  const releaseSourceManifestSha256 = sha256Buffer(Buffer.from(JSON.stringify(releaseSourceEntries), "utf8"));
  if (parsedBuildIdentity.acceptanceSourceSha256 !== expectedSourceFingerprint ||
      parsedBuildIdentity.approvedControlCatalogSha256 !== approvedControlCatalogSha256 ||
      parsedBuildIdentity.releaseSourceManifestSha256 !== releaseSourceManifestSha256 ||
      parsedBuildIdentity.sourceArchiveSha256 !== archiveHash ||
      parsedBuildIdentity.sourceBundleManifestSha256 !== sha256Buffer(bundleManifest) ||
      sha256Buffer(buildIdentity) !== checksumText.split("\n").find((line) =>
        line.endsWith(".build-identity.json"))?.split(/\s+/u)[0]) {
    throw new Error("LOCAL_GATE_RELEASE_BUILD_IDENTITY_DIVERGED");
  }
  const semanticBuildIdentityHash = sha256Buffer(Buffer.from(stableJsonCanonical(parsedBuildIdentity), "utf8"));
  trustedBuildContextEntries.push(
    { path: ".accepted-release/source.tar.gz", content: Buffer.from(archive), mode: 0o644 },
    { path: ".accepted-release/manifest.json", content: Buffer.from(bundleManifest), mode: 0o644 },
    { path: ".accepted-release/build-identity.json", content: Buffer.from(buildIdentity), mode: 0o644 },
    { path: ".accepted-release/checksums.sha256", content: Buffer.from(checksum), mode: 0o644 },
  );
  const trustedBuildContextTar = createDeterministicTar(trustedBuildContextEntries, { sourceDateEpoch: 0 });
  const verifiedOci = verifyOciLayoutArtifact(ociArtifact, parsedOciReceipt);
  if (parsedOciReceipt?.schemaVersion !== "xero-accepted-oci-build-receipt:v2" ||
      parsedOciReceipt.releaseVersion !== parsedBuildIdentity.releaseVersion ||
      parsedOciReceipt.releaseAttestationHash !== parsedBuildIdentity.releaseAttestationHash ||
      parsedOciReceipt.requiredMigration !== parsedBuildIdentity.requiredMigration ||
      parsedOciReceipt.toolsetHash !== parsedBuildIdentity.toolsetHash ||
      parsedOciReceipt.semanticBuildIdentityHash !== semanticBuildIdentityHash ||
      parsedOciReceipt.acceptanceSourceSha256 !== expectedSourceFingerprint ||
      parsedOciReceipt.approvedControlCatalogSha256 !== approvedControlCatalogSha256 ||
      parsedOciReceipt.sourceArchiveSha256 !== archiveHash ||
      parsedOciReceipt.sourceBundleManifestSha256 !== sha256Buffer(bundleManifest) ||
      parsedOciReceipt.releaseSourceManifestSha256 !== releaseSourceManifestSha256 ||
      parsedOciReceipt.buildContextTarSha256 !== sha256Buffer(trustedBuildContextTar) ||
      parsedOciReceipt.buildContextTarSizeBytes !== trustedBuildContextTar.length ||
      parsedOciReceipt.buildContextEntryCount !== trustedBuildContextEntries.length ||
      parsedOciReceipt.ociArtifact?.sha256 !== sha256Buffer(ociArtifact) ||
      parsedOciReceipt.ociArtifact?.sizeBytes !== ociArtifact.length ||
      parsedOciReceipt.buildMetadata?.sha256 !== sha256Buffer(ociMetadata) ||
      parsedOciReceipt.ociConfigDigest !== verifiedOci.configDigest ||
      JSON.stringify(parsedOciReceipt.ociLayerDigests) !== JSON.stringify(verifiedOci.layerDigests) ||
      !/^sha256:[a-f0-9]{64}$/u.test(parsedOciReceipt.ociManifestDigest ?? "")) {
    throw new Error("LOCAL_GATE_OCI_ARTIFACT_IDENTITY_DIVERGED");
  }
  return {
    release_version: "0.4.0-rc.1",
    source_fingerprint_sha256: expectedSourceFingerprint,
    approved_control_catalog_sha256: approvedControlCatalogSha256,
    release_source_manifest_sha256: releaseSourceManifestSha256,
    archive_sha256: archiveHash,
    archive_size_bytes: archive.length,
    bundle_manifest_sha256: sha256Buffer(bundleManifest),
    build_identity_sha256: sha256Buffer(buildIdentity),
    bundle_manifest_file_count: Array.isArray(parsedManifest.files) ? parsedManifest.files.length : null,
    checksum_file_sha256: sha256Buffer(checksum),
    semantic_build_identity_hash: semanticBuildIdentityHash,
    build_context_tar_sha256: parsedOciReceipt.buildContextTarSha256,
    build_context_tar_size_bytes: parsedOciReceipt.buildContextTarSizeBytes,
    build_context_entry_count: parsedOciReceipt.buildContextEntryCount,
    oci_artifact_sha256: sha256Buffer(ociArtifact),
    oci_artifact_size_bytes: ociArtifact.length,
    oci_manifest_digest: parsedOciReceipt.ociManifestDigest,
    oci_metadata_sha256: sha256Buffer(ociMetadata),
    oci_receipt_sha256: sha256Buffer(ociReceiptContent),
    oci_config_digest: verifiedOci.configDigest,
    oci_layer_digests: verifiedOci.layerDigests,
  };
}

function stableJsonCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonCanonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJsonCanonical(child)}`)
    .join(",")}}`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const ARTIFACT_STREAM_MAX_BYTES = 640 * 1024 * 1024;

export function exactArtifactStreamEntries(artifactStream, expectedPaths) {
  const entries = parseTarArchive(artifactStream, {
    maxExpandedBytes: ARTIFACT_STREAM_MAX_BYTES,
    maxEntries: expectedPaths.length,
  });
  const sortedExpectedPaths = [...expectedPaths].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(entries.map((entry) => entry.path)) !== JSON.stringify(sortedExpectedPaths) ||
      entries.some((entry) => entry.mode !== 0o400)) {
    throw new Error("LOCAL_GATE_ARTIFACT_STREAM_CONTRACT_INVALID");
  }
  return new Map(entries.map((entry) => [entry.path, entry.content]));
}

function sourceBundleContextEntries(artifactStream, approvedControlCatalogSha256) {
  const files = exactArtifactStreamEntries(artifactStream, [
    "source.tar.gz",
    "manifest.json",
    "build-identity.json",
    "checksums.sha256",
  ]);
  const archive = files.get("source.tar.gz");
  const manifestContent = files.get("manifest.json");
  const buildIdentityContent = files.get("build-identity.json");
  const checksumContent = files.get("checksums.sha256");
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  const buildIdentity = JSON.parse(buildIdentityContent.toString("utf8"));
  const archiveEntries = parseDeterministicTarGz(archive, {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxEntries: 50_000,
  });
  if (!Array.isArray(manifest.files) || manifest.files.length !== archiveEntries.length ||
      manifest.archive?.sha256 !== sha256Buffer(archive) ||
      buildIdentity.approvedControlCatalogSha256 !== approvedControlCatalogSha256) {
    throw new Error("LOCAL_GATE_SOURCE_BUNDLE_STREAM_IDENTITY_INVALID");
  }
  const contextEntries = manifest.files.map((file, index) => {
    const entry = archiveEntries[index];
    const expectedArchivePath = `${RELEASE_ROOT}/${file.path}`;
    const expectedMode = Number.parseInt(file.mode, 8);
    if (entry.path !== expectedArchivePath || entry.size !== file.sizeBytes ||
        entry.mode !== expectedMode || !entry.content ||
        releaseSha256(entry.content) !== file.sha256) {
      throw new Error(`LOCAL_GATE_SOURCE_BUNDLE_STREAM_FILE_INVALID:${String(file.path)}`);
    }
    return { path: file.path, content: entry.content, mode: expectedMode };
  });
  contextEntries.push(
    { path: ".accepted-release/source.tar.gz", content: archive, mode: 0o400 },
    { path: ".accepted-release/manifest.json", content: manifestContent, mode: 0o400 },
    { path: ".accepted-release/build-identity.json", content: buildIdentityContent, mode: 0o400 },
    { path: ".accepted-release/checksums.sha256", content: checksumContent, mode: 0o400 },
  );
  return contextEntries;
}

function ociArtifactEntries(artifactStream) {
  const files = exactArtifactStreamEntries(artifactStream, ["oci.tar", "metadata.json", "receipt.json"]);
  return [...files.entries()].map(([path, content]) => ({ path, content, mode: 0o400 }));
}

export async function createCapturedArtifactSnapshot(entries, kind, artifactStream) {
  const stagingRoot = await mkdtemp(join(tmpdir(), `xero-gate-${kind.toLowerCase()}-`));
  let snapshot;
  try {
    for (const entry of entries) {
      const target = resolve(stagingRoot, entry.path);
      const rel = relative(stagingRoot, target);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
        throw new Error(`LOCAL_GATE_ARTIFACT_PATH_INVALID:${entry.path}`);
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.content, { flag: "wx", mode: entry.mode });
    }
    const sourceRoots = [...new Set(entries.map((entry) => entry.path.split("/")[0]))]
      .sort((left, right) => left.localeCompare(right, "en"));
    snapshot = await createImmutableAcceptanceSnapshot(stagingRoot, {
      sourceRoots,
      copyDependencies: false,
      copyGitMetadata: false,
    });
    for (const entry of entries) {
      const captured = await readFile(resolve(snapshot.root, entry.path));
      if (!captured.equals(entry.content)) throw new Error(`LOCAL_GATE_ARTIFACT_CAPTURE_DIVERGED:${entry.path}`);
    }
    return {
      kind,
      artifactStreamSha256: sha256Buffer(artifactStream),
      artifactStreamSizeBytes: artifactStream.length,
      snapshot,
      stagingRoot,
      async dispose() {
        await snapshot.dispose();
        await rm(stagingRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await snapshot?.dispose().catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function artifactSnapshotEvidence(captured) {
  return {
    kind: captured.kind,
    artifact_stream_sha256: captured.artifactStreamSha256,
    artifact_stream_size_bytes: captured.artifactStreamSizeBytes,
    source_fingerprint: captured.snapshot.sourceFingerprint,
    original_mutation_events: captured.snapshot.originalMonitor.events(),
    snapshot_mutation_events: captured.snapshot.snapshotMonitor.events(),
    original_watcher_errors: captured.snapshot.originalMonitor.errors(),
    snapshot_watcher_errors: captured.snapshot.snapshotMonitor.errors(),
  };
}

async function assertCapturedArtifactSnapshots(capturedSnapshots) {
  for (const captured of capturedSnapshots) await assertAcceptanceSnapshotIntegrity(captured.snapshot);
}

function replaceStepArgument(plan, stepId, flag, value) {
  const step = plan.find((candidate) => candidate.id === stepId);
  const index = step?.args.indexOf(flag) ?? -1;
  if (!step || index < 0 || index + 1 >= step.args.length) {
    throw new Error(`LOCAL_GATE_PLAN_ARGUMENT_MISSING:${stepId}:${flag}`);
  }
  step.args[index + 1] = value;
}

async function runCommand(step, snapshotRoot) {
  const startedAt = new Date().toISOString();
  const child = spawn(step.command, step.args, {
    cwd: step.cwd ?? snapshotRoot,
    env: { ...process.env, ...(step.env ?? {}) },
    shell: false,
    stdio: step.artifactStreamKind ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const artifactStream = [];
  let artifactStreamSize = 0;
  let artifactStreamTooLarge = false;
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    process.stderr.write(chunk);
  });
  if (step.artifactStreamKind) {
    child.stdio[3].on("data", (chunk) => {
      artifactStreamSize += chunk.length;
      if (artifactStreamSize > ARTIFACT_STREAM_MAX_BYTES) {
        artifactStreamTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      artifactStream.push(chunk);
    });
  }
  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ exitCode: null, signal: null, spawnError: error.message }));
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal, spawnError: null }));
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    stdout: Buffer.concat(stdout),
    stderr: artifactStreamTooLarge
      ? Buffer.concat([...stderr, Buffer.from("\nLOCAL_GATE_ARTIFACT_STREAM_SIZE_LIMIT_EXCEEDED\n", "utf8")])
      : Buffer.concat(stderr),
    artifactStream: Buffer.concat(artifactStream),
    ...outcome,
  };
}

async function validateEvidenceStep(step, expectedSourceFingerprint, snapshotRoot) {
  const startedAt = new Date().toISOString();
  try {
    const content = await readFile(step.evidencePath);
    const document = JSON.parse(content.toString("utf8"));
    if (step.evidenceKind === "LOCAL_AGENT") {
      validateLocalAgentEvidence(document, { expectedSourceFingerprint });
    } else {
      validateProcessCrashRestartEvidence(document, { expectedSourceFingerprint });
    }
    const artifacts = await verifyEvidenceArtifactFiles(document, step.evidencePath, snapshotRoot);
    if (step.evidenceKind === "LOCAL_AGENT") {
      await verifyLocalAgentRawSemantics(document, artifacts, { repoRoot: snapshotRoot });
      await verifyLocalAgentExecutableIdentity(artifacts);
    } else {
      await recomputeProcessCrashEvidenceFromRaw(document, step.evidencePath);
    }
    return {
      status: "PASS",
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: Buffer.from(`${JSON.stringify({ status: "PASS", evidence: step.evidencePath })}\n`),
      stderr: Buffer.alloc(0),
      evidence_sha256: sha256Buffer(content),
    };
  } catch (error) {
    const code = error?.code === "ENOENT"
      ? `${step.evidenceKind}_EVIDENCE_NOT_CAPTURED`
      : error instanceof Error ? error.message : String(error);
    return {
      status: "NOT_CAPTURED",
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`${JSON.stringify({ status: "NOT_CAPTURED", error: code })}\n`),
      evidence_sha256: null,
    };
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  await mkdir(options.evidenceDirectory, { recursive: true });
  const manifestPath = resolve(options.evidenceDirectory, "gate-result.json");
  const snapshot = await createImmutableAcceptanceSnapshot(repoRoot);
  const capturedArtifactSnapshots = [];
  let acceptedBuildContextSnapshot;
  let ociArtifactSnapshot;
  try {
    const sourceBefore = snapshot.sourceFingerprint;
    const gateRunId = randomUUID();
    const liveReviewChallengeSha256 = sha256Buffer(randomBytes(32));
    const snapshotManifestContent = Buffer.from(stableJson(snapshot.sourceManifest), "utf8");
    const snapshotManifestName = "source-snapshot.manifest.json";
    await atomicWrite(resolve(options.evidenceDirectory, snapshotManifestName), snapshotManifestContent);
    const plan = createLocalAcceptancePlan({
      ...options,
      expectedSourceFingerprint: sourceBefore.sha256,
      sourceSnapshotManifestSha256: sha256Buffer(snapshotManifestContent),
      gateRunId,
      liveReviewChallengeSha256,
    });
    // Both claims below predate, and are unconditioned on, any particular step
    // list: they say this LOCAL run never implies Gate L authority and never
    // counts as an independent review, full stop - not "unless these specific
    // steps are present." Removing traceability-closed (this plan's last call
    // into scripts/review/) makes that truer than before, not less true: there
    // is now nothing in this gate that could be mistaken for review evidence in
    // the first place. No value change is warranted here; only the reasoning
    // in scripts/release/local-acceptance-gate-lib.mjs needed updating.
    const manifest = {
      schema_version: "1.1",
      gate: "LOCAL_RELEASE_ACCEPTANCE",
      gate_l_claim: "NOT_IMPLIED",
      independent_review_authority: "LOCAL_EVIDENCE_UNTRUSTED",
      gate_run_id: gateRunId,
      live_review_challenge_sha256: liveReviewChallengeSha256,
      ...(options.approvedReviewCodexSha256
        ? { approved_review_codex_sha256: options.approvedReviewCodexSha256 }
        : {}),
      ...(options.approvedReviewRuntimeSha256
        ? { approved_review_runtime_sha256: options.approvedReviewRuntimeSha256 }
        : {}),
      status: "RUNNING",
      started_at: new Date().toISOString(),
      finished_at: null,
      test_database: database,
      execution_boundary: "DIGEST_NAMED_READ_ONLY_SOURCE_SNAPSHOT",
      approved_control_catalog_sha256: options.approvedControlCatalogSha256,
      source_snapshot: {
        fingerprint: sourceBefore,
        original_mutation_guard: snapshot.originalMutationState,
        immutable_snapshot_mutation_guard: snapshot.snapshotMutationState,
        manifest_file: snapshotManifestName,
        manifest_sha256: sha256Buffer(snapshotManifestContent),
        file_count: snapshot.sourceManifest.files.length,
        dependencies_copied_not_linked: true,
        git_metadata_copied_not_linked: true,
      },
      source_fingerprint_before: sourceBefore,
      source_fingerprint_after: null,
      snapshot_fingerprint_after: null,
      source_mutation_events: [],
      snapshot_mutation_events: [],
      source_watcher_errors: snapshot.originalMonitor.errors(),
      snapshot_watcher_errors: snapshot.snapshotMonitor.errors(),
      generated_artifact_snapshots: [],
      final_integrity_error: null,
      source_stable: null,
      release_artifact_identity: null,
      failed_step_id: null,
      steps: [],
    };
    await atomicWrite(manifestPath, stableJson(manifest));

    const outcome = await runStepsFailClosed(plan, async (step) => {
      process.stdout.write(`\n[local-acceptance] ${step.id}: ${displayCommand(step)}\n`);
      const raw = step.evidencePath
        ? await validateEvidenceStep(step, sourceBefore.sha256, snapshot.root)
        : await runCommand(step, snapshot.root);
      if (raw.exitCode === 0 && step.artifactStreamKind) {
        try {
          if (!Buffer.isBuffer(raw.artifactStream) || raw.artifactStream.length === 0) {
            throw new Error(`LOCAL_GATE_ARTIFACT_STREAM_MISSING:${step.artifactStreamKind}`);
          }
          if (step.artifactStreamKind === "SOURCE_BUNDLE") {
            if (acceptedBuildContextSnapshot) throw new Error("LOCAL_GATE_SOURCE_BUNDLE_STREAM_DUPLICATE");
            acceptedBuildContextSnapshot = await createCapturedArtifactSnapshot(
              sourceBundleContextEntries(raw.artifactStream, options.approvedControlCatalogSha256),
              step.artifactStreamKind,
              raw.artifactStream,
            );
            capturedArtifactSnapshots.push(acceptedBuildContextSnapshot);
            const identityRoot = resolve(acceptedBuildContextSnapshot.snapshot.root, ".accepted-release");
            replaceStepArgument(plan, "release-bundle-verify", "--archive", resolve(identityRoot, "source.tar.gz"));
            replaceStepArgument(plan, "release-bundle-verify", "--manifest", resolve(identityRoot, "manifest.json"));
            replaceStepArgument(plan, "release-bundle-verify", "--build-identity", resolve(identityRoot, "build-identity.json"));
            replaceStepArgument(plan, "release-bundle-verify", "--checksum", resolve(identityRoot, "checksums.sha256"));
            replaceStepArgument(plan, "release-oci-build", "--context", acceptedBuildContextSnapshot.snapshot.root);
          } else if (step.artifactStreamKind === "OCI_RELEASE") {
            if (ociArtifactSnapshot) throw new Error("LOCAL_GATE_OCI_STREAM_DUPLICATE");
            ociArtifactSnapshot = await createCapturedArtifactSnapshot(
              ociArtifactEntries(raw.artifactStream),
              step.artifactStreamKind,
              raw.artifactStream,
            );
            capturedArtifactSnapshots.push(ociArtifactSnapshot);
            replaceStepArgument(
              plan,
              "release-oci-runtime-smoke",
              "--artifact",
              resolve(ociArtifactSnapshot.snapshot.root, "oci.tar"),
            );
            replaceStepArgument(
              plan,
              "release-oci-runtime-smoke",
              "--receipt",
              resolve(ociArtifactSnapshot.snapshot.root, "receipt.json"),
            );
          } else {
            throw new Error(`LOCAL_GATE_ARTIFACT_STREAM_KIND_INVALID:${step.artifactStreamKind}`);
          }
          manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
        } catch (error) {
          raw.status = "FAIL";
          raw.exitCode = 5;
          raw.stderr = Buffer.concat([
            raw.stderr,
            Buffer.from(`\n${error instanceof Error ? error.message : String(error)}\n`, "utf8"),
          ]);
        }
      }
      if (raw.exitCode === 0 && requiredSuiteContainsConditionalSkip(step.id, raw.stdout, raw.stderr)) {
        raw.exitCode = 3;
        raw.stderr = Buffer.concat([
          raw.stderr,
          Buffer.from("\nREQUIRED_SUITE_CONTAINED_CONDITIONAL_SKIP\n", "utf8"),
        ]);
      }
      try {
        await assertAcceptanceSnapshotIntegrity(snapshot);
        await assertCapturedArtifactSnapshots(capturedArtifactSnapshots);
      } catch (error) {
        raw.status = "FAIL";
        raw.exitCode = raw.exitCode === 0 || raw.exitCode === undefined ? 4 : raw.exitCode;
        raw.stderr = Buffer.concat([
          raw.stderr,
          Buffer.from(`\n${error instanceof Error ? error.message : String(error)}\n`, "utf8"),
        ]);
      }
      const stdout = redactEvidenceBuffer(raw.stdout, [process.env.TEST_DATABASE_URL]);
      const stderr = redactEvidenceBuffer(raw.stderr, [process.env.TEST_DATABASE_URL]);
      const stdoutName = safeEvidenceLogName(step.id, "stdout");
      const stderrName = safeEvidenceLogName(step.id, "stderr");
      await Promise.all([
        atomicWrite(resolve(options.evidenceDirectory, stdoutName), stdout),
        atomicWrite(resolve(options.evidenceDirectory, stderrName), stderr),
      ]);
      const status = raw.status ?? (raw.exitCode === 0 ? "PASS" : "FAIL");
      const result = {
        id: step.id,
        status,
        command: displayCommand(step),
        execution_cwd: step.evidencePath
          ? "IMMUTABLE_SOURCE_PLUS_HASH_BOUND_EXTERNAL_EVIDENCE"
          : step.cwd
            ? "MUTATION_GUARDED_ORIGINAL_EVIDENCE_BOUNDARY"
            : "CONTENT_ADDRESSED_SOURCE_SNAPSHOT",
        started_at: raw.startedAt,
        finished_at: raw.finishedAt,
        exit_code: raw.exitCode ?? null,
        signal: raw.signal ?? null,
        spawn_error: raw.spawnError ?? null,
        evidence_sha256: raw.evidence_sha256 ?? null,
        stdout: { file: stdoutName, sha256: sha256Buffer(stdout), size_bytes: stdout.length },
        stderr: { file: stderrName, sha256: sha256Buffer(stderr), size_bytes: stderr.length },
      };
      manifest.steps.push(result);
      manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
      manifest.failed_step_id = status === "PASS" ? null : step.id;
      await atomicWrite(manifestPath, stableJson(manifest));
      return result;
    });

    let sourceAfter = null;
    let snapshotAfter = null;
    let integrityError = null;
    try {
      const integrity = await assertAcceptanceSnapshotIntegrity(snapshot);
      await assertCapturedArtifactSnapshots(capturedArtifactSnapshots);
      sourceAfter = integrity.original_source;
      snapshotAfter = integrity.snapshot_source;
    } catch (error) {
      integrityError = error instanceof Error ? error.message : String(error);
      sourceAfter = await fingerprintAcceptanceSource(repoRoot).catch(() => null);
      snapshotAfter = await fingerprintAcceptanceSource(snapshot.root).catch(() => null);
    }
    manifest.source_fingerprint_after = sourceAfter;
    manifest.snapshot_fingerprint_after = snapshotAfter;
    manifest.source_mutation_events = snapshot.originalMonitor.events();
    manifest.snapshot_mutation_events = snapshot.snapshotMonitor.events();
    manifest.source_watcher_errors = snapshot.originalMonitor.errors();
    manifest.snapshot_watcher_errors = snapshot.snapshotMonitor.errors();
    manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
    let sourceStable = integrityError === null &&
      sourceAfter?.sha256 === sourceBefore.sha256 && snapshotAfter?.sha256 === sourceBefore.sha256;
    manifest.source_stable = sourceStable;
    manifest.status = outcome.status === "PASS" && sourceStable ? "PASS" : "FAIL";
    manifest.failed_step_id = outcome.failed_step_id ?? (sourceStable ? null : "source-stability");
    if (outcome.status === "PASS" && sourceStable) {
      try {
        if (!acceptedBuildContextSnapshot || !ociArtifactSnapshot) {
          throw new Error("LOCAL_GATE_GENERATED_ARTIFACT_SNAPSHOT_MISSING");
        }
        manifest.release_artifact_identity = await releaseArtifactIdentity(
          acceptedBuildContextSnapshot.snapshot.root,
          ociArtifactSnapshot.snapshot.root,
          snapshot.root,
          sourceBefore.sha256,
          options.approvedControlCatalogSha256,
        );
      } catch (error) {
        manifest.status = "FAIL";
        manifest.failed_step_id = "release-artifact-identity";
        manifest.release_artifact_identity = {
          status: "INVALID",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (manifest.status === "PASS") {
        try {
          await assertAcceptanceSnapshotIntegrity(snapshot);
          await assertCapturedArtifactSnapshots(capturedArtifactSnapshots);
        } catch (error) {
          sourceStable = false;
          manifest.status = "FAIL";
          manifest.failed_step_id = "source-stability";
          manifest.source_stable = false;
          manifest.final_integrity_error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    manifest.source_mutation_events = snapshot.originalMonitor.events();
    manifest.snapshot_mutation_events = snapshot.snapshotMonitor.events();
    manifest.source_watcher_errors = snapshot.originalMonitor.errors();
    manifest.snapshot_watcher_errors = snapshot.snapshotMonitor.errors();
    manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
    manifest.finished_at = new Date().toISOString();
    await atomicWrite(manifestPath, stableJson(manifest));
    if (manifest.status === "PASS") {
      try {
        await assertAcceptanceSnapshotIntegrity(snapshot);
        await assertCapturedArtifactSnapshots(capturedArtifactSnapshots);
      } catch (error) {
        sourceStable = false;
        manifest.status = "FAIL";
        manifest.failed_step_id = "source-stability";
        manifest.source_stable = false;
        manifest.source_mutation_events = snapshot.originalMonitor.events();
        manifest.snapshot_mutation_events = snapshot.snapshotMonitor.events();
        manifest.source_watcher_errors = snapshot.originalMonitor.errors();
        manifest.snapshot_watcher_errors = snapshot.snapshotMonitor.errors();
        manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
        manifest.final_integrity_error = error instanceof Error ? error.message : String(error);
        manifest.finished_at = new Date().toISOString();
        await atomicWrite(manifestPath, stableJson(manifest));
      }
    }

    if (manifest.status === "PASS") {
      const unsignedGate = Buffer.from(stableJsonCanonical(manifest), "utf8");
      const gateAcceptanceReceipt = {
        schema_version: "local-acceptance-gate-receipt:v1",
        status: "PASS",
        source_fingerprint_sha256: sourceBefore.sha256,
        gate_result_sha256: sha256Buffer(unsignedGate),
        required_step_ids: REQUIRED_GATE_STEP_IDS,
        approved_control_catalog_sha256: options.approvedControlCatalogSha256,
        ...(options.approvedReviewCodexSha256
          ? { approved_review_codex_sha256: options.approvedReviewCodexSha256 }
          : {}),
        ...(options.approvedReviewRuntimeSha256
          ? { approved_review_runtime_sha256: options.approvedReviewRuntimeSha256 }
          : {}),
        independent_review_authority: manifest.independent_review_authority,
        gate_run_id: manifest.gate_run_id,
        live_review_challenge_sha256: manifest.live_review_challenge_sha256,
        step_receipts: manifest.steps.map((step) => ({
          id: step.id,
          status: step.status,
          stdout_sha256: step.stdout.sha256,
          stderr_sha256: step.stderr.sha256,
        })),
        release_artifact_identity: manifest.release_artifact_identity,
      };
      const receiptContent = Buffer.from(stableJson(gateAcceptanceReceipt), "utf8");
      const receiptName = "accepted-build-context-receipt.json";
      await atomicWrite(resolve(options.evidenceDirectory, receiptName), receiptContent);
      manifest.accepted_build_context_receipt = {
        file: receiptName,
        sha256: sha256Buffer(receiptContent),
        gate_result_sha256: gateAcceptanceReceipt.gate_result_sha256,
      };
      await atomicWrite(manifestPath, stableJson(manifest));
      try {
        await assertAcceptanceSnapshotIntegrity(snapshot);
        await assertCapturedArtifactSnapshots(capturedArtifactSnapshots);
      } catch (error) {
        await rm(resolve(options.evidenceDirectory, receiptName), { force: true });
        sourceStable = false;
        delete manifest.accepted_build_context_receipt;
        manifest.status = "FAIL";
        manifest.failed_step_id = "source-stability";
        manifest.source_stable = false;
        manifest.source_mutation_events = snapshot.originalMonitor.events();
        manifest.snapshot_mutation_events = snapshot.snapshotMonitor.events();
        manifest.source_watcher_errors = snapshot.originalMonitor.errors();
        manifest.snapshot_watcher_errors = snapshot.snapshotMonitor.errors();
        manifest.generated_artifact_snapshots = capturedArtifactSnapshots.map(artifactSnapshotEvidence);
        manifest.final_integrity_error = error instanceof Error ? error.message : String(error);
        manifest.finished_at = new Date().toISOString();
        await atomicWrite(manifestPath, stableJson(manifest));
      }
    }

    process.stdout.write(`${JSON.stringify({
      status: manifest.status,
      failed_step_id: manifest.failed_step_id,
      evidence_directory: options.evidenceDirectory,
      gate_result: manifestPath,
      source_stable: sourceStable,
      execution_boundary: manifest.execution_boundary,
      gate_l_claim: "NOT_IMPLIED",
      independent_review_authority: manifest.independent_review_authority,
    }, null, 2)}\n`);
    if (manifest.status !== "PASS") process.exitCode = 1;
  } finally {
    for (const captured of [...capturedArtifactSnapshots].reverse()) {
      await captured.dispose().catch(() => undefined);
    }
    await snapshot.dispose();
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 2;
  });
}
