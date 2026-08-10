import type { Server } from "node:http";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_SCOPES, type AppConfig } from "../src/config.js";
import type { AccountingRepository } from "../src/db/repository.js";
import { createHttpApp } from "../src/http/app.js";
import type { Logger } from "../src/logging.js";
import { TOOL_ALLOWLIST } from "../src/mcp/toolNames.js";
import type { McpOAuthBrokerProvider } from "../src/oauth/mcpOAuthBrokerProvider.js";
import { StaticOAuthClientsStore } from "../src/oauth/staticOAuthClientsStore.js";
import type { XeroOAuthService } from "../src/oauth/xeroOAuthService.js";
import type { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import type { ReviewService } from "../src/services/reviewService.js";
import type { OrganisationSwitchService } from "../src/services/organisationSwitchService.js";
import { XERO_RELEASE_VERSION } from "../src/xeroRelease.js";

const issuer = "https://xero-mcp.example.test";
const hostClients = [{
  name: "Agent2",
  clientId: "agent2-client",
  clientSecret: "s".repeat(43),
  redirectUris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
}];

function config(): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: issuer,
    databaseUrl: "postgres://unused",
    mcpBearerToken: "legacy".repeat(8),
    allowedOrigins: ["https://agent2.zcloak.ai"],
    allowedHosts: ["xero-mcp.example.test"],
    requestBodyLimitBytes: 1_048_576,
    xero: {
      clientId: "xero-client",
      clientSecret: "xero-secret",
      redirectUri: `${issuer}/oauth/xero/callback`,
      scopes: ["offline_access", "accounting.invoices"],
    },
    xeroWriteEnabled: false,
    tokenEncryptionKey: Buffer.alloc(32, 3),
    mcpOAuthBroker: {
      enabled: true,
      issuer,
      resourceUri: `${issuer}/mcp`,
      protectedResourceUris: [`${issuer}/mcp`],
      authorizationPath: "/authorize",
      tokenPath: "/token",
      revocationPath: "/revoke",
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      revocationEndpoint: `${issuer}/revoke`,
      scopes: MCP_OAUTH_SCOPES,
      personalPocOnly: true,
      hostClients,
      missingResourceCompatClientIds: [],
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      authorizationCodeTtlSeconds: 300,
      browserFlowTtlSeconds: 600,
      tokenHashKey: Buffer.alloc(32, 1),
      cookieStateKey: Buffer.alloc(32, 2),
    },
    demoActorId: "personal-poc-user",
    logLevel: "error",
  };
}

async function parseMcp(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    return JSON.parse((data.at(-1) as string).slice(5).trim()) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("HTTP OAuth edge", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
  });

  const loopbackIt = process.env.TEST_HTTP_LOOPBACK === "true" ? it : it.skip;
  loopbackIt("serves a private organisation picker and requires exact same-origin confirmation", async () => {
    const baseConfig = config();
    const { mcpOAuthBroker: _mcpOAuthBroker, ...withoutBroker } = baseConfig;
    const appConfig: AppConfig = {
      ...withoutBroker,
      allowedHosts: ["127.0.0.1", "localhost"],
    };
    const getPage = vi.fn().mockResolvedValue({
      currentOrganisation: {
        connectionId: "connection-a",
        tenantId: "tenant-a",
        tenantName: "Company A",
        current: true,
      },
      organisations: [{
        connectionId: "connection-b",
        tenantId: "tenant-b",
        tenantName: "Company B",
        current: false,
      }],
      csrfToken: "csrf-switch",
      expiresAt: new Date("2026-08-10T05:10:00.000Z"),
    });
    const confirm = vi.fn().mockResolvedValue({
      status: "SWITCHED",
      currentOrganisation: {
        connectionId: "connection-b",
        tenantId: "tenant-b",
        tenantName: "Company B",
        current: true,
      },
    });
    const app = createHttpApp({
      config: appConfig,
      repository: { readiness: vi.fn().mockResolvedValue(true) } as unknown as AccountingRepository,
      accountingService: {} as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      organisationSwitchService: { getPage, confirm } as unknown as OrganisationSwitchService,
    });
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1");
      listening.once("listening", () => resolve(listening));
      listening.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    const local = `http://127.0.0.1:${address.port}`;

    const page = await fetch(`${local}/xero/organisation-switch?ticket=${"t".repeat(43)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(await page.text()).toContain("Company B");

    const wrongOrigin = await fetch(`${local}/xero/organisation-switch`, {
      method: "POST",
      headers: { Origin: "https://agent2.zcloak.ai", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: "t".repeat(43), csrf_token: "csrf-switch", connection_id: "connection-b" }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(confirm).not.toHaveBeenCalled();

    const confirmed = await fetch(`${local}/xero/organisation-switch`, {
      method: "POST",
      headers: { Origin: issuer, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: "t".repeat(43), csrf_token: "csrf-switch", connection_id: "connection-b" }),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toContain("no-store");
    expect(await confirmed.text()).toContain("Company B");
    expect(confirm).toHaveBeenCalledWith({
      ticket: "t".repeat(43),
      csrfToken: "csrf-switch",
      selectedConnectionId: "connection-b",
    });
  });

  loopbackIt("publishes exact discovery and challenges /mcp instead of accepting the legacy bearer", async () => {
    const clientsStore = new StaticOAuthClientsStore(hostClients, MCP_OAUTH_SCOPES);
    const provider = {
      clientsStore,
      skipLocalPkceValidation: true,
      authorize: vi.fn(),
      challengeForAuthorizationCode: vi.fn(),
      exchangeAuthorizationCode: vi.fn(async () => ({
        access_token: "issued-access-token",
        token_type: "Bearer" as const,
        expires_in: 900,
        refresh_token: "issued-refresh-token",
        refresh_token_expires_in: 2_592_000,
      })),
      exchangeRefreshToken: vi.fn(async () => ({
        access_token: "refreshed-access-token",
        token_type: "Bearer" as const,
        expires_in: 900,
        refresh_token: "refreshed-refresh-token",
        refresh_token_expires_in: 2_592_000,
      })),
      verifyAccessToken: vi.fn(async () => {
        throw new InvalidTokenError("The access token is invalid.");
      }),
      revokeToken: vi.fn(async () => {}),
      handleXeroCallback: vi.fn(),
      handleOrganisationSelection: vi.fn(),
    } as unknown as McpOAuthBrokerProvider;
    const readiness = vi.fn().mockResolvedValue(true);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const app = createHttpApp({
      config: config(),
      repository: { readiness } as unknown as AccountingRepository,
      accountingService: {} as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger,
      mcpOAuthProvider: provider,
    });
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1");
      listening.once("listening", () => resolve(listening));
      listening.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    const local = `http://127.0.0.1:${address.port}`;
    const agent2Origin = "https://agent2.zcloak.ai";

    const health = await fetch(`${local}/healthz`, { headers: { Origin: agent2Origin } });
    expect(health.status).toBe(200);
    await expect(health.clone().json()).resolves.toMatchObject({
      status: "ok",
      version: XERO_RELEASE_VERSION,
      toolCount: TOOL_ALLOWLIST.length,
    });
    expect(health.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(health.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate, Mcp-Session-Id, Retry-After",
    );
    expect(health.headers.get("access-control-allow-credentials")).toBeNull();
    expect(health.headers.get("vary")).toContain("Origin");

    const ready = await fetch(`${local}/readyz`, { headers: { Origin: agent2Origin } });
    expect(ready.status).toBe(200);
    await expect(ready.clone().json()).resolves.toEqual({ status: "ready", version: XERO_RELEASE_VERSION });
    expect(ready.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(ready.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(ready.headers.get("access-control-allow-credentials")).toBeNull();
    expect(readiness).toHaveBeenCalledOnce();

    const healthHead = await fetch(`${local}/healthz`, { method: "HEAD", headers: { Origin: agent2Origin } });
    expect(healthHead.status).toBe(200);
    expect(healthHead.headers.get("access-control-allow-origin")).toBe(agent2Origin);

    for (const rejectedOrigin of [
      "https://evil.invalid",
      "null",
      "https://agent2.zcloak.ai.evil.invalid",
      "https://agent2.zcloak.ai/",
    ]) {
      const wrongOrigin = await fetch(`${local}/healthz`, { headers: { Origin: rejectedOrigin } });
      expect(wrongOrigin.status, rejectedOrigin).toBe(403);
      expect(wrongOrigin.headers.get("access-control-allow-origin"), rejectedOrigin).toBeNull();
      expect(wrongOrigin.headers.get("access-control-allow-credentials"), rejectedOrigin).toBeNull();
    }

    const serverToServer = await fetch(`${local}/healthz`);
    expect(serverToServer.status).toBe(200);
    expect(serverToServer.headers.get("access-control-allow-origin")).toBeNull();

    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/readyz", "GET"],
      ["/.well-known/oauth-authorization-server", "GET"],
      ["/.well-known/oauth-protected-resource", "GET"],
      ["/.well-known/oauth-protected-resource/mcp", "GET"],
      ["/mcp", "POST"],
    ] as const) {
      const preflight = await fetch(`${local}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: agent2Origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
        },
      });
      expect(preflight.status, `${path} preflight`).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin"), `${path} origin`).toBe(agent2Origin);
      expect(preflight.headers.get("access-control-allow-methods"), `${path} methods`).toContain(method);
      expect(preflight.headers.get("access-control-allow-headers"), `${path} headers`).toContain("Authorization");
      expect(preflight.headers.get("access-control-allow-headers"), `${path} session header`).toContain("Mcp-Session-Id");
      expect(preflight.headers.get("access-control-allow-credentials"), `${path} credentials`).toBeNull();
      expect(preflight.headers.get("access-control-allow-origin"), `${path} wildcard`).not.toBe("*");
    }
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();

    const credentialPreflight = await fetch(`${local}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: agent2Origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, cookie",
      },
    });
    expect(credentialPreflight.status).toBe(403);
    expect(credentialPreflight.headers.get("access-control-allow-credentials")).toBeNull();

    for (const path of ["/token", "/revoke"] as const) {
      const sensitivePreflight = await fetch(`${local}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: agent2Origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(sensitivePreflight.status, `${path} preflight status`).toBe(405);
      expect(sensitivePreflight.headers.get("access-control-allow-origin"), `${path} preflight origin`).toBeNull();
      expect(sensitivePreflight.headers.get("access-control-allow-credentials"), `${path} preflight credentials`).toBeNull();

      const browserExchange = await fetch(`${local}${path}`, {
        method: "POST",
        headers: {
          Origin: agent2Origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: "unknown-agent2-client",
          client_secret: "invalid-client-secret",
          ...(path === "/token" ? { grant_type: "authorization_code", code: "invalid-code" } : { token: "invalid-token" }),
        }),
      });
      expect(browserExchange.status, `${path} browser exchange`).toBe(403);
      expect(browserExchange.headers.get("access-control-allow-origin"), `${path} browser origin`).toBeNull();
      expect(browserExchange.headers.get("access-control-allow-credentials"), `${path} browser credentials`).toBeNull();
    }

    const confidentialToken = await fetch(`${local}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: hostClients[0].clientId,
        client_secret: hostClients[0].clientSecret,
        grant_type: "authorization_code",
        code: "server-side-code",
        code_verifier: "server-side-verifier",
      }),
    });
    expect(confidentialToken.status).toBe(200);
    expect(confidentialToken.headers.get("access-control-allow-origin")).toBeNull();
    expect(confidentialToken.headers.get("access-control-allow-credentials")).toBeNull();
    await expect(confidentialToken.json()).resolves.toMatchObject({
      access_token: "issued-access-token",
      refresh_token: "issued-refresh-token",
      expires_in: 900,
      refresh_token_expires_in: 2_592_000,
    });

    const basicAuthorization = `Basic ${Buffer.from(
      `${hostClients[0].clientId}:${hostClients[0].clientSecret}`,
      "utf8",
    ).toString("base64")}`;
    const confidentialBasicToken = await fetch(`${local}/token`, {
      method: "POST",
      headers: {
        Authorization: basicAuthorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "server-side-basic-code",
        code_verifier: "server-side-basic-verifier",
      }),
    });
    expect(confidentialBasicToken.status).toBe(200);
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledTimes(2);

    for (const [label, authorization, body] of [
      [
        "wrong Basic secret",
        `Basic ${Buffer.from(`${hostClients[0].clientId}:wrong-secret`, "utf8").toString("base64")}`,
        new URLSearchParams({ grant_type: "authorization_code", code: "wrong-secret-code", code_verifier: "verifier" }),
      ],
      [
        "malformed Basic header",
        "Basic %%%",
        new URLSearchParams({ grant_type: "authorization_code", code: "malformed-code", code_verifier: "verifier" }),
      ],
      [
        "mixed Basic and post",
        basicAuthorization,
        new URLSearchParams({
          client_id: hostClients[0].clientId,
          client_secret: hostClients[0].clientSecret,
          grant_type: "authorization_code",
          code: "mixed-code",
          code_verifier: "verifier",
        }),
      ],
    ] as const) {
      const rejected = await fetch(`${local}/token`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      expect(rejected.status, label).toBe(401);
      expect(rejected.headers.get("www-authenticate"), label).toBe(
        'Basic realm="oauth-token", charset="UTF-8"',
      );
      await expect(rejected.json(), label).resolves.toEqual({
        error: "invalid_client",
        error_description: "OAuth client authentication failed.",
      });
    }
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledTimes(2);

    const confidentialRevoke = await fetch(`${local}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: hostClients[0].clientId,
        client_secret: hostClients[0].clientSecret,
        token: "server-side-token",
      }),
    });
    expect(confidentialRevoke.status).toBe(200);
    expect(confidentialRevoke.headers.get("access-control-allow-origin")).toBeNull();
    expect(confidentialRevoke.headers.get("access-control-allow-credentials")).toBeNull();

    const confidentialBasicRevoke = await fetch(`${local}/revoke`, {
      method: "POST",
      headers: {
        Authorization: basicAuthorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: "server-side-basic-token" }),
    });
    expect(confidentialBasicRevoke.status).toBe(200);
    expect(provider.revokeToken).toHaveBeenCalledTimes(2);

    const reviewPreflight = await fetch(`${local}/review/pr_cors_contract_1234/approve`, {
      method: "OPTIONS",
      headers: {
        Origin: agent2Origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(reviewPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const reviewMutation = await fetch(`${local}/review/pr_cors_contract_1234/approve`, {
      method: "POST",
      headers: { Origin: agent2Origin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(reviewMutation.status).toBe(403);
    expect(reviewMutation.headers.get("access-control-allow-origin")).toBeNull();

    for (const [path, method] of [
      ["/authorize", "GET"],
      ["/oauth/xero/callback", "GET"],
      ["/oauth/xero/select", "POST"],
      ["/connect/xero", "GET"],
    ] as const) {
      const sensitivePreflight = await fetch(`${local}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: agent2Origin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(sensitivePreflight.headers.get("access-control-allow-origin"), `${path} origin`).toBeNull();
      expect(sensitivePreflight.headers.get("access-control-allow-credentials"), `${path} credentials`).toBeNull();
    }

    const authorizationMetadata = await fetch(`${local}/.well-known/oauth-authorization-server`, {
      headers: { Origin: agent2Origin },
    });
    expect(authorizationMetadata.status).toBe(200);
    expect(authorizationMetadata.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(authorizationMetadata.headers.get("access-control-allow-origin")).not.toBe("*");
    await expect(authorizationMetadata.json()).resolves.toMatchObject({
      issuer: `${issuer}/`,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      protected_resources: [`${issuer}/mcp`],
    });

    const resourceMetadata = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`, {
      headers: { Origin: agent2Origin },
    });
    expect(resourceMetadata.status).toBe(200);
    expect(resourceMetadata.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(resourceMetadata.headers.get("access-control-allow-origin")).not.toBe("*");
    await expect(resourceMetadata.json()).resolves.toEqual({
      resource: `${issuer}/mcp`,
      authorization_servers: [`${issuer}/`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["xero.read", "xero.draft.write"],
      resource_name: "zCloak Xero Accounting MCP",
    });

    const rootResourceMetadata = await fetch(`${local}/.well-known/oauth-protected-resource`, {
      headers: { Origin: agent2Origin },
    });
    expect(rootResourceMetadata.status).toBe(200);
    expect(rootResourceMetadata.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(rootResourceMetadata.headers.get("access-control-allow-origin")).not.toBe("*");

    const rejectedMcpOrigin = await fetch(`${local}/mcp`, {
      headers: {
        Origin: "https://agent2.zcloak.ai.evil.invalid",
        Authorization: "Bearer attacker-token",
      },
    });
    expect(rejectedMcpOrigin.status).toBe(403);
    expect(rejectedMcpOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();

    const oversized = await fetch(`${local}/mcp`, {
      method: "POST",
      headers: { Origin: agent2Origin, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1_048_576) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(oversized.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(oversized.headers.get("access-control-allow-credentials")).toBeNull();

    const missing = await fetch(`${local}/mcp`, { headers: { Origin: agent2Origin } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("access-control-allow-origin")).toBe(agent2Origin);
    expect(missing.headers.get("access-control-expose-headers")).toBe(
      "WWW-Authenticate, Mcp-Session-Id, Retry-After",
    );
    expect(missing.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(missing.headers.get("access-control-allow-credentials")).toBeNull();
    expect(missing.headers.get("www-authenticate")).toContain(
      `resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
    );

    const legacy = await fetch(`${local}/mcp`, {
      headers: { authorization: `Bearer ${config().mcpBearerToken}` },
    });
    expect(legacy.status).toBe(401);
    expect(provider.verifyAccessToken).toHaveBeenCalledWith(config().mcpBearerToken);
  });

  loopbackIt("accepts a draft-write-only token at the edge while read tools still require xero.read", async () => {
    const clientsStore = new StaticOAuthClientsStore(hostClients, MCP_OAUTH_SCOPES);
    const provider = {
      clientsStore,
      skipLocalPkceValidation: true,
      authorize: vi.fn(),
      challengeForAuthorizationCode: vi.fn(),
      exchangeAuthorizationCode: vi.fn(),
      exchangeRefreshToken: vi.fn(),
      verifyAccessToken: vi.fn(async () => ({
        token: "write-only-access-token",
        clientId: "agent2-client",
        scopes: ["xero.draft.write"],
        expiresAt: Math.floor(Date.now() / 1_000) + 900,
        resource: new URL(`${issuer}/mcp`),
        extra: {
          credentialId: "credential-write-only",
          installationId: "installation-write-only",
          bindingId: "binding-write-only",
          connectionId: "connection-write-only",
          authorizationId: "authorization-write-only",
          workspaceId: "workspace-write-only",
          subjectType: "USER",
          subjectId: "user-write-only",
          agentId: "agent-write-only",
          policyId: "policy-write-only",
          tenantId: "tenant-write-only",
        },
      })),
      revokeToken: vi.fn(),
      handleXeroCallback: vi.fn(),
      handleOrganisationSelection: vi.fn(),
    } as unknown as McpOAuthBrokerProvider;
    const app = createHttpApp({
      config: config(),
      repository: { readiness: vi.fn().mockResolvedValue(true) } as unknown as AccountingRepository,
      accountingService: {
        withAudit: vi.fn(async ({ action }: { action: () => Promise<unknown> }) => action()),
      } as unknown as AccountingService,
      oauthService: {} as XeroOAuthService,
      reviewService: {} as ReviewService,
      connectionTickets: {} as ConnectionTicketService,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger,
      mcpOAuthProvider: provider,
    });
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1");
      listening.once("listening", () => resolve(listening));
      listening.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    const local = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: "Bearer write-only-access-token",
      Origin: "https://agent2.zcloak.ai",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    };
    const initialize = await fetch(`${local}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "write-only-edge-test", version: "0.1.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    const initializePayload = await parseMcp(initialize) as {
      result?: { serverInfo?: { version?: string } };
    };
    expect(initializePayload.result?.serverInfo?.version).toBe(XERO_RELEASE_VERSION);

    const readAttempt = await fetch(`${local}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "xero_connection_status", arguments: {} },
      }),
    });
    expect(readAttempt.status).toBe(200);
    const readPayload = await parseMcp(readAttempt);
    expect(JSON.stringify(readPayload)).toContain("xero.read");
    expect(JSON.stringify(readPayload)).toContain("FORBIDDEN");
  });
});
