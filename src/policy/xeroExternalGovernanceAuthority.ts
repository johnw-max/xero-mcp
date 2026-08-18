import { createPublicKey, verify } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import {
  LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION,
  type LedgerFirmGovernanceAuthority,
  type LedgerStandingDelegation,
} from "../control-kernel/ledgerControlKernel.js";
import { sha256, stableStringify } from "../security/hash.js";
import {
  XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
  normalizeXeroBusinessReference,
  xeroDocumentCoordinateAuthority,
  type XeroAccountingCaseBusinessAuthorityProfile,
} from "./xeroBusinessCoordinateAuthority.js";

export const XERO_GOVERNANCE_TRUST_BUNDLE_PATH =
  "/run/xero-governance/trust-bundle.json";
export const XERO_GOVERNANCE_RECEIPTS_PATH =
  "/run/xero-governance/receipts.json";
export const XERO_GOVERNANCE_STATUS_PATH =
  "/run/xero-governance/status.json";

export const XERO_GOVERNANCE_TRUST_BUNDLE_VERSION =
  "xero-governance-trust-bundle:v1";
export const XERO_GOVERNANCE_RECEIPT_VERSION =
  "xero-firm-governance-authority-receipt:v1";
export const XERO_GOVERNANCE_RECEIPT_SET_VERSION =
  "xero-firm-governance-authority-receipt-set:v1";
export const XERO_GOVERNANCE_STATUS_VERSION =
  "xero-firm-governance-authority-status:v1";

const RECEIPT_SIGNATURE_DOMAIN = "xero-firm-governance-authority-receipt-signature:v1";
const STATUS_SIGNATURE_DOMAIN = "xero-firm-governance-authority-status-signature:v1";
export const XERO_GOVERNANCE_MAX_RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const XERO_GOVERNANCE_MAX_STATUS_LIFETIME_MS = 60 * 60 * 1_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const routeSchema = z.enum([
  "SALES_INVOICE",
  "SUPPLIER_BILL",
  "CUSTOMER_CREDIT",
  "SUPPLIER_CREDIT",
]);
const providerFieldSchema = z.enum(["INVOICE_NUMBER", "CREDIT_NOTE_NUMBER", "REFERENCE"]);

const canonicalBase64Schema = z.string().min(1).max(4_096).refine((value) => {
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}, "must be canonical base64");

const canonicalBase64UrlSchema = z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    try {
      return Buffer.from(value, "base64url").toString("base64url") === value;
    } catch {
      return false;
    }
  }, "must be canonical base64url");

const signatureSchema = z.object({
  algorithm: z.literal("Ed25519"),
  key_id: identifierSchema,
  signature_b64url: canonicalBase64UrlSchema,
}).strict();

const trustKeySchema = z.object({
  key_id: identifierSchema,
  algorithm: z.literal("Ed25519"),
  public_key_spki_der_b64: canonicalBase64Schema,
  not_before: timestampSchema,
  expires_at: timestampSchema,
  status: z.enum(["ACTIVE", "REVOKED"]),
}).strict();

const trustBundleSchema = z.object({
  schema_version: z.literal(XERO_GOVERNANCE_TRUST_BUNDLE_VERSION),
  bundle_id: identifierSchema,
  issuer_org_id: identifierSchema,
  revision: z.number().int().positive(),
  issued_at: timestampSchema,
  expires_at: timestampSchema,
  keys: z.array(trustKeySchema).min(1).max(32),
}).strict().superRefine((bundle, context) => {
  const ids = bundle.keys.map((key) => key.key_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["keys"], message: "trust key IDs must be unique" });
  }
});

const coverageSchema = z.object({
  route: routeSchema,
  reference_kind: z.enum(["FORMAL_DOCUMENT_NUMBER", "GENERIC_RECURRING_REFERENCE"]),
  authoritative_provider_field: providerFieldSchema,
  contact_scope: z.literal("ALL_TENANT_CONTACTS"),
}).strict();

const writerSchema = z.object({
  writer_id: identifierSchema,
  writer_kind: z.literal("XERO_MCP_INSTALLATION"),
  workspace_id: z.string().trim().min(1).max(255),
  agent_id: z.string().trim().min(1).max(255),
  installation_id: z.string().trim().min(1).max(255),
  coordination_domain_id: identifierSchema,
}).strict();

const recurringSeriesSchema = z.object({
  authority_id: identifierSchema,
  revision: z.number().int().positive(),
  route: routeSchema,
  contact_id: z.string().uuid(),
  reference: z.string().trim().min(1).max(255),
  authoritative_provider_field: providerFieldSchema,
  normalization_version: z.literal(XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION),
  occurrence_key: z.literal("DOCUMENT_DATE"),
}).strict();

const receiptClaimsSchema = z.object({
  provider_id: z.literal("xero"),
  tenant_id: z.string().uuid(),
  authority_id: identifierSchema,
  revision: z.number().int().positive(),
  issuer_org_id: identifierSchema,
  issuer_role: z.literal("FIRM_GOVERNANCE_AUTHORITY"),
  issued_at: timestampSchema,
  not_before: timestampSchema,
  expires_at: timestampSchema,
  provider_atomic_uniqueness: z.literal(false),
  exclusive_writer_coverage: z.array(coverageSchema).min(1).max(8),
  writer_set: z.array(writerSchema).min(1).max(256),
  firm_governance_statement: z.object({
    all_non_enumerated_writers_prohibited: z.literal(true),
    human_xero_ui_writes_prohibited: z.literal(true),
    external_app_writes_prohibited: z.literal(true),
    import_writes_prohibited: z.literal(true),
  }).strict(),
  recurring_series_authorities: z.array(recurringSeriesSchema).max(10_000),
}).strict().superRefine((claims, context) => {
  const coverageCoordinates = claims.exclusive_writer_coverage.map((coverage, index) => {
    const expected = xeroDocumentCoordinateAuthority(coverage.route, coverage.reference_kind);
    if (
      expected.uniquenessAuthority !== "NON_UNIQUE_EXCLUSIVE_WRITER" ||
      expected.authoritativeProviderField !== coverage.authoritative_provider_field
    ) {
      context.addIssue({
        code: "custom",
        path: ["exclusive_writer_coverage", index],
        message: "coverage must identify an exact non-unique route/provider-field coordinate",
      });
    }
    return JSON.stringify([coverage.route, coverage.reference_kind]);
  });
  if (new Set(coverageCoordinates).size !== coverageCoordinates.length) {
    context.addIssue({
      code: "custom",
      path: ["exclusive_writer_coverage"],
      message: "exclusive-writer coverage coordinates must be unique",
    });
  }
  const writerIds = claims.writer_set.map((writer) => writer.writer_id);
  if (new Set(writerIds).size !== writerIds.length) {
    context.addIssue({ code: "custom", path: ["writer_set"], message: "writer IDs must be unique" });
  }
  if (new Set(claims.writer_set.map((writer) => writer.coordination_domain_id)).size !== 1) {
    context.addIssue({
      code: "custom",
      path: ["writer_set"],
      message: "all governed writers must share one coordination domain",
    });
  }
  const seriesCoordinates = claims.recurring_series_authorities.map((authority, index) => {
    const expected = xeroDocumentCoordinateAuthority(authority.route, "GENERIC_RECURRING_REFERENCE");
    if (authority.authoritative_provider_field !== expected.authoritativeProviderField) {
      context.addIssue({
        code: "custom",
        path: ["recurring_series_authorities", index, "authoritative_provider_field"],
        message: `must be ${expected.authoritativeProviderField}`,
      });
    }
    return JSON.stringify([
      authority.route,
      authority.contact_id.toLowerCase(),
      normalizeXeroBusinessReference(authority.reference),
    ]);
  });
  if (new Set(seriesCoordinates).size !== seriesCoordinates.length) {
    context.addIssue({
      code: "custom",
      path: ["recurring_series_authorities"],
      message: "recurring-series coordinates must be unique",
    });
  }
});

const governanceReceiptSchema = z.object({
  schema_version: z.literal(XERO_GOVERNANCE_RECEIPT_VERSION),
  claims: receiptClaimsSchema,
  receipt_sha256: sha256Schema,
  signature: signatureSchema,
}).strict();

const receiptSetSchema = z.object({
  schema_version: z.literal(XERO_GOVERNANCE_RECEIPT_SET_VERSION),
  receipts: z.array(governanceReceiptSchema).max(10_000),
}).strict();

const activeAuthoritySchema = z.object({
  tenant_id: z.string().uuid(),
  authority_id: identifierSchema,
  active_revision: z.number().int().positive(),
  active_receipt_sha256: sha256Schema,
}).strict();

const statusClaimsSchema = z.object({
  provider_id: z.literal("xero"),
  issuer_org_id: identifierSchema,
  issued_at: timestampSchema,
  expires_at: timestampSchema,
  active_authorities: z.array(activeAuthoritySchema).max(10_000),
  revoked_receipt_sha256s: z.array(sha256Schema).max(10_000),
}).strict().superRefine((claims, context) => {
  const coordinates = claims.active_authorities.map((authority) =>
    JSON.stringify([authority.tenant_id.toLowerCase(), authority.authority_id]));
  if (new Set(coordinates).size !== coordinates.length) {
    context.addIssue({ code: "custom", path: ["active_authorities"], message: "active authorities must be unique" });
  }
  if (new Set(claims.revoked_receipt_sha256s).size !== claims.revoked_receipt_sha256s.length) {
    context.addIssue({ code: "custom", path: ["revoked_receipt_sha256s"], message: "revocations must be unique" });
  }
});

const governanceStatusSchema = z.object({
  schema_version: z.literal(XERO_GOVERNANCE_STATUS_VERSION),
  claims: statusClaimsSchema,
  status_sha256: sha256Schema,
  signature: signatureSchema,
}).strict();

export interface XeroExternalGovernanceAuthorityInput {
  readonly trustBundle: Buffer;
  readonly receipts: Buffer;
  readonly status: Buffer;
  readonly expectedTrustBundleSha256: string;
  readonly expectedReceiptsSha256: string;
  readonly expectedStatusSha256: string;
  readonly now: Date;
}

export interface XeroExternalGovernanceAuthoritySet {
  readonly trustBundleSha256: string;
  readonly receiptsSha256: string;
  readonly statusSha256: string;
  readonly authorityProfiles: readonly XeroAccountingCaseBusinessAuthorityProfile[];
  readonly ledgerFirmGovernanceAuthorities: readonly LedgerFirmGovernanceAuthority[];
}

export interface XeroExternalGovernanceExpectedHashes {
  readonly trustBundleSha256: string;
  readonly receiptsSha256: string;
  readonly statusSha256: string;
}

function sameFileIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readFixedGovernanceFile(path: string): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || (before.mode & 0o022) !== 0 || before.size < 2 || before.size > 16 * 1_024 * 1_024) {
      throw new Error(`XERO_GOVERNANCE_RUNTIME_FILE_UNSAFE:${path}`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameFileIdentity(before, after)) throw new Error(`XERO_GOVERNANCE_RUNTIME_FILE_CHANGED:${path}`);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export function loadXeroExternalGovernanceAuthorityFromFixedFiles(
  expected: XeroExternalGovernanceExpectedHashes,
  now = new Date(),
): XeroExternalGovernanceAuthoritySet {
  return verifyXeroExternalGovernanceAuthority({
    trustBundle: readFixedGovernanceFile(XERO_GOVERNANCE_TRUST_BUNDLE_PATH),
    receipts: readFixedGovernanceFile(XERO_GOVERNANCE_RECEIPTS_PATH),
    status: readFixedGovernanceFile(XERO_GOVERNANCE_STATUS_PATH),
    expectedTrustBundleSha256: expected.trustBundleSha256,
    expectedReceiptsSha256: expected.receiptsSha256,
    expectedStatusSha256: expected.statusSha256,
    now,
  });
}

const NON_UNIQUE_COVERAGE_BY_ACTION = Object.freeze({
  "customer_invoice.create_draft": Object.freeze([
    ["SALES_INVOICE", "GENERIC_RECURRING_REFERENCE", "REFERENCE"],
  ]),
  "supplier_bill.create_draft": Object.freeze([
    ["SUPPLIER_BILL", "FORMAL_DOCUMENT_NUMBER", "INVOICE_NUMBER"],
    ["SUPPLIER_BILL", "GENERIC_RECURRING_REFERENCE", "INVOICE_NUMBER"],
  ]),
  "credit_note.create_draft": Object.freeze([
    ["CUSTOMER_CREDIT", "GENERIC_RECURRING_REFERENCE", "REFERENCE"],
    ["SUPPLIER_CREDIT", "FORMAL_DOCUMENT_NUMBER", "CREDIT_NOTE_NUMBER"],
    ["SUPPLIER_CREDIT", "GENERIC_RECURRING_REFERENCE", "CREDIT_NOTE_NUMBER"],
  ]),
} as const);

export function assertXeroExternalGovernanceCoversDelegations(
  authority: XeroExternalGovernanceAuthoritySet,
  delegations: readonly LedgerStandingDelegation[],
): void {
  xeroStandingDelegationsWithExternalGovernance(authority, delegations);
}

export function xeroStandingDelegationsWithExternalGovernance(
  authority: XeroExternalGovernanceAuthoritySet,
  delegations: readonly LedgerStandingDelegation[],
): readonly LedgerStandingDelegation[] {
  const profiles = new Map(authority.authorityProfiles.map((profile) => [profile.tenant_id.toLowerCase(), profile]));
  return Object.freeze(delegations.map((delegation): LedgerStandingDelegation => {
    if (delegation.status !== "ACTIVE") return Object.freeze({ ...delegation });
    const required = delegation.actionIds.flatMap((actionId) =>
      actionId in NON_UNIQUE_COVERAGE_BY_ACTION
        ? NON_UNIQUE_COVERAGE_BY_ACTION[actionId as keyof typeof NON_UNIQUE_COVERAGE_BY_ACTION]
          .map((coordinate) => Object.freeze({
            actionId,
            route: coordinate[0]!,
            referenceKind: coordinate[1]!,
            authoritativeProviderField: coordinate[2]!,
          }))
        : []);
    if (required.length === 0) return Object.freeze({ ...delegation });
    for (const tenantId of delegation.tenantIds) {
      const profile = profiles.get(tenantId.toLowerCase());
      if (!profile || profile.writer_authority.mode !== "VERIFIED_FIRM_GOVERNANCE") {
        throw new Error(`XERO_GOVERNANCE_REQUIRED_TENANT_MISSING:${tenantId}`);
      }
      const covered = new Set(profile.writer_authority.coverage.map((item) => JSON.stringify([
        item.route,
        item.reference_kind,
        item.authoritative_provider_field,
      ])));
      if (required.some((requirement) => !covered.has(JSON.stringify([
        requirement.route,
        requirement.referenceKind,
        requirement.authoritativeProviderField,
      ])))) {
        throw new Error(`XERO_GOVERNANCE_REQUIRED_COVERAGE_MISSING:${tenantId}`);
      }
      const governedWriters = !delegation.installationId ? [] : profile.writer_authority.writer_set.filter((writer) =>
        writer.workspace_id === delegation.workspaceId &&
        writer.agent_id === delegation.agentId &&
        writer.installation_id === delegation.installationId);
      if (governedWriters.length !== 1) {
        throw new Error(`XERO_GOVERNANCE_DELEGATED_WRITER_NOT_GOVERNED:${tenantId}`);
      }
    }
    const matchingAuthorities = authority.ledgerFirmGovernanceAuthorities.filter((candidate) =>
      delegation.tenantIds.some((tenantId) => tenantId.toLowerCase() === candidate.tenantId.toLowerCase()) &&
      candidate.workspaceId === delegation.workspaceId && candidate.agentId === delegation.agentId &&
      candidate.installationId === delegation.installationId && required.some((requirement) =>
        candidate.route === requirement.route && candidate.referenceKind === requirement.referenceKind &&
        candidate.authoritativeProviderField === requirement.authoritativeProviderField));
    const identities = new Map(matchingAuthorities.map((candidate) => [
      `${candidate.writerId}|${candidate.coordinationDomainId}`,
      candidate,
    ]));
    if (identities.size !== 1) {
      throw new Error(`XERO_GOVERNANCE_DELEGATED_WRITER_IDENTITY_AMBIGUOUS:${delegation.delegationId}`);
    }
    const identity = [...identities.values()][0]!;
    const expectedCount = new Set(delegation.tenantIds.flatMap((tenantId) => required.map((requirement) =>
      JSON.stringify([
        tenantId.toLowerCase(),
        requirement.route,
        requirement.referenceKind,
        requirement.authoritativeProviderField,
      ])))).size;
    const actualCount = new Set(matchingAuthorities.map((candidate) => JSON.stringify([
      candidate.tenantId.toLowerCase(),
      candidate.route,
      candidate.referenceKind,
      candidate.authoritativeProviderField,
    ]))).size;
    if (actualCount !== expectedCount) {
      throw new Error(`XERO_GOVERNANCE_REQUIRED_COVERAGE_MISSING:${delegation.delegationId}`);
    }
    return Object.freeze({
      ...delegation,
      writerId: identity.writerId,
      coordinationDomainId: identity.coordinationDomainId,
      firmGovernanceRequired: true,
      firmGovernanceRequirements: Object.freeze(required.map((requirement) => Object.freeze({ ...requirement }))),
      firmGovernanceAuthorities: Object.freeze(matchingAuthorities),
    });
  }));
}

function parseJson(buffer: Buffer, label: string): unknown {
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new Error(`XERO_GOVERNANCE_${label}_JSON_INVALID`);
  }
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`XERO_GOVERNANCE_${label}_TIME_INVALID`);
  return parsed;
}

function assertWindow(
  label: string,
  now: number,
  notBefore: string,
  expiresAt: string,
  issuedAt?: string,
  maxLifetimeMs?: number,
): void {
  const start = instant(notBefore, `${label}_NOT_BEFORE`);
  const expiry = instant(expiresAt, `${label}_EXPIRES`);
  const issued = issuedAt === undefined ? start : instant(issuedAt, `${label}_ISSUED`);
  if (issued > start || start >= expiry || now < start || now >= expiry) {
    throw new Error(`XERO_GOVERNANCE_${label}_NOT_CURRENT`);
  }
  if (maxLifetimeMs !== undefined && expiry - issued > maxLifetimeMs) {
    throw new Error(`XERO_GOVERNANCE_${label}_LIFETIME_TOO_LONG`);
  }
}

function assertPinnedHash(label: string, buffer: Buffer, expected: string): string {
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error(`XERO_GOVERNANCE_${label}_EXPECTED_SHA256_INVALID`);
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`XERO_GOVERNANCE_${label}_SHA256_MISMATCH`);
  return actual;
}

function receiptDigest(claims: z.infer<typeof receiptClaimsSchema>): string {
  return sha256(stableStringify({ domain: XERO_GOVERNANCE_RECEIPT_VERSION, claims }));
}

function statusDigest(claims: z.infer<typeof statusClaimsSchema>): string {
  return sha256(stableStringify({ domain: XERO_GOVERNANCE_STATUS_VERSION, claims }));
}

function signedPayload(domain: string, claims: unknown, digest: string): Buffer {
  return Buffer.from(stableStringify({ domain, claims, digest }), "utf8");
}

function verifySignature(
  label: string,
  signature: z.infer<typeof signatureSchema>,
  payload: Buffer,
  keys: ReadonlyMap<string, z.infer<typeof trustKeySchema>>,
  now: number,
): void {
  const key = keys.get(signature.key_id);
  if (!key || key.status !== "ACTIVE") throw new Error(`XERO_GOVERNANCE_${label}_SIGNING_KEY_UNTRUSTED`);
  assertWindow(`${label}_SIGNING_KEY`, now, key.not_before, key.expires_at);
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.public_key_spki_der_b64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error(`XERO_GOVERNANCE_${label}_SIGNING_KEY_INVALID`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(
    null,
    payload,
    publicKey,
    Buffer.from(signature.signature_b64url, "base64url"),
  )) {
    throw new Error(`XERO_GOVERNANCE_${label}_SIGNATURE_INVALID`);
  }
}

export function verifyXeroExternalGovernanceAuthority(
  input: XeroExternalGovernanceAuthorityInput,
): XeroExternalGovernanceAuthoritySet {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("XERO_GOVERNANCE_NOW_INVALID");
  }
  const trustBundleSha256 = assertPinnedHash(
    "TRUST_BUNDLE",
    input.trustBundle,
    input.expectedTrustBundleSha256,
  );
  const receiptsSha256 = assertPinnedHash("RECEIPTS", input.receipts, input.expectedReceiptsSha256);
  const statusSha256 = assertPinnedHash("STATUS", input.status, input.expectedStatusSha256);
  const trustBundle = trustBundleSchema.parse(parseJson(input.trustBundle, "TRUST_BUNDLE"));
  const receiptSet = receiptSetSchema.parse(parseJson(input.receipts, "RECEIPTS"));
  const status = governanceStatusSchema.parse(parseJson(input.status, "STATUS"));
  if (status.claims.issuer_org_id !== trustBundle.issuer_org_id) {
    throw new Error("XERO_GOVERNANCE_STATUS_TRUST_BUNDLE_ISSUER_MISMATCH");
  }
  const now = input.now.getTime();
  assertWindow("TRUST_BUNDLE", now, trustBundle.issued_at, trustBundle.expires_at);
  assertWindow("STATUS", now, status.claims.issued_at, status.claims.expires_at,
    status.claims.issued_at, XERO_GOVERNANCE_MAX_STATUS_LIFETIME_MS);
  const keys = new Map(trustBundle.keys.map((key) => [key.key_id, key]));
  const computedStatusDigest = statusDigest(status.claims);
  if (status.status_sha256 !== computedStatusDigest) throw new Error("XERO_GOVERNANCE_STATUS_DIGEST_MISMATCH");
  verifySignature(
    "STATUS",
    status.signature,
    signedPayload(STATUS_SIGNATURE_DOMAIN, status.claims, status.status_sha256),
    keys,
    now,
  );

  const revoked = new Set(status.claims.revoked_receipt_sha256s);
  const activeByCoordinate = new Map(status.claims.active_authorities.map((authority) => [
    JSON.stringify([authority.tenant_id.toLowerCase(), authority.authority_id]),
    authority,
  ]));
  const seenTenants = new Set<string>();
  const ledgerFirmGovernanceAuthorities: LedgerFirmGovernanceAuthority[] = [];
  const profiles = receiptSet.receipts.map((receipt): XeroAccountingCaseBusinessAuthorityProfile => {
    const computedReceiptDigest = receiptDigest(receipt.claims);
    if (receipt.receipt_sha256 !== computedReceiptDigest) {
      throw new Error("XERO_GOVERNANCE_RECEIPT_DIGEST_MISMATCH");
    }
    assertWindow(
      "RECEIPT",
      now,
      receipt.claims.not_before,
      receipt.claims.expires_at,
      receipt.claims.issued_at,
      XERO_GOVERNANCE_MAX_RECEIPT_LIFETIME_MS,
    );
    verifySignature(
      "RECEIPT",
      receipt.signature,
      signedPayload(RECEIPT_SIGNATURE_DOMAIN, receipt.claims, receipt.receipt_sha256),
      keys,
      now,
    );
    if (receipt.claims.issuer_org_id !== status.claims.issuer_org_id) {
      throw new Error("XERO_GOVERNANCE_RECEIPT_STATUS_ISSUER_MISMATCH");
    }
    if (revoked.has(receipt.receipt_sha256)) throw new Error("XERO_GOVERNANCE_RECEIPT_REVOKED");
    const active = activeByCoordinate.get(JSON.stringify([
      receipt.claims.tenant_id.toLowerCase(),
      receipt.claims.authority_id,
    ]));
    if (
      !active ||
      active.active_revision !== receipt.claims.revision ||
      active.active_receipt_sha256 !== receipt.receipt_sha256
    ) {
      throw new Error("XERO_GOVERNANCE_RECEIPT_NOT_CURRENT");
    }
    const tenant = receipt.claims.tenant_id.toLowerCase();
    if (seenTenants.has(tenant)) throw new Error("XERO_GOVERNANCE_TENANT_AUTHORITY_AMBIGUOUS");
    seenTenants.add(tenant);
    const coverage = receipt.claims.exclusive_writer_coverage.map((item) => ({
      route: item.route,
      reference_kind: item.reference_kind,
      authoritative_provider_field: item.authoritative_provider_field,
    }));
    const effectiveExpiresAt = new Date(Math.min(
      instant(receipt.claims.expires_at, "RECEIPT_EXPIRES"),
      instant(status.claims.expires_at, "STATUS_EXPIRES"),
      instant(trustBundle.expires_at, "TRUST_BUNDLE_EXPIRES"),
      instant(keys.get(receipt.signature.key_id)!.expires_at, "RECEIPT_SIGNING_KEY_EXPIRES"),
      instant(keys.get(status.signature.key_id)!.expires_at, "STATUS_SIGNING_KEY_EXPIRES"),
    )).toISOString();
    for (const coverageItem of receipt.claims.exclusive_writer_coverage) {
      for (const writer of receipt.claims.writer_set) {
        ledgerFirmGovernanceAuthorities.push({
          schemaVersion: LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION,
          providerId: "xero",
          tenantId: receipt.claims.tenant_id,
          authorityId: receipt.claims.authority_id,
          revision: receipt.claims.revision,
          providerAtomicUniqueness: false,
          route: coverageItem.route,
          referenceKind: coverageItem.reference_kind,
          authoritativeProviderField: coverageItem.authoritative_provider_field,
          writerId: writer.writer_id,
          writerKind: writer.writer_kind,
          workspaceId: writer.workspace_id,
          agentId: writer.agent_id,
          installationId: writer.installation_id,
          coordinationDomainId: writer.coordination_domain_id,
          receiptClaimsSha256: receipt.receipt_sha256,
          statusClaimsSha256: status.status_sha256,
          trustBundleFileSha256: trustBundleSha256,
          receiptsFileSha256: receiptsSha256,
          statusFileSha256: statusSha256,
          effectiveExpiresAt: new Date(effectiveExpiresAt),
          firmGovernanceStatement: {
            allNonEnumeratedWritersProhibited: true,
            humanXeroUiWritesProhibited: true,
            externalAppWritesProhibited: true,
            importWritesProhibited: true,
          },
          recurringSeriesAuthorities: receipt.claims.recurring_series_authorities.map((authority) => ({
            authorityId: authority.authority_id,
            revision: authority.revision,
            route: authority.route,
            contactId: authority.contact_id,
            normalizedReference: normalizeXeroBusinessReference(authority.reference),
            authoritativeProviderField: authority.authoritative_provider_field,
            normalizationVersion: authority.normalization_version,
            occurrenceKey: authority.occurrence_key,
          })),
        });
      }
    }
    return {
      tenant_id: receipt.claims.tenant_id,
      writer_authority: {
        mode: "VERIFIED_FIRM_GOVERNANCE",
        authority_id: receipt.claims.authority_id,
        revision: receipt.claims.revision,
        provider_atomic_uniqueness: false,
        governance_authority_active: true,
        verification_receipt_sha256: receipt.receipt_sha256,
        status_manifest_sha256: status.status_sha256,
        trust_bundle_sha256: trustBundleSha256,
        expires_at: effectiveExpiresAt,
        coverage,
        writer_set: receipt.claims.writer_set,
      },
      recurring_series_authorities: receipt.claims.recurring_series_authorities.map((authority) => ({
        authority_id: authority.authority_id,
        revision: authority.revision,
        route: authority.route,
        contact_id: authority.contact_id,
        reference: authority.reference,
        authoritative_provider_field: authority.authoritative_provider_field,
        normalization_version: authority.normalization_version,
        occurrence_key: authority.occurrence_key,
        verification_receipt_sha256: receipt.receipt_sha256,
        status_manifest_sha256: status.status_sha256,
        trust_bundle_sha256: trustBundleSha256,
        expires_at: effectiveExpiresAt,
      })),
    };
  });
  if (profiles.length !== activeByCoordinate.size) {
    throw new Error("XERO_GOVERNANCE_ACTIVE_STATUS_RECEIPT_SET_INCOMPLETE");
  }
  return Object.freeze({
    trustBundleSha256,
    receiptsSha256,
    statusSha256,
    authorityProfiles: Object.freeze(profiles.map((profile) => Object.freeze(profile))),
    ledgerFirmGovernanceAuthorities: Object.freeze(ledgerFirmGovernanceAuthorities.map((authority) =>
      Object.freeze({
        ...authority,
        effectiveExpiresAt: new Date(authority.effectiveExpiresAt),
        firmGovernanceStatement: Object.freeze({ ...authority.firmGovernanceStatement }),
        recurringSeriesAuthorities: Object.freeze(authority.recurringSeriesAuthorities.map((series) =>
          Object.freeze({ ...series }))),
      }))),
  });
}

/** Test utility exports only canonical signing bytes, never keys or production receipts. */
export const xeroGovernanceSigningContract = Object.freeze({
  receiptDigest,
  statusDigest,
  receiptPayload: (claims: z.infer<typeof receiptClaimsSchema>, digest: string) =>
    signedPayload(RECEIPT_SIGNATURE_DOMAIN, claims, digest),
  statusPayload: (claims: z.infer<typeof statusClaimsSchema>, digest: string) =>
    signedPayload(STATUS_SIGNATURE_DOMAIN, claims, digest),
});
