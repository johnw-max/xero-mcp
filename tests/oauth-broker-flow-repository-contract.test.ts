import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../src/db/repository.js";
import type {
  AuthorizedProviderConnection,
  CreateBrokerAuthorizationFlowInput,
  McpAccessToken,
  OAuthBrokerAuthorizationFlow,
  OAuthInstallation,
  ProviderAuthorization,
} from "../src/domain/models.js";

const now = new Date("2026-08-05T14:00:00.000Z");
const minuteLater = new Date("2026-08-05T14:01:00.000Z");
const twoMinutesLater = new Date("2026-08-05T14:02:00.000Z");
const fiveMinutesLater = new Date("2026-08-05T14:05:00.000Z");
const tenMinutesLater = new Date("2026-08-05T14:10:00.000Z");
const hourLater = new Date("2026-08-05T15:00:00.000Z");

const hash = (label: string): string => `${label}-${"h".repeat(48)}`;

function retryMetadata(issuedAt: Date) {
  return {
    retryResponseCiphertext: `encrypted-refresh-response-${issuedAt.toISOString()}`,
    retryExpiresAt: new Date(issuedAt.getTime() + 10_000),
  };
}

interface FlowIdentityOverride {
  workspaceId: string;
  subjectId: string;
  agentId: string;
  clientId: string;
}

function createFlowInput(
  suffix: string,
  overrides: Partial<OAuthBrokerAuthorizationFlow> = {},
  identity?: FlowIdentityOverride,
): CreateBrokerAuthorizationFlowInput {
  const installation: OAuthInstallation = {
    installationId: `installation-${suffix}`,
    workspaceId: identity?.workspaceId ?? `workspace-${suffix}`,
    subjectType: "USER",
    subjectId: identity?.subjectId ?? `user-${suffix}`,
    agentId: identity?.agentId ?? `agent-${suffix}`,
    clientId: identity?.clientId ?? `client-${suffix}`,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
  const flow: OAuthBrokerAuthorizationFlow = {
    flowHash: hash(`flow-${suffix}`),
    browserSessionHash: hash(`browser-${suffix}`),
    xeroStateHash: hash(`xero-state-${suffix}`),
    outerStateHash: hash(`outer-state-${suffix}`),
    outerStateCiphertext: `encrypted-outer-state-${suffix}`,
    clientId: installation.clientId,
    redirectUri: `https://host.example.test/${suffix}/oauth/callback`,
    pkceCodeChallenge: hash(`pkce-${suffix}`),
    pkceCodeChallengeMethod: "S256",
    resource: "https://mcp.example.test/mcp",
    audience: "xero-accounting-mcp",
    requestedScopes: ["xero.read", "xero.draft.write"],
    workspaceId: installation.workspaceId,
    subjectType: installation.subjectType,
    subjectId: installation.subjectId,
    agentId: installation.agentId,
    installationId: installation.installationId,
    personalPoc: true,
    status: "AUTHORIZING_XERO",
    expiresAt: tenMinutesLater,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return { installation, flow };
}

function providerExchange(
  input: CreateBrokerAuthorizationFlowInput,
  suffix: string,
  connectionCount = 2,
): {
  authorization: ProviderAuthorization;
  connections: AuthorizedProviderConnection[];
} {
  const authorization: ProviderAuthorization = {
    authorizationId: `authorization-${suffix}`,
    workspaceId: input.flow.workspaceId,
    authorizedBySubject: input.flow.subjectId,
    provider: "xero",
    providerSubject: `xero-user-${suffix}`,
    grantedScopes: [
      "openid",
      "offline_access",
      "accounting.invoices.read",
      "accounting.invoices",
    ],
    tokenCiphertext: `encrypted-xero-token-set-${suffix}`,
    tokenExpiresAt: hourLater,
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: minuteLater,
    updatedAt: minuteLater,
  };
  const connections = Array.from({ length: connectionCount }, (_, index): AuthorizedProviderConnection => ({
    connectionId: `connection-${suffix}-${index + 1}`,
    authorizationId: authorization.authorizationId,
    provider: "xero",
    providerConnectionId: `xero-connection-${suffix}-${index + 1}`,
    tenantId: `tenant-${suffix}-${index + 1}`,
    tenantName: `Organisation ${suffix} ${index + 1}`,
    status: "ACTIVE",
    lastVerifiedAt: minuteLater,
    createdAt: minuteLater,
    updatedAt: minuteLater,
  }));
  return { authorization, connections };
}

async function advanceToSelection(
  repository: AccountingRepository,
  suffix: string,
  flowOverrides: Partial<OAuthBrokerAuthorizationFlow> = {},
  connectionCount = 2,
  identity?: FlowIdentityOverride,
) {
  const created = createFlowInput(suffix, flowOverrides, identity);
  await repository.createBrokerAuthorizationFlow(created);
  await expect(repository.beginBrokerXeroCallback({
    flowHash: created.flow.flowHash,
    browserSessionHash: created.flow.browserSessionHash,
    xeroStateHash: created.flow.xeroStateHash,
    now: minuteLater,
  })).resolves.toMatchObject({ status: "EXCHANGING_XERO" });
  const exchange = providerExchange(created, suffix, connectionCount);
  const selectionCsrfHash = hash(`selection-csrf-${suffix}`);
  await expect(repository.completeBrokerXeroExchange({
    flowHash: created.flow.flowHash,
    browserSessionHash: created.flow.browserSessionHash,
    authorization: exchange.authorization,
    connections: exchange.connections,
    selectionCsrfHash,
    now: twoMinutesLater,
  })).resolves.toMatchObject({ status: "AWAITING_SELECTION" });
  return { ...created, ...exchange, selectionCsrfHash };
}

describe("OAuth Broker V2 flow repository contract", () => {
  it("atomically creates a pending installation and a complete V2 browser flow", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const first = createFlowInput("create");
    await expect(repository.createBrokerAuthorizationFlow(first)).resolves.toMatchObject({
      installation: { status: "PENDING" },
      flow: {
        status: "AUTHORIZING_XERO",
        installationId: first.installation.installationId,
        outerStateCiphertext: first.flow.outerStateCiphertext,
      },
    });

    const rolledBack = createFlowInput("rolled-back", { flowHash: first.flow.flowHash });
    await expect(repository.createBrokerAuthorizationFlow(rolledBack)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.saveOAuthInstallation(rolledBack.installation)).resolves.toMatchObject({
      installationId: rolledBack.installation.installationId,
    });
  });

  it("binds the Xero callback to flow, browser, keyed Xero state, TTL, and one atomic transition", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const input = createFlowInput("callback");
    await repository.createBrokerAuthorizationFlow(input);

    for (const mismatch of [
      { browserSessionHash: hash("wrong-browser") },
      { xeroStateHash: hash("wrong-xero-state") },
      { flowHash: hash("wrong-flow") },
    ]) {
      await expect(repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: minuteLater,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    const [first, replay] = await Promise.all([
      repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: minuteLater,
      }),
      repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: minuteLater,
      }),
    ]);
    expect([first?.status, replay?.status].sort()).toEqual(["EXCHANGING_XERO", undefined].sort());

    const expired = createFlowInput("expired", { expiresAt: minuteLater });
    await repository.createBrokerAuthorizationFlow(expired);
    await expect(repository.beginBrokerXeroCallback({
      flowHash: expired.flow.flowHash,
      browserSessionHash: expired.flow.browserSessionHash,
      xeroStateHash: expired.flow.xeroStateHash,
      now: minuteLater,
    })).resolves.toBeUndefined();
  });

  it("atomically persists one ProviderAuthorization, every discovered organisation, and the selection CSRF", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const input = createFlowInput("exchange");
    await repository.createBrokerAuthorizationFlow(input);
    await repository.beginBrokerXeroCallback({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      xeroStateHash: input.flow.xeroStateHash,
      now: minuteLater,
    });
    const exchange = providerExchange(input, "exchange");

    await expect(repository.completeBrokerXeroExchange({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      authorization: exchange.authorization,
      connections: [{ ...exchange.connections[0]!, authorizationId: "another-authorization" }],
      selectionCsrfHash: hash("bad-csrf"),
      now: twoMinutesLater,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(repository.completeBrokerXeroExchange({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      authorization: exchange.authorization,
      connections: exchange.connections,
      selectionCsrfHash: hash("selection-csrf-exchange"),
      now: twoMinutesLater,
    })).resolves.toMatchObject({
      status: "AWAITING_SELECTION",
      authorizationId: exchange.authorization.authorizationId,
      selectionCsrfHash: hash("selection-csrf-exchange"),
    });
    await expect(repository.getBrokerSelection({
      flowHash: input.flow.flowHash,
      browserSessionHash: input.flow.browserSessionHash,
      now: twoMinutesLater,
    })).resolves.toMatchObject({
      flow: { status: "AWAITING_SELECTION" },
      connections: [
        { connectionId: exchange.connections[0]!.connectionId },
        { connectionId: exchange.connections[1]!.connectionId },
      ],
    });
    await expect(repository.getBrokerSelection({
      flowHash: input.flow.flowHash,
      browserSessionHash: hash("cross-browser"),
      now: twoMinutesLater,
    })).resolves.toBeUndefined();
  });

  it("requires explicit same-browser organisation selection and atomically issues a flow-bound code", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const context = await advanceToSelection(repository, "selection");
    const baseSelection = {
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[1]!.connectionId,
      bindingId: "binding-selection",
      policyId: "policy-selection",
      authorizationCodeHash: hash("authorization-code-selection"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    };

    for (const mismatch of [
      { browserSessionHash: hash("wrong-browser") },
      { selectionCsrfHash: hash("wrong-csrf") },
      { selectedConnectionId: "connection-from-another-authorization" },
    ]) {
      await expect(repository.completeBrokerOrganisationSelection({
        ...baseSelection,
        ...mismatch,
      })).resolves.toBeUndefined();
    }

    const [first, concurrent] = await Promise.all([
      repository.completeBrokerOrganisationSelection(baseSelection),
      repository.completeBrokerOrganisationSelection({
        ...baseSelection,
        bindingId: "binding-selection-concurrent",
        authorizationCodeHash: hash("authorization-code-selection-concurrent"),
      }),
    ]);
    const issued = first ?? concurrent;
    expect([first, concurrent].filter(Boolean)).toHaveLength(1);
    expect(issued).toMatchObject({
      outerStateCiphertext: context.flow.outerStateCiphertext,
      flow: {
        status: "COMPLETED",
        consumedAt: twoMinutesLater,
      },
      installation: { status: "ACTIVE" },
      binding: {
        connectionId: context.connections[1]!.connectionId,
        status: "ACTIVE",
      },
      authorizationCode: {
        flowHash: context.flow.flowHash,
        clientId: context.flow.clientId,
        redirectUri: context.flow.redirectUri,
        pkceCodeChallenge: context.flow.pkceCodeChallenge,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: context.flow.requestedScopes,
        connectionId: context.connections[1]!.connectionId,
      },
    });
    expect(issued?.flow).not.toHaveProperty("outerStateCiphertext");
    expect(issued?.flow).not.toHaveProperty("selectionCsrfHash");
    await expect(repository.getBrokerSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      now: twoMinutesLater,
    })).resolves.toBeUndefined();
  });

  it("makes resource part of the final atomic authorization-code exchange judgement", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const context = await advanceToSelection(repository, "resource-final", {}, 1);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: "binding-resource-final",
      policyId: "policy-resource-final",
      authorizationCodeHash: hash("authorization-code-resource-final"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });
    if (!issued) throw new Error("expected selection to complete");

    const familyId = "refresh-family-resource-final";
    const exchangeInput = {
      grant: {
        codeHash: issued.authorizationCode.codeHash,
        clientId: issued.authorizationCode.clientId,
        redirectUri: issued.authorizationCode.redirectUri,
        pkceCodeChallenge: issued.authorizationCode.pkceCodeChallenge,
        expectedResource: issued.authorizationCode.resource,
        now: twoMinutesLater,
      },
      refreshTokenFamily: {
        family: {
          familyId,
          installationId: issued.installation.installationId,
          bindingId: issued.binding.bindingId,
          connectionId: issued.binding.connectionId,
          clientId: issued.authorizationCode.clientId,
          resource: issued.authorizationCode.resource,
          audience: issued.authorizationCode.audience,
          grantedScopes: issued.authorizationCode.grantedScopes,
          status: "ACTIVE" as const,
          createdAt: twoMinutesLater,
          updatedAt: twoMinutesLater,
        },
        initialToken: {
          tokenHash: hash("refresh-token-resource-final"),
          tokenId: "refresh-token-resource-final",
          familyId,
          issuedAt: twoMinutesLater,
          expiresAt: hourLater,
        },
      },
      accessToken: {
        tokenHash: hash("access-token-resource-final"),
        tokenId: "access-token-resource-final",
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        refreshFamilyId: familyId,
        clientId: issued.authorizationCode.clientId,
        resource: issued.authorizationCode.resource,
        audience: issued.authorizationCode.audience,
        grantedScopes: issued.authorizationCode.grantedScopes,
        issuedAt: twoMinutesLater,
        expiresAt: hourLater,
      },
    };

    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet({
      ...exchangeInput,
      grant: { ...exchangeInput.grant, expectedResource: "https://wrong-resource.example/mcp" },
    })).resolves.toEqual({ status: "INVALID" });
    await expect(repository.peekOAuthAuthorizationCodeForExchange({
      ...exchangeInput.grant,
    })).resolves.toBeDefined();
    await expect(repository.exchangeOAuthAuthorizationCodeForTokenSet(exchangeInput)).resolves.toMatchObject({
      status: "ISSUED",
      authorizationCode: { consumedAt: twoMinutesLater },
    });
  });

  it("scrubs encrypted outer state from expired flows in bounded cleanup batches", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const expired = ["expired-cleanup-a", "expired-cleanup-b", "expired-cleanup-c"]
      .map((suffix) => createFlowInput(suffix, { expiresAt: minuteLater }));
    for (const input of expired) await repository.createBrokerAuthorizationFlow(input);
    const expiredAwaiting = await advanceToSelection(
      repository,
      "expired-cleanup-awaiting",
      { expiresAt: fiveMinutesLater },
      1,
    );
    const validAwaiting = await advanceToSelection(repository, "valid-cleanup-awaiting", {}, 1);
    const valid = createFlowInput("valid-cleanup");
    await repository.createBrokerAuthorizationFlow(valid);

    const first = await repository.cleanupExpiredEphemeral(minuteLater, 2);
    expect(first.deleted.oauthBrokerFlows).toBe(2);
    const second = await repository.cleanupExpiredEphemeral(minuteLater, 2);
    expect(second.deleted.oauthBrokerFlows).toBe(1);
    const third = await repository.cleanupExpiredEphemeral(minuteLater, 2);
    expect(third.deleted.oauthBrokerFlows).toBe(0);
    await expect(repository.beginBrokerXeroCallback({
      flowHash: expired[0]!.flow.flowHash,
      browserSessionHash: expired[0]!.flow.browserSessionHash,
      xeroStateHash: expired[0]!.flow.xeroStateHash,
      now: minuteLater,
    })).resolves.toBeUndefined();
    await expect(repository.beginBrokerXeroCallback({
      flowHash: valid.flow.flowHash,
      browserSessionHash: valid.flow.browserSessionHash,
      xeroStateHash: valid.flow.xeroStateHash,
      now: minuteLater,
    })).resolves.toMatchObject({ status: "EXCHANGING_XERO" });

    const expiredSelectionCleanup = await repository.cleanupExpiredEphemeral(fiveMinutesLater, 10);
    expect(expiredSelectionCleanup.deleted.oauthBrokerFlows).toBe(1);
    await expect(repository.getProviderAuthorization(
      expiredAwaiting.authorization.authorizationId,
      expiredAwaiting.flow.workspaceId,
      expiredAwaiting.flow.subjectId,
    )).resolves.toMatchObject({ status: "REVOKED", revokedAt: fiveMinutesLater });
    await expect(repository.listActiveConnectionsByAuthorization(
      expiredAwaiting.authorization.authorizationId,
      expiredAwaiting.flow.workspaceId,
    )).resolves.toEqual([]);
    await expect(repository.saveOAuthInstallation({
      ...expiredAwaiting.installation,
      updatedAt: fiveMinutesLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getProviderAuthorization(
      validAwaiting.authorization.authorizationId,
      validAwaiting.flow.workspaceId,
      validAwaiting.flow.subjectId,
    )).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(repository.listActiveConnectionsByAuthorization(
      validAwaiting.authorization.authorizationId,
      validAwaiting.flow.workspaceId,
    )).resolves.toHaveLength(1);
  });

  it("never auto-selects a sole organisation and rejects a racing selection for the same MCP client", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity: FlowIdentityOverride = {
      workspaceId: "workspace-poc-race",
      subjectId: "user-poc-race",
      agentId: "agent-poc-race",
      clientId: "client-poc-race",
    };
    const first = await advanceToSelection(repository, "poc-first", {}, 1, identity);
    const second = await advanceToSelection(repository, "poc-second", {}, 1, identity);

    await expect(repository.getBrokerSelection({
      flowHash: first.flow.flowHash,
      browserSessionHash: first.flow.browserSessionHash,
      now: twoMinutesLater,
    })).resolves.toMatchObject({ connections: [{ connectionId: first.connections[0]!.connectionId }] });

    await expect(repository.completeBrokerOrganisationSelection({
      flowHash: first.flow.flowHash,
      browserSessionHash: first.flow.browserSessionHash,
      selectionCsrfHash: first.selectionCsrfHash,
      selectedConnectionId: first.connections[0]!.connectionId,
      bindingId: "binding-poc-first",
      policyId: "policy-poc-first",
      authorizationCodeHash: hash("code-poc-first"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    })).resolves.toMatchObject({ flow: { status: "COMPLETED" } });

    await expect(repository.completeBrokerOrganisationSelection({
      flowHash: second.flow.flowHash,
      browserSessionHash: second.flow.browserSessionHash,
      selectionCsrfHash: second.selectionCsrfHash,
      selectedConnectionId: second.connections[0]!.connectionId,
      bindingId: "binding-poc-second",
      policyId: "policy-poc-second",
      authorizationCodeHash: hash("code-poc-second"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    })).resolves.toBeUndefined();
  });

  it("allows distinct Personal POC MCP clients to remain connected independently", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const first = await advanceToSelection(repository, "poc-client-a", {}, 1);
    const second = await advanceToSelection(repository, "poc-client-b", {}, 1);
    const complete = (context: typeof first, suffix: string) => repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: `binding-${suffix}`,
      policyId: `policy-${suffix}`,
      authorizationCodeHash: hash(`code-${suffix}`),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });

    await expect(complete(first, "poc-client-a")).resolves.toMatchObject({ installation: { status: "ACTIVE" } });
    await expect(complete(second, "poc-client-b")).resolves.toMatchObject({ installation: { status: "ACTIVE" } });
  });

  it("atomically replaces an established Personal POC grant for the same MCP client", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity: FlowIdentityOverride = {
      workspaceId: "workspace-poc-reauthorize",
      subjectId: "user-poc-reauthorize",
      agentId: "agent-poc-reauthorize",
      clientId: "client-poc-reauthorize",
    };
    const first = await advanceToSelection(repository, "poc-reauthorize-first", {}, 1, identity);
    const firstIssued = await repository.completeBrokerOrganisationSelection({
      flowHash: first.flow.flowHash,
      browserSessionHash: first.flow.browserSessionHash,
      selectionCsrfHash: first.selectionCsrfHash,
      selectedConnectionId: first.connections[0]!.connectionId,
      bindingId: "binding-poc-reauthorize-first",
      policyId: "policy-poc-reauthorize-first",
      authorizationCodeHash: hash("code-poc-reauthorize-first"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });
    if (!firstIssued) throw new Error("expected first grant to complete");
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId: "family-poc-reauthorize-first",
        installationId: firstIssued.installation.installationId,
        bindingId: firstIssued.binding.bindingId,
        connectionId: firstIssued.binding.connectionId,
        clientId: first.flow.clientId,
        resource: first.flow.resource,
        audience: first.flow.audience,
        grantedScopes: first.flow.requestedScopes,
        status: "ACTIVE",
        createdAt: twoMinutesLater,
        updatedAt: twoMinutesLater,
      },
      initialToken: {
        tokenHash: hash("refresh-poc-reauthorize-first"),
        tokenId: "refresh-poc-reauthorize-first",
        familyId: "family-poc-reauthorize-first",
        issuedAt: twoMinutesLater,
        expiresAt: hourLater,
      },
    });

    const second = await advanceToSelection(repository, "poc-reauthorize-second", {}, 1, identity);
    await expect(repository.completeBrokerOrganisationSelection({
      flowHash: second.flow.flowHash,
      browserSessionHash: second.flow.browserSessionHash,
      selectionCsrfHash: second.selectionCsrfHash,
      selectedConnectionId: second.connections[0]!.connectionId,
      bindingId: "binding-poc-reauthorize-second",
      policyId: "policy-poc-reauthorize-second",
      authorizationCodeHash: hash("code-poc-reauthorize-second"),
      authorizationCodeExpiresAt: tenMinutesLater,
      now: fiveMinutesLater,
    })).resolves.toMatchObject({ installation: { status: "ACTIVE" } });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: firstIssued.installation.installationId,
      bindingId: firstIssued.binding.bindingId,
      workspaceId: firstIssued.binding.workspaceId,
      subjectType: firstIssued.binding.subjectType,
      subjectId: firstIssued.binding.subjectId,
      agentId: firstIssued.binding.agentId,
      connectionId: firstIssued.binding.connectionId,
    })).resolves.toBeUndefined();
  });

  it("terminates denied or failed flows once, returns outer state only to the caller, and clears ciphertext", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    for (const terminalStatus of ["DENIED", "FAILED"] as const) {
      const input = createFlowInput(`terminal-${terminalStatus.toLowerCase()}`);
      await repository.createBrokerAuthorizationFlow(input);
      const terminated = await repository.terminateBrokerAuthorizationFlow({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        terminalStatus,
        now: minuteLater,
      });
      expect(terminated).toMatchObject({
        outerStateCiphertext: input.flow.outerStateCiphertext,
        flow: {
          status: terminalStatus,
          consumedAt: minuteLater,
        },
      });
      expect(terminated?.flow).not.toHaveProperty("outerStateCiphertext");
      await expect(repository.terminateBrokerAuthorizationFlow({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        terminalStatus,
        now: minuteLater,
      })).resolves.toBeUndefined();
      await expect(repository.beginBrokerXeroCallback({
        flowHash: input.flow.flowHash,
        browserSessionHash: input.flow.browserSessionHash,
        xeroStateHash: input.flow.xeroStateHash,
        now: minuteLater,
      })).resolves.toBeUndefined();
    }
  });

  it("atomically revokes only the pending grant when an awaiting-selection flow terminates", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const victim = await advanceToSelection(repository, "terminal-awaiting-victim", {}, 2);
    const survivor = await advanceToSelection(repository, "terminal-awaiting-survivor", {}, 1);

    await expect(repository.terminateBrokerAuthorizationFlow({
      flowHash: victim.flow.flowHash,
      browserSessionHash: victim.flow.browserSessionHash,
      terminalStatus: "FAILED",
      now: fiveMinutesLater,
    })).resolves.toMatchObject({ flow: { status: "FAILED" } });
    await expect(repository.getProviderAuthorization(
      victim.authorization.authorizationId,
      victim.flow.workspaceId,
      victim.flow.subjectId,
    )).resolves.toMatchObject({ status: "REVOKED", revokedAt: fiveMinutesLater });
    await expect(repository.listActiveConnectionsByAuthorization(
      victim.authorization.authorizationId,
      victim.flow.workspaceId,
    )).resolves.toEqual([]);
    await expect(repository.saveOAuthInstallation({
      ...victim.installation,
      updatedAt: fiveMinutesLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(repository.getProviderAuthorization(
      survivor.authorization.authorizationId,
      survivor.flow.workspaceId,
      survivor.flow.subjectId,
    )).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(repository.listActiveConnectionsByAuthorization(
      survivor.authorization.authorizationId,
      survivor.flow.workspaceId,
    )).resolves.toHaveLength(1);
    await expect(repository.getBrokerSelection({
      flowHash: survivor.flow.flowHash,
      browserSessionHash: survivor.flow.browserSessionHash,
      now: fiveMinutesLater,
    })).resolves.toBeDefined();
  });

  it("disconnects the exact grant on refresh replay and allows Personal POC reconnection", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const context = await advanceToSelection(repository, "refresh-replay", {}, 1);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: "binding-refresh-replay",
      policyId: "policy-refresh-replay",
      authorizationCodeHash: hash("authorization-code-refresh-replay"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });
    if (!issued) throw new Error("expected replay test selection to complete");

    const familyId = "family-refresh-replay";
    const initialRefreshHash = hash("refresh-replay-0");
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: context.flow.clientId,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: twoMinutesLater,
        updatedAt: twoMinutesLater,
      },
      initialToken: {
        tokenHash: initialRefreshHash,
        tokenId: "refresh-replay-0",
        familyId,
        issuedAt: twoMinutesLater,
        expiresAt: hourLater,
      },
    });
    const initialAccess: McpAccessToken = {
      tokenHash: hash("access-refresh-replay-0"),
      tokenId: "access-refresh-replay-0",
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: context.flow.clientId,
      resource: context.flow.resource,
      audience: context.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: twoMinutesLater,
      expiresAt: hourLater,
    };
    await repository.saveMcpAccessToken(initialAccess);
    const rotatedAt = fiveMinutesLater;
    const rotatedRefreshHash = hash("refresh-replay-1");
    const rotatedAccess: McpAccessToken = {
      ...initialAccess,
      tokenHash: hash("access-refresh-replay-1"),
      tokenId: "access-refresh-replay-1",
      issuedAt: rotatedAt,
    };
    const rotation = {
      currentTokenHash: initialRefreshHash,
      expectedClientId: context.flow.clientId,
      expectedResource: context.flow.resource,
      expectedAudience: context.flow.audience,
      newTokenHash: rotatedRefreshHash,
      newTokenId: "refresh-replay-1",
      issuedAt: rotatedAt,
      expiresAt: hourLater,
    };
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation,
      accessToken: rotatedAccess,
      ...retryMetadata(rotatedAt),
    })).resolves.toMatchObject({ status: "ROTATED", familyId });

    const replayAt = new Date("2026-08-05T14:06:00.000Z");
    await expect(repository.rotateMcpRefreshTokenAndIssueAccessToken({
      rotation: {
        ...rotation,
        newTokenHash: hash("refresh-replay-forbidden"),
        newTokenId: "refresh-replay-forbidden",
        issuedAt: replayAt,
      },
      accessToken: {
        ...rotatedAccess,
        tokenHash: hash("access-refresh-replay-forbidden"),
        tokenId: "access-refresh-replay-forbidden",
        issuedAt: replayAt,
      },
    })).resolves.toEqual({ status: "REPLAY_DETECTED", familyId });

    const bindingResolution = {
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      workspaceId: issued.binding.workspaceId,
      subjectType: issued.binding.subjectType,
      subjectId: issued.binding.subjectId,
      agentId: issued.binding.agentId,
      connectionId: issued.binding.connectionId,
    };
    await expect(repository.resolveAgentConnectionBinding(bindingResolution)).resolves.toBeUndefined();
    for (const token of [initialAccess, rotatedAccess]) {
      await expect(repository.resolveMcpAccessToken({
        tokenHash: token.tokenHash,
        expectedResource: token.resource,
        expectedAudience: token.audience,
        now: replayAt,
      })).resolves.toBeUndefined();
    }
    await expect(repository.saveOAuthInstallation({
      ...issued.installation,
      status: "ACTIVE",
      updatedAt: replayAt,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const reconnected = await advanceToSelection(
      repository,
      "refresh-replay-reconnected",
      { expiresAt: hourLater },
      1,
    );
    await expect(repository.completeBrokerOrganisationSelection({
      flowHash: reconnected.flow.flowHash,
      browserSessionHash: reconnected.flow.browserSessionHash,
      selectionCsrfHash: reconnected.selectionCsrfHash,
      selectedConnectionId: reconnected.connections[0]!.connectionId,
      bindingId: "binding-refresh-replay-reconnected",
      policyId: "policy-refresh-replay-reconnected",
      authorizationCodeHash: hash("authorization-code-refresh-replay-reconnected"),
      authorizationCodeExpiresAt: new Date("2026-08-05T14:15:00.000Z"),
      now: tenMinutesLater,
    })).resolves.toMatchObject({
      installation: { status: "ACTIVE" },
      binding: { status: "ACTIVE" },
    });
  });

  it("atomically replaces the same Personal POC principal when its refresh grant has naturally expired", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const identity: FlowIdentityOverride = {
      workspaceId: "workspace-expired-reconnect",
      subjectId: "user-expired-reconnect",
      agentId: "agent-expired-reconnect",
      clientId: "client-expired-reconnect",
    };
    const oldContext = await advanceToSelection(
      repository,
      "expired-reconnect-old",
      {},
      1,
      identity,
    );
    const oldIssued = await repository.completeBrokerOrganisationSelection({
      flowHash: oldContext.flow.flowHash,
      browserSessionHash: oldContext.flow.browserSessionHash,
      selectionCsrfHash: oldContext.selectionCsrfHash,
      selectedConnectionId: oldContext.connections[0]!.connectionId,
      bindingId: "binding-expired-reconnect-old",
      policyId: "policy-expired-reconnect-old",
      authorizationCodeHash: hash("code-expired-reconnect-old"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });
    if (!oldIssued) throw new Error("expected old Personal POC selection to complete");

    const familyId = "family-expired-reconnect-old";
    const refreshTokenHash = hash("refresh-expired-reconnect-old");
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: oldIssued.installation.installationId,
        bindingId: oldIssued.binding.bindingId,
        connectionId: oldIssued.binding.connectionId,
        clientId: identity.clientId,
        resource: oldContext.flow.resource,
        audience: oldContext.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: twoMinutesLater,
        updatedAt: twoMinutesLater,
      },
      initialToken: {
        tokenHash: refreshTokenHash,
        tokenId: "refresh-expired-reconnect-old",
        familyId,
        issuedAt: twoMinutesLater,
        expiresAt: fiveMinutesLater,
      },
    });
    const accessToken: McpAccessToken = {
      tokenHash: hash("access-expired-reconnect-old"),
      tokenId: "access-expired-reconnect-old",
      installationId: oldIssued.installation.installationId,
      bindingId: oldIssued.binding.bindingId,
      connectionId: oldIssued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: identity.clientId,
      resource: oldContext.flow.resource,
      audience: oldContext.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: twoMinutesLater,
      expiresAt: hourLater,
    };
    await repository.saveMcpAccessToken(accessToken);

    const newContext = await advanceToSelection(
      repository,
      "expired-reconnect-new",
      {},
      1,
      identity,
    );
    const reconnectedAt = new Date("2026-08-05T14:06:00.000Z");
    const reconnected = await repository.completeBrokerOrganisationSelection({
      flowHash: newContext.flow.flowHash,
      browserSessionHash: newContext.flow.browserSessionHash,
      selectionCsrfHash: newContext.selectionCsrfHash,
      selectedConnectionId: newContext.connections[0]!.connectionId,
      bindingId: "binding-expired-reconnect-new",
      policyId: "policy-expired-reconnect-new",
      authorizationCodeHash: hash("code-expired-reconnect-new"),
      authorizationCodeExpiresAt: tenMinutesLater,
      now: reconnectedAt,
    });
    expect(reconnected).toMatchObject({
      installation: { status: "ACTIVE" },
      binding: { status: "ACTIVE" },
    });
    await expect(repository.resolveAgentConnectionBinding({
      installationId: oldIssued.installation.installationId,
      bindingId: oldIssued.binding.bindingId,
      workspaceId: oldIssued.binding.workspaceId,
      subjectType: oldIssued.binding.subjectType,
      subjectId: oldIssued.binding.subjectId,
      agentId: oldIssued.binding.agentId,
      connectionId: oldIssued.binding.connectionId,
    })).resolves.toBeUndefined();
    await expect(repository.peekMcpRefreshTokenContext({
      tokenHash: refreshTokenHash,
      clientId: identity.clientId,
      expectedResource: oldContext.flow.resource,
      expectedAudience: oldContext.flow.audience,
      now: reconnectedAt,
    })).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessToken.tokenHash,
      expectedResource: accessToken.resource,
      expectedAudience: accessToken.audience,
      now: reconnectedAt,
    })).resolves.toBeUndefined();
    await expect(repository.getProviderAuthorization(
      oldContext.authorization.authorizationId,
      identity.workspaceId,
      identity.subjectId,
    )).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(repository.listActiveConnectionsByAuthorization(
      oldContext.authorization.authorizationId,
      identity.workspaceId,
    )).resolves.toHaveLength(1);
  });

  it("provides non-consuming, tuple-bound code and refresh previews and client-safe revocation", async () => {
    const repository: AccountingRepository = new InMemoryAccountingRepository();
    const context = await advanceToSelection(repository, "preview", {}, 1);
    const issued = await repository.completeBrokerOrganisationSelection({
      flowHash: context.flow.flowHash,
      browserSessionHash: context.flow.browserSessionHash,
      selectionCsrfHash: context.selectionCsrfHash,
      selectedConnectionId: context.connections[0]!.connectionId,
      bindingId: "binding-preview",
      policyId: "policy-preview",
      authorizationCodeHash: hash("authorization-code-preview"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    });
    if (!issued) throw new Error("expected selection to complete");
    const previewInput = {
      codeHash: issued.authorizationCode.codeHash,
      clientId: issued.authorizationCode.clientId,
      redirectUri: issued.authorizationCode.redirectUri,
      pkceCodeChallenge: issued.authorizationCode.pkceCodeChallenge,
      expectedResource: issued.authorizationCode.resource,
      now: twoMinutesLater,
    };
    await expect(repository.peekOAuthAuthorizationCodeForExchange(previewInput)).resolves.toMatchObject({
      connectionId: context.connections[0]!.connectionId,
      grantedScopes: context.flow.requestedScopes,
    });
    await expect(repository.peekOAuthAuthorizationCodeForExchange(previewInput)).resolves.toBeDefined();
    await expect(repository.peekOAuthAuthorizationCodeForExchange({
      ...previewInput,
      expectedResource: "https://wrong-resource.example/mcp",
    })).resolves.toBeUndefined();
    await expect(repository.consumeOAuthAuthorizationCode({
      codeHash: issued.authorizationCode.codeHash,
      clientId: issued.authorizationCode.clientId,
      redirectUri: issued.authorizationCode.redirectUri,
      pkceCodeChallenge: issued.authorizationCode.pkceCodeChallenge,
      now: twoMinutesLater,
    })).resolves.toBeDefined();
    await expect(repository.peekOAuthAuthorizationCodeForExchange(previewInput)).resolves.toBeUndefined();

    const familyId = "refresh-family-preview";
    await repository.createMcpRefreshTokenFamily({
      family: {
        familyId,
        installationId: issued.installation.installationId,
        bindingId: issued.binding.bindingId,
        connectionId: issued.binding.connectionId,
        clientId: context.flow.clientId,
        resource: context.flow.resource,
        audience: context.flow.audience,
        grantedScopes: ["xero.read"],
        status: "ACTIVE",
        createdAt: twoMinutesLater,
        updatedAt: twoMinutesLater,
      },
      initialToken: {
        tokenHash: hash("refresh-token-preview-0"),
        tokenId: "refresh-token-preview-0",
        familyId,
        issuedAt: twoMinutesLater,
        expiresAt: hourLater,
      },
    });
    const accessToken: McpAccessToken = {
      tokenHash: hash("access-token-preview"),
      tokenId: "access-token-preview",
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      connectionId: issued.binding.connectionId,
      refreshFamilyId: familyId,
      clientId: context.flow.clientId,
      resource: context.flow.resource,
      audience: context.flow.audience,
      grantedScopes: ["xero.read"],
      issuedAt: twoMinutesLater,
      expiresAt: hourLater,
    };
    await repository.saveMcpAccessToken(accessToken);
    const bindingResolutionInput = {
      installationId: issued.installation.installationId,
      bindingId: issued.binding.bindingId,
      workspaceId: issued.binding.workspaceId,
      subjectType: issued.binding.subjectType,
      subjectId: issued.binding.subjectId,
      agentId: issued.binding.agentId,
      connectionId: issued.binding.connectionId,
    };

    const refreshPreviewInput = {
      tokenHash: hash("refresh-token-preview-0"),
      clientId: context.flow.clientId,
      expectedResource: context.flow.resource,
      expectedAudience: context.flow.audience,
      now: twoMinutesLater,
    };
    await expect(repository.peekMcpRefreshTokenContext(refreshPreviewInput)).resolves.toMatchObject({
      familyId,
      consumed: false,
      grantedScopes: ["xero.read"],
    });
    await expect(repository.peekMcpRefreshTokenContext({
      ...refreshPreviewInput,
      clientId: "another-client",
    })).resolves.toBeUndefined();

    await expect(repository.rotateMcpRefreshToken({
      currentTokenHash: refreshPreviewInput.tokenHash,
      expectedClientId: context.flow.clientId,
      expectedResource: context.flow.resource,
      expectedAudience: context.flow.audience,
      newTokenHash: hash("refresh-token-preview-1"),
      newTokenId: "refresh-token-preview-1",
      issuedAt: new Date("2026-08-05T14:03:00.000Z"),
      expiresAt: hourLater,
    })).resolves.toMatchObject({ status: "ROTATED" });
    await expect(repository.peekMcpRefreshTokenContext({
      ...refreshPreviewInput,
      now: new Date("2026-08-05T14:03:00.000Z"),
    })).resolves.toMatchObject({ consumed: true });

    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: accessToken.tokenHash,
      clientId: "another-client",
      revokedAt: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessToken.tokenHash,
      expectedResource: accessToken.resource,
      expectedAudience: accessToken.audience,
      now: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toBeDefined();
    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: accessToken.tokenHash,
      clientId: accessToken.clientId,
      revokedAt: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveMcpAccessToken({
      tokenHash: accessToken.tokenHash,
      expectedResource: accessToken.resource,
      expectedAudience: accessToken.audience,
      now: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toBeUndefined();
    await expect(repository.resolveAgentConnectionBinding(bindingResolutionInput)).resolves.toBeDefined();
    const derivedAccessToken: McpAccessToken = {
      ...accessToken,
      tokenHash: hash("access-token-preview-derived"),
      tokenId: "access-token-preview-derived",
      issuedAt: new Date("2026-08-05T14:04:00.000Z"),
    };
    await repository.saveMcpAccessToken(derivedAccessToken);
    await expect(repository.resolveMcpAccessToken({
      tokenHash: derivedAccessToken.tokenHash,
      expectedResource: derivedAccessToken.resource,
      expectedAudience: derivedAccessToken.audience,
      now: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toBeDefined();
    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: hash("refresh-token-preview-1"),
      clientId: context.flow.clientId,
      revokedAt: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toEqual({ status: "ACCEPTED" });
    await expect(repository.resolveAgentConnectionBinding(bindingResolutionInput)).resolves.toBeUndefined();
    await expect(repository.resolveMcpAccessToken({
      tokenHash: derivedAccessToken.tokenHash,
      expectedResource: derivedAccessToken.resource,
      expectedAudience: derivedAccessToken.audience,
      now: new Date("2026-08-05T14:04:00.000Z"),
    })).resolves.toBeUndefined();
    await expect(repository.saveOAuthInstallation({
      ...issued.installation,
      status: "ACTIVE",
      updatedAt: fiveMinutesLater,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.rotateMcpRefreshToken({
      currentTokenHash: hash("refresh-token-preview-1"),
      expectedClientId: context.flow.clientId,
      expectedResource: context.flow.resource,
      expectedAudience: context.flow.audience,
      newTokenHash: hash("refresh-token-preview-2"),
      newTokenId: "refresh-token-preview-2",
      issuedAt: fiveMinutesLater,
      expiresAt: hourLater,
    })).resolves.toEqual({ status: "INVALID" });
    await expect(repository.revokeOAuthTokenForClient({
      tokenHash: hash("unknown-token"),
      clientId: context.flow.clientId,
      revokedAt: fiveMinutesLater,
    })).resolves.toEqual({ status: "ACCEPTED" });

    const reconnected = await advanceToSelection(repository, "preview-reconnected", {}, 1);
    await expect(repository.completeBrokerOrganisationSelection({
      flowHash: reconnected.flow.flowHash,
      browserSessionHash: reconnected.flow.browserSessionHash,
      selectionCsrfHash: reconnected.selectionCsrfHash,
      selectedConnectionId: reconnected.connections[0]!.connectionId,
      bindingId: "binding-preview-reconnected",
      policyId: "policy-preview-reconnected",
      authorizationCodeHash: hash("authorization-code-preview-reconnected"),
      authorizationCodeExpiresAt: fiveMinutesLater,
      now: twoMinutesLater,
    })).resolves.toMatchObject({
      installation: { status: "ACTIVE" },
      binding: { status: "ACTIVE" },
    });
  });
});
