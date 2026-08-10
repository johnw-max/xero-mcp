import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type {
  AgentConnectionBinding,
  AuthorizedProviderConnection,
  McpAccessToken,
  OAuthInstallation,
  ProviderAuthorization,
} from "../src/domain/models.js";
import { OrganisationSwitchService } from "../src/services/organisationSwitchService.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";

const now = new Date("2026-08-10T04:00:00.000Z");
const resource = "https://xero-mcp.example.test/mcp";

async function harness() {
  const repository = new InMemoryAccountingRepository();
  const authorization: ProviderAuthorization = {
    authorizationId: "auth-switch",
    workspaceId: "workspace-switch",
    authorizedBySubject: "user-switch",
    provider: "xero",
    providerSubject: "xero-user-switch",
    grantedScopes: ["accounting.invoices.read"],
    tokenCiphertext: "encrypted-provider-token",
    tokenExpiresAt: new Date(now.getTime() + 30 * 60_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveProviderAuthorization(authorization);

  const connections: AuthorizedProviderConnection[] = [
    {
      connectionId: "connection-a",
      authorizationId: authorization.authorizationId,
      provider: "xero",
      providerConnectionId: "xero-connection-a",
      tenantId: "tenant-a",
      tenantName: "Company A",
      status: "ACTIVE",
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      connectionId: "connection-b",
      authorizationId: authorization.authorizationId,
      provider: "xero",
      providerConnectionId: "xero-connection-b",
      tenantId: "tenant-b",
      tenantName: "Company B",
      status: "ACTIVE",
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];
  for (const connection of connections) {
    await repository.upsertAuthorizedProviderConnection(authorization.workspaceId, connection);
  }

  const installation: OAuthInstallation = {
    installationId: "installation-switch",
    workspaceId: authorization.workspaceId,
    subjectType: "USER",
    subjectId: authorization.authorizedBySubject,
    agentId: "agent-switch",
    clientId: "agent2-client",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveOAuthInstallation(installation);

  const binding: AgentConnectionBinding = {
    bindingId: "binding-a",
    installationId: installation.installationId,
    workspaceId: installation.workspaceId,
    subjectType: installation.subjectType,
    subjectId: installation.subjectId,
    agentId: installation.agentId,
    connectionId: connections[0]!.connectionId,
    policyId: "policy-switch",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveAgentConnectionBinding(binding);

  const accessToken: McpAccessToken = {
    tokenHash: "access-token-switch",
    tokenId: "access-token-id-switch",
    installationId: installation.installationId,
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
    clientId: installation.clientId,
    resource,
    audience: resource,
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 15 * 60_000),
  };
  await repository.saveMcpAccessToken(accessToken);
  const resolved = await repository.resolveMcpAccessToken({
    tokenHash: accessToken.tokenHash,
    expectedResource: resource,
    expectedAudience: resource,
    now,
  });
  if (!resolved) throw new Error("seeded access token did not resolve");
  expect(resolved.bindingRevision).toBe(1);

  const service = new OrganisationSwitchService({
    repository,
    publicBaseUrl: "https://xero-mcp.example.test",
    secret: Buffer.alloc(32, 7),
    clock: () => new Date(now),
    ticketFactory: () => "t".repeat(43),
    bindingIdFactory: () => "binding-b",
  });
  return {
    repository,
    service,
    context: createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken: resolved,
    }),
  };
}

describe("conversation-driven Xero organisation switching", () => {
  it("returns a short-lived user link and switches subsequent MCP calls only after exact page confirmation", async () => {
    const { repository, service, context } = await harness();

    const started = await service.start(context);
    expect(started).toMatchObject({
      status: "USER_CONFIRMATION_REQUIRED",
      currentOrganisation: { tenantId: "tenant-a", tenantName: "Company A" },
    });
    expect(started.switchUrl).toBe(
      `https://xero-mcp.example.test/xero/organisation-switch?ticket=${"t".repeat(43)}`,
    );
    expect(started.expiresAt.toISOString()).toBe("2026-08-10T04:10:00.000Z");

    const page = await service.getPage("t".repeat(43));
    expect(page.currentOrganisation).toMatchObject({ tenantId: "tenant-a", tenantName: "Company A" });
    expect(page.organisations.map((entry) => entry.tenantName)).toEqual(["Company A", "Company B"]);

    await expect(service.confirm({
      ticket: "t".repeat(43),
      csrfToken: "wrong-csrf",
      selectedConnectionId: "connection-b",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const switched = await service.confirm({
      ticket: "t".repeat(43),
      csrfToken: page.csrfToken,
      selectedConnectionId: "connection-b",
    });
    expect(switched).toMatchObject({
      status: "SWITCHED",
      previousOrganisation: { tenantId: "tenant-a", tenantName: "Company A" },
      currentOrganisation: { tenantId: "tenant-b", tenantName: "Company B" },
    });

    await expect(service.getPage("t".repeat(43))).rejects.toMatchObject({ code: "CONFLICT" });
    const rebound = await repository.resolveMcpAccessToken({
      tokenHash: "access-token-switch",
      expectedResource: resource,
      expectedAudience: resource,
      now,
    });
    expect(rebound).toMatchObject({
      installationId: "installation-switch",
      bindingId: "binding-b",
      connectionId: "connection-b",
      bindingRevision: 2,
      tenantId: "tenant-b",
    });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: "installation-switch",
      bindingId: "binding-a",
      workspaceId: "workspace-switch",
      subjectType: "USER",
      subjectId: "user-switch",
      agentId: "agent-switch",
      connectionId: "connection-a",
    })).resolves.toBeUndefined();
    expect(repository.governanceAuditEvents.map((event) => ({
      eventType: event.eventType,
      source: event.source,
      disposition: event.disposition,
      outcome: event.outcome,
    }))).toEqual([
      {
        eventType: "xero.organisation_switch.requested",
        source: "MCP",
        disposition: "ESCALATE",
        outcome: "PROPOSED",
      },
      {
        eventType: "xero.organisation_switch.completed",
        source: "USER_UI",
        disposition: "AUTO_EXECUTE",
        outcome: "SUCCEEDED",
      },
    ]);
  });

  it("increments the active binding revision even when the confirmed tuple is unchanged", async () => {
    const { repository, service, context } = await harness();
    const started = await service.start(context);
    const ticket = new URL(started.switchUrl).searchParams.get("ticket");
    if (!ticket) throw new Error("organisation switch ticket was missing");
    const page = await service.getPage(ticket);

    await expect(service.confirm({
      ticket,
      csrfToken: page.csrfToken,
      selectedConnectionId: "connection-a",
    })).resolves.toMatchObject({
      status: "UNCHANGED",
      currentOrganisation: { tenantId: "tenant-a", tenantName: "Company A" },
    });

    await expect(repository.resolveMcpAccessToken({
      tokenHash: "access-token-switch",
      expectedResource: resource,
      expectedAudience: resource,
      now,
    })).resolves.toMatchObject({
      bindingId: "binding-a",
      connectionId: "connection-a",
      bindingRevision: 2,
      tenantId: "tenant-a",
    });
  });
});
