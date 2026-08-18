import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { LedgerTargetSessionService } from "../src/services/ledgerTargetSessionService.js";
import { OrganisationSwitchService } from "../src/services/organisationSwitchService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres per-conversation Xero ledger targets", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const cleanupInstallations = new Map<string, string>();

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await repository?.close();
  });

  afterEach(async () => {
    if (!repository) return;
    const revokedAt = new Date();
    for (const [installationId, workspaceId] of cleanupInstallations) {
      await repository.revokeOAuthInstallation(installationId, workspaceId, revokedAt);
    }
    cleanupInstallations.clear();
  });

  it("keeps concurrent conversations pinned to different organisations and cleans expired capabilities", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date("2026-08-12T08:00:00.000Z");
    const tokenExpiry = new Date(now.getTime() + 60 * 60_000);
    const ticket = Buffer.from(`switch-${suffix}`, "utf8").toString("base64url").slice(0, 43).padEnd(43, "s");
    const secondTicket = Buffer.from(`switch-second-${suffix}`, "utf8").toString("base64url").slice(0, 43).padEnd(43, "r");
    let currentTime = new Date(now);
    let referenceSequence = 0;
    let switchSequence = 0;
    const ids = {
      authorization: `target-auth-${suffix}`,
      workspace: `target-workspace-${suffix}`,
      user: `target-user-${suffix}`,
      agent: `target-agent-${suffix}`,
      installation: `target-installation-${suffix}`,
      client: `target-client-${suffix}`,
      policy: `target-policy-${suffix}`,
      bindingA: `target-binding-a-${suffix}`,
      bindingB: `target-binding-b-${suffix}`,
      connectionA: `target-connection-a-${suffix}`,
      connectionB: `target-connection-b-${suffix}`,
      accessHash: `target-access-hash-${suffix}`,
      accessId: `target-access-id-${suffix}`,
    };
    cleanupInstallations.set(ids.installation, ids.workspace);
    await repository.saveProviderAuthorization({
      authorizationId: ids.authorization,
      workspaceId: ids.workspace,
      authorizedBySubject: ids.user,
      provider: "xero",
      grantedScopes: ["accounting.settings.read", "accounting.transactions.read"],
      tokenCiphertext: `encrypted-target-token-${suffix}`,
      tokenExpiresAt: tokenExpiry,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    for (const [connectionId, tenantId, tenantName] of [
      [ids.connectionA, `target-tenant-a-${suffix}`, "Client Company A"],
      [ids.connectionB, `target-tenant-b-${suffix}`, "Client Company B"],
    ] as const) {
      await repository.upsertAuthorizedProviderConnection(ids.workspace, {
        connectionId,
        authorizationId: ids.authorization,
        provider: "xero",
        providerConnectionId: `provider-${connectionId}`,
        tenantId,
        tenantName,
        status: "ACTIVE",
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    await repository.saveOAuthInstallation({
      installationId: ids.installation,
      workspaceId: ids.workspace,
      subjectType: "USER",
      subjectId: ids.user,
      agentId: ids.agent,
      clientId: ids.client,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveAgentConnectionBinding({
      bindingId: ids.bindingA,
      installationId: ids.installation,
      workspaceId: ids.workspace,
      subjectType: "USER",
      subjectId: ids.user,
      agentId: ids.agent,
      connectionId: ids.connectionA,
      policyId: ids.policy,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    const resource = "https://xero-mcp.example.test/mcp";
    await repository.saveMcpAccessToken({
      tokenHash: ids.accessHash,
      tokenId: ids.accessId,
      installationId: ids.installation,
      bindingId: ids.bindingA,
      connectionId: ids.connectionA,
      clientId: ids.client,
      resource,
      audience: resource,
      grantedScopes: ["xero.read"],
      issuedAt: now,
      expiresAt: tokenExpiry,
    });
    const resolveContext = async () => {
      const resolved = await repository.resolveMcpAccessToken({
        tokenHash: ids.accessHash,
        expectedResource: resource,
        expectedAudience: resource,
        now: currentTime,
      });
      if (!resolved) throw new Error("seeded MCP token did not resolve");
      return createOAuthRequestContext({ issuer: "https://xero-mcp.example.test", resolvedToken: resolved });
    };
    const targets = new LedgerTargetSessionService({
      repository,
      secret: Buffer.alloc(32, 9),
      required: true,
      ttlMs: 30 * 60_000,
      clock: () => new Date(currentTime),
      referenceFactory: () => {
        referenceSequence += 1;
        return `xts_${Buffer.alloc(32, referenceSequence).toString("base64url")}`;
      },
      sessionIdFactory: () => `target-session-${suffix}-${referenceSequence}`,
    });
    const switchService = new OrganisationSwitchService({
      repository,
      publicBaseUrl: "https://xero-mcp.example.test",
      secret: Buffer.alloc(32, 7),
      clock: () => new Date(currentTime),
      ticketFactory: () => {
        switchSequence += 1;
        return switchSequence === 1 ? ticket : secondTicket;
      },
      bindingIdFactory: () => ids.bindingB,
    });

    const contextA = await resolveContext();
    const pinnedA = await targets.issue(contextA);
    const pinnedOtherA = await targets.issue(contextA);
    const switchContextA = await targets.resolve(contextA, pinnedA.target_session_ref);
    await switchService.start(switchContextA);
    const page = await switchService.getPage(ticket);
    await switchService.confirm({
      ticket,
      csrfToken: page.csrfToken,
      selectedConnectionId: ids.connectionB,
    });
    const contextB = await resolveContext();
    const pinnedB = await targets.issue(contextB);

    await expect(targets.resolve(contextB, pinnedA.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    const [resolvedOtherA, resolvedB] = await Promise.all([
      targets.resolve(contextB, pinnedOtherA.target_session_ref),
      targets.resolve(contextB, pinnedB.target_session_ref),
    ]);
    expect(resolvedOtherA).toMatchObject({
      bindingId: ids.bindingA,
      connectionId: ids.connectionA,
      bindingRevision: 1,
    });
    expect(resolvedB).toMatchObject({
      bindingId: ids.bindingB,
      connectionId: ids.connectionB,
      bindingRevision: 2,
    });
    const secondSwitch = await switchService.start(resolvedOtherA);
    expect(secondSwitch.currentOrganisation).toMatchObject({ tenantName: "Client Company A" });
    const secondPage = await switchService.getPage(secondTicket);
    await switchService.confirm({
      ticket: secondTicket,
      csrfToken: secondPage.csrfToken,
      selectedConnectionId: ids.connectionB,
    });
    await expect(targets.resolve(contextB, pinnedOtherA.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    await expect(targets.resolve(contextB, pinnedB.target_session_ref)).resolves.toMatchObject({
      connectionId: ids.connectionB,
      bindingRevision: 2,
    });
    const persisted = await repository.pool.query<{ serialized: string }>(
      `SELECT jsonb_agg(to_jsonb(target))::text AS serialized
       FROM ledger_target_sessions target
       WHERE oauth_installation_id = $1`,
      [ids.installation],
    );
    expect(persisted.rows[0]?.serialized).not.toContain(pinnedA.target_session_ref);
    expect(persisted.rows[0]?.serialized).not.toContain(pinnedOtherA.target_session_ref);
    expect(persisted.rows[0]?.serialized).not.toContain(pinnedB.target_session_ref);

    const earlyCleanup = await repository.cleanupExpiredEphemeral(currentTime, 100, currentTime);
    expect(earlyCleanup.lockAcquired).toBe(true);
    expect(earlyCleanup.deleted.organisationSwitchSessions).toBeGreaterThanOrEqual(2);
    expect(earlyCleanup.deleted.ledgerTargetSessions).toBeGreaterThanOrEqual(2);

    currentTime = new Date(now.getTime() + 31 * 60_000);
    const cleanup = await repository.cleanupExpiredEphemeral(currentTime, 100, currentTime);
    expect(cleanup.lockAcquired).toBe(true);
    expect(cleanup.deleted.ledgerTargetSessions).toBeGreaterThanOrEqual(1);
    await expect(targets.resolve(contextB, pinnedA.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    await expect(targets.resolve(contextB, pinnedB.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
  });
});
