import { XeroClient, type TokenSet, type TokenSetParameters } from "xero-node";
import type { AppConfig } from "../config.js";
import type { AccountingRepository } from "../db/repository.js";
import type {
  AuthorizedProviderConnection,
  ProviderAuthorization,
  ProviderConnection,
} from "../domain/models.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
import {
  requireOAuthBoundRequestContext,
  type OAuthBoundRequestContext,
} from "../security/requestContext.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { AccountingPrincipal } from "./types.js";
import {
  BROKER_MCP_SCOPES,
  describeLegacyXeroScopePolicyProblems,
  leastPrivilegeXeroScopesForLegacy,
  missingBrokerXeroScopeCapabilities,
  type BrokerMcpScope,
} from "./xeroScopes.js";

interface StoredTokenSet extends TokenSetParameters {
  access_token: string;
}

export interface LegacyResolvedXeroConnection {
  mode: "LEGACY";
  connection: ProviderConnection;
}

export interface OAuthResolvedXeroConnection {
  mode: "OAUTH";
  connection: AuthorizedProviderConnection;
  authorization: ProviderAuthorization;
  context: OAuthBoundRequestContext;
}

export type ResolvedXeroConnection =
  | LegacyResolvedXeroConnection
  | OAuthResolvedXeroConnection;

export type XeroActionConnection = ProviderConnection | AuthorizedProviderConnection;

type ClientAction<T> = (client: XeroClient, connection: XeroActionConnection) => Promise<T>;
type AccessTokenAction<T> = (accessToken: string, connection: XeroActionConnection) => Promise<T>;

class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

function tokenSetParameters(tokenSet: TokenSet): StoredTokenSet {
  if (!tokenSet.access_token) {
    throw new AppError("PROVIDER_ERROR", "Xero returned a token set without an access token.", {
      httpStatus: 502,
    });
  }
  const stored: StoredTokenSet = { access_token: tokenSet.access_token };
  if (tokenSet.refresh_token) stored.refresh_token = tokenSet.refresh_token;
  if (tokenSet.id_token) stored.id_token = tokenSet.id_token;
  if (tokenSet.token_type) stored.token_type = tokenSet.token_type;
  if (tokenSet.scope) stored.scope = tokenSet.scope;
  if (tokenSet.expires_at) stored.expires_at = tokenSet.expires_at;
  if (tokenSet.session_state) stored.session_state = tokenSet.session_state;
  return stored;
}

function expiresAt(tokenSet: StoredTokenSet): Date {
  if (tokenSet.expires_at) return new Date(tokenSet.expires_at * 1_000);
  return new Date(Date.now() + 25 * 60_000);
}

function requestedBrokerScopes(context: OAuthBoundRequestContext): BrokerMcpScope[] {
  return BROKER_MCP_SCOPES.filter((scope) => context.scopes.includes(scope));
}

function actorId(principal: AccountingPrincipal): string {
  return typeof principal === "string" ? principal : principal.actorId;
}

export class XeroClientManager {
  readonly #repository: AccountingRepository;
  readonly #cipher: TokenCipher;
  readonly #config: AppConfig["xero"];
  readonly #logger: Logger;
  readonly #legacyWriteEnabled: boolean;
  readonly #refreshMutex = new KeyedMutex();

  constructor(options: {
    repository: AccountingRepository;
    cipher: TokenCipher;
    config: AppConfig["xero"];
    logger: Logger;
    legacyWriteEnabled?: boolean;
  }) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#legacyWriteEnabled = options.legacyWriteEnabled ?? true;
  }

  async resolveSingleConnection(actorId: string): Promise<ProviderConnection> {
    const connections = await this.#repository.listActiveConnections(actorId);
    if (connections.length === 0) {
      throw new AppError("NOT_CONNECTED", "No active Xero organisation is connected.", { httpStatus: 409 });
    }
    if (connections.length !== 1) {
      throw new AppError("AMBIGUOUS_CONNECTION", "The demo requires exactly one active Xero organisation.", {
        httpStatus: 409,
      });
    }
    const connection = connections[0] as ProviderConnection;
    const scopeProblems = describeLegacyXeroScopePolicyProblems(
      connection.grantedScopes,
      this.#legacyWriteEnabled,
    );
    if (scopeProblems.length > 0) {
      throw new AppError(
        "NOT_CONNECTED",
        `The Xero connection violates the active least-privilege policy: ${scopeProblems.join(", ")}. Re-authorisation is required.`,
        { httpStatus: 409 },
      );
    }
    return connection;
  }

  /**
   * Resolves the server-selected Xero connection. A non-legacy request must
   * match the full installation/binding/subject/agent/connection tuple; no
   * tenant or connection is selected from a tool argument.
   */
  async resolveConnection(principal: AccountingPrincipal): Promise<ResolvedXeroConnection> {
    if (typeof principal === "string" || principal.legacyDemo) {
      return {
        mode: "LEGACY",
        connection: await this.resolveSingleConnection(actorId(principal)),
      };
    }

    const context = requireOAuthBoundRequestContext(principal);
    const binding = await this.#repository.resolveAgentConnectionBinding({
      installationId: context.oauthInstallationId,
      bindingId: context.bindingId,
      workspaceId: context.workspaceId,
      subjectType: context.subjectType,
      subjectId: context.subjectId,
      agentId: context.agentId,
      connectionId: context.connectionId,
    });
    if (!binding) {
      throw new AppError("FORBIDDEN", "The OAuth token is not bound to an active Xero organisation.", {
        httpStatus: 403,
      });
    }

    const authorization = await this.#repository.getProviderAuthorization(
      binding.authorizationId,
      context.workspaceId,
      context.subjectId,
    );
    if (!authorization || authorization.status !== "ACTIVE") {
      throw new AppError("FORBIDDEN", "The bound Xero authorization is not active for this subject.", {
        httpStatus: 403,
      });
    }

    const connections = await this.#repository.listActiveConnectionsByAuthorization(
      authorization.authorizationId,
      context.workspaceId,
    );
    const exactConnections = connections.filter((connection) =>
      connection.connectionId === context.connectionId &&
      connection.connectionId === binding.connectionId &&
      connection.authorizationId === authorization.authorizationId &&
      connection.tenantId === binding.tenantId,
    );
    if (exactConnections.length !== 1) {
      throw new AppError("FORBIDDEN", "The bound Xero organisation could not be resolved exactly.", {
        httpStatus: 403,
      });
    }

    const missingCapabilities = missingBrokerXeroScopeCapabilities(
      authorization.grantedScopes,
      requestedBrokerScopes(context),
    );
    if (missingCapabilities.length > 0) {
      throw new AppError(
        "NOT_CONNECTED",
        `The Xero authorization is missing required capabilities: ${missingCapabilities.map((item) => item.capability).join(", ")}. Re-authorisation is required.`,
        { httpStatus: 409 },
      );
    }

    return {
      mode: "OAUTH",
      connection: exactConnections[0] as AuthorizedProviderConnection,
      authorization,
      context,
    };
  }

  async withClient<T>(principal: AccountingPrincipal, action: ClientAction<T>): Promise<T> {
    const initial = await this.resolveConnection(principal);
    const mutexKey = initial.mode === "OAUTH"
      ? initial.authorization.authorizationId
      : initial.connection.connectionId;

    return this.#refreshMutex.run(mutexKey, async () => {
      let resolved = await this.resolveConnection(principal);
      let client = await this.#createClient(resolved);

      if (this.#tokenExpiresAt(resolved).getTime() <= Date.now() + 60_000) {
        try {
          const refreshed = await client.refreshToken();
          const parameters = tokenSetParameters(refreshed);

          if (resolved.mode === "OAUTH") {
            const authorization = resolved.authorization;
            const refreshedScopes = typeof parameters.scope === "string"
              ? parameters.scope.split(/\s+/).filter(Boolean)
              : authorization.grantedScopes;
            const ciphertext = this.#cipher.encrypt(
              JSON.stringify(parameters),
              authorization.authorizationId,
            );
            const saved = await this.#repository.updateProviderAuthorizationToken(
              authorization.authorizationId,
              authorization.workspaceId,
              authorization.refreshVersion,
              ciphertext,
              expiresAt(parameters),
              refreshedScopes,
            );

            if (saved) {
              resolved = { ...resolved, authorization: saved };
            } else {
              resolved = await this.resolveConnection(principal);
              client = await this.#createClient(resolved);
            }
          } else {
            const connection = resolved.connection;
            const refreshedScopes = typeof parameters.scope === "string"
              ? parameters.scope.split(/\s+/).filter(Boolean)
              : connection.grantedScopes;
            const scopeProblems = describeLegacyXeroScopePolicyProblems(
              refreshedScopes,
              this.#legacyWriteEnabled,
            );
            if (scopeProblems.length > 0) {
              throw new AppError(
                "NOT_CONNECTED",
                `The refreshed Xero token violates the active least-privilege policy: ${scopeProblems.join(", ")}. Re-authorisation is required.`,
                { httpStatus: 409 },
              );
            }
            const ciphertext = this.#cipher.encrypt(JSON.stringify(parameters), connection.connectionId);
            const saved = await this.#repository.updateConnectionToken(
              connection.connectionId,
              connection.refreshVersion,
              ciphertext,
              expiresAt(parameters),
            );

            if (saved) {
              resolved = { mode: "LEGACY", connection: saved };
            } else {
              resolved = await this.resolveConnection(principal);
              client = await this.#createClient(resolved);
            }
          }
        } catch (error) {
          if (resolved.mode === "OAUTH") {
            const recovered = await this.#recoverOAuthRefreshRace(resolved);
            if (recovered) {
              resolved = recovered;
              client = await this.#createClient(resolved);
            } else {
              await this.#repository.markProviderAuthorizationStatus(
                resolved.authorization.authorizationId,
                resolved.authorization.workspaceId,
                "TOKEN_REFRESH_FAILED",
                new Date(),
              );
              this.#throwRefreshFailure(actorId(principal), resolved.connection.tenantId, error);
            }
          } else {
            const connection = resolved.connection;
            const failedVersion = connection.refreshVersion;
            const markedFailed = await this.#repository.markConnectionStatusIfVersion(
              connection.connectionId,
              failedVersion,
              "TOKEN_REFRESH_FAILED",
            );
            if (!markedFailed) {
              const latest = await this.#repository.getConnectionByActorTenant(
                actorId(principal),
                connection.tenantId,
              );
              if (
                latest?.status === "ACTIVE" &&
                latest.refreshVersion !== failedVersion &&
                latest.tokenExpiresAt.getTime() > Date.now() + 60_000
              ) {
                resolved = { mode: "LEGACY", connection: latest };
                client = await this.#createClient(resolved);
                this.#logger.info("Xero token refresh race resolved with a newer active token.", {
                  actorId: actorId(principal),
                  tenantId: latest.tenantId,
                });
              } else {
                this.#throwRefreshFailure(actorId(principal), connection.tenantId, error);
              }
            } else {
              this.#throwRefreshFailure(actorId(principal), connection.tenantId, error);
            }
          }
        }
      }

      return action(client, resolved.connection);
    });
  }

  async withAccessToken<T>(principal: AccountingPrincipal, action: AccessTokenAction<T>): Promise<T> {
    return this.withClient(principal, async (client, connection) => {
      const accessToken = client.readTokenSet().access_token;
      if (!accessToken) {
        throw new AppError("NOT_CONNECTED", "The Xero connection has no usable access token.", { httpStatus: 409 });
      }
      return action(accessToken, connection);
    });
  }

  serializeTokenSet(tokenSet: TokenSet): { json: string; expiresAt: Date; scopes: string[] } {
    const parameters = tokenSetParameters(tokenSet);
    return {
      json: JSON.stringify(parameters),
      expiresAt: expiresAt(parameters),
      scopes: typeof parameters.scope === "string" ? parameters.scope.split(/\s+/).filter(Boolean) : [],
    };
  }

  createOAuthClient(state: string, scopes: readonly string[] = this.#config.scopes): XeroClient {
    return new XeroClient({
      clientId: this.#config.clientId,
      clientSecret: this.#config.clientSecret,
      redirectUris: [this.#config.redirectUri],
      scopes: [...scopes],
      state,
      httpTimeout: 10_000,
      clockTolerance: 10,
    });
  }

  async #createClient(resolved: ResolvedXeroConnection): Promise<XeroClient> {
    const client = this.createOAuthClient(
      "stored-connection",
      resolved.mode === "LEGACY"
        ? leastPrivilegeXeroScopesForLegacy(this.#config.scopes, this.#legacyWriteEnabled)
        : this.#config.scopes,
    );
    await client.initialize();
    const tokenOwner = resolved.mode === "OAUTH" ? resolved.authorization : resolved.connection;
    const aad = resolved.mode === "OAUTH"
      ? resolved.authorization.authorizationId
      : resolved.connection.connectionId;
    let parameters: StoredTokenSet;
    try {
      parameters = JSON.parse(this.#cipher.decrypt(tokenOwner.tokenCiphertext, aad)) as StoredTokenSet;
    } catch (error) {
      throw new AppError("CONFIGURATION_ERROR", "Stored Xero credentials are unreadable.", {
        httpStatus: 500,
        cause: error,
      });
    }
    client.setTokenSet(parameters);
    return client;
  }

  #tokenExpiresAt(resolved: ResolvedXeroConnection): Date {
    return resolved.mode === "OAUTH"
      ? resolved.authorization.tokenExpiresAt
      : resolved.connection.tokenExpiresAt;
  }

  async #recoverOAuthRefreshRace(
    failed: OAuthResolvedXeroConnection,
  ): Promise<OAuthResolvedXeroConnection | undefined> {
    const latest = await this.#repository.getProviderAuthorization(
      failed.authorization.authorizationId,
      failed.authorization.workspaceId,
      failed.context.subjectId,
    );
    if (
      latest?.status === "ACTIVE" &&
      latest.refreshVersion !== failed.authorization.refreshVersion &&
      latest.tokenExpiresAt.getTime() > Date.now() + 60_000
    ) {
      this.#logger.info("Xero OAuth authorization refresh race resolved with a newer active token.", {
        actorId: failed.context.actorId,
        tenantId: failed.connection.tenantId,
        authorizationId: latest.authorizationId,
      });
      return { ...failed, authorization: latest };
    }
    return undefined;
  }

  #throwRefreshFailure(actorId: string, tenantId: string, error: unknown): never {
    this.#logger.warn("Xero token refresh failed.", {
      actorId,
      tenantId,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    throw new AppError("NOT_CONNECTED", "The Xero connection must be re-authorised.", {
      httpStatus: 409,
      cause: error,
    });
  }
}
