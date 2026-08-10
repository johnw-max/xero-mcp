import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { XeroOAuthService } from "../src/oauth/xeroOAuthService.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { sha256 } from "../src/security/hash.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

const requiredScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.settings",
  "accounting.contacts.read",
  "accounting.contacts",
  "accounting.invoices.read",
  "accounting.invoices",
  "accounting.payments.read",
  "accounting.manualjournals.read",
  "accounting.manualjournals",
  "accounting.banktransactions.read",
  "accounting.reports.trialbalance.read",
];
const readOnlyScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.manualjournals.read",
  "accounting.banktransactions.read",
  "accounting.reports.trialbalance.read",
];
const authenticationEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    clientId: "client-a",
    clientSecret: "secret-a",
    redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
    scopes: requiredScopes,
  },
  xeroWriteEnabled: false,
  tokenEncryptionKey: Buffer.alloc(32, 9),
  demoActorId: "actor-a",
  logLevel: "error",
};

async function serviceWithScopes(scopes: string[], tenants: unknown[] = [{
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantName: "Synthetic Trial Organisation",
  orgData: { shortCode: "!Trial1" },
}], organisationErrorTenantIds: string[] = [], runtimeConfig: AppConfig = config) {
  const repository = new InMemoryAccountingRepository();
  const cipher = new Aes256GcmTokenCipher(runtimeConfig.tokenEncryptionKey);
  const state = "browser-bound-oauth-state";
  const browserSession = "browser-session-secret";
  await repository.saveOAuthState(
    sha256(state),
    sha256(browserSession),
    "actor-a",
    new Date(Date.now() + 60_000),
  );
  const tokenJson = JSON.stringify({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1_000) + 1_800,
    scope: scopes.join(" "),
  });
  const tokenSet = {
    access_token: `header.${Buffer.from(JSON.stringify({
      authentication_event_id: authenticationEventId,
    })).toString("base64url")}.signature`,
  };
  const organisationsByTenantId = new Map<string, Record<string, unknown>>();
  const eventBoundTenants = tenants.map((tenant) => {
    if (typeof tenant !== "object" || tenant === null || "authEventId" in tenant) return tenant;
    return { ...tenant, authEventId: authenticationEventId };
  }).map((tenant) => {
    if (typeof tenant !== "object" || tenant === null) return tenant;
    const { orgData, ...connection } = tenant as Record<string, unknown>;
    const tenantId = connection.tenantId;
    if (typeof tenantId === "string" && typeof orgData === "object" && orgData !== null) {
      organisationsByTenantId.set(tenantId, { organisationID: tenantId, ...orgData as Record<string, unknown> });
    }
    return connection;
  });
  const organisationErrorSet = new Set(organisationErrorTenantIds);
  const getOrganisations = vi.fn().mockImplementation(async (tenantId: string) => {
    if (organisationErrorSet.has(tenantId)) {
      throw new Error(`Historical Xero organisation ${tenantId} is inaccessible.`);
    }
    const organisation = organisationsByTenantId.get(tenantId);
    return { body: { organisations: organisation ? [organisation] : [] } };
  });
  const updateTenants = vi.fn().mockImplementation(async (fullOrgDetails = true) => {
    const discovered = eventBoundTenants.map((tenant) => typeof tenant === "object" && tenant !== null
      ? { ...tenant }
      : tenant);
    if (!fullOrgDetails) return discovered;
    const organisations = await Promise.all(discovered.map(async (tenant) => {
      const tenantId = typeof tenant === "object" && tenant !== null
        ? Reflect.get(tenant, "tenantId")
        : undefined;
      const response = await getOrganisations(tenantId);
      return response.body.organisations[0];
    }));
    return discovered.map((tenant, index) => typeof tenant === "object" && tenant !== null
      ? { ...tenant, ...(organisations[index] ? { orgData: organisations[index] } : {}) }
      : tenant);
  });
  const client = {
    buildConsentUrl: vi.fn().mockResolvedValue("https://login.xero.test/authorize"),
    apiCallback: vi.fn().mockResolvedValue(tokenSet),
    updateTenants,
    accountingApi: { getOrganisations },
  };
  const manager = {
    createOAuthClient: vi.fn().mockReturnValue(client),
    serializeTokenSet: vi.fn().mockReturnValue({
      json: tokenJson,
      expiresAt: new Date(Date.now() + 1_800_000),
      scopes,
    }),
  } as unknown as XeroClientManager;
  const service = new XeroOAuthService({ repository, manager, cipher, config: runtimeConfig });
  return { repository, cipher, state, browserSession, service, client, manager, tokenJson, getOrganisations };
}

describe("Xero OAuth callback persistence", () => {
  it("persists only a single-tenant, fully-scoped token set encrypted at rest", async () => {
    const { repository, cipher, state, browserSession, service, client, tokenJson } =
      await serviceWithScopes(readOnlyScopes);

    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=synthetic&state=${state}`,
    })).resolves.toMatchObject({
      actorId: "actor-a",
      tenantId: "11111111-1111-4111-8111-111111111111",
      tenantName: "Synthetic Trial Organisation",
      scopes: readOnlyScopes,
    });

    const stored = await repository.getConnectionByActorTenant(
      "actor-a",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(stored).toBeDefined();
    expect(stored?.tenantShortCode).toBe("!Trial1");
    expect(stored?.tokenCiphertext).not.toContain("test-access-token");
    expect(cipher.decrypt(stored?.tokenCiphertext ?? "", stored?.connectionId ?? "")).toBe(tokenJson);
    expect(client.apiCallback).toHaveBeenCalledWith(expect.stringContaining("code=synthetic"));

    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=replay&state=${state}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requests only strict read scopes when the legacy write gate is disabled", async () => {
    const { service, manager, browserSession } = await serviceWithScopes(readOnlyScopes);
    await expect(service.start("actor-start", browserSession)).resolves.toBe(
      "https://login.xero.test/authorize",
    );
    expect(manager.createOAuthClient).toHaveBeenCalledWith(
      expect.any(String),
      readOnlyScopes,
    );
  });

  it("rejects a legacy read-only callback if Xero returns accounting write scopes", async () => {
    const { repository, state, browserSession, service } = await serviceWithScopes(requiredScopes);
    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=overgranted&state=${state}`,
    })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: expect.stringMatching(/unexpected accounting write scope/i),
    });
    await expect(repository.listActiveConnections("actor-a")).resolves.toHaveLength(0);
  });

  it("keeps the reviewed full scope bundle when legacy controlled writes are enabled", async () => {
    const writeConfig: AppConfig = {
      ...config,
      xeroWriteEnabled: true,
      xeroAllowedTenantId: "11111111-1111-4111-8111-111111111111",
    };
    const { state, browserSession, service, manager } = await serviceWithScopes(
      requiredScopes,
      undefined,
      undefined,
      writeConfig,
    );
    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=write-enabled&state=${state}`,
    })).resolves.toMatchObject({ scopes: requiredScopes });
    expect(manager.createOAuthClient).toHaveBeenCalledWith(state, requiredScopes);
  });

  it("rejects a callback whose actual granted scopes cannot support the fixed tool set", async () => {
    const { repository, state, browserSession, service } = await serviceWithScopes([
      "offline_access",
      "accounting.invoices",
    ]);

    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=limited&state=${state}`,
    })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: expect.stringMatching(/settings|contact|trial balance/i),
    });
    await expect(repository.listActiveConnections("actor-a")).resolves.toHaveLength(0);
  });

  it("rejects multi-tenant consent before storing any connection", async () => {
    const { repository, state, browserSession, service } = await serviceWithScopes(readOnlyScopes, [
      { tenantId: "11111111-1111-4111-8111-111111111111", tenantName: "Tenant One" },
      { tenantId: "22222222-2222-4222-8222-222222222222", tenantName: "Tenant Two" },
    ]);

    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=multi&state=${state}`,
    })).rejects.toMatchObject({ code: "AMBIGUOUS_CONNECTION" });
    await expect(repository.listActiveConnections("actor-a")).resolves.toHaveLength(0);
  });

  it("ignores historical Xero connections and binds only the current authentication event", async () => {
    const currentTenantId = "11111111-1111-4111-8111-111111111111";
    const historicalTenantId = "22222222-2222-4222-8222-222222222222";
    const { repository, state, browserSession, service, client, getOrganisations } = await serviceWithScopes(readOnlyScopes, [
      {
        tenantId: currentTenantId,
        tenantName: "Current consent organisation",
      },
      {
        authEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        tenantId: historicalTenantId,
        tenantName: "Historical organisation",
      },
      {
        authEventId: undefined,
        tenantId: "33333333-3333-4333-8333-333333333333",
        tenantName: "Unbound organisation",
      },
    ], [historicalTenantId]);

    await expect(service.callback({
      state,
      browserSession,
      queryString: `code=current-event&state=${state}`,
    })).resolves.toMatchObject({ tenantId: currentTenantId });
    await expect(repository.listActiveConnections("actor-a")).resolves.toHaveLength(1);
    expect(client.updateTenants).toHaveBeenCalledWith(false);
    expect(getOrganisations.mock.calls.map(([tenantId]) => tenantId)).toEqual([currentTenantId]);
  });
});
