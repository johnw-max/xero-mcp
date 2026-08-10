import { randomUUID } from "node:crypto";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthBrokerConfig } from "../config.js";
import type {
  ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ExchangeOAuthAuthorizationCodeForTokenSetResult,
  McpAccessToken,
  McpRefreshTokenContextPreview,
  OAuthAuthorizationCodeExchangePreview,
  PeekMcpRefreshTokenContextInput,
  PeekOAuthAuthorizationCodeForExchangeInput,
  RevokeOAuthTokenForClientInput,
  RevokeOAuthTokenForClientResult,
  ResolvedMcpAccessToken,
  ResolveMcpAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenResult,
} from "../domain/models.js";
import { MCP_OAUTH_REFRESH_RETRY_GRACE_MS } from "../domain/models.js";
import { sha256 } from "../security/hash.js";
import {
  generateOAuthSecret,
  isValidPkceVerifier,
  keyedOAuthSecretHash,
  pkceS256Challenge,
} from "../security/oauthSecrets.js";
import { resolveBrokerOAuthResource } from "./brokerResource.js";
import type { TokenCipher } from "../security/tokenCipher.js";

export type EnabledMcpOAuthBrokerConfig = Extract<McpOAuthBrokerConfig, { enabled: true }>;
export type McpOAuthTokens = OAuthTokens & { refresh_token_expires_in: number };

/** Minimal storage boundary. Every secret crossing it is a domain-separated keyed hash. */
export interface McpOAuthTokenRepositoryDependency {
  peekOAuthAuthorizationCodeForExchange(
    input: PeekOAuthAuthorizationCodeForExchangeInput,
  ): Promise<OAuthAuthorizationCodeExchangePreview | undefined>;
  exchangeOAuthAuthorizationCodeForTokenSet(
    input: ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ): Promise<ExchangeOAuthAuthorizationCodeForTokenSetResult>;
  peekMcpRefreshTokenContext(
    input: PeekMcpRefreshTokenContextInput,
  ): Promise<McpRefreshTokenContextPreview | undefined>;
  rotateMcpRefreshTokenAndIssueAccessToken(
    input: RotateMcpRefreshTokenAndIssueAccessTokenInput,
  ): Promise<RotateMcpRefreshTokenAndIssueAccessTokenResult>;
  resolveMcpAccessToken(input: ResolveMcpAccessTokenInput): Promise<ResolvedMcpAccessToken | undefined>;
  revokeOAuthTokenForClient(
    input: RevokeOAuthTokenForClientInput,
  ): Promise<RevokeOAuthTokenForClientResult>;
}

export type McpOAuthRawSecretPurpose = "access_token" | "refresh_token";
export type McpOAuthIdentifierPurpose = "access_token" | "refresh_token" | "refresh_family";

const AUTHORIZATION_CODE_MAX_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_MAX_TTL_SECONDS = 900;
const REFRESH_TOKEN_MAX_TTL_SECONDS = 2_592_000;
const INVALID_GRANT_MESSAGE = "The OAuth grant is invalid.";
const INVALID_SCOPE_MESSAGE = "The requested OAuth scope is invalid.";
const INVALID_TOKEN_MESSAGE = "The access token is invalid.";

function invalidGrant(): InvalidGrantError {
  return new InvalidGrantError(INVALID_GRANT_MESSAGE);
}

function invalidScope(): InvalidScopeError {
  return new InvalidScopeError(INVALID_SCOPE_MESSAGE);
}

function invalidToken(): InvalidTokenError {
  return new InvalidTokenError(INVALID_TOKEN_MESSAGE);
}

function hasExactSupportedScopes(
  scopes: readonly string[],
  supportedScopes: readonly string[],
): boolean {
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) return false;
  const supported = new Set(supportedScopes);
  return scopes.every((scope) => scope.length > 0 && scope === scope.trim() && supported.has(scope));
}

function isScopeSubset(candidate: readonly string[], allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return candidate.every((scope) => allowedSet.has(scope));
}

function generatedValue(value: string, description: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`The ${description} factory returned an invalid value.`);
  }
  return value;
}

export class McpOAuthTokenService {
  readonly #config: EnabledMcpOAuthBrokerConfig;
  readonly #repository: McpOAuthTokenRepositoryDependency;
  readonly #clock: () => Date;
  readonly #secretFactory: (purpose: McpOAuthRawSecretPurpose) => string;
  readonly #idFactory: (purpose: McpOAuthIdentifierPurpose) => string;
  readonly #cipher: TokenCipher;
  readonly #accessTokenTtlSeconds: number;
  readonly #refreshTokenTtlSeconds: number;

  constructor(options: {
    config: EnabledMcpOAuthBrokerConfig;
    repository: McpOAuthTokenRepositoryDependency;
    cipher: TokenCipher;
    clock?: () => Date;
    secretFactory?: (purpose: McpOAuthRawSecretPurpose) => string;
    idFactory?: (purpose: McpOAuthIdentifierPurpose) => string;
  }) {
    this.#config = options.config;
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#clock = options.clock ?? (() => new Date());
    this.#secretFactory = options.secretFactory ?? (() => generateOAuthSecret());
    this.#idFactory = options.idFactory ?? ((purpose) => `${purpose}_${randomUUID()}`);
    this.#accessTokenTtlSeconds = Math.min(
      ACCESS_TOKEN_MAX_TTL_SECONDS,
      options.config.accessTokenTtlSeconds,
    );
    this.#refreshTokenTtlSeconds = Math.min(
      REFRESH_TOKEN_MAX_TTL_SECONDS,
      options.config.refreshTokenTtlSeconds,
    );
    if (this.#accessTokenTtlSeconds < 1 || this.#refreshTokenTtlSeconds < 1) {
      throw new Error("OAuth token TTL configuration must be positive.");
    }
  }

  async exchangeAuthorizationCode(
    clientId: string,
    rawCode: string,
    verifier: string | undefined,
    exactRedirect: string | undefined,
    resource: URL | string | undefined,
  ): Promise<McpOAuthTokens> {
    const canonicalResource = resolveBrokerOAuthResource(this.#config, clientId, resource);
    if (
      !verifier ||
      !isValidPkceVerifier(verifier) ||
      !exactRedirect ||
      !this.#isConfiguredClientRedirect(clientId, exactRedirect)
    ) {
      throw invalidGrant();
    }

    const now = this.#now();
    const codeHash = keyedOAuthSecretHash(
      this.#config.tokenHashKey,
      "authorization_code",
      rawCode,
    );
    const challenge = pkceS256Challenge(verifier);
    const preview = await this.#repository.peekOAuthAuthorizationCodeForExchange({
      codeHash,
      clientId,
      redirectUri: exactRedirect,
      pkceCodeChallenge: challenge,
      expectedResource: canonicalResource,
      now,
    });
    if (!this.#isValidCodePreview(preview, { codeHash, clientId, now })) {
      throw invalidGrant();
    }

    const code = preview;
    const issued = this.#newRawTokenPair(rawCode);
    const familyId = this.#newId("refresh_family");
    const accessTokenId = this.#newId("access_token");
    const refreshTokenId = this.#newId("refresh_token");
    if (new Set([familyId, accessTokenId, refreshTokenId]).size !== 3) {
      throw new Error("OAuth identifier factories must return independent values.");
    }
    const accessExpiresAt = new Date(now.getTime() + this.#accessTokenTtlSeconds * 1_000);
    const refreshExpiresAt = new Date(now.getTime() + this.#refreshTokenTtlSeconds * 1_000);
    const grantedScopes = [...code.grantedScopes];
    const accessToken = this.#accessToken({
      rawToken: issued.accessToken,
      tokenId: accessTokenId,
      installationId: code.installationId,
      bindingId: code.bindingId,
      connectionId: code.connectionId,
      refreshFamilyId: familyId,
      clientId: code.clientId,
      resource: code.resource,
      audience: code.audience,
      grantedScopes,
      issuedAt: now,
      expiresAt: accessExpiresAt,
    });

    const result = await this.#repository.exchangeOAuthAuthorizationCodeForTokenSet({
      grant: {
        codeHash,
        clientId,
        redirectUri: exactRedirect,
        pkceCodeChallenge: challenge,
        expectedResource: canonicalResource,
        now,
      },
      accessToken,
      refreshTokenFamily: {
        family: {
          familyId,
          installationId: code.installationId,
          bindingId: code.bindingId,
          connectionId: code.connectionId,
          clientId: code.clientId,
          resource: code.resource,
          audience: code.audience,
          grantedScopes,
          status: "ACTIVE",
          createdAt: now,
          updatedAt: now,
        },
        initialToken: {
          tokenHash: keyedOAuthSecretHash(
            this.#config.tokenHashKey,
            "refresh_token",
            issued.refreshToken,
          ),
          tokenId: refreshTokenId,
          familyId,
          issuedAt: now,
          expiresAt: refreshExpiresAt,
        },
      },
    });
    if (result.status !== "ISSUED") throw invalidGrant();

    return {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: this.#accessTokenTtlSeconds,
      refresh_token: issued.refreshToken,
      refresh_token_expires_in: this.#refreshTokenTtlSeconds,
      scope: grantedScopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    clientId: string,
    rawRefresh: string,
    optionalScopes: string[] | undefined,
    resource: URL | string | undefined,
  ): Promise<McpOAuthTokens> {
    const canonicalResource = resolveBrokerOAuthResource(this.#config, clientId, resource);

    const now = this.#now();
    const currentTokenHash = keyedOAuthSecretHash(
      this.#config.tokenHashKey,
      "refresh_token",
      rawRefresh,
    );
    const preview = await this.#repository.peekMcpRefreshTokenContext({
      tokenHash: currentTokenHash,
      clientId,
      expectedResource: canonicalResource,
      expectedAudience: canonicalResource,
      now,
    });
    if (
      !preview ||
      preview.clientId !== clientId ||
      preview.resource !== this.#config.resourceUri ||
      preview.audience !== this.#config.resourceUri ||
      !hasExactSupportedScopes(preview.grantedScopes, this.#config.scopes)
    ) {
      throw invalidGrant();
    }

    let grantedScopes = [...preview.grantedScopes];
    if (optionalScopes) {
      const normalized = [...new Set(optionalScopes)];
      if (
        normalized.length === 0 ||
        !hasExactSupportedScopes(normalized, this.#config.scopes) ||
        !isScopeSubset(normalized, preview.grantedScopes)
      ) {
        throw invalidScope();
      }
      grantedScopes = normalized;
    }

    const issued = this.#newRawTokenPair(rawRefresh);
    const accessTokenId = this.#newId("access_token");
    const refreshTokenId = this.#newId("refresh_token");
    if (accessTokenId === refreshTokenId) {
      throw new Error("OAuth identifier factories must return independent values.");
    }
    const accessExpiresAt = new Date(now.getTime() + this.#accessTokenTtlSeconds * 1_000);
    const refreshExpiresAt = new Date(now.getTime() + this.#refreshTokenTtlSeconds * 1_000);
    const accessToken = this.#accessToken({
      rawToken: issued.accessToken,
      tokenId: accessTokenId,
      installationId: preview.installationId,
      bindingId: preview.bindingId,
      connectionId: preview.connectionId,
      refreshFamilyId: preview.familyId,
      clientId: preview.clientId,
      resource: preview.resource,
      audience: preview.audience,
      grantedScopes,
      issuedAt: now,
      expiresAt: accessExpiresAt,
    });
    const rotation = {
      currentTokenHash,
      expectedClientId: clientId,
      expectedResource: canonicalResource,
      expectedAudience: canonicalResource,
      ...(optionalScopes ? { requestedScopes: grantedScopes } : {}),
      newTokenHash: keyedOAuthSecretHash(
        this.#config.tokenHashKey,
        "refresh_token",
        issued.refreshToken,
      ),
      newTokenId: refreshTokenId,
      issuedAt: now,
      expiresAt: refreshExpiresAt,
    };
    const result = await this.#repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation,
      accessToken,
      retryResponseCiphertext: this.#cipher.encrypt(JSON.stringify({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: this.#accessTokenTtlSeconds,
        refresh_token: issued.refreshToken,
        refresh_token_expires_in: this.#refreshTokenTtlSeconds,
        scope: grantedScopes.join(" "),
      } satisfies McpOAuthTokens), this.#refreshRetryContext(currentTokenHash)),
      retryExpiresAt: new Date(now.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS),
    });
    if (result.status === "COALESCED") {
      const coalesced = await this.#readCoalescedRefreshResponse({
        result,
        currentTokenHash,
        clientId,
        now,
      });
      if (coalesced) return coalesced;
      throw invalidGrant();
    }
    if (result.status !== "ROTATED") throw invalidGrant();
    if (!hasExactSupportedScopes(result.grantedScopes, this.#config.scopes)) throw invalidGrant();

    return {
      access_token: issued.accessToken,
      token_type: "Bearer",
      expires_in: this.#accessTokenTtlSeconds,
      refresh_token: issued.refreshToken,
      refresh_token_expires_in: this.#refreshTokenTtlSeconds,
      scope: result.grantedScopes.join(" "),
    };
  }

  async verifyAccessToken(rawToken: string): Promise<AuthInfo> {
    const now = this.#now();
    const tokenHash = keyedOAuthSecretHash(this.#config.tokenHashKey, "access_token", rawToken);
    const resolved = await this.#repository.resolveMcpAccessToken({
      tokenHash,
      expectedResource: this.#config.resourceUri,
      expectedAudience: this.#config.resourceUri,
      now,
    });
    if (
      !resolved ||
      resolved.resource !== this.#config.resourceUri ||
      resolved.audience !== this.#config.resourceUri ||
      resolved.expiresAt <= now ||
      !Number.isSafeInteger(resolved.bindingRevision) ||
      resolved.bindingRevision < 1 ||
      !hasExactSupportedScopes(resolved.grantedScopes, this.#config.scopes)
    ) {
      throw invalidToken();
    }

    return {
      token: rawToken,
      clientId: resolved.clientId,
      scopes: [...resolved.grantedScopes],
      expiresAt: Math.floor(resolved.expiresAt.getTime() / 1_000),
      resource: new URL(resolved.resource),
      extra: {
        credentialId: sha256(resolved.tokenId),
        installationId: resolved.installationId,
        bindingId: resolved.bindingId,
        connectionId: resolved.connectionId,
        bindingRevision: resolved.bindingRevision,
        authorizationId: resolved.authorizationId,
        workspaceId: resolved.workspaceId,
        subjectType: resolved.subjectType,
        subjectId: resolved.subjectId,
        agentId: resolved.agentId,
        policyId: resolved.policyId,
        tenantId: resolved.tenantId,
      },
    };
  }

  async revokeTokenForClient(rawToken: string, clientId: string): Promise<void> {
    const revokedAt = this.#now();
    await this.#repository.revokeOAuthTokenForClient({
      tokenHash: keyedOAuthSecretHash(
        this.#config.tokenHashKey,
        "access_token",
        rawToken,
      ),
      clientId,
      revokedAt,
    });
    await this.#repository.revokeOAuthTokenForClient({
      tokenHash: keyedOAuthSecretHash(
        this.#config.tokenHashKey,
        "refresh_token",
        rawToken,
      ),
      clientId,
      revokedAt,
    });
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("OAuth token clock returned an invalid date.");
    return new Date(now);
  }

  #isConfiguredClientRedirect(clientId: string, redirectUri: string): boolean {
    const client = this.#config.hostClients.find((candidate) => candidate.clientId === clientId);
    return Boolean(client?.redirectUris.includes(redirectUri));
  }

  #isValidCodePreview(
    preview: OAuthAuthorizationCodeExchangePreview | undefined,
    expected: {
      codeHash: string;
      clientId: string;
      now: Date;
    },
  ): preview is OAuthAuthorizationCodeExchangePreview {
    return Boolean(
      preview &&
      preview.codeHash === expected.codeHash &&
      preview.clientId === expected.clientId &&
      preview.resource === this.#config.resourceUri &&
      preview.audience === this.#config.resourceUri &&
      preview.expiresAt > expected.now &&
      preview.expiresAt.getTime() - expected.now.getTime() <= AUTHORIZATION_CODE_MAX_TTL_MS &&
      hasExactSupportedScopes(preview.grantedScopes, this.#config.scopes) &&
      preview.installationId &&
      preview.bindingId &&
      preview.connectionId,
    );
  }

  #newRawTokenPair(previousRawSecret: string): { accessToken: string; refreshToken: string } {
    const accessToken = generatedValue(this.#secretFactory("access_token"), "access token secret");
    const refreshToken = generatedValue(this.#secretFactory("refresh_token"), "refresh token secret");
    if (
      accessToken === refreshToken ||
      accessToken === previousRawSecret ||
      refreshToken === previousRawSecret
    ) {
      throw new Error("OAuth token factories must return independent opaque values.");
    }
    return { accessToken, refreshToken };
  }

  #newId(purpose: McpOAuthIdentifierPurpose): string {
    return generatedValue(this.#idFactory(purpose), `${purpose} identifier`);
  }

  #refreshRetryContext(sourceTokenHash: string): string {
    return `mcp-oauth-refresh-retry:${sourceTokenHash}`;
  }

  async #readCoalescedRefreshResponse(input: {
    result: Extract<RotateMcpRefreshTokenAndIssueAccessTokenResult, { status: "COALESCED" }>;
    currentTokenHash: string;
    clientId: string;
    now: Date;
  }): Promise<McpOAuthTokens | undefined> {
    try {
      const parsed = JSON.parse(this.#cipher.decrypt(
        input.result.responseCiphertext,
        this.#refreshRetryContext(input.result.sourceTokenHash),
      )) as Partial<McpOAuthTokens>;
      const scopes = input.result.grantedScopes;
      if (
        (
          input.result.sourceTokenHash !== input.currentTokenHash &&
          input.result.refreshTokenHash !== input.currentTokenHash
        ) ||
        !hasExactSupportedScopes(scopes, this.#config.scopes) ||
        typeof parsed.access_token !== "string" ||
        typeof parsed.refresh_token !== "string" ||
        parsed.token_type !== "Bearer" ||
        parsed.expires_in !== this.#accessTokenTtlSeconds ||
        parsed.refresh_token_expires_in !== this.#refreshTokenTtlSeconds ||
        parsed.scope !== scopes.join(" ") ||
        keyedOAuthSecretHash(this.#config.tokenHashKey, "access_token", parsed.access_token) !== input.result.accessTokenHash ||
        keyedOAuthSecretHash(this.#config.tokenHashKey, "refresh_token", parsed.refresh_token) !== input.result.refreshTokenHash
      ) {
        throw new Error("invalid coalesced OAuth response");
      }
      return parsed as McpOAuthTokens;
    } catch {
      await this.#repository.revokeOAuthTokenForClient({
        tokenHash: input.currentTokenHash,
        clientId: input.clientId,
        revokedAt: input.now,
      });
      return undefined;
    }
  }

  #accessToken(input: {
    rawToken: string;
    tokenId: string;
    installationId: string;
    bindingId: string;
    connectionId: string;
    refreshFamilyId: string;
    clientId: string;
    resource: string;
    audience: string;
    grantedScopes: string[];
    issuedAt: Date;
    expiresAt: Date;
  }): McpAccessToken {
    return {
      tokenHash: keyedOAuthSecretHash(
        this.#config.tokenHashKey,
        "access_token",
        input.rawToken,
      ),
      tokenId: input.tokenId,
      installationId: input.installationId,
      bindingId: input.bindingId,
      connectionId: input.connectionId,
      refreshFamilyId: input.refreshFamilyId,
      clientId: input.clientId,
      resource: input.resource,
      audience: input.audience,
      grantedScopes: [...input.grantedScopes],
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
  }
}
