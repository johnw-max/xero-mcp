#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyLocalAcceptanceRelease } from "../verify-accepted-oci-release.mjs";

export const PRODUCTION_RELEASE_ENV_PATH = "/etc/xero-accounting-mcp/release.env";
export const PRODUCTION_RELEASE_ARTIFACT_ROOT = "/srv/xero-accounting-mcp/release";

const REQUIRED_ENV_KEYS = Object.freeze([
  "APP_IMAGE",
  "XERO_ACCEPTANCE_GATE_RESULT",
  "XERO_ACCEPTANCE_GATE_RECEIPT",
  "XERO_ACCEPTED_OCI_RECEIPT",
  "XERO_ACCEPTED_OCI_ARTIFACT",
  "XERO_WRITE_ENABLED",
]);

const XERO_AUTONOMOUS_WRITE_ACTIONS = Object.freeze(new Set([
  "supplier_bill.create_draft",
  "customer_invoice.create_draft",
  "quote.create_draft",
  "purchase_order.create_draft",
  "credit_note.create_draft",
  "manual_journal.create_draft",
  "contact.create_basic",
  "contact.update_basic",
  "item.create_basic_untracked",
  "item.update_basic_untracked",
]));

const XERO_FIRM_GOVERNANCE_ACTIONS = Object.freeze(new Set([
  "supplier_bill.create_draft",
  "customer_invoice.create_draft",
  "credit_note.create_draft",
]));

function mode(stat) {
  return Number(stat.mode & 0o7777n);
}

function identity(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    size: stat.size.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  });
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function containedPath(anchor, candidate, errorCode) {
  const absoluteAnchor = resolve(anchor);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteAnchor, absoluteCandidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(errorCode);
  return { absoluteAnchor, absoluteCandidate };
}

function ancestorPaths(anchor, candidate, includeAnchorAncestors) {
  const { absoluteAnchor, absoluteCandidate } = containedPath(
    anchor,
    candidate,
    "PRODUCTION_TRUST_PATH_OUTSIDE_ANCHOR",
  );
  const paths = [];
  if (includeAnchorAncestors) {
    let cursor = absoluteAnchor;
    while (true) {
      paths.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    paths.reverse();
  } else {
    paths.push(absoluteAnchor);
  }
  let cursor = absoluteAnchor;
  for (const segment of relative(absoluteAnchor, dirname(absoluteCandidate)).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    if (!paths.includes(cursor)) paths.push(cursor);
  }
  return paths;
}

export async function assertTrustedDirectoryChain({
  anchor,
  candidate,
  expectedUid = 0,
  includeAnchorAncestors = true,
}) {
  const observed = [];
  for (const path of ancestorPaths(anchor, candidate, includeAnchorAncestors)) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== expectedUid || (mode(stat) & 0o022) !== 0) {
      throw new Error(`PRODUCTION_TRUST_DIRECTORY_UNSAFE:${path}`);
    }
    observed.push(Object.freeze({ path, identity: identity(stat) }));
  }
  return Object.freeze(observed);
}

async function assertDirectoryChainUnchanged(observed) {
  for (const entry of observed) {
    const stat = await lstat(entry.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), entry.identity)) {
      throw new Error(`PRODUCTION_TRUST_DIRECTORY_CHANGED:${entry.path}`);
    }
  }
}

export async function readTrustedRegularFile(path, options) {
  const absolutePath = resolve(path);
  const directoryChain = await assertTrustedDirectoryChain({ ...options, candidate: absolutePath });
  const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const allowedModes = options.allowedModes ?? [0o400, 0o600];
    if (!before.isFile() || before.isSymbolicLink() || Number(before.uid) !== (options.expectedUid ?? 0) ||
        !allowedModes.includes(mode(before))) {
      throw new Error(`PRODUCTION_TRUST_FILE_UNSAFE:${absolutePath}`);
    }
    await options.afterOpen?.({ path: absolutePath, handle, before });
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(identity(before), identity(after)) || !sameIdentity(identity(after), identity(pathAfter))) {
      throw new Error(`PRODUCTION_TRUST_FILE_CHANGED:${absolutePath}`);
    }
    await assertDirectoryChainUnchanged(directoryChain);
    return Object.freeze({ path: absolutePath, content, identity: identity(after) });
  } finally {
    await handle.close();
  }
}

export function parseCapturedReleaseEnvironment(content) {
  const values = new Map();
  for (const [index, raw] of content.toString("utf8").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || values.has(match[1])) throw new Error(`PRODUCTION_RELEASE_ENV_INVALID:${index + 1}`);
    values.set(match[1], match[2]);
  }
  const required = Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => {
    const value = values.get(key);
    if (!value) throw new Error(`PRODUCTION_RELEASE_ENV_REQUIRED:${key}`);
    return [key, value];
  }));
  if (!/^(?:true|false)$/u.test(required.XERO_WRITE_ENABLED)) {
    throw new Error("PRODUCTION_RELEASE_ENV_WRITE_ENABLED_INVALID");
  }
  if (!/^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u.test(required.APP_IMAGE)) {
    throw new Error("PRODUCTION_RELEASE_ENV_APP_IMAGE_INVALID");
  }
  return Object.freeze(required);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function exactIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function exactSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function exactPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function exactTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function exactTrimmedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value === value.trim();
}

function canonicalBase64(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function canonicalBase64Url(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    /^[A-Za-z0-9_-]+$/u.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

function normalizeBusinessReference(value) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

const NON_UNIQUE_PROVIDER_FIELDS = Object.freeze(new Map([
  ["SALES_INVOICE|GENERIC_RECURRING_REFERENCE", "REFERENCE"],
  ["SUPPLIER_BILL|FORMAL_DOCUMENT_NUMBER", "INVOICE_NUMBER"],
  ["SUPPLIER_BILL|GENERIC_RECURRING_REFERENCE", "INVOICE_NUMBER"],
  ["CUSTOMER_CREDIT|GENERIC_RECURRING_REFERENCE", "REFERENCE"],
  ["SUPPLIER_CREDIT|FORMAL_DOCUMENT_NUMBER", "CREDIT_NOTE_NUMBER"],
  ["SUPPLIER_CREDIT|GENERIC_RECURRING_REFERENCE", "CREDIT_NOTE_NUMBER"],
]));

function assertGovernanceTrustKey(key) {
  if (!exactKeys(key, [
    "key_id", "algorithm", "public_key_spki_der_b64", "not_before", "expires_at", "status",
  ]) || !exactIdentifier(key.key_id) || key.algorithm !== "Ed25519" ||
      !canonicalBase64(key.public_key_spki_der_b64) || !exactTimestamp(key.not_before) ||
      !exactTimestamp(key.expires_at) || Date.parse(key.not_before) >= Date.parse(key.expires_at) ||
      !["ACTIVE", "REVOKED"].includes(key.status)) {
    throw new Error("PRODUCTION_GOVERNANCE_TRUST_KEY_INVALID");
  }
}

function assertGovernanceStatusClaims(claims) {
  if (!exactKeys(claims, [
    "provider_id", "issuer_org_id", "issued_at", "expires_at", "active_authorities",
    "revoked_receipt_sha256s",
  ]) || claims.provider_id !== "xero" || !exactIdentifier(claims.issuer_org_id) ||
      !exactTimestamp(claims.issued_at) || !exactTimestamp(claims.expires_at) ||
      !Array.isArray(claims.active_authorities) || claims.active_authorities.length > 10_000 ||
      !Array.isArray(claims.revoked_receipt_sha256s) || claims.revoked_receipt_sha256s.length > 10_000 ||
      !claims.revoked_receipt_sha256s.every(exactSha256)) {
    throw new Error("PRODUCTION_GOVERNANCE_STATUS_CLAIMS_INVALID");
  }
  const coordinates = new Set();
  for (const authority of claims.active_authorities) {
    if (!exactKeys(authority, [
      "tenant_id", "authority_id", "active_revision", "active_receipt_sha256",
    ]) || !exactUuid(authority.tenant_id) || !exactIdentifier(authority.authority_id) ||
        !exactPositiveInteger(authority.active_revision) || !exactSha256(authority.active_receipt_sha256)) {
      throw new Error("PRODUCTION_GOVERNANCE_STATUS_AUTHORITY_INVALID");
    }
    const coordinate = `${authority.tenant_id.toLowerCase()}|${authority.authority_id}`;
    if (coordinates.has(coordinate)) throw new Error("PRODUCTION_GOVERNANCE_STATUS_AUTHORITY_AMBIGUOUS");
    coordinates.add(coordinate);
  }
  if (new Set(claims.revoked_receipt_sha256s).size !== claims.revoked_receipt_sha256s.length) {
    throw new Error("PRODUCTION_GOVERNANCE_STATUS_REVOCATION_AMBIGUOUS");
  }
}

function assertGovernanceReceiptClaims(claims) {
  if (!exactKeys(claims, [
    "provider_id", "tenant_id", "authority_id", "revision", "issuer_org_id", "issuer_role",
    "issued_at", "not_before", "expires_at", "provider_atomic_uniqueness",
    "exclusive_writer_coverage", "writer_set", "firm_governance_statement",
    "recurring_series_authorities",
  ]) || claims.provider_id !== "xero" || !exactUuid(claims.tenant_id) ||
      !exactIdentifier(claims.authority_id) || !exactPositiveInteger(claims.revision) ||
      !exactIdentifier(claims.issuer_org_id) || claims.issuer_role !== "FIRM_GOVERNANCE_AUTHORITY" ||
      claims.provider_atomic_uniqueness !== false || !Array.isArray(claims.exclusive_writer_coverage) ||
      claims.exclusive_writer_coverage.length === 0 || claims.exclusive_writer_coverage.length > 8 ||
      !Array.isArray(claims.writer_set) || claims.writer_set.length === 0 || claims.writer_set.length > 256 ||
      !Array.isArray(claims.recurring_series_authorities) ||
      claims.recurring_series_authorities.length > 10_000 ||
      ![claims.issued_at, claims.not_before, claims.expires_at].every(exactTimestamp)) {
    throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_CLAIMS_INVALID");
  }
  const statement = claims.firm_governance_statement;
  if (!exactKeys(statement, [
    "all_non_enumerated_writers_prohibited", "human_xero_ui_writes_prohibited",
    "external_app_writes_prohibited", "import_writes_prohibited",
  ]) || Object.values(statement).some((value) => value !== true)) {
    throw new Error("PRODUCTION_GOVERNANCE_FIRM_STATEMENT_INVALID");
  }
  const coverage = new Set();
  for (const item of claims.exclusive_writer_coverage) {
    if (!exactKeys(item, [
      "route", "reference_kind", "authoritative_provider_field", "contact_scope",
    ]) || item.contact_scope !== "ALL_TENANT_CONTACTS" ||
        NON_UNIQUE_PROVIDER_FIELDS.get(`${item.route}|${item.reference_kind}`) !==
          item.authoritative_provider_field) {
      throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_COVERAGE_INVALID");
    }
    const coordinate = `${item.route}|${item.reference_kind}`;
    if (coverage.has(coordinate)) throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_COVERAGE_AMBIGUOUS");
    coverage.add(coordinate);
  }
  const writerIds = new Set();
  const coordinationDomains = new Set();
  for (const writer of claims.writer_set) {
    if (!exactKeys(writer, [
      "writer_id", "writer_kind", "workspace_id", "agent_id", "installation_id",
      "coordination_domain_id",
    ]) || !exactIdentifier(writer.writer_id) || writer.writer_kind !== "XERO_MCP_INSTALLATION" ||
        ![writer.workspace_id, writer.agent_id, writer.installation_id].every((value) =>
          exactTrimmedString(value, 255)) ||
        !exactIdentifier(writer.coordination_domain_id)) {
      throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_WRITER_INVALID");
    }
    if (writerIds.has(writer.writer_id)) throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_WRITER_AMBIGUOUS");
    writerIds.add(writer.writer_id);
    coordinationDomains.add(writer.coordination_domain_id);
  }
  if (coordinationDomains.size !== 1) throw new Error("PRODUCTION_GOVERNANCE_COORDINATION_DOMAIN_AMBIGUOUS");
  const seriesCoordinates = new Set();
  for (const series of claims.recurring_series_authorities) {
    if (!exactKeys(series, [
      "authority_id", "revision", "route", "contact_id", "reference",
      "authoritative_provider_field", "normalization_version", "occurrence_key",
    ]) || !exactIdentifier(series.authority_id) || !exactPositiveInteger(series.revision) ||
        !exactUuid(series.contact_id) || !exactTrimmedString(series.reference, 255) ||
        series.normalization_version !== "xero-reference-coordinate:v1" ||
        series.occurrence_key !== "DOCUMENT_DATE" ||
        NON_UNIQUE_PROVIDER_FIELDS.get(`${series.route}|GENERIC_RECURRING_REFERENCE`) !==
          series.authoritative_provider_field) {
      throw new Error("PRODUCTION_GOVERNANCE_RECURRING_AUTHORITY_INVALID");
    }
    const coordinate = `${series.route}|${series.contact_id.toLowerCase()}|${normalizeBusinessReference(series.reference)}`;
    if (seriesCoordinates.has(coordinate)) {
      throw new Error("PRODUCTION_GOVERNANCE_RECURRING_AUTHORITY_AMBIGUOUS");
    }
    seriesCoordinates.add(coordinate);
  }
}

function currentWindow(label, now, issuedAt, notBefore, expiresAt, maxLifetimeMs) {
  const issued = Date.parse(issuedAt);
  const start = Date.parse(notBefore);
  const expiry = Date.parse(expiresAt);
  if (![issued, start, expiry].every(Number.isFinite) || issued > start || start >= expiry ||
      now < start || now >= expiry || expiry - issued > maxLifetimeMs) {
    throw new Error(`PRODUCTION_GOVERNANCE_${label}_NOT_CURRENT`);
  }
}

function verifyGovernanceSignature(label, signature, payload, keys, now) {
  if (!exactKeys(signature, ["algorithm", "key_id", "signature_b64url"]) ||
      signature.algorithm !== "Ed25519" || !exactIdentifier(signature.key_id) ||
      !canonicalBase64Url(signature.signature_b64url)) {
    throw new Error(`PRODUCTION_GOVERNANCE_${label}_SIGNATURE_INVALID`);
  }
  const key = keys.get(signature.key_id);
  if (!key || key.status !== "ACTIVE" || key.algorithm !== "Ed25519") {
    throw new Error(`PRODUCTION_GOVERNANCE_${label}_SIGNING_KEY_UNTRUSTED`);
  }
  currentWindow(`${label}_KEY`, now, key.not_before, key.not_before, key.expires_at, 366 * 24 * 60 * 60 * 1_000);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(key.public_key_spki_der_b64, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error(`PRODUCTION_GOVERNANCE_${label}_SIGNING_KEY_INVALID`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(
    null,
    Buffer.from(payload, "utf8"),
    publicKey,
    Buffer.from(signature.signature_b64url, "base64url"),
  )) throw new Error(`PRODUCTION_GOVERNANCE_${label}_SIGNATURE_INVALID`);
}

export function verifyCapturedGovernanceAuthority({ trustBundle, receipts, status, env, now = new Date() }) {
  const expected = {
    trustBundleSha256: env.XERO_GOVERNANCE_TRUST_BUNDLE_SHA256,
    receiptsSha256: env.XERO_GOVERNANCE_RECEIPTS_SHA256,
    statusSha256: env.XERO_GOVERNANCE_STATUS_SHA256,
  };
  for (const [key, content, expectedKey] of [
    ["trustBundle", trustBundle, "trustBundleSha256"],
    ["receipts", receipts, "receiptsSha256"],
    ["status", status, "statusSha256"],
  ]) {
    if (sha256(content) !== expected[expectedKey]) {
      throw new Error(`PRODUCTION_GOVERNANCE_${key.toUpperCase()}_SHA256_MISMATCH`);
    }
  }
  let trustDocument;
  let receiptDocument;
  let statusDocument;
  try {
    trustDocument = JSON.parse(trustBundle.toString("utf8"));
    receiptDocument = JSON.parse(receipts.toString("utf8"));
    statusDocument = JSON.parse(status.toString("utf8"));
  } catch {
    throw new Error("PRODUCTION_GOVERNANCE_JSON_INVALID");
  }
  if (!exactKeys(trustDocument, [
    "schema_version", "bundle_id", "issuer_org_id", "revision", "issued_at", "expires_at", "keys",
  ]) ||
      trustDocument.schema_version !== "xero-governance-trust-bundle:v1" ||
      !exactIdentifier(trustDocument.bundle_id) || !exactIdentifier(trustDocument.issuer_org_id) ||
      !exactPositiveInteger(trustDocument.revision) || !exactTimestamp(trustDocument.issued_at) ||
      !exactTimestamp(trustDocument.expires_at) || !Array.isArray(trustDocument.keys) ||
      trustDocument.keys.length === 0 || trustDocument.keys.length > 32) {
    throw new Error("PRODUCTION_GOVERNANCE_TRUST_BUNDLE_INVALID");
  }
  currentWindow("TRUST_BUNDLE", now.getTime(), trustDocument.issued_at, trustDocument.issued_at,
    trustDocument.expires_at, 366 * 24 * 60 * 60 * 1_000);
  trustDocument.keys.forEach(assertGovernanceTrustKey);
  const keys = new Map(trustDocument.keys.map((key) => [key.key_id, key]));
  if (keys.size !== trustDocument.keys.length) throw new Error("PRODUCTION_GOVERNANCE_TRUST_KEYS_AMBIGUOUS");
  if (!exactKeys(statusDocument, ["schema_version", "claims", "status_sha256", "signature"]) ||
      statusDocument.schema_version !== "xero-firm-governance-authority-status:v1" ||
      !exactSha256(statusDocument.status_sha256)) {
    throw new Error("PRODUCTION_GOVERNANCE_STATUS_INVALID");
  }
  assertGovernanceStatusClaims(statusDocument.claims);
  if (statusDocument.claims.issuer_org_id !== trustDocument.issuer_org_id) {
    throw new Error("PRODUCTION_GOVERNANCE_STATUS_TRUST_BUNDLE_ISSUER_MISMATCH");
  }
  const computedStatus = sha256(stableJson({ domain: statusDocument.schema_version, claims: statusDocument.claims }));
  if (computedStatus !== statusDocument.status_sha256) throw new Error("PRODUCTION_GOVERNANCE_STATUS_DIGEST_MISMATCH");
  currentWindow("STATUS", now.getTime(), statusDocument.claims.issued_at, statusDocument.claims.issued_at,
    statusDocument.claims.expires_at, 60 * 60 * 1_000);
  verifyGovernanceSignature("STATUS", statusDocument.signature, stableJson({
    domain: "xero-firm-governance-authority-status-signature:v1",
    claims: statusDocument.claims,
    digest: statusDocument.status_sha256,
  }), keys, now.getTime());
  if (!exactKeys(receiptDocument, ["schema_version", "receipts"]) ||
      receiptDocument.schema_version !== "xero-firm-governance-authority-receipt-set:v1" ||
      !Array.isArray(receiptDocument.receipts) || receiptDocument.receipts.length > 10_000) {
    throw new Error("PRODUCTION_GOVERNANCE_RECEIPTS_INVALID");
  }
  const active = new Map(statusDocument.claims.active_authorities.map((authority) => [
    `${authority.tenant_id}|${authority.authority_id}`,
    authority,
  ]));
  const revoked = new Set(statusDocument.claims.revoked_receipt_sha256s);
  for (const receipt of receiptDocument.receipts) {
    if (!exactKeys(receipt, ["schema_version", "claims", "receipt_sha256", "signature"]) ||
        receipt.schema_version !== "xero-firm-governance-authority-receipt:v1" ||
        !exactSha256(receipt.receipt_sha256)) {
      throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_INVALID");
    }
    assertGovernanceReceiptClaims(receipt.claims);
    const computed = sha256(stableJson({ domain: receipt.schema_version, claims: receipt.claims }));
    if (computed !== receipt.receipt_sha256) throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_DIGEST_MISMATCH");
    currentWindow("RECEIPT", now.getTime(), receipt.claims.issued_at, receipt.claims.not_before,
      receipt.claims.expires_at, 24 * 60 * 60 * 1_000);
    verifyGovernanceSignature("RECEIPT", receipt.signature, stableJson({
      domain: "xero-firm-governance-authority-receipt-signature:v1",
      claims: receipt.claims,
      digest: receipt.receipt_sha256,
    }), keys, now.getTime());
    if (receipt.claims.issuer_org_id !== statusDocument.claims.issuer_org_id) {
      throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_STATUS_ISSUER_MISMATCH");
    }
    const current = active.get(`${receipt.claims.tenant_id}|${receipt.claims.authority_id}`);
    if (revoked.has(receipt.receipt_sha256) || !current || current.active_revision !== receipt.claims.revision ||
        current.active_receipt_sha256 !== receipt.receipt_sha256) {
      throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_NOT_ACTIVE");
    }
  }
  if (active.size !== receiptDocument.receipts.length) throw new Error("PRODUCTION_GOVERNANCE_RECEIPT_SET_INCOMPLETE");
  return Object.freeze({ ...expected, receiptCount: receiptDocument.receipts.length });
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: "/root", PATH: "/usr/bin:/bin" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        rejectPromise(new Error(`PRODUCTION_DOCKER_COMMAND_FAILED:${code ?? "null"}:${signal ?? "none"}:${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function trustedProductionDocker(expectedUid) {
  const invokedPath = "/usr/bin/docker";
  try {
    const resolvedPath = await realpath(invokedPath);
    if (resolvedPath !== invokedPath) throw new Error("PRODUCTION_DOCKER_EXECUTABLE_SYMLINK");
    await assertTrustedDirectoryChain({
      anchor: "/usr",
      candidate: invokedPath,
      expectedUid,
      includeAnchorAncestors: true,
    });
    const stat = await lstat(resolvedPath, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && Number(stat.uid) === expectedUid && (mode(stat) & 0o022) === 0) {
      return invokedPath;
    }
  } catch {
    // Only the fixed root-owned system Docker client can perform admission.
  }
  throw new Error("PRODUCTION_DOCKER_EXECUTABLE_UNTRUSTED");
}

export function assertPulledProductionImageIdentity(inspection, env, ociReceipt) {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new Error("PRODUCTION_IMAGE_INSPECTION_INVALID");
  }
  // Docker's classic image store exposes the config digest as `.Id`, while
  // Docker 29 with the containerd image store exposes the exact pulled
  // single-platform manifest digest. Both are content identities pinned by the
  // accepted OCI receipt; no other image ID is admissible.
  const acceptedImageIds = new Set([
    ociReceipt.ociConfigDigest,
    ociReceipt.ociManifestDigest,
  ]);
  if (!Array.isArray(inspection.RepoDigests) || !inspection.RepoDigests.includes(env.APP_IMAGE) ||
      !acceptedImageIds.has(inspection.Id) ||
      !env.APP_IMAGE.endsWith(`@${ociReceipt.ociManifestDigest}`)) {
    throw new Error("PRODUCTION_IMAGE_REPODIGEST_MISMATCH");
  }
  const labels = inspection.Config?.Labels ?? {};
  const expectedLabels = {
    "io.zcloak.xero.build-identity-hash": ociReceipt.semanticBuildIdentityHash,
    "io.zcloak.xero.acceptance-source-sha256": ociReceipt.acceptanceSourceSha256,
    "io.zcloak.xero.source-archive-sha256": ociReceipt.sourceArchiveSha256,
  };
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (labels[key] !== value) throw new Error(`PRODUCTION_IMAGE_LABEL_MISMATCH:${key}`);
  }
  const envValues = inspection.Config?.Env;
  if (!Array.isArray(envValues)) throw new Error("PRODUCTION_IMAGE_ENV_INVALID");
  // The image bakes in the identity of the source it was built from, and that is
  // what the server publishes as its runtime attestation. A deployment env file
  // supplying the same variable silently wins over the baked value, so the server
  // would attest to a build it is not running and have no way to notice. The image
  // is digest-pinned above, which makes its own value the authority here.
  const embeddedIdentityEntry = envValues.find((value) => value.startsWith("XERO_BUILD_IDENTITY_JSON="));
  if (!embeddedIdentityEntry) throw new Error("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_MISSING");
  let embeddedIdentity;
  try {
    embeddedIdentity = JSON.parse(embeddedIdentityEntry.slice("XERO_BUILD_IDENTITY_JSON=".length));
  } catch {
    throw new Error("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_INVALID");
  }
  if (embeddedIdentity?.acceptanceSourceSha256 !== ociReceipt.acceptanceSourceSha256 ||
      embeddedIdentity?.sourceArchiveSha256 !== ociReceipt.sourceArchiveSha256) {
    throw new Error("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_MISMATCH");
  }
  if (env.XERO_BUILD_IDENTITY_JSON !== undefined) {
    let overrideIdentity;
    try {
      overrideIdentity = JSON.parse(env.XERO_BUILD_IDENTITY_JSON);
    } catch {
      throw new Error("PRODUCTION_BUILD_IDENTITY_OVERRIDE_INVALID");
    }
    if (JSON.stringify(overrideIdentity, Object.keys(overrideIdentity).sort()) !==
        JSON.stringify(embeddedIdentity, Object.keys(embeddedIdentity).sort())) {
      throw new Error("PRODUCTION_BUILD_IDENTITY_OVERRIDE_MISMATCH");
    }
  }
  return true;
}

export async function admitProductionDeployment(options = {}) {
  const expectedUid = options.expectedUid ?? 0;
  const releaseEnvPath = resolve(options.releaseEnvPath ?? PRODUCTION_RELEASE_ENV_PATH);
  const artifactRoot = resolve(options.artifactRoot ?? PRODUCTION_RELEASE_ARTIFACT_ROOT);
  const envAnchor = resolve(options.envAnchor ?? dirname(releaseEnvPath));
  const includeAnchorAncestors = options.includeAnchorAncestors !== false;
  const envFile = await readTrustedRegularFile(releaseEnvPath, {
    anchor: envAnchor,
    expectedUid,
    includeAnchorAncestors,
  });
  const env = parseCapturedReleaseEnvironment(envFile.content);
  const artifactSpecs = [
    ["gateResult", env.XERO_ACCEPTANCE_GATE_RESULT, true],
    ["gateReceipt", env.XERO_ACCEPTANCE_GATE_RECEIPT, true],
    ["ociReceipt", env.XERO_ACCEPTED_OCI_RECEIPT, true],
    ["ociArtifact", env.XERO_ACCEPTED_OCI_ARTIFACT, false],
  ];
  const captured = {};
  for (const [key, path, json] of artifactSpecs) {
    containedPath(artifactRoot, path, `PRODUCTION_RELEASE_ARTIFACT_OUTSIDE_ROOT:${key}`);
    const file = await readTrustedRegularFile(path, {
      anchor: artifactRoot,
      expectedUid,
      includeAnchorAncestors,
    });
    captured[key] = json ? JSON.parse(file.content.toString("utf8")) : file.content;
  }
  verifyLocalAcceptanceRelease({
    ...captured,
  });
  if (!env.APP_IMAGE.endsWith(`@${captured.ociReceipt.ociManifestDigest}`)) {
    throw new Error("PRODUCTION_APP_IMAGE_NOT_ACCEPTED_OCI_MANIFEST");
  }
  if (options.verifyDocker !== false) {
    const docker = options.dockerExecutable ?? await trustedProductionDocker(expectedUid);
    const execute = options.executeDocker ?? ((args) => run(docker, ["--host", "unix:///var/run/docker.sock", ...args]));
    await execute(["image", "pull", env.APP_IMAGE]);
    const inspection = JSON.parse(await execute(["image", "inspect", env.APP_IMAGE, "--format", "{{json .}}"]));
    assertPulledProductionImageIdentity(inspection, env, captured.ociReceipt);
  }
  return Object.freeze({
    schemaVersion: "xero-production-deployment-admission:v1",
    status: "PASS",
    appImage: env.APP_IMAGE,
    ociManifestDigest: captured.ociReceipt.ociManifestDigest,
    semanticBuildIdentityHash: captured.ociReceipt.semanticBuildIdentityHash,
    acceptanceSourceSha256: captured.ociReceipt.acceptanceSourceSha256,
    sourceArchiveSha256: captured.ociReceipt.sourceArchiveSha256,
    writeEnabled: env.XERO_WRITE_ENABLED === "true",
  });
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error("PRODUCTION_DEPLOYMENT_ADMISSION_REQUIRES_ROOT");
  if (process.argv.length > 2 && !(process.argv.length === 4 && process.argv[2] === "--format" && process.argv[3] === "fields")) {
    throw new Error("usage: production-deployment-admission.mjs [--format fields]");
  }
  const result = await admitProductionDeployment();
  if (process.argv[3] === "fields") {
    process.stdout.write([
      result.appImage,
      result.ociManifestDigest,
      result.semanticBuildIdentityHash,
      result.acceptanceSourceSha256,
      result.sourceArchiveSha256,
      String(result.writeEnabled),
    ].join("|") + "\n");
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
