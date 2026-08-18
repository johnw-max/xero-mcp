import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { hashObject } from "../src/security/hash.js";
import {
  createLedgerAuthoritySnapshot,
  legacyLedgerAuthoritySnapshotV1Hash,
} from "../src/domain/ledgerAuthority.js";
import { selectXeroFirmGovernanceClaim } from "../src/policy/xeroFirmGovernanceClaim.js";
import {
  verifyXeroExternalGovernanceAuthority,
  xeroStandingDelegationsWithExternalGovernance,
} from "../src/policy/xeroExternalGovernanceAuthority.js";
import { createTestXeroGovernanceArtifacts } from "./helpers/xeroGovernanceAuthority.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;
const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;

function connectionWithApplicationName(name: string): string {
  const value = new URL(databaseUrl!);
  value.searchParams.set("application_name", name);
  return value.toString();
}

async function waitForAdvisoryWait(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await repository!.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'
       ) AS waiting`,
      [applicationName],
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${applicationName} on the authority publication lock.`);
}

const governedTenantId = "22222222-2222-4222-8222-222222222222";

async function governedSnapshot(
  revision: number,
  delegationExpiresAt: Date,
  authorityExpiresAt: Date,
) {
  const artifacts = createTestXeroGovernanceArtifacts(governedTenantId);
  const verified = verifyXeroExternalGovernanceAuthority({
    trustBundle: artifacts.trustBundle,
    receipts: artifacts.receipts,
    status: artifacts.status,
    expectedTrustBundleSha256: artifacts.expectedTrustBundleSha256,
    expectedReceiptsSha256: artifacts.expectedReceiptsSha256,
    expectedStatusSha256: artifacts.expectedStatusSha256,
    now: new Date("2026-08-14T00:00:00.000Z"),
  });
  const adjusted = {
    ...verified,
    ledgerFirmGovernanceAuthorities: verified.ledgerFirmGovernanceAuthorities.map((authority) => ({
      ...authority,
      effectiveExpiresAt: authorityExpiresAt,
    })),
  };
  const snapshot = createLedgerAuthoritySnapshot({
    providerId: "xero",
    revision,
    writeKillSwitchEnabled: true,
    standingDelegations: xeroStandingDelegationsWithExternalGovernance(adjusted, [{
      delegationId: "pg-governed-delegation",
      revision: 3,
      status: "ACTIVE",
      providerId: "xero",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      tenantIds: [governedTenantId],
      actionIds: ["supplier_bill.create_draft"],
      expiresAt: delegationExpiresAt,
      firmGovernanceRequired: true,
    }]),
    publishedAt: new Date(),
  });
  const claim = selectXeroFirmGovernanceClaim(snapshot, {
    actionId: "supplier_bill.create_draft",
    tenantId: governedTenantId,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    installationId: "installation-test",
    expectation: {
      route: "SUPPLIER_BILL",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      authoritativeProviderField: "INVOICE_NUMBER",
    },
  });
  return { snapshot, claim };
}

function governedConfirmation(
  suffix: string,
  snapshot: Awaited<ReturnType<typeof governedSnapshot>>["snapshot"],
  claim: Awaited<ReturnType<typeof governedSnapshot>>["claim"],
  now: Date,
) {
  return {
    mutationRequestId: `xmr_${hashObject({ fixture: "pg-governed-mutation", suffix }).slice(0, 32)}`,
    preparationId: `xmp_${hashObject({ fixture: "pg-governed-preparation", suffix }).slice(0, 32)}`,
    requestId: `pg-governed-request-${suffix}`,
    actorId: "workspace-test:user:user-test",
    workspaceId: "workspace-test",
    tenantId: governedTenantId,
    installationId: "installation-test",
    bindingId: "binding-test",
    connectionId: "connection-test",
    objectType: "SUPPLIER_BILL" as const,
    operation: "CREATE_DRAFT" as const,
    canonicalPayload: { reference: `BILL-${suffix}` },
    canonicalPayloadHash: "a".repeat(64),
    sourceUnitKey: `pg-governed-source-${suffix}`,
    sourceSha256: "b".repeat(64),
    sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION" as const,
    confirmationSummaryHash: "c".repeat(64),
    confirmationPhraseHash: "d".repeat(64),
    authorizationReceipt: {
      receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
      receiptHash: "e".repeat(64),
      actionId: claim.actionId,
      delegationId: claim.delegationId,
      delegationRevision: claim.delegationRevision,
      authoritySnapshotRevision: snapshot.revision,
      authoritySnapshotHash: snapshot.snapshotHash,
      firmGovernanceClaim: claim,
    },
    claimForWrite: true,
    expectedAuthoritySnapshotRevision: snapshot.revision,
    expectedAuthoritySnapshotHash: snapshot.snapshotHash,
    expectedFirmGovernanceClaim: claim,
    now,
  };
}

suite("PostgreSQL ledger authority snapshot control store", () => {
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), "migrations"));
    await repository!.pool.query("DELETE FROM ledger_authority_snapshots WHERE provider_id = 'xero'");
  });

  afterAll(async () => {
    await repository!.pool.query("DELETE FROM xero_mutation_requests WHERE request_id LIKE 'pg-governed-request-%'");
    await repository!.pool.query("DELETE FROM xero_mutation_preparations WHERE source_unit_key LIKE 'pg-governed-source-%'");
    await repository!.pool.query("DELETE FROM ledger_authority_snapshots WHERE provider_id = 'xero'");
    await repository!.close();
  });

  it("is reentrant at 032 and enforces monotonic publish across repository instances", async () => {
    await expect(runMigrations(databaseUrl!, resolve(process.cwd(), "migrations"))).resolves.toEqual([]);
    const rev1 = {
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: [{
        delegationId: "pg-authority-delegation",
        revision: 1,
        status: "ACTIVE" as const,
        providerId: "xero",
        workspaceId: "workspace-pg",
        agentId: "agent-pg",
        installationId: "installation-pg",
        tenantIds: ["tenant-pg"],
        actionIds: ["supplier_bill.create_draft"],
        expiresAt: new Date("2026-09-13T00:00:00.000Z"),
      }],
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    };
    await expect(repository!.publishLedgerAuthoritySnapshot(rev1)).resolves.toMatchObject({ mode: "CREATED" });
    await expect(repository!.getLedgerAuthoritySnapshot("xero")).resolves.toMatchObject({
      standingDelegations: [{ expiresAt: new Date("2026-09-13T00:00:00.000Z") }],
    });
    const second = new PostgresAccountingRepository(databaseUrl!);
    try {
      await expect(second.publishLedgerAuthoritySnapshot({
        ...rev1,
        revision: 2,
        writeKillSwitchEnabled: false,
        standingDelegations: [],
        publishedAt: new Date("2026-08-13T00:01:00.000Z"),
      })).resolves.toMatchObject({ mode: "ADVANCED", snapshot: { revision: 2 } });
      await expect(repository!.getLedgerAuthoritySnapshot("xero")).resolves.toMatchObject({
        revision: 2,
        writeKillSwitchEnabled: false,
      });
      await expect(repository!.publishLedgerAuthoritySnapshot(rev1)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await second.close();
    }
  });

  it("serializes the empty-table bootstrap race so rev1 cannot overwrite queued rev2", async () => {
    await repository!.pool.query("DELETE FROM ledger_authority_snapshots WHERE provider_id = 'xero'");
    const blocker = await repository!.pool.connect();
    const rev2Repository = new PostgresAccountingRepository(
      connectionWithApplicationName("authority-bootstrap-rev2"),
    );
    const rev1Repository = new PostgresAccountingRepository(
      connectionWithApplicationName("authority-bootstrap-rev1"),
    );
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)",
        [2_026_081_302, "xero"],
      );
      const rev2Promise = rev2Repository.publishLedgerAuthoritySnapshot({
        providerId: "xero",
        revision: 2,
        writeKillSwitchEnabled: false,
        standingDelegations: [],
        publishedAt: new Date("2026-08-13T00:01:00.000Z"),
      });
      await waitForAdvisoryWait("authority-bootstrap-rev2");
      const rev1Promise = rev1Repository.publishLedgerAuthoritySnapshot({
        providerId: "xero",
        revision: 1,
        writeKillSwitchEnabled: true,
        standingDelegations: [{
          delegationId: "stale-bootstrap-delegation",
          revision: 1,
          status: "ACTIVE",
          providerId: "xero",
          workspaceId: "workspace-pg",
          agentId: "agent-pg",
          installationId: "installation-pg",
          tenantIds: ["tenant-pg"],
          actionIds: ["supplier_bill.create_draft"],
        }],
        publishedAt: new Date("2026-08-13T00:00:00.000Z"),
      });
      await waitForAdvisoryWait("authority-bootstrap-rev1");
      await blocker.query("COMMIT");
      await expect(rev2Promise).resolves.toMatchObject({ mode: "CREATED", snapshot: { revision: 2 } });
      await expect(rev1Promise).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(repository!.getLedgerAuthoritySnapshot("xero")).resolves.toMatchObject({
        revision: 2,
        writeKillSwitchEnabled: false,
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await rev2Repository.close();
      await rev1Repository.close();
    }
  }, 120_000);

  it("verifies a legacy v1 row and only replaces it with a strictly higher v2 revision", async () => {
    await repository!.pool.query("DELETE FROM ledger_authority_snapshots WHERE provider_id = 'xero'");
    const legacy = {
      providerId: "xero",
      revision: 7,
      writeKillSwitchEnabled: true,
      standingDelegations: [{
        delegationId: "legacy-pg-authority",
        revision: 1,
        status: "ACTIVE" as const,
        providerId: "xero",
        workspaceId: "workspace-pg",
        agentId: "agent-pg",
        installationId: "installation-pg",
        tenantIds: ["tenant-pg"],
        actionIds: ["supplier_bill.create_draft"],
      }],
    };
    await repository!.pool.query(
      `INSERT INTO ledger_authority_snapshots(
         provider_id, revision, snapshot_hash, write_kill_switch_enabled,
         standing_delegations, published_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)`,
      [
        legacy.providerId,
        legacy.revision,
        legacyLedgerAuthoritySnapshotV1Hash(legacy),
        legacy.writeKillSwitchEnabled,
        JSON.stringify(legacy.standingDelegations),
        new Date("2026-08-13T00:00:00.000Z"),
      ],
    );
    await expect(repository!.getLedgerAuthoritySnapshot("xero")).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
    });
    await expect(repository!.publishLedgerAuthoritySnapshot({
      ...legacy,
      publishedAt: new Date("2026-08-13T00:01:00.000Z"),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository!.publishLedgerAuthoritySnapshot({
      ...legacy,
      revision: 8,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T00:02:00.000Z"),
    })).resolves.toMatchObject({ mode: "ADVANCED", snapshot: { revision: 8 } });

    await repository!.pool.query(
      "UPDATE ledger_authority_snapshots SET revision = 9, snapshot_hash = $1 WHERE provider_id = 'xero'",
      ["0".repeat(64)],
    );
    await expect(repository!.publishLedgerAuthoritySnapshot({
      ...legacy,
      revision: 10,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T00:03:00.000Z"),
    })).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
  });

  it("re-establishes the exact governed delegation under lock and uses the database expiry boundary", async () => {
    await repository!.pool.query("DELETE FROM xero_mutation_requests WHERE request_id LIKE 'pg-governed-request-%'");
    await repository!.pool.query("DELETE FROM xero_mutation_preparations WHERE source_unit_key LIKE 'pg-governed-source-%'");
    await repository!.pool.query("DELETE FROM ledger_authority_snapshots WHERE provider_id = 'xero'");
    const clock = await repository!.pool.query<{ repository_now: Date }>(
      "SELECT statement_timestamp() AS repository_now",
    );
    const databaseNow = clock.rows[0]!.repository_now;

    const current = await governedSnapshot(
      20,
      new Date(databaseNow.getTime() + 60_000),
      new Date(databaseNow.getTime() + 3_600_000),
    );
    await repository!.publishLedgerAuthoritySnapshot({
      ...current.snapshot,
      publishedAt: current.snapshot.publishedAt,
    });
    const success = governedConfirmation("success", current.snapshot, current.claim, databaseNow);
    await repository!.createXeroMutationPreparation({
      ...success,
      expiresAt: new Date(databaseNow.getTime() + 3_600_000),
    });
    await expect(repository!.confirmXeroMutationPreparation(success)).resolves.toMatchObject({
      created: true,
      request: { state: "WRITE_IN_FLIGHT" },
    });

    const race = governedConfirmation("race", current.snapshot, current.claim, databaseNow);
    await repository!.createXeroMutationPreparation({
      ...race,
      expiresAt: new Date(databaseNow.getTime() + 3_600_000),
    });
    await repository!.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 21,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date(databaseNow.getTime() + 1),
    });
    await expect(repository!.confirmXeroMutationPreparation(race)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
    await expect(repository!.getXeroMutationRequest(race.mutationRequestId)).resolves.toBeUndefined();

    const expired = await governedSnapshot(22, databaseNow, new Date(databaseNow.getTime() + 3_600_000));
    await repository!.publishLedgerAuthoritySnapshot({
      ...expired.snapshot,
      publishedAt: expired.snapshot.publishedAt,
    });
    const boundary = governedConfirmation("boundary", expired.snapshot, expired.claim, databaseNow);
    await repository!.createXeroMutationPreparation({
      ...boundary,
      expiresAt: new Date(databaseNow.getTime() + 3_600_000),
    });
    await expect(repository!.confirmXeroMutationPreparation(boundary)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
    await expect(repository!.getXeroMutationRequest(boundary.mutationRequestId)).resolves.toBeUndefined();
  });
});
