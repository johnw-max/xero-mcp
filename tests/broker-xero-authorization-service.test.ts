import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  BrokerXeroAuthorizationService,
  type BrokerXeroAuthorizationInput,
} from "../src/oauth/brokerXeroAuthorizationService.js";
import type { Logger } from "../src/logging.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

const readOnlyXeroScopes = [
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.reports.trialbalance.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.manualjournals.read",
  "accounting.banktransactions.read",
];

const granularWriteXeroScopes = [
  ...readOnlyXeroScopes,
  "accounting.settings",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.manualjournals",
];

const draftOnlyXeroScopes = [
  "offline_access",
  "accounting.settings",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.manualjournals",
];

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  publicBaseUrl: "https://xero-mcp.example.test",
  databaseUrl: "postgres://unused",
  mcpBearerToken: "m".repeat(48),
  allowedOrigins: ["https://agent2.example.test"],
  allowedHosts: ["xero-mcp.example.test"],
  requestBodyLimitBytes: 1_048_576,
  xero: {
    clientId: "xero-client",
    clientSecret: "xero-secret",
    redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
    scopes: readOnlyXeroScopes,
  },
  xeroWriteEnabled: false,
  tokenEncryptionKey: Buffer.alloc(32, 7),
  demoActorId: "legacy-demo",
  logLevel: "error",
};

const now = new Date("2026-08-05T09:30:00.000Z");
const expiresAt = new Date("2026-08-05T10:00:00.000Z");
const authenticationEventId = "d0ddcf81-f942-4f4d-b3c7-f98045204db4";
const tokenJson = JSON.stringify({
  access_token: "secret-access-token",
  refresh_token: "secret-refresh-token",
  expires_at: Math.floor(expiresAt.getTime() / 1_000),
  scope: readOnlyXeroScopes.join(" "),
});

const baseInput: BrokerXeroAuthorizationInput = {
  xeroState: "xero-state-123",
  callbackQuery: "code=xero-code&state=xero-state-123",
  authorizationId: "authz-123",
  workspaceId: "workspace-123",
  authorizedBySubject: "user-123",
  requestedMcpScopes: ["xero.read"],
  now,
};

function createSubject(options: {
  scopes?: string[];
  tenants?: unknown[];
  connectionIds?: string[];
  accessToken?: string;
  organisationErrorTenantIds?: string[];
  logger?: Logger;
} = {}) {
  const scopes = options.scopes ?? readOnlyXeroScopes;
  const serializedTokenJson = JSON.stringify({
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token",
    expires_at: Math.floor(expiresAt.getTime() / 1_000),
    scope: scopes.join(" "),
  });
  const organisationsByTenantId = new Map<string, Record<string, unknown>>();
  const tenants = (options.tenants ?? [{
    id: "xero-connection-1",
    tenantId: "tenant-1",
    tenantName: "Tenant One",
    orgData: { shortCode: "!Tenant1" },
  }]).map((tenant) => {
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
  const ids = [...(options.connectionIds ?? ["conn-internal-1", "conn-internal-2"] )];
  const tokenSet = {
    access_token: options.accessToken ?? `header.${Buffer.from(JSON.stringify({
      authentication_event_id: authenticationEventId,
    })).toString("base64url")}.signature`,
  };
  const organisationErrorTenantIds = new Set(options.organisationErrorTenantIds ?? []);
  const getOrganisations = vi.fn().mockImplementation(async (tenantId: string) => {
    if (organisationErrorTenantIds.has(tenantId)) {
      throw new Error(`Historical Xero organisation ${tenantId} is inaccessible.`);
    }
    const organisation = organisationsByTenantId.get(tenantId);
    return { body: { organisations: organisation ? [organisation] : [] } };
  });
  const updateTenants = vi.fn().mockImplementation(async (fullOrgDetails = true) => {
    const discovered = tenants.map((tenant) => typeof tenant === "object" && tenant !== null
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
    apiCallback: vi.fn().mockResolvedValue(tokenSet),
    updateTenants,
    accountingApi: { getOrganisations },
  };
  const manager = {
    createOAuthClient: vi.fn().mockReturnValue(client),
    serializeTokenSet: vi.fn().mockReturnValue({
      json: serializedTokenJson,
      expiresAt,
      scopes,
    }),
  } as unknown as XeroClientManager;
  const cipher = new Aes256GcmTokenCipher(config.tokenEncryptionKey);
  const service = new BrokerXeroAuthorizationService({
    manager,
    cipher,
    config,
    connectionIdFactory: () => ids.shift() ?? "conn-fallback",
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { service, cipher, client, manager, tokenSet, getOrganisations };
}

describe("BrokerXeroAuthorizationService", () => {
  it("emits only fixed, secret-free stage contexts during a successful exchange", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { service } = createSubject({ logger });

    await service.exchange(baseInput);

    expect(vi.mocked(logger.info).mock.calls).toEqual([
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "CALLBACK_VALIDATION" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "TOKEN_EXCHANGE" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "TENANT_DISCOVERY" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "SCOPE_VALIDATION" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "CONNECTION_ASSEMBLY" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "AUTHORIZATION_ASSEMBLY" }],
      ["Xero Broker OAuth exchange advanced.", { oauthStage: "COMPLETE" }],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("secret-access-token");
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("secret-refresh-token");
  });

  it("logs only the fixed stage, AppError code, and safe error class for validation failures", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { service } = createSubject({ logger });

    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.read", "xero.admin"],
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Xero Broker OAuth exchange failed.", {
      oauthStage: "CALLBACK_VALIDATION",
      errorCode: "VALIDATION_FAILED",
      errorClass: "AppError",
    });
  });

  it("does not copy provider error messages or OAuth values into failure logs", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { service, client } = createSubject({ logger });
    const providerError = new Error(
      "code=QA_CODE_91A state=QA_STATE_91A cookie=QA_COOKIE_91A token=QA_TOKEN_91A tenant=QA_TENANT_91A client_secret=QA_SECRET_91A",
    );
    providerError.name = "RPError";
    client.apiCallback.mockRejectedValueOnce(providerError);

    await expect(service.exchange(baseInput)).rejects.toBe(providerError);

    expect(logger.error).toHaveBeenCalledWith("Xero Broker OAuth exchange failed.", {
      oauthStage: "TOKEN_EXCHANGE",
      errorClass: "RPError",
    });
    const rendered = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    for (const sentinel of [
      "QA_CODE_91A",
      "QA_STATE_91A",
      "QA_COOKIE_91A",
      "QA_TOKEN_91A",
      "QA_TENANT_91A",
      "QA_SECRET_91A",
    ]) {
      expect(rendered).not.toContain(sentinel);
    }
  });

  it("collapses an unreviewed provider error class to the fixed Error category", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { service, client } = createSubject({ logger });
    const providerError = new Error("untrusted provider failure");
    providerError.name = "QA_SECRET_CLASS_42C";
    client.apiCallback.mockRejectedValueOnce(providerError);

    await expect(service.exchange(baseInput)).rejects.toBe(providerError);

    expect(logger.error).toHaveBeenCalledWith("Xero Broker OAuth exchange failed.", {
      oauthStage: "TOKEN_EXCHANGE",
      errorClass: "Error",
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      "QA_SECRET_CLASS_42C",
    );
  });

  it("returns every organisation from the callback event and ignores older or unbound connections", async () => {
    const { service, cipher, client, manager, tokenSet, getOrganisations } = createSubject({
      organisationErrorTenantIds: ["tenant-old"],
      tenants: [
        {
          id: "xero-connection-1",
          tenantId: "tenant-1",
          tenantName: "Tenant One",
          orgData: { shortCode: "!Tenant1" },
        },
        {
          connectionId: "xero-connection-2",
          tenantId: "tenant-2",
          orgData: { name: "Tenant Two", shortCode: "unsafe short code" },
        },
        {
          id: "xero-connection-old",
          authEventId: "11111111-1111-4111-8111-111111111111",
          tenantId: "tenant-old",
          tenantName: "Previously connected organisation",
        },
        {
          id: "xero-connection-without-event",
          authEventId: undefined,
          tenantId: "tenant-without-event",
          tenantName: "Unbound organisation",
        },
      ],
    });

    const result = await service.exchange(baseInput);

    expect(client.apiCallback).toHaveBeenCalledWith(
      "https://xero-mcp.example.test/oauth/xero/callback?code=xero-code&state=xero-state-123",
    );
    expect(client.updateTenants).toHaveBeenCalledWith(false);
    expect(getOrganisations.mock.calls.map(([tenantId]) => tenantId)).toEqual(["tenant-1", "tenant-2"]);
    expect(manager.serializeTokenSet).toHaveBeenCalledWith(tokenSet);
    expect(result.connections).toEqual([
      {
        connectionId: "conn-internal-1",
        authorizationId: "authz-123",
        provider: "xero",
        providerConnectionId: "xero-connection-1",
        tenantId: "tenant-1",
        tenantName: "Tenant One",
        tenantShortCode: "!Tenant1",
        status: "ACTIVE",
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        connectionId: "conn-internal-2",
        authorizationId: "authz-123",
        provider: "xero",
        providerConnectionId: "xero-connection-2",
        tenantId: "tenant-2",
        tenantName: "Tenant Two",
        status: "ACTIVE",
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    expect(result.authorization).toMatchObject({
      authorizationId: "authz-123",
      workspaceId: "workspace-123",
      authorizedBySubject: "user-123",
      provider: "xero",
      grantedScopes: readOnlyXeroScopes,
      tokenExpiresAt: expiresAt,
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });

    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
    expect(cipher.decrypt(result.authorization.tokenCiphertext, "authz-123")).toBe(tokenJson);
    expect(() => cipher.decrypt(result.authorization.tokenCiphertext, "other-authz")).toThrow();
  });

  it("accepts the complete granular controlled-write bundle", async () => {
    const { service } = createSubject({ scopes: granularWriteXeroScopes });

    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.read", "xero.draft.write"],
    })).resolves.toMatchObject({
      authorization: { grantedScopes: granularWriteXeroScopes },
      connections: [{ tenantId: "tenant-1" }],
    });
  });

  it("accepts a draft-write-only token without unrelated report or transaction reads", async () => {
    const { service } = createSubject({ scopes: draftOnlyXeroScopes });
    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.draft.write"],
    })).resolves.toMatchObject({
      authorization: { grantedScopes: draftOnlyXeroScopes },
      connections: [{ tenantId: "tenant-1" }],
    });
  });

  it.each([
    ["accounting.invoices", /draft invoice.*purchase-order write/i],
    ["accounting.manualjournals", /manual journal draft write/i],
    ["accounting.contacts", /contact create and update/i],
    ["accounting.settings", /item create and update/i],
  ])("rejects draft write when the granular token lacks %s", async (missingScope, message) => {
    const { service } = createSubject({
      scopes: granularWriteXeroScopes.filter((scope) => scope !== missingScope),
    });

    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.read", "xero.draft.write"],
    })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: expect.stringMatching(message),
    });
  });

  it("accepts the deprecated broad Xero scopes for an existing write connection", async () => {
    const { service } = createSubject({
      scopes: [
        "offline_access",
        "accounting.transactions",
        "accounting.settings",
        "accounting.contacts",
        "accounting.reports.read",
      ],
    });

    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.read", "xero.draft.write"],
    })).resolves.toMatchObject({
      connections: [{ tenantId: "tenant-1" }],
    });
  });

  it("accepts the legacy broad read-only transaction scope for xero.read", async () => {
    const { service } = createSubject({
      scopes: [
        "offline_access",
        "accounting.transactions.read",
        "accounting.settings.read",
        "accounting.contacts.read",
        "accounting.reports.read",
      ],
    });

    await expect(service.exchange(baseInput)).resolves.toMatchObject({
      connections: [{ tenantId: "tenant-1" }],
    });
  });

  it.each([
    ["offline_access", /offline token refresh/i],
    ["accounting.settings.read", /settings read/i],
    ["accounting.contacts.read", /contact read/i],
    ["accounting.reports.trialbalance.read", /trial balance read/i],
    ["accounting.payments.read", /payment history read/i],
    ["accounting.manualjournals.read", /manual journal read/i],
    ["accounting.banktransactions.read", /bank transaction read/i],
  ])("rejects a token missing the baseline %s capability", async (missingScope, message) => {
    const { service } = createSubject({
      scopes: readOnlyXeroScopes.filter((scope) => scope !== missingScope),
    });

    await expect(service.exchange(baseInput)).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: expect.stringMatching(message),
    });
  });

  it("rejects zero Xero organisations", async () => {
    const { service } = createSubject({ tenants: [] });

    await expect(service.exchange(baseInput)).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("returns multiple fresh-token-visible re-authorised organisations for explicit broker selection", async () => {
    const { service } = createSubject({
      tenants: [
        {
          id: "xero-connection-old-1",
          authEventId: "11111111-1111-4111-8111-111111111111",
          tenantId: "tenant-old-1",
          tenantName: "Previously connected organisation 1",
        },
        {
          id: "xero-connection-old-2",
          authEventId: "22222222-2222-4222-8222-222222222222",
          tenantId: "tenant-old-2",
          tenantName: "Previously connected organisation 2",
        },
      ],
    });

    await expect(service.exchange(baseInput)).resolves.toMatchObject({
      connections: [
        expect.objectContaining({
          providerConnectionId: "xero-connection-old-1",
          tenantId: "tenant-old-1",
        }),
        expect.objectContaining({
          providerConnectionId: "xero-connection-old-2",
          tenantId: "tenant-old-2",
        }),
      ],
    });
  });

  it.each([
    ["a missing authentication_event_id", {}],
    ["an oversized authentication_event_id", { authentication_event_id: "x".repeat(129) }],
    [
      "an oversized JWT payload",
      { authentication_event_id: authenticationEventId, ignored: "x".repeat(9_000) },
    ],
  ])("rejects an access token with %s", async (_label, payload) => {
    const { service, client } = createSubject({
      accessToken: `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`,
    });

    await expect(service.exchange(baseInput)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(client.updateTenants).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing tenant ID", [{ id: "connection-1", tenantName: "Broken" }], /tenant ID/i],
    ["a missing connection ID", [{ tenantId: "tenant-1", tenantName: "Broken" }], /connection ID/i],
    [
      "a duplicate tenant ID",
      [
        { id: "connection-1", tenantId: "tenant-1" },
        { id: "connection-2", tenantId: "tenant-1" },
      ],
      /duplicate tenant ID/i,
    ],
    [
      "a duplicate Xero connection ID",
      [
        { id: "connection-1", tenantId: "tenant-1" },
        { id: "connection-1", tenantId: "tenant-2" },
      ],
      /duplicate connection ID/i,
    ],
  ])("rejects %s", async (_label, tenants, message) => {
    const { service } = createSubject({ tenants });

    await expect(service.exchange(baseInput)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringMatching(message),
    });
  });

  it("rejects a callback whose query state does not exactly match the Xero state", async () => {
    const { service, client } = createSubject();

    await expect(service.exchange({
      ...baseInput,
      callbackQuery: "code=xero-code&state=attacker-state",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(client.apiCallback).not.toHaveBeenCalled();
  });

  it("does not silently ignore an unknown host scope", async () => {
    const { service, client } = createSubject();

    await expect(service.exchange({
      ...baseInput,
      requestedMcpScopes: ["xero.read", "xero.admin"],
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { unsupportedScopes: ["xero.admin"] },
    });
    expect(client.apiCallback).not.toHaveBeenCalled();
  });
});
