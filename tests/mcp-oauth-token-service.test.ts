import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { describe, expect, it, vi } from "vitest";
import type {
  ExchangeOAuthAuthorizationCodeForTokenSetInput,
  McpAccessToken,
  McpRefreshTokenContextPreview,
  PeekMcpRefreshTokenContextInput,
  RevokeOAuthTokenForClientInput,
  ResolvedMcpAccessToken,
  RotateMcpRefreshTokenAndIssueAccessTokenInput,
} from "../src/domain/models.js";
import { MCP_OAUTH_REFRESH_RETRY_GRACE_MS } from "../src/domain/models.js";
import {
  McpOAuthTokenService,
  type EnabledMcpOAuthBrokerConfig,
  type McpOAuthTokenRepositoryDependency,
} from "../src/oauth/mcpOAuthTokenService.js";
import { sha256 } from "../src/security/hash.js";
import { keyedOAuthSecretHash, pkceS256Challenge } from "../src/security/oauthSecrets.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

const canonicalResource = "https://xero-mcp.example.test/mcp";
const exactRedirect = "https://agent2.example.test/api/mcp/accounting-mcp/oauth/callback";
const clientId = "agent2-accounting-mcp";
const now = new Date("2026-08-05T10:00:00.000Z");
const verifier = "v".repeat(43);
const rawCode = "C".repeat(43);
const accessOne = "A".repeat(43);
const refreshOne = "R".repeat(43);
const accessTwo = "B".repeat(43);
const refreshTwo = "S".repeat(43);
const accessThree = "D".repeat(43);
const refreshThree = "T".repeat(43);
const retryCipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 13));

const config: EnabledMcpOAuthBrokerConfig = {
  enabled: true,
  issuer: "https://xero-mcp.example.test",
  resourceUri: canonicalResource,
  protectedResourceUris: [canonicalResource],
  authorizationPath: "/authorize",
  tokenPath: "/token",
  revocationPath: "/revoke",
  authorizationEndpoint: "https://xero-mcp.example.test/authorize",
  tokenEndpoint: "https://xero-mcp.example.test/token",
  revocationEndpoint: "https://xero-mcp.example.test/revoke",
  scopes: ["xero.read", "xero.draft.write"],
  personalPocOnly: true,
  hostClients: [{
    name: "Agent2",
    clientId,
    clientSecret: "s".repeat(32),
    redirectUris: [exactRedirect],
  }, {
    name: "Strict Host",
    clientId: "strict-host",
    clientSecret: "t".repeat(32),
    redirectUris: ["https://strict-host.example.test/oauth/callback"],
  }],
  missingResourceCompatClientIds: [clientId],
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  authorizationCodeTtlSeconds: 300,
  browserFlowTtlSeconds: 600,
  tokenHashKey: Buffer.alloc(32, 11),
  cookieStateKey: Buffer.alloc(32, 12),
};

function authorizationCode(scopes = ["xero.read", "xero.draft.write"]) {
  return {
    codeHash: keyedOAuthSecretHash(config.tokenHashKey, "authorization_code", rawCode),
    flowHash: "flow-hash",
    installationId: "installation-1",
    bindingId: "binding-1",
    connectionId: "connection-1",
    clientId,
    redirectUri: exactRedirect,
    pkceCodeChallenge: pkceS256Challenge(verifier),
    pkceCodeChallengeMethod: "S256" as const,
    resource: canonicalResource,
    audience: canonicalResource,
    grantedScopes: scopes,
    expiresAt: new Date(now.getTime() + 4 * 60_000),
    createdAt: new Date(now.getTime() - 60_000),
  };
}

interface StoredAccess {
  resolved: ResolvedMcpAccessToken;
  refreshFamilyId: string;
}

interface StoredRefresh {
  context: McpRefreshTokenContextPreview;
  consumed: boolean;
  consumedAt?: Date;
  retry?: {
    accessTokenHash: string;
    refreshTokenHash: string;
    responseCiphertext: string;
    expiresAt: Date;
    grantedScopes: string[];
  };
}

class FakeTokenRepository implements McpOAuthTokenRepositoryDependency {
  previewCode = authorizationCode();
  codeConsumed = false;
  readonly access = new Map<string, StoredAccess>();
  readonly refresh = new Map<string, StoredRefresh>();

  readonly peekOAuthAuthorizationCodeForExchange = vi.fn(async (input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    pkceCodeChallenge: string;
    expectedResource: string;
    now: Date;
  }) => {
    if (
      this.codeConsumed ||
      input.codeHash !== this.previewCode.codeHash ||
      input.clientId !== this.previewCode.clientId ||
      input.redirectUri !== this.previewCode.redirectUri ||
      input.pkceCodeChallenge !== this.previewCode.pkceCodeChallenge ||
      input.expectedResource !== this.previewCode.resource ||
      this.previewCode.expiresAt <= input.now
    ) return undefined;
    return this.previewCode;
  });

  readonly exchangeOAuthAuthorizationCodeForTokenSet = vi.fn(
    async (input: ExchangeOAuthAuthorizationCodeForTokenSetInput) => {
      if (this.codeConsumed) return { status: "INVALID" as const };
      this.codeConsumed = true;
      const family = input.refreshTokenFamily.family;
      this.refresh.set(input.refreshTokenFamily.initialToken.tokenHash, {
        context: {
          familyId: family.familyId,
          installationId: family.installationId,
          bindingId: family.bindingId,
          connectionId: family.connectionId,
          clientId: family.clientId,
          resource: family.resource,
          audience: family.audience,
          grantedScopes: [...family.grantedScopes],
          consumed: false,
          expiresAt: input.refreshTokenFamily.initialToken.expiresAt,
        },
        consumed: false,
      });
      this.saveAccess(input.accessToken);
      return {
        status: "ISSUED" as const,
        authorizationCode: { ...this.previewCode, consumedAt: input.grant.now },
        accessToken: input.accessToken,
        refreshToken: input.refreshTokenFamily.initialToken,
      };
    },
  );

  readonly peekMcpRefreshTokenContext = vi.fn(async (input: PeekMcpRefreshTokenContextInput) => {
    const stored = this.refresh.get(input.tokenHash)?.context;
    if (
      !stored ||
      stored.clientId !== input.clientId ||
      stored.resource !== input.expectedResource ||
      stored.audience !== input.expectedAudience
    ) return undefined;
    return stored;
  });

  readonly rotateMcpRefreshTokenAndIssueAccessToken = vi.fn(
    async (input: RotateMcpRefreshTokenAndIssueAccessTokenInput) => {
      const current = this.refresh.get(input.rotation.currentTokenHash);
      if (!current) return { status: "INVALID" as const };
      if (current.context.expiresAt <= input.rotation.issuedAt) {
        for (const [hash, token] of this.access) {
          if (token.refreshFamilyId === current.context.familyId) this.access.delete(hash);
        }
        for (const [hash, token] of this.refresh) {
          if (token.context.familyId === current.context.familyId) this.refresh.delete(hash);
        }
        return { status: "INVALID" as const };
      }
      const parentRetry = [...this.refresh.entries()].find(([, candidate]) =>
        candidate.consumedAt &&
        candidate.consumedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
          input.rotation.issuedAt.getTime() &&
        candidate.retry?.refreshTokenHash === input.rotation.currentTokenHash
      );
      if (parentRetry) {
        const [sourceTokenHash, parent] = parentRetry;
        const requestedScopes = input.rotation.requestedScopes ?? current.context.grantedScopes;
        const retryScopes = parent.retry?.grantedScopes ?? [];
        const sameScopes = requestedScopes.length === retryScopes.length &&
          requestedScopes.every((scope) => retryScopes.includes(scope));
        if (parent.retry && parent.retry.expiresAt > input.rotation.issuedAt && sameScopes) {
          return {
            status: "COALESCED" as const,
            sourceTokenHash,
            accessTokenHash: parent.retry.accessTokenHash,
            refreshTokenHash: input.rotation.currentTokenHash,
            responseCiphertext: parent.retry.responseCiphertext,
            grantedScopes: [...parent.retry.grantedScopes],
          };
        }
        return { status: "INVALID" as const };
      }
      if (current.consumed) {
        const requestedScopes = input.rotation.requestedScopes ?? current.context.grantedScopes;
        const retryScopes = current.retry?.grantedScopes ?? [];
        const sameScopes = requestedScopes.length === retryScopes.length &&
          requestedScopes.every((scope) => retryScopes.includes(scope));
        if (current.retry && current.retry.expiresAt > input.rotation.issuedAt && sameScopes) {
          return {
            status: "COALESCED" as const,
            sourceTokenHash: input.rotation.currentTokenHash,
            accessTokenHash: current.retry.accessTokenHash,
            refreshTokenHash: current.retry.refreshTokenHash,
            responseCiphertext: current.retry.responseCiphertext,
            grantedScopes: [...current.retry.grantedScopes],
          };
        }
        if (
          current.consumedAt &&
          current.consumedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
            input.rotation.issuedAt.getTime()
        ) return { status: "INVALID" as const };
        for (const [hash, token] of this.access) {
          if (token.refreshFamilyId === current.context.familyId) this.access.delete(hash);
        }
        return { status: "REPLAY_DETECTED" as const, familyId: current.context.familyId };
      }
      current.consumed = true;
      current.consumedAt = input.rotation.issuedAt;
      current.context.consumed = true;
      const grantedScopes = [...(input.rotation.requestedScopes ?? current.context.grantedScopes)];
      current.retry = {
        accessTokenHash: input.accessToken.tokenHash,
        refreshTokenHash: input.rotation.newTokenHash,
        responseCiphertext: input.retryResponseCiphertext,
        expiresAt: input.retryExpiresAt,
        grantedScopes,
      };
      this.refresh.set(input.rotation.newTokenHash, {
        context: {
          ...current.context,
          consumed: false,
          expiresAt: input.rotation.expiresAt,
        },
        consumed: false,
      });
      this.saveAccess(input.accessToken);
      return {
        status: "ROTATED" as const,
        familyId: current.context.familyId,
        refreshToken: {
          tokenHash: input.rotation.newTokenHash,
          tokenId: input.rotation.newTokenId,
          familyId: current.context.familyId,
          parentTokenHash: input.rotation.currentTokenHash,
          issuedAt: input.rotation.issuedAt,
          expiresAt: input.rotation.expiresAt,
        },
        accessToken: input.accessToken,
        installationId: current.context.installationId,
        bindingId: current.context.bindingId,
        connectionId: current.context.connectionId,
        grantedScopes,
      };
    },
  );

  readonly resolveMcpAccessToken = vi.fn(async (input: { tokenHash: string }) =>
    this.access.get(input.tokenHash)?.resolved,
  );

  readonly revokeOAuthTokenForClient = vi.fn(async (input: RevokeOAuthTokenForClientInput) => {
    let revoked = false;
    const access = this.access.get(input.tokenHash);
    if (access?.resolved.clientId === input.clientId) {
      this.access.delete(input.tokenHash);
      revoked = true;
    }
    const refresh = this.refresh.get(input.tokenHash);
    if (refresh?.context.clientId === input.clientId) {
      for (const [hash, token] of this.access) {
        if (token.refreshFamilyId === refresh.context.familyId) this.access.delete(hash);
      }
      for (const [hash, token] of this.refresh) {
        if (token.context.familyId === refresh.context.familyId) this.refresh.delete(hash);
      }
      revoked = true;
    }
    void revoked;
    return { status: "ACCEPTED" as const };
  });

  private saveAccess(token: McpAccessToken): void {
    this.access.set(token.tokenHash, {
      refreshFamilyId: token.refreshFamilyId ?? "",
      resolved: {
        tokenId: token.tokenId,
        clientId: token.clientId,
        resource: token.resource,
        audience: token.audience,
        grantedScopes: [...token.grantedScopes],
        issuedAt: token.issuedAt,
        expiresAt: token.expiresAt,
        installationId: token.installationId,
        bindingId: token.bindingId,
        connectionId: token.connectionId,
        authorizationId: "provider-authorization-1",
        workspaceId: "workspace-1",
        subjectType: "USER",
        subjectId: "user-1",
        agentId: "accounting-agent-1",
        policyId: "draft-only-policy",
        tenantId: "xero-tenant-1",
      },
    });
  }
}

function createSubject(options: {
  repository?: FakeTokenRepository;
  config?: EnabledMcpOAuthBrokerConfig;
  clock?: () => Date;
} = {}) {
  const repository = options.repository ?? new FakeTokenRepository();
  const secrets = [accessOne, refreshOne, accessTwo, refreshTwo, accessThree, refreshThree];
  let sequence = 0;
  const service = new McpOAuthTokenService({
    config: options.config ?? config,
    repository,
    cipher: retryCipher,
    clock: options.clock ?? (() => now),
    secretFactory: () => secrets.shift() ?? `Z${String(sequence++).padStart(42, "0")}`,
    idFactory: (purpose) => `${purpose}-id-${sequence++}`,
  });
  return { service, repository };
}

async function issueInitialTokens(service: McpOAuthTokenService) {
  return service.exchangeAuthorizationCode(
    clientId,
    rawCode,
    verifier,
    exactRedirect,
    new URL(canonicalResource),
  );
}

describe("McpOAuthTokenService", () => {
  it("atomically exchanges a bound S256 authorization code for opaque hashed tokens", async () => {
    const { service, repository } = createSubject();

    await expect(issueInitialTokens(service)).resolves.toEqual({
      access_token: accessOne,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: refreshOne,
      refresh_token_expires_in: 2_592_000,
      scope: "xero.read xero.draft.write",
    });

    expect(repository.peekOAuthAuthorizationCodeForExchange).toHaveBeenCalledWith({
      codeHash: keyedOAuthSecretHash(config.tokenHashKey, "authorization_code", rawCode),
      clientId,
      redirectUri: exactRedirect,
      pkceCodeChallenge: pkceS256Challenge(verifier),
      expectedResource: canonicalResource,
      now,
    });
    const composite = repository.exchangeOAuthAuthorizationCodeForTokenSet.mock.calls[0]?.[0];
    expect(composite).toBeDefined();
    expect(composite?.grant).toEqual({
      codeHash: keyedOAuthSecretHash(config.tokenHashKey, "authorization_code", rawCode),
      clientId,
      redirectUri: exactRedirect,
      pkceCodeChallenge: pkceS256Challenge(verifier),
      expectedResource: canonicalResource,
      now,
    });
    expect(composite?.accessToken).toMatchObject({
      tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "access_token", accessOne),
      installationId: "installation-1",
      bindingId: "binding-1",
      connectionId: "connection-1",
      clientId,
      resource: canonicalResource,
      audience: canonicalResource,
      grantedScopes: ["xero.read", "xero.draft.write"],
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 900_000),
    });
    expect(composite?.refreshTokenFamily.initialToken).toMatchObject({
      tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", refreshOne),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 2_592_000_000),
    });
    const persistedInput = JSON.stringify(composite);
    for (const raw of [rawCode, verifier, accessOne, refreshOne]) {
      expect(persistedInput).not.toContain(raw);
    }
    expect(composite?.accessToken.tokenHash).not.toBe(
      composite?.refreshTokenFamily.initialToken.tokenHash,
    );
  });

  it("canonicalizes an omitted resource only for the explicitly compatible Agent2 client", async () => {
    const { service, repository } = createSubject();

    const initial = await service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      undefined,
    );
    expect(repository.peekOAuthAuthorizationCodeForExchange).toHaveBeenCalledWith(
      expect.objectContaining({ expectedResource: canonicalResource }),
    );
    expect(repository.exchangeOAuthAuthorizationCodeForTokenSet).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: expect.objectContaining({
          clientId,
          resource: canonicalResource,
          audience: canonicalResource,
        }),
        refreshTokenFamily: expect.objectContaining({
          family: expect.objectContaining({
            clientId,
            resource: canonicalResource,
            audience: canonicalResource,
          }),
        }),
      }),
    );

    await expect(service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      undefined,
    )).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "xero.read xero.draft.write",
    });
    expect(repository.peekMcpRefreshTokenContext).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId,
        expectedResource: canonicalResource,
        expectedAudience: canonicalResource,
      }),
    );
  });

  it("keeps omitted-resource compatibility disabled outside the explicit Personal POC profile", async () => {
    const nonPocConfig: EnabledMcpOAuthBrokerConfig = {
      ...config,
      personalPocOnly: false,
    };
    const { service } = createSubject({ config: nonPocConfig });

    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      undefined,
    )).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("keeps omitted-resource compatibility disabled unless exactly one canonical resource is configured", async () => {
    for (const protectedResourceUris of [
      [canonicalResource, "https://xero-mcp.example.test/other"],
      [canonicalResource, canonicalResource],
      ["https://xero-mcp.example.test/other"],
      [],
    ]) {
      const unsafeConfig: EnabledMcpOAuthBrokerConfig = {
        ...config,
        protectedResourceUris,
      };
      const { service } = createSubject({ config: unsafeConfig });

      await expect(service.exchangeAuthorizationCode(
        clientId,
        rawCode,
        verifier,
        exactRedirect,
        undefined,
      )).rejects.toBeInstanceOf(InvalidTargetError);
    }
  });

  it("returns one generic invalid_grant when an authorization code is replayed", async () => {
    const { service } = createSubject();
    await issueInitialTokens(service);

    await expect(issueInitialTokens(service)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects malformed or mismatched PKCE without issuing tokens", async () => {
    const { service, repository } = createSubject();

    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      "too-short",
      exactRedirect,
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      "x".repeat(43),
      exactRedirect,
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    expect(repository.exchangeOAuthAuthorizationCodeForTokenSet).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong redirect", clientId, `${exactRedirect}/other`, canonicalResource],
    ["wrong client", "other-client", exactRedirect, canonicalResource],
  ])("rejects a code bound to the %s without disclosing the mismatch", async (
    _label,
    attemptedClient,
    attemptedRedirect,
    attemptedResource,
  ) => {
    const { service } = createSubject();

    await expect(service.exchangeAuthorizationCode(
      attemptedClient,
      rawCode,
      verifier,
      attemptedRedirect,
      attemptedResource,
    )).rejects.toMatchObject({
      name: "InvalidGrantError",
      message: "The OAuth grant is invalid.",
    });
  });

  it("rejects a wrong authorization-code resource and keeps omitted-resource compatibility client-bound", async () => {
    const { service } = createSubject();

    await expect(service.exchangeAuthorizationCode(
      "strict-host",
      rawCode,
      verifier,
      "https://strict-host.example.test/oauth/callback",
      undefined,
    )).rejects.toBeInstanceOf(InvalidTargetError);
    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      "https://xero-mcp.example.test/other",
    )).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("does not consume a compatible client's authorization code after a wrong explicit resource", async () => {
    const { service, repository } = createSubject();

    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      "https://xero-mcp.example.test/other",
    )).rejects.toBeInstanceOf(InvalidTargetError);
    expect(repository.peekOAuthAuthorizationCodeForExchange).not.toHaveBeenCalled();
    expect(repository.exchangeOAuthAuthorizationCodeForTokenSet).not.toHaveBeenCalled();

    await expect(service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      undefined,
    )).resolves.toMatchObject({
      access_token: accessOne,
      refresh_token: refreshOne,
    });
  });

  it("rejects a code record whose lifetime exceeds five minutes", async () => {
    const repository = new FakeTokenRepository();
    repository.previewCode = {
      ...authorizationCode(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_001),
    };
    const { service } = createSubject({ repository });

    await expect(issueInitialTokens(service)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("coalesces concurrent refresh retries to the exact rotated token response", async () => {
    const { service, repository } = createSubject();
    const initial = await issueInitialTokens(service);

    await expect(service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    )).resolves.toEqual({
      access_token: accessTwo,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: refreshTwo,
      refresh_token_expires_in: 2_592_000,
      scope: "xero.read xero.draft.write",
    });
    expect(repository.peekMcpRefreshTokenContext).toHaveBeenCalledWith({
      tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", refreshOne),
      clientId,
      expectedResource: canonicalResource,
      expectedAudience: canonicalResource,
      now,
    });
    const rotation = repository.rotateMcpRefreshTokenAndIssueAccessToken.mock.calls[0]?.[0];
    expect(rotation?.rotation).toMatchObject({
      currentTokenHash: keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", refreshOne),
      expectedClientId: clientId,
      expectedResource: canonicalResource,
      expectedAudience: canonicalResource,
      newTokenHash: keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", refreshTwo),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 2_592_000_000),
    });
    expect(rotation?.accessToken.tokenHash).toBe(
      keyedOAuthSecretHash(config.tokenHashKey, "access_token", accessTwo),
    );

    const expectedCoalesced = {
      access_token: accessTwo,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: refreshTwo,
      refresh_token_expires_in: 2_592_000,
      scope: "xero.read xero.draft.write",
    };
    const concurrentRetries = await Promise.all(Array.from({ length: 50 }, () =>
      service.exchangeRefreshToken(clientId, refreshOne, undefined, canonicalResource),
    ));
    expect(concurrentRetries).toEqual(Array.from({ length: 50 }, () => expectedCoalesced));
    expect(repository.rotateMcpRefreshTokenAndIssueAccessToken).toHaveBeenCalledTimes(51);
    await expect(service.verifyAccessToken(accessTwo)).resolves.toBeDefined();
  });

  it("coalesces an immediate successor refresh instead of creating a stale token chain", async () => {
    const { service } = createSubject();
    const initial = await issueInitialTokens(service);
    const rotated = await service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    );

    await expect(service.exchangeRefreshToken(
      clientId,
      rotated.refresh_token ?? "",
      undefined,
      canonicalResource,
    )).resolves.toEqual(rotated);
    await expect(service.verifyAccessToken(rotated.access_token)).resolves.toBeDefined();
  });

  it("fails closed and revokes the family when a cached retry response is corrupt", async () => {
    const { service, repository } = createSubject();
    const initial = await issueInitialTokens(service);
    const rotated = await service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    );
    const sourceHash = keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", refreshOne);
    const source = repository.refresh.get(sourceHash);
    if (!source?.retry) throw new Error("expected a stored refresh retry response");
    source.retry.responseCiphertext = "corrupt-ciphertext";

    await expect(service.exchangeRefreshToken(
      clientId,
      refreshOne,
      undefined,
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(service.verifyAccessToken(rotated.access_token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a mixed-scope concurrent retry without revoking the valid successor", async () => {
    const { service } = createSubject();
    const initial = await issueInitialTokens(service);
    const rotated = await service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    );

    await expect(service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      ["xero.read"],
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(service.verifyAccessToken(rotated.access_token)).resolves.toBeDefined();
  });

  it("treats the MCP refresh lifetime as a rolling idle window", async () => {
    let currentTime = now;
    const { service, repository } = createSubject({ clock: () => currentTime });
    const initial = await issueInitialTokens(service);

    currentTime = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1_000);
    const firstRotation = await service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    );
    const firstInput = repository.rotateMcpRefreshTokenAndIssueAccessToken.mock.calls[0]?.[0];
    expect(firstInput?.rotation.expiresAt).toEqual(
      new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1_000),
    );

    currentTime = new Date(now.getTime() + 59 * 24 * 60 * 60 * 1_000 - 1);
    await expect(service.exchangeRefreshToken(
      clientId,
      firstRotation.refresh_token ?? "",
      undefined,
      canonicalResource,
    )).resolves.toMatchObject({
      access_token: accessThree,
      refresh_token: refreshThree,
      refresh_token_expires_in: 2_592_000,
    });
  });

  it("routes an expired current refresh token through atomic cleanup before returning invalid_grant", async () => {
    const { service, repository } = createSubject();
    const initial = await issueInitialTokens(service);
    const refreshHash = keyedOAuthSecretHash(
      config.tokenHashKey,
      "refresh_token",
      initial.refresh_token ?? "",
    );
    const stored = repository.refresh.get(refreshHash);
    if (!stored) throw new Error("expected the initial refresh token to be stored");
    stored.context.expiresAt = new Date(now.getTime() - 1);

    await expect(service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);

    expect(repository.rotateMcpRefreshTokenAndIssueAccessToken).toHaveBeenCalledTimes(1);
    await expect(service.verifyAccessToken(initial.access_token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("preserves refresh replay family revocation when the compatible client omits resource", async () => {
    let currentTime = now;
    const { service } = createSubject({ clock: () => currentTime });
    const initial = await service.exchangeAuthorizationCode(
      clientId,
      rawCode,
      verifier,
      exactRedirect,
      undefined,
    );
    const rotated = await service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      undefined,
    );
    await expect(service.verifyAccessToken(rotated.access_token)).resolves.toBeDefined();

    currentTime = new Date(now.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS + 1);

    await expect(service.exchangeRefreshToken(
      clientId,
      initial.refresh_token ?? "",
      undefined,
      undefined,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(service.verifyAccessToken(initial.access_token))
      .rejects.toBeInstanceOf(InvalidTokenError);
    await expect(service.verifyAccessToken(rotated.access_token))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("returns the actual narrowed scope on refresh", async () => {
    const { service, repository } = createSubject();
    await issueInitialTokens(service);

    const refreshed = await service.exchangeRefreshToken(
      clientId,
      refreshOne,
      ["xero.read"],
      canonicalResource,
    );
    expect(refreshed.scope).toBe("xero.read");
    expect(repository.rotateMcpRefreshTokenAndIssueAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        rotation: expect.objectContaining({ requestedScopes: ["xero.read"] }),
        accessToken: expect.objectContaining({ grantedScopes: ["xero.read"] }),
      }),
    );
  });

  it("rejects refresh scope expansion and unknown scopes before rotation", async () => {
    const repository = new FakeTokenRepository();
    repository.previewCode = authorizationCode(["xero.read"]);
    const { service } = createSubject({ repository });
    await issueInitialTokens(service);

    await expect(service.exchangeRefreshToken(
      clientId,
      refreshOne,
      ["xero.read", "xero.draft.write"],
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidScopeError);
    await expect(service.exchangeRefreshToken(
      clientId,
      refreshOne,
      ["xero.admin"],
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidScopeError);
    expect(repository.rotateMcpRefreshTokenAndIssueAccessToken).not.toHaveBeenCalled();
  });

  it("uses invalid_grant for refresh client mismatch and invalid_target for resource mismatch", async () => {
    const { service } = createSubject();
    await issueInitialTokens(service);

    await expect(service.exchangeRefreshToken(
      "other-client",
      refreshOne,
      undefined,
      canonicalResource,
    )).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(service.exchangeRefreshToken(
      clientId,
      refreshOne,
      undefined,
      "https://xero-mcp.example.test/other",
    )).rejects.toBeInstanceOf(InvalidTargetError);
    await expect(service.exchangeRefreshToken(
      "strict-host",
      refreshOne,
      undefined,
      undefined,
    )).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("verifies access tokens into binding-only server claims", async () => {
    const { service, repository } = createSubject();
    await issueInitialTokens(service);

    const authInfo = await service.verifyAccessToken(accessOne);
    expect(authInfo).toEqual({
      token: accessOne,
      clientId,
      scopes: ["xero.read", "xero.draft.write"],
      expiresAt: Math.floor((now.getTime() + 900_000) / 1_000),
      resource: new URL(canonicalResource),
      extra: {
        credentialId: sha256("access_token-id-1"),
        installationId: "installation-1",
        bindingId: "binding-1",
        connectionId: "connection-1",
        authorizationId: "provider-authorization-1",
        workspaceId: "workspace-1",
        subjectType: "USER",
        subjectId: "user-1",
        agentId: "accounting-agent-1",
        policyId: "draft-only-policy",
        tenantId: "xero-tenant-1",
      },
    });
    expect(repository.resolveMcpAccessToken).toHaveBeenCalledWith({
      tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "access_token", accessOne),
      expectedResource: canonicalResource,
      expectedAudience: canonicalResource,
      now,
    });
    expect(JSON.stringify(authInfo.extra)).not.toContain(accessOne);
    expect(JSON.stringify(authInfo.extra)).not.toMatch(/token|hash/i);

    await expect(service.verifyAccessToken("unknown-access-token"))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("performs client-bound access and refresh revocation while unknown tokens stay silent", async () => {
    const { service, repository } = createSubject();
    await issueInitialTokens(service);

    await expect(service.revokeTokenForClient(accessOne, "other-client")).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(accessOne)).resolves.toBeDefined();
    await expect(service.revokeTokenForClient(accessOne, clientId)).resolves.toBeUndefined();
    await expect(service.verifyAccessToken(accessOne)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(service.revokeTokenForClient("unknown-token", clientId)).resolves.toBeUndefined();

    expect(repository.revokeOAuthTokenForClient).toHaveBeenNthCalledWith(
      repository.revokeOAuthTokenForClient.mock.calls.length - 1,
      {
        tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "access_token", "unknown-token"),
        clientId,
        revokedAt: now,
      },
    );
    expect(repository.revokeOAuthTokenForClient).toHaveBeenLastCalledWith({
      tokenHash: keyedOAuthSecretHash(config.tokenHashKey, "refresh_token", "unknown-token"),
      clientId,
      revokedAt: now,
    });
    expect(JSON.stringify(repository.revokeOAuthTokenForClient.mock.calls)).not.toContain(accessOne);

    const refreshSubject = createSubject();
    await issueInitialTokens(refreshSubject.service);
    await refreshSubject.service.revokeTokenForClient(refreshOne, clientId);
    await expect(refreshSubject.service.verifyAccessToken(accessOne))
      .rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("caps access and refresh TTLs even for an unsafe hand-built config", async () => {
    const unsafeConfig: EnabledMcpOAuthBrokerConfig = {
      ...config,
      accessTokenTtlSeconds: 5_000,
      refreshTokenTtlSeconds: 99_999_999,
    };
    const { service, repository } = createSubject({ config: unsafeConfig });

    const response = await issueInitialTokens(service);
    const composite = repository.exchangeOAuthAuthorizationCodeForTokenSet.mock.calls[0]?.[0];
    expect(response.expires_in).toBe(900);
    expect(response.refresh_token_expires_in).toBe(2_592_000);
    expect(composite?.accessToken.expiresAt).toEqual(new Date(now.getTime() + 900_000));
    expect(composite?.refreshTokenFamily.initialToken.expiresAt).toEqual(
      new Date(now.getTime() + 2_592_000_000),
    );
  });
});
