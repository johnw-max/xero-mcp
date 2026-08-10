import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type {
  AuthorizedProviderConnection,
  ProviderAuthorization,
} from "../domain/models.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
import { safeXeroTenantShortCode } from "../providers/xeroDeepLinks.js";
import type { XeroClientManager } from "../providers/xeroClientManager.js";
import {
  BROKER_MCP_SCOPES,
  missingBrokerXeroScopeCapabilities,
  type BrokerMcpScope,
} from "../providers/xeroScopes.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import {
  xeroTenantsForAuthenticationEvent,
} from "./xeroAuthenticationEvent.js";

interface XeroTenant {
  /** Official Xero connection identifier returned by GET /connections. */
  id?: unknown;
  /** Compatibility alias used by some Xero SDK/test representations. */
  connectionId?: unknown;
  authEventId?: unknown;
  tenantId?: unknown;
  tenantName?: unknown;
  orgData?: {
    name?: unknown;
    shortCode?: unknown;
  };
}

/**
 * Safe observability boundary: stage names are fixed here. Exchange logs must
 * never add callback parameters, tokens, cookies, client credentials, or Xero
 * organisation identifiers.
 */
type BrokerXeroExchangeStage =
  | "CALLBACK_VALIDATION"
  | "TOKEN_EXCHANGE"
  | "TENANT_DISCOVERY"
  | "SCOPE_VALIDATION"
  | "CONNECTION_ASSEMBLY"
  | "AUTHORIZATION_ASSEMBLY"
  | "COMPLETE";

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const SAFE_ERROR_CLASSES = new Set([
  "AbortError",
  "AggregateError",
  "AppError",
  "AxiosError",
  "Error",
  "FetchError",
  "OPError",
  "RangeError",
  "ResponseError",
  "RPError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_ERROR_CLASSES.has(error.name) ? error.name : "Error";
}

export interface BrokerXeroAuthorizationInput {
  xeroState: string;
  callbackQuery: string | URLSearchParams;
  authorizationId: string;
  workspaceId: string;
  authorizedBySubject: string;
  requestedMcpScopes: readonly string[];
  now: Date;
}

export interface BrokerXeroAuthorizationResult {
  /** Unpersisted. The caller owns the database transaction. */
  authorization: ProviderAuthorization;
  /** All authorised organisations. No organisation is implicitly selected. */
  connections: AuthorizedProviderConnection[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("PROVIDER_ERROR", `Xero returned a connection without ${field}.`, {
      httpStatus: 502,
    });
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredInputString(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new AppError("VALIDATION_FAILED", `${field} must be a non-empty exact value.`, {
      httpStatus: 400,
    });
  }
  return value;
}

function requestedBrokerScopes(scopes: readonly string[]): BrokerMcpScope[] {
  const supported = new Set<string>(BROKER_MCP_SCOPES);
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new AppError("VALIDATION_FAILED", "At least one Xero MCP scope must be requested.", {
      httpStatus: 400,
    });
  }

  const unknown = normalized.filter((scope) => !supported.has(scope));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION_FAILED", "The requested Xero MCP scope is not supported.", {
      httpStatus: 400,
      details: { unsupportedScopes: unknown },
    });
  }
  return normalized as BrokerMcpScope[];
}

function callbackQueryString(query: string | URLSearchParams): string {
  const raw = typeof query === "string" ? query.replace(/^\?/u, "") : query.toString();
  if (raw.includes("#")) {
    throw new AppError("FORBIDDEN", "The Xero OAuth callback query is invalid.", {
      httpStatus: 403,
    });
  }
  return raw;
}

export class BrokerXeroAuthorizationService {
  readonly #manager: XeroClientManager;
  readonly #cipher: TokenCipher;
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #createConnectionId: () => string;

  constructor(options: {
    manager: XeroClientManager;
    cipher: TokenCipher;
    config: AppConfig;
    logger?: Logger;
    connectionIdFactory?: () => string;
  }) {
    this.#manager = options.manager;
    this.#cipher = options.cipher;
    this.#config = options.config;
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#createConnectionId = options.connectionIdFactory ?? (() => `conn_${randomUUID()}`);
  }

  async exchange(input: BrokerXeroAuthorizationInput): Promise<BrokerXeroAuthorizationResult> {
    let oauthStage: BrokerXeroExchangeStage = "CALLBACK_VALIDATION";
    const advance = (nextStage: BrokerXeroExchangeStage): void => {
      oauthStage = nextStage;
      this.#logger.info("Xero Broker OAuth exchange advanced.", { oauthStage });
    };

    try {
      return await this.#performExchange(input, advance);
    } catch (error) {
      this.#logger.error("Xero Broker OAuth exchange failed.", {
        oauthStage,
        ...(error instanceof AppError ? { errorCode: error.code } : {}),
        errorClass: safeErrorClass(error),
      });
      throw error;
    }
  }

  async #performExchange(
    input: BrokerXeroAuthorizationInput,
    advance: (stage: BrokerXeroExchangeStage) => void,
  ): Promise<BrokerXeroAuthorizationResult> {
    advance("CALLBACK_VALIDATION");
    const xeroState = requiredInputString(input.xeroState, "xeroState");
    const authorizationId = requiredInputString(input.authorizationId, "authorizationId");
    const workspaceId = requiredInputString(input.workspaceId, "workspaceId");
    const authorizedBySubject = requiredInputString(
      input.authorizedBySubject,
      "authorizedBySubject",
    );
    if (Number.isNaN(input.now.getTime())) {
      throw new AppError("VALIDATION_FAILED", "now must be a valid date.", {
        httpStatus: 400,
      });
    }
    const requestedMcpScopes = requestedBrokerScopes(input.requestedMcpScopes);
    const query = callbackQueryString(input.callbackQuery);
    const states = new URLSearchParams(query).getAll("state");
    if (states.length !== 1 || states[0] !== xeroState) {
      throw new AppError("FORBIDDEN", "The Xero OAuth callback state is invalid.", {
        httpStatus: 403,
      });
    }

    const redirectUri = new URL(this.#config.xero.redirectUri);
    if (redirectUri.search || redirectUri.hash) {
      throw new AppError("CONFIGURATION_ERROR", "The Xero redirect URI must not contain a query or fragment.", {
        httpStatus: 500,
      });
    }

    advance("TOKEN_EXCHANGE");
    const client = this.#manager.createOAuthClient(xeroState);
    const callbackUrl = `${this.#config.xero.redirectUri}?${query}`;
    const tokenSet = await client.apiCallback(callbackUrl);
    advance("TENANT_DISCOVERY");
    const tenants = await xeroTenantsForAuthenticationEvent(client, tokenSet.access_token) as XeroTenant[];
    if (tenants.length === 0) {
      throw new AppError("NOT_CONNECTED", "Xero did not return any organisation from the current authorisation event.", {
        httpStatus: 409,
      });
    }

    advance("SCOPE_VALIDATION");
    const serialized = this.#manager.serializeTokenSet(tokenSet);
    const missingCapabilities = missingBrokerXeroScopeCapabilities(
      serialized.scopes,
      requestedMcpScopes,
    );
    if (missingCapabilities.length > 0) {
      throw new AppError(
        "NOT_CONNECTED",
        `Xero did not grant the required capabilities: ${missingCapabilities
          .map((requirement) => requirement.capability)
          .join(", ")}. Re-authorisation is required.`,
        { httpStatus: 409 },
      );
    }

    advance("CONNECTION_ASSEMBLY");
    const seenTenantIds = new Set<string>();
    const seenProviderConnectionIds = new Set<string>();
    const seenConnectionIds = new Set<string>();
    const connections = tenants.map((tenant): AuthorizedProviderConnection => {
      const tenantId = requiredString(tenant.tenantId, "a tenant ID");
      const officialId = optionalNonEmptyString(tenant.id);
      const compatibilityId = optionalNonEmptyString(tenant.connectionId);
      if (officialId && compatibilityId && officialId !== compatibilityId) {
        throw new AppError("PROVIDER_ERROR", "Xero returned conflicting connection identifiers.", {
          httpStatus: 502,
        });
      }
      const providerConnectionId = requiredString(
        officialId ?? compatibilityId,
        "a connection ID",
      );

      const tenantIdentity = tenantId.toLocaleLowerCase("en-US");
      const providerConnectionIdentity = providerConnectionId.toLocaleLowerCase("en-US");
      if (seenTenantIds.has(tenantIdentity)) {
        throw new AppError("PROVIDER_ERROR", "Xero returned a duplicate tenant ID.", {
          httpStatus: 502,
        });
      }
      if (seenProviderConnectionIds.has(providerConnectionIdentity)) {
        throw new AppError("PROVIDER_ERROR", "Xero returned a duplicate connection ID.", {
          httpStatus: 502,
        });
      }
      seenTenantIds.add(tenantIdentity);
      seenProviderConnectionIds.add(providerConnectionIdentity);

      const connectionId = this.#createConnectionId();
      if (!connectionId || connectionId !== connectionId.trim() || seenConnectionIds.has(connectionId)) {
        throw new AppError("CONFLICT", "A unique internal Xero connection ID could not be created.", {
          httpStatus: 409,
        });
      }
      seenConnectionIds.add(connectionId);

      const tenantName = optionalNonEmptyString(tenant.tenantName)
        ?? optionalNonEmptyString(tenant.orgData?.name)
        ?? "Xero organisation";
      const tenantShortCode = safeXeroTenantShortCode(tenant.orgData?.shortCode);
      return {
        connectionId,
        authorizationId,
        provider: "xero",
        providerConnectionId,
        tenantId,
        tenantName,
        ...(tenantShortCode ? { tenantShortCode } : {}),
        status: "ACTIVE",
        lastVerifiedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      };
    });

    advance("AUTHORIZATION_ASSEMBLY");
    const authorization: ProviderAuthorization = {
      authorizationId,
      workspaceId,
      authorizedBySubject,
      provider: "xero",
      grantedScopes: [...serialized.scopes],
      tokenCiphertext: this.#cipher.encrypt(serialized.json, authorizationId),
      tokenExpiresAt: serialized.expiresAt,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: input.now,
      updatedAt: input.now,
    };

    advance("COMPLETE");
    return { authorization, connections };
  }
}
