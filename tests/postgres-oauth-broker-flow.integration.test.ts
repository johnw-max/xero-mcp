import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import type {
  AuthorizedProviderConnection,
  CreateBrokerAuthorizationFlowInput,
  OAuthBrokerAuthorizationFlow,
  OAuthInstallation,
  ProviderAuthorization,
} from "../src/domain/models.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const hash = (label: string): string => `${label}-${"h".repeat(48)}`;

describeWithPostgres("Postgres OAuth Broker V2 flow integration", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;

  interface FlowIdentityOverride {
    workspaceId: string;
    subjectId: string;
    agentId: string;
    clientId: string;
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await repository?.close();
  });

  function createFlowInput(
    suffix: string,
    personalPoc: boolean,
    identity?: FlowIdentityOverride,
  ): CreateBrokerAuthorizationFlowInput {
    const createdAt = new Date();
    const installation: OAuthInstallation = {
      installationId: `v2-installation-${suffix}`,
      workspaceId: identity?.workspaceId ?? `v2-workspace-${suffix}`,
      subjectType: "USER",
      subjectId: identity?.subjectId ?? `v2-user-${suffix}`,
      agentId: identity?.agentId ?? `v2-agent-${suffix}`,
      clientId: identity?.clientId ?? `v2-client-${suffix}`,
      status: "PENDING",
      createdAt,
      updatedAt: createdAt,
    };
    const flow: OAuthBrokerAuthorizationFlow = {
      flowHash: hash(`v2-flow-${suffix}`),
      browserSessionHash: hash(`v2-browser-${suffix}`),
      xeroStateHash: hash(`v2-xero-state-${suffix}`),
      outerStateHash: hash(`v2-outer-state-${suffix}`),
      outerStateCiphertext: `encrypted-v2-outer-state-${suffix}`,
      clientId: installation.clientId,
      redirectUri: `https://host.example.test/${suffix}/callback`,
      pkceCodeChallenge: hash(`v2-pkce-${suffix}`),
      pkceCodeChallengeMethod: "S256",
      resource: "https://mcp.example.test/mcp",
      audience: "xero-accounting-mcp",
      requestedScopes: ["xero.read"],
      workspaceId: installation.workspaceId,
      subjectType: installation.subjectType,
      subjectId: installation.subjectId,
      agentId: installation.agentId,
      installationId: installation.installationId,
      personalPoc,
      status: "AUTHORIZING_XERO",
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
      createdAt,
      updatedAt: createdAt,
    };
    return { installation, flow };
  }

  function providerExchange(input: CreateBrokerAuthorizationFlowInput, suffix: string, count = 2): {
    authorization: ProviderAuthorization;
    connections: AuthorizedProviderConnection[];
  } {
    const exchangedAt = new Date(input.flow.createdAt.getTime() + 60_000);
    const authorization: ProviderAuthorization = {
      authorizationId: `v2-authorization-${suffix}`,
      workspaceId: input.flow.workspaceId,
      authorizedBySubject: input.flow.subjectId,
      provider: "xero",
      grantedScopes: ["openid", "offline_access", "accounting.invoices.read"],
      tokenCiphertext: `encrypted-v2-xero-token-${suffix}`,
      tokenExpiresAt: new Date(exchangedAt.getTime() + 30 * 60_000),
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: exchangedAt,
      updatedAt: exchangedAt,
    };
    return {
      authorization,
      connections: Array.from({ length: count }, (_, index) => ({
        connectionId: `v2-connection-${suffix}-${index + 1}`,
        authorizationId: authorization.authorizationId,
        provider: "xero" as const,
        providerConnectionId: `v2-xero-connection-${suffix}-${index + 1}`,
        tenantId: `v2-tenant-${suffix}-${index + 1}`,
        tenantName: `V2 Organisation ${index + 1}`,
        status: "ACTIVE" as const,
        lastVerifiedAt: exchangedAt,
        createdAt: exchangedAt,
        updatedAt: exchangedAt,
      })),
    };
  }

  async function advanceToSelection(
    suffix: string,
    personalPoc: boolean,
    count = 2,
    identity?: FlowIdentityOverride,
  ) {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const created = createFlowInput(suffix, personalPoc, identity);
    const callbackAt = new Date(created.flow.createdAt.getTime() + 30_000);
    const exchangeAt = new Date(created.flow.createdAt.getTime() + 60_000);
    await repository.createBrokerAuthorizationFlow(created);
    await expect(repository.beginBrokerXeroCallback({
      flowHash: created.flow.flowHash,
      browserSessionHash: created.flow.browserSessionHash,
      xeroStateHash: created.flow.xeroStateHash,
      now: callbackAt,
    })).resolves.toMatchObject({ status: "EXCHANGING_XERO" });
    const exchange = providerExchange(created, suffix, count);
    const selectionCsrfHash = hash(`v2-selection-csrf-${suffix}`);
    await expect(repository.completeBrokerXeroExchange({
      flowHash: created.flow.flowHash,
      browserSessionHash: created.flow.browserSessionHash,
      authorization: exchange.authorization,
      connections: exchange.connections,
      selectionCsrfHash,
      now: exchangeAt,
    })).resolves.toMatchObject({ status: "AWAITING_SELECTION" });
    return { ...created, ...exchange, selectionCsrfHash, exchangeAt };
  }

  it("fails the active refresh-family migration safely when historical conflicts exist", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const migrationSql = await readFile(
      resolve(process.cwd(), "migrations/019_xero_mcp_refresh_family_lifecycle.sql"),
      "utf8",
    );
    const schema = `refresh_family_preflight_${randomUUID().replaceAll("-", "")}`;
    const client = await repository.pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE mcp_refresh_token_families(
           family_id text PRIMARY KEY,
           oauth_installation_id text NOT NULL,
           family_status text NOT NULL
         )`,
      );
      await client.query(
        `INSERT INTO mcp_refresh_token_families(family_id, oauth_installation_id, family_status)
         VALUES ('family-a', 'installation-conflict', 'ACTIVE'),
                ('family-b', 'installation-conflict', 'ACTIVE')`,
      );

      await client.query("BEGIN");
      let migrationError: unknown;
      try {
        await client.query(migrationSql);
      } catch (error) {
        migrationError = error;
      }
      await client.query("ROLLBACK");
      expect(migrationError).toMatchObject({ code: "23505" });

      await expect(client.query(
        "SELECT family_id, family_status FROM mcp_refresh_token_families ORDER BY family_id",
      )).resolves.toMatchObject({
        rows: [
          { family_id: "family-a", family_status: "ACTIVE" },
          { family_id: "family-b", family_status: "ACTIVE" },
        ],
      });
      await expect(client.query(
        `SELECT 1
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname = 'mcp_refresh_token_families_active_installation_uq'`,
        [schema],
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("permits at most one ACTIVE refresh family per OAuth installation", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const context = await advanceToSelection(suffix, false, 1);
    const selectedAt = new Date(context.exchangeAt.getTime() + 30_000);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: `v2-family-unique-binding-${suffix}`,
      policyId: `v2-family-unique-policy-${suffix}`,
      authorizationCodeHash: hash(`v2-family-unique-code-${suffix}`),
      authorizationCodeExpiresAt: new Date(selectedAt.getTime() + 5 * 60_000),
      now: selectedAt,
    });
    if (!issued) throw new Error("expected uniqueness test selection to complete");

    const familyInput = (familySuffix: string) => ({
      family: {
        familyId: `v2-family-unique-${suffix}-${familySuffix}`,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: context.flow.clientId,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE" as const,
        createdAt: selectedAt,
        updatedAt: selectedAt,
      },
      initialToken: {
        tokenHash: hash(`v2-family-unique-refresh-${suffix}-${familySuffix}`),
        tokenId: `v2-family-unique-refresh-${suffix}-${familySuffix}`,
        familyId: `v2-family-unique-${suffix}-${familySuffix}`,
        issuedAt: selectedAt,
        expiresAt: new Date(selectedAt.getTime() + 30 * 60_000),
      },
    });
    await expect(repository.createMcpRefreshTokenFamily(familyInput("first"))).resolves.toBeUndefined();
    await expect(repository.createMcpRefreshTokenFamily(familyInput("second"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(repository.pool.query(
      `SELECT count(*)::int AS active_count
       FROM mcp_refresh_token_families
       WHERE oauth_installation_id = $1 AND family_status = 'ACTIVE'`,
      [issued.installation.installationId],
    )).resolves.toMatchObject({ rows: [{ active_count: 1 }] });
    await repository.revokeOAuthInstallation(
      issued.installation.installationId,
      issued.installation.workspaceId,
      new Date(selectedAt.getTime() + 1_000),
    );
  });

  it("runs the atomic V2 browser lifecycle, safe previews, and client-bound revocation", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const input = createFlowInput(suffix, false);
    await expect(repository.createBrokerAuthorizationFlow(input)).resolves.toMatchObject({
      installation: { status: "PENDING" },
      flow: { status: "AUTHORIZING_XERO" },
    });

    const rolledBack = createFlowInput(`${suffix}-rollback`, false);
    rolledBack.flow.flowHash = input.flow.flowHash;
    await expect(repository.createBrokerAuthorizationFlow(rolledBack)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.pool.query(
      "SELECT 1 FROM oauth_installations WHERE installation_id = $1",
      [rolledBack.installation.installationId],
    )).resolves.toMatchObject({ rowCount: 0 });

    const callbackAt = new Date(input.flow.createdAt.getTime() + 30_000);
    const callbacks = await Promise.all([
      repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: callbackAt,
      }),
      repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: callbackAt,
      }),
    ]);
    expect(callbacks.filter(Boolean)).toHaveLength(1);
    expect(callbacks.find(Boolean)).toMatchObject({ status: "EXCHANGING_XERO" });

    const exchange = providerExchange(input, suffix);
    const exchangeAt = new Date(input.flow.createdAt.getTime() + 60_000);
    const selectionCsrfHash = hash(`v2-selection-csrf-${suffix}`);
    await expect(repository.completeBrokerXeroExchange({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      authorization: exchange.authorization,
      connections: exchange.connections,
      selectionCsrfHash,
      now: exchangeAt,
    })).resolves.toMatchObject({ status: "AWAITING_SELECTION" });
    await expect(repository.getBrokerSelection({
      flowHash: input.flow.flowHash,
      browserSessionHash: hash("wrong-browser"),
      now: exchangeAt,
    })).resolves.toBeUndefined();
    await expect(repository.getBrokerSelection({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      now: exchangeAt,
    })).resolves.toMatchObject({ connections: [{}, {}] });

    const selectionAt = new Date(input.flow.createdAt.getTime() + 90_000);
    const selection = {
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      selectionCsrfHash,
      selectedConnectionId: exchange.connections[1]!.connectionId,
      bindingId: `v2-binding-${suffix}`,
      policyId: `v2-policy-${suffix}`,
      authorizationCodeHash: hash(`v2-code-${suffix}`),
      authorizationCodeExpiresAt: new Date(selectionAt.getTime() + 5 * 60_000),
      now: selectionAt,
    };
    await expect(repository.completeBrokerOrganisationSelection({
      ...selection,
      selectedConnectionId: `v2-cross-connection-${suffix}`,
    })).resolves.toBeUndefined();
    const selections = await Promise.all([
      repository.completeBrokerOrganisationSelection(selection),
      repository.completeBrokerOrganisationSelection({
        ...selection,
        bindingId: `v2-binding-${suffix}-concurrent`,
        authorizationCodeHash: hash(`v2-code-${suffix}-concurrent`),
      }),
    ]);
    expect(selections.filter(Boolean)).toHaveLength(1);
    const issued = selections.find(Boolean);
    if (!issued) throw new Error("expected one selection to complete");
    expect(issued).toMatchObject({
      outerStateCiphertext: input.flow.outerStateCiphertext,
      flow: { status: "COMPLETED", consumedAt: selectionAt },
      authorizationCode: {
        resource: input.flow.resource,
        audience: input.flow.audience,
        grantedScopes: input.flow.requestedScopes,
        connectionId: exchange.connections[1]!.connectionId,
      },
    });
    const storedFlow = await repository.pool.query(
      `SELECT flow_version, flow_status, outer_state_ciphertext, selection_csrf_hash
       FROM oauth_broker_flows WHERE flow_hash = $1`,
      [input.flow.flowHash],
    );
    expect(storedFlow.rows[0]).toMatchObject({
      flow_version: 2,
      flow_status: "COMPLETED",
      outer_state_ciphertext: null,
      selection_csrf_hash: null,
    });

    const codePreview = {
      codeHash: issued.authorizationCode.codeHash,
      clientId: input.flow.clientId,
      redirectUri: input.flow.redirectUri,
      pkceCodeChallenge: input.flow.pkceCodeChallenge,
      expectedResource: input.flow.resource,
      now: selectionAt,
    };
    await expect(repository.peekOAuthAuthorizationCodeForExchange(codePreview)).resolves.toMatchObject({
      connectionId: exchange.connections[1]!.connectionId,
    });
    await expect(repository.peekOAuthAuthorizationCodeForExchange({
      ...codePreview,
      clientId: "another-client",
    })).resolves.toBeUndefined();

    const familyId = `v2-family-${suffix}`;
    const refreshHash = hash(`v2-refresh-${suffix}-0`);
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: input.flow.clientId,
        resource: input.flow.resource,
        audience: input.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: selectionAt,
        updatedAt: selectionAt,
      },
      initialToken: {
        tokenHash: refreshHash,
        tokenId: `v2-refresh-${suffix}-0`,
        familyId,
        issuedAt: selectionAt,
        expiresAt: new Date(selectionAt.getTime() + 30 * 60_000),
      },
    });
    const accessHash = hash(`v2-access-${suffix}`);
    await repository.saveMcpAccessToken({
      tokenHash: accessHash,
      tokenId: `v2-access-${suffix}`,
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: input.flow.clientId,
      resource: input.flow.resource,
      audience: input.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: selectionAt,
      expiresAt: new Date(selectionAt.getTime() + 15 * 60_000),
    });
    const bindingResolutionInput = {
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      workspaceId: issued.binding.workspaceId,
      subjectType: issued.binding.subjectType,
      subjectId: issued.binding.subjectId,
      agentId: issued.binding.agentId,
      connectionId: issued.binding.connectionId,
    };
    const refreshPreview = {
      tokenHash: refreshHash,
      clientId: input.flow.clientId,
      expectedResource: input.flow.resource,
      expectedAudience: input.flow.audience,
      now: selectionAt,
    };
    await expect(repository.peekMcpRefreshTokenContext(refreshPreview)).resolves.toMatchObject({ consumed: false });
    const rotatedAt = new Date(selectionAt.getTime() + 60_000);
    const rotatedHash = hash(`v2-refresh-${suffix}-1`);
    await expect(repository.rotateMcpRefreshToken({
      currentTokenHash: refreshHash,
      expectedClientId: input.flow.clientId,
      expectedResource: input.flow.resource,
      expectedAudience: input.flow.audience,
      newTokenHash: rotatedHash,
      newTokenId: `v2-refresh-${suffix}-1`,
      issuedAt: rotatedAt,
      expiresAt: new Date(rotatedAt.getTime() + 30 * 60_000),
    })).resolves.toMatchObject({ status: "ROTATED" });
    await expect(repository.peekMcpRefreshTokenContext({
      ...refreshPreview,
      now: rotatedAt,
    })).resolves.toMatchObject({ consumed: true });

    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: rotatedHash,
      clientId: "another-client",
      revokedAt: rotatedAt,
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.peekMcpRefreshTokenContext({
      ...refreshPreview,
      tokenHash: rotatedHash,
      now: rotatedAt,
    })).resolves.toBeDefined();
    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: accessHash,
      clientId: input.flow.clientId,
      revokedAt: rotatedAt,
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveAgentConnectionBinding(bindingResolutionInput)).resolves.toBeDefined();
    await expect(repository.peekMcpRefreshTokenContext({
      ...refreshPreview,
      tokenHash: rotatedHash,
      now: rotatedAt,
    })).resolves.toBeDefined();
    const derivedAccessHash = hash(`v2-access-${suffix}-derived`);
    await repository.saveMcpAccessToken({
      tokenHash: derivedAccessHash,
      tokenId: `v2-access-${suffix}-derived`,
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: input.flow.clientId,
      resource: input.flow.resource,
      audience: input.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: rotatedAt,
      expiresAt: new Date(rotatedAt.getTime() + 15 * 60_000),
    });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: derivedAccessHash,
      expectedResource: input.flow.resource,
      expectedAudience: input.flow.audience,
      now: rotatedAt,
    })).resolves.toBeDefined();

    const concurrentAt = new Date(rotatedAt.getTime() + 1_000);
    const [concurrentRotation, concurrentRevoke] = await Promise.all([
      repository.rotateMcpRefreshToken({
        currentTokenHash: rotatedHash,
        expectedClientId: input.flow.clientId,
        expectedResource: input.flow.resource,
        expectedAudience: input.flow.audience,
        newTokenHash: hash(`v2-refresh-${suffix}-2`),
        newTokenId: `v2-refresh-${suffix}-2`,
        issuedAt: concurrentAt,
        expiresAt: new Date(concurrentAt.getTime() + 30 * 60_000),
      }),
      repository.revokeOAuthTokenForClient({
        tokenHash: rotatedHash,
        clientId: input.flow.clientId,
        revokedAt: concurrentAt,
      }),
    ]);
    expect(["ROTATED", "INVALID"]).toContain(concurrentRotation.status);
    expect(concurrentRevoke).toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessHash,
      expectedResource: input.flow.resource,
      expectedAudience: input.flow.audience,
      now: concurrentAt,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: derivedAccessHash,
      expectedResource: input.flow.resource,
      expectedAudience: input.flow.audience,
      now: concurrentAt,
    })).resolves.toBeUndefined();
    await expect(repository.resolveAgentConnectionBinding(bindingResolutionInput)).resolves.toBeUndefined();
    const revokedGrant = await repository.pool.query(
      `SELECT installation.installation_status, binding.binding_status
       FROM oauth_installations installation
       JOIN agent_connection_bindings binding
         ON binding.oauth_installation_id = installation.installation_id
       WHERE installation.installation_id = $1 AND binding.binding_id = $2`,
      [issued.installation.installationId, issued.binding.bindingId],
    );
    expect(revokedGrant.rows[0]).toEqual({
      installation_status: "REVOKED",
      binding_status: "REVOKED",
    });
    const familyState = await repository.pool.query(
      "SELECT family_status FROM mcp_refresh_token_families WHERE family_id = $1",
      [familyId],
    );
    expect(familyState.rows[0]).toEqual({ family_status: "REVOKED" });
    const refreshState = await repository.pool.query(
      `SELECT COUNT(*)::int AS token_count, BOOL_AND(revoked_at IS NOT NULL) AS all_revoked
       FROM mcp_refresh_tokens WHERE family_id = $1`,
      [familyId],
    );
    expect(refreshState.rows[0]).toMatchObject({ token_count: expect.any(Number), all_revoked: true });
    expect(refreshState.rows[0].token_count).toBeGreaterThanOrEqual(2);
    const accessState = await repository.pool.query(
      `SELECT COUNT(*)::int AS token_count, BOOL_AND(revoked_at IS NOT NULL) AS all_revoked
       FROM mcp_access_tokens WHERE refresh_family_id = $1`,
      [familyId],
    );
    expect(accessState.rows[0]).toEqual({ token_count: 2, all_revoked: true });
  });

  it("scrubs encrypted outer state when an unconsumed V2 browser flow expires", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const input = createFlowInput(randomUUID(), false);
    input.flow.expiresAt = new Date(input.flow.createdAt.getTime() + 60_000);
    await repository.createBrokerAuthorizationFlow(input);
    const awaiting = await advanceToSelection(randomUUID(), false, 2);
    const cutoff = new Date(Math.max(input.flow.expiresAt.getTime(), awaiting.flow.expiresAt.getTime()) + 1_000);
    const cleanup = await repository.cleanupExpiredEphemeral(cutoff, 10_000);
    expect(cleanup.deleted.oauthBrokerFlows).toBeGreaterThanOrEqual(2);
    const stored = await repository.pool.query(
      `SELECT flow_status, consumed_at, outer_state_ciphertext, selection_csrf_hash
       FROM oauth_broker_flows WHERE flow_hash = $1`,
      [input.flow.flowHash],
    );
    expect(stored.rows[0]).toEqual({
      flow_status: "FAILED",
      consumed_at: cutoff,
      outer_state_ciphertext: null,
      selection_csrf_hash: null,
    });
    const expiredPendingGrant = await repository.pool.query(
      `SELECT installation.installation_status, provider_auth.authorization_status,
              ARRAY_AGG(connection.connection_status ORDER BY connection.connection_id) AS connection_statuses
       FROM oauth_installations installation
       JOIN provider_authorizations provider_auth ON provider_auth.authorization_id = $2
       JOIN provider_connections connection ON connection.authorization_id = provider_auth.authorization_id
       WHERE installation.installation_id = $1
       GROUP BY installation.installation_status, provider_auth.authorization_status`,
      [awaiting.installation.installationId, awaiting.authorization.authorizationId],
    );
    expect(expiredPendingGrant.rows[0]).toEqual({
      installation_status: "REVOKED",
      authorization_status: "REVOKED",
      connection_statuses: ["REVOKED", "REVOKED"],
    });
  });

  it("serializes Personal POC selections globally and terminates the losing browser flow", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = await advanceToSelection(randomUUID(), true, 1);
    const second = await advanceToSelection(randomUUID(), true, 1);
    const selectedAt = new Date(Math.max(first.exchangeAt.getTime(), second.exchangeAt.getTime()) + 30_000);
    const selectionFor = (context: typeof first, suffix: string) => ({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: `v2-poc-binding-${suffix}`,
      policyId: `v2-poc-policy-${suffix}`,
      authorizationCodeHash: hash(`v2-poc-code-${suffix}`),
      authorizationCodeExpiresAt: new Date(selectedAt.getTime() + 5 * 60_000),
      now: selectedAt,
    });
    await expect(repository.completeBrokerOrganisationSelection({
      ...selectionFor(first, "cross"),
      selectedConnectionId: second.connections[0]!.connectionId,
    })).resolves.toBeUndefined();

    const [firstResult, secondResult] = await Promise.all([
      repository.completeBrokerOrganisationSelection(selectionFor(first, "first")),
      repository.completeBrokerOrganisationSelection(selectionFor(second, "second")),
    ]);
    expect([firstResult, secondResult].filter(Boolean)).toHaveLength(1);
    const winnerResult = firstResult ?? secondResult;
    if (!winnerResult) throw new Error("expected one Personal POC selection to complete");
    const winner = firstResult ? first : second;
    const loser = firstResult ? second : first;
    await expect(repository.terminateBrokerAuthorizationFlow({
      flowHash: loser.flow.flowHash,
      browserSessionHash: loser.flow.browserSessionHash,
      terminalStatus: "FAILED",
      now: selectedAt,
    })).resolves.toMatchObject({
      outerStateCiphertext: loser.flow.outerStateCiphertext,
      flow: { status: "FAILED", consumedAt: selectedAt },
    });
    const terminal = await repository.pool.query(
      "SELECT outer_state_ciphertext, selection_csrf_hash FROM oauth_broker_flows WHERE flow_hash = $1",
      [loser.flow.flowHash],
    );
    expect(terminal.rows[0]).toEqual({ outer_state_ciphertext: null, selection_csrf_hash: null });
    const terminatedPendingGrant = await repository.pool.query(
      `SELECT installation.installation_status, provider_auth.authorization_status,
              ARRAY_AGG(connection.connection_status ORDER BY connection.connection_id) AS connection_statuses
       FROM oauth_installations installation
       JOIN provider_authorizations provider_auth ON provider_auth.authorization_id = $2
       JOIN provider_connections connection ON connection.authorization_id = provider_auth.authorization_id
       WHERE installation.installation_id = $1
       GROUP BY installation.installation_status, provider_auth.authorization_status`,
      [loser.installation.installationId, loser.authorization.authorizationId],
    );
    expect(terminatedPendingGrant.rows[0]).toEqual({
      installation_status: "REVOKED",
      authorization_status: "REVOKED",
      connection_statuses: ["REVOKED"],
    });
    await expect(repository.getProviderAuthorization(
      winner.authorization.authorizationId,
      winner.flow.workspaceId,
      winner.flow.subjectId,
    )).resolves.toMatchObject({ status: "ACTIVE" });
    const active = await repository.pool.query(
      "SELECT installation_id FROM oauth_installations WHERE installation_status = 'ACTIVE'",
    );
    expect(active.rows).toEqual([{ installation_id: winner.installation.installationId }]);

    const refreshHash = hash(`v2-poc-refresh-${randomUUID()}`);
    const familyId = `v2-poc-family-${randomUUID()}`;
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: winnerResult.installation.installationId,
        bindingId: winnerResult.binding.bindingId,
        connectionId: winnerResult.binding.connectionId,
        clientId: winner.flow.clientId,
        resource: winner.flow.resource,
        audience: winner.flow.audience,
        grantedScopes: winner.flow.requestedScopes,
        status: "ACTIVE",
        createdAt: selectedAt,
        updatedAt: selectedAt,
      },
      initialToken: {
        tokenHash: refreshHash,
        tokenId: `v2-poc-refresh-token-${randomUUID()}`,
        familyId,
        issuedAt: selectedAt,
        expiresAt: new Date(selectedAt.getTime() + 30 * 60_000),
      },
    });
    const revokedAt = new Date(selectedAt.getTime() + 1_000);
    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: refreshHash,
      clientId: winner.flow.clientId,
      revokedAt,
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: winnerResult.installation.installationId,
      bindingId: winnerResult.binding.bindingId,
      workspaceId: winnerResult.binding.workspaceId,
      subjectType: winnerResult.binding.subjectType,
      subjectId: winnerResult.binding.subjectId,
      agentId: winnerResult.binding.agentId,
      connectionId: winnerResult.binding.connectionId,
    })).resolves.toBeUndefined();
    await expect(repository.pool.query(
      "SELECT installation_status FROM oauth_installations WHERE installation_id = $1",
      [winnerResult.installation.installationId],
    )).resolves.toMatchObject({ rows: [{ installation_status: "REVOKED" }] });

    const reconnected = await advanceToSelection(randomUUID(), true, 1);
    const reconnectedAt = new Date(reconnected.exchangeAt.getTime() + 30_000);
    const reconnectedResult = await repository.completeBrokerOrganisationSelection({
      flowHash: reconnected.flow.flowHash,
      browserSessionHash: reconnected.flow.browserSessionHash,
      selectionCsrfHash: reconnected.selectionCsrfHash,
      selectedConnectionId: reconnected.connections[0]!.connectionId,
      bindingId: `v2-poc-binding-reconnected-${randomUUID()}`,
      policyId: `v2-poc-policy-reconnected-${randomUUID()}`,
      authorizationCodeHash: hash(`v2-poc-code-reconnected-${randomUUID()}`),
      authorizationCodeExpiresAt: new Date(reconnectedAt.getTime() + 5 * 60_000),
      now: reconnectedAt,
    });
    expect(reconnectedResult).toMatchObject({ installation: { status: "ACTIVE" } });
    const activeAfterReconnect = await repository.pool.query(
      "SELECT installation_id FROM oauth_installations WHERE installation_status = 'ACTIVE'",
    );
    expect(activeAfterReconnect.rows).toEqual([{ installation_id: reconnected.installation.installationId }]);
    await repository.revokeOAuthInstallation(
      reconnected.installation.installationId,
      reconnected.installation.workspaceId,
      reconnectedAt,
    );
  });

  it("coalesces a concurrent refresh burst, then disconnects the exact grant on delayed replay", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const context = await advanceToSelection(suffix, true, 1);
    const selectedAt = new Date(context.exchangeAt.getTime() + 30_000);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: `v2-replay-binding-${suffix}`,
      policyId: `v2-replay-policy-${suffix}`,
      authorizationCodeHash: hash(`v2-replay-code-${suffix}`),
      authorizationCodeExpiresAt: new Date(selectedAt.getTime() + 5 * 60_000),
      now: selectedAt,
    });
    if (!issued) throw new Error("expected replay test selection to complete");

    const familyId = `v2-replay-family-${suffix}`;
    const initialRefreshHash = hash(`v2-replay-refresh-${suffix}-0`);
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: context.flow.clientId,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: selectedAt,
        updatedAt: selectedAt,
      },
      initialToken: {
        tokenHash: initialRefreshHash,
        tokenId: `v2-replay-refresh-${suffix}-0`,
        familyId,
        issuedAt: selectedAt,
        expiresAt: new Date(selectedAt.getTime() + 30 * 60_000),
      },
    });
    const initialAccess = {
      tokenHash: hash(`v2-replay-access-${suffix}-0`),
      tokenId: `v2-replay-access-${suffix}-0`,
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: context.flow.clientId,
      resource: context.flow.resource,
      audience: context.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: selectedAt,
      expiresAt: new Date(selectedAt.getTime() + 15 * 60_000),
    };
    await repository.saveMcpAccessToken(initialAccess);
    const rotatedAt = new Date(selectedAt.getTime() + 1_000);
    const attempts = Array.from({ length: 3 }, (_, index) => ({
      rotation: {
        currentTokenHash: initialRefreshHash,
        expectedClientId: context.flow.clientId,
        expectedResource: context.flow.resource,
        expectedAudience: context.flow.audience,
        newTokenHash: hash(`v2-replay-refresh-${suffix}-${index + 1}`),
        newTokenId: `v2-replay-refresh-${suffix}-${index + 1}`,
        issuedAt: rotatedAt,
        expiresAt: new Date(rotatedAt.getTime() + 30 * 60_000),
      },
      accessToken: {
        ...initialAccess,
        tokenHash: hash(`v2-replay-access-${suffix}-${index + 1}`),
        tokenId: `v2-replay-access-${suffix}-${index + 1}`,
        issuedAt: rotatedAt,
      },
      retryResponseCiphertext: `encrypted-v2-replay-response-${suffix}-${index + 1}`,
      retryExpiresAt: new Date(rotatedAt.getTime() + 10_000),
    }));
    const burst = await Promise.all(attempts.map((attempt) =>
      repository.rotateMcpRefreshTokenAndIssueAccessToken(attempt),
    ));
    const winnerIndex = burst.findIndex((result) => result.status === "ROTATED");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(burst.filter((result) => result.status === "ROTATED")).toHaveLength(1);
    expect(burst.filter((result) => result.status === "COALESCED")).toHaveLength(2);
    const winner = attempts[winnerIndex]!;
    for (const result of burst) {
      if (result.status !== "COALESCED") continue;
      expect(result).toMatchObject({
        sourceTokenHash: initialRefreshHash,
        accessTokenHash: winner.accessToken.tokenHash,
        refreshTokenHash: winner.rotation.newTokenHash,
        responseCiphertext: winner.retryResponseCiphertext,
        grantedScopes: ["xero.read"],
      });
    }
    const activeAfterBurst = await repository.pool.query(
      `SELECT family.family_status, installation.installation_status, binding.binding_status,
              (SELECT count(*)::int FROM mcp_refresh_tokens WHERE family_id = $1) AS refresh_count,
              (SELECT count(*)::int FROM mcp_access_tokens WHERE refresh_family_id = $1) AS access_count,
              (SELECT count(*)::int FROM mcp_refresh_tokens
                 WHERE family_id = $1 AND parent_token_hash IS NOT NULL
                   AND consumed_at IS NULL AND replaced_by_token_hash IS NULL
                   AND revoked_at IS NULL) AS active_successor_count
       FROM mcp_refresh_token_families family
       JOIN oauth_installations installation
         ON installation.installation_id = family.oauth_installation_id
       JOIN agent_connection_bindings binding ON binding.binding_id = family.binding_id
       WHERE family.family_id = $1`,
      [familyId],
    );
    expect(activeAfterBurst.rows[0]).toEqual({
      family_status: "ACTIVE",
      installation_status: "ACTIVE",
      binding_status: "ACTIVE",
      refresh_count: 2,
      access_count: 2,
      active_successor_count: 1,
    });

    const replayAt = new Date(rotatedAt.getTime() + 10_001);
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        ...winner.rotation,
        newTokenHash: hash(`v2-replay-refresh-${suffix}-forbidden`),
        newTokenId: `v2-replay-refresh-${suffix}-forbidden`,
        issuedAt: replayAt,
      },
      accessToken: {
        ...winner.accessToken,
        tokenHash: hash(`v2-replay-access-${suffix}-forbidden`),
        tokenId: `v2-replay-access-${suffix}-forbidden`,
        issuedAt: replayAt,
      },
      retryResponseCiphertext: `encrypted-v2-replay-response-${suffix}-forbidden`,
      retryExpiresAt: new Date(replayAt.getTime() + 10_000),
    })).resolves.toEqual({ status: "REPLAY_DETECTED", familyId });

    const disconnected = await repository.pool.query(
      `SELECT installation.installation_status, binding.binding_status,
              family.family_status, family.replay_detected_at,
              provider_auth.authorization_status, connection.connection_status
       FROM mcp_refresh_token_families family
       JOIN oauth_installations installation
         ON installation.installation_id = family.oauth_installation_id
       JOIN agent_connection_bindings binding ON binding.binding_id = family.binding_id
       JOIN provider_connections connection ON connection.connection_id = family.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE family.family_id = $1`,
      [familyId],
    );
    expect(disconnected.rows[0]).toEqual({
      installation_status: "REVOKED",
      binding_status: "REVOKED",
      family_status: "REVOKED",
      replay_detected_at: replayAt,
      authorization_status: "ACTIVE",
      connection_status: "ACTIVE",
    });
    const tokenStates = await repository.pool.query(
      `SELECT
         (SELECT BOOL_AND(revoked_at IS NOT NULL) FROM mcp_refresh_tokens WHERE family_id = $1) AS refresh_revoked,
         (SELECT BOOL_AND(revoked_at IS NOT NULL) FROM mcp_access_tokens WHERE refresh_family_id = $1) AS access_revoked`,
      [familyId],
    );
    expect(tokenStates.rows[0]).toEqual({ refresh_revoked: true, access_revoked: true });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      workspaceId: issued.binding.workspaceId,
      subjectType: issued.binding.subjectType,
      subjectId: issued.binding.subjectId,
      agentId: issued.binding.agentId,
      connectionId: issued.binding.connectionId,
    })).resolves.toBeUndefined();

    const reconnected = await advanceToSelection(randomUUID(), true, 1);
    const reconnectedAt = new Date(reconnected.exchangeAt.getTime() + 30_000);
    const reconnectedResult = await repository.completeBrokerOrganisationSelection({
      flowHash: reconnected.flow.flowHash,
      browserSessionHash: reconnected.flow.browserSessionHash,
      selectionCsrfHash: reconnected.selectionCsrfHash,
      selectedConnectionId: reconnected.connections[0]!.connectionId,
      bindingId: `v2-replay-reconnected-binding-${randomUUID()}`,
      policyId: `v2-replay-reconnected-policy-${randomUUID()}`,
      authorizationCodeHash: hash(`v2-replay-reconnected-code-${randomUUID()}`),
      authorizationCodeExpiresAt: new Date(reconnectedAt.getTime() + 5 * 60_000),
      now: reconnectedAt,
    });
    expect(reconnectedResult).toMatchObject({ installation: { status: "ACTIVE" } });
    await repository.revokeOAuthInstallation(
      reconnected.installation.installationId,
      reconnected.installation.workspaceId,
      reconnectedAt,
    );
  });

  it("disconnects the exact Personal POC grant on natural refresh expiry and permits reconnection", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const context = await advanceToSelection(suffix, true, 1);
    const selectedAt = new Date(context.exchangeAt.getTime() + 30_000);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: `v2-expiry-binding-${suffix}`,
      policyId: `v2-expiry-policy-${suffix}`,
      authorizationCodeHash: hash(`v2-expiry-code-${suffix}`),
      authorizationCodeExpiresAt: new Date(selectedAt.getTime() + 5 * 60_000),
      now: selectedAt,
    });
    if (!issued) throw new Error("expected expiry test selection to complete");

    const familyId = `v2-expiry-family-${suffix}`;
    const initialRefreshHash = hash(`v2-expiry-refresh-${suffix}-0`);
    const refreshExpiresAt = new Date(selectedAt.getTime() + 1_000);
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: context.flow.clientId,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: selectedAt,
        updatedAt: selectedAt,
      },
      initialToken: {
        tokenHash: initialRefreshHash,
        tokenId: `v2-expiry-refresh-${suffix}-0`,
        familyId,
        issuedAt: selectedAt,
        expiresAt: refreshExpiresAt,
      },
    });
    const initialAccess = {
      tokenHash: hash(`v2-expiry-access-${suffix}-0`),
      tokenId: `v2-expiry-access-${suffix}-0`,
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: context.flow.clientId,
      resource: context.flow.resource,
      audience: context.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: selectedAt,
      expiresAt: new Date(selectedAt.getTime() + 15 * 60_000),
    };
    await repository.saveMcpAccessToken(initialAccess);

    const expiredAt = new Date(refreshExpiresAt.getTime() + 1_000);
    await expect(repository.peekMcpRefreshTokenContext({
      tokenHash: initialRefreshHash,
      clientId: context.flow.clientId,
      expectedResource: context.flow.resource,
      expectedAudience: context.flow.audience,
      now: expiredAt,
    })).resolves.toMatchObject({ familyId, expiresAt: refreshExpiresAt });

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: initialRefreshHash,
        expectedClientId: context.flow.clientId,
        expectedResource: context.flow.resource,
        expectedAudience: context.flow.audience,
        newTokenHash: hash(`v2-expiry-refresh-${suffix}-forbidden`),
        newTokenId: `v2-expiry-refresh-${suffix}-forbidden`,
        issuedAt: expiredAt,
        expiresAt: new Date(expiredAt.getTime() + 30 * 24 * 60 * 60_000),
      },
      accessToken: {
        ...initialAccess,
        tokenHash: hash(`v2-expiry-access-${suffix}-forbidden`),
        tokenId: `v2-expiry-access-${suffix}-forbidden`,
        issuedAt: expiredAt,
        expiresAt: new Date(expiredAt.getTime() + 15 * 60_000),
      },
    })).resolves.toEqual({ status: "INVALID" });

    const disconnected = await repository.pool.query(
      `SELECT installation.installation_status, binding.binding_status,
              family.family_status, family.replay_detected_at,
              provider_auth.authorization_status, connection.connection_status
       FROM mcp_refresh_token_families family
       JOIN oauth_installations installation
         ON installation.installation_id = family.oauth_installation_id
       JOIN agent_connection_bindings binding ON binding.binding_id = family.binding_id
       JOIN provider_connections connection ON connection.connection_id = family.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE family.family_id = $1`,
      [familyId],
    );
    expect(disconnected.rows[0]).toEqual({
      installation_status: "REVOKED",
      binding_status: "REVOKED",
      family_status: "REVOKED",
      replay_detected_at: null,
      authorization_status: "ACTIVE",
      connection_status: "ACTIVE",
    });
    const tokenStates = await repository.pool.query(
      `SELECT
         (SELECT BOOL_AND(revoked_at IS NOT NULL) FROM mcp_refresh_tokens WHERE family_id = $1) AS refresh_revoked,
         (SELECT BOOL_AND(revoked_at IS NOT NULL) FROM mcp_access_tokens WHERE refresh_family_id = $1) AS access_revoked`,
      [familyId],
    );
    expect(tokenStates.rows[0]).toEqual({ refresh_revoked: true, access_revoked: true });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      workspaceId: issued.binding.workspaceId,
      subjectType: issued.binding.subjectType,
      subjectId: issued.binding.subjectId,
      agentId: issued.binding.agentId,
      connectionId: issued.binding.connectionId,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: initialAccess.tokenHash,
      expectedResource: initialAccess.resource,
      expectedAudience: initialAccess.audience,
      now: expiredAt,
    })).resolves.toBeUndefined();

    const reconnected = await advanceToSelection(randomUUID(), true, 1);
    const reconnectedAt = new Date(reconnected.exchangeAt.getTime() + 30_000);
    const reconnectedResult = await repository.completeBrokerOrganisationSelection({
      flowHash: reconnected.flow.flowHash,
      browserSessionHash: reconnected.flow.browserSessionHash,
      selectionCsrfHash: reconnected.selectionCsrfHash,
      selectedConnectionId: reconnected.connections[0]!.connectionId,
      bindingId: `v2-expiry-reconnected-binding-${randomUUID()}`,
      policyId: `v2-expiry-reconnected-policy-${randomUUID()}`,
      authorizationCodeHash: hash(`v2-expiry-reconnected-code-${randomUUID()}`),
      authorizationCodeExpiresAt: new Date(reconnectedAt.getTime() + 5 * 60_000),
      now: reconnectedAt,
    });
    expect(reconnectedResult).toMatchObject({ installation: { status: "ACTIVE" } });
    await repository.revokeOAuthInstallation(
      reconnected.installation.installationId,
      reconnected.installation.workspaceId,
      reconnectedAt,
    );
  });

  it("atomically replaces the same Personal POC principal after its refresh grant expires", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const principalSuffix = randomUUID();
    const identity: FlowIdentityOverride = {
      workspaceId: `v2-expired-reconnect-workspace-${principalSuffix}`,
      subjectId: `v2-expired-reconnect-user-${principalSuffix}`,
      agentId: `v2-expired-reconnect-agent-${principalSuffix}`,
      clientId: `v2-expired-reconnect-client-${principalSuffix}`,
    };
    const oldSuffix = randomUUID();
    const oldContext = await advanceToSelection(oldSuffix, true, 1, identity);
    const oldSelectedAt = new Date(oldContext.exchangeAt.getTime() + 30_000);
    const oldIssued = await repository.completeBrokerOrganisationSelection({
      flowHash: oldContext.flow.flowHash,
      browserSessionHash: oldContext.flow.browserSessionHash,
      selectionCsrfHash: oldContext.selectionCsrfHash,
      selectedConnectionId: oldContext.connections[0]!.connectionId,
      bindingId: `v2-expired-reconnect-old-binding-${oldSuffix}`,
      policyId: `v2-expired-reconnect-old-policy-${oldSuffix}`,
      authorizationCodeHash: hash(`v2-expired-reconnect-old-code-${oldSuffix}`),
      authorizationCodeExpiresAt: new Date(oldSelectedAt.getTime() + 5 * 60_000),
      now: oldSelectedAt,
    });
    if (!oldIssued) throw new Error("expected old Personal POC selection to complete");

    const oldFamilyId = `v2-expired-reconnect-family-${oldSuffix}`;
    const oldRefreshExpiresAt = new Date(oldSelectedAt.getTime() + 1_000);
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId: oldFamilyId,
        installationId: oldIssued.installation.installationId,
        bindingId: oldIssued.binding.bindingId,
        connectionId: oldIssued.binding.connectionId,
        clientId: identity.clientId,
        resource: oldContext.flow.resource,
        audience: oldContext.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: oldSelectedAt,
        updatedAt: oldSelectedAt,
      },
      initialToken: {
        tokenHash: hash(`v2-expired-reconnect-refresh-${oldSuffix}`),
        tokenId: `v2-expired-reconnect-refresh-${oldSuffix}`,
        familyId: oldFamilyId,
        issuedAt: oldSelectedAt,
        expiresAt: oldRefreshExpiresAt,
      },
    });
    const oldAccessHash = hash(`v2-expired-reconnect-access-${oldSuffix}`);
    await repository.saveMcpAccessToken({
      tokenHash: oldAccessHash,
      tokenId: `v2-expired-reconnect-access-${oldSuffix}`,
      installationId: oldIssued.installation.installationId,
      bindingId: oldIssued.binding.bindingId,
      connectionId: oldIssued.binding.connectionId,
      refreshFamilyId: oldFamilyId,
      clientId: identity.clientId,
      resource: oldContext.flow.resource,
      audience: oldContext.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: oldSelectedAt,
      expiresAt: new Date(oldSelectedAt.getTime() + 15 * 60_000),
    });

    const newSuffix = randomUUID();
    const newContext = await advanceToSelection(newSuffix, true, 1, identity);
    const reconnectedAt = new Date(Math.max(
      newContext.exchangeAt.getTime() + 30_000,
      oldRefreshExpiresAt.getTime() + 1_000,
    ));
    const reconnected = await repository.completeBrokerOrganisationSelection({
      flowHash: newContext.flow.flowHash,
      browserSessionHash: newContext.flow.browserSessionHash,
      selectionCsrfHash: newContext.selectionCsrfHash,
      selectedConnectionId: newContext.connections[0]!.connectionId,
      bindingId: `v2-expired-reconnect-new-binding-${newSuffix}`,
      policyId: `v2-expired-reconnect-new-policy-${newSuffix}`,
      authorizationCodeHash: hash(`v2-expired-reconnect-new-code-${newSuffix}`),
      authorizationCodeExpiresAt: new Date(reconnectedAt.getTime() + 5 * 60_000),
      now: reconnectedAt,
    });
    expect(reconnected).toMatchObject({ installation: { status: "ACTIVE" } });

    const oldState = await repository.pool.query(
      `SELECT installation.installation_status, binding.binding_status,
              family.family_status, refresh_token.revoked_at AS refresh_revoked_at,
              access.revoked_at AS access_revoked_at,
              provider_auth.authorization_status, connection.connection_status
       FROM oauth_installations installation
       JOIN agent_connection_bindings binding
         ON binding.oauth_installation_id = installation.installation_id
       JOIN mcp_refresh_token_families family
         ON family.oauth_installation_id = installation.installation_id
       JOIN mcp_refresh_tokens refresh_token ON refresh_token.family_id = family.family_id
       JOIN mcp_access_tokens access
         ON access.oauth_installation_id = installation.installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE installation.installation_id = $1`,
      [oldIssued.installation.installationId],
    );
    expect(oldState.rows[0]).toMatchObject({
      installation_status: "REVOKED",
      binding_status: "REVOKED",
      family_status: "REVOKED",
      authorization_status: "ACTIVE",
      connection_status: "ACTIVE",
    });
    expect(oldState.rows[0]?.refresh_revoked_at).toBeInstanceOf(Date);
    expect(oldState.rows[0]?.access_revoked_at).toBeInstanceOf(Date);
    await expect(repository.resolveMcpAccessToken({
      tokenHash: oldAccessHash,
      expectedResource: oldContext.flow.resource,
      expectedAudience: oldContext.flow.audience,
      now: reconnectedAt,
    })).resolves.toBeUndefined();

    if (reconnected) {
      await repository.revokeOAuthInstallation(
        reconnected.installation.installationId,
        reconnected.installation.workspaceId,
        new Date(reconnectedAt.getTime() + 1_000),
      );
    }
  });
});
