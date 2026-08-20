import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { hashObject } from "../src/security/hash.js";
import { createXeroRuntimeAttestation, XERO_RELEASE_ATTESTATION } from "../src/xeroRelease.js";
import { XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION } from "../src/policy/xeroAccountingCaseProviderContract.js";
import { XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION } from "../src/policy/xeroDeclaredLedgerPolicy.js";
import {
  EXPECTED_XERO_DUPLICATE_INDEXES,
  type XeroDuplicateIndexCatalogRow,
} from "../src/db/xeroDuplicateIndexReadiness.js";

const requiredMigration = XERO_RELEASE_ATTESTATION.requiredMigration;
const requiredRecoveryProjection = {
  status: "COMPATIBLE" as const,
  activeCaseCount: 0,
  storedPolicyProjectionVersions: [],
  storedProviderProjectionVersions: [],
  requiredPolicyProjectionVersion: XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
  requiredProviderProjectionVersion: XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
};
const repositories: PostgresAccountingRepository[] = [];
const unknownAuthorityReadiness = {
  authoritySnapshotRevision: null,
  authoritySnapshotHash: null,
  authorityContentHash: null,
  authorityWriteKillSwitchEnabled: null,
  firmGovernance: {
    status: "UNKNOWN",
    repositoryObservedAt: expect.any(String),
    requiredDelegationCount: null,
    authorityCount: null,
    authorityAggregateHash: null,
    trustBundleFileSha256: null,
    receiptsFileSha256: null,
    statusFileSha256: null,
    minEffectiveExpiresAt: null,
  },
};

function exactDuplicateIndexRows(): XeroDuplicateIndexCatalogRow[] {
  return Object.entries(EXPECTED_XERO_DUPLICATE_INDEXES).map(([indexName, expected]) => ({
    indexName,
    accessMethod: "btree",
    isUnique: true,
    isValid: true,
    isReady: true,
    keyDefinitions: [...expected.keyDefinitions],
    predicate: expected.predicate,
  }));
}

function mockReadinessConnections(
  repository: PostgresAccountingRepository,
  outcomes: Array<Record<string, unknown> | Error>,
) {
  const queries: Array<[string, unknown[] | undefined]> = [];
  vi.spyOn(repository.pool, "connect").mockImplementation(async () => {
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("missing readiness test outcome");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push([sql, params]);
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)) return { rows: [] };
      if (sql.includes("AS ready")) return { rows: [{ ready: true }] };
      if (sql.includes("FROM pg_index index_meta")) return { rows: exactDuplicateIndexRows() };
      if (sql.includes("schema_migrations")) {
        if (outcome instanceof Error) throw outcome;
        return { rows: [outcome] };
      }
      if (sql.includes("WITH active_recovery")) {
        const row = outcome instanceof Error ? {
          active_recovery_case_count: "0",
          stored_policy_projection_versions: [],
          stored_provider_projection_versions: [],
          active_recovery_projection_valid: true,
          active_recovery_projection_compatible: true,
        } : outcome;
        return { rows: [row] };
      }
      if (sql.includes("ledger_authority_snapshots")) {
        return { rows: [{ provider_id: null, repository_observed_at: new Date("2026-08-13T22:00:00.000Z") }] };
      }
      throw new Error("unexpected readiness test query");
    });
    return { query, release: vi.fn() } as never;
  });
  return queries;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

describe("repository runtime readiness evidence", () => {
  it("binds write mode, storage mode, migration status, and migration head into the dynamic hash", () => {
    const baseline = {
      buildIdentityHash: "c".repeat(64),
      acceptanceSourceSha256: "d".repeat(64),
      sourceArchiveSha256: "e".repeat(64),
      writeMode: "READ_ONLY" as const,
      processWriteGateEnabled: true,
      configuredAuthorityRevision: 2,
      standingDelegationsConfigSha256: "7".repeat(64),
      authoritySnapshotRevision: 2,
      authoritySnapshotHash: "a".repeat(64),
      authorityWriteKillSwitchEnabled: false,
      storageMode: "POSTGRES" as const,
      repositoryReady: true,
      requiredMigration,
      requiredMigrationStatus: "APPLIED" as const,
      migrationHead: requiredMigration,
      activeAccountingCaseRecoveryProjection: requiredRecoveryProjection,
      firmGovernance: {
        status: "CURRENT" as const,
        repositoryObservedAt: "2026-08-13T22:00:00.000Z",
        requiredDelegationCount: 1,
        authorityCount: 3,
        authorityAggregateHash: "9".repeat(64),
        trustBundleFileSha256: "1".repeat(64),
        receiptsFileSha256: "2".repeat(64),
        statusFileSha256: "3".repeat(64),
        minEffectiveExpiresAt: "2026-08-13T22:30:00.000Z",
      },
    };
    const baselineHash = hashObject(createXeroRuntimeAttestation(baseline));
    const variants = [
      { ...baseline, buildIdentityHash: "f".repeat(64) },
      { ...baseline, acceptanceSourceSha256: "1".repeat(64) },
      { ...baseline, sourceArchiveSha256: "2".repeat(64) },
      { ...baseline, writeMode: "WRITE_ENABLED" as const },
      { ...baseline, processWriteGateEnabled: false },
      { ...baseline, configuredAuthorityRevision: 3 },
      { ...baseline, standingDelegationsConfigSha256: "8".repeat(64) },
      { ...baseline, authoritySnapshotRevision: 3 },
      { ...baseline, authoritySnapshotHash: "b".repeat(64) },
      { ...baseline, authorityWriteKillSwitchEnabled: true },
      { ...baseline, storageMode: "IN_MEMORY" as const },
      { ...baseline, repositoryReady: false },
      { ...baseline, requiredMigrationStatus: "MISSING" as const },
      { ...baseline, migrationHead: "030_accounting_case_preflight_reseal.sql" },
      { ...baseline, activeAccountingCaseRecoveryProjection: {
        ...requiredRecoveryProjection,
        status: "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION" as const,
        activeCaseCount: 1,
        storedPolicyProjectionVersions: ["xero-sg-accounting-policy-projection:v3"],
      } },
    ];
    for (const variant of variants) {
      expect(hashObject(createXeroRuntimeAttestation(variant))).not.toBe(baselineHash);
    }
  });

  it("marks the in-memory implementation explicitly as migration not applicable", async () => {
    const repository = new InMemoryAccountingRepository();
    await expect(repository.readinessEvidence(requiredMigration)).resolves.toEqual({
      ready: true,
      storageMode: "IN_MEMORY",
      requiredMigration,
      requiredMigrationStatus: "NOT_APPLICABLE",
      migrationHead: null,
      activeAccountingCaseRecoveryProjection: requiredRecoveryProjection,
      ...unknownAuthorityReadiness,
    });
  });

  it("reports the actual PostgreSQL migration head and required migration status", async () => {
    const repository = new PostgresAccountingRepository("postgres://unused.invalid/runtime-attestation");
    repositories.push(repository);
    const queries = mockReadinessConnections(repository, [{
        required_migration_applied: true,
        migration_head: requiredMigration,
        active_recovery_case_count: "0",
        stored_policy_projection_versions: [],
        stored_provider_projection_versions: [],
        active_recovery_projection_valid: true,
        active_recovery_projection_compatible: true,
    }]);

    await expect(repository.readinessEvidence(requiredMigration)).resolves.toEqual({
      ready: true,
      storageMode: "POSTGRES",
      requiredMigration,
      requiredMigrationStatus: "APPLIED",
      migrationHead: requiredMigration,
      activeAccountingCaseRecoveryProjection: requiredRecoveryProjection,
      ...unknownAuthorityReadiness,
    });
    expect(queries).toContainEqual([
      expect.stringContaining("schema_migrations"),
      [
        requiredMigration,
        XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
        XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
      ],
    ]);
  });

  it("fails closed when PostgreSQL lacks the required migration or cannot attest its schema", async () => {
    const repository = new PostgresAccountingRepository("postgres://unused.invalid/runtime-attestation");
    repositories.push(repository);
    mockReadinessConnections(repository, [{
        required_migration_applied: false,
        migration_head: "030_accounting_case_preflight_reseal.sql",
        active_recovery_case_count: "1",
        stored_policy_projection_versions: ["xero-sg-accounting-policy-projection:v3"],
        stored_provider_projection_versions: ["xero-accounting-case-provider-projection:v4"],
        active_recovery_projection_valid: true,
        active_recovery_projection_compatible: false,
    }, new Error("must not escape into public evidence")]);

    await expect(repository.readinessEvidence(requiredMigration)).resolves.toEqual({
      ready: false,
      storageMode: "POSTGRES",
      requiredMigration,
      requiredMigrationStatus: "MISSING",
      migrationHead: "030_accounting_case_preflight_reseal.sql",
      activeAccountingCaseRecoveryProjection: {
        ...requiredRecoveryProjection,
        status: "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
        activeCaseCount: 1,
        storedPolicyProjectionVersions: ["xero-sg-accounting-policy-projection:v3"],
        storedProviderProjectionVersions: ["xero-accounting-case-provider-projection:v4"],
      },
      ...unknownAuthorityReadiness,
    });

    await expect(repository.readinessEvidence(requiredMigration)).resolves.toEqual({
      ready: false,
      storageMode: "POSTGRES",
      requiredMigration,
      requiredMigrationStatus: "UNKNOWN",
      migrationHead: null,
      activeAccountingCaseRecoveryProjection: {
        ...requiredRecoveryProjection,
        status: "UNKNOWN",
        activeCaseCount: null,
      },
      authoritySnapshotRevision: null,
      authoritySnapshotHash: null,
      authorityContentHash: null,
      authorityWriteKillSwitchEnabled: null,
      firmGovernance: {
        ...unknownAuthorityReadiness.firmGovernance,
        repositoryObservedAt: null,
      },
    });
  });

  it("fails closed on an unsupported active recovery projection even when schema readiness is green", async () => {
    const repository = new PostgresAccountingRepository("postgres://unused.invalid/runtime-attestation");
    repositories.push(repository);
    mockReadinessConnections(repository, [{
        required_migration_applied: true,
        migration_head: requiredMigration,
        active_recovery_case_count: "2",
        stored_policy_projection_versions: [
          "xero-sg-accounting-policy-projection:v3",
          "xero-sg-accounting-policy-projection:v4",
        ],
        stored_provider_projection_versions: ["xero-accounting-case-provider-projection:v4"],
        active_recovery_projection_valid: true,
        active_recovery_projection_compatible: false,
    }]);

    await expect(repository.readinessEvidence(requiredMigration)).resolves.toMatchObject({
      ready: false,
      requiredMigrationStatus: "APPLIED",
      activeAccountingCaseRecoveryProjection: {
        status: "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
        activeCaseCount: 2,
        storedPolicyProjectionVersions: [
          "xero-sg-accounting-policy-projection:v3",
          "xero-sg-accounting-policy-projection:v4",
        ],
        storedProviderProjectionVersions: ["xero-accounting-case-provider-projection:v4"],
      },
    });
  });

  it("does not expose malformed schema-version content as a stored version", async () => {
    const repository = new PostgresAccountingRepository("postgres://unused.invalid/runtime-attestation");
    repositories.push(repository);
    const injectedCaseIdentity = "case-secret-identity-must-not-escape";
    mockReadinessConnections(repository, [{
      required_migration_applied: true,
      migration_head: requiredMigration,
      active_recovery_case_count: "1",
      stored_policy_projection_versions: [injectedCaseIdentity],
      stored_provider_projection_versions: ["xero-accounting-case-provider-projection:v4"],
      active_recovery_projection_valid: false,
      active_recovery_projection_compatible: false,
    }]);

    const evidence = await repository.readinessEvidence(requiredMigration);
    expect(evidence).toMatchObject({
      ready: false,
      activeAccountingCaseRecoveryProjection: {
        status: "UNKNOWN",
        activeCaseCount: null,
        storedPolicyProjectionVersions: [],
        storedProviderProjectionVersions: [],
      },
    });
    expect(JSON.stringify(evidence)).not.toContain(injectedCaseIdentity);
  });
});
