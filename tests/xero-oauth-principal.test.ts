import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type {
  AgentConnectionBinding,
  AuthorizedProviderConnection,
  OAuthInstallation,
  ProviderAuthorization,
  ResolvedMcpAccessToken,
} from "../src/domain/models.js";
import type { Logger } from "../src/logging.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { createOAuthRequestContext, type RequestContext } from "../src/security/requestContext.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

const readXeroScopes = [
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

function fakeClient(refreshToken = vi.fn()) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshToken,
  };
}

interface SeededOAuthPrincipal {
  authorization: ProviderAuthorization;
  connection: AuthorizedProviderConnection;
  installation: OAuthInstallation;
  binding: AgentConnectionBinding;
  context: RequestContext;
}

async function seedOAuthPrincipal(options: {
  repository: InMemoryAccountingRepository;
  cipher: Aes256GcmTokenCipher;
  suffix: string;
  outerScopes?: string[];
  xeroScopes?: string[];
  expired?: boolean;
}): Promise<SeededOAuthPrincipal> {
  const now = new Date();
  const xeroScopes = options.xeroScopes ?? readXeroScopes;
  const authorizationId = `authorization-${options.suffix}`;
  const workspaceId = `workspace-${options.suffix}`;
  const subjectId = `user-${options.suffix}`;
  const tokenJson = JSON.stringify({
    access_token: `xero-access-${options.suffix}`,
    refresh_token: `xero-refresh-${options.suffix}`,
    expires_at: options.expired ? 1 : Math.floor(Date.now() / 1_000) + 3_600,
    scope: xeroScopes.join(" "),
  });
  const authorization: ProviderAuthorization = {
    authorizationId,
    workspaceId,
    authorizedBySubject: subjectId,
    provider: "xero",
    providerSubject: `xero-${subjectId}`,
    grantedScopes: xeroScopes,
    tokenCiphertext: options.cipher.encrypt(tokenJson, authorizationId),
    tokenExpiresAt: options.expired ? new Date(1_000) : new Date(Date.now() + 3_600_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await options.repository.saveProviderAuthorization(authorization);

  const connection: AuthorizedProviderConnection = {
    connectionId: `connection-${options.suffix}`,
    authorizationId,
    provider: "xero",
    providerConnectionId: `xero-connection-${options.suffix}`,
    tenantId: `tenant-${options.suffix}`,
    tenantName: `Organisation ${options.suffix}`,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await options.repository.upsertAuthorizedProviderConnection(workspaceId, connection);

  const installation: OAuthInstallation = {
    installationId: `installation-${options.suffix}`,
    workspaceId,
    subjectType: "USER",
    subjectId,
    agentId: `agent-${options.suffix}`,
    clientId: "agent2-accounting-mcp",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await options.repository.saveOAuthInstallation(installation);

  const binding: AgentConnectionBinding = {
    bindingId: `binding-${options.suffix}`,
    installationId: installation.installationId,
    workspaceId,
    subjectType: installation.subjectType,
    subjectId,
    agentId: installation.agentId,
    connectionId: connection.connectionId,
    policyId: `policy-${options.suffix}`,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await options.repository.saveAgentConnectionBinding(binding);

  const resolvedToken: ResolvedMcpAccessToken = {
    tokenId: `token-${options.suffix}`,
    clientId: installation.clientId,
    resource: "https://xero-mcp.example.test/mcp",
    audience: "https://xero-mcp.example.test/mcp",
    grantedScopes: options.outerScopes ?? ["xero.read"],
    issuedAt: now,
    expiresAt: new Date(Date.now() + 900_000),
    installationId: installation.installationId,
    bindingId: binding.bindingId,
    connectionId: connection.connectionId,
    authorizationId,
    workspaceId,
    subjectType: installation.subjectType,
    subjectId,
    agentId: installation.agentId,
    policyId: binding.policyId,
    tenantId: connection.tenantId,
  };

  return {
    authorization,
    connection,
    installation,
    binding,
    context: createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    }),
  };
}

function manager(
  repository: InMemoryAccountingRepository,
  cipher: Aes256GcmTokenCipher,
): XeroClientManager {
  return new XeroClientManager({
    repository,
    cipher,
    config: {
      clientId: "xero-client",
      clientSecret: "xero-secret",
      redirectUri: "https://xero-mcp.example.test/oauth/xero/callback",
      scopes: [
        "openid",
        "profile",
        "email",
        ...readXeroScopes,
        "accounting.settings",
        "accounting.contacts",
        "accounting.invoices",
        "accounting.manualjournals",
      ],
    },
    logger: logger(),
  });
}

describe("trusted OAuth accounting principals", () => {
  it("fails closed when any server-resolved binding tuple field is absent", async () => {
    const repository = new InMemoryAccountingRepository();
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 4));
    const seeded = await seedOAuthPrincipal({ repository, cipher, suffix: "complete" });
    const clientManager = manager(repository, cipher);

    for (const field of [
      "workspaceId",
      "subjectType",
      "subjectId",
      "agentId",
      "oauthInstallationId",
      "bindingId",
      "connectionId",
    ]) {
      const invalid = { ...seeded.context, [field]: undefined } as unknown as RequestContext;
      await expect(clientManager.resolveConnection(invalid)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("resolves the exact binding and never crosses to another tenant", async () => {
    const repository = new InMemoryAccountingRepository();
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 5));
    const a = await seedOAuthPrincipal({ repository, cipher, suffix: "a" });
    const b = await seedOAuthPrincipal({ repository, cipher, suffix: "b" });
    const clientManager = manager(repository, cipher);
    vi.spyOn(clientManager, "createOAuthClient").mockReturnValue(fakeClient() as never);

    await expect(clientManager.withClient(
      a.context,
      async (_client, connection) => connection.tenantId,
    )).resolves.toBe(a.connection.tenantId);
    await expect(clientManager.withClient(
      b.context,
      async (_client, connection) => connection.tenantId,
    )).resolves.toBe(b.connection.tenantId);

    await expect(clientManager.resolveConnection({
      ...a.context,
      connectionId: b.connection.connectionId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(clientManager.resolveConnection({
      ...a.context,
      bindingId: b.binding.bindingId,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts read-only provider scopes for xero.read but not xero.draft.write", async () => {
    const repository = new InMemoryAccountingRepository();
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 6));
    const seeded = await seedOAuthPrincipal({ repository, cipher, suffix: "read-only" });
    const clientManager = manager(repository, cipher);

    await expect(clientManager.resolveConnection(seeded.context)).resolves.toMatchObject({
      connection: { connectionId: seeded.connection.connectionId },
      authorization: { authorizationId: seeded.authorization.authorizationId },
    });
    await expect(clientManager.resolveConnection({
      ...seeded.context,
      scopes: ["xero.read", "xero.draft.write"],
    })).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("refreshes the ProviderAuthorization with authorization AAD and never writes legacy credentials", async () => {
    const repository = new InMemoryAccountingRepository();
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 7));
    const seeded = await seedOAuthPrincipal({
      repository,
      cipher,
      suffix: "refresh",
      expired: true,
    });
    const clientManager = manager(repository, cipher);
    const refreshedScopes = [...readXeroScopes];
    const refreshToken = vi.fn().mockResolvedValue({
      access_token: "xero-access-new",
      refresh_token: "xero-refresh-new",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      scope: refreshedScopes.join(" "),
    });
    vi.spyOn(clientManager, "createOAuthClient").mockReturnValue(fakeClient(refreshToken) as never);
    const updateAuthorization = vi.spyOn(repository, "updateProviderAuthorizationToken");
    const updateLegacy = vi.spyOn(repository, "updateConnectionToken");

    await expect(clientManager.withClient(
      seeded.context,
      async (_client, connection) => connection.connectionId,
    )).resolves.toBe(seeded.connection.connectionId);

    expect(updateAuthorization).toHaveBeenCalledOnce();
    expect(updateAuthorization).toHaveBeenCalledWith(
      seeded.authorization.authorizationId,
      seeded.authorization.workspaceId,
      0,
      expect.any(String),
      expect.any(Date),
      refreshedScopes,
    );
    expect(updateLegacy).not.toHaveBeenCalled();
    const saved = await repository.getProviderAuthorization(
      seeded.authorization.authorizationId,
      seeded.authorization.workspaceId,
      seeded.authorization.authorizedBySubject,
    );
    expect(saved).toMatchObject({ refreshVersion: 1, status: "ACTIVE" });
    expect(JSON.parse(cipher.decrypt(
      saved?.tokenCiphertext ?? "",
      seeded.authorization.authorizationId,
    ))).toMatchObject({ access_token: "xero-access-new", refresh_token: "xero-refresh-new" });
  });
});
