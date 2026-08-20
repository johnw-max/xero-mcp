/**
 * One release identifier for every public Xero MCP surface.
 *
 * Keep this equal to package.json. The version contract test fails if the
 * package is bumped without updating this value, so initialize, health and
 * readiness cannot silently identify different builds.
 */
export const XERO_RELEASE_VERSION = "0.4.0-rc.1";

/** Public runtime attestation. These values identify the enforcement stack,
 * not merely the package version, so remote UAT can reject a stale image or
 * a process started with the wrong tool/config generation. */
export const XERO_RELEASE_ATTESTATION = Object.freeze({
  controlKernel: "ledger-control-kernel-v2",
  ledgerAuthoritySnapshot: LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
  accountingCaseCompiler: ACCOUNTING_CASE_COMPILER_VERSION,
  accountingPolicy: XERO_ACCOUNTING_CASE_POLICY_VERSION,
  accountingPolicyProjection: XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
  accountingCaseProviderContract: XERO_ACCOUNTING_CASE_PROVIDER_CONTRACT_VERSION,
  accountingCaseProviderProjection: XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
  accountingCaseBusinessAuthorityProjection: XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITY_PROJECTION_VERSION,
  accountingCaseReadbackValidator: ACCOUNTING_CASE_READBACK_VALIDATOR_VERSION,
  xeroNativeRouteContract: XERO_NATIVE_ROUTE_CONTRACT_VERSION,
  xeroContactIdentityContract: XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
  requiredMigration: REQUIRED_MIGRATION_HEAD,
  publicToolProfile: "xero-accounting-case-business-intake-v4",
  executionAuthority: "OAUTH_TARGET_BOUND_WRITE_GATE",
  writeCompletion: "PROVIDER_ID_RECEIPT_EXACT_READBACK",
});

export type XeroRuntimeWriteMode = "WRITE_ENABLED" | "READ_ONLY";

export interface XeroRuntimeAttestationInput {
  buildIdentityHash: string | null;
  acceptanceSourceSha256: string | null;
  sourceArchiveSha256: string | null;
  writeMode: XeroRuntimeWriteMode;
  processWriteGateEnabled: boolean;
  authoritySnapshotRevision: number | null;
  authoritySnapshotHash: string | null;
  authorityWriteKillSwitchEnabled: boolean | null;
  storageMode: "POSTGRES" | "IN_MEMORY" | "UNKNOWN";
  repositoryReady: boolean;
  requiredMigration: string;
  requiredMigrationStatus: "APPLIED" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";
  migrationHead: string | null;
  activeAccountingCaseRecoveryProjection: ActiveAccountingCaseRecoveryProjectionEvidence;
}

/** Binds the build identity to the observed process and storage state. */
export function createXeroRuntimeAttestation(input: XeroRuntimeAttestationInput) {
  return Object.freeze({
    releaseAttestationHash: hashObject(XERO_RELEASE_ATTESTATION),
    ...input,
  });
}
import {
  ACCOUNTING_CASE_COMPILER_VERSION,
} from "./domain/accountingCase.js";
import {
  XERO_ACCOUNTING_CASE_POLICY_VERSION,
  XERO_ACCOUNTING_CASE_PROVIDER_CONTRACT_VERSION,
  XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
} from "./policy/xeroAccountingCaseProviderContract.js";
import { XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION } from "./policy/xeroDeclaredLedgerPolicy.js";
import { ACCOUNTING_CASE_READBACK_VALIDATOR_VERSION } from "./control-kernel/accountingCaseReadbackValidator.js";
import { XERO_NATIVE_ROUTE_CONTRACT_VERSION } from "./policy/xeroNativeRouteContract.js";
import { XERO_CONTACT_IDENTITY_CONTRACT_VERSION } from "./policy/xeroContactIdentity.js";
import { XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITY_PROJECTION_VERSION } from "./policy/xeroBusinessCoordinateAuthority.js";
import { hashObject } from "./security/hash.js";
import { REQUIRED_MIGRATION_HEAD } from "./db/requiredMigrations.js";
import { LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION } from "./domain/ledgerAuthority.js";
import { TOOL_ALLOWLIST } from "./mcp/toolNames.js";
import type { ActiveAccountingCaseRecoveryProjectionEvidence } from "./db/accountingCaseRecoveryProjectionReadiness.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export const XERO_BUILD_IDENTITY_SCHEMA_VERSION = "xero-oci-build-identity:v2" as const;

export interface XeroBuildIdentity {
  schemaVersion: typeof XERO_BUILD_IDENTITY_SCHEMA_VERSION;
  releaseVersion: typeof XERO_RELEASE_VERSION;
  acceptanceSourceSha256: string;
  releaseSourceManifestSha256: string;
  sourceArchiveSha256: string;
  sourceBundleManifestSha256: string;
  toolsetHash: string;
  releaseAttestationHash: string;
  requiredMigration: string;
}

export interface XeroBuildArtifactIdentityInput {
  acceptanceSourceSha256: string;
  releaseSourceManifestSha256: string;
  sourceArchiveSha256: string;
  sourceBundleManifestSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBuildIdentityFields(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([
    "acceptanceSourceSha256",
    "releaseAttestationHash",
    "releaseSourceManifestSha256",
    "releaseVersion",
    "requiredMigration",
    "schemaVersion",
    "sourceArchiveSha256",
    "sourceBundleManifestSha256",
    "toolsetHash",
  ]);
}

/**
 * Creates the immutable bridge from the locally accepted source snapshot and
 * source bundle to the runtime contract compiled from those same bytes.
 */
export function createXeroBuildIdentity(input: XeroBuildArtifactIdentityInput): XeroBuildIdentity {
  if (![
    input.acceptanceSourceSha256,
    input.releaseSourceManifestSha256,
    input.sourceArchiveSha256,
    input.sourceBundleManifestSha256,
  ].every((value) => SHA256.test(value))) {
    throw new Error("XERO_BUILD_IDENTITY_ARTIFACT_HASH_INVALID");
  }
  return Object.freeze({
    schemaVersion: XERO_BUILD_IDENTITY_SCHEMA_VERSION,
    releaseVersion: XERO_RELEASE_VERSION,
    acceptanceSourceSha256: input.acceptanceSourceSha256,
    releaseSourceManifestSha256: input.releaseSourceManifestSha256,
    sourceArchiveSha256: input.sourceArchiveSha256,
    sourceBundleManifestSha256: input.sourceBundleManifestSha256,
    toolsetHash: hashObject(TOOL_ALLOWLIST),
    releaseAttestationHash: hashObject(XERO_RELEASE_ATTESTATION),
    requiredMigration: XERO_RELEASE_ATTESTATION.requiredMigration,
  });
}

export function parseXeroBuildIdentity(raw: string): XeroBuildIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("XERO_BUILD_IDENTITY_JSON_INVALID");
  }
  if (!isRecord(parsed) || !exactBuildIdentityFields(parsed)) {
    throw new Error("XERO_BUILD_IDENTITY_FIELDS_INVALID");
  }
  const expected = createXeroBuildIdentity({
    acceptanceSourceSha256: String(parsed.acceptanceSourceSha256),
    releaseSourceManifestSha256: String(parsed.releaseSourceManifestSha256),
    sourceArchiveSha256: String(parsed.sourceArchiveSha256),
    sourceBundleManifestSha256: String(parsed.sourceBundleManifestSha256),
  });
  if (hashObject(parsed) !== hashObject(expected)) {
    throw new Error("XERO_BUILD_IDENTITY_CONTRACT_MISMATCH");
  }
  return expected;
}

export function xeroBuildIdentityHash(identity: XeroBuildIdentity): string {
  return hashObject(identity);
}
