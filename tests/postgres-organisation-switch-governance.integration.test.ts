import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { OrganisationSwitchService } from "../src/services/organisationSwitchService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres organisation switching and governance audit", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await repository?.close();
  });

  it("atomically changes the current binding, invalidates the old runtime context, and appends a tamper-evident trail", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const ticket = Buffer.from(suffix, "utf8").toString("base64url").slice(0, 43).padEnd(43, "t");
    const now = new Date("2026-08-10T04:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 60 * 60_000);
    const ids = {
      authorization: `switch-auth-${suffix}`,
      workspace: `switch-workspace-${suffix}`,
      user: `switch-user-${suffix}`,
      agent: `switch-agent-${suffix}`,
      installation: `switch-installation-${suffix}`,
      bindingA: `switch-binding-a-${suffix}`,
      bindingB: `switch-binding-b-${suffix}`,
      connectionA: `switch-connection-a-${suffix}`,
      connectionB: `switch-connection-b-${suffix}`,
      tenantA: `switch-tenant-a-${suffix}`,
      tenantB: `switch-tenant-b-${suffix}`,
      client: `switch-client-${suffix}`,
      policy: `switch-policy-${suffix}`,
      accessHash: `switch-access-hash-${suffix}`,
      accessId: `switch-access-id-${suffix}`,
    };

    await repository.saveProviderAuthorization({
      authorizationId: ids.authorization,
      workspaceId: ids.workspace,
      authorizedBySubject: ids.user,
      provider: "xero",
      grantedScopes: ["accounting.invoices.read"],
      tokenCiphertext: `encrypted-switch-provider-token-${suffix}`,
      tokenExpiresAt: expiresAt,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    for (const [connectionId, tenantId, tenantName] of [
      [ids.connectionA, ids.tenantA, "Company A"],
      [ids.connectionB, ids.tenantB, "Company B"],
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
      expiresAt,
    });
    const before = await repository.resolveMcpAccessToken({
      tokenHash: ids.accessHash,
      expectedResource: resource,
      expectedAudience: resource,
      now,
    });
    if (!before) throw new Error("seeded access token did not resolve");
    expect(before.bindingRevision).toBe(1);

    const service = new OrganisationSwitchService({
      repository,
      publicBaseUrl: "https://xero-mcp.example.test",
      secret: Buffer.alloc(32, 7),
      clock: () => new Date(now),
      ticketFactory: () => ticket,
      bindingIdFactory: () => ids.bindingB,
    });
    const context = createOAuthRequestContext({ issuer: "https://xero-mcp.example.test", resolvedToken: before });
    await service.start(context);
    const page = await service.getPage(ticket);
    await expect(service.confirm({
      ticket,
      csrfToken: page.csrfToken,
      selectedConnectionId: ids.connectionB,
    })).resolves.toMatchObject({
      status: "SWITCHED",
      currentOrganisation: { tenantId: ids.tenantB, tenantName: "Company B" },
    });

    await expect(repository.resolveAgentConnectionBinding({
      installationId: ids.installation,
      bindingId: ids.bindingA,
      workspaceId: ids.workspace,
      subjectType: "USER",
      subjectId: ids.user,
      agentId: ids.agent,
      connectionId: ids.connectionA,
    })).resolves.toBeUndefined();
    const afterSwitch = await repository.resolveMcpAccessToken({
      tokenHash: ids.accessHash,
      expectedResource: resource,
      expectedAudience: resource,
      now,
    });
    expect(afterSwitch).toMatchObject({
      bindingId: ids.bindingB,
      connectionId: ids.connectionB,
      bindingRevision: 2,
      tenantId: ids.tenantB,
    });

    const bumped = await repository.pool.query<{ binding_revision: string }>(
      `UPDATE oauth_installation_active_bindings
       SET binding_revision = binding_revision + 1
       WHERE oauth_installation_id = $1
         AND binding_id = $2
         AND connection_id = $3
       RETURNING binding_revision`,
      [ids.installation, ids.bindingB, ids.connectionB],
    );
    expect(Number(bumped.rows[0]?.binding_revision)).toBe(3);
    await expect(repository.resolveMcpAccessToken({
      tokenHash: ids.accessHash,
      expectedResource: resource,
      expectedAudience: resource,
      now,
    })).resolves.toMatchObject({
      bindingId: ids.bindingB,
      connectionId: ids.connectionB,
      bindingRevision: 3,
      tenantId: ids.tenantB,
    });

    const events = await repository.pool.query<{
      event_id: string;
      event_type: string;
      event_source: string;
      disposition: string;
      outcome: string;
      previous_event_hash: string | null;
      event_hash: string;
    }>(
      `SELECT event_id, event_type, event_source, disposition, outcome,
              previous_event_hash, event_hash
       FROM governance_audit_events
       WHERE stream_id = $1
       ORDER BY event_sequence`,
      [`installation:${ids.installation}`],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.map((event) => ({
      eventType: event.event_type,
      source: event.event_source,
      disposition: event.disposition,
      outcome: event.outcome,
    }))).toEqual([
      {
        eventType: "xero.organisation_switch.requested",
        source: "MCP",
        disposition: "ESCALATE",
        outcome: "PROPOSED",
      },
      {
        eventType: "xero.organisation_switch.completed",
        source: "USER_UI",
        disposition: "AUTO_EXECUTE",
        outcome: "SUCCEEDED",
      },
    ]);
    expect(events.rows[0]!.previous_event_hash).toBeNull();
    expect(events.rows[1]!.previous_event_hash).toBe(events.rows[0]!.event_hash);
    await expect(repository.pool.query(
      "UPDATE governance_audit_events SET outcome = 'FAILED' WHERE event_id = $1",
      [events.rows[1]!.event_id],
    )).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
    await expect(repository.pool.query(
      "DELETE FROM governance_audit_events WHERE event_id = $1",
      [events.rows[0]!.event_id],
    )).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
  });
});
