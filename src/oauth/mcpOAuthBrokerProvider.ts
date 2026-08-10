import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AppConfig, McpOAuthBrokerConfig } from "../config.js";
import type { AccountingRepository } from "../db/repository.js";
import type { OAuthBrokerAuthorizationFlow } from "../domain/models.js";
import { AppError } from "../errors.js";
import type { XeroClientManager } from "../providers/xeroClientManager.js";
import {
  leastPrivilegeXeroScopesForBroker,
  type BrokerMcpScope,
} from "../providers/xeroScopes.js";
import { safeEqual } from "../security/hash.js";
import {
  generateOAuthSecret,
  keyedOAuthSecretHash,
} from "../security/oauthSecrets.js";
import { Aes256GcmTokenCipher, type TokenCipher } from "../security/tokenCipher.js";
import {
  brokerFlowCookieOptions,
  clearBrokerFlowCookieOptions,
  MCP_OAUTH_FLOW_COOKIE,
  readExactCookie,
} from "./brokerCookies.js";
import {
  personalPocHostReturnAction,
  renderPersonalPocHostReturnPage,
  renderXeroOrganisationSelectionPage,
} from "./brokerPages.js";
import type { BrokerXeroAuthorizationService } from "./brokerXeroAuthorizationService.js";
import type { McpOAuthTokenService } from "./mcpOAuthTokenService.js";
import { StaticOAuthClientsStore } from "./staticOAuthClientsStore.js";
import { resolveBrokerOAuthResource } from "./brokerResource.js";

type EnabledBrokerConfig = Extract<McpOAuthBrokerConfig, { enabled: true }>;

const HOST_STATE_MAX_LENGTH = 2_048;
const EXACT_PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const EXACT_OPAQUE_BROWSER_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const PERSONAL_POC_WORKSPACE_ID = "personal-poc";
const PERSONAL_POC_POLICY_ID = "policy_personal-poc-xero-v1";

function exactNonEmpty(value: string, maxLength: number): boolean {
  return value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export type BrokerBrowserOriginStatus =
  | "EXACT"
  | "CANONICAL_EQUIVALENT"
  | "ABSENT"
  | "NULL"
  | "INVALID"
  | "OTHER";

export type BrokerFetchMetadataStatus =
  | "TRUSTED_SAME_ORIGIN_USER_NAVIGATION"
  | "MISSING"
  | "MISMATCH";

/**
 * Compare browser form origins using Web Origin semantics while still
 * rejecting opaque, path-bearing, credential-bearing, or foreign values.
 */
export function classifyBrokerBrowserOrigin(
  suppliedOrigin: string | undefined,
  issuer: string,
): BrokerBrowserOriginStatus {
  if (suppliedOrigin === undefined) return "ABSENT";
  if (suppliedOrigin === issuer) return "EXACT";
  if (suppliedOrigin === "null") return "NULL";
  try {
    const supplied = new URL(suppliedOrigin);
    const expected = new URL(issuer);
    if (
      supplied.username ||
      supplied.password ||
      supplied.pathname !== "/" ||
      supplied.search ||
      supplied.hash
    ) {
      return "INVALID";
    }
    return supplied.origin === expected.origin ? "CANONICAL_EQUIVALENT" : "OTHER";
  } catch {
    return "INVALID";
  }
}

export function classifyBrokerFetchMetadata(headers: {
  site?: string | string[] | undefined;
  mode?: string | string[] | undefined;
  destination?: string | string[] | undefined;
  user?: string | string[] | undefined;
}): BrokerFetchMetadataStatus {
  const values = [headers.site, headers.mode, headers.destination, headers.user];
  if (values.some((value) => value === undefined)) return "MISSING";
  if (
    headers.site === "same-origin" &&
    headers.mode === "navigate" &&
    headers.destination === "document" &&
    headers.user === "?1"
  ) {
    return "TRUSTED_SAME_ORIGIN_USER_NAVIGATION";
  }
  return "MISMATCH";
}

function supportedScopeSubset(
  requested: readonly string[] | undefined,
  supported: readonly string[],
): string[] | undefined {
  if (!requested || requested.length === 0 || new Set(requested).size !== requested.length) {
    return undefined;
  }
  const supportedSet = new Set(supported);
  if (requested.some((scope) => !exactNonEmpty(scope, 128) || !supportedSet.has(scope))) {
    return undefined;
  }
  return [...requested];
}

function rawQueryString(request: Request): string {
  const index = request.originalUrl.indexOf("?");
  return index < 0 ? "" : request.originalUrl.slice(index + 1);
}

function exactSingleParameter(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length === 1 && exactNonEmpty(values[0] as string, 2_048)
    ? values[0]
    : undefined;
}

function hostRedirect(
  redirectUri: string,
  response: { code?: string; error?: "access_denied" | "server_error"; state: string },
): string {
  const target = new URL(redirectUri);
  if (response.code) target.searchParams.set("code", response.code);
  if (response.error) target.searchParams.set("error", response.error);
  target.searchParams.set("state", response.state);
  return target.href;
}

function setPrivateBrowserHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function setSelectionPageHeaders(response: Response): void {
  setPrivateBrowserHeaders(response);
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function setPersonalPocReturnPageHeaders(response: Response, formAction: string): void {
  setPrivateBrowserHeaders(response);
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  );
}

export function sendBrokerHostAuthorizationResult(
  response: Response,
  options: {
    manualPersonalPocReturn: boolean;
    returnUrl: string;
    hostName: string;
    organisationName?: string;
  },
): void {
  if (!options.manualPersonalPocReturn) {
    setPrivateBrowserHeaders(response);
    response.redirect(302, options.returnUrl);
    return;
  }
  setPersonalPocReturnPageHeaders(response, personalPocHostReturnAction(options.returnUrl));
  response.status(200).type("html").send(renderPersonalPocHostReturnPage({
    returnUrl: options.returnUrl,
    hostName: options.hostName,
    organisationName: options.organisationName ?? "Xero organisation",
  }));
}

export function shouldUsePersonalPocManualReturn(options: {
  personalPoc: boolean;
  clientId: string;
  allowedClientIds: readonly string[];
}): boolean {
  return options.personalPoc && options.allowedClientIds.includes(options.clientId);
}

/**
 * End-to-end outer OAuth provider for a pre-registered MCP Host.
 *
 * Host identity is deliberately not inferred from OAuth parameters. Until a
 * signed Host assertion exists, this provider only runs in the explicitly
 * labelled one-person POC profile.
 */
export class McpOAuthBrokerProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: StaticOAuthClientsStore;
  readonly #config: AppConfig;
  readonly #broker: EnabledBrokerConfig;
  readonly #repository: AccountingRepository;
  readonly #manager: XeroClientManager;
  readonly #xeroAuthorization: BrokerXeroAuthorizationService;
  readonly #tokens: McpOAuthTokenService;
  readonly #stateCipher: TokenCipher;
  readonly #clock: () => Date;
  readonly #secretFactory: () => string;
  readonly #idFactory: (purpose: "installation" | "authorization" | "binding") => string;

  constructor(options: {
    config: AppConfig;
    repository: AccountingRepository;
    manager: XeroClientManager;
    xeroAuthorization: BrokerXeroAuthorizationService;
    tokens: McpOAuthTokenService;
    stateCipher?: TokenCipher;
    clock?: () => Date;
    secretFactory?: () => string;
    idFactory?: (purpose: "installation" | "authorization" | "binding") => string;
  }) {
    if (!options.config.mcpOAuthBroker?.enabled) {
      throw new Error("The MCP OAuth Broker provider requires an enabled Broker configuration.");
    }
    this.#config = options.config;
    this.#broker = options.config.mcpOAuthBroker;
    this.#repository = options.repository;
    this.#manager = options.manager;
    this.#xeroAuthorization = options.xeroAuthorization;
    this.#tokens = options.tokens;
    this.#stateCipher = options.stateCipher ?? new Aes256GcmTokenCipher(this.#broker.cookieStateKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#secretFactory = options.secretFactory ?? generateOAuthSecret;
    this.#idFactory = options.idFactory ?? ((purpose) => `${purpose}_${randomUUID()}`);
    this.clientsStore = new StaticOAuthClientsStore(this.#broker.hostClients, this.#broker.scopes);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    if (!this.#broker.personalPocOnly) {
      throw new AccessDeniedError("Trusted Host installation identity is not configured.");
    }
    if (!this.#isExactRegisteredRedirect(client.client_id, params.redirectUri)) {
      throw new InvalidRequestError("The redirect URI is not registered exactly.");
    }
    if (!params.state || !exactNonEmpty(params.state, HOST_STATE_MAX_LENGTH)) {
      throw new InvalidRequestError("A bounded Host state value is required.");
    }
    if (!EXACT_PKCE_CHALLENGE.test(params.codeChallenge)) {
      throw new InvalidRequestError("A valid S256 PKCE challenge is required.");
    }
    const canonicalResource = resolveBrokerOAuthResource(
      this.#broker,
      client.client_id,
      params.resource,
    );
    const requestedScopes = supportedScopeSubset(params.scopes, this.#broker.scopes);
    if (!requestedScopes) {
      throw new InvalidScopeError("The requested OAuth scope is invalid.");
    }

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#broker.browserFlowTtlSeconds * 1_000);
    const browserSecret = this.#newSecret("browser flow");
    const xeroState = this.#newSecret("Xero state");
    const flowHash = this.#hash("browser_flow", browserSecret);
    const installationId = this.#newId("installation");
    const subjectId = this.#config.demoActorId;
    const flow: OAuthBrokerAuthorizationFlow = {
      flowHash,
      browserSessionHash: this.#hash("browser_session", browserSecret),
      xeroStateHash: this.#hash("xero_state", xeroState),
      outerStateHash: this.#hash("host_state", params.state),
      outerStateCiphertext: this.#stateCipher.encrypt(params.state, flowHash),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      pkceCodeChallenge: params.codeChallenge,
      pkceCodeChallengeMethod: "S256",
      resource: canonicalResource,
      audience: canonicalResource,
      requestedScopes,
      workspaceId: PERSONAL_POC_WORKSPACE_ID,
      subjectType: "USER",
      subjectId,
      agentId: `host-client:${client.client_id}`,
      installationId,
      personalPoc: true,
      status: "AUTHORIZING_XERO",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.#repository.createBrokerAuthorizationFlow({
      installation: {
        installationId,
        workspaceId: flow.workspaceId,
        subjectType: flow.subjectType,
        subjectId: flow.subjectId,
        agentId: flow.agentId,
        clientId: flow.clientId,
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      },
      flow,
    });

    const xeroScopes = leastPrivilegeXeroScopesForBroker(
      this.#config.xero.scopes,
      requestedScopes as BrokerMcpScope[],
    );
    const consentUrl = await this.#manager.createOAuthClient(xeroState, xeroScopes).buildConsentUrl();
    response.cookie(
      MCP_OAUTH_FLOW_COOKIE,
      browserSecret,
      brokerFlowCookieOptions(this.#broker.browserFlowTtlSeconds),
    );
    setPrivateBrowserHeaders(response);
    response.redirect(302, consentUrl);
  }

  async challengeForAuthorizationCode(): Promise<string> {
    // The token service performs the exact storage-bound S256 comparison.
    throw new InvalidGrantError("The OAuth grant is invalid.");
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.#tokens.exchangeAuthorizationCode(
      client.client_id,
      authorizationCode,
      codeVerifier,
      redirectUri,
      resource,
    );
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.#tokens.exchangeRefreshToken(client.client_id, refreshToken, scopes, resource);
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.#tokens.verifyAccessToken(token);
  }

  revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    return this.#tokens.revokeTokenForClient(request.token, client.client_id);
  }

  async handleXeroCallback(request: Request, response: Response): Promise<void> {
    const browserSecret = readExactCookie(request.headers.cookie, MCP_OAUTH_FLOW_COOKIE);
    const queryString = rawQueryString(request);
    const query = new URLSearchParams(queryString);
    const xeroState = exactSingleParameter(query, "state");
    if (!browserSecret || !EXACT_OPAQUE_BROWSER_VALUE.test(browserSecret) || !xeroState) {
      throw new AppError("FORBIDDEN", "The OAuth callback is missing its trusted browser state.", {
        httpStatus: 403,
      });
    }

    const flowHash = this.#hash("browser_flow", browserSecret);
    const browserSessionHash = this.#hash("browser_session", browserSecret);
    const flow = await this.#repository.beginBrokerXeroCallback({
      flowHash,
      browserSessionHash,
      xeroStateHash: this.#hash("xero_state", xeroState),
      now: this.#now(),
    });
    if (!flow) {
      throw new AppError("FORBIDDEN", "The OAuth browser flow is invalid, expired, or already used.", {
        httpStatus: 403,
      });
    }

    const xeroErrors = query.getAll("error");
    if (xeroErrors.length > 0) {
      const denied = xeroErrors.length === 1 && xeroErrors[0] === "access_denied";
      await this.#terminateAndRedirect(
        response,
        flow,
        browserSecret,
        denied ? "DENIED" : "FAILED",
        denied ? "access_denied" : "server_error",
      );
      return;
    }
    if (query.getAll("code").length !== 1) {
      await this.#terminateAndRedirect(
        response,
        flow,
        browserSecret,
        "FAILED",
        "server_error",
      );
      return;
    }

    try {
      const now = this.#now();
      const authorizationId = this.#newId("authorization");
      const selectionCsrf = this.#newSecret("organisation selection CSRF");
      const exchanged = await this.#xeroAuthorization.exchange({
        xeroState,
        callbackQuery: queryString,
        authorizationId,
        workspaceId: flow.workspaceId,
        authorizedBySubject: flow.subjectId,
        requestedMcpScopes: flow.requestedScopes,
        now,
      });
      const completed = await this.#repository.completeBrokerXeroExchange({
        flowHash,
        browserSessionHash,
        authorization: exchanged.authorization,
        connections: exchanged.connections,
        selectionCsrfHash: this.#hash("csrf_token", selectionCsrf),
        now,
      });
      if (!completed) throw new Error("The Broker flow could not enter organisation selection.");

      setSelectionPageHeaders(response);
      response.type("html").send(renderXeroOrganisationSelectionPage({
        organisations: exchanged.connections.map((connection) => ({
          connectionId: connection.connectionId,
          tenantName: connection.tenantName,
          tenantId: connection.tenantId,
        })),
        csrfToken: selectionCsrf,
        requestedScopes: completed.requestedScopes,
        personalPocOnly: completed.personalPoc,
      }));
    } catch {
      await this.#terminateAndRedirect(
        response,
        flow,
        browserSecret,
        "FAILED",
        "server_error",
      );
    }
  }

  async handleOrganisationSelection(request: Request, response: Response): Promise<void> {
    const originStatus = classifyBrokerBrowserOrigin(request.headers.origin, this.#broker.issuer);
    const fetchMetadataStatus = classifyBrokerFetchMetadata({
      site: request.headers["sec-fetch-site"],
      mode: request.headers["sec-fetch-mode"],
      destination: request.headers["sec-fetch-dest"],
      user: request.headers["sec-fetch-user"],
    });
    const originAllowed = originStatus === "EXACT" ||
      originStatus === "CANONICAL_EQUIVALENT" ||
      (
        originStatus === "NULL" &&
        this.#broker.personalPocOnly &&
        fetchMetadataStatus !== "MISMATCH"
      );
    if (!originAllowed) {
      throw new AppError("FORBIDDEN", "Organisation selection must be submitted from this site.", {
        httpStatus: 403,
        details: { resultStatus: `${originStatus}_${fetchMetadataStatus}` },
      });
    }
    const browserSecret = readExactCookie(request.headers.cookie, MCP_OAUTH_FLOW_COOKIE);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    const selectedConnectionId = typeof request.body?.connection_id === "string"
      ? request.body.connection_id
      : undefined;
    if (
      !browserSecret ||
      !EXACT_OPAQUE_BROWSER_VALUE.test(browserSecret) ||
      !csrfToken ||
      !exactNonEmpty(csrfToken, 256) ||
      !selectedConnectionId ||
      !exactNonEmpty(selectedConnectionId, 256)
    ) {
      throw new AppError("FORBIDDEN", "The organisation selection request is invalid.", {
        httpStatus: 403,
        details: {
          resultStatus: [
            browserSecret
              ? EXACT_OPAQUE_BROWSER_VALUE.test(browserSecret) ? "COOKIE_OK" : "COOKIE_INVALID"
              : "COOKIE_MISSING",
            csrfToken
              ? exactNonEmpty(csrfToken, 256) ? "CSRF_OK" : "CSRF_INVALID"
              : "CSRF_MISSING",
            selectedConnectionId
              ? exactNonEmpty(selectedConnectionId, 256) ? "CONNECTION_OK" : "CONNECTION_INVALID"
              : "CONNECTION_MISSING",
          ].join("_"),
        },
      });
    }

    const now = this.#now();
    const flowHash = this.#hash("browser_flow", browserSecret);
    const browserSessionHash = this.#hash("browser_session", browserSecret);
    const selection = await this.#repository.getBrokerSelection({
      flowHash,
      browserSessionHash,
      now,
    });
    if (!selection) {
      throw new AppError("FORBIDDEN", "The organisation selection has expired or was already used.", {
        httpStatus: 403,
        details: { resultStatus: "FLOW_SELECTION_MISSING" },
      });
    }
    const selectedConnection = selection.connections.find(
      (connection) => connection.connectionId === selectedConnectionId,
    );
    if (!selectedConnection) {
      throw new AppError("FORBIDDEN", "The selected Xero organisation is not part of this OAuth event.", {
        httpStatus: 403,
        details: { resultStatus: "CONNECTION_NOT_DISCOVERED" },
      });
    }

    const rawAuthorizationCode = this.#newSecret("authorization code");
    const result = await this.#repository.completeBrokerOrganisationSelection({
      flowHash,
      browserSessionHash,
      selectionCsrfHash: this.#hash("csrf_token", csrfToken),
      selectedConnectionId,
      bindingId: this.#newId("binding"),
      policyId: PERSONAL_POC_POLICY_ID,
      authorizationCodeHash: this.#hash("authorization_code", rawAuthorizationCode),
      authorizationCodeExpiresAt: new Date(
        now.getTime() + this.#broker.authorizationCodeTtlSeconds * 1_000,
      ),
      now,
    });
    if (!result) {
      throw new AppError("FORBIDDEN", "The organisation selection is invalid or was already used.", {
        httpStatus: 403,
        details: { resultStatus: "SELECTION_COMPLETE_REJECTED" },
      });
    }

    const outerState = this.#stateCipher.decrypt(result.outerStateCiphertext, flowHash);
    if (!safeEqual(this.#hash("host_state", outerState), result.flow.outerStateHash)) {
      throw new AppError("FORBIDDEN", "The Host OAuth state could not be verified.", {
        httpStatus: 403,
        details: { resultStatus: "HOST_STATE_MISMATCH" },
      });
    }
    response.clearCookie(MCP_OAUTH_FLOW_COOKIE, clearBrokerFlowCookieOptions());
    const returnUrl = hostRedirect(result.flow.redirectUri, {
      code: rawAuthorizationCode,
      state: outerState,
    });
    const hostName = this.#broker.hostClients.find((client) => client.clientId === result.flow.clientId)?.name
      ?? "MCP Host";
    sendBrokerHostAuthorizationResult(response, {
      manualPersonalPocReturn: shouldUsePersonalPocManualReturn({
        personalPoc: result.flow.personalPoc,
        clientId: result.flow.clientId,
        allowedClientIds: this.#broker.missingResourceCompatClientIds,
      }),
      returnUrl,
      hostName,
      organisationName: selectedConnection.tenantName,
    });
  }

  #hash(
    purpose: Parameters<typeof keyedOAuthSecretHash>[1],
    rawSecret: string,
  ): string {
    return keyedOAuthSecretHash(this.#broker.tokenHashKey, purpose, rawSecret);
  }

  #newSecret(description: string): string {
    const value = this.#secretFactory();
    if (!EXACT_OPAQUE_BROWSER_VALUE.test(value)) {
      throw new Error(`The ${description} factory returned an invalid opaque value.`);
    }
    return value;
  }

  #newId(purpose: "installation" | "authorization" | "binding"): string {
    const value = this.#idFactory(purpose);
    if (!exactNonEmpty(value, 256)) throw new Error(`The ${purpose} identifier is invalid.`);
    return value;
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("The OAuth Broker clock is invalid.");
    return new Date(value);
  }

  #isExactRegisteredRedirect(clientId: string, redirectUri: string): boolean {
    const configured = this.#broker.hostClients.find((client) => client.clientId === clientId);
    return Boolean(configured?.redirectUris.includes(redirectUri));
  }

  #verifiedOuterState(flow: OAuthBrokerAuthorizationFlow, ciphertext: string): string {
    const state = this.#stateCipher.decrypt(ciphertext, flow.flowHash);
    if (!safeEqual(this.#hash("host_state", state), flow.outerStateHash)) {
      throw new ServerError("The Host OAuth state could not be verified.");
    }
    return state;
  }

  async #terminateAndRedirect(
    response: Response,
    flow: OAuthBrokerAuthorizationFlow,
    browserSecret: string,
    terminalStatus: "DENIED" | "FAILED",
    error: "access_denied" | "server_error",
  ): Promise<void> {
    const terminated = await this.#repository.terminateBrokerAuthorizationFlow({
      flowHash: flow.flowHash,
      browserSessionHash: this.#hash("browser_session", browserSecret),
      terminalStatus,
      now: this.#now(),
    });
    if (!terminated) {
      throw new AppError("FORBIDDEN", "The OAuth browser flow could not be terminated safely.", {
        httpStatus: 403,
      });
    }
    const outerState = this.#verifiedOuterState(terminated.flow, terminated.outerStateCiphertext);
    response.clearCookie(MCP_OAUTH_FLOW_COOKIE, clearBrokerFlowCookieOptions());
    setPrivateBrowserHeaders(response);
    response.redirect(302, hostRedirect(terminated.flow.redirectUri, { error, state: outerState }));
  }
}
