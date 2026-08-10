import { describe, expect, it } from "vitest";
import { loadQuickBooksConfig } from "../src/quickbooks/config.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    QUICKBOOKS_PUBLIC_BASE_URL: "https://quickbooks-mcp.example.test",
    DATABASE_URL: "postgres://unused",
    QUICKBOOKS_MCP_BEARER_TOKEN: "m".repeat(48),
    QUICKBOOKS_TOKEN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString("base64"),
    QUICKBOOKS_MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
    QUICKBOOKS_MCP_ALLOWED_HOSTS: "quickbooks-mcp.example.test",
    QUICKBOOKS_CLIENT_ID: "client-a",
    QUICKBOOKS_CLIENT_SECRET: "secret-a",
    ...overrides,
  };
}

describe("QuickBooks runtime configuration", () => {
  it("defaults to Sandbox with writes closed and exact Agent2 origin", () => {
    const config = loadQuickBooksConfig(env());

    expect(config).toMatchObject({
      publicBaseUrl: "https://quickbooks-mcp.example.test",
      allowedOrigins: ["https://agent2.zcloak.ai"],
      writeEnabled: false,
      oauth: {
        environment: "sandbox",
        redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
      },
    });
    expect(config).not.toHaveProperty("allowedRealmId");
  });

  it("treats a blank optional minor version as absent", () => {
    const blank = loadQuickBooksConfig(env({ QUICKBOOKS_MINOR_VERSION: "" }));
    const configured = loadQuickBooksConfig(env({ QUICKBOOKS_MINOR_VERSION: "75" }));

    expect(blank.oauth).not.toHaveProperty("minorVersion");
    expect(configured.oauth).toMatchObject({ minorVersion: 75 });
  });

  it("requires an exact realm when writes are enabled", () => {
    expect(() => loadQuickBooksConfig(env({ QUICKBOOKS_WRITE_ENABLED: "true" })))
      .toThrow(/QUICKBOOKS_ALLOWED_REALM_ID/);

    expect(loadQuickBooksConfig(env({
      QUICKBOOKS_WRITE_ENABLED: "true",
      QUICKBOOKS_ALLOWED_REALM_ID: "934145",
    }))).toMatchObject({ writeEnabled: true, allowedRealmId: "934145" });
  });

  it("requires an HTTPS origin in production", () => {
    expect(() => loadQuickBooksConfig(env({
      NODE_ENV: "production",
      QUICKBOOKS_PUBLIC_BASE_URL: "http://quickbooks-mcp.example.test/path",
    }))).toThrow(/HTTPS origin/);
  });

  it("enables a registered confidential Agent2 OAuth client without changing the Intuit redirect", () => {
    const config = loadQuickBooksConfig(env({
      NODE_ENV: "production",
      QUICKBOOKS_MCP_OAUTH_ENABLED: "true",
      QUICKBOOKS_MCP_OAUTH_CLIENT_ID: "agent2-quickbooks",
      QUICKBOOKS_MCP_OAUTH_CLIENT_SECRET: "s".repeat(48),
      QUICKBOOKS_MCP_OAUTH_REDIRECT_URIS: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    }));

    expect(config.oauth.redirectUri).toBe("https://quickbooks-mcp.example.test/oauth/quickbooks/callback");
    expect(config.mcpOAuth).toMatchObject({
      clientId: "agent2-quickbooks",
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
      accessTokenTtlSeconds: 3_600,
    });
  });
});
