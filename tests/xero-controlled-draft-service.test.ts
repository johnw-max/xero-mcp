import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { AccountingProvider } from "../src/providers/types.js";
import type { XeroControlledMutationProvider } from "../src/providers/xeroControlledMutationProvider.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
  type RequestContext,
} from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { XeroControlledMutationService } from "../src/services/xeroControlledMutationService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";
import { AppError } from "../src/errors.js";
import { XERO_AUTONOMOUS_WRITE_ACTIONS } from "../src/policy/xeroAutonomousActions.js";
import {
  MutableTestLedgerAuthoritySnapshotResolver,
  RepositoryLedgerAuthoritySnapshotResolver,
  type LedgerAuthoritySnapshotResolver,
} from "../src/domain/ledgerAuthority.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const quoteId = "33333333-3333-4333-8333-333333333333";

const quoteInput = {
  source_ref: "work-material:quote-001",
  source_unit_key: "document:quote-001",
  contact_id: contactId,
  quote_date: "2026-08-07",
  expiry_date: "2026-08-31",
  currency: "SGD",
  reference: "CLIENT-QUOTE-001",
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Accounting advisory",
    quantity: 2,
    unit_amount: 125.5,
    account_code: "200",
    tax_type: "OUTPUT",
  }],
};

function harness(options: {
  writeEnabled?: boolean;
  mismatch?: boolean;
  providerFailure?: "DEFINITELY_REJECTED" | "UNKNOWN";
  evidencePersistenceFailure?: boolean;
  statusTenantId?: string;
  contactBecomesInactive?: boolean;
  internalProjectionMismatch?: boolean;
  oauthBound?: boolean;
  targetBound?: boolean;
  omitAllowedTenantId?: boolean;
  authorityResolverFactory?: (repository: InMemoryAccountingRepository) => LedgerAuthoritySnapshotResolver;
} = {}) {
  const repository = new InMemoryAccountingRepository();
  const executionEvents: string[] = [];
  const persistWriteEvidence = repository.recordXeroMutationWriteEvidence.bind(repository);
  vi.spyOn(repository, "recordXeroMutationWriteEvidence").mockImplementation(async (input) => {
    executionEvents.push("WRITE_EVIDENCE_PERSISTED");
    if (options.evidencePersistenceFailure) {
      throw new AppError("CONFIGURATION_ERROR", "Injected persistence failure.", { httpStatus: 500 });
    }
    return persistWriteEvidence(input);
  });
  const legacy = createLegacySharedBearerRequestContext({
    actorId: "workspace-test:user:user-test",
    audience: "https://mcp.example.test/mcp",
  });
  const oauthBound = options.oauthBound !== false;
  const targetBound = options.targetBound !== false;
  const context: RequestContext = oauthBound
    ? Object.freeze({
        ...createOAuthRequestContext({
          issuer: "https://mcp.example.test",
          resolvedToken: {
          tokenId: "token-test",
          clientId: "agent2-accounting-mcp",
          resource: "https://mcp.example.test/mcp",
          audience: "https://mcp.example.test/mcp",
          grantedScopes: ["xero.read", "xero.draft.write"],
          issuedAt: new Date("2026-08-07T00:00:00.000Z"),
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          installationId: "installation-test",
          bindingId: "binding-test",
          connectionId: "connection-test",
          bindingRevision: 1,
          authorizationId: "authorization-test",
          workspaceId: "workspace-test",
          subjectType: "USER",
          subjectId: "user-test",
          agentId: "agent-test",
          policyId: "policy-test",
          tenantId,
          } satisfies ResolvedMcpAccessToken,
        }),
        ...(targetBound ? {
          targetSessionId: "target-session-test",
          targetSessionHash: "c".repeat(64),
          targetSessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        } : {}),
      })
    : {
        ...legacy,
        connectionId: "connection-test",
        scopes: Object.freeze(["xero.read", "xero.draft.write"]),
      };
  if (oauthBound) {
    const resolvedBinding = {
      installationId: "installation-test",
      bindingId: "binding-test",
      workspaceId: "workspace-test",
      subjectType: "USER",
      subjectId: "user-test",
      agentId: "agent-test",
      connectionId: "connection-test",
      bindingRevision: 1,
      authorizationId: "authorization-test",
      tenantId,
      tenantName: "Demo Org",
      policyId: "policy-test",
    };
    vi.spyOn(repository, "resolveAgentConnectionBinding").mockResolvedValue(resolvedBinding);
    if (targetBound) {
      vi.spyOn(repository, "resolveLedgerTargetSession").mockResolvedValue({
        session: {
          sessionId: "target-session-test",
          sessionHash: "c".repeat(64),
          installationId: "installation-test",
          bindingId: "binding-test",
          connectionId: "connection-test",
          bindingRevision: 1,
          createdAt: new Date("2026-08-12T00:00:00.000Z"),
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        },
        binding: resolvedBinding,
      });
    }
  }
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "test-confirmation-secret-that-is-at-least-32-bytes",
    ...(options.authorityResolverFactory
      ? { authoritySnapshotResolver: options.authorityResolverFactory(repository) }
      : {}),
    writeKillSwitchEnabled: options.writeEnabled ?? true,
    standingDelegations: [{
      delegationId: "test-xero-standing-delegation",
      revision: 1,
      status: "ACTIVE",
      providerId: "xero",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      tenantIds: [tenantId],
      actionIds: XERO_AUTONOMOUS_WRITE_ACTIONS,
    }],
    providerCapabilityEvaluator: {
      evaluate: async () => ({ allowed: true, denyReasons: [], receiptHash: "e".repeat(64) }),
    },
    unsafeAllowLegacyContextForTests: true,
    legacyBindingForTests: {
      actorId: context.actorId,
      workspaceId: "workspace-test",
      tenantId,
      installationId: "installation-test",
      bindingId: "binding-test",
      connectionId: "connection-test",
    },
  });
  let contactReads = 0;
  const readProvider = {
    connectionStatus: vi.fn(async () => ({
      connected: true,
      tenant: { id: options.statusTenantId ?? tenantId, name: "Demo Org" },
      scopes: ["accounting.invoices", "accounting.settings.read", "accounting.contacts.read"],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId, tenantName: "Demo Org" })),
    getContact: vi.fn(async () => {
      contactReads += 1;
      return {
        contactId,
        name: "Demo Customer",
        status: options.contactBecomesInactive && contactReads > 1 ? "ARCHIVED" : "ACTIVE",
      };
    }),
    listAccounts: vi.fn(async () => [{
      accountId: "44444444-4444-4444-8444-444444444444",
      code: "200",
      name: "Sales",
      status: "ACTIVE",
      type: "REVENUE",
      class: "REVENUE",
    }]),
    listTaxRates: vi.fn(async () => [{
      name: "Output tax",
      taxType: "OUTPUT",
      status: "ACTIVE",
      canApplyToRevenue: true,
    }]),
  } as unknown as AccountingProvider;
  const createQuoteDraft = vi.fn(async (_context, payload) => {
    if (options.providerFailure === "DEFINITELY_REJECTED") {
      throw new AppError("PROVIDER_ERROR", "Xero rejected the quote draft.", {
        httpStatus: 422,
        retryable: false,
        details: { writeOutcome: "DEFINITELY_REJECTED", validationErrorCount: 1 },
      });
    }
    if (options.providerFailure === "UNKNOWN") {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero result is unknown.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    executionEvents.push("PROVIDER_WRITE_RETURNED");
    return {
      objectId: quoteId,
      receipt: { operation: "CREATE_QUOTE_DRAFT", quoteId, providerRequestId: "provider-001" },
      payload,
    };
  });
  const writeProvider = {
    getItemByCode: vi.fn(async () => undefined),
    resolveTrackingOptionIds: vi.fn(async (_context, ids: readonly string[]) => ({
      requestedIds: [...ids],
      matchedIds: [...ids],
      complete: true,
    })),
    createQuoteDraft,
    readAndVerifyQuoteDraft: vi.fn(async (_context, objectId, expected) => {
      executionEvents.push("EXACT_READBACK_STARTED");
      const canonical = options.mismatch || options.internalProjectionMismatch
        ? { ...expected, reference: "WRONG" }
        : expected;
      const snapshot = {
        objectType: "QUOTE" as const,
        quoteId: objectId,
        canonicalPayload: canonical,
        providerTotalsVerified: true as const,
        providerTotalsEvidence: {
          subTotal: "251.0000",
          totalTax: "0.0000",
          total: "251.0000",
          arithmeticVerified: true as const,
          lineBasisVerified: true as const,
        },
        providerLineAmountEvidence: {
          verificationRole: "NON_CANONICAL_EVIDENCE" as const,
          values: ["251.0000"],
          observedCount: 1,
          missingCount: 0,
          amountsMatchEntered: true as const,
        },
      };
      if (options.internalProjectionMismatch) {
        return {
          ok: true as const,
          snapshot,
          readbackCanonicalPayload: expected,
          readbackCanonicalPayloadHash: hashObject(expected),
        };
      }
      return options.mismatch
        ? { ok: false as const, reasons: ["CANONICAL_PAYLOAD_MISMATCH" as const], snapshot, readbackCanonicalPayload: canonical }
        : { ok: true as const, snapshot, readbackCanonicalPayload: canonical, readbackCanonicalPayloadHash: hashObject(canonical) };
    }),
  } as unknown as XeroControlledMutationProvider;
  const service = new XeroControlledMutationService(
    readProvider,
    writeProvider,
    mutations,
    {
      xeroWriteEnabled: options.writeEnabled ?? true,
      ...(options.omitAllowedTenantId ? {} : { xeroAllowedTenantId: tenantId }),
    },
  );
  return { context, repository, service, mutations, createQuoteDraft, executionEvents };
}

describe("XeroControlledMutationService quote/PO execution", () => {
  it("binds receipts to rev1 and an old service observes a durable rev2 revocation without restart", async () => {
    const old = harness({
      authorityResolverFactory: (repository) => new RepositoryLedgerAuthoritySnapshotResolver(repository),
    });
    await old.repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: [{
        delegationId: "dynamic-authority-delegation",
        revision: 1,
        status: "ACTIVE",
        providerId: "xero",
        workspaceId: "workspace-test",
        agentId: "agent-test",
        installationId: "installation-test",
        tenantIds: [tenantId],
        actionIds: XERO_AUTONOMOUS_WRITE_ACTIONS,
      }],
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    const active = await old.service.prepareQuoteDraft(old.context, {
      ...quoteInput,
      source_ref: "work-material:authority-active",
      source_unit_key: "document:authority-active",
    });
    await old.service.createQuoteDraft(old.context, {
      preparation_id: active.preparation_id,
      request_id: "authority-active",
    });
    const activeRequest = await old.repository.getXeroMutationRequest(
      `xmr_${hashObject({ preparationId: active.preparation_id }).slice(0, 32)}`,
    );
    expect(activeRequest?.authorizationReceipt).toMatchObject({
      authoritySnapshotRevision: 1,
      authoritySnapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    await old.repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 2,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T00:01:00.000Z"),
    });
    await expect(old.mutations.preflightAutonomousActions(
      old.context,
      ["quote.create_draft"],
    )).rejects.toMatchObject({ code: "WRITE_GATE_DISABLED" });
    const revoked = await old.service.prepareQuoteDraft(old.context, {
      ...quoteInput,
      source_ref: "work-material:authority-revoked",
      source_unit_key: "document:authority-revoked",
    });
    await expect(old.service.createQuoteDraft(old.context, {
      preparation_id: revoked.preparation_id,
      request_id: "authority-revoked",
    })).rejects.toMatchObject({ code: "WRITE_GATE_DISABLED" });
    expect(old.createQuoteDraft).toHaveBeenCalledTimes(1);
  });

  it("fails a resolve-to-claim race before permit issuance or Provider I/O", async () => {
    const mutable = new MutableTestLedgerAuthoritySnapshotResolver({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: [{
        delegationId: "racing-authority-delegation",
        revision: 1,
        status: "ACTIVE",
        providerId: "xero",
        workspaceId: "workspace-test",
        agentId: "agent-test",
        installationId: "installation-test",
        tenantIds: [tenantId],
        actionIds: XERO_AUTONOMOUS_WRITE_ACTIONS,
      }],
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    let resolves = 0;
    const racingResolver: LedgerAuthoritySnapshotResolver = {
      claimConsistency: "TEST_RESOLVER_GUARDED",
      resolveCurrent: async () => {
        resolves += 1;
        if (resolves === 2) {
          mutable.publish({
            providerId: "xero",
            revision: 2,
            writeKillSwitchEnabled: false,
            standingDelegations: [],
            publishedAt: new Date("2026-08-13T00:00:01.000Z"),
          });
        }
        return mutable.resolveCurrent();
      },
    };
    const race = harness({ authorityResolverFactory: () => racingResolver });
    const prepared = await race.service.prepareQuoteDraft(race.context, {
      ...quoteInput,
      source_ref: "work-material:authority-race",
      source_unit_key: "document:authority-race",
    });
    await expect(race.service.createQuoteDraft(race.context, {
      preparation_id: prepared.preparation_id,
      request_id: "authority-race",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(race.createQuoteDraft).not.toHaveBeenCalled();
    await expect(race.repository.getXeroMutationRequest(
      `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`,
    )).resolves.toBeUndefined();
  });

  it("rechecks the expected durable snapshot inside the repository claim", async () => {
    const race = harness({
      authorityResolverFactory: (repository) => new RepositoryLedgerAuthoritySnapshotResolver(repository),
    });
    const activeGrant = {
      delegationId: "repository-cas-delegation",
      revision: 1,
      status: "ACTIVE" as const,
      providerId: "xero",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      tenantIds: [tenantId],
      actionIds: XERO_AUTONOMOUS_WRITE_ACTIONS,
    };
    await race.repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: true,
      standingDelegations: [activeGrant],
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    const prepared = await race.service.prepareQuoteDraft(race.context, {
      ...quoteInput,
      source_ref: "work-material:authority-repository-cas",
      source_unit_key: "document:authority-repository-cas",
    });
    const confirm = race.repository.confirmXeroMutationPreparation.bind(race.repository);
    vi.spyOn(race.repository, "confirmXeroMutationPreparation").mockImplementationOnce(async (input) => {
      await race.repository.publishLedgerAuthoritySnapshot({
        providerId: "xero",
        revision: 2,
        writeKillSwitchEnabled: false,
        standingDelegations: [],
        publishedAt: new Date("2026-08-13T00:00:01.000Z"),
      });
      return confirm(input);
    });
    await expect(race.service.createQuoteDraft(race.context, {
      preparation_id: prepared.preparation_id,
      request_id: "authority-repository-cas",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(race.createQuoteDraft).not.toHaveBeenCalled();
  });

  it("uses the exact OAuth Broker binding when the legacy tenant allowlist is intentionally empty", async () => {
    const broker = harness({ oauthBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareQuoteDraft(broker.context, {
      ...quoteInput,
      source_ref: "work-material:quote-broker-empty-allowlist",
      source_unit_key: "document:quote-broker-empty-allowlist",
    });
    await expect(broker.service.createQuoteDraft(broker.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-broker-empty-allowlist",
    })).resolves.toMatchObject({ state: "DRAFT_READBACK_VERIFIED", xero_object_id: quoteId });
    expect(broker.createQuoteDraft).toHaveBeenCalledTimes(1);
  });

  it("uses a pinned ledger target for controlled writes instead of the installation's mutable active pointer", async () => {
    const broker = harness({ oauthBound: true, targetBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareQuoteDraft(broker.context, {
      ...quoteInput,
      source_ref: "work-material:quote-pinned-target",
      source_unit_key: "document:quote-pinned-target",
    });
    await expect(broker.service.createQuoteDraft(broker.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-pinned-target",
    })).resolves.toMatchObject({ state: "DRAFT_READBACK_VERIFIED", xero_object_id: quoteId });
    expect(broker.repository.resolveLedgerTargetSession).toHaveBeenCalled();
    expect(broker.createQuoteDraft).toHaveBeenCalledTimes(1);
  });

  it("invalidates a prepared mutation when the conversation re-pins to a different target session", async () => {
    const broker = harness({ oauthBound: true, targetBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareQuoteDraft(broker.context, {
      ...quoteInput,
      source_ref: "work-material:quote-old-target",
      source_unit_key: "document:quote-old-target",
    });
    const repinnedContext = Object.freeze({
      ...broker.context,
      targetSessionId: "target-session-repinned",
      targetSessionHash: "d".repeat(64),
    });
    vi.mocked(broker.repository.resolveLedgerTargetSession).mockResolvedValue({
      session: {
        sessionId: "target-session-repinned",
        sessionHash: "d".repeat(64),
        installationId: "installation-test",
        bindingId: "binding-test",
        connectionId: "connection-test",
        bindingRevision: 1,
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      binding: {
        installationId: "installation-test",
        bindingId: "binding-test",
        workspaceId: "workspace-test",
        subjectType: "USER",
        subjectId: "user-test",
        agentId: "agent-test",
        connectionId: "connection-test",
        bindingRevision: 1,
        authorizationId: "authorization-test",
        tenantId,
        tenantName: "Demo Org",
        policyId: "policy-test",
      },
    });

    await expect(broker.service.createQuoteDraft(repinnedContext, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-old-target",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(broker.createQuoteDraft).not.toHaveBeenCalled();
  });

  it("blocks an already-authorised mutation request after the conversation re-pins", async () => {
    const broker = harness({ oauthBound: true, targetBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareQuoteDraft(broker.context, {
      ...quoteInput,
      source_ref: "work-material:quote-confirmed-old-target",
      source_unit_key: "document:quote-confirmed-old-target",
    });
    const confirmed = await broker.service.createQuoteDraft(broker.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-confirmed-old-target",
    });
    const repinnedContext = Object.freeze({
      ...broker.context,
      targetSessionId: "target-session-after-confirmation",
      targetSessionHash: "e".repeat(64),
    });
    vi.mocked(broker.repository.resolveLedgerTargetSession).mockResolvedValue({
      session: {
        sessionId: "target-session-after-confirmation",
        sessionHash: "e".repeat(64),
        installationId: "installation-test",
        bindingId: "binding-test",
        connectionId: "connection-test",
        bindingRevision: 1,
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      binding: {
        installationId: "installation-test",
        bindingId: "binding-test",
        workspaceId: "workspace-test",
        subjectType: "USER",
        subjectId: "user-test",
        agentId: "agent-test",
        connectionId: "connection-test",
        bindingRevision: 1,
        authorizationId: "authorization-test",
        tenantId,
        tenantName: "Demo Org",
        policyId: "policy-test",
      },
    });

    await expect(broker.mutations.start(repinnedContext, {
      mutationRequestId: confirmed.mutation_request_id,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(broker.createQuoteDraft).toHaveBeenCalledOnce();
  });

  it("prepares an immutable source-bound proposal and autonomously creates one readback-verified DRAFT", async () => {
    const { context, service, createQuoteDraft, executionEvents } = harness();
    const prepared = await service.prepareQuoteDraft(context, quoteInput);
    expect(prepared).toMatchObject({
      state: "PREPARED",
      object_type: "QUOTE",
      operation: "CREATE_DRAFT",
      execution_mode: "STANDING_AUTONOMOUS_DELEGATION",
      per_transaction_confirmation_required: false,
      next_action: "CALL_EXECUTE_TOOL",
      source: { original_file_verified: false },
      proposal: { status: "DRAFT", objectType: "QUOTE" },
    });
    const confirmed = {
      preparation_id: prepared.preparation_id,
      request_id: "quote-controlled-001",
    };
    await expect(service.createQuoteDraft(context, confirmed)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      object_type: "QUOTE",
      xero_object_id: quoteId,
      status: "DRAFT",
    });
    await expect(service.createQuoteDraft(context, confirmed)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      xero_object_id: quoteId,
    });
    expect(createQuoteDraft).toHaveBeenCalledTimes(1);
    expect(executionEvents).toEqual([
      "PROVIDER_WRITE_RETURNED",
      "WRITE_EVIDENCE_PERSISTED",
      "EXACT_READBACK_STARTED",
    ]);
  });

  it("rejects the removed confirmation-phrase field and a closed write gate without calling Xero", async () => {
    const wrong = harness();
    const prepared = await wrong.service.prepareQuoteDraft(wrong.context, quoteInput);
    await expect(wrong.service.createQuoteDraft(wrong.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-controlled-002",
      confirmation_phrase: "legacy-model-copied-phrase",
    } as never)).rejects.toBeDefined();
    expect(wrong.createQuoteDraft).not.toHaveBeenCalled();

    const closed = harness({ writeEnabled: false });
    const closedPrepared = await closed.service.prepareQuoteDraft(closed.context, {
      ...quoteInput,
      source_ref: "work-material:quote-closed",
    });
    await expect(closed.service.createQuoteDraft(closed.context, {
      preparation_id: closedPrepared.preparation_id,
      request_id: "quote-controlled-closed",
    })).rejects.toMatchObject({ code: "WRITE_GATE_DISABLED" });
    expect(closed.createQuoteDraft).not.toHaveBeenCalled();

    const legacyWithoutAllowlist = harness({ oauthBound: false, omitAllowedTenantId: true });
    const legacyPrepared = await legacyWithoutAllowlist.service.prepareQuoteDraft(
      legacyWithoutAllowlist.context,
      {
        ...quoteInput,
        source_ref: "work-material:quote-legacy-no-allowlist",
        source_unit_key: "document:quote-legacy-no-allowlist",
      },
    );
    await expect(legacyWithoutAllowlist.service.createQuoteDraft(legacyWithoutAllowlist.context, {
      preparation_id: legacyPrepared.preparation_id,
      request_id: "quote-legacy-no-allowlist",
    })).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
      details: { denyReasons: expect.arrayContaining(["WRITE_TENANT_NOT_ALLOWED"]) },
    });
    expect(legacyWithoutAllowlist.createQuoteDraft).not.toHaveBeenCalled();
  });

  it("rejects a connection-status tenant that differs from the exact OAuth binding", async () => {
    const mismatch = harness({ statusTenantId: "99999999-9999-4999-8999-999999999999" });
    const prepared = await mismatch.service.prepareQuoteDraft(mismatch.context, {
      ...quoteInput,
      source_ref: "work-material:quote-tenant-mismatch",
      source_unit_key: "document:quote-tenant-mismatch",
    });
    await expect(mismatch.service.createQuoteDraft(mismatch.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-tenant-mismatch",
    })).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
      details: { denyReasons: expect.arrayContaining(["TENANT_BINDING_MISMATCH"]) },
    });
    expect(mismatch.createQuoteDraft).not.toHaveBeenCalled();
  });

  it("revalidates persisted accounting references immediately before POST", async () => {
    const changed = harness({ contactBecomesInactive: true });
    const prepared = await changed.service.prepareQuoteDraft(changed.context, {
      ...quoteInput,
      source_ref: "work-material:quote-stale-contact",
      source_unit_key: "document:quote-stale-contact",
    });
    await expect(changed.service.createQuoteDraft(changed.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-stale-contact",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(changed.createQuoteDraft).not.toHaveBeenCalled();
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(changed.repository.getXeroMutationRequest(mutationId)).resolves.toBeUndefined();
  });

  it("persists a canonical mismatch and never reports it as verified", async () => {
    const { context, repository, service } = harness({ mismatch: true });
    const prepared = await service.prepareQuoteDraft(context, {
      ...quoteInput,
      source_ref: "work-material:quote-mismatch",
    });
    await expect(service.createQuoteDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-controlled-mismatch",
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(repository.getXeroMutationRequest(mutationId)).resolves.toMatchObject({
      state: "READBACK_MISMATCH",
      xeroObjectId: quoteId,
    });
  });

  it("persists an internally inconsistent provider projection as a mismatch", async () => {
    const inconsistent = harness({ internalProjectionMismatch: true });
    const prepared = await inconsistent.service.prepareQuoteDraft(inconsistent.context, {
      ...quoteInput,
      source_ref: "work-material:quote-internal-projection-mismatch",
      source_unit_key: "document:quote-internal-projection-mismatch",
    });
    await expect(inconsistent.service.createQuoteDraft(inconsistent.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-internal-projection-mismatch",
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    const persisted = await inconsistent.repository.getXeroMutationRequest(mutationId);
    expect(persisted).toMatchObject({ state: "READBACK_MISMATCH", xeroObjectId: quoteId });
    expect(persisted?.readbackSnapshot).toMatchObject({
      evidence: { providerProjectionConsistency: "MISMATCH" },
    });
  });

  it("records definite provider 4xx rejection separately from an uncertain transport outcome", async () => {
    const rejected = harness({ providerFailure: "DEFINITELY_REJECTED" });
    const rejectedPreparation = await rejected.service.prepareQuoteDraft(rejected.context, {
      ...quoteInput,
      source_ref: "work-material:quote-provider-rejected",
    });
    await expect(rejected.service.createQuoteDraft(rejected.context, {
      preparation_id: rejectedPreparation.preparation_id,
      request_id: "quote-provider-rejected",
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    const rejectedMutationId = `xmr_${hashObject({ preparationId: rejectedPreparation.preparation_id }).slice(0, 32)}`;
    await expect(rejected.repository.getXeroMutationRequest(rejectedMutationId)).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: { writeOutcome: "DEFINITELY_REJECTED", httpStatus: 422 },
    });

    const unknown = harness({ providerFailure: "UNKNOWN" });
    const unknownPreparation = await unknown.service.prepareQuoteDraft(unknown.context, {
      ...quoteInput,
      source_ref: "work-material:quote-provider-unknown",
    });
    await expect(unknown.service.createQuoteDraft(unknown.context, {
      preparation_id: unknownPreparation.preparation_id,
      request_id: "quote-provider-unknown",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    const unknownMutationId = `xmr_${hashObject({ preparationId: unknownPreparation.preparation_id }).slice(0, 32)}`;
    await expect(unknown.repository.getXeroMutationRequest(unknownMutationId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
    });
  });

  it("retains the exact Xero ID and receipt when the first evidence persistence attempt fails", async () => {
    const failed = harness({ evidencePersistenceFailure: true });
    const prepared = await failed.service.prepareQuoteDraft(failed.context, {
      ...quoteInput,
      source_ref: "work-material:quote-evidence-persistence-failure",
    });
    await expect(failed.service.createQuoteDraft(failed.context, {
      preparation_id: prepared.preparation_id,
      request_id: "quote-evidence-persistence-failure",
    })).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: { xeroObjectId: quoteId },
    });
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(failed.repository.getXeroMutationRequest(mutationId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
      xeroObjectId: quoteId,
      writeReceipt: { quoteId, providerRequestId: "provider-001" },
    });
    expect(failed.executionEvents).toEqual([
      "PROVIDER_WRITE_RETURNED",
      "WRITE_EVIDENCE_PERSISTED",
    ]);
  });
});
