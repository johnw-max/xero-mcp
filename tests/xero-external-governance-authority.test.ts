import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/security/hash.js";
import {
  parseXeroAccountingCaseBusinessAuthorityProfiles,
  projectXeroAccountingCaseBusinessAuthority,
} from "../src/policy/xeroBusinessCoordinateAuthority.js";
import {
  assertXeroExternalGovernanceCoversDelegations,
  verifyXeroExternalGovernanceAuthority,
} from "../src/policy/xeroExternalGovernanceAuthority.js";
import {
  TEST_GOVERNANCE_NOW,
  createTestXeroGovernanceArtifacts,
  resignTestXeroGovernanceReceiptSet,
  resignTestXeroGovernanceStatus,
} from "./helpers/xeroGovernanceAuthority.js";

function verifyFixture(fixture: ReturnType<typeof createTestXeroGovernanceArtifacts>, overrides: Partial<{
  trustBundle: Buffer;
  receipts: Buffer;
  status: Buffer;
  expectedTrustBundleSha256: string;
  expectedReceiptsSha256: string;
  expectedStatusSha256: string;
  now: Date;
}> = {}) {
  return verifyXeroExternalGovernanceAuthority({
    trustBundle: overrides.trustBundle ?? fixture.trustBundle,
    receipts: overrides.receipts ?? fixture.receipts,
    status: overrides.status ?? fixture.status,
    expectedTrustBundleSha256: overrides.expectedTrustBundleSha256 ?? fixture.expectedTrustBundleSha256,
    expectedReceiptsSha256: overrides.expectedReceiptsSha256 ?? fixture.expectedReceiptsSha256,
    expectedStatusSha256: overrides.expectedStatusSha256 ?? fixture.expectedStatusSha256,
    now: overrides.now ?? TEST_GOVERNANCE_NOW,
  });
}

describe("externally rooted Xero firm-governance authority", () => {
  it("verifies pinned Ed25519 receipt/status bytes and never claims provider atomic uniqueness", () => {
    const fixture = createTestXeroGovernanceArtifacts();
    const verified = verifyFixture(fixture);
    expect(verified).toMatchObject({
      trustBundleSha256: fixture.expectedTrustBundleSha256,
      receiptsSha256: fixture.expectedReceiptsSha256,
      statusSha256: fixture.expectedStatusSha256,
    });
    expect(verified.authorityProfiles).toHaveLength(1);
    const profile = verified.authorityProfiles[0]!;
    expect(profile.writer_authority).toMatchObject({
      mode: "VERIFIED_FIRM_GOVERNANCE",
      provider_atomic_uniqueness: false,
      governance_authority_active: true,
      verification_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      trust_bundle_sha256: fixture.expectedTrustBundleSha256,
      expires_at: "2026-08-14T00:45:00.000Z",
    });
    expect(projectXeroAccountingCaseBusinessAuthority(profile.tenant_id, profile).writerAuthority)
      .toMatchObject({ providerAtomicUniqueness: false, governanceAuthorityActive: true });
  });

  it("projects the legacy candidate boolean plus arbitrary hash only as unverified", () => {
    const [legacy] = parseXeroAccountingCaseBusinessAuthorityProfiles([{
      tenant_id: "11111111-1111-4111-8111-111111111111",
      writer_authority: {
        mode: "EXCLUSIVE_GOVERNED_WRITER",
        authority_id: "candidate-self-assertion",
        revision: 1,
        covers_all_tenant_writers: true,
        verification_receipt_sha256: "f".repeat(64),
      },
      recurring_series_authorities: [],
    }]);
    expect(legacy).toBeDefined();
    expect(projectXeroAccountingCaseBusinessAuthority(legacy!.tenant_id, legacy!).writerAuthority)
      .toMatchObject({ mode: "LEGACY_UNVERIFIED_EXCLUSIVE_WRITER" });
  });

  it("rejects unpinned bytes, forged signatures, and a candidate-selected signing key", () => {
    const fixture = createTestXeroGovernanceArtifacts();
    expect(() => verifyFixture(fixture, { expectedReceiptsSha256: "0".repeat(64) }))
      .toThrow("XERO_GOVERNANCE_RECEIPTS_SHA256_MISMATCH");

    const forgedDocument = structuredClone(fixture.receiptSetDocument) as any;
    forgedDocument.receipts[0].signature.signature_b64url = "A".repeat(86);
    const forged = Buffer.from(`${JSON.stringify(forgedDocument)}\n`);
    expect(() => verifyFixture(fixture, {
      receipts: forged,
      expectedReceiptsSha256: sha256(forged),
    })).toThrow("XERO_GOVERNANCE_RECEIPT_SIGNATURE_INVALID");

    const candidateBundle = structuredClone(fixture.trustBundleDocument) as any;
    const candidate = generateKeyPairSync("ed25519");
    candidateBundle.keys[0].public_key_spki_der_b64 = candidate.publicKey
      .export({ format: "der", type: "spki" }).toString("base64");
    const candidateBytes = Buffer.from(`${JSON.stringify(candidateBundle)}\n`);
    expect(() => verifyFixture(fixture, {
      trustBundle: candidateBytes,
      expectedTrustBundleSha256: fixture.expectedTrustBundleSha256,
    })).toThrow("XERO_GOVERNANCE_TRUST_BUNDLE_SHA256_MISMATCH");
  });

  it("fails closed for expired, revoked, stale, wrong-field and wrong-writer governance", () => {
    const fixture = createTestXeroGovernanceArtifacts();
    expect(() => verifyFixture(fixture, { now: new Date("2026-08-14T00:45:00.000Z") }))
      .toThrow(/NOT_CURRENT/u);

    const revoked = createTestXeroGovernanceArtifacts(undefined, { revoked: true });
    expect(() => verifyFixture(revoked)).toThrow("XERO_GOVERNANCE_RECEIPT_REVOKED");

    const staleStatusDocument = structuredClone(fixture.statusDocument) as any;
    staleStatusDocument.claims.active_authorities[0].active_revision = 2;
    const staleStatus = resignTestXeroGovernanceStatus(staleStatusDocument, fixture.privateKey);
    expect(() => verifyFixture(fixture, {
      status: staleStatus,
      expectedStatusSha256: sha256(staleStatus),
    })).toThrow("XERO_GOVERNANCE_RECEIPT_NOT_CURRENT");

    const wrongFieldDocument = structuredClone(fixture.receiptSetDocument) as any;
    wrongFieldDocument.receipts[0].claims.exclusive_writer_coverage[0].authoritative_provider_field =
      "INVOICE_NUMBER";
    const wrongField = Buffer.from(`${JSON.stringify(wrongFieldDocument)}\n`);
    expect(() => verifyFixture(fixture, {
      receipts: wrongField,
      expectedReceiptsSha256: sha256(wrongField),
    })).toThrow(/non-unique route\/provider-field coordinate/u);

    const wrongWriterDocument = structuredClone(fixture.receiptSetDocument) as any;
    wrongWriterDocument.receipts[0].claims.writer_set.push({
      ...wrongWriterDocument.receipts[0].claims.writer_set[0],
      writer_id: "other-uncoordinated-writer",
      coordination_domain_id: "different-database",
    });
    const wrongWriter = Buffer.from(`${JSON.stringify(wrongWriterDocument)}\n`);
    expect(() => verifyFixture(fixture, {
      receipts: wrongWriter,
      expectedReceiptsSha256: sha256(wrongWriter),
    })).toThrow(/share one coordination domain/u);
  });

  it("blocks a customer-invoice delegation without exact generic AR coverage", () => {
    const fixture = createTestXeroGovernanceArtifacts();
    const receiptDocument = structuredClone(fixture.receiptSetDocument) as any;
    receiptDocument.receipts[0].claims.exclusive_writer_coverage =
      receiptDocument.receipts[0].claims.exclusive_writer_coverage.slice(1);
    const receipts = resignTestXeroGovernanceReceiptSet(receiptDocument, fixture.privateKey);
    const statusDocument = structuredClone(fixture.statusDocument) as any;
    statusDocument.claims.active_authorities[0].active_receipt_sha256 =
      receiptDocument.receipts[0].receipt_sha256;
    const status = resignTestXeroGovernanceStatus(statusDocument, fixture.privateKey);
    const verified = verifyFixture(fixture, {
      receipts,
      status,
      expectedReceiptsSha256: sha256(receipts),
      expectedStatusSha256: sha256(status),
    });

    expect(() => assertXeroExternalGovernanceCoversDelegations(verified, [{
      delegationId: "test-customer-invoice-delegation",
      revision: 1,
      status: "ACTIVE",
      providerId: "xero",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      tenantIds: ["11111111-1111-4111-8111-111111111111"],
      actionIds: ["customer_invoice.create_draft"],
    }])).toThrow("XERO_GOVERNANCE_REQUIRED_COVERAGE_MISSING");
  });
});
