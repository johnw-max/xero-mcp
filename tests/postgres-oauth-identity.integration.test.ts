import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres Phase 2a OAuth identity integration", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await repository?.close();
  });

  it("executes binding isolation, one-time grants, access resolution, and refresh replay revocation", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const createdAt = new Date();
    const minuteLater = new Date(createdAt.getTime() + 60_000);
    const twoMinutesLater = new Date(createdAt.getTime() + 120_000);
    const threeMinutesLater = new Date(createdAt.getTime() + 180_000);
    const expiresAt = new Date(createdAt.getTime() + 3_600_000);
    const resource = "https://mcp.example.test/mcp";
    const audience = "xero-accounting-mcp";

    await expect(repository.readiness()).resolves.toBe(true);
    await repository.saveProviderAuthorization({
      authorizationId: `auth-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      authorizedBySubject: `user-${suffix}`,
      provider: "xero",
      grantedScopes: ["accounting.invoices.read"],
      tokenCiphertext: `encrypted-${suffix}`,
      tokenExpiresAt: expiresAt,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    const connection = await repository.upsertAuthorizedProviderConnection(`workspace-${suffix}`, {
      connectionId: `connection-${suffix}`,
      authorizationId: `auth-${suffix}`,
      provider: "xero",
      providerConnectionId: `xero-connection-${suffix}`,
      tenantId: `tenant-${suffix}`,
      tenantName: "Postgres Test Organisation",
      status: "ACTIVE",
      lastVerifiedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveOAuthInstallation({
      installationId: `installation-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      clientId: `oauth-client-${suffix}`,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveAgentConnectionBinding({
      bindingId: `binding-${suffix}`,
      installationId: `installation-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      connectionId: connection.connectionId,
      policyId: `policy-${suffix}`,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: `installation-${suffix}`,
      bindingId: `binding-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      connectionId: connection.connectionId,
    })).resolves.toMatchObject({ tenantId: `tenant-${suffix}` });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: `installation-${suffix}`,
      bindingId: `binding-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      connectionId: `connection-cross-${suffix}`,
    })).resolves.toBeUndefined();

    await repository.saveOAuthBrokerFlow({
      flowHash: `flow-hash-${suffix}`,
      browserSessionHash: `browser-hash-${suffix}`,
      clientId: `oauth-client-${suffix}`,
      redirectUri: `https://client.example.test/${suffix}/callback`,
      pkceCodeChallenge: `pkce-${suffix}`,
      pkceCodeChallengeMethod: "S256",
      workspaceId: `workspace-${suffix}`,
      subjectType: "USER",
      subjectId: `user-${suffix}`,
      agentId: `agent-${suffix}`,
      requestedScopes: ["mcp:tools", "mcp:reports"],
      expiresAt,
      createdAt,
    });
    const flowInput = {
      flowHash: `flow-hash-${suffix}`,
      browserSessionHash: `browser-hash-${suffix}`,
      clientId: `oauth-client-${suffix}`,
      redirectUri: `https://client.example.test/${suffix}/callback`,
      now: minuteLater,
    };
    await expect(repository.consumeOAuthBrokerFlow(flowInput)).resolves.toMatchObject({ consumedAt: minuteLater });
    await expect(repository.consumeOAuthBrokerFlow(flowInput)).resolves.toBeUndefined();

    await repository.saveOAuthAuthorizationCode({
      codeHash: `code-hash-${suffix}`,
      flowHash: `flow-hash-${suffix}`,
      installationId: `installation-${suffix}`,
      bindingId: `binding-${suffix}`,
      connectionId: connection.connectionId,
      clientId: `oauth-client-${suffix}`,
      redirectUri: `https://client.example.test/${suffix}/callback`,
      pkceCodeChallenge: `pkce-${suffix}`,
      pkceCodeChallengeMethod: "S256",
      resource,
      audience,
      grantedScopes: ["mcp:tools", "mcp:reports"],
      expiresAt,
      createdAt: minuteLater,
    });
    await expect(repository.consumeOAuthAuthorizationCode({
      codeHash: `code-hash-${suffix}`,
      clientId: `oauth-client-${suffix}`,
      redirectUri: `https://client.example.test/${suffix}/callback`,
      pkceCodeChallenge: "pkce-wrong",
      now: minuteLater,
    })).resolves.toBeUndefined();
    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet({
      grant: {
        codeHash: `code-hash-${suffix}`,
        clientId: `oauth-client-${suffix}`,
        redirectUri: `https://client.example.test/${suffix}/callback`,
        pkceCodeChallenge: `pkce-${suffix}`,
        expectedResource: resource,
        now: minuteLater,
      },
      refreshTokenFamily: {
        family: {
          familyId: `family-${suffix}`,
          installationId: `installation-${suffix}`,
          bindingId: `binding-${suffix}`,
          connectionId: connection.connectionId,
          clientId: `oauth-client-${suffix}`,
          resource,
          audience,
          grantedScopes: ["mcp:tools", "mcp:reports"],
          status: "ACTIVE",
          createdAt,
          updatedAt: createdAt,
        },
        initialToken: {
          tokenHash: `refresh-hash-${suffix}-0`,
          tokenId: `refresh-id-${suffix}-0`,
          familyId: `family-${suffix}`,
          issuedAt: minuteLater,
          expiresAt,
        },
      },
      accessToken: {
        tokenHash: `access-hash-${suffix}`,
        tokenId: `access-id-${suffix}`,
        installationId: `installation-${suffix}`,
        bindingId: `binding-${suffix}`,
        connectionId: connection.connectionId,
        refreshFamilyId: `family-${suffix}`,
        clientId: `oauth-client-${suffix}`,
        resource,
        audience,
        grantedScopes: ["mcp:tools", "mcp:reports"],
        issuedAt: minuteLater,
        expiresAt,
      },
    })).resolves.toMatchObject({ status: "ISSUED" });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: `access-hash-${suffix}`,
      expectedResource: resource,
      expectedAudience: audience,
      now: twoMinutesLater,
    })).resolves.toMatchObject({ connectionId: connection.connectionId });

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: `refresh-hash-${suffix}-0`,
        expectedClientId: `oauth-client-${suffix}`,
        expectedResource: resource,
        expectedAudience: audience,
        requestedScopes: ["mcp:tools", "mcp:admin"],
        newTokenHash: `refresh-hash-${suffix}-scope-escalation`,
        newTokenId: `refresh-id-${suffix}-scope-escalation`,
        issuedAt: twoMinutesLater,
        expiresAt,
      },
      accessToken: {
        tokenHash: `access-hash-${suffix}-scope-escalation`,
        tokenId: `access-id-${suffix}-scope-escalation`,
        installationId: `installation-${suffix}`,
        bindingId: `binding-${suffix}`,
        connectionId: connection.connectionId,
        refreshFamilyId: `family-${suffix}`,
        clientId: `oauth-client-${suffix}`,
        resource,
        audience,
        grantedScopes: ["mcp:tools", "mcp:admin"],
        issuedAt: twoMinutesLater,
        expiresAt,
      },
    })).resolves.toEqual({ status: "INVALID" });

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: `refresh-hash-${suffix}-0`,
        expectedClientId: `oauth-client-${suffix}`,
        expectedResource: resource,
        expectedAudience: audience,
        requestedScopes: ["mcp:tools"],
        newTokenHash: `refresh-hash-${suffix}-1`,
        newTokenId: `refresh-id-${suffix}-1`,
        issuedAt: twoMinutesLater,
        expiresAt,
      },
      accessToken: {
        tokenHash: `access-hash-${suffix}-1`,
        tokenId: `access-id-${suffix}-1`,
        installationId: `installation-${suffix}`,
        bindingId: `binding-${suffix}`,
        connectionId: connection.connectionId,
        refreshFamilyId: `family-${suffix}`,
        clientId: `oauth-client-${suffix}`,
        resource,
        audience,
        grantedScopes: ["mcp:tools"],
        issuedAt: twoMinutesLater,
        expiresAt,
      },
      retryResponseCiphertext: `encrypted-refresh-response-${suffix}-1`,
      retryExpiresAt: new Date(twoMinutesLater.getTime() + 10_000),
    })).resolves.toMatchObject({
      status: "ROTATED",
      familyId: `family-${suffix}`,
      grantedScopes: ["mcp:tools"],
      accessToken: { grantedScopes: ["mcp:tools"] },
    });
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: `refresh-hash-${suffix}-0`,
        expectedClientId: `oauth-client-${suffix}`,
        expectedResource: resource,
        expectedAudience: audience,
        newTokenHash: `refresh-hash-${suffix}-replay`,
        newTokenId: `refresh-id-${suffix}-replay`,
        issuedAt: threeMinutesLater,
        expiresAt,
      },
      accessToken: {
        tokenHash: `access-hash-${suffix}-replay`,
        tokenId: `access-id-${suffix}-replay`,
        installationId: `installation-${suffix}`,
        bindingId: `binding-${suffix}`,
        connectionId: connection.connectionId,
        refreshFamilyId: `family-${suffix}`,
        clientId: `oauth-client-${suffix}`,
        resource,
        audience,
        grantedScopes: ["mcp:tools"],
        issuedAt: threeMinutesLater,
        expiresAt,
      },
    })).resolves.toEqual({ status: "REPLAY_DETECTED", familyId: `family-${suffix}` });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: `access-hash-${suffix}`,
      expectedResource: resource,
      expectedAudience: audience,
      now: threeMinutesLater,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: `access-hash-${suffix}-1`,
      expectedResource: resource,
      expectedAudience: audience,
      now: threeMinutesLater,
    })).resolves.toBeUndefined();

    await expect(repository.markConnectionStatusIfVersion(
      connection.connectionId,
      0,
      "TOKEN_REFRESH_FAILED",
    )).resolves.toBe(true);
    await expect(repository.listActiveConnectionsByAuthorization(
      `auth-${suffix}`,
      `workspace-${suffix}`,
    )).resolves.toEqual([]);
    await repository.markConnectionStatus(connection.connectionId, "ACTIVE");
    await expect(repository.listActiveConnectionsByAuthorization(
      `auth-${suffix}`,
      `workspace-${suffix}`,
    )).resolves.toHaveLength(1);
    await repository.markConnectionStatus(connection.connectionId, "REVOKED");
    await repository.markConnectionStatus(connection.connectionId, "ACTIVE");
    await expect(repository.upsertAuthorizedProviderConnection(`workspace-${suffix}`, {
      ...connection,
      status: "ACTIVE",
      updatedAt: threeMinutesLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.listActiveConnectionsByAuthorization(
      `auth-${suffix}`,
      `workspace-${suffix}`,
    )).resolves.toEqual([]);
  });

  it("accepts only complete new, legacy, or dual-write provider connection shapes", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 3_600_000);
    await repository.saveProviderAuthorization({
      authorizationId: `shape-auth-${suffix}`,
      workspaceId: `shape-workspace-${suffix}`,
      authorizedBySubject: `shape-user-${suffix}`,
      provider: "xero",
      grantedScopes: [],
      tokenCiphertext: `shape-provider-token-${suffix}`,
      tokenExpiresAt: expiresAt,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });

    const insertShape = (connectionId: string, authorizationId: string | null, actorId: string | null,
      tokenCiphertext: string | null, tokenExpiresAt: Date | null) => repository.pool.query(
      `INSERT INTO provider_connections(
         connection_id, authorization_id, actor_id, provider, tenant_id, tenant_name,
         granted_scopes, token_ciphertext, token_expires_at, refresh_version,
         connection_status, created_at, updated_at
       ) VALUES ($1,$2,$3,'xero',$4,$5,'{}',$6,$7,0,'ACTIVE',$8,$8)`,
      [
        connectionId,
        authorizationId,
        actorId,
        `shape-tenant-${connectionId}`,
        `Shape ${connectionId}`,
        tokenCiphertext,
        tokenExpiresAt,
        createdAt,
      ],
    );

    await expect(insertShape(`pure-new-${suffix}`, `shape-auth-${suffix}`, null, null, null)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(insertShape(
      `legacy-${suffix}`,
      null,
      `legacy-actor-${suffix}`,
      `legacy-token-${suffix}`,
      expiresAt,
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(insertShape(
      `dual-${suffix}`,
      `shape-auth-${suffix}`,
      `dual-actor-${suffix}`,
      `dual-token-${suffix}`,
      expiresAt,
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(insertShape(
      `partial-${suffix}`,
      `shape-auth-${suffix}`,
      `partial-actor-${suffix}`,
      null,
      null,
    )).rejects.toMatchObject({ code: "23514" });
  });
});
