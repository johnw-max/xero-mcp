import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { sha256 } from "../../src/security/hash.js";
import {
  XERO_GOVERNANCE_RECEIPT_SET_VERSION,
  XERO_GOVERNANCE_RECEIPT_VERSION,
  XERO_GOVERNANCE_STATUS_VERSION,
  XERO_GOVERNANCE_TRUST_BUNDLE_VERSION,
  verifyXeroExternalGovernanceAuthority,
  xeroGovernanceSigningContract,
} from "../../src/policy/xeroExternalGovernanceAuthority.js";
import { XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION } from
  "../../src/policy/xeroBusinessCoordinateAuthority.js";

export const TEST_GOVERNANCE_NOW = new Date("2026-08-14T00:00:00.000Z");

export interface TestXeroGovernanceArtifacts {
  readonly trustBundle: Buffer;
  readonly receipts: Buffer;
  readonly status: Buffer;
  readonly expectedTrustBundleSha256: string;
  readonly expectedReceiptsSha256: string;
  readonly expectedStatusSha256: string;
  readonly privateKey: KeyObject;
  readonly trustBundleDocument: Record<string, unknown>;
  readonly receiptSetDocument: Record<string, unknown>;
  readonly statusDocument: Record<string, unknown>;
  readonly authorityProfiles: ReturnType<typeof verifyXeroExternalGovernanceAuthority>["authorityProfiles"];
}

function encoded(document: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
}

export function createTestXeroGovernanceArtifacts(
  tenantId = "11111111-1111-4111-8111-111111111111",
  options: {
    now?: Date;
    receiptExpiresAt?: string;
    statusExpiresAt?: string;
    revoked?: boolean;
    writerId?: string;
    workspaceId?: string;
    agentId?: string;
    installationId?: string;
    coordinationDomainId?: string;
    receiptIssuedAt?: string;
    receiptNotBefore?: string;
    statusIssuedAt?: string;
  } = {},
): TestXeroGovernanceArtifacts {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test Xero governance signing material is test-only.");
  }
  const now = options.now ?? TEST_GOVERNANCE_NOW;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "test-firm-governance-key-v1";
  const authorityId = `test-firm-governance-${tenantId}`;
  const receiptClaims = {
    provider_id: "xero" as const,
    tenant_id: tenantId,
    authority_id: authorityId,
    revision: 1,
    issuer_org_id: "test-accounting-firm",
    issuer_role: "FIRM_GOVERNANCE_AUTHORITY" as const,
    issued_at: options.receiptIssuedAt ?? "2026-08-13T23:30:00.000Z",
    not_before: options.receiptNotBefore ?? options.receiptIssuedAt ?? "2026-08-13T23:30:00.000Z",
    expires_at: options.receiptExpiresAt ?? "2026-08-14T23:30:00.000Z",
    provider_atomic_uniqueness: false as const,
    exclusive_writer_coverage: ([
      ["SALES_INVOICE", "GENERIC_RECURRING_REFERENCE", "REFERENCE"],
      ["SUPPLIER_BILL", "FORMAL_DOCUMENT_NUMBER", "INVOICE_NUMBER"],
      ["SUPPLIER_BILL", "GENERIC_RECURRING_REFERENCE", "INVOICE_NUMBER"],
      ["CUSTOMER_CREDIT", "GENERIC_RECURRING_REFERENCE", "REFERENCE"],
      ["SUPPLIER_CREDIT", "FORMAL_DOCUMENT_NUMBER", "CREDIT_NOTE_NUMBER"],
      ["SUPPLIER_CREDIT", "GENERIC_RECURRING_REFERENCE", "CREDIT_NOTE_NUMBER"],
      // `as const` makes these tuples of literals. Without it the array infers
      // as string[][], destructuring yields `string | undefined` under
      // noUncheckedIndexedAccess, and the coverage entries stop matching the
      // exact route/field unions the authority schema requires.
    ] as const).map(([route, reference_kind, authoritative_provider_field]) => ({
      route,
      reference_kind,
      authoritative_provider_field,
      contact_scope: "ALL_TENANT_CONTACTS" as const,
    })),
    writer_set: [{
      writer_id: options.writerId ?? "test-work-agent-installation",
      writer_kind: "XERO_MCP_INSTALLATION" as const,
      workspace_id: options.workspaceId ?? "workspace-test",
      agent_id: options.agentId ?? "agent-test",
      installation_id: options.installationId ?? "installation-test",
      coordination_domain_id: options.coordinationDomainId ?? "test-shared-postgres-authority-domain",
    }],
    firm_governance_statement: {
      all_non_enumerated_writers_prohibited: true as const,
      human_xero_ui_writes_prohibited: true as const,
      external_app_writes_prohibited: true as const,
      import_writes_prohibited: true as const,
    },
    recurring_series_authorities: [],
  };
  const receiptSha256 = xeroGovernanceSigningContract.receiptDigest(receiptClaims);
  const receipt = {
    schema_version: XERO_GOVERNANCE_RECEIPT_VERSION,
    claims: receiptClaims,
    receipt_sha256: receiptSha256,
    signature: {
      algorithm: "Ed25519" as const,
      key_id: keyId,
      signature_b64url: sign(
        null,
        xeroGovernanceSigningContract.receiptPayload(receiptClaims, receiptSha256),
        privateKey,
      ).toString("base64url"),
    },
  };
  const statusClaims = {
    provider_id: "xero" as const,
    issuer_org_id: "test-accounting-firm",
    issued_at: options.statusIssuedAt ?? "2026-08-13T23:45:00.000Z",
    expires_at: options.statusExpiresAt ?? "2026-08-14T00:45:00.000Z",
    active_authorities: [{
      tenant_id: tenantId,
      authority_id: authorityId,
      active_revision: 1,
      active_receipt_sha256: receiptSha256,
    }],
    revoked_receipt_sha256s: options.revoked ? [receiptSha256] : [],
  };
  const statusSha256 = xeroGovernanceSigningContract.statusDigest(statusClaims);
  const statusDocument = {
    schema_version: XERO_GOVERNANCE_STATUS_VERSION,
    claims: statusClaims,
    status_sha256: statusSha256,
    signature: {
      algorithm: "Ed25519" as const,
      key_id: keyId,
      signature_b64url: sign(
        null,
        xeroGovernanceSigningContract.statusPayload(statusClaims, statusSha256),
        privateKey,
      ).toString("base64url"),
    },
  };
  const trustBundleDocument = {
    schema_version: XERO_GOVERNANCE_TRUST_BUNDLE_VERSION,
    bundle_id: "test-host-approved-firm-governance-keys",
    issuer_org_id: "test-accounting-firm",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
    keys: [{
      key_id: keyId,
      algorithm: "Ed25519" as const,
      public_key_spki_der_b64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      not_before: "2026-08-01T00:00:00.000Z",
      expires_at: "2026-09-01T00:00:00.000Z",
      status: "ACTIVE" as const,
    }],
  };
  const receiptSetDocument = {
    schema_version: XERO_GOVERNANCE_RECEIPT_SET_VERSION,
    receipts: [receipt],
  };
  const trustBundle = encoded(trustBundleDocument);
  const receipts = encoded(receiptSetDocument);
  const status = encoded(statusDocument);
  const expectedTrustBundleSha256 = sha256(trustBundle);
  const expectedReceiptsSha256 = sha256(receipts);
  const expectedStatusSha256 = sha256(status);
  const authorityProfiles = options.revoked ? [] : verifyXeroExternalGovernanceAuthority({
    trustBundle,
    receipts,
    status,
    expectedTrustBundleSha256,
    expectedReceiptsSha256,
    expectedStatusSha256,
    now,
  }).authorityProfiles;
  return {
    trustBundle,
    receipts,
    status,
    expectedTrustBundleSha256,
    expectedReceiptsSha256,
    expectedStatusSha256,
    privateKey,
    trustBundleDocument,
    receiptSetDocument,
    statusDocument,
    authorityProfiles,
  };
}

export function resignTestXeroGovernanceStatus(
  document: Record<string, any>,
  privateKey: KeyObject,
): Buffer {
  const claims = document.claims;
  const digest = xeroGovernanceSigningContract.statusDigest(claims);
  document.status_sha256 = digest;
  document.signature.signature_b64url = sign(
    null,
    xeroGovernanceSigningContract.statusPayload(claims, digest),
    privateKey,
  ).toString("base64url");
  return encoded(document);
}

export function resignTestXeroGovernanceReceiptSet(
  document: Record<string, any>,
  privateKey: KeyObject,
): Buffer {
  const receipt = document.receipts[0];
  const claims = receipt.claims;
  const digest = xeroGovernanceSigningContract.receiptDigest(claims);
  receipt.receipt_sha256 = digest;
  receipt.signature.signature_b64url = sign(
    null,
    xeroGovernanceSigningContract.receiptPayload(claims, digest),
    privateKey,
  ).toString("base64url");
  return encoded(document);
}

export function testRecurringSeriesAuthority(
  artifacts: TestXeroGovernanceArtifacts,
  input: { route: "SALES_INVOICE" | "SUPPLIER_BILL" | "CUSTOMER_CREDIT" | "SUPPLIER_CREDIT"; contactId: string; reference: string },
): Record<string, unknown> {
  return {
    authority_id: `test-recurring-${input.route.toLowerCase()}`,
    revision: 1,
    route: input.route,
    contact_id: input.contactId,
    reference: input.reference,
    authoritative_provider_field: input.route === "SALES_INVOICE" || input.route === "CUSTOMER_CREDIT"
      ? "REFERENCE"
      : input.route === "SUPPLIER_BILL" ? "INVOICE_NUMBER" : "CREDIT_NOTE_NUMBER",
    normalization_version: XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
    occurrence_key: "DOCUMENT_DATE",
    verification_receipt_sha256: artifacts.authorityProfiles[0]!.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE"
      ? artifacts.authorityProfiles[0]!.writer_authority.verification_receipt_sha256
      : "",
  };
}
