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
  /**
   * Controls the REVENUE-class applicability flag Xero reports on the
   * "OUTPUT" tax rate used by `quoteInput`'s single line. Defaults to `true`
   * (today's normal, unambiguous case). "OMIT" leaves the field off the
   * stubbed TaxRateSummary entirely, reproducing Xero's genuinely optional
   * `CanApplyToRevenue` -- the exact shape SR-04 is about.
   */
  taxRateCanApplyToRevenue?: boolean | "OMIT";
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
    writeEnabled: options.writeEnabled ?? true,
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
      ...(options.taxRateCanApplyToRevenue === "OMIT"
        ? {}
        : { canApplyToRevenue: options.taxRateCanApplyToRevenue ?? true }),
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
  it("does not make current Case execution depend on historical authority snapshot rows", async () => {
    const current = harness();
    await current.repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 1,
      writeKillSwitchEnabled: false,
      standingDelegations: [],
      publishedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    const prepared = await current.service.prepareQuoteDraft(current.context, {
      ...quoteInput,
      source_ref: "work-material:current-write-gate",
      source_unit_key: "document:current-write-gate",
    });
    await expect(current.service.createQuoteDraft(current.context, {
      preparation_id: prepared.preparation_id,
      request_id: "current-write-gate",
    })).resolves.toMatchObject({ state: "DRAFT_READBACK_VERIFIED" });
    expect(current.createQuoteDraft).toHaveBeenCalledOnce();
  });

  it("uses XERO_WRITE_ENABLED as the current process gate", async () => {
    const disabled = harness({ writeEnabled: false });
    await expect(disabled.mutations.preflightAutonomousActions(
      disabled.context,
      ["quote.create_draft"],
    )).rejects.toMatchObject({ code: "WRITE_GATE_DISABLED" });
    expect(disabled.createQuoteDraft).not.toHaveBeenCalled();
  });

  it("keeps the claim bound to the sealed Case even if legacy snapshot storage changes", async () => {
    const race = harness();
    const prepared = await race.service.prepareQuoteDraft(race.context, {
      ...quoteInput,
      source_ref: "work-material:sealed-case-claim",
      source_unit_key: "document:sealed-case-claim",
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
      request_id: "sealed-case-claim",
    })).resolves.toMatchObject({ state: "DRAFT_READBACK_VERIFIED" });
    expect(race.createQuoteDraft).toHaveBeenCalledOnce();
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

describe("XeroControlledMutationService tax-applicability fail-closed handling (SR-04)", () => {
  // xeroTaxRateResolver.ts and xeroDeclaredLedgerBinding.ts both treat a
  // missing CanApplyTo* flag as "not applicable" (=== true), never as
  // implicit permission. This pins xeroControlledMutationService.ts's own
  // #validateDocumentReferences -> exactActiveTax -> taxApplies chain to the
  // identical answer, since it gates real Quote/PurchaseOrder draft writes.
  it("rejects a line whose tax rate omits the account-class applicability flag, matching the policy files", async () => {
    const omitted = harness({ taxRateCanApplyToRevenue: "OMIT" });
    await expect(omitted.service.prepareQuoteDraft(omitted.context, {
      ...quoteInput,
      source_ref: "work-material:quote-tax-flag-omitted",
      source_unit_key: "document:quote-tax-flag-omitted",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { path: "lines[0].tax_type" },
    });
  });

  it("still rejects a line whose tax rate explicitly disallows the account class", async () => {
    const disallowed = harness({ taxRateCanApplyToRevenue: false });
    await expect(disallowed.service.prepareQuoteDraft(disallowed.context, {
      ...quoteInput,
      source_ref: "work-material:quote-tax-flag-false",
      source_unit_key: "document:quote-tax-flag-false",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { path: "lines[0].tax_type" },
    });
  });

  it("still accepts a line whose tax rate explicitly allows the account class", async () => {
    const allowed = harness({ taxRateCanApplyToRevenue: true });
    await expect(allowed.service.prepareQuoteDraft(allowed.context, {
      ...quoteInput,
      source_ref: "work-material:quote-tax-flag-true",
      source_unit_key: "document:quote-tax-flag-true",
    })).resolves.toMatchObject({ state: "PREPARED" });
  });
});
