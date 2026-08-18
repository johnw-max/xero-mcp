import { describe, expect, it } from "vitest";
import { loadConfig, MCP_OAUTH_SCOPES } from "../src/config.js";
import { createXeroBuildIdentity } from "../src/xeroRelease.js";
import { sha256 } from "../src/security/hash.js";
/**
 * ADR-002 retains `XERO_TENANT_COA_PROFILES_JSON` and its legacy schema
 * (`src/policy/xeroTenantCoaProfile.ts`) purely for deployment compatibility
 * -- config.ts still parses it, but it no longer gates any write. This
 * fixture only needs to satisfy that legacy schema's own shape; it carries
 * no live behaviour any more.
 */
function testXeroTenantCoaProfile(tenantId: string, revision = 1) {
  return {
    profile_id: `test-sg-coa-${tenantId}`,
    revision,
    tenant_id: tenantId,
    jurisdiction: "SG" as const,
    categories: {
      CONSULTING_REVENUE: {
        account_id: "33333333-3333-4333-8333-333333333333",
        account_code: "200",
        expected_type: "REVENUE",
        expected_class: "REVENUE",
      },
      OFFICE_SUPPLIES: {
        account_id: "33333333-3333-4333-8333-333333333353",
        account_code: "453",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
      CLOUD_SUBSCRIPTIONS: {
        account_id: "33333333-3333-4333-8333-333333333385",
        account_code: "485",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
    },
  };
}

const AGENT2_CALLBACK = "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback";
const TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
const TOKEN_HASH_KEY = Buffer.alloc(32, 2).toString("base64");
const COOKIE_STATE_KEY = Buffer.alloc(32, 3).toString("base64");
const MUTATION_CONFIRMATION_KEY = Buffer.alloc(32, 4).toString("base64");
const BUILD_IDENTITY = createXeroBuildIdentity({
  acceptanceSourceSha256: "a".repeat(64),
  releaseSourceManifestSha256: "b".repeat(64),
  sourceArchiveSha256: "c".repeat(64),
  sourceBundleManifestSha256: "d".repeat(64),
  approvedControlCatalogSha256: "e".repeat(64),
});

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "https://xero-mcp.example.test",
    DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
    MCP_BEARER_TOKEN: "m".repeat(48),
    MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
    MCP_ALLOWED_HOSTS: "xero-mcp.example.test",
    REQUEST_BODY_LIMIT_BYTES: "1048576",
    XERO_CLIENT_ID: "xero-client",
    XERO_CLIENT_SECRET: "xero-secret",
    XERO_SCOPES: "openid profile email offline_access accounting.settings.read accounting.settings accounting.contacts.read accounting.contacts accounting.invoices.read accounting.invoices accounting.payments.read accounting.manualjournals.read accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read",
    TOKEN_ENCRYPTION_KEY_B64: TOKEN_ENCRYPTION_KEY,
    XERO_MUTATION_CONFIRMATION_KEY_B64: MUTATION_CONFIRMATION_KEY,
    DEMO_ACTOR_ID: "qa-actor",
    LOG_LEVEL: "error",
    XERO_BUILD_IDENTITY_JSON: JSON.stringify(BUILD_IDENTITY),
    ...overrides,
  };
}

function hostClients(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      name: "Agent2",
      client_id: "agent2-accounting-mcp",
      client_secret: "a".repeat(32),
      redirect_uris: [AGENT2_CALLBACK],
      ...overrides,
    },
    {
      name: "Another MCP Host",
      client_id: "another-host",
      client_secret: "b".repeat(32),
      redirect_uris: ["https://mcp-host.example.test/oauth/callback"],
    },
  ]);
}

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return validEnv({
    MCP_OAUTH_BROKER_ENABLED: "true",
    PERSONAL_POC_ONLY: "true",
    HOST_OAUTH_CLIENTS_JSON: hostClients(),
    OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "agent2-accounting-mcp",
    OAUTH_MANUAL_RETURN_CLIENT_IDS: "agent2-accounting-mcp",
    OAUTH_TOKEN_HASH_KEY_B64: TOKEN_HASH_KEY,
    OAUTH_COOKIE_STATE_KEY_B64: COOKIE_STATE_KEY,
    XERO_TENANT_COA_PROFILES_JSON: JSON.stringify([testXeroTenantCoaProfile(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )]),
    XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: "1".repeat(64),
    XERO_GOVERNANCE_RECEIPTS_SHA256: "2".repeat(64),
    XERO_GOVERNANCE_STATUS_SHA256: "3".repeat(64),
    ...overrides,
  });
}

function standingDelegations(): string {
  return JSON.stringify([{
    delegation_id: "agent2-xero-standing-v1",
    revision: 1,
    status: "ACTIVE",
    workspace_id: "workspace-test",
    agent_id: "agent-test",
    installation_id: "installation-test",
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action_ids: ["supplier_bill.create_draft"],
  }]);
}

describe("MCP OAuth Broker configuration", () => {
  it("is disabled by default and requires no new Broker secret", () => {
    const config = loadConfig(validEnv());

    expect(config.mcpOAuthBroker).toEqual({
      enabled: false,
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
      personalPocOnly: false,
      sharedTestUsers: false,
    });
  });

  it("derives the canonical resource and endpoints and supports multiple exact Host clients", () => {
    const config = loadConfig(enabledEnv());
    const broker = config.mcpOAuthBroker;
    expect(broker?.enabled).toBe(true);
    if (!broker?.enabled) throw new Error("expected enabled Broker config");

    expect(broker).toMatchObject({
      issuer: "https://xero-mcp.example.test",
      resourceUri: "https://xero-mcp.example.test/mcp",
      protectedResourceUris: ["https://xero-mcp.example.test/mcp"],
      authorizationPath: "/authorize",
      tokenPath: "/token",
      revocationPath: "/revoke",
      authorizationEndpoint: "https://xero-mcp.example.test/authorize",
      tokenEndpoint: "https://xero-mcp.example.test/token",
      revocationEndpoint: "https://xero-mcp.example.test/revoke",
      scopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: true,
      sharedTestUsers: false,
      missingResourceCompatClientIds: ["agent2-accounting-mcp"],
      manualReturnClientIds: ["agent2-accounting-mcp"],
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      authorizationCodeTtlSeconds: 300,
      browserFlowTtlSeconds: 600,
    });
    expect(broker.hostClients).toHaveLength(2);
    expect(broker.hostClients[0]).toMatchObject({
      name: "Agent2",
      clientId: "agent2-accounting-mcp",
      redirectUris: [AGENT2_CALLBACK],
    });
    expect(broker.hostClients[1]).toMatchObject({
      clientId: "another-host",
    });
    expect(config.xero.redirectUri).toBe("https://xero-mcp.example.test/oauth/xero/callback");
    expect(config.xeroTargetSessionRequired).toBe(false);
    expect(config.xeroTargetSessionTtlSeconds).toBe(1_800);
  });

  it("supports a bounded strict per-conversation ledger target policy", () => {
    const config = loadConfig(enabledEnv({
      XERO_TARGET_SESSION_REQUIRED: "true",
      XERO_TARGET_SESSION_TTL_SECONDS: "120",
    }));
    expect(config.xeroTargetSessionRequired).toBe(true);
    expect(config.xeroTargetSessionTtlSeconds).toBe(120);
    expect(() => loadConfig(enabledEnv({ XERO_TARGET_SESSION_TTL_SECONDS: "59" })))
      .toThrow(/XERO_TARGET_SESSION_TTL_SECONDS/i);
    expect(() => loadConfig(enabledEnv({ XERO_TARGET_SESSION_TTL_SECONDS: "14401" })))
      .toThrow(/XERO_TARGET_SESSION_TTL_SECONDS/i);
  });

  it("uses the selected server-side binding for Broker writes without a legacy global tenant allowlist", () => {
    const delegations = standingDelegations();
    const config = loadConfig(enabledEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_AUTHORITY_REVISION: "1",
      XERO_ALLOWED_TENANT_ID: "",
      XERO_TARGET_SESSION_REQUIRED: "true",
      XERO_STANDING_DELEGATIONS_JSON: delegations,
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: sha256(delegations),
      XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256: "6".repeat(64),
      XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: "7".repeat(64),
    }));

    expect(config.xeroWriteEnabled).toBe(true);
    expect(config.xeroAllowedTenantId).toBeUndefined();
    expect(config.mcpOAuthBroker?.enabled).toBe(true);
  });

  it("enables isolated multi-user early UAT behind an explicit test-only flag", () => {
    const broker = loadConfig(enabledEnv({ SHARED_TEST_USERS: "true" })).mcpOAuthBroker;

    expect(broker?.enabled && broker.sharedTestUsers).toBe(true);
    expect(() => loadConfig(enabledEnv({
      PERSONAL_POC_ONLY: "false",
      SHARED_TEST_USERS: "true",
      OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "",
      OAUTH_MANUAL_RETURN_CLIENT_IDS: "",
    }))).toThrow(/SHARED_TEST_USERS.*PERSONAL_POC_ONLY/i);
  });

  it("does not allow legacy shared-bearer writes after autonomous mode is enabled", () => {
    expect(() => loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: "",
    }))).toThrow(/MCP_OAUTH_BROKER_ENABLED=true.*required/i);
  });

  it.each([
    "http://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback",
    "https://*.zcloak.ai/api/mcp/accounting-mcp/oauth/callback",
    "https://operator:password@agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback",
    "https://@agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback",
    "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback#fragment",
    "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback#",
    "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback ",
  ])("rejects a non-exact or unsafe Host redirect URI: %s", (redirectUri) => {
    expect(() => loadConfig(enabledEnv({
      HOST_OAUTH_CLIENTS_JSON: hostClients({ redirect_uris: [redirectUri] }),
    }))).toThrow(/HOST_OAUTH_CLIENTS_JSON.*redirect_uris/i);
  });

  it("rejects duplicate Host client IDs", () => {
    const clients = JSON.parse(hostClients()) as Array<Record<string, unknown>>;
    clients[1] = { ...clients[1], client_id: clients[0]?.client_id };
    expect(() => loadConfig(enabledEnv({
      HOST_OAUTH_CLIENTS_JSON: JSON.stringify(clients),
    }))).toThrow(/client_id.*unique/i);
  });

  it("keeps missing-resource compatibility on an exact non-secret registered-client allowlist", () => {
    const disabled = loadConfig(enabledEnv({
      OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "",
    })).mcpOAuthBroker;
    expect(disabled?.enabled && disabled.missingResourceCompatClientIds).toEqual([]);

    expect(() => loadConfig(enabledEnv({
      OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "not-a-registered-client",
    }))).toThrow(/only pre-registered confidential Host client IDs/i);
    expect(() => loadConfig(enabledEnv({
      OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "agent2-accounting-mcp,agent2-accounting-mcp",
    }))).toThrow(/unique exact client IDs/i);
    expect(() => loadConfig(enabledEnv({
      PERSONAL_POC_ONLY: "false",
    }))).toThrow(/only when PERSONAL_POC_ONLY=true/i);
    expect(() => loadConfig(enabledEnv({
      HOST_OAUTH_CLIENTS_JSON: hostClients({
        redirect_uris: [`${AGENT2_CALLBACK}?existing=value`],
      }),
    }))).toThrow(/callback URLs without query parameters/i);
  });

  it("keeps missing-resource compatibility independent from the manual browser return allowlist", () => {
    const broker = loadConfig(enabledEnv({
      OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: "agent2-accounting-mcp,another-host",
      OAUTH_MANUAL_RETURN_CLIENT_IDS: "agent2-accounting-mcp",
    })).mcpOAuthBroker;
    expect(broker?.enabled && broker).toMatchObject({
      missingResourceCompatClientIds: ["agent2-accounting-mcp", "another-host"],
      manualReturnClientIds: ["agent2-accounting-mcp"],
    });
    expect(() => loadConfig(enabledEnv({
      OAUTH_MANUAL_RETURN_CLIENT_IDS: "not-a-registered-client",
    }))).toThrow(/OAUTH_MANUAL_RETURN_CLIENT_IDS.*pre-registered confidential Host client IDs/i);
    expect(() => loadConfig(enabledEnv({
      OAUTH_MANUAL_RETURN_CLIENT_IDS: "agent2-accounting-mcp,agent2-accounting-mcp",
    }))).toThrow(/OAUTH_MANUAL_RETURN_CLIENT_IDS.*unique exact client IDs/i);
  });

  it.each([
    ["OAUTH_ACCESS_TOKEN_TTL_SECONDS", "901"],
    ["OAUTH_REFRESH_TOKEN_TTL_SECONDS", "2592001"],
    ["OAUTH_AUTH_CODE_TTL_SECONDS", "301"],
    ["OAUTH_BROWSER_FLOW_TTL_SECONDS", "601"],
  ])("rejects %s above its security ceiling", (variableName, value) => {
    expect(() => loadConfig(enabledEnv({ [variableName]: value }))).toThrow(variableName);
  });

  it("rejects short client secrets without echoing the secret", () => {
    const weakSecret = "DO-NOT-ECHO-THIS-WEAK-SECRET";
    let message = "";
    try {
      loadConfig(enabledEnv({
        HOST_OAUTH_CLIENTS_JSON: hostClients({ client_secret: weakSecret }),
      }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/client_secret/i);
    expect(message).not.toContain(weakSecret);
  });

  it.each([
    ["missing token hash key", { OAUTH_TOKEN_HASH_KEY_B64: undefined }],
    ["non-base64 cookie/state key", { OAUTH_COOKIE_STATE_KEY_B64: "not-a-secret-key" }],
    ["reused Broker keys", { OAUTH_COOKIE_STATE_KEY_B64: TOKEN_HASH_KEY }],
    ["reused Xero encryption key", { OAUTH_TOKEN_HASH_KEY_B64: TOKEN_ENCRYPTION_KEY }],
    ["reused mutation confirmation and Broker hash keys", { OAUTH_TOKEN_HASH_KEY_B64: MUTATION_CONFIRMATION_KEY }],
    ["reused mutation confirmation and cookie/state keys", { OAUTH_COOKIE_STATE_KEY_B64: MUTATION_CONFIRMATION_KEY }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => loadConfig(enabledEnv(overrides))).toThrow(/key|required|independent/i);
  });

  it("accepts only explicit boolean flag values", () => {
    expect(() => loadConfig(validEnv({ PERSONAL_POC_ONLY: "yes" }))).toThrow(/PERSONAL_POC_ONLY/i);
    expect(() => loadConfig(validEnv({ SHARED_TEST_USERS: "yes" }))).toThrow(/SHARED_TEST_USERS/i);
    expect(() => loadConfig(validEnv({ MCP_OAUTH_BROKER_ENABLED: "1" }))).toThrow(
      /MCP_OAUTH_BROKER_ENABLED/i,
    );
    expect(() => loadConfig(validEnv({ XERO_TARGET_SESSION_REQUIRED: "yes" }))).toThrow(
      /XERO_TARGET_SESSION_REQUIRED/i,
    );
  });

  it("requires an HTTPS origin when the Broker is enabled outside production too", () => {
    expect(() => loadConfig(enabledEnv({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    }))).toThrow(/HTTPS origin/i);
  });
});
