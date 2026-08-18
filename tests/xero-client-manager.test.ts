import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ProviderConnection } from "../src/domain/models.js";
import type { Logger } from "../src/logging.js";
import {
  XeroClientManager,
} from "../src/providers/xeroClientManager.js";
import type { XeroTrialBalanceTransport } from "../src/providers/xeroTrialBalanceTransport.js";
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

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function setup(options: {
  scopes?: string[];
  legacyWriteEnabled?: boolean;
  trialBalanceTransport?: XeroTrialBalanceTransport;
} = {}) {
  const scopes = options.scopes ?? requiredScopes;
  const repository = new InMemoryAccountingRepository();
  const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 8));
  const connectionId = "conn-refresh-race";
  const tokenJson = JSON.stringify({
    access_token: "test-access-old",
    refresh_token: "test-refresh-old",
    expires_at: 1,
    scope: scopes.join(" "),
  });
  const connection: ProviderConnection = {
    connectionId,
    actorId: "actor-a",
    provider: "xero",
    tenantId: "tenant-a",
    tenantName: "Tenant A",
    grantedScopes: scopes,
    tokenCiphertext: cipher.encrypt(tokenJson, connectionId),
    tokenExpiresAt: new Date(1_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: new Date("2026-08-03T12:00:00.000Z"),
    updatedAt: new Date("2026-08-03T12:00:00.000Z"),
  };
  await repository.upsertConnection(connection);
  const testLogger = logger();
  const manager = new XeroClientManager({
    repository,
    cipher,
    config: {
      clientId: "client-a",
      clientSecret: "secret-a",
      redirectUri: "https://example.test/oauth/xero/callback",
      scopes: requiredScopes,
    },
    logger: testLogger,
    legacyWriteEnabled: options.legacyWriteEnabled ?? true,
    trialBalanceTransport: options.trialBalanceTransport,
  });
  return { repository, cipher, connection, manager, testLogger };
}

function fakeClient(refreshToken: () => Promise<unknown>) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshToken: vi.fn(refreshToken),
  };
}

describe("Xero token refresh concurrency", () => {
  it("accepts a strict read-only legacy connection when writes are disabled", async () => {
    const { manager } = await setup({
      scopes: readOnlyScopes,
      legacyWriteEnabled: false,
    });
    await expect(manager.resolveSingleConnection("actor-a")).resolves.toMatchObject({
      actorId: "actor-a",
      grantedScopes: readOnlyScopes,
    });
  });

  it("requires reconnection for an over-granted legacy token when writes are disabled", async () => {
    const { manager } = await setup({ legacyWriteEnabled: false });
    await expect(manager.resolveSingleConnection("actor-a")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      message: expect.stringMatching(/unexpected accounting write scope/i),
    });
  });

  it("keeps the refreshed access token inside the manager-owned bounded transport", async () => {
    const getTrialBalance = vi.fn(async (input: { tenantId: string; accessToken: string }) => ({
      tenantId: input.tenantId,
      tokenObservedInsideManagerTransport: input.accessToken,
    }));
    const { repository, manager } = await setup({
      trialBalanceTransport: { getTrialBalance },
    });
    let activeTokenSet: Record<string, unknown> = {};
    const refreshed = {
      access_token: "test-access-refreshed",
      refresh_token: "test-refresh-refreshed",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      scope: requiredScopes.join(" "),
    };
    const client = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setTokenSet: vi.fn((tokenSet: Record<string, unknown>) => {
        activeTokenSet = tokenSet;
      }),
      refreshToken: vi.fn(async () => {
        activeTokenSet = refreshed;
        return refreshed;
      }),
      readTokenSet: vi.fn(() => activeTokenSet),
    };
    vi.spyOn(manager, "createOAuthClient").mockReturnValue(client as never);
    await expect(manager.getTrialBalance("actor-a")).resolves.toEqual({
      tenantId: "tenant-a",
      tokenObservedInsideManagerTransport: "test-access-refreshed",
    });
    expect(getTrialBalance).toHaveBeenCalledOnce();
    expect(client.refreshToken).toHaveBeenCalledOnce();
    await expect(repository.getConnectionByActorTenant("actor-a", "tenant-a")).resolves.toMatchObject({
      refreshVersion: 1,
      status: "ACTIVE",
    });
  });

  it("does not let a stale refresh failure disable a newer active token", async () => {
    const { repository, cipher, connection, manager, testLogger } = await setup();
    const refreshedTokenJson = JSON.stringify({
      access_token: "test-access-new",
      refresh_token: "test-refresh-new",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      scope: requiredScopes.join(" "),
    });
    const client = fakeClient(async () => {
      await repository.updateConnectionToken(
        connection.connectionId,
        0,
        cipher.encrypt(refreshedTokenJson, connection.connectionId),
        new Date(Date.now() + 3_600_000),
      );
      throw new Error("stale refresh token was already rotated");
    });
    vi.spyOn(manager, "createOAuthClient").mockReturnValue(client as never);

    await expect(
      manager.withClient("actor-a", async (_xeroClient, activeConnection) => activeConnection.refreshVersion),
    ).resolves.toBe(1);

    await expect(repository.getConnectionByActorTenant("actor-a", "tenant-a")).resolves.toMatchObject({
      status: "ACTIVE",
      refreshVersion: 1,
    });
    expect(testLogger.info).toHaveBeenCalledWith(
      "Xero token refresh race resolved with a newer active token.",
      expect.objectContaining({ actorId: "actor-a", tenantId: "tenant-a" }),
    );
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it("marks the exact failed refresh version and requires re-authorisation", async () => {
    const { repository, manager, testLogger } = await setup();
    const client = fakeClient(async () => {
      throw new Error("refresh rejected");
    });
    vi.spyOn(manager, "createOAuthClient").mockReturnValue(client as never);

    await expect(manager.withClient("actor-a", async () => "unreachable")).rejects.toMatchObject({
      code: "OAUTH_REFRESH_FAILED",
      details: {
        failureLayer: "PROVIDER_OAUTH_REFRESH",
        recoveryAction: "RECONNECT_XERO",
      },
    });
    await expect(repository.getConnectionByActorTenant("actor-a", "tenant-a")).resolves.toMatchObject({
      status: "TOKEN_REFRESH_FAILED",
      refreshVersion: 0,
    });
    expect(testLogger.warn).toHaveBeenCalledTimes(1);
  });
});
