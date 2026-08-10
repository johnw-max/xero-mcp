import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { AccountingRepository } from "../db/repository.js";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../logging.js";
import type { XeroOAuthService } from "../oauth/xeroOAuthService.js";
import type { McpOAuthBrokerProvider } from "../oauth/mcpOAuthBrokerProvider.js";
import { StaticOAuthClientsStore } from "../oauth/staticOAuthClientsStore.js";
import type { AccountingService } from "../services/accountingService.js";
import type { ConnectionTicketService } from "../services/connectionTicketService.js";
import type { ReviewService } from "../services/reviewService.js";
import {
  beginTicketBoundXeroOAuth,
  completeTicketBoundXeroOAuth,
  createExactOriginCors,
  createHttpApp,
  isReviewOriginAllowed,
  rejectReviewWithAudit,
  renderResultPage,
  renderReviewPage,
  requireAnyVerifiedMcpScope,
  requireLegacySharedBearer,
  reviewCookieOptions,
  safeLogPath,
} from "./app.js";

function corsConfig(): Pick<AppConfig, "allowedOrigins"> {
  return {
    allowedOrigins: ["https://agent2.zcloak.ai"],
  };
}

function exerciseCors(options: {
  path: string;
  method: string;
  origin?: string;
  requestedMethod?: string;
  requestedHeaders?: string;
}) {
  const headers = new Map<string, string>();
  const responseState: { status?: number; body?: unknown; ended: boolean } = { ended: false };
  const response = {
    vary: vi.fn(),
    setHeader: vi.fn((name: string, value: string) => headers.set(name.toLowerCase(), value)),
    status: vi.fn((status: number) => {
      responseState.status = status;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      responseState.body = body;
      return response;
    }),
    end: vi.fn(() => {
      responseState.ended = true;
      return response;
    }),
  } as unknown as Response;
  const request = {
    path: options.path,
    method: options.method,
    headers: {
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.requestedMethod ? { "access-control-request-method": options.requestedMethod } : {}),
      ...(options.requestedHeaders ? { "access-control-request-headers": options.requestedHeaders } : {}),
    },
  } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;

  createExactOriginCors(corsConfig())(request, response, next);
  return { headers, responseState, response, next };
}

function requestContextTestConfig(): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "https://xero-mcp.example.test",
    databaseUrl: "postgres://unused",
    mcpBearerToken: "m".repeat(48),
    allowedOrigins: ["https://work.zcloak.example.test"],
    allowedHosts: ["xero-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    xero: {
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
      scopes: ["offline_access", "accounting.invoices"],
    },
    xeroWriteEnabled: false,
    tokenEncryptionKey: Buffer.alloc(32),
    xeroMutationConfirmationKey: Buffer.alloc(32, 1),
    demoActorId: "trusted-demo-actor",
    logLevel: "error",
  };
}

describe("browser review boundary", () => {
  it("uses Lax so cross-site top-level review navigation carries the secure operator cookie", () => {
    const options = reviewCookieOptions({ nodeEnv: "production" }, new Date("2026-08-03T12:00:00Z"));
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });

  it("requires review mutations to come from the MCP public origin", () => {
    const config = { publicBaseUrl: "https://mcp.jiayuanwang.xyz" };
    expect(isReviewOriginAllowed(config, "https://mcp.jiayuanwang.xyz")).toBe(true);
    expect(isReviewOriginAllowed(config, "https://work.zcloak.ai")).toBe(false);
    expect(isReviewOriginAllowed(config, undefined)).toBe(false);
  });

  it("never includes a one-time connect ticket in the application log path", () => {
    expect(safeLogPath({
      path: "/connect/xero",
      originalUrl: "/connect/xero?ticket=QA_CONNECT_SECRET",
    })).toBe("/connect/xero");
  });

  it("routes a human rejection through the unified audit wrapper", async () => {
    const reject = vi.fn().mockResolvedValue({ postingRequestId: "pr_test", state: "REJECTED" });
    const withAudit = vi.fn(async (options: {
      action: () => Promise<{ postingRequestId: string; state: "REJECTED" }>;
      recordId: (value: { postingRequestId: string }) => string;
    }) => {
      const result = await options.action();
      expect(options.recordId(result)).toBe("pr_test");
      return result;
    });

    await expect(rejectReviewWithAudit({
      accountingService: { withAudit } as unknown as AccountingService,
      reviewService: { reject } as unknown as ReviewService,
      actorId: "demo-actor",
      sessionHash: "session-hash",
      csrfToken: "csrf-token",
      postingRequestId: "pr_test",
    })).resolves.toEqual({ postingRequestId: "pr_test", state: "REJECTED" });

    expect(withAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "demo-actor",
      toolName: "review_reject_supplier_bill",
      input: { postingRequestId: "pr_test" },
    }));
    expect(reject).toHaveBeenCalledWith({
      postingRequestId: "pr_test",
      actorId: "demo-actor",
      sessionHash: "session-hash",
      csrfToken: "csrf-token",
    });
  });

  it("renders the organisation, Tenant and InvoiceID as business review fields", () => {
    const html = renderReviewPage({
      postingRequestId: "pr_review_contract_1234",
      csrfToken: "csrf-contract-token",
      review: {
        postingRequestId: "pr_review_contract_1234",
        state: "APPROVAL_PENDING",
        action: "APPROVE_OR_REJECT",
        tenantName: "Synthetic & Demo Organisation",
        tenantId: "11111111-1111-4111-8111-111111111111",
        invoiceId: "22222222-2222-4222-8222-222222222222",
        xeroBillUrl: "https://go.xero.com/organisationlogin/default.aspx?shortcode=%21Demo1&redirecturl=%2FAccountsPayable%2FEdit.aspx%3FInvoiceID%3D22222222-2222-4222-8222-222222222222",
        bill: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          invoiceId: "22222222-2222-4222-8222-222222222222",
          type: "ACCPAY",
          status: "DRAFT",
          contact: { contactId: "33333333-3333-4333-8333-333333333333", name: "Synthetic supplier" },
          lines: [{
            description: "Synthetic service",
            quantity: "1.0000",
            unitAmount: "100.0000",
            lineAmount: "100.0000",
            accountCode: "404",
            taxType: "NONE",
          }],
          total: "100.0000",
        },
      },
    });

    expect(html).toContain("<dt>Xero organisation</dt><dd>Synthetic &amp; Demo Organisation</dd>");
    expect(html).toContain("<dt>Tenant ID</dt><dd>11111111-1111-4111-8111-111111111111</dd>");
    expect(html).toContain("<dt>Xero Invoice ID</dt><dd>22222222-2222-4222-8222-222222222222</dd>");
    expect(html).toContain("Approve and post to Xero");
    expect(html).toContain("View this bill in Xero");
    expect(html).toContain("Reject");
    expect(html.match(/<form /g)).toHaveLength(2);
  });

  it("renders a verified result with business evidence and a Xero handoff", () => {
    const html = renderResultPage({
      title: "Posted to Xero",
      message: "Exact readback verified.",
      postingRequestId: "pr_result_contract_1234",
      status: "AUTHORISED",
      tenantName: "Synthetic & Demo Organisation",
      tenantId: "11111111-1111-4111-8111-111111111111",
      invoiceId: "22222222-2222-4222-8222-222222222222",
      reference: "ZC-XERO-DEMO-001",
      currency: "SGD",
      total: "109.0000",
      xeroBillUrl: "https://go.xero.com/organisationlogin/default.aspx?shortcode=%21Demo1",
    });

    expect(html).toContain("Synthetic &amp; Demo Organisation");
    expect(html).toContain("ZC-XERO-DEMO-001");
    expect(html).toContain("109.0000");
    expect(html).toContain("View this bill in Xero");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders a missing snapshot safely without a form or CSRF field", () => {
    const html = renderReviewPage({
      postingRequestId: "pr_unverified_contract_1234",
      csrfToken: "must-not-be-rendered",
      review: {
        postingRequestId: "pr_unverified_contract_1234",
        state: "VALIDATED",
        action: "NONE",
        tenantId: "11111111-1111-4111-8111-111111111111",
      },
    });

    expect(html).toContain("Workflow status: VALIDATED");
    expect(html).toContain("No verified Xero bill snapshot is available.");
    expect(html).toContain("No Review action is available.");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("csrf_token");
    expect(html).not.toContain("must-not-be-rendered");
  });

  it("shows only the readback recovery action for a fully bound authorise unknown", () => {
    const html = renderReviewPage({
      postingRequestId: "pr_recovery_contract_1234",
      csrfToken: "recovery-csrf-token",
      review: {
        postingRequestId: "pr_recovery_contract_1234",
        state: "WRITE_RESULT_UNKNOWN",
        action: "RECOVER_AUTHORISE",
        tenantName: "Synthetic Demo Organisation",
        tenantId: "11111111-1111-4111-8111-111111111111",
        invoiceId: "22222222-2222-4222-8222-222222222222",
        bill: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          invoiceId: "22222222-2222-4222-8222-222222222222",
          type: "ACCPAY",
          status: "DRAFT",
          contact: { contactId: "33333333-3333-4333-8333-333333333333" },
          lines: [],
        },
      },
    });

    expect(html).toContain("Check Xero status safely");
    expect(html).toContain("will not submit another write");
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).not.toContain(">Reject<");
  });
});

describe("exact-origin browser CORS boundary", () => {
  it("adds readable challenge headers only for an exact configured origin", () => {
    const allowed = exerciseCors({
      path: "/healthz",
      method: "GET",
      origin: "https://agent2.zcloak.ai",
    });
    expect(allowed.next).toHaveBeenCalledOnce();
    expect(allowed.response.vary).toHaveBeenCalledWith("Origin");
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://agent2.zcloak.ai");
    expect(allowed.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate, Mcp-Session-Id, Retry-After",
    );
    expect(allowed.headers.has("access-control-allow-credentials")).toBe(false);

    const denied = exerciseCors({
      path: "/healthz",
      method: "GET",
      origin: "https://evil.invalid",
    });
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.response.status).toHaveBeenCalledWith(403);
    expect(denied.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("leaves origin-less server-to-server requests usable without emitting CORS headers", () => {
    const result = exerciseCors({ path: "/mcp", method: "POST" });
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.headers.has("access-control-allow-origin")).toBe(false);
    expect(result.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it.each([
    ["/healthz", "GET"],
    ["/readyz", "GET"],
    ["/.well-known/oauth-authorization-server", "GET"],
    ["/.well-known/oauth-protected-resource", "GET"],
    ["/.well-known/oauth-protected-resource/mcp", "GET"],
    ["/mcp", "POST"],
  ])("terminates an allowed %s %s preflight before auth or route handling", (path, requestedMethod) => {
    const result = exerciseCors({
      path,
      method: "OPTIONS",
      origin: "https://agent2.zcloak.ai",
      requestedMethod,
      requestedHeaders: "authorization, content-type, mcp-protocol-version",
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.status).toHaveBeenCalledWith(204);
    expect(result.response.end).toHaveBeenCalledOnce();
    expect(result.headers.get("access-control-allow-origin")).toBe("https://agent2.zcloak.ai");
    expect(result.headers.get("access-control-allow-methods")).toContain(requestedMethod);
    expect(result.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(result.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(result.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");
    expect(result.headers.get("access-control-max-age")).toBe("600");
    expect(result.headers.has("access-control-allow-credentials")).toBe(false);
  });

  it("rejects credential-bearing preflight headers and never enables cookies", () => {
    const result = exerciseCors({
      path: "/mcp",
      method: "OPTIONS",
      origin: "https://agent2.zcloak.ai",
      requestedMethod: "POST",
      requestedHeaders: "authorization, content-type, cookie",
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.status).toHaveBeenCalledWith(403);
    expect(result.headers.has("access-control-allow-credentials")).toBe(false);
    expect(result.headers.get("access-control-allow-headers")).toBeUndefined();
  });

  it.each(["/authorize", "/token", "/revoke", "/oauth/xero/callback", "/oauth/xero/select"])(
    "does not expose the sensitive endpoint %s through browser CORS",
    (path) => {
      const result = exerciseCors({
        path,
        method: "POST",
        origin: "https://agent2.zcloak.ai",
      });
      expect(result.next).toHaveBeenCalledOnce();
      expect(result.response.vary).not.toHaveBeenCalled();
      expect(result.headers.has("access-control-allow-origin")).toBe(false);
    },
  );

  it("does not make review mutations cross-origin CORS resources", () => {
    const result = exerciseCors({
      path: "/review/pr_example/approve",
      method: "POST",
      origin: "https://agent2.zcloak.ai",
    });
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.response.vary).not.toHaveBeenCalled();
    expect(result.headers.has("access-control-allow-origin")).toBe(false);
    expect(isReviewOriginAllowed(
      { publicBaseUrl: "https://xero-mcp.example.test" },
      "https://agent2.zcloak.ai",
    )).toBe(false);
  });
});

describe("MCP request context boundary", () => {
  it("accepts either documented MCP capability at the authenticated HTTP edge", () => {
    const middleware = requireAnyVerifiedMcpScope({
      supportedScopes: ["xero.read", "xero.draft.write"],
      resourceMetadataUrl: "https://xero-mcp.example.test/.well-known/oauth-protected-resource/mcp",
    });
    for (const scopes of [["xero.read"], ["xero.draft.write"]]) {
      const request = { auth: { scopes } } as unknown as Request;
      const response = { set: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as Response;
      const next = vi.fn() as unknown as NextFunction;
      middleware(request, response, next);
      expect(next, scopes[0]).toHaveBeenCalledOnce();
      expect(response.status, scopes[0]).not.toHaveBeenCalled();
    }
  });

  it("rejects an authenticated token that has no supported MCP capability", () => {
    const middleware = requireAnyVerifiedMcpScope({
      supportedScopes: ["xero.read", "xero.draft.write"],
      resourceMetadataUrl: "https://xero-mcp.example.test/.well-known/oauth-protected-resource/mcp",
    });
    const response = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    middleware({ auth: { scopes: ["unrelated.scope"] } } as unknown as Request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: "insufficient_scope" }));
    expect(response.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining("resource_metadata="),
    );
  });

  it("ignores forged identity headers and generates a unique trusted context per request", () => {
    const config = requestContextTestConfig();
    const middleware = requireLegacySharedBearer(config);
    const forgedHeaders = {
      authorization: `Bearer ${config.mcpBearerToken}`,
      "x-actor-id": "forged-actor",
      "x-user-id": "forged-user",
      "x-workspace-id": "forged-workspace",
      "x-agent-id": "forged-agent",
      "x-conversation-id": "forged-conversation",
      "x-oauth-installation-id": "forged-installation",
      "x-binding-id": "forged-binding",
      "x-connection-id": "forged-connection",
      "x-tenant-id": "forged-tenant",
      "x-roles": "admin",
    };
    const request = { headers: forgedHeaders } as unknown as Request;
    const firstResponse = { locals: {} } as unknown as Response;
    const secondResponse = { locals: {} } as unknown as Response;
    const firstNext = vi.fn() as unknown as NextFunction;
    const secondNext = vi.fn() as unknown as NextFunction;

    middleware(request, firstResponse, firstNext);
    middleware(request, secondResponse, secondNext);

    const first = firstResponse.locals.requestContext;
    const second = secondResponse.locals.requestContext;
    expect(firstNext).toHaveBeenCalledOnce();
    expect(secondNext).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      actorId: "trusted-demo-actor",
      roles: [],
      legacyDemo: true,
      authn: {
        issuer: "urn:xero-accounting-mcp:legacy-demo",
        subject: "legacy-demo:trusted-demo-actor",
        audience: "https://xero-mcp.example.test/mcp",
        tokenId: "legacy-demo-shared-bearer",
      },
    });
    expect(first).not.toHaveProperty("workspaceId");
    expect(first).not.toHaveProperty("userId");
    expect(first).not.toHaveProperty("agentId");
    expect(first).not.toHaveProperty("conversationId");
    expect(first).not.toHaveProperty("oauthInstallationId");
    expect(first).not.toHaveProperty("bindingId");
    expect(first).not.toHaveProperty("connectionId");
    expect(first.requestId).not.toBe(second.requestId);
  });

  it("fails startup closed when Broker OAuth is enabled without its provider", () => {
    const config = requestContextTestConfig();
    config.mcpOAuthBroker = {
      enabled: true,
      issuer: config.publicBaseUrl,
      resourceUri: `${config.publicBaseUrl}/mcp`,
      protectedResourceUris: [`${config.publicBaseUrl}/mcp`],
      authorizationPath: "/authorize",
      tokenPath: "/token",
      revocationPath: "/revoke",
      authorizationEndpoint: `${config.publicBaseUrl}/authorize`,
      tokenEndpoint: `${config.publicBaseUrl}/token`,
      revocationEndpoint: `${config.publicBaseUrl}/revoke`,
      scopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: true,
      hostClients: [{
        name: "Agent2",
        clientId: "agent2-client",
        clientSecret: "s".repeat(43),
        redirectUris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
      }],
      missingResourceCompatClientIds: [],
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      authorizationCodeTtlSeconds: 300,
      browserFlowTtlSeconds: 600,
      tokenHashKey: Buffer.alloc(32, 1),
      cookieStateKey: Buffer.alloc(32, 2),
    };

    expect(() => createHttpApp({
      config,
      repository: {} as AccountingRepository,
      accountingService: {} as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger: {} as Logger,
    })).toThrow(/requires its provider/i);
  });

  it("mounts the Broker selection callback and removes the legacy ticket connect route", () => {
    const config = requestContextTestConfig();
    const hostClients = [{
      name: "Agent2",
      clientId: "agent2-client",
      clientSecret: "s".repeat(43),
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
    }];
    config.mcpOAuthBroker = {
      enabled: true,
      issuer: config.publicBaseUrl,
      resourceUri: `${config.publicBaseUrl}/mcp`,
      protectedResourceUris: [`${config.publicBaseUrl}/mcp`],
      authorizationPath: "/authorize",
      tokenPath: "/token",
      revocationPath: "/revoke",
      authorizationEndpoint: `${config.publicBaseUrl}/authorize`,
      tokenEndpoint: `${config.publicBaseUrl}/token`,
      revocationEndpoint: `${config.publicBaseUrl}/revoke`,
      scopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: true,
      hostClients,
      missingResourceCompatClientIds: [],
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      authorizationCodeTtlSeconds: 300,
      browserFlowTtlSeconds: 600,
      tokenHashKey: Buffer.alloc(32, 1),
      cookieStateKey: Buffer.alloc(32, 2),
    };
    const clientsStore = new StaticOAuthClientsStore(hostClients, ["xero.read", "xero.draft.write"]);
    const mcpOAuthProvider = {
      clientsStore,
      skipLocalPkceValidation: true,
      authorize: vi.fn(),
      challengeForAuthorizationCode: vi.fn(),
      exchangeAuthorizationCode: vi.fn(),
      exchangeRefreshToken: vi.fn(),
      verifyAccessToken: vi.fn(),
      revokeToken: vi.fn(),
      handleXeroCallback: vi.fn(),
      handleOrganisationSelection: vi.fn(),
    } as unknown as McpOAuthBrokerProvider;
    const app = createHttpApp({
      config,
      repository: {} as AccountingRepository,
      accountingService: {} as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger: {} as Logger,
      mcpOAuthProvider,
    });
    const stack = (app as unknown as {
      router: { stack: Array<{ route?: { path?: string } }> };
    }).router.stack;
    const paths = stack.map((layer) => layer.route?.path).filter((path): path is string => typeof path === "string");

    expect(paths).toContain("/oauth/xero/callback");
    expect(paths).toContain("/oauth/xero/select");
    expect(paths).not.toContain("/connect/xero");
  });
});

describe("ticket-bound Xero OAuth identity boundary", () => {
  it("does not expose a Bearer-to-browser-session or standalone OAuth-start route", () => {
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "https://xero-mcp.example.test",
      databaseUrl: "postgres://unused",
      mcpBearerToken: "m".repeat(48),
      allowedOrigins: ["https://work.zcloak.example.test"],
      allowedHosts: ["xero-mcp.example.test"],
      requestBodyLimitBytes: 1_048_576,
      xero: {
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
        scopes: ["offline_access", "accounting.invoices"],
      },
      xeroWriteEnabled: false,
      tokenEncryptionKey: Buffer.alloc(32),
      xeroMutationConfirmationKey: Buffer.alloc(32, 1),
      demoActorId: "demo-actor",
      logLevel: "error",
    };
    const app = createHttpApp({
      config,
      repository: {} as AccountingRepository,
      accountingService: {} as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger: {} as Logger,
    });
    const stack = (app as unknown as {
      router: { stack: Array<{ route?: { path?: string } }> };
    }).router.stack;
    const paths = stack.map((layer) => layer.route?.path).filter((path): path is string => typeof path === "string");

    expect(paths).toContain("/connect/xero");
    expect(paths).toContain("/oauth/xero/callback");
    expect(paths).not.toContain("/operator/session");
    expect(paths).not.toContain("/oauth/xero/start");
  });

  it("derives the OAuth actor only from the consumed one-time connect ticket", async () => {
    const consume = vi.fn().mockResolvedValue({ actorId: "ticket-actor" });
    const start = vi.fn().mockResolvedValue("https://login.xero.test/consent");

    await expect(beginTicketBoundXeroOAuth({
      ticket: "one-time-ticket",
      browserSession: "browser-bound-secret",
      connectionTickets: { consume } as unknown as ConnectionTicketService,
      oauthService: { start } as unknown as XeroOAuthService,
    })).resolves.toEqual({ consentUrl: "https://login.xero.test/consent" });

    expect(consume).toHaveBeenCalledWith("one-time-ticket");
    expect(start).toHaveBeenCalledWith("ticket-actor", "browser-bound-secret");
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0] as number);
  });

  it("creates the review session only after a successful callback and for its returned actor", async () => {
    const callback = vi.fn().mockResolvedValue({
      actorId: "oauth-state-actor",
      tenantId: "tenant-1",
      tenantName: "Demo Org",
      scopes: ["accounting.invoices"],
    });
    const createOperatorSession = vi.fn().mockResolvedValue({
      session: "review-session",
      expiresAt: new Date("2026-08-04T00:00:00Z"),
    });

    const result = await completeTicketBoundXeroOAuth({
      state: "state",
      browserSession: "browser-bound-secret",
      queryString: "code=success&state=state",
      oauthService: { callback } as unknown as XeroOAuthService,
      reviewService: { createOperatorSession } as unknown as ReviewService,
    });

    expect(createOperatorSession).toHaveBeenCalledWith("oauth-state-actor");
    expect(callback.mock.invocationCallOrder[0]).toBeLessThan(createOperatorSession.mock.invocationCallOrder[0] as number);
    expect(result.reviewSession.session).toBe("review-session");
  });

  it("never creates a review session when Xero denies or the callback fails", async () => {
    const callback = vi.fn().mockRejectedValue(new Error("access_denied"));
    const createOperatorSession = vi.fn();

    await expect(completeTicketBoundXeroOAuth({
      state: "state",
      browserSession: "browser-bound-secret",
      queryString: "error=access_denied&state=state",
      oauthService: { callback } as unknown as XeroOAuthService,
      reviewService: { createOperatorSession } as unknown as ReviewService,
    })).rejects.toThrow("access_denied");

    expect(createOperatorSession).not.toHaveBeenCalled();
  });
});
