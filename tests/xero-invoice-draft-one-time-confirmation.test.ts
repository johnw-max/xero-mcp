import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import type { AccountingProvider, InvoiceSnapshot, SupplierBillSnapshot } from "../src/providers/types.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";
import { XERO_AUTONOMOUS_WRITE_ACTIONS } from "../src/policy/xeroAutonomousActions.js";
import { createXeroTenantCoaExecutionConstraints } from "../src/policy/xeroTenantCoaProfile.js";
import { testXeroTenantCoaBinding } from "./helpers/xeroTenantCoaProfile.js";
import { RepositoryLedgerAuthoritySnapshotResolver } from "../src/domain/ledgerAuthority.js";
import {
  verifyXeroExternalGovernanceAuthority,
  xeroStandingDelegationsWithExternalGovernance,
} from "../src/policy/xeroExternalGovernanceAuthority.js";
import { createTestXeroGovernanceArtifacts } from "./helpers/xeroGovernanceAuthority.js";
import { xeroProviderWritePermitMode } from "../src/security/xeroProviderWritePermit.js";
import { XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS } from "../src/db/repository.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const salesInvoiceId = "44444444-4444-4444-8444-444444444444";
const expenseAccountId = "33333333-3333-4333-8333-333333333385";
const revenueAccountId = "33333333-3333-4333-8333-333333333333";
const fixedNow = new Date("2026-08-14T00:30:00.000Z");
const supplierFormalGovernanceExpectation = Object.freeze({
  route: "SUPPLIER_BILL" as const,
  referenceKind: "FORMAL_DOCUMENT_NUMBER" as const,
  authoritativeProviderField: "INVOICE_NUMBER" as const,
});

function harness(initialNow = fixedNow) {
  let currentNow = initialNow;
  const repository = new InMemoryAccountingRepository({ now: () => currentNow });
  const resolvedToken: ResolvedMcpAccessToken = {
    tokenId: "token-invoice-confirmation",
    clientId: "agent2-accounting-mcp",
    resource: "https://xero-mcp.example.test/mcp",
    audience: "https://xero-mcp.example.test/mcp",
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: new Date("2026-08-07T00:00:00.000Z"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    installationId: "installation-invoice-confirmation",
    bindingId: "binding-invoice-confirmation",
    connectionId: "connection-invoice-confirmation",
    bindingRevision: 1,
    authorizationId: "authorization-invoice-confirmation",
    workspaceId: "workspace-invoice-confirmation",
    subjectType: "USER",
    subjectId: "user-invoice-confirmation",
    agentId: "agent-invoice-confirmation",
    policyId: "policy-invoice-confirmation",
    tenantId,
  };
  const context = Object.freeze({
    ...createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    }),
    targetSessionId: "target-session-invoice",
    targetSessionHash: "c".repeat(64),
    targetSessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  const readOnlyRecoveryContext = Object.freeze({
    ...createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken: {
        ...resolvedToken,
        tokenId: "token-invoice-recovery-read-only",
        grantedScopes: ["xero.read"],
      },
    }),
    targetSessionId: "target-session-invoice-renewed",
    targetSessionHash: "d".repeat(64),
    targetSessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  const resolvedBinding = {
    installationId: resolvedToken.installationId,
    bindingId: resolvedToken.bindingId,
    workspaceId: resolvedToken.workspaceId,
    subjectType: resolvedToken.subjectType,
    subjectId: resolvedToken.subjectId,
    agentId: resolvedToken.agentId,
    connectionId: resolvedToken.connectionId,
    bindingRevision: resolvedToken.bindingRevision,
    authorizationId: resolvedToken.authorizationId,
    tenantId,
    tenantName: "Demo Organisation",
    policyId: resolvedToken.policyId,
  };
  vi.spyOn(repository, "resolveAgentConnectionBinding").mockResolvedValue(resolvedBinding);
  vi.spyOn(repository, "resolveLedgerTargetSession").mockImplementation(async (input) => {
    const renewed = input.sessionHash === readOnlyRecoveryContext.targetSessionHash;
    return {
      session: {
      sessionId: renewed ? readOnlyRecoveryContext.targetSessionId : context.targetSessionId,
      sessionHash: input.sessionHash,
      installationId: resolvedToken.installationId,
      bindingId: resolvedToken.bindingId,
      connectionId: resolvedToken.connectionId,
      bindingRevision: resolvedToken.bindingRevision,
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
      binding: resolvedBinding,
    };
  });
  const bill: SupplierBillSnapshot = {
    tenantId,
    invoiceId,
    type: "ACCPAY",
    status: "DRAFT",
    contact: { contactId, name: "Demo Supplier" },
    invoiceDate: "2026-08-07",
    dueDate: "2026-08-21",
    currency: "HKD",
    invoiceNumber: "AP-ONE-TIME-001",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Synthetic subscription",
      quantity: "1.0000",
      unitAmount: "43.2100",
      lineAmount: "43.2100",
      taxAmount: "0.0000",
      accountCode: "485",
      accountId: expenseAccountId,
      taxType: "NONE",
    }],
    subTotal: "43.2100",
    totalTax: "0.0000",
    total: "43.2100",
  };
  const createDraftSupplierBill = vi.fn(async (
    _principal: unknown,
    _input: unknown,
    _idempotencyKey: string,
    recordWriteEvidence?: (evidence: { invoiceId: string; receipt: Record<string, unknown> }) => Promise<void>,
  ) => {
    const receipt = { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "provider-one-time-001" };
    await recordWriteEvidence?.({ invoiceId, receipt });
    return { bill, receipt };
  });
  const salesInvoice: InvoiceSnapshot = {
    ...bill,
    invoiceId: salesInvoiceId,
    type: "ACCREC",
    invoiceNumber: "AR-ONE-TIME-001",
    reference: "supplementary-reference",
    lines: [{
      ...bill.lines[0]!,
      description: "Synthetic advisory",
      unitAmount: "88.0000",
      lineAmount: "88.0000",
      accountCode: "200",
      accountId: revenueAccountId,
    }],
    subTotal: "88.0000",
    totalTax: "0.0000",
    total: "88.0000",
  };
  const salesProviderPermitModes: string[] = [];
  const salesIdempotencyKeys: string[] = [];
  const createDraftSalesInvoice = vi.fn(async (
    _principal: unknown,
    _input: unknown,
    _idempotencyKey: string,
    recordWriteEvidence?: (evidence: { invoiceId: string; receipt: Record<string, unknown> }) => Promise<void>,
    providerWritePermit?: Parameters<typeof xeroProviderWritePermitMode>[0],
  ) => {
    salesIdempotencyKeys.push(_idempotencyKey);
    salesProviderPermitModes.push(xeroProviderWritePermitMode(providerWritePermit));
    const receipt = {
      operation: "CREATE_ACCREC_DRAFT",
      invoiceId: salesInvoiceId,
      providerRequestId: "provider-sales-one-time-001",
    };
    await recordWriteEvidence?.({ invoiceId: salesInvoiceId, receipt });
    return { invoice: salesInvoice, receipt };
  });
  const getContact = vi.fn(async () => ({ contactId, name: "Demo Supplier", status: "ACTIVE" }));
  const getSupplierBill = vi.fn(async () => bill);
  const liveAccounts = () => [
    { accountId: expenseAccountId, code: "485", name: "Subscriptions", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
    { accountId: revenueAccountId, code: "200", name: "Advisory Revenue", type: "REVENUE", class: "REVENUE", status: "ACTIVE" },
  ];
  const listAccounts = vi.fn(async () => liveAccounts());
  const provider = {
    getSupplierBillDraftReferenceData: vi.fn(async () => ({
      tenant: { id: tenantId, name: "Demo Organisation" },
      contacts: [{ contactId, name: "Demo Supplier", status: "ACTIVE", isSupplier: true }],
      contactsComplete: true,
      accounts: [
        ...liveAccounts(),
      ],
      taxRates: [{
        taxType: "NONE",
        name: "No Tax",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
        canApplyToRevenue: true,
        canApplyToAssets: true,
      }],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId, tenantName: "Demo Organisation" })),
    listAccounts,
    listTaxRates: vi.fn(async () => [
      {
        taxType: "NONE",
        name: "No Tax",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
        canApplyToRevenue: true,
        canApplyToAssets: true,
      },
    ]),
    getContact,
    getSupplierBill,
    createDraftSupplierBill,
    createDraftSalesInvoice,
  } as unknown as AccountingProvider;
  const artifacts = createTestXeroGovernanceArtifacts(tenantId, {
    workspaceId: resolvedToken.workspaceId,
    agentId: resolvedToken.agentId,
    installationId: resolvedToken.installationId,
    writerId: "test-invoice-writer",
    coordinationDomainId: "test-invoice-coordination-domain",
  });
  const externalAuthority = verifyXeroExternalGovernanceAuthority({
    trustBundle: artifacts.trustBundle,
    receipts: artifacts.receipts,
    status: artifacts.status,
    expectedTrustBundleSha256: artifacts.expectedTrustBundleSha256,
    expectedReceiptsSha256: artifacts.expectedReceiptsSha256,
    expectedStatusSha256: artifacts.expectedStatusSha256,
    now: initialNow,
  });
  const governedDelegations = xeroStandingDelegationsWithExternalGovernance(externalAuthority, [{
    delegationId: "test-invoice-standing-delegation",
    revision: 1,
    status: "ACTIVE",
    providerId: "xero",
    workspaceId: resolvedToken.workspaceId,
    agentId: resolvedToken.agentId,
    installationId: resolvedToken.installationId,
    tenantIds: [tenantId],
    actionIds: XERO_AUTONOMOUS_WRITE_ACTIONS,
  }]);
  void repository.publishLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 1,
    writeKillSwitchEnabled: true,
    standingDelegations: governedDelegations,
    publishedAt: initialNow,
  });
  const authoritySnapshotResolver = new RepositoryLedgerAuthoritySnapshotResolver(repository);
  const providerCapabilityEvaluator = {
    evaluate: vi.fn(async () => ({ allowed: true, denyReasons: [] as string[], receiptHash: "e".repeat(64) })),
  };
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "invoice-confirmation-secret-that-is-at-least-32-bytes",
    authoritySnapshotResolver,
    now: () => currentNow,
    providerCapabilityEvaluator,
  });
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new AccountingService({
    repository,
    provider,
    config: { publicBaseUrl: "https://xero-mcp.example.test", xeroWriteEnabled: true },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    mutationFoundation: mutations,
  });
  const readOnlyRecoveryService = new AccountingService({
    repository,
    provider,
    config: { publicBaseUrl: "https://xero-mcp.example.test", xeroWriteEnabled: false },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    mutationFoundation: mutations,
  });
  return {
    repository,
    context,
    readOnlyRecoveryContext,
    service,
    readOnlyRecoveryService,
    mutations,
    authoritySnapshotResolver,
    governedDelegations,
    createDraftSupplierBill,
    createDraftSalesInvoice,
    salesInvoice,
    getContact,
    getSupplierBill,
    listAccounts,
    providerCapabilityEvaluator,
    salesIdempotencyKeys,
    salesProviderPermitModes,
    setNow: (next: Date) => { currentNow = next; },
  };
}

describe("Supplier Bill standing autonomous execution", () => {
  it("binds execution to the persisted proposal and makes replay idempotent", async () => {
    const { repository, context, service, createDraftSupplierBill } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-one-time-001",
      source_sha256: "a".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    expect(prepared).toMatchObject({
      technicallyReady: true,
      preparation_id: expect.stringMatching(/^xmp_[a-f0-9]{32}$/),
      expires_at: expect.any(String),
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");

    await expect(service.executePreparedSupplierBillDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-confirm-001",
      total: 999,
    } as never, undefined, undefined, supplierFormalGovernanceExpectation)).rejects.toBeDefined();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();

    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-confirm-001",
    };
    const created = await service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    );
    expect(created).toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      mutationRequestId: expect.stringMatching(/^xmr_[a-f0-9]{32}$/),
    });
    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).resolves.toMatchObject({
      invoiceId,
      status: "DRAFT",
      idempotentReplay: true,
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
    await expect(repository.getXeroMutationRequest(created.mutationRequestId)).resolves.toMatchObject({
      objectType: "SUPPLIER_BILL",
      state: "READBACK_VERIFIED",
      xeroObjectId: invoiceId,
      readbackStatus: "DRAFT",
    });
  });

  it("does not issue authority before validation and can execute after the external reference is repaired", async () => {
    const { context, service, createDraftSupplierBill, getContact } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-validation-terminal-001",
      source_sha256: "c".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-validation-terminal-confirm-001",
    };

    getContact.mockResolvedValueOnce(undefined);
    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(createDraftSupplierBill).not.toHaveBeenCalled();

    getContact.mockResolvedValue({ contactId, name: "Demo Supplier", status: "ACTIVE" });
    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).resolves.toMatchObject({
      invoiceId,
      readbackVerified: true,
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it("claims the generic mutation before the legacy Provider create", async () => {
    const { repository, context, service, createDraftSupplierBill } = harness();
    const atomicClaim = vi.spyOn(repository, "confirmXeroMutationPreparation");
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-generic-claim-order-001",
      source_sha256: "e".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");

    await service.executePreparedSupplierBillDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ap-generic-claim-order-confirm-001",
    }, undefined, undefined, supplierFormalGovernanceExpectation);

    expect(atomicClaim).toHaveBeenCalledOnce();
    expect(atomicClaim).toHaveBeenCalledWith(expect.objectContaining({ claimForWrite: true }));
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
    expect(atomicClaim.mock.invocationCallOrder[0]).toBeLessThan(
      createDraftSupplierBill.mock.invocationCallOrder[0]!,
    );
  });

  it("records a definite Provider rejection terminally before allowing replay", async () => {
    const { repository, context, service, createDraftSupplierBill } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-provider-rejected-terminal-001",
      source_sha256: "f".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-PROVIDER-REJECTED-TERMINAL-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-provider-rejected-terminal-confirm-001",
    };
    createDraftSupplierBill.mockRejectedValueOnce(new AppError(
      "PROVIDER_ERROR",
      "Xero definitely rejected the draft.",
      { httpStatus: 422, details: { writeOutcome: "DEFINITELY_REJECTED" } },
    ));

    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: {
        reasonCode: "PROVIDER_ERROR",
      },
    });

    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it("keeps concurrent execution of the same confirmation to one Provider create", async () => {
    const { context, service, createDraftSupplierBill } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-one-time-001",
      source_sha256: "d".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-concurrent-confirm-001",
    };

    const [first, second] = await Promise.all([
      service.executePreparedSupplierBillDraft(
        context, command, undefined, undefined, supplierFormalGovernanceExpectation,
      ),
      service.executePreparedSupplierBillDraft(
        context, command, undefined, undefined, supplierFormalGovernanceExpectation,
      ),
    ]);
    expect(first.invoiceId).toBe(invoiceId);
    expect(second.invoiceId).toBe(invoiceId);
    expect([first.idempotentReplay, second.idempotentReplay]).toContain(true);
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it("recovers a WRITE_UNCERTAIN generic mutation from exact legacy readback without a second Provider create", async () => {
    const { repository, context, service, createDraftSupplierBill, getSupplierBill } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-recover-generic-001",
      source_sha256: "7".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-recover-generic-confirm-001",
    };
    createDraftSupplierBill.mockImplementationOnce(async (
      _principal,
      _input,
      _idempotencyKey,
      recordWriteEvidence,
    ) => {
      const receipt = { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "provider-recover-001" };
      await recordWriteEvidence?.({ invoiceId, receipt });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Provider response timed out after the write.", {
        httpStatus: 502,
        retryable: false,
        details: { invoiceId },
      });
    });

    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
    });
    const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
    });

    await expect(service.executePreparedSupplierBillDraft(context, command)).resolves.toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      idempotentReplay: true,
      mutationRequestId,
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
    expect(getSupplierBill).toHaveBeenCalledOnce();
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      xeroObjectId: invoiceId,
    });
  });

  it("keeps an in-flight mutation durable when markUnknown fails and blocks every retry create", async () => {
    const { repository, context, service, mutations, createDraftSupplierBill } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-mark-unknown-persistence-failure-001",
      source_sha256: "9".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-MARK-UNKNOWN-PERSISTENCE-FAILURE-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-mark-unknown-persistence-failure-confirm-001",
    };
    const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    const markUnknown = vi.spyOn(mutations, "markUnknown").mockRejectedValueOnce(
      new Error("simulated mutation uncertainty persistence failure"),
    );
    createDraftSupplierBill.mockRejectedValueOnce(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "The submitted Xero response was lost.",
      { httpStatus: 502, retryable: false },
    ));

    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(markUnknown).toHaveBeenCalledOnce();
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_IN_FLIGHT",
    });

    await expect(mutations.resumeAutonomousRecovery(context, {
      preparationId: prepared.preparation_id,
      requestId: command.request_id,
    }, { objectType: "SUPPLIER_BILL", operation: "CREATE_DRAFT" })).resolves.toMatchObject({
      claim: {
        mode: "RECOVER_ONLY",
        request: { mutationRequestId, state: "WRITE_IN_FLIGHT" },
      },
    });
    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();

    const duplicatePreparation = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-mark-unknown-persistence-failure-001",
      source_sha256: "9".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-MARK-UNKNOWN-PERSISTENCE-FAILURE-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!duplicatePreparation.preparation_id) throw new Error("duplicate preparation missing");
    await expect(service.executePreparedSupplierBillDraft(context, {
      preparation_id: duplicatePreparation.preparation_id,
      request_id: "ap-mark-unknown-persistence-failure-new-request-001",
    }, undefined, undefined, supplierFormalGovernanceExpectation)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This source already has an active Xero mutation.",
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it("allows renewed same-organisation read-only recovery with the deployment write gate closed", async () => {
    const {
      repository,
      context,
      readOnlyRecoveryContext,
      service,
      readOnlyRecoveryService,
      mutations,
      governedDelegations,
      createDraftSupplierBill,
      getSupplierBill,
    } = harness();
    const authorisePermit = vi.spyOn(mutations, "authoriseAutonomous");
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-recover-read-only-001",
      source_sha256: "8".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-recover-read-only-confirm-001",
    };
    createDraftSupplierBill.mockImplementationOnce(async (
      _principal,
      _input,
      _idempotencyKey,
      recordWriteEvidence,
    ) => {
      const receipt = { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "provider-read-only-recovery" };
      await recordWriteEvidence?.({ invoiceId, receipt });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Provider response timed out after the write.", {
        httpStatus: 502,
        retryable: false,
        details: { invoiceId },
      });
    });
    await expect(service.executePreparedSupplierBillDraft(
      context, command, undefined, undefined, supplierFormalGovernanceExpectation,
    )).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
    });
    const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
    });

    await repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 2,
      writeKillSwitchEnabled: false,
      standingDelegations: governedDelegations.map((delegation) => ({ ...delegation, status: "REVOKED" as const })),
      publishedAt: new Date(fixedNow.getTime() + 1),
    });

    authorisePermit.mockClear();
    createDraftSupplierBill.mockClear();
    getSupplierBill.mockClear();
    await expect(readOnlyRecoveryService.executePreparedSupplierBillDraft(
      readOnlyRecoveryContext,
      command,
    )).resolves.toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      mutationRequestId,
    });

    expect(getSupplierBill).toHaveBeenCalledOnce();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
    expect(authorisePermit).not.toHaveBeenCalled();
  });
});

describe("Sales Invoice standing autonomous execution", () => {
  it("creates ACCREC only from the server-persisted confirmed proposal", async () => {
    const { repository, context, service, createDraftSalesInvoice } = harness();
    const atomicClaim = vi.spyOn(repository, "confirmXeroMutationPreparation");
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-one-time-001",
      source_sha256: "b".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    expect(prepared).toMatchObject({
      technicallyReady: true,
      preparation_id: expect.stringMatching(/^xmp_[a-f0-9]{32}$/),
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");

    const created = await service.executePreparedSalesInvoiceDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ar-one-time-confirm-001",
    });
    expect(created).toMatchObject({
      invoiceId: salesInvoiceId,
      status: "DRAFT",
      readbackVerified: true,
      mutationRequestId: expect.stringMatching(/^xmr_[a-f0-9]{32}$/),
    });
    expect(atomicClaim).toHaveBeenCalledOnce();
    expect(atomicClaim).toHaveBeenCalledWith(expect.objectContaining({ claimForWrite: true }));
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
    expect(atomicClaim.mock.invocationCallOrder[0]).toBeLessThan(
      createDraftSalesInvoice.mock.invocationCallOrder[0]!,
    );
    await expect(repository.getXeroMutationRequest(created.mutationRequestId)).resolves.toMatchObject({
      objectType: "SALES_INVOICE",
      state: "READBACK_VERIFIED",
      xeroObjectId: salesInvoiceId,
      readbackStatus: "DRAFT",
    });
  });

  it("replays one native idempotency recovery after a submitted response is lost without creating a second invoice", async () => {
    const {
      repository,
      context,
      service,
      createDraftSalesInvoice,
      salesInvoice,
      salesIdempotencyKeys,
      salesProviderPermitModes,
    } = harness();
    const recoveredInvoice = { ...salesInvoice, invoiceNumber: "AR-ONE-TIME-001" };
    const providerObjects = new Set<string>();
    const first = createDraftSalesInvoice.mockImplementationOnce(async (
      _principal,
      _input,
      idempotencyKey,
      _recordWriteEvidence,
      providerWritePermit,
    ) => {
      salesIdempotencyKeys.push(idempotencyKey);
      salesProviderPermitModes.push(xeroProviderWritePermitMode(providerWritePermit));
      // The provider accepted the create, but the transport lost the response
      // before an InvoiceID reached the MCP.
      providerObjects.add(salesInvoiceId);
      throw new AppError("WRITE_RESULT_UNKNOWN", "The submitted Xero response was lost.", {
        httpStatus: 502,
        retryable: false,
      });
    });
    first.mockImplementation(async (
      _principal,
      _input,
      idempotencyKey,
      recordWriteEvidence,
      providerWritePermit,
    ) => {
      salesIdempotencyKeys.push(idempotencyKey);
      salesProviderPermitModes.push(xeroProviderWritePermitMode(providerWritePermit));
      // Xero native idempotency returns the original object for the exact same
      // request/key; the mock deliberately records only one provider object.
      providerObjects.add(salesInvoiceId);
      await recordWriteEvidence?.({
        invoiceId: salesInvoiceId,
        receipt: {
          operation: "NATIVE_IDEMPOTENCY_RECOVERY",
          invoiceId: salesInvoiceId,
          providerRequestId: "provider-sales-native-recovery",
        },
      });
      return {
        invoice: recoveredInvoice,
        receipt: {
          operation: "NATIVE_IDEMPOTENCY_RECOVERY",
          invoiceId: salesInvoiceId,
          providerRequestId: "provider-sales-native-recovery",
        },
      };
    });
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-native-recovery-001",
      source_sha256: "e".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-ONE-TIME-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ar-native-recovery-001",
    };

    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    const replay = await service.executePreparedSalesInvoiceDraft(context, command);
    expect(replay).toMatchObject({
      invoiceId: salesInvoiceId,
      status: "DRAFT",
      readbackVerified: true,
      idempotentReplay: true,
      providerReceipt: expect.objectContaining({ operation: "NATIVE_IDEMPOTENCY_RECOVERY" }),
    });

    expect(createDraftSalesInvoice).toHaveBeenCalledTimes(2);
    expect(salesIdempotencyKeys).toHaveLength(2);
    expect(salesIdempotencyKeys[0]).toBe(salesIdempotencyKeys[1]);
    expect(salesProviderPermitModes).toEqual([
      "INITIAL_WRITE",
      "NATIVE_IDEMPOTENCY_RECOVERY",
    ]);
    expect(providerObjects).toHaveLength(1);
    await expect(repository.getXeroMutationRequest(
      `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`,
    )).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      nativeRecoveryClaim: expect.objectContaining({
        receiptType: "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM",
      }),
      writeReceipt: expect.not.objectContaining({ nativeRecoveryClaim: expect.anything() }),
    });
  });

  it("rejects native recovery at the five-minute boundary without a replay", async () => {
    const { context, service, createDraftSalesInvoice, setNow } = harness();
    createDraftSalesInvoice.mockRejectedValueOnce(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "The submitted Xero response was lost.",
      { httpStatus: 502, retryable: false },
    ));
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-native-recovery-expired-001",
      source_sha256: "1".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-NATIVE-RECOVERY-EXPIRED-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ar-native-recovery-expired-001",
    };
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });

    setNow(new Date(fixedNow.getTime() + XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS));
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({
        code: "WRITE_RESULT_UNKNOWN",
        details: { reasonCode: "RECOVERY_AUTHORITY_OR_WINDOW_INVALID" },
      });
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent native recovery claim and one replay call", async () => {
    const { context, service, createDraftSalesInvoice } = harness();
    let enterReplay!: () => void;
    let releaseReplay!: () => void;
    const replayEntered = new Promise<void>((resolve) => { enterReplay = resolve; });
    const replayReleased = new Promise<void>((resolve) => { releaseReplay = resolve; });
    createDraftSalesInvoice
      .mockRejectedValueOnce(new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The submitted Xero response was lost.",
        { httpStatus: 502, retryable: false },
      ))
      .mockImplementationOnce(async () => {
        enterReplay();
        await replayReleased;
        throw new AppError("WRITE_RESULT_UNKNOWN", "The recovery response was also lost.", {
          httpStatus: 502,
          retryable: false,
        });
      });
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-native-recovery-concurrent-001",
      source_sha256: "2".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-NATIVE-RECOVERY-CONCURRENT-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ar-native-recovery-concurrent-001",
    };
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });

    const firstReplay = service.executePreparedSalesInvoiceDraft(context, command);
    await replayEntered;
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({
        code: "CONFLICT",
        details: { reasonCode: "RECOVERY_REPLAY_ALREADY_CONSUMED" },
      });
    releaseReplay();
    await expect(firstReplay).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(createDraftSalesInvoice).toHaveBeenCalledTimes(2);
  });

  it("rejects native recovery after authority revision drift and never replays", async () => {
    const {
      repository,
      context,
      service,
      createDraftSalesInvoice,
      governedDelegations,
    } = harness();
    createDraftSalesInvoice.mockRejectedValueOnce(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "The submitted Xero response was lost.",
      { httpStatus: 502, retryable: false },
    ));
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-native-recovery-authority-drift-001",
      source_sha256: "3".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-NATIVE-RECOVERY-AUTHORITY-DRIFT-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ar-native-recovery-authority-drift-001",
    };
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await repository.publishLedgerAuthoritySnapshot({
      providerId: "xero",
      revision: 2,
      writeKillSwitchEnabled: true,
      standingDelegations: governedDelegations,
      publishedAt: new Date(fixedNow.getTime() + 1_000),
    });

    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({
        code: "APPROVAL_INVALID",
        details: { reasonCode: "RECOVERY_AUTHORITY_DRIFT" },
      });
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
  });

  it("rejects native recovery when current Provider capability is denied", async () => {
    const {
      context,
      service,
      createDraftSalesInvoice,
      providerCapabilityEvaluator,
    } = harness();
    createDraftSalesInvoice.mockRejectedValueOnce(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "The submitted Xero response was lost.",
      { httpStatus: 502, retryable: false },
    ));
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-native-recovery-provider-deny-001",
      source_sha256: "4".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-NATIVE-RECOVERY-PROVIDER-DENY-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ar-native-recovery-provider-deny-001",
    };
    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    providerCapabilityEvaluator.evaluate.mockResolvedValue({
      allowed: false,
      denyReasons: ["MISSING_XERO_OAUTH_SCOPE"],
      receiptHash: "f".repeat(64),
    });

    await expect(service.executePreparedSalesInvoiceDraft(context, command))
      .rejects.toMatchObject({
        code: "ACTION_UNSUPPORTED",
        details: {
          providerAccessDenyReasons: ["MISSING_XERO_OAUTH_SCOPE"],
          providerMutationPossible: false,
        },
      });
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
  });

  it("rejects same-ID/code COA semantic drift before a mutation claim or Provider write", async () => {
    const {
      repository,
      context,
      service,
      mutations,
      createDraftSalesInvoice,
      listAccounts,
    } = harness();
    const confirmMutation = vi.spyOn(repository, "confirmXeroMutationPreparation");
    const authorisePermit = vi.spyOn(mutations, "authoriseAutonomous");
    const constraints = createXeroTenantCoaExecutionConstraints(
      testXeroTenantCoaBinding(tenantId),
      ["CONSULTING_REVENUE"],
    );
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-coa-permit-edge-drift",
      source_sha256: "9".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-COA-PERMIT-EDGE-DRIFT",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic advisory",
        quantity: 1,
        unit_amount: 88,
        account_code: "200",
        tax_type: "NONE",
      }],
    }, constraints);
    if (!prepared.preparation_id) throw new Error("preparation missing");

    const goodAccounts = [
      { accountId: expenseAccountId, code: "485", name: "Subscriptions", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
      { accountId: revenueAccountId, code: "200", name: "Advisory Revenue", type: "REVENUE", class: "REVENUE", status: "ACTIVE" },
    ];
    const driftedAccounts = goodAccounts.map((account) => account.accountId === revenueAccountId
      ? { ...account, type: "ASSET", class: "ASSET" }
      : account);
    listAccounts.mockReset();
    // The outer execution check sees a valid profile. The final complete
    // reference check then sees the same AccountID/code drift to ASSET. NONE
    // remains tax-compatible with assets, proving the semantic gate—not the
    // generic active/code/tax check—is what prevents the write.
    listAccounts
      .mockResolvedValueOnce(goodAccounts)
      .mockResolvedValueOnce(goodAccounts)
      .mockResolvedValue(driftedAccounts);

    await expect(service.executePreparedSalesInvoiceDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ar-coa-permit-edge-drift",
    }, constraints)).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      details: {
        reasonCodes: ["XERO_COA_EXECUTION_ACCOUNT_SEMANTICS_DRIFT"],
        providerMutationPossible: false,
      },
    });

    expect(authorisePermit).toHaveBeenCalledOnce();
    expect(confirmMutation).not.toHaveBeenCalled();
    expect(createDraftSalesInvoice).not.toHaveBeenCalled();
    await expect(repository.getXeroMutationRequest(
      `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`,
    )).resolves.toBeUndefined();
  });
});
