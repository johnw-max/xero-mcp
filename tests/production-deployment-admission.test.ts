import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPulledProductionImageIdentity,
  parseCapturedReleaseEnvironment,
  readTrustedRegularFile,
  verifyCapturedGovernanceAuthority,
} from "../scripts/release/production-deployment-admission.mjs";
import {
  assertProductionAdmissionWrapperContract,
  assertProductionComposeContract,
  assertProductionCutoverContract,
  assertProductionRunbookContract,
} from "../scripts/release/production-deployment-contract.mjs";
import { verifyXeroExternalGovernanceAuthority } from
  "../src/policy/xeroExternalGovernanceAuthority.js";
import { sha256 } from "../src/security/hash.js";
import {
  TEST_GOVERNANCE_NOW,
  createTestXeroGovernanceArtifacts,
  resignTestXeroGovernanceReceiptSet,
  resignTestXeroGovernanceStatus,
} from "./helpers/xeroGovernanceAuthority.js";

const uid = process.getuid?.() ?? 0;

function capturedReleaseEnvironment(overrides: Record<string, string> = {}): Buffer {
  const standingDelegations = overrides.XERO_STANDING_DELEGATIONS_JSON ?? "[]";
  const values = {
    APP_IMAGE: `registry.example/xero@sha256:${"a".repeat(64)}`,
    XERO_ACCEPTANCE_GATE_RESULT: "/srv/xero-accounting-mcp/release/gate-result.json",
    XERO_ACCEPTANCE_GATE_RECEIPT: "/srv/xero-accounting-mcp/release/gate-receipt.json",
    XERO_ACCEPTED_OCI_RECEIPT: "/srv/xero-accounting-mcp/release/oci-receipt.json",
    XERO_ACCEPTED_OCI_ARTIFACT: "/srv/xero-accounting-mcp/release/oci.tar",
    XERO_APPROVED_CONTROL_CATALOG_SHA256: "b".repeat(64),
    XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: "c".repeat(64),
    XERO_GOVERNANCE_RECEIPTS_SHA256: "d".repeat(64),
    XERO_GOVERNANCE_STATUS_SHA256: "e".repeat(64),
    XERO_WRITE_ENABLED: "false",
    XERO_AUTHORITY_REVISION: "7",
    XERO_STANDING_DELEGATIONS_JSON: standingDelegations,
    XERO_STANDING_DELEGATIONS_CONFIG_SHA256: sha256(standingDelegations),
    XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256: "6".repeat(64),
    XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "NOT_REQUIRED",
    ...overrides,
  };
  return Buffer.from(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function governanceInputs(
  fixture: ReturnType<typeof createTestXeroGovernanceArtifacts>,
  overrides: Partial<{ trustBundle: Buffer; receipts: Buffer; status: Buffer }> = {},
) {
  const trustBundle = overrides.trustBundle ?? fixture.trustBundle;
  const receipts = overrides.receipts ?? fixture.receipts;
  const status = overrides.status ?? fixture.status;
  return {
    trustBundle,
    receipts,
    status,
    expectedTrustBundleSha256: sha256(trustBundle),
    expectedReceiptsSha256: sha256(receipts),
    expectedStatusSha256: sha256(status),
  };
}

function expectRuntimeAndAdmissionToReject(
  fixture: ReturnType<typeof createTestXeroGovernanceArtifacts>,
  overrides: Partial<{ trustBundle: Buffer; receipts: Buffer; status: Buffer }>,
): void {
  const input = governanceInputs(fixture, overrides);
  expect(() => verifyXeroExternalGovernanceAuthority({ ...input, now: TEST_GOVERNANCE_NOW })).toThrow();
  expect(() => verifyCapturedGovernanceAuthority({
    trustBundle: input.trustBundle,
    receipts: input.receipts,
    status: input.status,
    env: {
      XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: input.expectedTrustBundleSha256,
      XERO_GOVERNANCE_RECEIPTS_SHA256: input.expectedReceiptsSha256,
      XERO_GOVERNANCE_STATUS_SHA256: input.expectedStatusSha256,
    },
    now: TEST_GOVERNANCE_NOW,
  })).toThrow();
}

async function trustFixture() {
  const root = await mkdtemp(join(tmpdir(), "xero-production-trust-"));
  await chmod(root, 0o700);
  const file = join(root, "release.json");
  await writeFile(file, "accepted\n", { mode: 0o600 });
  return { root, file };
}

describe("production deployment admission", () => {
  it("captures a safe regular file once and rejects a world-writable root-owned file", async () => {
    const fixture = await trustFixture();
    try {
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).resolves.toMatchObject({ content: Buffer.from("accepted\n") });
      await chmod(fixture.file, 0o666);
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).rejects.toThrow("PRODUCTION_TRUST_FILE_UNSAFE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("permits 0444 only for explicitly public governance evidence", async () => {
    const fixture = await trustFixture();
    try {
      await chmod(fixture.file, 0o444);
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
        allowedModes: [0o444],
      })).resolves.toMatchObject({ content: Buffer.from("accepted\n") });
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).rejects.toThrow("PRODUCTION_TRUST_FILE_UNSAFE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verifies pinned firm signatures/status and rejects signed provider-uniqueness inflation", () => {
    const fixture = createTestXeroGovernanceArtifacts();
    const env = {
      XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: fixture.expectedTrustBundleSha256,
      XERO_GOVERNANCE_RECEIPTS_SHA256: fixture.expectedReceiptsSha256,
      XERO_GOVERNANCE_STATUS_SHA256: fixture.expectedStatusSha256,
    };
    expect(verifyCapturedGovernanceAuthority({
      trustBundle: fixture.trustBundle,
      receipts: fixture.receipts,
      status: fixture.status,
      env,
      now: TEST_GOVERNANCE_NOW,
    })).toMatchObject({ receiptCount: 1 });

    const receiptDocument = structuredClone(fixture.receiptSetDocument) as any;
    receiptDocument.receipts[0].claims.provider_atomic_uniqueness = true;
    const receipts = resignTestXeroGovernanceReceiptSet(receiptDocument, fixture.privateKey);
    const statusDocument = structuredClone(fixture.statusDocument) as any;
    statusDocument.claims.active_authorities[0].active_receipt_sha256 =
      receiptDocument.receipts[0].receipt_sha256;
    const status = resignTestXeroGovernanceStatus(statusDocument, fixture.privateKey);
    expect(() => verifyCapturedGovernanceAuthority({
      trustBundle: fixture.trustBundle,
      receipts,
      status,
      env: {
        ...env,
        XERO_GOVERNANCE_RECEIPTS_SHA256: sha256(receipts),
        XERO_GOVERNANCE_STATUS_SHA256: sha256(status),
      },
      now: TEST_GOVERNANCE_NOW,
    })).toThrow("PRODUCTION_GOVERNANCE_RECEIPT_CLAIMS_INVALID");
  });

  it("rejects issuer, UUID, canonical encoding and recurring-coordinate defects on both trust boundaries", () => {
    const issuerFixture = createTestXeroGovernanceArtifacts();
    const wrongIssuerBundle = structuredClone(issuerFixture.trustBundleDocument) as any;
    wrongIssuerBundle.issuer_org_id = "different-accounting-firm";
    expectRuntimeAndAdmissionToReject(issuerFixture, {
      trustBundle: Buffer.from(`${JSON.stringify(wrongIssuerBundle)}\n`, "utf8"),
    });

    const keyFixture = createTestXeroGovernanceArtifacts();
    const nonCanonicalKeyBundle = structuredClone(keyFixture.trustBundleDocument) as any;
    nonCanonicalKeyBundle.keys.push({
      ...nonCanonicalKeyBundle.keys[0],
      key_id: "unused-revoked-noncanonical-key",
      public_key_spki_der_b64: "AA",
      status: "REVOKED",
    });
    expectRuntimeAndAdmissionToReject(keyFixture, {
      trustBundle: Buffer.from(`${JSON.stringify(nonCanonicalKeyBundle)}\n`, "utf8"),
    });

    const uuidFixture = createTestXeroGovernanceArtifacts();
    const invalidUuidReceipts = structuredClone(uuidFixture.receiptSetDocument) as any;
    invalidUuidReceipts.receipts[0].claims.tenant_id = "not-a-tenant-uuid";
    const invalidUuidReceiptBytes = resignTestXeroGovernanceReceiptSet(invalidUuidReceipts, uuidFixture.privateKey);
    const invalidUuidStatus = structuredClone(uuidFixture.statusDocument) as any;
    invalidUuidStatus.claims.active_authorities[0].tenant_id = "not-a-tenant-uuid";
    invalidUuidStatus.claims.active_authorities[0].active_receipt_sha256 =
      invalidUuidReceipts.receipts[0].receipt_sha256;
    const invalidUuidStatusBytes = resignTestXeroGovernanceStatus(invalidUuidStatus, uuidFixture.privateKey);
    expectRuntimeAndAdmissionToReject(uuidFixture, {
      receipts: invalidUuidReceiptBytes,
      status: invalidUuidStatusBytes,
    });

    const seriesFixture = createTestXeroGovernanceArtifacts();
    const duplicateSeriesReceipts = structuredClone(seriesFixture.receiptSetDocument) as any;
    const series = {
      authority_id: "recurring-sales-v1",
      revision: 1,
      route: "SALES_INVOICE",
      contact_id: "22222222-2222-4222-8222-222222222222",
      reference: "Payroll August",
      authoritative_provider_field: "REFERENCE",
      normalization_version: "xero-reference-coordinate:v1",
      occurrence_key: "DOCUMENT_DATE",
    };
    duplicateSeriesReceipts.receipts[0].claims.recurring_series_authorities = [
      series,
      { ...series, authority_id: "recurring-sales-v2", reference: "payroll  august" },
    ];
    const duplicateSeriesReceiptBytes = resignTestXeroGovernanceReceiptSet(
      duplicateSeriesReceipts,
      seriesFixture.privateKey,
    );
    const duplicateSeriesStatus = structuredClone(seriesFixture.statusDocument) as any;
    duplicateSeriesStatus.claims.active_authorities[0].active_receipt_sha256 =
      duplicateSeriesReceipts.receipts[0].receipt_sha256;
    const duplicateSeriesStatusBytes = resignTestXeroGovernanceStatus(
      duplicateSeriesStatus,
      seriesFixture.privateKey,
    );
    expectRuntimeAndAdmissionToReject(seriesFixture, {
      receipts: duplicateSeriesReceiptBytes,
      status: duplicateSeriesStatusBytes,
    });
  });

  it("rejects a revoked receipt and status expiry even while the receipt remains valid", () => {
    const revoked = createTestXeroGovernanceArtifacts(undefined, { revoked: true });
    const input = {
      trustBundle: revoked.trustBundle,
      receipts: revoked.receipts,
      status: revoked.status,
      env: {
        XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: revoked.expectedTrustBundleSha256,
        XERO_GOVERNANCE_RECEIPTS_SHA256: revoked.expectedReceiptsSha256,
        XERO_GOVERNANCE_STATUS_SHA256: revoked.expectedStatusSha256,
      },
    };
    expect(() => verifyCapturedGovernanceAuthority({ ...input, now: TEST_GOVERNANCE_NOW }))
      .toThrow("PRODUCTION_GOVERNANCE_RECEIPT_NOT_ACTIVE");

    const active = createTestXeroGovernanceArtifacts();
    expect(() => verifyCapturedGovernanceAuthority({
      trustBundle: active.trustBundle,
      receipts: active.receipts,
      status: active.status,
      env: {
        XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: active.expectedTrustBundleSha256,
        XERO_GOVERNANCE_RECEIPTS_SHA256: active.expectedReceiptsSha256,
        XERO_GOVERNANCE_STATUS_SHA256: active.expectedStatusSha256,
      },
      now: new Date("2026-08-14T00:45:00.000Z"),
    })).toThrow("PRODUCTION_GOVERNANCE_STATUS_NOT_CURRENT");
  });

  it("rejects a group/world-writable ancestor", async () => {
    const fixture = await trustFixture();
    try {
      const writable = join(fixture.root, "writable");
      await mkdir(writable, { mode: 0o700 });
      await chmod(writable, 0o777);
      const nested = join(writable, "receipt.json");
      await writeFile(nested, "{}\n", { mode: 0o600 });
      await expect(readTrustedRegularFile(nested, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
      })).rejects.toThrow("PRODUCTION_TRUST_DIRECTORY_UNSAFE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects a path swap after O_NOFOLLOW open instead of mixing snapshots", async () => {
    const fixture = await trustFixture();
    try {
      await expect(readTrustedRegularFile(fixture.file, {
        anchor: fixture.root,
        expectedUid: uid,
        includeAnchorAncestors: false,
        afterOpen: async () => {
          await rename(fixture.file, join(fixture.root, "original.json"));
          await writeFile(fixture.file, "attacker\n", { mode: 0o600 });
        },
      })).rejects.toThrow("PRODUCTION_TRUST_FILE_CHANGED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate env keys and validates pulled digest, image ID, labels, and config env", () => {
    expect(() => parseCapturedReleaseEnvironment(Buffer.from("APP_IMAGE=a@sha256:" + "a".repeat(64) +
      "\nAPP_IMAGE=b@sha256:" + "b".repeat(64) + "\n")))
      .toThrow("PRODUCTION_RELEASE_ENV_INVALID");

    const catalog = "c".repeat(64);
    const manifest = `sha256:${"d".repeat(64)}`;
    const config = `sha256:${"e".repeat(64)}`;
    const env = { APP_IMAGE: `registry.example/xero@${manifest}`, XERO_APPROVED_CONTROL_CATALOG_SHA256: catalog };
    const receipt = {
      ociManifestDigest: manifest,
      ociConfigDigest: config,
      semanticBuildIdentityHash: "1".repeat(64),
      acceptanceSourceSha256: "2".repeat(64),
      sourceArchiveSha256: "3".repeat(64),
    };
    const embeddedIdentity = JSON.stringify({
      acceptanceSourceSha256: receipt.acceptanceSourceSha256,
      sourceArchiveSha256: receipt.sourceArchiveSha256,
    });
    const inspection = {
      RepoDigests: [env.APP_IMAGE],
      Id: config,
      Config: {
        Labels: {
          "io.zcloak.xero.build-identity-hash": receipt.semanticBuildIdentityHash,
          "io.zcloak.xero.acceptance-source-sha256": receipt.acceptanceSourceSha256,
          "io.zcloak.xero.source-archive-sha256": receipt.sourceArchiveSha256,
          "io.zcloak.xero.approved-control-catalog-sha256": catalog,
        },
        Env: [
          `XERO_APPROVED_CONTROL_CATALOG_SHA256=${catalog}`,
          `XERO_BUILD_IDENTITY_JSON=${embeddedIdentity}`,
        ],
      },
    };
    expect(assertPulledProductionImageIdentity(inspection, env, receipt)).toBe(true);
    expect(() => assertPulledProductionImageIdentity({ ...inspection, RepoDigests: [] }, env, receipt))
      .toThrow("PRODUCTION_IMAGE_REPODIGEST_MISMATCH");

    // The server publishes its build identity from this variable. A deployment env
    // file supplying it silently wins over the value the image baked in, so the
    // running server would attest to a build it is not executing.
    const stripped = {
      ...inspection,
      Config: { ...inspection.Config, Env: [`XERO_APPROVED_CONTROL_CATALOG_SHA256=${catalog}`] },
    };
    expect(() => assertPulledProductionImageIdentity(stripped, env, receipt))
      .toThrow("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_MISSING");
    const foreign = {
      ...inspection,
      Config: {
        ...inspection.Config,
        Env: [
          `XERO_APPROVED_CONTROL_CATALOG_SHA256=${catalog}`,
          `XERO_BUILD_IDENTITY_JSON=${JSON.stringify({ acceptanceSourceSha256: "9".repeat(64), sourceArchiveSha256: receipt.sourceArchiveSha256 })}`,
        ],
      },
    };
    expect(() => assertPulledProductionImageIdentity(foreign, env, receipt))
      .toThrow("PRODUCTION_IMAGE_BUILD_IDENTITY_ENV_MISMATCH");
    expect(assertPulledProductionImageIdentity(inspection, { ...env, XERO_BUILD_IDENTITY_JSON: embeddedIdentity }, receipt))
      .toBe(true);
    expect(() => assertPulledProductionImageIdentity(inspection, {
      ...env,
      XERO_BUILD_IDENTITY_JSON: JSON.stringify({
        acceptanceSourceSha256: "8".repeat(64),
        sourceArchiveSha256: "7".repeat(64),
      }),
    }, receipt)).toThrow("PRODUCTION_BUILD_IDENTITY_OVERRIDE_MISMATCH");
  });

  it("captures the exact authority revision, write mode, and standing-delegation bytes", () => {
    expect(parseCapturedReleaseEnvironment(capturedReleaseEnvironment())).toMatchObject({
      XERO_AUTHORITY_REVISION: "7",
      XERO_WRITE_ENABLED: "false",
      XERO_FIRM_GOVERNANCE_REQUIRED: "false",
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: sha256("[]"),
      XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256: "6".repeat(64),
      XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "NOT_REQUIRED",
    });
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: "f".repeat(64),
    }))).toThrow("PRODUCTION_RELEASE_ENV_STANDING_DELEGATIONS_DIGEST_MISMATCH");
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
      XERO_AUTHORITY_REVISION: "0",
    }))).toThrow("PRODUCTION_RELEASE_ENV_AUTHORITY_REVISION_INVALID");
  });

  it("strictly validates standing delegations before any container or migration", () => {
    const valid = {
      delegation_id: "work-xero-agent-v1",
      revision: 1,
      status: "ACTIVE",
      workspace_id: "workspace-test",
      agent_id: "agent-test",
      installation_id: "installation-test",
      tenant_id: "11111111-1111-4111-8111-111111111111",
      action_ids: ["supplier_bill.create_draft"],
      expires_at: "2026-08-14T00:30:00.000Z",
    };
    const active = JSON.stringify([valid]);
    expect(parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
      XERO_WRITE_ENABLED: "true",
      XERO_STANDING_DELEGATIONS_JSON: active,
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: sha256(active),
      XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "5".repeat(64),
    }))).toMatchObject({ XERO_FIRM_GOVERNANCE_REQUIRED: "true" });

    for (const invalid of [
      [{ ...valid, tenant_id: "not-a-uuid" }],
      [{ ...valid, action_ids: ["payment.create"] }],
      [{ ...valid, action_ids: ["supplier_bill.create_draft", "supplier_bill.create_draft"] }],
      [{ ...valid, expires_at: "tomorrow" }],
      [{ ...valid, candidate_extra_authority: true }],
      [valid, { ...valid }],
    ]) {
      const json = JSON.stringify(invalid);
      expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
        XERO_WRITE_ENABLED: "true",
        XERO_STANDING_DELEGATIONS_JSON: json,
        XERO_STANDING_DELEGATIONS_CONFIG_SHA256: sha256(json),
        XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "5".repeat(64),
      }))).toThrow("PRODUCTION_RELEASE_ENV_STANDING_DELEGATIONS_INVALID");
    }
  });

  it("requires host-approved expected snapshot and governance aggregate identities", () => {
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
      XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256: "",
    }))).toThrow("PRODUCTION_RELEASE_ENV_REQUIRED:XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256");
    expect(() => parseCapturedReleaseEnvironment(capturedReleaseEnvironment({
      XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "f".repeat(64),
    }))).toThrow("PRODUCTION_RELEASE_ENV_FIRM_GOVERNANCE_AGGREGATE_UNEXPECTED");
  });

  it("forbids verify-then-compose separation and path-rereading cutover scripts", () => {
    const runbook = [
      "--approved-control-catalog-sha256",
      "/srv/xero-accounting-mcp/release",
      "/etc/xero-accounting-mcp/release.env",
      "sudo deploy/scripts/admit-and-compose.sh host-green-up",
      "docker compose -f deploy/docker-compose/compose.vps.yaml up -d --no-build accounting-mcp",
    ].join("\n");
    expect(() => assertProductionRunbookContract("runbook", Buffer.from(runbook)))
      .toThrow("PRODUCTION_RUNBOOK_DIRECT_MUTATION_FORBIDDEN");

    const wrapper = "case \"${1:-}\" in\n/usr/bin/node scripts/release/production-deployment-admission.mjs\n";
    expect(() => assertProductionAdmissionWrapperContract("wrapper", Buffer.from(wrapper)))
      .toThrow("PRODUCTION_ADMISSION_WRAPPER_ORDER_INVALID");

    const cutover = [
      "/usr/bin/node scripts/release/production-deployment-admission.mjs --format fields",
      "RELEASE_ENV_OVERRIDE_FORBIDDEN",
      "activeAccountingCaseRecoveryProjection COMPATIBLE",
      "release_env_value APP_IMAGE",
    ].join("\n");
    expect(() => assertProductionCutoverContract("cutover", Buffer.from(cutover)))
      .toThrow("PRODUCTION_CUTOVER_PATH_REREAD_FORBIDDEN");
  });

  it("does not admit a legacy green cutover that omits active recovery projection readiness", () => {
    const legacyCutover = [
      "/usr/bin/node scripts/release/production-deployment-admission.mjs --format fields",
      "RELEASE_ENV_OVERRIDE_FORBIDDEN",
      "grep -Fq '\"status\":\"ready\"'",
    ].join("\n");
    expect(() => assertProductionCutoverContract("legacy-cutover", Buffer.from(legacyCutover)))
      .toThrow("PRODUCTION_CUTOVER_ACTIVE_RECOVERY_PROJECTION_GUARD_MISSING");
  });

  it.each([
    "deploy/docker-compose/compose.vps.yaml",
    "deploy/docker-compose/compose.host-nginx.vps.yaml",
    "deploy/docker-compose/compose.host-nginx.green.vps.yaml",
  ])("pins governance mounts and hashes in %s", async (path) => {
    const original = (await readFile(path)).toString("utf8");
    expect(assertProductionComposeContract(path, Buffer.from(original))).toBe(true);
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      "/etc/xero-accounting-mcp/governance/receipts.json",
      "/tmp/candidate-receipts.json",
    )))).toThrow("PRODUCTION_COMPOSE_GOVERNANCE_MOUNT_PATH_INVALID");
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      "/run/xero-governance/status.json",
      "/tmp/status.json",
    )))).toThrow("PRODUCTION_COMPOSE_GOVERNANCE_MOUNT_PATH_INVALID");
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      "target: /run/xero-governance/trust-bundle.json\n        read_only: true",
      "target: /run/xero-governance/trust-bundle.json\n        read_only: false",
    )))).toThrow("PRODUCTION_COMPOSE_GOVERNANCE_MOUNT_UNSAFE");
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      /^\s*XERO_GOVERNANCE_STATUS_SHA256:.*\n/mu,
      "",
    )))).toThrow("PRODUCTION_COMPOSE_GOVERNANCE_HASH_REQUIRED");
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      /^\s*XERO_STANDING_DELEGATIONS_JSON:.*\n/mu,
      "",
    )))).toThrow("PRODUCTION_COMPOSE_AUTHORITY_CONFIG_REQUIRED");
    expect(() => assertProductionComposeContract(path, Buffer.from(original.replace(
      /^\s*XERO_AUTHORITY_REVISION:.*\n/mu,
      "",
    )))).toThrow("PRODUCTION_COMPOSE_AUTHORITY_CONFIG_REQUIRED");
  });
});
