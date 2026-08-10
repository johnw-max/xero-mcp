import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../src/db/repository.js";
import type {
  AgentConnectionBinding,
  AuthorizedProviderConnection,
  McpAccessToken,
  McpRefreshTokenFamily,
  OAuthAuthorizationCode,
  OAuthBrokerFlow,
  OAuthInstallation,
  ProviderAuthorization,
  ResolveAgentConnectionBindingInput,
} from "../src/domain/models.js";

const now = new Date("2026-08-05T12:00:00.000Z");
const minuteLater = new Date("2026-08-05T12:01:00.000Z");
const tenMinutesLater = new Date("2026-08-05T12:10:00.000Z");
const hourLater = new Date("2026-08-05T13:00:00.000Z");
const past = new Date("2026-08-05T11:59:00.000Z");
const resource = "https://mcp.example.test/mcp";
const audience = "xero-accounting-mcp";

function retryMetadata(issuedAt: Date) {
  return {
    retryResponseCiphertext: `encrypted-refresh-response-${issuedAt.toISOString()}`,
    retryExpiresAt: new Date(issuedAt.getTime() + 10_000),
  };
}

interface SeededIdentity {
  authorization: ProviderAuthorization;
  connection: AuthorizedProviderConnection;
  installation: OAuthInstallation;
  binding: AgentConnectionBinding;
  resolveInput: ResolveAgentConnectionBindingInput;
}

async function seedIdentity(repository: AccountingRepository, suffix: string): Promise<SeededIdentity> {
  const authorization: ProviderAuthorization = {
    authorizationId: `auth-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    authorizedBySubject: `user-${suffix}`,
    provider: "xero",
    providerSubject: `xero-user-${suffix}`,
    grantedScopes: ["accounting.invoices.read"],
    tokenCiphertext: `encrypted-provider-token-${suffix}`,
    tokenExpiresAt: hourLater,
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveProviderAuthorization(authorization);

  const connection: AuthorizedProviderConnection = {
    connectionId: `connection-${suffix}`,
    authorizationId: authorization.authorizationId,
    provider: "xero",
    providerConnectionId: `xero-connection-${suffix}`,
    tenantId: `tenant-${suffix}`,
    tenantName: `Organisation ${suffix}`,
    status: "ACTIVE",
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await repository.upsertAuthorizedProviderConnection(authorization.workspaceId, connection);

  const installation: OAuthInstallation = {
    installationId: `installation-${suffix}`,
    workspaceId: authorization.workspaceId,
    subjectType: "USER",
    subjectId: authorization.authorizedBySubject,
    agentId: `agent-${suffix}`,
    clientId: `oauth-client-${suffix}`,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveOAuthInstallation(installation);

  const binding: AgentConnectionBinding = {
    bindingId: `binding-${suffix}`,
    installationId: installation.installationId,
    workspaceId: installation.workspaceId,
    subjectType: installation.subjectType,
    subjectId: installation.subjectId,
    agentId: installation.agentId,
    connectionId: connection.connectionId,
    policyId: `policy-${suffix}`,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveAgentConnectionBinding(binding);

  return {
    authorization,
    connection,
    installation,
    binding,
    resolveInput: {
      installationId: installation.installationId,
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      subjectType: binding.subjectType,
      subjectId: binding.subjectId,
      agentId: binding.agentId,
      connectionId: binding.connectionId,
    },
  };
}

function brokerFlow(suffix: string, expiresAt = tenMinutesLater): OAuthBrokerFlow {
  return {
    flowHash: `flow-hash-${suffix}`,
    browserSessionHash: `browser-hash-${suffix}`,
    clientId: `oauth-client-${suffix}`,
    redirectUri: `https://client.example.test/${suffix}/callback`,
    pkceCodeChallenge: `pkce-challenge-${suffix}`,
    pkceCodeChallengeMethod: "S256",
    workspaceId: `workspace-${suffix}`,
    subjectType: "USER",
    subjectId: `user-${suffix}`,
    agentId: `agent-${suffix}`,
    requestedScopes: ["accounting.invoices.read"],
    expiresAt,
    createdAt: expiresAt <= now ? new Date("2026-08-05T11:50:00.000Z") : now,
  };
}

function authorizationCode(identity: SeededIdentity, suffix: string, expiresAt = tenMinutesLater): OAuthAuthorizationCode {
  return {
    codeHash: `authorization-code-hash-${suffix}`,
    flowHash: `flow-hash-${suffix}`,
    installationId: identity.installation.installationId,
    bindingId: identity.binding.bindingId,
    connectionId: identity.connection.connectionId,
    clientId: identity.installation.clientId,
    redirectUri: `https://client.example.test/${suffix}/callback`,
    pkceCodeChallenge: `pkce-challenge-${suffix}`,
    pkceCodeChallengeMethod: "S256",
    resource,
    audience,
    grantedScopes: ["mcp:tools"],
    expiresAt,
    createdAt: expiresAt <= now ? new Date("2026-08-05T11:50:00.000Z") : now,
  };
}

async function consumeFlowForAuthorizationCode(
  repository: AccountingRepository,
  identity: SeededIdentity,
  suffix: string,
  requestedScopes = ["mcp:tools"],
  consumedAt = now,
): Promise<OAuthBrokerFlow> {
  const flow: OAuthBrokerFlow = {
    ...brokerFlow(suffix),
    clientId: identity.installation.clientId,
    workspaceId: identity.installation.workspaceId,
    subjectType: identity.installation.subjectType,
    subjectId: identity.installation.subjectId,
    agentId: identity.installation.agentId,
    requestedScopes,
    createdAt: new Date(Math.min(now.getTime(), consumedAt.getTime())),
  };
  await repository.saveOAuthBrokerFlow(flow);
  await expect(repository.consumeOAuthBrokerFlow({
    flowHash: flow.flowHash,
    browserSessionHash: flow.browserSessionHash,
    clientId: flow.clientId,
    redirectUri: flow.redirectUri,
    now: consumedAt,
  })).resolves.toMatchObject({ flowHash: flow.flowHash, consumedAt });
  return flow;
}

function accessToken(
  identity: SeededIdentity,
  suffix: string,
  refreshFamilyId?: string,
): McpAccessToken {
  const token: McpAccessToken = {
    tokenHash: `access-token-hash-${suffix}`,
    tokenId: `access-token-id-${suffix}`,
    installationId: identity.installation.installationId,
    bindingId: identity.binding.bindingId,
    connectionId: identity.connection.connectionId,
    clientId: identity.installation.clientId,
    resource,
    audience,
    grantedScopes: ["mcp:tools"],
    issuedAt: now,
    expiresAt: hourLater,
  };
  if (refreshFamilyId) token.refreshFamilyId = refreshFamilyId;
  return token;
}

function refreshFamily(identity: SeededIdentity, suffix: string): McpRefreshTokenFamily {
  return {
    familyId: `refresh-family-${suffix}`,
    installationId: identity.installation.installationId,
    bindingId: identity.binding.bindingId,
    connectionId: identity.connection.connectionId,
    clientId: identity.installation.clientId,
    resource,
    audience,
    grantedScopes: ["mcp:tools"],
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
}

async function createRefreshFamily(
  repository: AccountingRepository,
  identity: SeededIdentity,
  suffix: string,
  expiresAt = hourLater,
): Promise<McpRefreshTokenFamily> {
  const family = refreshFamily(identity, suffix);
  await repository.createMcpRefreshTokenFamily({
    family,
    initialToken: {
      tokenHash: `refresh-token-hash-${suffix}-0`,
      tokenId: `refresh-token-id-${suffix}-0`,
      familyId: family.familyId,
      issuedAt: now,
      expiresAt,
    },
  });
  return family;
}

describe("Phase 2a OAuth identity repository contract", () => {
  it("keeps provider credentials on Authorization and updates them with refresh-version CAS", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "a");

    await expect(repository.getProviderAuthorization(
      identity.authorization.authorizationId,
      "workspace-b",
      identity.authorization.authorizedBySubject,
    )).resolves.toBeUndefined();
    await expect(repository.listActiveConnectionsByAuthorization(
      identity.authorization.authorizationId,
      "workspace-b",
    )).resolves.toEqual([]);

    const updated = await repository.updateProviderAuthorizationToken(
      identity.authorization.authorizationId,
      identity.authorization.workspaceId,
      0,
      "encrypted-provider-token-rotated",
      hourLater,
      ["accounting.invoices.read", "accounting.contacts.read"],
    );
    expect(updated).toMatchObject({ refreshVersion: 1, tokenCiphertext: "encrypted-provider-token-rotated" });
    await expect(repository.updateProviderAuthorizationToken(
      identity.authorization.authorizationId,
      identity.authorization.workspaceId,
      0,
      "stale-token",
      hourLater,
      [],
    )).resolves.toBeUndefined();
  });

  it("consumes a short-lived broker flow once and binds browser, OAuth client, and redirect URI", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const flow = brokerFlow("a");
    await expect(repository.saveOAuthBrokerFlow({
      ...brokerFlow("invalid-lifetime"),
      expiresAt: now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await repository.saveOAuthBrokerFlow(flow);

    for (const mismatch of [
      { browserSessionHash: "browser-hash-b" },
      { clientId: "oauth-client-b" },
      { redirectUri: "https://client.example.test/b/callback" },
    ]) {
      await expect(repository.consumeOAuthBrokerFlow({
        flowHash: flow.flowHash,
        browserSessionHash: flow.browserSessionHash,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        now,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    const consumed = await repository.consumeOAuthBrokerFlow({
      flowHash: flow.flowHash,
      browserSessionHash: flow.browserSessionHash,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      now,
    });
    expect(consumed).toMatchObject({
      flowHash: flow.flowHash,
      pkceCodeChallenge: flow.pkceCodeChallenge,
      consumedAt: now,
    });
    await expect(repository.consumeOAuthBrokerFlow({
      flowHash: flow.flowHash,
      browserSessionHash: flow.browserSessionHash,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      now,
    })).resolves.toBeUndefined();

    const expired = brokerFlow("expired", past);
    await repository.saveOAuthBrokerFlow(expired);
    await expect(repository.consumeOAuthBrokerFlow({
      flowHash: expired.flowHash,
      browserSessionHash: expired.browserSessionHash,
      clientId: expired.clientId,
      redirectUri: expired.redirectUri,
      now,
    })).resolves.toBeUndefined();
  });

  it("consumes an authorization code once and binds OAuth client, redirect URI, and S256 PKCE", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "a");
    const code = authorizationCode(identity, "a");
    await expect(repository.saveOAuthAuthorizationCode({
      ...authorizationCode(identity, "invalid-lifetime"),
      expiresAt: now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.saveOAuthAuthorizationCode({
      ...authorizationCode(identity, "wrong-client"),
      flowHash: code.flowHash,
      clientId: "oauth-client-wrong",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(repository.saveOAuthAuthorizationCode(code)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await consumeFlowForAuthorizationCode(repository, identity, "a");
    await expect(repository.saveOAuthAuthorizationCode({
      ...code,
      codeHash: "authorization-code-hash-scope-escalation",
      grantedScopes: ["mcp:tools", "mcp:admin"],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await repository.saveOAuthAuthorizationCode(code);

    for (const mismatch of [
      { clientId: "oauth-client-b" },
      { redirectUri: "https://client.example.test/b/callback" },
      { pkceCodeChallenge: "pkce-challenge-b" },
    ]) {
      await expect(repository.consumeOAuthAuthorizationCode({
        codeHash: code.codeHash,
        clientId: code.clientId,
        redirectUri: code.redirectUri,
        pkceCodeChallenge: code.pkceCodeChallenge,
        now,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    await expect(repository.consumeOAuthAuthorizationCode({
      codeHash: code.codeHash,
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      pkceCodeChallenge: code.pkceCodeChallenge,
      now,
    })).resolves.toMatchObject({ codeHash: code.codeHash, consumedAt: now });
    await expect(repository.consumeOAuthAuthorizationCode({
      codeHash: code.codeHash,
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      pkceCodeChallenge: code.pkceCodeChallenge,
      now,
    })).resolves.toBeUndefined();

    const expired = authorizationCode(identity, "expired", past);
    await consumeFlowForAuthorizationCode(
      repository,
      identity,
      "expired",
      ["mcp:tools"],
      new Date("2026-08-05T11:50:00.000Z"),
    );
    await repository.saveOAuthAuthorizationCode(expired);
    await expect(repository.consumeOAuthAuthorizationCode({
      codeHash: expired.codeHash,
      clientId: expired.clientId,
      redirectUri: expired.redirectUri,
      pkceCodeChallenge: expired.pkceCodeChallenge,
      now,
    })).resolves.toBeUndefined();
  });

  it("atomically consumes a code and issues a scope-bound access/refresh token set", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "atomic");
    const code = authorizationCode(identity, "atomic");
    await consumeFlowForAuthorizationCode(repository, identity, "atomic");
    await repository.saveOAuthAuthorizationCode(code);
    const family = refreshFamily(identity, "atomic");
    const initialRefreshToken = {
      tokenHash: "refresh-token-hash-atomic-0",
      tokenId: "refresh-token-id-atomic-0",
      familyId: family.familyId,
      issuedAt: now,
      expiresAt: hourLater,
    };
    const issuedAccessToken = accessToken(identity, "atomic", family.familyId);
    const exchangeInput = {
      grant: {
        codeHash: code.codeHash,
        clientId: code.clientId,
        redirectUri: code.redirectUri,
        pkceCodeChallenge: code.pkceCodeChallenge,
        expectedResource: code.resource,
        now,
      },
      accessToken: issuedAccessToken,
      refreshTokenFamily: { family, initialToken: initialRefreshToken },
    };

    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet({
      ...exchangeInput,
      grant: { ...exchangeInput.grant, pkceCodeChallenge: "pkce-wrong" },
    })).resolves.toEqual({ status: "INVALID" });
    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet({
      ...exchangeInput,
      grant: { ...exchangeInput.grant, expectedResource: "https://wrong-resource.example/mcp" },
    })).resolves.toEqual({ status: "INVALID" });
    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet({
      ...exchangeInput,
      accessToken: {
        ...issuedAccessToken,
        grantedScopes: ["mcp:tools", "mcp:admin"],
      },
    })).resolves.toEqual({ status: "INVALID" });

    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet(exchangeInput)).resolves.toMatchObject({
      status: "ISSUED",
      authorizationCode: { codeHash: code.codeHash, consumedAt: now },
      accessToken: { tokenHash: issuedAccessToken.tokenHash },
      refreshToken: { tokenHash: initialRefreshToken.tokenHash },
    });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: issuedAccessToken.tokenHash,
      expectedResource: issuedAccessToken.resource,
      expectedAudience: issuedAccessToken.audience,
      now: minuteLater,
    })).resolves.toMatchObject({ connectionId: identity.connection.connectionId });
    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet(exchangeInput)).resolves.toEqual({
      status: "INVALID",
    });
  });

  it("treats a revoked authorized connection as terminal across status changes and ordinary upserts", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "connection-terminal");

    await expect(repository.markConnectionStatusIfVersion(
      identity.connection.connectionId,
      0,
      "TOKEN_REFRESH_FAILED",
    )).resolves.toBe(true);
    await expect(repository.listActiveConnectionsByAuthorization(
      identity.authorization.authorizationId,
      identity.authorization.workspaceId,
    )).resolves.toEqual([]);

    await repository.markConnectionStatus(identity.connection.connectionId, "ACTIVE");
    await expect(repository.listActiveConnectionsByAuthorization(
      identity.authorization.authorizationId,
      identity.authorization.workspaceId,
    )).resolves.toHaveLength(1);

    await repository.markConnectionStatus(identity.connection.connectionId, "REVOKED");
    await repository.markConnectionStatus(identity.connection.connectionId, "ACTIVE");
    await expect(repository.markConnectionStatusIfVersion(
      identity.connection.connectionId,
      0,
      "ACTIVE",
    )).resolves.toBe(false);
    await expect(repository.upsertAuthorizedProviderConnection(identity.authorization.workspaceId, {
      ...identity.connection,
      status: "ACTIVE",
      updatedAt: minuteLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.listActiveConnectionsByAuthorization(
      identity.authorization.authorizationId,
      identity.authorization.workspaceId,
    )).resolves.toEqual([]);
  });

  it("never resolves a binding across installation, workspace, subject, agent, or connection", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const a = await seedIdentity(repository, "a");
    const b = await seedIdentity(repository, "b");

    await expect(repository.resolveAgentConnectionBinding(a.resolveInput)).resolves.toMatchObject({
      installationId: a.installation.installationId,
      bindingId: a.binding.bindingId,
      connectionId: a.connection.connectionId,
      authorizationId: a.authorization.authorizationId,
    });
    for (const mismatch of [
      { installationId: b.installation.installationId },
      { bindingId: b.binding.bindingId },
      { workspaceId: b.binding.workspaceId },
      { subjectId: b.binding.subjectId },
      { agentId: b.binding.agentId },
      { connectionId: b.connection.connectionId },
    ]) {
      await expect(repository.resolveAgentConnectionBinding({
        ...a.resolveInput,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    await expect(repository.saveAgentConnectionBinding({
      ...a.binding,
      bindingId: "binding-cross-tenant",
      connectionId: b.connection.connectionId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("resolves opaque access tokens only for their resource, audience, and active binding", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const a = await seedIdentity(repository, "a");
    const b = await seedIdentity(repository, "b");
    const token = accessToken(a, "a");
    await expect(repository.saveMcpAccessToken({
      ...accessToken(a, "invalid-lifetime"),
      expiresAt: now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await repository.saveMcpAccessToken(token);
    await expect(repository.saveMcpAccessToken({
      ...accessToken(a, "wrong-client"),
      clientId: "oauth-client-wrong",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const expiredToken: McpAccessToken = {
      ...accessToken(a, "expired"),
      issuedAt: new Date("2026-08-05T11:50:00.000Z"),
      expiresAt: past,
    };
    await repository.saveMcpAccessToken(expiredToken);
    await expect(repository.resolveMcpAccessToken({
      tokenHash: expiredToken.tokenHash,
      expectedResource: expiredToken.resource,
      expectedAudience: expiredToken.audience,
      now,
    })).resolves.toBeUndefined();

    await expect(repository.resolveMcpAccessToken({
      tokenHash: token.tokenHash,
      expectedResource: "https://another-resource.example/mcp",
      expectedAudience: token.audience,
      now,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: token.tokenHash,
      expectedResource: token.resource,
      expectedAudience: "another-audience",
      now,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: token.tokenHash,
      expectedResource: token.resource,
      expectedAudience: token.audience,
      now,
    })).resolves.toMatchObject({
      installationId: a.installation.installationId,
      bindingId: a.binding.bindingId,
      connectionId: a.connection.connectionId,
      tenantId: a.connection.tenantId,
    });

    await expect(repository.saveMcpAccessToken({
      ...accessToken(a, "cross"),
      connectionId: b.connection.connectionId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(repository.revokeMcpAccessToken(token.tokenHash, minuteLater)).resolves.toBe(true);
    await expect(repository.resolveMcpAccessToken({
      tokenHash: token.tokenHash,
      expectedResource: token.resource,
      expectedAudience: token.audience,
      now: minuteLater,
    })).resolves.toBeUndefined();
  });

  it("rotates refresh-token hashes once and revokes the whole family after replay", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const a = await seedIdentity(repository, "a");
    const b = await seedIdentity(repository, "b");
    const familyA = await createRefreshFamily(repository, a, "a");
    const familyB = await createRefreshFamily(repository, b, "b");
    await expect(createRefreshFamily(repository, a, "a-second-active")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const invalidFamily = refreshFamily(a, "invalid-shape");
    await expect(repository.createMcpRefreshTokenFamily({
      family: invalidFamily,
      initialToken: {
        tokenHash: "refresh-token-hash-invalid-shape-0",
        tokenId: "refresh-token-id-invalid-shape-0",
        familyId: invalidFamily.familyId,
        issuedAt: now,
        expiresAt: hourLater,
        consumedAt: now,
      },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.createMcpRefreshTokenFamily({
      family: { ...refreshFamily(a, "wrong-client"), clientId: "oauth-client-wrong" },
      initialToken: {
        tokenHash: "refresh-token-hash-wrong-client-0",
        tokenId: "refresh-token-id-wrong-client-0",
        familyId: "refresh-family-wrong-client",
        issuedAt: now,
        expiresAt: hourLater,
      },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const linkedAccessA = accessToken(a, "family-a", familyA.familyId);
    await repository.saveMcpAccessToken(linkedAccessA);
    await expect(repository.saveMcpAccessToken({
      ...accessToken(a, "scope-escalation", familyA.familyId),
      grantedScopes: ["mcp:tools", "mcp:admin"],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rotatedAccessA: McpAccessToken = {
      ...accessToken(a, "rotated-a", familyA.familyId),
      issuedAt: minuteLater,
    };

    for (const mismatch of [
      { expectedClientId: "oauth-client-wrong" },
      { expectedResource: "https://wrong-resource.example/mcp" },
      { expectedAudience: "wrong-audience" },
    ]) {
      await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
        rotation: {
          currentTokenHash: "refresh-token-hash-a-0",
          expectedClientId: familyA.clientId,
          expectedResource: familyA.resource,
          expectedAudience: familyA.audience,
          newTokenHash: "refresh-token-hash-wrong-1",
          newTokenId: "refresh-token-id-wrong-1",
          issuedAt: minuteLater,
          expiresAt: hourLater,
          ...mismatch,
        },
        accessToken: rotatedAccessA,
      })).resolves.toEqual({ status: "INVALID" });
    }

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: "refresh-token-hash-a-0",
        expectedClientId: familyA.clientId,
        expectedResource: familyA.resource,
        expectedAudience: familyA.audience,
        newTokenHash: "refresh-token-hash-a-1",
        newTokenId: "refresh-token-id-a-1",
        issuedAt: minuteLater,
        expiresAt: hourLater,
      },
      accessToken: rotatedAccessA,
      ...retryMetadata(minuteLater),
    })).resolves.toMatchObject({
      status: "ROTATED",
      familyId: familyA.familyId,
      installationId: a.installation.installationId,
      bindingId: a.binding.bindingId,
      connectionId: a.connection.connectionId,
    });

    const replayAt = new Date("2026-08-05T12:02:00.000Z");
    await expect(repository.cleanupExpiredEphemeral(replayAt, 100, replayAt)).resolves.toMatchObject({
      lockAcquired: true,
      deleted: { mcpRefreshRetryResponses: 1 },
    });
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: "refresh-token-hash-a-0",
        expectedClientId: familyA.clientId,
        expectedResource: familyA.resource,
        expectedAudience: familyA.audience,
        newTokenHash: "refresh-token-hash-a-replay",
        newTokenId: "refresh-token-id-a-replay",
        issuedAt: replayAt,
        expiresAt: hourLater,
      },
      accessToken: { ...rotatedAccessA, tokenHash: "access-replay", tokenId: "access-replay", issuedAt: replayAt },
    })).resolves.toEqual({ status: "REPLAY_DETECTED", familyId: familyA.familyId });
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: "refresh-token-hash-a-1",
        expectedClientId: familyA.clientId,
        expectedResource: familyA.resource,
        expectedAudience: familyA.audience,
        newTokenHash: "refresh-token-hash-a-2",
        newTokenId: "refresh-token-id-a-2",
        issuedAt: replayAt,
        expiresAt: hourLater,
      },
      accessToken: { ...rotatedAccessA, tokenHash: "access-a-2", tokenId: "access-a-2", issuedAt: replayAt },
    })).resolves.toEqual({ status: "INVALID" });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: linkedAccessA.tokenHash,
      expectedResource: linkedAccessA.resource,
      expectedAudience: linkedAccessA.audience,
      now: replayAt,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: rotatedAccessA.tokenHash,
      expectedResource: rotatedAccessA.resource,
      expectedAudience: rotatedAccessA.audience,
      now: replayAt,
    })).resolves.toBeUndefined();

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        currentTokenHash: "refresh-token-hash-b-0",
        expectedClientId: familyB.clientId,
        expectedResource: familyB.resource,
        expectedAudience: familyB.audience,
        newTokenHash: "refresh-token-hash-b-1",
        newTokenId: "refresh-token-id-b-1",
        issuedAt: replayAt,
        expiresAt: hourLater,
      },
      accessToken: { ...accessToken(b, "rotated-b", familyB.familyId), issuedAt: replayAt },
      ...retryMetadata(replayAt),
    })).resolves.toMatchObject({ status: "ROTATED", familyId: familyB.familyId });
  });

  it("allows a refresh request to narrow scopes but rejects scope expansion", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "refresh-scope");
    const family = {
      ...refreshFamily(identity, "refresh-scope"),
      grantedScopes: ["mcp:tools", "mcp:reports"],
    };
    await repository.createMcpRefreshTokenFamily({
      family,
      initialToken: {
        tokenHash: "refresh-token-hash-refresh-scope-0",
        tokenId: "refresh-token-id-refresh-scope-0",
        familyId: family.familyId,
        issuedAt: now,
        expiresAt: hourLater,
      },
    });

    const baseRotation = {
      currentTokenHash: "refresh-token-hash-refresh-scope-0",
      expectedClientId: family.clientId,
      expectedResource: family.resource,
      expectedAudience: family.audience,
      newTokenHash: "refresh-token-hash-refresh-scope-1",
      newTokenId: "refresh-token-id-refresh-scope-1",
      issuedAt: minuteLater,
      expiresAt: hourLater,
    };
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: { ...baseRotation, requestedScopes: ["mcp:tools", "mcp:admin"] },
      accessToken: {
        ...accessToken(identity, "refresh-scope-expanded", family.familyId),
        grantedScopes: ["mcp:tools", "mcp:admin"],
        issuedAt: minuteLater,
      },
    })).resolves.toEqual({ status: "INVALID" });

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: { ...baseRotation, requestedScopes: ["mcp:tools"] },
      accessToken: {
        ...accessToken(identity, "refresh-scope-overlong-retry", family.familyId),
        grantedScopes: ["mcp:tools"],
        issuedAt: minuteLater,
      },
      retryResponseCiphertext: "encrypted-overlong-refresh-response",
      retryExpiresAt: new Date(minuteLater.getTime() + 10_001),
    })).resolves.toEqual({ status: "INVALID" });

    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: { ...baseRotation, requestedScopes: ["mcp:tools"] },
      accessToken: {
        ...accessToken(identity, "refresh-scope-narrowed", family.familyId),
        grantedScopes: ["mcp:tools"],
        issuedAt: minuteLater,
      },
      ...retryMetadata(minuteLater),
    })).resolves.toMatchObject({
      status: "ROTATED",
      grantedScopes: ["mcp:tools"],
      accessToken: { grantedScopes: ["mcp:tools"] },
    });
  });

  it("rejects expired refresh tokens and cascades installation revocation without affecting another installation", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const a = await seedIdentity(repository, "a");
    const b = await seedIdentity(repository, "b");
    const expiredFamily = await createRefreshFamily(repository, a, "expired", minuteLater);
    const familyB = await createRefreshFamily(repository, b, "b");
    const accessA = accessToken(a, "a");
    const accessB = accessToken(b, "b", familyB.familyId);
    await repository.saveMcpAccessToken(accessA);
    await repository.saveMcpAccessToken(accessB);

    await expect(repository.rotateMcpRefreshToken({
      currentTokenHash: "refresh-token-hash-expired-0",
      expectedClientId: expiredFamily.clientId,
      expectedResource: expiredFamily.resource,
      expectedAudience: expiredFamily.audience,
      newTokenHash: "refresh-token-hash-expired-1",
      newTokenId: "refresh-token-id-expired-1",
      issuedAt: tenMinutesLater,
      expiresAt: hourLater,
    })).resolves.toEqual({ status: "INVALID" });

    await expect(repository.saveOAuthInstallation({
      ...a.installation,
      status: "ACTIVE",
      updatedAt: tenMinutesLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.saveAgentConnectionBinding({
      ...a.binding,
      status: "ACTIVE",
      updatedAt: tenMinutesLater,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(repository.resolveAgentConnectionBinding(a.resolveInput)).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessA.tokenHash,
      expectedResource: accessA.resource,
      expectedAudience: accessA.audience,
      now: tenMinutesLater,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessB.tokenHash,
      expectedResource: accessB.resource,
      expectedAudience: accessB.audience,
      now: tenMinutesLater,
    })).resolves.toMatchObject({ installationId: b.installation.installationId });
    await expect(repository.revokeOAuthInstallation(
      a.installation.installationId,
      b.installation.workspaceId,
      tenMinutesLater,
    )).resolves.toBe(false);
  });

  it("revokes a refresh family by any member hash", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity = await seedIdentity(repository, "a");
    const family = await createRefreshFamily(repository, identity, "a");
    await expect(repository.revokeMcpRefreshTokenFamilyByTokenHash(
      "refresh-token-hash-a-0",
      minuteLater,
    )).resolves.toBe(true);
    await expect(repository.rotateMcpRefreshToken({
      currentTokenHash: "refresh-token-hash-a-0",
      expectedClientId: family.clientId,
      expectedResource: family.resource,
      expectedAudience: family.audience,
      newTokenHash: "refresh-token-hash-a-1",
      newTokenId: "refresh-token-id-a-1",
      issuedAt: minuteLater,
      expiresAt: hourLater,
    })).resolves.toEqual({ status: "INVALID" });
  });
});
