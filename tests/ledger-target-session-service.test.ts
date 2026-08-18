import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type {
  AgentConnectionBinding,
  AuthorizedProviderConnection,
  McpAccessToken,
  OAuthInstallation,
  ProviderAuthorization,
} from "../src/domain/models.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { LedgerTargetSessionService } from "../src/services/ledgerTargetSessionService.js";
import { OrganisationSwitchService } from "../src/services/organisationSwitchService.js";

const baseNow = new Date("2026-08-12T08:00:00.000Z");
const resource = "https://xero-mcp.example.test/mcp";

async function createHarness(options: { required?: boolean } = {}) {
  let currentTime = new Date(baseNow);
  let referenceSequence = 0;
  let switchSequence = 0;
  const repository = new InMemoryAccountingRepository();
  const authorization: ProviderAuthorization = {
    authorizationId: "target-auth",
    workspaceId: "target-workspace",
    authorizedBySubject: "target-user",
    provider: "xero",
    providerSubject: "target-xero-user",
    grantedScopes: ["accounting.settings.read", "accounting.transactions.read"],
    tokenCiphertext: "encrypted-provider-token",
    tokenExpiresAt: new Date(baseNow.getTime() + 60 * 60_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: baseNow,
    updatedAt: baseNow,
  };
  await repository.saveProviderAuthorization(authorization);

  const connections: AuthorizedProviderConnection[] = [
    {
      connectionId: "target-connection-a",
      authorizationId: authorization.authorizationId,
      provider: "xero",
      providerConnectionId: "xero-target-a",
      tenantId: "target-tenant-a",
      tenantName: "Client Company A",
      status: "ACTIVE",
      lastVerifiedAt: baseNow,
      createdAt: baseNow,
      updatedAt: baseNow,
    },
    {
      connectionId: "target-connection-b",
      authorizationId: authorization.authorizationId,
      provider: "xero",
      providerConnectionId: "xero-target-b",
      tenantId: "target-tenant-b",
      tenantName: "Client Company B",
      status: "ACTIVE",
      lastVerifiedAt: baseNow,
      createdAt: baseNow,
      updatedAt: baseNow,
    },
  ];
  for (const connection of connections) {
    await repository.upsertAuthorizedProviderConnection(authorization.workspaceId, connection);
  }

  const installation: OAuthInstallation = {
    installationId: "target-installation",
    workspaceId: authorization.workspaceId,
    subjectType: "USER",
    subjectId: authorization.authorizedBySubject,
    agentId: "target-agent",
    clientId: "target-client",
    status: "ACTIVE",
    createdAt: baseNow,
    updatedAt: baseNow,
  };
  await repository.saveOAuthInstallation(installation);
  const binding: AgentConnectionBinding = {
    bindingId: "target-binding-a",
    installationId: installation.installationId,
    workspaceId: installation.workspaceId,
    subjectType: installation.subjectType,
    subjectId: installation.subjectId,
    agentId: installation.agentId,
    connectionId: connections[0]!.connectionId,
    policyId: "target-policy",
    status: "ACTIVE",
    createdAt: baseNow,
    updatedAt: baseNow,
  };
  await repository.saveAgentConnectionBinding(binding);
  const accessToken: McpAccessToken = {
    tokenHash: "target-access-hash",
    tokenId: "target-access-id",
    installationId: installation.installationId,
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
    clientId: installation.clientId,
    resource,
    audience: resource,
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: baseNow,
    expiresAt: new Date(baseNow.getTime() + 60 * 60_000),
  };
  await repository.saveMcpAccessToken(accessToken);
  const resolveContext = async () => {
    const resolved = await repository.resolveMcpAccessToken({
      tokenHash: accessToken.tokenHash,
      expectedResource: resource,
      expectedAudience: resource,
      now: currentTime,
    });
    if (!resolved) throw new Error("seeded MCP access token did not resolve");
    return createOAuthRequestContext({ issuer: "https://xero-mcp.example.test", resolvedToken: resolved });
  };
  const targets = new LedgerTargetSessionService({
    repository,
    secret: Buffer.alloc(32, 9),
    required: options.required ?? true,
    ttlMs: 30 * 60_000,
    clock: () => new Date(currentTime),
    referenceFactory: () => {
      referenceSequence += 1;
      return `xts_${Buffer.alloc(32, referenceSequence).toString("base64url")}`;
    },
    sessionIdFactory: () => `target-session-${referenceSequence}`,
  });
  const switchService = new OrganisationSwitchService({
    repository,
    publicBaseUrl: "https://xero-mcp.example.test",
    secret: Buffer.alloc(32, 7),
    clock: () => new Date(currentTime),
    ticketFactory: () => {
      switchSequence += 1;
      return (switchSequence === 1 ? "s" : "r").repeat(43);
    },
    bindingIdFactory: () => "target-binding-b",
  });
  return {
    repository,
    targets,
    switchService,
    resolveContext,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

describe("OAuth-principal-bound Xero ledger target sessions", () => {
  it("keeps an independently pinned Company A capability while another pin path switches to Company B", async () => {
    const harness = await createHarness();
    const contextA = await harness.resolveContext();
    const pinnedA = await harness.targets.issue(contextA);
    const pinnedOtherA = await harness.targets.issue(contextA);
    expect(pinnedA).toMatchObject({
      organisation_name: "Client Company A",
      binding_revision: 1,
    });
    expect(harness.repository.governanceAuditEvents[0]).toMatchObject({
      eventType: "xero.ledger_target_session.issued",
      outcome: "SUCCEEDED",
      evidence: {
        targetSessionRefSafe: pinnedA.target_ref_safe,
        rawCapabilityPersisted: false,
      },
    });
    expect(JSON.stringify(harness.repository.governanceAuditEvents[0])).not.toContain(pinnedA.target_session_ref);

    const switchContextA = await harness.targets.resolve(contextA, pinnedA.target_session_ref);
    await harness.switchService.start(switchContextA);
    const switchPage = await harness.switchService.getPage("s".repeat(43));
    await harness.switchService.confirm({
      ticket: "s".repeat(43),
      csrfToken: switchPage.csrfToken,
      selectedConnectionId: "target-connection-b",
    });

    const contextB = await harness.resolveContext();
    const pinnedB = await harness.targets.issue(contextB);
    await expect(harness.targets.resolve(contextB, pinnedA.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    const [resolvedOtherA, resolvedB] = await Promise.all([
      harness.targets.resolve(contextB, pinnedOtherA.target_session_ref),
      harness.targets.resolve(contextB, pinnedB.target_session_ref),
    ]);

    expect(resolvedOtherA).toMatchObject({
      bindingId: "target-binding-a",
      connectionId: "target-connection-a",
      bindingRevision: 1,
    });
    expect(resolvedB).toMatchObject({
      bindingId: "target-binding-b",
      connectionId: "target-connection-b",
      bindingRevision: 2,
    });
    const secondSwitch = await harness.switchService.start(resolvedOtherA);
    expect(secondSwitch.currentOrganisation).toMatchObject({ tenantName: "Client Company A" });
    const secondPage = await harness.switchService.getPage("r".repeat(43));
    await harness.switchService.confirm({
      ticket: "r".repeat(43),
      csrfToken: secondPage.csrfToken,
      selectedConnectionId: "target-connection-b",
    });
    await expect(harness.targets.resolve(contextB, pinnedOtherA.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    await expect(harness.targets.resolve(contextB, pinnedB.target_session_ref)).resolves.toMatchObject({
      connectionId: "target-connection-b",
      bindingRevision: 2,
    });
    expect(pinnedA.target_session_ref).not.toBe(pinnedB.target_session_ref);
    expect(JSON.stringify(await harness.repository.resolveLedgerTargetSession({
      sessionHash: resolvedB.targetSessionHash!,
      installationId: "target-installation",
      workspaceId: "target-workspace",
      subjectType: "USER",
      subjectId: "target-user",
      agentId: "target-agent",
      now: baseNow,
    }))).not.toContain(pinnedA.target_session_ref);
    expect(harness.repository.governanceAuditEvents.filter(
      (event) => event.eventType === "xero.organisation_switch.completed",
    )).toHaveLength(2);
    expect(harness.repository.governanceAuditEvents.find(
      (event) => event.eventType === "xero.organisation_switch.completed",
    )).toMatchObject({
      eventType: "xero.organisation_switch.completed",
      evidence: { sourceTargetRevoked: true },
    });
    await expect(harness.repository.cleanupExpiredEphemeral(baseNow, 100, baseNow)).resolves.toMatchObject({
      deleted: { organisationSwitchSessions: 2, ledgerTargetSessions: 2 },
    });
    await expect(harness.targets.resolve(contextB, pinnedB.target_session_ref)).resolves.toMatchObject({
      connectionId: "target-connection-b",
    });
  });

  it("fails closed for missing, malformed, cross-installation and expired target references", async () => {
    const harness = await createHarness();
    const context = await harness.resolveContext();
    const pinned = await harness.targets.issue(context);

    await expect(harness.targets.resolve(context, undefined)).rejects.toMatchObject({ code: "TARGET_SESSION_REQUIRED" });
    await expect(harness.targets.resolve(context, "not-a-target-ref")).rejects.toMatchObject({ code: "TARGET_SESSION_INVALID" });
    await expect(harness.targets.resolve(Object.freeze({
      ...context,
      oauthInstallationId: "another-installation",
    }), pinned.target_session_ref)).rejects.toMatchObject({ code: "TARGET_SESSION_INVALID" });

    harness.advance(30 * 60_000 + 1);
    await expect(harness.targets.resolve(context, pinned.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
    await expect(harness.repository.cleanupExpiredEphemeral(
      new Date(baseNow.getTime() + 30 * 60_000 + 1),
      100,
      new Date(baseNow.getTime() + 30 * 60_000 + 1),
    )).resolves.toMatchObject({ deleted: { ledgerTargetSessions: 1 } });
  });

  it("requires a fresh pin even when the user confirms the same organisation", async () => {
    const harness = await createHarness();
    const context = await harness.resolveContext();
    const pinned = await harness.targets.issue(context);
    const switchContext = await harness.targets.resolve(context, pinned.target_session_ref);
    await harness.switchService.start(switchContext);
    const page = await harness.switchService.getPage("s".repeat(43));
    const unchanged = await harness.switchService.confirm({
      ticket: "s".repeat(43),
      csrfToken: page.csrfToken,
      selectedConnectionId: "target-connection-a",
    });

    expect(unchanged).toMatchObject({ status: "UNCHANGED" });
    expect(unchanged.message).toContain("pin the organisation again");
    await expect(harness.targets.resolve(context, pinned.target_session_ref)).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
    });
  });

  it("supports an explicit compatibility mode without weakening strict mode", async () => {
    const strictHarness = await createHarness({ required: true });
    const strictContext = await strictHarness.resolveContext();
    await expect(strictHarness.targets.resolve(strictContext, undefined)).rejects.toMatchObject({ code: "TARGET_SESSION_REQUIRED" });

    const compatibleHarness = await createHarness({ required: false });
    const compatibleContext = await compatibleHarness.resolveContext();
    await expect(compatibleHarness.targets.resolve(compatibleContext, undefined)).resolves.toBe(compatibleContext);
  });
});
