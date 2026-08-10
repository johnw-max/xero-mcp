import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  createOAuthMetadata,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthBrokerConfig } from "../config.js";
import { requireConstantTimeOAuthClient } from "./clientAuthentication.js";

export type EnabledMcpOAuthBrokerConfig = Extract<McpOAuthBrokerConfig, { enabled: true }>;

export function oauthMetadataForBroker(
  config: EnabledMcpOAuthBrokerConfig,
  provider: OAuthServerProvider,
): OAuthMetadata {
  const metadata = createOAuthMetadata({
    provider,
    issuerUrl: new URL(config.issuer),
    baseUrl: new URL(config.issuer),
    scopesSupported: [...config.scopes],
  });
  // This deployment intentionally supports only pre-registered confidential
  // web clients. The SDK's generic metadata also advertises `none`; override it
  // so discovery cannot suggest a public-client flow that our edge rejects.
  return {
    ...metadata,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    protected_resources: [...config.protectedResourceUris],
  };
}

export function protectedResourceMetadataForBroker(
  config: EnabledMcpOAuthBrokerConfig,
): OAuthProtectedResourceMetadata {
  return {
    resource: config.resourceUri,
    authorization_servers: [new URL(config.issuer).href],
    bearer_methods_supported: ["header"],
    scopes_supported: [...config.scopes],
    resource_name: "zCloak Xero Accounting MCP",
  };
}

/**
 * The upstream SDK enables wildcard CORS on token and revocation handlers.
 * This Broker uses pre-registered confidential clients, so those exchanges
 * must stay server-to-server and must never inherit the SDK wildcard.
 */
export function requireServerToServerOAuthExchange(request: Request, response: Response, next: NextFunction): void {
  if (request.path !== "/token" && request.path !== "/revoke") {
    next();
    return;
  }
  if (request.method === "OPTIONS") {
    response.setHeader("Allow", "POST");
    response.status(405).end();
    return;
  }
  if (request.headers.origin) {
    response.status(403).json({
      error: "invalid_request",
      error_description: "OAuth token exchanges are restricted to confidential server clients.",
    });
    return;
  }

  const originalSetHeader = response.setHeader.bind(response);
  response.setHeader = ((name: string, value: string | number | readonly string[]) => {
    if (name.toLowerCase().startsWith("access-control-")) return response;
    return originalSetHeader(name, value);
  }) as Response["setHeader"];
  next();
}

/** Standard MCP OAuth routes plus constant-time confidential-client pre-authentication. */
export function createMcpOAuthRouter(options: {
  config: EnabledMcpOAuthBrokerConfig;
  provider: OAuthServerProvider;
}): RequestHandler {
  const { config, provider } = options;
  if (provider.clientsStore.registerClient) {
    throw new Error("Dynamic OAuth client registration must remain disabled for this Broker.");
  }
  const router = express.Router();
  router.use(requireServerToServerOAuthExchange);
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));
  router.post("/token", requireConstantTimeOAuthClient(provider.clientsStore));
  router.post("/revoke", requireConstantTimeOAuthClient(provider.clientsStore));

  // Optional root compatibility alias. The path-specific /mcp metadata served
  // by the SDK router remains authoritative under RFC 9728.
  router.get("/.well-known/oauth-protected-resource", (_, response) => {
    response.json(protectedResourceMetadataForBroker(config));
  });
  const resourcePath = new URL(config.resourceUri).pathname;
  router.get(`/.well-known/oauth-protected-resource${resourcePath === "/" ? "" : resourcePath}`, (_, response) => {
    response.json(protectedResourceMetadataForBroker(config));
  });
  router.get("/.well-known/oauth-authorization-server", (_, response) => {
    response.json(oauthMetadataForBroker(config, provider));
  });
  router.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.issuer),
    baseUrl: new URL(config.issuer),
    resourceServerUrl: new URL(config.resourceUri),
    scopesSupported: [...config.scopes],
    resourceName: "zCloak Xero Accounting MCP",
  }));
  return router;
}
