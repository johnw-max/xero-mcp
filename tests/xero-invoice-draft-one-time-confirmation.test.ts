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

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const salesInvoiceId = "44444444-4444-4444-8444-444444444444";

function harness() {
  const repository = new InMemoryAccountingRepository();
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
  const context = createOAuthRequestContext({
    issuer: "https://xero-mcp.example.test",
    resolvedToken,
  });
  vi.spyOn(repository, "resolveAgentConnectionBinding").mockResolvedValue({
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
    reference: "AP-ONE-TIME-001",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Synthetic subscription",
      quantity: "1.0000",
      unitAmount: "43.2100",
      lineAmount: "43.2100",
      taxAmount: "0.0000",
      accountCode: "485",
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
    reference: "AR-ONE-TIME-001",
    lines: [{
      ...bill.lines[0]!,
      description: "Synthetic advisory",
      unitAmount: "88.0000",
      lineAmount: "88.0000",
      accountCode: "200",
    }],
    subTotal: "88.0000",
    totalTax: "0.0000",
    total: "88.0000",
  };
  const createDraftSalesInvoice = vi.fn(async (
    _principal: unknown,
    _input: unknown,
    _idempotencyKey: string,
    recordWriteEvidence?: (evidence: { invoiceId: string; receipt: Record<string, unknown> }) => Promise<void>,
  ) => {
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
  const provider = {
    getSupplierBillDraftReferenceData: vi.fn(async () => ({
      tenant: { id: tenantId, name: "Demo Organisation" },
      contacts: [{ contactId, name: "Demo Supplier", status: "ACTIVE", isSupplier: true }],
      contactsComplete: true,
      accounts: [
        { code: "485", name: "Subscriptions", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
        { code: "200", name: "Advisory Revenue", type: "REVENUE", class: "REVENUE", status: "ACTIVE" },
      ],
      taxRates: [{
        taxType: "NONE",
        name: "No Tax",
        status: "ACTIVE",
        canApplyToExpenses: true,
        canApplyToRevenue: true,
      }],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId, tenantName: "Demo Organisation" })),
    listAccounts: vi.fn(async () => [
      { code: "485", name: "Subscriptions", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
      { code: "200", name: "Advisory Revenue", type: "REVENUE", class: "REVENUE", status: "ACTIVE" },
    ]),
    listTaxRates: vi.fn(async () => [
      {
        taxType: "NONE",
        name: "No Tax",
        status: "ACTIVE",
        canApplyToExpenses: true,
        canApplyToRevenue: true,
      },
    ]),
    getContact,
    getSupplierBill,
    createDraftSupplierBill,
    createDraftSalesInvoice,
  } as unknown as AccountingProvider;
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "invoice-confirmation-secret-that-is-at-least-32-bytes",
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
  return {
    repository,
    context,
    service,
    createDraftSupplierBill,
    createDraftSalesInvoice,
    getContact,
    getSupplierBill,
  };
}

describe("Supplier Bill one-time preparation confirmation", () => {
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
      confirmation_phrase: expect.stringContaining("确认创建 Supplier Bill DRAFT"),
      expires_at: expect.any(String),
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");

    await expect(service.executePreparedSupplierBillDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-confirm-001",
      confirmation_phrase: `${prepared.confirmation_phrase}-wrong`,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(createDraftSupplierBill).not.toHaveBeenCalled();

    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    };
    const created = await service.executePreparedSupplierBillDraft(context, command);
    expect(created).toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      mutationRequestId: expect.stringMatching(/^xmr_[a-f0-9]{32}$/),
    });
    await expect(service.executePreparedSupplierBillDraft(context, command)).resolves.toMatchObject({
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

  it("permanently consumes a confirmation after validation failure and never writes on replay", async () => {
    const { context, service, createDraftSupplierBill, getContact } = harness();
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-validation-terminal-001",
      source_sha256: "c".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-VALIDATION-TERMINAL-001",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-validation-terminal-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    };

    getContact.mockResolvedValueOnce(undefined);
    await expect(service.executePreparedSupplierBillDraft(context, command)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(createDraftSupplierBill).not.toHaveBeenCalled();

    getContact.mockResolvedValue({ contactId, name: "Demo Supplier", status: "ACTIVE" });
    await expect(service.executePreparedSupplierBillDraft(context, command)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
  });

  it("claims the generic mutation before the legacy Provider create", async () => {
    const { repository, context, service, createDraftSupplierBill } = harness();
    const beginWrite = vi.spyOn(repository, "beginXeroMutationWrite");
    const prepared = await service.prepareSupplierBillDraft(context, {
      source_ref: "work-material:ap-generic-claim-order-001",
      source_sha256: "e".repeat(64),
      supplier_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AP-ONE-TIME-001",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");

    await service.executePreparedSupplierBillDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ap-generic-claim-order-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    });

    expect(beginWrite).toHaveBeenCalledOnce();
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
    expect(beginWrite.mock.invocationCallOrder[0]).toBeLessThan(
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
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-provider-rejected-terminal-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    };
    createDraftSupplierBill.mockRejectedValueOnce(new AppError(
      "PROVIDER_ERROR",
      "Xero definitely rejected the draft.",
      { httpStatus: 422, details: { writeOutcome: "DEFINITELY_REJECTED" } },
    ));

    await expect(service.executePreparedSupplierBillDraft(context, command)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparation_id }).slice(0, 32)}`;
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: {
        reasonCode: "PROVIDER_ERROR",
      },
    });

    await expect(service.executePreparedSupplierBillDraft(context, command)).rejects.toMatchObject({
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
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-one-time-concurrent-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    };

    const [first, second] = await Promise.all([
      service.executePreparedSupplierBillDraft(context, command),
      service.executePreparedSupplierBillDraft(context, command),
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
      line_amount_type: "Exclusive",
      lines: [{
        description: "Synthetic subscription",
        quantity: 1,
        unit_amount: 43.21,
        account_code: "485",
        tax_type: "NONE",
      }],
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");
    const command = {
      preparation_id: prepared.preparation_id,
      request_id: "ap-recover-generic-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
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

    await expect(service.executePreparedSupplierBillDraft(context, command)).rejects.toMatchObject({
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
});

describe("Sales Invoice one-time preparation confirmation", () => {
  it("creates ACCREC only from the server-persisted confirmed proposal", async () => {
    const { repository, context, service, createDraftSalesInvoice } = harness();
    const beginWrite = vi.spyOn(repository, "beginXeroMutationWrite");
    const prepared = await service.prepareSalesInvoiceDraft(context, {
      source_ref: "work-material:ar-one-time-001",
      source_sha256: "b".repeat(64),
      customer_name: "Demo Supplier",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-ONE-TIME-001",
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
      confirmation_phrase: expect.stringContaining("确认创建 Sales Invoice DRAFT"),
    });
    if (!prepared.preparation_id || !prepared.confirmation_phrase) throw new Error("preparation missing");

    const created = await service.executePreparedSalesInvoiceDraft(context, {
      preparation_id: prepared.preparation_id,
      request_id: "ar-one-time-confirm-001",
      confirmation_phrase: prepared.confirmation_phrase,
    });
    expect(created).toMatchObject({
      invoiceId: salesInvoiceId,
      status: "DRAFT",
      readbackVerified: true,
      mutationRequestId: expect.stringMatching(/^xmr_[a-f0-9]{32}$/),
    });
    expect(beginWrite).toHaveBeenCalledOnce();
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
    expect(beginWrite.mock.invocationCallOrder[0]).toBeLessThan(
      createDraftSalesInvoice.mock.invocationCallOrder[0]!,
    );
    await expect(repository.getXeroMutationRequest(created.mutationRequestId)).resolves.toMatchObject({
      objectType: "SALES_INVOICE",
      state: "READBACK_VERIFIED",
      xeroObjectId: salesInvoiceId,
      readbackStatus: "DRAFT",
    });
  });
});
