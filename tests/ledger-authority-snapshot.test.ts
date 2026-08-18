import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import {
  MutableTestLedgerAuthoritySnapshotResolver,
  createLedgerAuthoritySnapshot,
  legacyLedgerAuthoritySnapshotV1Hash,
} from "../src/domain/ledgerAuthority.js";
import {
  verifyXeroExternalGovernanceAuthority,
  xeroStandingDelegationsWithExternalGovernance,
} from "../src/policy/xeroExternalGovernanceAuthority.js";
import { sha256 } from "../src/security/hash.js";
import {
  createTestXeroGovernanceArtifacts,
  resignTestXeroGovernanceStatus,
} from "./helpers/xeroGovernanceAuthority.js";

const active = [{
  delegationId: "authority-delegation-1",
  revision: 1,
  status: "ACTIVE" as const,
  providerId: "xero",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  installationId: "installation-1",
  tenantIds: ["tenant-1"],
  actionIds: ["supplier_bill.create_draft"],
}];

describe("versioned ledger authority snapshot", () => {
  it("hashes only canonical authority content, not publication time or input ordering", () => {
    const first = createLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: active,
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    const replay = createLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: [{ ...active[0]!, actionIds: [...active[0]!.actionIds].reverse() }],
      publishedAt: new Date("2026-08-13T01:00:00.000Z"),
    });
    expect(replay.snapshotHash).toBe(first.snapshotHash);
  });

  it("allows same-revision same-hash replay and rejects drift or rollback", async () => {
    const repository = new InMemoryAccountingRepository();
    const rev1 = {
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: active,
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    };
    await expect(repository.publishLedgerAuthoritySnapshot(rev1)).resolves.toMatchObject({ mode: "CREATED" });
    await expect(repository.publishLedgerAuthoritySnapshot({
      ...rev1,
      publishedAt: new Date("2026-08-13T00:01:00.000Z"),
    })).resolves.toMatchObject({ mode: "IDEMPOTENT_REPLAY" });
    await expect(repository.publishLedgerAuthoritySnapshot({
      ...rev1,
      writeKillSwitchEnabled: false,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await repository.publishLedgerAuthoritySnapshot({
      ...rev1,
      revision: 2,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
    });
    await expect(repository.publishLedgerAuthoritySnapshot(rev1)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a higher authority revision when a signed governance status is renewed", async () => {
    const repository = new InMemoryAccountingRepository();
    const now = new Date("2026-08-14T00:30:00.000Z");
    const artifacts = createTestXeroGovernanceArtifacts("11111111-1111-4111-8111-111111111111", { now });
    const verified = (status: Buffer) => verifyXeroExternalGovernanceAuthority({
      trustBundle: artifacts.trustBundle,
      receipts: artifacts.receipts,
      status,
      expectedTrustBundleSha256: artifacts.expectedTrustBundleSha256,
      expectedReceiptsSha256: artifacts.expectedReceiptsSha256,
      expectedStatusSha256: sha256(status),
      now,
    });
    const rawDelegation = [{
      delegationId: "governance-renewal-delegation",
      revision: 1,
      status: "ACTIVE" as const,
      providerId: "xero" as const,
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      tenantIds: ["11111111-1111-4111-8111-111111111111"],
      actionIds: ["supplier_bill.create_draft"],
      firmGovernanceRequired: true,
    }];
    const initial = xeroStandingDelegationsWithExternalGovernance(verified(artifacts.status), rawDelegation);
    await expect(repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 20,
      writeKillSwitchEnabled: true,
      standingDelegations: initial,
      publishedAt: now,
    })).resolves.toMatchObject({ mode: "CREATED" });

    const renewedDocument = structuredClone(artifacts.statusDocument) as Record<string, any>;
    renewedDocument.claims.issued_at = "2026-08-14T00:15:00.000Z";
    renewedDocument.claims.expires_at = "2026-08-14T01:15:00.000Z";
    const renewedStatus = resignTestXeroGovernanceStatus(renewedDocument, artifacts.privateKey);
    const renewed = xeroStandingDelegationsWithExternalGovernance(verified(renewedStatus), rawDelegation);
    expect(renewed[0]?.firmGovernanceAuthorities).not.toEqual(initial[0]?.firmGovernanceAuthorities);
    await expect(repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 20,
      writeKillSwitchEnabled: true,
      standingDelegations: renewed,
      publishedAt: new Date("2026-08-14T00:31:00.000Z"),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 21,
      writeKillSwitchEnabled: true,
      standingDelegations: renewed,
      publishedAt: new Date("2026-08-14T00:31:00.000Z"),
    })).resolves.toMatchObject({ mode: "ADVANCED", snapshot: { revision: 21 } });
  });

  it("gives test code an explicit monotonic mutable resolver", async () => {
    const resolver = new MutableTestLedgerAuthoritySnapshotResolver({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: active,
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    resolver.publish({
      providerId: "xero",
      revision: 2,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T00:01:00.000Z"),
    });
    await expect(resolver.resolveCurrent()).resolves.toMatchObject({ revision: 2, writeKillSwitchEnabled: false });
    expect(() => resolver.publish({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: active,
      publishedAt: new Date("2026-08-13T00:02:00.000Z"),
    })).toThrow("revision cannot decrease");
  });

  it("treats v1 as typed stale and only advances a valid v1 at a higher v2 revision", async () => {
    const repository = new InMemoryAccountingRepository();
    const legacy = {
      providerId: "xero",
      revision: 7,
      writeKillSwitchEnabled: true,
      standingDelegations: active,
    };
    repository.seedLegacyLedgerAuthoritySnapshotForTest(
      legacy,
      legacyLedgerAuthoritySnapshotV1Hash(legacy),
    );
    await expect(repository.getLedgerAuthoritySnapshot("xero")).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
    });
    await expect(repository.publishLedgerAuthoritySnapshot({
      ...legacy,
      publishedAt: new Date("2026-08-13T01:00:00.000Z"),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.publishLedgerAuthoritySnapshot({
      ...legacy,
      revision: 8,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T01:01:00.000Z"),
    })).resolves.toMatchObject({ mode: "ADVANCED", snapshot: { revision: 8 } });

    const corrupt = new InMemoryAccountingRepository();
    corrupt.seedLegacyLedgerAuthoritySnapshotForTest(legacy, "0".repeat(64));
    await expect(corrupt.publishLedgerAuthoritySnapshot({
      ...legacy,
      revision: 8,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T01:02:00.000Z"),
    })).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
  });
});
