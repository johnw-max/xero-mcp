#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REQUIRED_GATE_STEP_IDS } from "./local-acceptance-contract.mjs";
import { assertApprovedLocalBuilderReceipt } from "./approved-local-builder-contract.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIRECTORY_PATHS = new Set(["blobs/", "blobs/sha256/"]);
const OCI_REGULAR_PATH = /^(?:oci-layout|index\.json|blobs\/sha256\/[a-f0-9]{64})$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableCanonical(child)}`)
    .join(",")}}`;
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul >= 0 ? nul : field.length).toString("utf8");
}

function readTarOctal(header, offset, length, fieldName) {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`OCI_TAR_${fieldName.toUpperCase()}_INVALID`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`OCI_TAR_${fieldName.toUpperCase()}_UNSAFE`);
  return parsed;
}

function isZeroBlock(block) {
  return block.length === 512 && block.every((byte) => byte === 0);
}

function assertSafeOciRegularPath(path) {
  if (!OCI_REGULAR_PATH.test(path) || posix.isAbsolute(path) || posix.normalize(path) !== path) {
    throw new Error(`OCI_TAR_REGULAR_PATH_INVALID:${path}`);
  }
}

/**
 * Parses the deliberately tiny OCI-layout tar dialect emitted by Buildx.
 * Source-release archives intentionally use a different, regular-file-only parser.
 */
export function parseOciLayoutTar(tar, options = {}) {
  const maxArtifactBytes = options.maxArtifactBytes ?? 512 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 20_000;
  if (!Buffer.isBuffer(tar)) throw new TypeError("OCI_TAR_BUFFER_REQUIRED");
  if (tar.length > maxArtifactBytes) throw new Error("OCI_TAR_SIZE_LIMIT_EXCEEDED");
  const entries = [];
  const seen = new Set();
  const directories = new Set();
  let offset = 0;
  let endMarkerSeen = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      const second = tar.subarray(offset + 512, offset + 1024);
      if (!isZeroBlock(second)) throw new Error("OCI_TAR_END_MARKER_INVALID");
      if (!tar.subarray(offset + 1024).every((byte) => byte === 0)) {
        throw new Error("OCI_TAR_TRAILING_DATA");
      }
      endMarkerSeen = true;
      break;
    }

    const storedChecksum = readTarOctal(header, 148, 8, "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const calculatedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== calculatedChecksum) throw new Error("OCI_TAR_CHECKSUM_MISMATCH");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (seen.has(path)) throw new Error(`OCI_TAR_DUPLICATE_ENTRY:${path}`);
    seen.add(path);
    const type = header[156];
    const size = readTarOctal(header, 124, 12, "size");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error(`OCI_TAR_ENTRY_TRUNCATED:${path}`);

    if (type === "5".charCodeAt(0)) {
      if (!OCI_DIRECTORY_PATHS.has(path) || size !== 0) {
        throw new Error(`OCI_TAR_DIRECTORY_INVALID:${path}`);
      }
      directories.add(path);
    } else if (type === 0 || type === "0".charCodeAt(0)) {
      assertSafeOciRegularPath(path);
      entries.push({ path, content: Buffer.from(tar.subarray(contentStart, contentEnd)) });
    } else {
      throw new Error(`OCI_TAR_ENTRY_TYPE_FORBIDDEN:${path}:${String.fromCharCode(type)}`);
    }
    if (seen.size > maxEntries) throw new Error("OCI_TAR_ENTRY_LIMIT_EXCEEDED");
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (!endMarkerSeen) throw new Error("OCI_TAR_END_MARKER_MISSING");
  if ([...OCI_DIRECTORY_PATHS].some((path) => !directories.has(path))) {
    throw new Error("OCI_TAR_REQUIRED_DIRECTORIES_MISSING");
  }
  return entries;
}

export function ociManifestDigestFromArtifact(ociArtifact) {
  const entries = new Map(parseOciLayoutTar(ociArtifact).map((entry) => [entry.path, entry.content]));
  const indexBytes = entries.get("index.json");
  if (!indexBytes) throw new Error("OCI_LAYOUT_INDEX_MISSING");
  const index = JSON.parse(indexBytes.toString("utf8"));
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(index.manifests[0]?.digest ?? "")) {
    throw new Error("OCI_LAYOUT_INDEX_INVALID");
  }
  return index.manifests[0].digest;
}

function blobForDigest(entries, descriptor, label) {
  if (!descriptor || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.digest ?? "") ||
      !Number.isInteger(descriptor.size) || descriptor.size < 1) {
    throw new Error(`OCI_${label}_DESCRIPTOR_INVALID`);
  }
  const digest = descriptor.digest.slice("sha256:".length);
  const blob = entries.get(`blobs/sha256/${digest}`);
  if (!blob || blob.length !== descriptor.size || sha256(blob) !== digest) {
    throw new Error(`OCI_${label}_BLOB_MISMATCH`);
  }
  return blob;
}

export function verifyOciLayoutArtifact(ociArtifact, expected) {
  const parsedEntries = parseOciLayoutTar(ociArtifact);
  const entries = new Map(parsedEntries.map((entry) => [entry.path, entry.content]));
  if (entries.size !== parsedEntries.length || !entries.has("oci-layout") || !entries.has("index.json")) {
    throw new Error("OCI_LAYOUT_REQUIRED_FILES_INVALID");
  }
  const layout = JSON.parse(entries.get("oci-layout").toString("utf8"));
  const index = JSON.parse(entries.get("index.json").toString("utf8"));
  if (layout.imageLayoutVersion !== "1.0.0" || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error("OCI_LAYOUT_INDEX_INVALID");
  }
  const manifestDescriptor = index.manifests[0];
  const manifestBlob = blobForDigest(entries, manifestDescriptor, "MANIFEST");
  if (manifestDescriptor.digest !== expected.ociManifestDigest) {
    throw new Error("OCI_MANIFEST_DIGEST_DIVERGED");
  }
  const manifest = JSON.parse(manifestBlob.toString("utf8"));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length < 1) {
    throw new Error("OCI_MANIFEST_INVALID");
  }
  const configBlob = blobForDigest(entries, manifest.config, "CONFIG");
  for (const [indexValue, layer] of manifest.layers.entries()) blobForDigest(entries, layer, `LAYER_${indexValue}`);
  const referencedBlobs = new Set([
    manifestDescriptor.digest.slice(7),
    manifest.config.digest.slice(7),
    ...manifest.layers.map((layer) => layer.digest.slice(7)),
  ]);
  const observedBlobs = [...entries.keys()]
    .filter((path) => path.startsWith("blobs/sha256/"))
    .map((path) => path.slice("blobs/sha256/".length));
  if (observedBlobs.some((digest) => !referencedBlobs.has(digest))) {
    throw new Error("OCI_LAYOUT_UNREFERENCED_BLOB");
  }
  const config = JSON.parse(configBlob.toString("utf8"));
  const labels = config.config?.Labels ?? {};
  const expectedLabels = {
    "io.zcloak.xero.build-identity-hash": expected.semanticBuildIdentityHash,
    "io.zcloak.xero.acceptance-source-sha256": expected.acceptanceSourceSha256,
    "io.zcloak.xero.source-archive-sha256": expected.sourceArchiveSha256,
    "io.zcloak.xero.approved-control-catalog-sha256": expected.approvedControlCatalogSha256,
  };
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (labels[key] !== value) throw new Error(`OCI_IMAGE_LABEL_MISMATCH:${key}`);
  }
  const environment = config.config?.Env;
  const embedded = Array.isArray(environment)
    ? environment.find((value) => value.startsWith("XERO_BUILD_IDENTITY_JSON="))
    : undefined;
  if (!embedded) throw new Error("OCI_BUILD_IDENTITY_ENV_MISSING");
  const embeddedIdentity = JSON.parse(embedded.slice("XERO_BUILD_IDENTITY_JSON=".length));
  if (sha256(stableCanonical(embeddedIdentity)) !== expected.semanticBuildIdentityHash ||
      embeddedIdentity.acceptanceSourceSha256 !== expected.acceptanceSourceSha256 ||
      embeddedIdentity.sourceArchiveSha256 !== expected.sourceArchiveSha256) {
    throw new Error("OCI_BUILD_IDENTITY_ENV_MISMATCH");
  }
  if (embeddedIdentity.approvedControlCatalogSha256 !== expected.approvedControlCatalogSha256) {
    throw new Error("OCI_BUILD_IDENTITY_CONTROL_CATALOG_MISMATCH");
  }
  const controlCatalogEnvironment = Array.isArray(environment)
    ? environment.find((value) => value.startsWith("XERO_APPROVED_CONTROL_CATALOG_SHA256="))
    : undefined;
  if (controlCatalogEnvironment !==
      `XERO_APPROVED_CONTROL_CATALOG_SHA256=${expected.approvedControlCatalogSha256}`) {
    throw new Error("OCI_CONTROL_CATALOG_ENV_MISMATCH");
  }
  if (config.config?.User !== "10001:10001" ||
      JSON.stringify(config.config?.Cmd) !== JSON.stringify(["npm", "run", "start"])) {
    throw new Error("OCI_RUNTIME_CONFINEMENT_INVALID");
  }
  return Object.freeze({
    ociManifestDigest: manifestDescriptor.digest,
    configDigest: manifest.config.digest,
    layerDigests: manifest.layers.map((layer) => layer.digest),
  });
}

export function assertApprovedControlCatalogChain({
  gateResult,
  gateReceipt,
  ociReceipt,
  approvedControlCatalogSha256,
}) {
  if (!SHA256.test(approvedControlCatalogSha256 ?? "")) {
    throw new Error("APPROVED_CONTROL_CATALOG_SHA256_REQUIRED");
  }
  if (gateResult?.approved_control_catalog_sha256 !== approvedControlCatalogSha256 ||
      gateReceipt?.approved_control_catalog_sha256 !== approvedControlCatalogSha256 ||
      ociReceipt?.approvedControlCatalogSha256 !== approvedControlCatalogSha256) {
    throw new Error("LOCAL_ACCEPTANCE_CONTROL_CATALOG_MISMATCH");
  }
  return true;
}

export function verifyLocalAcceptanceRelease({
  gateResult,
  gateReceipt,
  ociReceipt,
  ociArtifact,
  approvedControlCatalogSha256,
}) {
  assertApprovedControlCatalogChain({
    gateResult,
    gateReceipt,
    ociReceipt,
    approvedControlCatalogSha256,
  });
  if (gateResult?.schema_version !== "1.1" || gateResult.status !== "PASS" ||
      gateResult.source_stable !== true || gateResult.failed_step_id !== null ||
      gateReceipt?.schema_version !== "local-acceptance-gate-receipt:v1" || gateReceipt.status !== "PASS") {
    throw new Error("LOCAL_ACCEPTANCE_RELEASE_NOT_PASSED");
  }
  const withoutReceipt = structuredClone(gateResult);
  delete withoutReceipt.accepted_build_context_receipt;
  if (sha256(stableCanonical(withoutReceipt)) !== gateReceipt.gate_result_sha256) {
    throw new Error("LOCAL_ACCEPTANCE_GATE_RESULT_MISMATCH");
  }
  if (gateReceipt.source_fingerprint_sha256 !== gateResult.source_fingerprint_before?.sha256 ||
      JSON.stringify(gateReceipt.required_step_ids) !== JSON.stringify(REQUIRED_GATE_STEP_IDS) ||
      JSON.stringify(gateResult.steps.map((step) => step.id)) !== JSON.stringify(REQUIRED_GATE_STEP_IDS) ||
      gateResult.steps.some((step) => step.status !== "PASS") ||
      gateReceipt.step_receipts.length !== REQUIRED_GATE_STEP_IDS.length ||
      gateReceipt.step_receipts.some((receipt, index) => {
        const step = gateResult.steps[index];
        return receipt.id !== step.id || receipt.status !== "PASS" ||
          receipt.stdout_sha256 !== step.stdout.sha256 || receipt.stderr_sha256 !== step.stderr.sha256;
      })) {
    throw new Error("LOCAL_ACCEPTANCE_GATE_STEPS_MISMATCH");
  }
  if (stableCanonical(gateReceipt.release_artifact_identity) !== stableCanonical(gateResult.release_artifact_identity)) {
    throw new Error("LOCAL_ACCEPTANCE_RELEASE_IDENTITY_MISMATCH");
  }
  const release = gateResult.release_artifact_identity;
  if (!release || !SHA256.test(release.oci_artifact_sha256 ?? "") ||
      release.oci_artifact_sha256 !== sha256(ociArtifact) ||
      release.oci_artifact_size_bytes !== ociArtifact.length ||
      release.oci_receipt_sha256 !== sha256(Buffer.from(`${JSON.stringify(ociReceipt, null, 2)}\n`, "utf8")) ||
      ociReceipt?.schemaVersion !== "xero-accepted-oci-build-receipt:v2" ||
      ociReceipt.releaseVersion !== "0.4.0-rc.1" ||
      typeof ociReceipt.releaseAttestationHash !== "string" || !SHA256.test(ociReceipt.releaseAttestationHash) ||
      typeof ociReceipt.requiredMigration !== "string" ||
        !/^\d{3}_[a-z0-9_]+\.sql$/u.test(ociReceipt.requiredMigration) ||
      typeof ociReceipt.toolsetHash !== "string" || !SHA256.test(ociReceipt.toolsetHash) ||
      !SHA256.test(ociReceipt.buildContextTarSha256 ?? "") ||
      !Number.isSafeInteger(ociReceipt.buildContextTarSizeBytes) || ociReceipt.buildContextTarSizeBytes <= 0 ||
      !Number.isSafeInteger(ociReceipt.buildContextEntryCount) || ociReceipt.buildContextEntryCount <= 4 ||
      release.build_context_tar_sha256 !== ociReceipt.buildContextTarSha256 ||
      release.build_context_tar_size_bytes !== ociReceipt.buildContextTarSizeBytes ||
      release.build_context_entry_count !== ociReceipt.buildContextEntryCount ||
      ociReceipt.ociArtifact?.sha256 !== release.oci_artifact_sha256 ||
      ociReceipt.ociManifestDigest !== release.oci_manifest_digest ||
      ociReceipt.semanticBuildIdentityHash !== release.semantic_build_identity_hash) {
    throw new Error("LOCAL_ACCEPTANCE_OCI_RECEIPT_MISMATCH");
  }
  if (release.approved_control_catalog_sha256 !== approvedControlCatalogSha256 ||
      ociReceipt.approvedControlCatalogSha256 !== approvedControlCatalogSha256) {
    throw new Error("LOCAL_ACCEPTANCE_OCI_CONTROL_CATALOG_MISMATCH");
  }
  assertApprovedLocalBuilderReceipt(ociReceipt.builder);
  return verifyOciLayoutArtifact(ociArtifact, ociReceipt);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag ?? "argument"} requires a value`);
    if (flag === "--gate-result") options.gateResult = resolve(value);
    else if (flag === "--gate-receipt") options.gateReceipt = resolve(value);
    else if (flag === "--oci-receipt") options.ociReceipt = resolve(value);
    else if (flag === "--oci-artifact") options.ociArtifact = resolve(value);
    else if (flag === "--approved-control-catalog-sha256") options.approvedControlCatalogSha256 = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (Object.keys(options).length !== 5 ||
      !SHA256.test(options.approvedControlCatalogSha256 ?? "")) {
    throw new Error("All local acceptance release artifacts and --approved-control-catalog-sha256 are required");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [gateResult, gateReceipt, ociReceipt, ociArtifact] = await Promise.all([
    readFile(options.gateResult, "utf8").then(JSON.parse),
    readFile(options.gateReceipt, "utf8").then(JSON.parse),
    readFile(options.ociReceipt, "utf8").then(JSON.parse),
    readFile(options.ociArtifact),
  ]);
  const result = verifyLocalAcceptanceRelease({
    gateResult,
    gateReceipt,
    ociReceipt,
    ociArtifact,
    approvedControlCatalogSha256: options.approvedControlCatalogSha256,
  });
  process.stdout.write(`${JSON.stringify({ status: "PASS", ...result })}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
