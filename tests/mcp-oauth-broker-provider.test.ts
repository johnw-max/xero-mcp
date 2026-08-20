import type { Request, Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_SCOPES, type AppConfig } from "../src/config.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import {
  classifyBrokerBrowserOrigin,
  classifyBrokerFetchMetadata,
  McpOAuthBrokerProvider,
  sendBrokerHostAuthorizationResult,
  shouldUsePersonalPocManualReturn,
} from "../src/oauth/mcpOAuthBrokerProvider.js";
import { McpOAuthTokenService } from "../src/oauth/mcpOAuthTokenService.js";
import { pkceS256Challenge } from "../src/security/oauthSecrets.js";
import { keyedOAuthSecretHash } from "../src/security/oauthSecrets.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import type { BrokerXeroAuthorizationService } from "../src/oauth/brokerXeroAuthorizationService.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";

const now = new Date("2026-08-05T10:00:00.000Z");
const redirectUri = "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback";
const workRedirectUri = "https://work.zcloak.ai/api/mcp/zcloak-ledger-mcp-xero-demo/oauth/callback";
const verifier = "v".repeat(43);
const retryCipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 14));

function config(personalPocOnly = true, sharedTestUsers = false): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "https://xero-mcp.example.test",
    databaseUrl: "postgres://test",
    mcpBearerToken: "m".repeat(43),
    allowedOrigins: ["https://agent2.zcloak.ai"],
    allowedHosts: ["xero-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    xero: {
      clientId: "xero-client",
      clientSecret: "xero-secret",
      redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "accounting.invoices.read",
        "accounting.invoices",
        "accounting.payments.read",
        "accounting.payments",
        "accounting.manualjournals.read",
        "accounting.manualjournals",
        "accounting.banktransactions.read",
        "accounting.banktransactions",
        "accounting.settings.read",
        "accounting.settings",
        "accounting.contacts.read",
        "accounting.contacts",
        "accounting.journals.read",
        "accounting.reports.trialbalance.read",
        "accounting.reports.profitandloss.read",
        "accounting.reports.balancesheet.read",
        "accounting.reports.aged.read",
      ],
    },
    xeroWriteEnabled: true,
    tokenEncryptionKey: Buffer.alloc(32, 3),
    mcpOAuthBroker: {
      enabled: true,
      issuer: "https://xero-mcp.example.test",
      resourceUri: "https://xero-mcp.example.test/mcp",
      protectedResourceUris: ["https://xero-mcp.example.test/mcp"],
      authorizationPath: "/authorize",
      tokenPath: "/token",
      revocationPath: "/revoke",
      authorizationEndpoint: "https://xero-mcp.example.test/authorize",
      tokenEndpoint: "https://xero-mcp.example.test/token",
      revocationEndpoint: "https://xero-mcp.example.test/revoke",
      scopes: MCP_OAUTH_SCOPES,
      personalPocOnly,
      sharedTestUsers,
      hostClients: [{
        name: "Agent2",
        clientId: "agent2-client",
        clientSecret: "h".repeat(43),
        redirectUris: [redirectUri],
      }, {
        name: "Work",
        clientId: "work-client",
        clientSecret: "s".repeat(43),
        redirectUris: [workRedirectUri],
      }],
      missingResourceCompatClientIds: ["agent2-client", "work-client"],
      manualReturnClientIds: ["agent2-client"],
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      authorizationCodeTtlSeconds: 300,
      browserFlowTtlSeconds: 600,
      tokenHashKey: Buffer.alloc(32, 1),
      cookieStateKey: Buffer.alloc(32, 2),
    },
    demoActorId: "john-wang-personal-poc",
    logLevel: "error",
  };
}

interface CapturedResponse {
  response: Response;
  headers: Map<string, unknown>;
  cookies: Array<{ name: string; value: string; options: unknown }>;
  cleared: string[];
  redirects: string[];
  statuses: number[];
  body?: string;
}

function capturedResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    response: undefined as unknown as Response,
    headers: new Map(),
    cookies: [],
    cleared: [],
    redirects: [],
    statuses: [],
  };
  const response = {
    setHeader: (name: string, value: unknown) => {
      captured.headers.set(name.toLowerCase(), value);
      return response;
    },
    cookie: (name: string, value: string, options: unknown) => {
      captured.cookies.push({ name, value, options });
      return response;
    },
    clearCookie: (name: string) => {
      captured.cleared.push(name);
      return response;
    },
    redirect: (_status: number, location: string) => {
      captured.redirects.push(location);
      return response;
    },
    status: (status: number) => {
      captured.statuses.push(status);
      return response;
    },
    type: () => response,
    send: (body: string) => {
      captured.body = body;
      return response;
    },
  };
  captured.response = response as unknown as Response;
  return captured;
}

function request(input: {
  originalUrl: string;
  cookie?: string;
  origin?: string;
  trustedNavigationMetadata?: boolean;
  body?: Record<string, unknown>;
}): Request {
  return {
    originalUrl: input.originalUrl,
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.trustedNavigationMetadata ? {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      } : {}),
    },
    body: input.body ?? {},
  } as unknown as Request;
}

describe("MCP OAuth Broker provider", () => {
  it("accepts only the exact or canonically equivalent Broker browser origin", () => {
    const issuer = "https://broker.example.test";
    expect(classifyBrokerBrowserOrigin(issuer, issuer)).toBe("EXACT");
    expect(classifyBrokerBrowserOrigin(`${issuer}/`, issuer)).toBe("CANONICAL_EQUIVALENT");
    expect(classifyBrokerBrowserOrigin(undefined, issuer)).toBe("ABSENT");
    expect(classifyBrokerBrowserOrigin("null", issuer)).toBe("NULL");
    expect(classifyBrokerBrowserOrigin(`${issuer}/oauth`, issuer)).toBe("INVALID");
    expect(classifyBrokerBrowserOrigin("https://evil.invalid", issuer)).toBe("OTHER");
  });

  it("trusts only complete same-origin user-navigation Fetch Metadata", () => {
    expect(classifyBrokerFetchMetadata({
      site: "same-origin",
      mode: "navigate",
      destination: "document",
      user: "?1",
    })).toBe("TRUSTED_SAME_ORIGIN_USER_NAVIGATION");
    expect(classifyBrokerFetchMetadata({})).toBe("MISSING");
    expect(classifyBrokerFetchMetadata({
      site: "cross-site",
      mode: "navigate",
      destination: "document",
      user: "?1",
    })).toBe("MISMATCH");
    for (const site of ["same-site", "cross-site", "none"]) {
      expect(classifyBrokerFetchMetadata({
        site,
        mode: "navigate",
        destination: "document",
        user: "?1",
      })).toBe("MISMATCH");
    }
    expect(classifyBrokerFetchMetadata({
      site: "same-origin",
      mode: "cors",
      destination: "empty",
      user: "?1",
    })).toBe("MISMATCH");
    expect(classifyBrokerFetchMetadata({
      site: ["same-origin", "same-origin"],
      mode: "navigate",
      destination: "document",
      user: "?1",
    })).toBe("MISMATCH");
  });

  it("runs the Personal POC Agent2 flow through explicit organisation selection and token verification", async () => {
    const appConfig = config();
    const brokerConfig = appConfig.mcpOAuthBroker;
    if (!brokerConfig?.enabled) throw new Error("test broker must be enabled");
    const repository = new InMemoryAccountingRepository();
    let xeroState = "";
    const manager = {
      createOAuthClient: vi.fn((state: string) => {
        xeroState = state;
        return { buildConsentUrl: async () => `https://login.xero.test/authorize?state=${state}` };
      }),
    } as unknown as XeroClientManager;
    const xeroAuthorization = {
      exchange: vi.fn(async (input: {
        authorizationId: string;
        workspaceId: string;
        authorizedBySubject: string;
        now: Date;
      }) => ({
        authorization: {
          authorizationId: input.authorizationId,
          workspaceId: input.workspaceId,
          authorizedBySubject: input.authorizedBySubject,
          provider: "xero" as const,
          grantedScopes: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "accounting.invoices.read",
            "accounting.invoices",
            "accounting.payments.read",
            "accounting.payments",
            "accounting.manualjournals.read",
            "accounting.manualjournals",
            "accounting.banktransactions.read",
            "accounting.banktransactions",
            "accounting.settings.read",
            "accounting.settings",
            "accounting.contacts.read",
            "accounting.contacts",
            "accounting.reports.trialbalance.read",
            "accounting.reports.profitandloss.read",
            "accounting.reports.balancesheet.read",
            "accounting.reports.aged.read",
          ],
          tokenCiphertext: "ciphertext",
          tokenExpiresAt: new Date(input.now.getTime() + 1_800_000),
          refreshVersion: 0,
          status: "ACTIVE" as const,
          createdAt: input.now,
          updatedAt: input.now,
        },
        connections: [{
          connectionId: "conn_xero_demo",
          authorizationId: input.authorizationId,
          provider: "xero" as const,
          providerConnectionId: "official-xero-connection",
          tenantId: "tenant-xero-demo",
          tenantName: "Demo Books Ltd",
          status: "ACTIVE" as const,
          lastVerifiedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        }],
      })),
    } as unknown as BrokerXeroAuthorizationService;
    const tokenService = new McpOAuthTokenService({
      config: brokerConfig,
      repository,
      cipher: retryCipher,
      clock: () => now,
    });
    const generated = [
      "b".repeat(43),
      "x".repeat(43),
      "c".repeat(43),
      "r".repeat(43),
      "o".repeat(43),
    ];
    const provider = new McpOAuthBrokerProvider({
      config: appConfig,
      repository,
      manager,
      xeroAuthorization,
      tokens: tokenService,
      clock: () => now,
      secretFactory: () => {
        const value = generated.shift();
        if (!value) throw new Error("unexpected secret request");
        return value;
      },
      idFactory: (purpose) => `${purpose}_test`,
    });
    const client = await provider.clientsStore.getClient("agent2-client") as OAuthClientInformationFull;

    const authorize = capturedResponse();
    await provider.authorize(client, {
      state: "agent2-host-state",
      scopes: ["xero.read", "xero.draft.write"],
      codeChallenge: pkceS256Challenge(verifier),
      redirectUri,
      resource: undefined,
    }, authorize.response);

    expect(authorize.redirects[0]).toContain("https://login.xero.test/authorize");
    const flowCookie = authorize.cookies[0];
    expect(flowCookie).toMatchObject({
      name: "__Host-zcloak_oauth_flow",
      options: expect.objectContaining({ secure: true, httpOnly: true, sameSite: "lax", path: "/" }),
    });

    const callback = capturedResponse();
    await provider.handleXeroCallback(request({
      originalUrl: `/oauth/xero/callback?state=${xeroState}&code=xero-code`,
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
    }), callback.response);
    expect(callback.body).toContain("Choose an organisation");
    expect(callback.body).toContain("Test connection · Intended for one user.");
    expect(callback.body).toContain("Demo Books Ltd");
    expect(callback.cookies).toContainEqual(expect.objectContaining({
      name: "__Host-zcloak_oauth_flow",
      value: flowCookie?.value,
      options: expect.objectContaining({
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      }),
    }));
    const csrfToken = callback.body?.match(/name="csrf_token" value="([^"]+)"/u)?.[1];
    const selectionTicket = callback.body?.match(/name="selection_ticket" value="([^"]+)"/u)?.[1];
    expect(csrfToken).toBe("c".repeat(43));
    expect(selectionTicket).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      origin: "null",
      body: { csrf_token: csrfToken, connection_id: "conn_xero_demo" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { resultStatus: "CSRF_OK_SELECTION_TICKET_MISSING_CONNECTION_OK" },
    });
    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
      origin: "https://evil.invalid",
      trustedNavigationMetadata: true,
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "conn_xero_demo" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { resultStatus: "OTHER_TRUSTED_SAME_ORIGIN_USER_NAVIGATION" },
    });
    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
      origin: "null",
      trustedNavigationMetadata: true,
      body: { csrf_token: "wrong-csrf", selection_ticket: selectionTicket, connection_id: "conn_xero_demo" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { resultStatus: "SELECTION_TICKET_INVALID" },
    });
    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${"q".repeat(43)}`,
      origin: "null",
      trustedNavigationMetadata: true,
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "conn_xero_demo" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { resultStatus: "COOKIE_SELECTION_TICKET_MISMATCH" },
    });

    const selection = capturedResponse();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      origin: "null",
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "conn_xero_demo" },
    }), selection.response);
    const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    expect(selection.cleared).toContain("__Host-zcloak_oauth_flow");
    expect(selection.statuses).toEqual([200]);
    expect(selection.redirects).toEqual([]);
    expect(selection.headers.get("cache-control")).toBe("no-store");
    expect(selection.headers.get("pragma")).toBe("no-cache");
    expect(selection.headers.get("expires")).toBe("0");
    expect(selection.headers.get("referrer-policy")).toBe("no-referrer");
    expect(selection.headers.get("x-content-type-options")).toBe("nosniff");
    expect(selection.headers.get("x-frame-options")).toBe("DENY");
    expect(selection.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(selection.body).toContain("Return to Agent2");
    expect(selection.body).toContain(`name="code" value="${"r".repeat(43)}"`);
    expect(selection.body).toContain('name="state" value="agent2-host-state"');
    expect(selection.body).not.toContain("href=");
    expect(selection.body?.match(/id="return-to-host"/gu)).toHaveLength(1);
    expect(logged).not.toContain("r".repeat(43));
    expect(logged).not.toContain("agent2-host-state");
    expect(logged).not.toContain(selectionTicket);

    const formAction = selection.body?.match(/<form method="get" action="([^"]+)"/u)?.[1];
    if (!formAction) throw new Error("expected Host return form action");
    const hostCallback = new URL(formAction);
    for (const match of selection.body?.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu) ?? []) {
      hostCallback.searchParams.append(match[1] as string, match[2] as string);
    }
    expect(`${hostCallback.origin}${hostCallback.pathname}`).toBe(redirectUri);
    expect(hostCallback.searchParams.get("state")).toBe("agent2-host-state");
    expect(hostCallback.searchParams.get("code")).toBe("r".repeat(43));

    // A second submit of the exact same chooser form — a double click, an
    // impatient second tap, a back-button resubmit — must come back as the
    // identical outcome, not an error: the caller's intent was already
    // satisfied by the first submit, and no new credential is minted.
    const replay = capturedResponse();
    await provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
      origin: "null",
      trustedNavigationMetadata: true,
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "conn_xero_demo" },
    }), replay.response);
    expect(replay.statuses).toEqual([200]);
    expect(replay.redirects).toEqual([]);
    expect(replay.cleared).toContain("__Host-zcloak_oauth_flow");
    expect(replay.body).toBe(selection.body);
    expect(replay.headers.get("content-security-policy")).toBe(
      selection.headers.get("content-security-policy"),
    );

    // Naming a *different* connection than what this flow actually
    // completed is not "the same request" even with an otherwise-valid
    // ticket, so it is never replayed as a silent organisation switch — it
    // still fails, distinctly from the safe retry case above. It is,
    // however, still a *known* completion (the cache has this exact flow's
    // outcome, just for the other connection), so the reason must say so
    // rather than falling back to the generic "selection missing" code.
    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
      origin: "null",
      trustedNavigationMetadata: true,
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "some-other-connection" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/expired|already used/i),
      details: { resultStatus: "FLOW_ALREADY_COMPLETED" },
    });

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      hostCallback.searchParams.get("code") as string,
      verifier,
      redirectUri,
      undefined,
    );
    expect(tokens.scope).toBe("xero.read xero.draft.write");
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.extra).toMatchObject({
      workspaceId: "personal-poc",
      subjectType: "USER",
      subjectId: "john-wang-personal-poc",
      agentId: "host-client:agent2-client",
      tenantId: "tenant-xero-demo",
      connectionId: "conn_xero_demo",
    });

    await expect(provider.exchangeAuthorizationCode(
      client,
      hostCallback.searchParams.get("code") as string,
      verifier,
      redirectUri,
      new URL(brokerConfig.resourceUri),
    )).rejects.toMatchObject({ errorCode: "invalid_grant" });
  });

  it("never claims a completion it cannot prove: a selection that is simply gone stays FLOW_SELECTION_MISSING, not FLOW_ALREADY_COMPLETED", async () => {
    const appConfig = config();
    const brokerConfig = appConfig.mcpOAuthBroker;
    if (!brokerConfig?.enabled) throw new Error("test broker must be enabled");
    const repository = new InMemoryAccountingRepository();
    let xeroState = "";
    const manager = {
      createOAuthClient: vi.fn((state: string) => {
        xeroState = state;
        return { buildConsentUrl: async () => `https://login.xero.test/authorize?state=${state}` };
      }),
    } as unknown as XeroClientManager;
    const xeroAuthorization = {
      exchange: vi.fn(async (input: {
        authorizationId: string;
        workspaceId: string;
        authorizedBySubject: string;
        now: Date;
      }) => ({
        authorization: {
          authorizationId: input.authorizationId,
          workspaceId: input.workspaceId,
          authorizedBySubject: input.authorizedBySubject,
          provider: "xero" as const,
          grantedScopes: ["openid"],
          tokenCiphertext: "ciphertext",
          tokenExpiresAt: new Date(input.now.getTime() + 1_800_000),
          refreshVersion: 0,
          status: "ACTIVE" as const,
          createdAt: input.now,
          updatedAt: input.now,
        },
        connections: [{
          connectionId: "conn_never_completed",
          authorizationId: input.authorizationId,
          provider: "xero" as const,
          providerConnectionId: "official-xero-connection",
          tenantId: "tenant-never-completed",
          tenantName: "Never Completed Ltd",
          status: "ACTIVE" as const,
          lastVerifiedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        }],
      })),
    } as unknown as BrokerXeroAuthorizationService;
    const tokenService = new McpOAuthTokenService({
      config: brokerConfig,
      repository,
      cipher: retryCipher,
      clock: () => now,
    });
    const generated = ["b".repeat(43), "x".repeat(43), "c".repeat(43)];
    const provider = new McpOAuthBrokerProvider({
      config: appConfig,
      repository,
      manager,
      xeroAuthorization,
      tokens: tokenService,
      clock: () => now,
      secretFactory: () => {
        const value = generated.shift();
        if (!value) throw new Error("unexpected secret request");
        return value;
      },
      idFactory: (purpose) => `${purpose}_never_completed`,
    });

    const authorize = capturedResponse();
    await provider.authorize(await provider.clientsStore.getClient("agent2-client") as OAuthClientInformationFull, {
      state: "never-completed-host-state",
      scopes: ["xero.read"],
      codeChallenge: pkceS256Challenge(verifier),
      redirectUri,
      resource: undefined,
    }, authorize.response);
    const flowCookie = authorize.cookies[0];

    const callback = capturedResponse();
    await provider.handleXeroCallback(request({
      originalUrl: `/oauth/xero/callback?state=${xeroState}&code=xero-code`,
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
    }), callback.response);
    const csrfToken = callback.body?.match(/name="csrf_token" value="([^"]+)"/u)?.[1];
    const selectionTicket = callback.body?.match(/name="selection_ticket" value="([^"]+)"/u)?.[1];

    // This flow reaches AWAITING_SELECTION — it has a perfectly valid
    // selection ticket — but `handleOrganisationSelection` is never called
    // on it, so the provider's completed-selection cache has no entry for
    // it. Move it out of AWAITING_SELECTION some other way (here, the Host
    // denies or the browser gives up), the same way an expiry would: no
    // completion, ever, by anyone.
    const flowHash = keyedOAuthSecretHash(brokerConfig.tokenHashKey, "browser_flow", flowCookie?.value as string);
    const browserSessionHash = keyedOAuthSecretHash(
      brokerConfig.tokenHashKey,
      "browser_session",
      flowCookie?.value as string,
    );
    const terminated = await repository.terminateBrokerAuthorizationFlow({
      flowHash,
      browserSessionHash,
      terminalStatus: "FAILED",
      now,
    });
    if (!terminated) throw new Error("test setup expected the flow to terminate");

    // The selection ticket is still cryptographically valid (it only checks
    // its own expiry and CSRF binding, never the repository), so this
    // reaches the "is this flow still selectable" check and finds it is
    // not — with nothing in the cache to say why. It must not guess.
    await expect(provider.handleOrganisationSelection(request({
      originalUrl: "/oauth/xero/select",
      cookie: `${flowCookie?.name}=${flowCookie?.value}`,
      origin: "null",
      trustedNavigationMetadata: true,
      body: { csrf_token: csrfToken, selection_ticket: selectionTicket, connection_id: "conn_never_completed" },
    }), capturedResponse().response)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { resultStatus: "FLOW_SELECTION_MISSING" },
    });
  });

  it("gives multiple testers using one Host client independent installation subjects", async () => {
    const appConfig = config(true, true);
    const brokerConfig = appConfig.mcpOAuthBroker;
    if (!brokerConfig?.enabled) throw new Error("test broker must be enabled");
    const repository = new InMemoryAccountingRepository();
    const manager = {
      createOAuthClient: vi.fn((state: string) => ({
        buildConsentUrl: async () => `https://login.xero.test/authorize?state=${state}`,
      })),
    } as unknown as XeroClientManager;
    const browserOne = "b".repeat(43);
    const xeroOne = "x".repeat(43);
    const browserTwo = "d".repeat(43);
    const xeroTwo = "y".repeat(43);
    const secrets = [browserOne, xeroOne, browserTwo, xeroTwo];
    const installationIds = ["installation_shared_1", "installation_shared_2"];
    const provider = new McpOAuthBrokerProvider({
      config: appConfig,
      repository,
      manager,
      xeroAuthorization: {} as BrokerXeroAuthorizationService,
      tokens: new McpOAuthTokenService({
        config: brokerConfig,
        repository,
        cipher: retryCipher,
        clock: () => now,
      }),
      clock: () => now,
      secretFactory: () => {
        const value = secrets.shift();
        if (!value) throw new Error("unexpected secret request");
        return value;
      },
      idFactory: (purpose) => {
        if (purpose !== "installation") throw new Error("unexpected identifier request");
        const value = installationIds.shift();
        if (!value) throw new Error("unexpected installation request");
        return value;
      },
    });
    const client = await provider.clientsStore.getClient("agent2-client") as OAuthClientInformationFull;
    const params = {
      scopes: ["xero.read"],
      codeChallenge: pkceS256Challenge(verifier),
      redirectUri,
      resource: new URL(brokerConfig.resourceUri),
    };

    await provider.authorize(client, { ...params, state: "tester-one" }, capturedResponse().response);
    await provider.authorize(client, { ...params, state: "tester-two" }, capturedResponse().response);

    const begin = (browserSecret: string, xeroState: string) => repository.beginBrokerXeroCallback({
      flowHash: keyedOAuthSecretHash(brokerConfig.tokenHashKey, "browser_flow", browserSecret),
      browserSessionHash: keyedOAuthSecretHash(brokerConfig.tokenHashKey, "browser_session", browserSecret),
      xeroStateHash: keyedOAuthSecretHash(brokerConfig.tokenHashKey, "xero_state", xeroState),
      now,
    });
    const first = await begin(browserOne, xeroOne);
    const second = await begin(browserTwo, xeroTwo);

    expect(first).toMatchObject({
      clientId: "agent2-client",
      installationId: "installation_shared_1",
      subjectId: "shared-test-installation:installation_shared_1",
    });
    expect(second).toMatchObject({
      clientId: "agent2-client",
      installationId: "installation_shared_2",
      subjectId: "shared-test-installation:installation_shared_2",
    });
    expect(first?.subjectId).not.toBe(second?.subjectId);
  });

  it("returns a strict Work Host directly with the exact code and outer state", () => {
    const response = capturedResponse();
    const returnUrl = `${workRedirectUri}?code=${"z".repeat(43)}&state=work-host-state`;

    sendBrokerHostAuthorizationResult(response.response, {
      manualPersonalPocReturn: false,
      returnUrl,
      hostName: "Work",
    });

    expect(response.redirects).toEqual([returnUrl]);
    expect(response.statuses).toEqual([]);
    expect(response.body).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-security-policy")).toBe(false);
  });

  it("enables the manual return page only for an exact allowlisted Personal POC client", () => {
    const appConfig = config();
    const broker = appConfig.mcpOAuthBroker;
    if (!broker?.enabled) throw new Error("test broker must be enabled");
    expect(shouldUsePersonalPocManualReturn({
      broker,
      personalPoc: true,
      clientId: "agent2-client",
    })).toBe(true);
    expect(shouldUsePersonalPocManualReturn({
      broker,
      personalPoc: true,
      clientId: "work-client",
    })).toBe(false);

    const brokerWithObservedHostCompatibility = {
      ...broker,
      manualReturnClientIds: ["agent2-client", "work-client"],
    };
    expect(shouldUsePersonalPocManualReturn({
      broker: brokerWithObservedHostCompatibility,
      personalPoc: true,
      clientId: "work-client",
    })).toBe(true);
    expect(shouldUsePersonalPocManualReturn({
      broker: brokerWithObservedHostCompatibility,
      personalPoc: false,
      clientId: "work-client",
    })).toBe(false);
  });

  it("keeps Work resource compatibility independent while rejecting a wrong non-empty resource", async () => {
    const appConfig = config();
    const brokerConfig = appConfig.mcpOAuthBroker;
    if (!brokerConfig?.enabled) throw new Error("test broker must be enabled");
    const repository = new InMemoryAccountingRepository();
    const manager = {
      createOAuthClient: vi.fn(() => ({ buildConsentUrl: async () => "https://login.xero.test/authorize" })),
    } as unknown as XeroClientManager;
    const provider = new McpOAuthBrokerProvider({
      config: appConfig,
      repository,
      manager,
      xeroAuthorization: {} as BrokerXeroAuthorizationService,
      tokens: new McpOAuthTokenService({ config: brokerConfig, repository, cipher: retryCipher, clock: () => now }),
      clock: () => now,
    });
    const agent2 = await provider.clientsStore.getClient("agent2-client") as OAuthClientInformationFull;
    const strictHost = await provider.clientsStore.getClient("work-client") as OAuthClientInformationFull;
    const baseParams = {
      state: "host-state",
      scopes: ["xero.read"],
      codeChallenge: pkceS256Challenge(verifier),
    };

    const workAuthorize = capturedResponse();
    await expect(provider.authorize(strictHost, {
      ...baseParams,
      redirectUri: workRedirectUri,
      resource: undefined,
    }, workAuthorize.response)).resolves.toBeUndefined();
    expect(workAuthorize.redirects[0]).toContain("https://login.xero.test/authorize");
    await expect(provider.authorize(agent2, {
      ...baseParams,
      redirectUri,
      resource: new URL("https://xero-mcp.example.test/other"),
    }, capturedResponse().response)).rejects.toMatchObject({ errorCode: "invalid_target" });
    expect(manager.createOAuthClient).toHaveBeenCalledOnce();
  });

  it("fails closed without the explicit Personal POC profile", async () => {
    const appConfig = config(false);
    const brokerConfig = appConfig.mcpOAuthBroker;
    if (!brokerConfig?.enabled) throw new Error("test broker must be enabled");
    const repository = new InMemoryAccountingRepository();
    const provider = new McpOAuthBrokerProvider({
      config: appConfig,
      repository,
      manager: {} as XeroClientManager,
      xeroAuthorization: {} as BrokerXeroAuthorizationService,
      tokens: new McpOAuthTokenService({ config: brokerConfig, repository, cipher: retryCipher, clock: () => now }),
      clock: () => now,
    });
    const client = await provider.clientsStore.getClient("agent2-client") as OAuthClientInformationFull;
    await expect(provider.authorize(client, {
      state: "agent2-host-state",
      scopes: ["xero.read"],
      codeChallenge: pkceS256Challenge(verifier),
      redirectUri,
      resource: new URL(brokerConfig.resourceUri),
    }, capturedResponse().response)).rejects.toMatchObject({ errorCode: "access_denied" });
  });
});
