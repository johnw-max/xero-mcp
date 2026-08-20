import type { NextFunction, Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_SCOPES, type McpOAuthBrokerConfig } from "../src/config.js";
import {
  createMcpOAuthRouter,
  oauthMetadataForBroker,
  protectedResourceMetadataForBroker,
  requireServerToServerOAuthExchange,
} from "../src/oauth/mcpOAuthRouter.js";
import { StaticOAuthClientsStore } from "../src/oauth/staticOAuthClientsStore.js";

const enabledConfig: Extract<McpOAuthBrokerConfig, { enabled: true }> = {
  enabled: true,
  issuer: "https://xero-mcp.example.test",
  resourceUri: "https://xero-mcp.example.test/mcp",
  protectedResourceUris: ["https://xero-mcp.example.test/mcp"],
  authorizationEndpoint: "https://xero-mcp.example.test/authorize",
  tokenEndpoint: "https://xero-mcp.example.test/token",
  revocationEndpoint: "https://xero-mcp.example.test/revoke",
  scopes: MCP_OAUTH_SCOPES,
  personalPocOnly: true,
  hostClients: [{
    name: "Agent2",
    clientId: "agent2-client",
    clientSecret: "a".repeat(43),
    redirectUris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
  }],
  missingResourceCompatClientIds: [],
  manualReturnClientIds: [],
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  authorizationCodeTtlSeconds: 300,
  browserFlowTtlSeconds: 600,
  tokenHashKey: Buffer.alloc(32, 1),
  cookieStateKey: Buffer.alloc(32, 2),
};

function provider(dynamicRegistration = false): OAuthServerProvider {
  const clientsStore = new StaticOAuthClientsStore(enabledConfig.hostClients, enabledConfig.scopes);
  if (dynamicRegistration) {
    Object.defineProperty(clientsStore, "registerClient", {
      value: async () => ({ client_id: "dynamic", redirect_uris: ["https://example.test/callback"] }),
    });
  }
  return {
    clientsStore,
    skipLocalPkceValidation: true,
    authorize: async (_client: OAuthClientInformationFull, _params: AuthorizationParams, _res: Response) => {},
    challengeForAuthorizationCode: async () => "challenge",
    exchangeAuthorizationCode: async (): Promise<OAuthTokens> => ({ access_token: "token", token_type: "Bearer" }),
    exchangeRefreshToken: async (): Promise<OAuthTokens> => ({ access_token: "token", token_type: "Bearer" }),
    verifyAccessToken: async (): Promise<AuthInfo> => ({ token: "token", clientId: "client", scopes: [] }),
    revokeToken: async (_client: OAuthClientInformationFull, _request: OAuthTokenRevocationRequest) => {},
  };
}

describe("MCP OAuth router contract", () => {
  it("advertises the exact standard endpoints, S256 and confidential client auth", () => {
    const metadata = oauthMetadataForBroker(enabledConfig, provider());
    expect(metadata).toMatchObject({
      issuer: "https://xero-mcp.example.test/",
      authorization_endpoint: "https://xero-mcp.example.test/authorize",
      token_endpoint: "https://xero-mcp.example.test/token",
      revocation_endpoint: "https://xero-mcp.example.test/revoke",
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: ["xero.read", "xero.draft.write"],
      protected_resources: ["https://xero-mcp.example.test/mcp"],
    });
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  it("publishes the canonical MCP resource and never a generic origin audience", () => {
    expect(protectedResourceMetadataForBroker(enabledConfig)).toEqual({
      resource: "https://xero-mcp.example.test/mcp",
      authorization_servers: ["https://xero-mcp.example.test/"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["xero.read", "xero.draft.write"],
      resource_name: "zCloak Xero Accounting MCP",
    });
    expect(createMcpOAuthRouter({ config: enabledConfig, provider: provider() })).toBeTypeOf("function");
  });

  it("refuses a provider that would expose dynamic client registration", () => {
    expect(() => createMcpOAuthRouter({ config: enabledConfig, provider: provider(true) }))
      .toThrow(/dynamic.*disabled/i);
  });

  it("keeps token and revocation exchanges server-only and neutralises the SDK wildcard", () => {
    const createResponse = () => {
      const originalSetHeader = vi.fn();
      const response = {
        setHeader: originalSetHeader,
        status: vi.fn(() => response),
        json: vi.fn(() => response),
        end: vi.fn(() => response),
      } as unknown as Response;
      return { response, originalSetHeader };
    };

    const preflight = createResponse();
    const preflightNext = vi.fn() as unknown as NextFunction;
    requireServerToServerOAuthExchange({
      path: "/token",
      method: "OPTIONS",
      headers: { origin: "https://agent2.zcloak.ai" },
    } as unknown as Request, preflight.response, preflightNext);
    expect(preflightNext).not.toHaveBeenCalled();
    expect(preflight.response.status).toHaveBeenCalledWith(405);
    expect(preflight.originalSetHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(preflight.originalSetHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", expect.anything());

    const browser = createResponse();
    const browserNext = vi.fn() as unknown as NextFunction;
    requireServerToServerOAuthExchange({
      path: "/revoke",
      method: "POST",
      headers: { origin: "https://agent2.zcloak.ai" },
    } as unknown as Request, browser.response, browserNext);
    expect(browserNext).not.toHaveBeenCalled();
    expect(browser.response.status).toHaveBeenCalledWith(403);
    expect(browser.originalSetHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", expect.anything());

    const server = createResponse();
    const serverNext = vi.fn() as unknown as NextFunction;
    requireServerToServerOAuthExchange({
      path: "/token",
      method: "POST",
      headers: {},
    } as unknown as Request, server.response, serverNext);
    expect(serverNext).toHaveBeenCalledOnce();
    server.response.setHeader("Access-Control-Allow-Origin", "*");
    server.response.setHeader("Access-Control-Allow-Credentials", "true");
    server.response.setHeader("Cache-Control", "no-store");
    expect(server.originalSetHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
    expect(server.originalSetHeader).not.toHaveBeenCalledWith("Access-Control-Allow-Credentials", "true");
    expect(server.originalSetHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
});
