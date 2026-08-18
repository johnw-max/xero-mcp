import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { AccountingProvider } from "../src/providers/types.js";
import type { CreditNoteManualJournalWriteProvider } from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
  type RequestContext,
} from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { XeroCreditNoteManualJournalService } from "../src/services/xeroCreditNoteManualJournalService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";
import { AppError } from "../src/errors.js";
import { XERO_AUTONOMOUS_WRITE_ACTIONS } from "../src/policy/xeroAutonomousActions.js";
import {
  bindXeroDeclaredLedger,
  createXeroDeclaredLedgerExecutionConstraints,
  type XeroDeclaredLedgerBinding,
} from "../src/policy/xeroDeclaredLedgerBinding.js";
import type { AccountSummary, TaxRateSummary } from "../src/providers/types.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const revenueAccountId = "33333333-3333-4333-8333-333333333333";
const expenseAccountId = "44444444-4444-4444-8444-444444444444";
const creditNoteId = "55555555-5555-4555-8555-555555555555";
const manualJournalId = "66666666-6666-4666-8666-666666666666";

// ADR-002: server-owned execution constraints now bind the caller-declared
// account code + TaxType against the tenant's live chart of accounts, not a
// semantic category profile.
function testLedgerBinding(forTenantId: string): XeroDeclaredLedgerBinding {
  const accounts: readonly AccountSummary[] = [
    { accountId: revenueAccountId, code: "200", name: "Sales", status: "ACTIVE", type: "REVENUE", class: "REVENUE" },
    { accountId: expenseAccountId, code: "400", name: "Operating expense", status: "ACTIVE", type: "EXPENSE", class: "EXPENSE" },
  ];
  const taxRates: readonly TaxRateSummary[] = [
    { taxType: "OUTPUTY24", name: "GST on Income", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true },
  ];
  return bindXeroDeclaredLedger({
    tenantId: forTenantId,
    jurisdiction: "SG",
    accountCodes: accounts.map((account) => account.code!),
    taxTypes: taxRates.map((taxRate) => taxRate.taxType),
    accounts,
    taxRates,
  });
}

const creditNoteInput = {
  source_ref: "work-material:credit-note-001",
  source_unit_key: "credit-note:001",
  reason: "Customer service credit",
  credit_note_type: "ACCRECCREDIT" as const,
  contact_id: contactId,
  credit_note_date: "2026-08-07",
  currency: "SGD",
  reference: "CN-SOURCE-001",
  authoritative_provider_field: "CREDIT_NOTE_NUMBER" as const,
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Service credit",
    quantity: 1,
    unit_amount: 125.5,
    account_id: revenueAccountId,
    account_code: "200",
    tax_type: "OUTPUTY24",
  }],
};

const manualJournalInput = {
  source_ref: "work-material:manual-journal-001",
  source_unit_key: "manual-journal:001",
  journal_date: "2026-08-07",
  narration: "Monthly accrual",
  lines: [
    {
      account_id: expenseAccountId,
      account_code: "400",
      description: "Accrued expense",
      line_amount: 500,
    },
    {
      account_id: revenueAccountId,
      account_code: "200",
      description: "Accrual offset",
      line_amount: -500,
    },
  ],
};

function harness(options: {
  writeEnabled?: boolean;
  missingContact?: boolean;
  missingTax?: boolean;
  protectExpenseAccount?: boolean;
  trackingIncomplete?: boolean;
  invalidItemSide?: boolean;
  providerFailure?: "DEFINITELY_REJECTED" | "UNKNOWN";
  manualReadbackMismatch?: boolean;
  evidencePersistenceFailure?: "FIRST_ONLY" | "BOTH";
  contactBecomesInactive?: boolean;
  oauthBound?: boolean;
  omitAllowedTenantId?: boolean;
} = {}) {
  const repository = new InMemoryAccountingRepository();
  const legacy = createLegacySharedBearerRequestContext({
    actorId: "workspace-test:user:user-test",
    audience: "https://mcp.example.test/mcp",
  });
  const oauthBound = options.oauthBound !== false;
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
        targetSessionId: "target-session-test",
        targetSessionHash: "c".repeat(64),
        targetSessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
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
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "test-confirmation-secret-that-is-at-least-32-bytes",
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
  if (options.evidencePersistenceFailure) {
    vi.spyOn(mutations, "recordWriteEvidence").mockRejectedValue(
      new AppError("CONFIGURATION_ERROR", "Injected write-evidence persistence failure.", { httpStatus: 500 }),
    );
    if (options.evidencePersistenceFailure === "BOTH") {
      vi.spyOn(mutations, "markUnknown").mockRejectedValue(
        new AppError("CONFIGURATION_ERROR", "Injected fallback persistence failure.", { httpStatus: 500 }),
      );
    }
  }
  let contactReads = 0;
  const liveAccounts = () => [
    {
      accountId: revenueAccountId,
      code: "200",
      name: "Sales",
      status: "ACTIVE",
      type: "REVENUE",
      class: "REVENUE",
    },
    {
      accountId: expenseAccountId,
      code: "400",
      name: "Operating expense",
      status: "ACTIVE",
      type: "EXPENSE",
      class: "EXPENSE",
      ...(options.protectExpenseAccount ? { systemAccount: "CREDITORS" } : {}),
    },
  ];
  const listAccounts = vi.fn(async () => liveAccounts());
  const readProvider = {
    connectionStatus: vi.fn(async () => ({
      connected: true,
      tenant: { id: tenantId, name: "Demo Org" },
      scopes: [
        "accounting.invoices",
        "accounting.manualjournals",
        "accounting.settings.read",
        "accounting.contacts.read",
      ],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId, tenantName: "Demo Org" })),
    getContact: vi.fn(async () => {
      contactReads += 1;
      if (options.missingContact) return undefined;
      return {
        contactId,
        name: "Demo Customer",
        status: options.contactBecomesInactive && contactReads > 1 ? "ARCHIVED" : "ACTIVE",
      };
    }),
    listAccounts,
    listTaxRates: vi.fn(async () => options.missingTax ? [] : [{
      name: "Output tax",
      taxType: "OUTPUTY24",
      status: "ACTIVE",
      displayTaxRate: "9.0000",
      effectiveRate: "9.0000",
      canApplyToRevenue: true,
      canApplyToAssets: true,
    }]),
  } as unknown as AccountingProvider;

  let creditMutationId: string | undefined;
  let creditWriteEvidenceAtRead: Record<string, unknown> | undefined;
  const createCreditNoteDraft = vi.fn(async (_context, payload, idempotencyKey: string) => {
    creditMutationId = idempotencyKey;
    if (options.providerFailure === "DEFINITELY_REJECTED") {
      throw new AppError("PROVIDER_ERROR", "Xero rejected the credit note.", {
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
    return {
      objectId: creditNoteId,
      receipt: { operation: "CREATE_CREDIT_NOTE_DRAFT", creditNoteId },
      payload,
    };
  });
  const createManualJournalDraft = vi.fn(async (_context, payload) => ({
    objectId: manualJournalId,
    receipt: { operation: "CREATE_MANUAL_JOURNAL_DRAFT", manualJournalId },
    payload,
  }));
  const writeProvider = {
    getItemByCode: vi.fn(async (_context, code: string) => options.invalidItemSide
      ? { itemId: "77777777-7777-4777-8777-777777777777", code, isSold: false, isPurchased: true }
      : undefined),
    resolveTrackingOptionIds: vi.fn(async (_context, ids: readonly string[]) => ({
      requestedIds: [...ids],
      matchedIds: [...ids],
      complete: !options.trackingIncomplete,
    })),
    createCreditNoteDraft,
    readAndVerifyCreditNoteDraft: vi.fn(async (_context, objectId, expected) => {
      if (creditMutationId) {
        const persisted = await repository.getXeroMutationRequest(creditMutationId);
        creditWriteEvidenceAtRead = persisted ? {
          state: persisted.state,
          xeroObjectId: persisted.xeroObjectId,
          writeReceipt: persisted.writeReceipt,
        } : undefined;
      }
      return {
        ok: true as const,
        snapshot: {
        objectType: "CREDIT_NOTE" as const,
        creditNoteId: objectId,
        canonicalPayload: expected,
        providerEconomicsEvidence: {
          lineAmounts: ["125.5000"],
          taxAmounts: ["0.0000"],
          subTotal: "125.5000",
          totalTax: "0.0000",
          total: "125.5000",
          noDiscountsVerified: true as const,
        },
        },
        readbackCanonicalPayload: expected,
        readbackCanonicalPayloadHash: hashObject(expected),
      };
    }),
    createManualJournalDraft,
    readAndVerifyManualJournalDraft: vi.fn(async (_context, objectId, expected) => {
      const canonical = options.manualReadbackMismatch
        ? { ...expected, narration: "Mismatched narration" }
        : expected;
      const snapshot = {
        objectType: "MANUAL_JOURNAL" as const,
        manualJournalId: objectId,
        canonicalPayload: canonical,
        providerTaxEvidence: { taxTypes: ["NONE", "NONE"], taxAmounts: ["0.0000", "0.0000"], allNoneAndZero: true },
        balanceVerified: true as const,
      };
      return options.manualReadbackMismatch
        ? {
            ok: false as const,
            reasons: ["CANONICAL_PAYLOAD_MISMATCH" as const],
            snapshot,
            readbackCanonicalPayload: canonical,
          }
        : {
            ok: true as const,
            snapshot,
            readbackCanonicalPayload: canonical,
            readbackCanonicalPayloadHash: hashObject(canonical),
          };
    }),
  } as unknown as CreditNoteManualJournalWriteProvider;

  const service = new XeroCreditNoteManualJournalService(
    readProvider,
    writeProvider,
    mutations,
    {
      xeroWriteEnabled: options.writeEnabled ?? true,
      ...(options.omitAllowedTenantId ? {} : { xeroAllowedTenantId: tenantId }),
    },
  );
  return {
    context,
    repository,
    service,
    createCreditNoteDraft,
    createManualJournalDraft,
    creditWriteEvidenceAtRead: () => creditWriteEvidenceAtRead,
    listAccounts,
    mutations,
  };
}

describe("XeroCreditNoteManualJournalService", () => {
  it("uses the exact OAuth Broker binding when the legacy tenant allowlist is intentionally empty", async () => {
    const broker = harness({ oauthBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareCreditNoteDraft(broker.context, {
      ...creditNoteInput,
      source_ref: "work-material:credit-note-broker-empty-allowlist",
      source_unit_key: "credit-note:broker-empty-allowlist",
    });
    await expect(broker.service.createCreditNoteDraft(broker.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-broker-empty-allowlist",
    })).resolves.toMatchObject({ state: "DRAFT_READBACK_VERIFIED", xero_object_id: creditNoteId });
    expect(broker.createCreditNoteDraft).toHaveBeenCalledTimes(1);
  });

  it("creates one source-bound and readback-verified credit-note DRAFT", async () => {
    const { context, service, createCreditNoteDraft } = harness();
    const prepared = await service.prepareCreditNoteDraft(context, creditNoteInput);
    expect(prepared).toMatchObject({
      state: "PREPARED",
      object_type: "CREDIT_NOTE",
      operation: "CREATE_DRAFT",
      proposal: { status: "DRAFT", objectType: "CREDIT_NOTE" },
      execution_mode: "STANDING_AUTONOMOUS_DELEGATION",
      per_transaction_confirmation_required: false,
      next_action: "CALL_EXECUTE_TOOL",
    });
    const execution = {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-controlled-001",
    };
    await expect(service.createCreditNoteDraft(context, execution)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      object_type: "CREDIT_NOTE",
      xero_object_id: creditNoteId,
      status: "DRAFT",
    });
    await expect(service.createCreditNoteDraft(context, execution)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      xero_object_id: creditNoteId,
    });
    expect(createCreditNoteDraft).toHaveBeenCalledTimes(1);
  });

  it("persists the exact provider ID and receipt before the first readback GET", async () => {
    const { context, service, creditWriteEvidenceAtRead } = harness();
    const prepared = await service.prepareCreditNoteDraft(context, {
      ...creditNoteInput,
      source_ref: "work-material:credit-note-write-evidence",
      source_unit_key: "credit-note:write-evidence",
    });
    await service.createCreditNoteDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-write-evidence",
    });
    expect(creditWriteEvidenceAtRead()).toMatchObject({
      state: "WRITE_IN_FLIGHT",
      xeroObjectId: creditNoteId,
      writeReceipt: { operation: "CREATE_CREDIT_NOTE_DRAFT", creditNoteId },
    });
  });

  it("returns the exact Xero ID as WRITE_RESULT_UNKNOWN even when both evidence persistence attempts fail", async () => {
    const failed = harness({ evidencePersistenceFailure: "BOTH" });
    const prepared = await failed.service.prepareCreditNoteDraft(failed.context, {
      ...creditNoteInput,
      source_ref: "work-material:credit-note-double-persistence-failure",
      source_unit_key: "credit-note:double-persistence-failure",
    });
    await expect(failed.service.createCreditNoteDraft(failed.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-double-persistence-failure",
    })).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: { xeroObjectId: creditNoteId },
    });
  });

  it("creates one balanced NoTax manual-journal DRAFT and replays idempotently", async () => {
    const { context, service, createManualJournalDraft } = harness();
    const prepared = await service.prepareManualJournalDraft(context, manualJournalInput);
    expect(prepared).toMatchObject({
      state: "PREPARED",
      object_type: "MANUAL_JOURNAL",
      proposal: {
        status: "DRAFT",
        lineAmountType: "NO_TAX",
        debitTotal: "500.0000",
        creditTotal: "500.0000",
        netAmount: "0.0000",
      },
    });
    const execution = {
      preparation_id: prepared.preparation_id,
      request_id: "manual-journal-controlled-001",
    };
    await expect(service.createManualJournalDraft(context, execution)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      object_type: "MANUAL_JOURNAL",
      xero_object_id: manualJournalId,
      status: "DRAFT",
    });
    await expect(service.createManualJournalDraft(context, execution)).resolves.toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      xero_object_id: manualJournalId,
    });
    expect(createManualJournalDraft).toHaveBeenCalledTimes(1);
  });

  it("rejects the removed phrase field, requires an open write gate, and accepts only the two-field envelope", async () => {
    const wrong = harness();
    const prepared = await wrong.service.prepareCreditNoteDraft(wrong.context, creditNoteInput);
    await expect(wrong.service.createCreditNoteDraft(wrong.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-wrong-phrase",
      confirmation_phrase: "legacy-model-copied-phrase",
    } as never)).rejects.toBeDefined();
    expect(wrong.createCreditNoteDraft).not.toHaveBeenCalled();

    await expect(wrong.service.createCreditNoteDraft(wrong.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-extra-field",
      tenant_id: tenantId,
    } as never)).rejects.toBeDefined();
    expect(wrong.createCreditNoteDraft).not.toHaveBeenCalled();

    const closed = harness({ writeEnabled: false });
    const closedPrepared = await closed.service.prepareManualJournalDraft(closed.context, {
      ...manualJournalInput,
      source_ref: "work-material:manual-journal-closed",
      source_unit_key: "manual-journal:closed",
    });
    await expect(closed.service.createManualJournalDraft(closed.context, {
      preparation_id: closedPrepared.preparation_id,
      request_id: "manual-journal-write-gate-closed",
    })).rejects.toMatchObject({
      code: "WRITE_GATE_DISABLED",
      details: { denyReasons: expect.arrayContaining(["WRITE_GATE_CLOSED"]) },
    });
    expect(closed.createManualJournalDraft).not.toHaveBeenCalled();

    const legacyWithoutAllowlist = harness({ oauthBound: false, omitAllowedTenantId: true });
    const legacyPrepared = await legacyWithoutAllowlist.service.prepareCreditNoteDraft(
      legacyWithoutAllowlist.context,
      {
        ...creditNoteInput,
        source_ref: "work-material:credit-note-legacy-no-allowlist",
        source_unit_key: "credit-note:legacy-no-allowlist",
      },
    );
    await expect(legacyWithoutAllowlist.service.createCreditNoteDraft(legacyWithoutAllowlist.context, {
      preparation_id: legacyPrepared.preparation_id,
      request_id: "credit-note-legacy-no-allowlist",
    })).rejects.toMatchObject({
      code: "TARGET_SESSION_INVALID",
      details: { denyReasons: expect.arrayContaining(["WRITE_TENANT_NOT_ALLOWED"]) },
    });
    expect(legacyWithoutAllowlist.createCreditNoteDraft).not.toHaveBeenCalled();
  });

  it("revalidates persisted ledger references immediately before POST", async () => {
    const changed = harness({ contactBecomesInactive: true });
    const prepared = await changed.service.prepareCreditNoteDraft(changed.context, {
      ...creditNoteInput,
      source_ref: "work-material:credit-note-stale-contact",
      source_unit_key: "credit-note:stale-contact",
    });
    await expect(changed.service.createCreditNoteDraft(changed.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-stale-contact",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(changed.createCreditNoteDraft).not.toHaveBeenCalled();
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(changed.repository.getXeroMutationRequest(mutationId)).resolves.toBeUndefined();
  });

  it("rejects same-ID/code credit COA semantic drift before a mutation claim or Provider write", async () => {
    const drift = harness();
    const confirmMutation = vi.spyOn(drift.repository, "confirmXeroMutationPreparation");
    const authorisePermit = vi.spyOn(drift.mutations, "authoriseAutonomous");
    const constraints = createXeroDeclaredLedgerExecutionConstraints(
      testLedgerBinding(tenantId),
      [{ accountCode: "200", taxType: "OUTPUTY24" }],
    );
    const prepared = await drift.service.prepareCreditNoteDraft(drift.context, {
      ...creditNoteInput,
      source_ref: "work-material:credit-note-coa-permit-edge-drift",
      source_unit_key: "credit-note:coa-permit-edge-drift",
    }, constraints);
    const goodAccounts = [
      { accountId: revenueAccountId, code: "200", name: "Sales", status: "ACTIVE", type: "REVENUE", class: "REVENUE" },
      { accountId: expenseAccountId, code: "400", name: "Operating expense", status: "ACTIVE", type: "EXPENSE", class: "EXPENSE" },
    ];
    const driftedAccounts = goodAccounts.map((account) => account.accountId === revenueAccountId
      ? { ...account, type: "ASSET", class: "ASSET" }
      : account);
    drift.listAccounts.mockReset();
    // Outer reference + semantic checks pass. The claim-adjacent complete
    // reference read remains generically valid, then the semantic comparison
    // sees the same ID/code with an ASSET type/class.
    drift.listAccounts
      .mockResolvedValueOnce(goodAccounts)
      .mockResolvedValueOnce(goodAccounts)
      .mockResolvedValueOnce(driftedAccounts)
      .mockResolvedValue(driftedAccounts);

    await expect(drift.service.createCreditNoteDraft(drift.context, {
      preparation_id: prepared.preparation_id,
      request_id: "credit-note-coa-permit-edge-drift",
    }, constraints)).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      details: {
        reasonCodes: ["XERO_DECLARED_EXECUTION_ACCOUNT_SEMANTICS_DRIFT"],
        providerMutationPossible: false,
      },
    });
    expect(authorisePermit).toHaveBeenCalledOnce();
    expect(confirmMutation).not.toHaveBeenCalled();
    expect(drift.createCreditNoteDraft).not.toHaveBeenCalled();
    await expect(drift.repository.getXeroMutationRequest(
      `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`,
    )).resolves.toBeUndefined();
  });

  it("rejects unresolved contact, tax, and protected-account references before preparation", async () => {
    const missingContact = harness({ missingContact: true });
    await expect(missingContact.service.prepareCreditNoteDraft(
      missingContact.context,
      creditNoteInput,
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { path: "contact_id" } });

    const missingTax = harness({ missingTax: true });
    await expect(missingTax.service.prepareCreditNoteDraft(
      missingTax.context,
      { ...creditNoteInput, source_unit_key: "credit-note:missing-tax" },
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { path: "lines[0].tax_type" } });

    const protectedAccount = harness({ protectExpenseAccount: true });
    await expect(protectedAccount.service.prepareManualJournalDraft(
      protectedAccount.context,
      { ...manualJournalInput, source_unit_key: "manual-journal:protected" },
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { path: "lines[0].account_id" } });
  });

  it("rejects an item on the wrong business side and unresolved tracking options", async () => {
    const wrongItem = harness({ invalidItemSide: true });
    await expect(wrongItem.service.prepareCreditNoteDraft(wrongItem.context, {
      ...creditNoteInput,
      source_unit_key: "credit-note:wrong-item-side",
      lines: [{ ...creditNoteInput.lines[0], item_code: "ADVISORY" }],
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { path: "lines[0].item_code" },
    });

    const tracking = harness({ trackingIncomplete: true });
    await expect(tracking.service.prepareManualJournalDraft(tracking.context, {
      ...manualJournalInput,
      source_unit_key: "manual-journal:bad-tracking",
      lines: manualJournalInput.lines.map((line, index) => ({
        ...line,
        ...(index === 0 ? { tracking_option_ids: ["88888888-8888-4888-8888-888888888888"] } : {}),
      })),
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { path: "lines.tracking_option_ids" },
    });
  });

  it("records a definite provider rejection separately from an uncertain write outcome", async () => {
    const rejected = harness({ providerFailure: "DEFINITELY_REJECTED" });
    const rejectedPreparation = await rejected.service.prepareCreditNoteDraft(rejected.context, {
      ...creditNoteInput,
      source_unit_key: "credit-note:provider-rejected",
    });
    await expect(rejected.service.createCreditNoteDraft(rejected.context, {
      preparation_id: rejectedPreparation.preparation_id,
      request_id: "credit-note-provider-rejected",
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    const rejectedMutationId = `xmr_${hashObject({ preparationId: rejectedPreparation.preparation_id }).slice(0, 32)}`;
    await expect(rejected.repository.getXeroMutationRequest(rejectedMutationId)).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: { writeOutcome: "DEFINITELY_REJECTED" },
    });

    const unknown = harness({ providerFailure: "UNKNOWN" });
    const unknownPreparation = await unknown.service.prepareCreditNoteDraft(unknown.context, {
      ...creditNoteInput,
      source_unit_key: "credit-note:provider-unknown",
    });
    await expect(unknown.service.createCreditNoteDraft(unknown.context, {
      preparation_id: unknownPreparation.preparation_id,
      request_id: "credit-note-provider-unknown",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    const unknownMutationId = `xmr_${hashObject({ preparationId: unknownPreparation.preparation_id }).slice(0, 32)}`;
    await expect(unknown.repository.getXeroMutationRequest(unknownMutationId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
    });
  });

  it("persists a manual-journal readback mismatch and never reports success", async () => {
    const mismatch = harness({ manualReadbackMismatch: true });
    const prepared = await mismatch.service.prepareManualJournalDraft(mismatch.context, {
      ...manualJournalInput,
      source_unit_key: "manual-journal:mismatch",
    });
    await expect(mismatch.service.createManualJournalDraft(mismatch.context, {
      preparation_id: prepared.preparation_id,
      request_id: "manual-journal-readback-mismatch",
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    const mutationId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(mismatch.repository.getXeroMutationRequest(mutationId)).resolves.toMatchObject({
      state: "READBACK_MISMATCH",
      xeroObjectId: manualJournalId,
    });
  });
});
