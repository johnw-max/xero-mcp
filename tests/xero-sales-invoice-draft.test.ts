import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { canonicalSalesInvoiceDraftExtractionFingerprint } from "../src/domain/canonical.js";
import {
  createDraftSalesInvoiceSchema,
  type CreateDraftSalesInvoiceInput,
} from "../src/domain/schemas.js";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import type {
  AccountingProvider,
  InvoiceSnapshot,
  SupplierBillSnapshot,
} from "../src/providers/types.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { reviewActionForPosting } from "../src/services/reviewService.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const providerConnectionId = "connection-sales-provider-test";

const noneRevenueTaxRate = {
  taxType: "NONE",
  status: "ACTIVE",
  displayTaxRate: "0.0000",
  effectiveRate: "0.0000",
  canApplyToRevenue: true,
};

const salesInput: CreateDraftSalesInvoiceInput = {
  request_id: "sales-create-20260807-a",
  source_ref: "agent2://material/customer-invoice-a",
  source_sha256: "1".repeat(64),
  source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
  user_confirmation: "CONFIRMED_FOR_DRAFT",
  contact_id: contactId,
  invoice_date: "2026-08-07",
  due_date: "2026-08-21",
  currency: "HKD",
  reference: "AR-20260807-001",
  authoritative_provider_field: "INVOICE_NUMBER",
  line_amount_type: "Exclusive",
  lines: [{
    description: "Accounting advisory services",
    quantity: 1,
    unit_amount: 1200,
    account_code: "200",
    tax_type: "NONE",
  }],
};

const salesInvoice: InvoiceSnapshot = {
  tenantId,
  invoiceId,
  type: "ACCREC",
  status: "DRAFT",
  contact: { contactId, name: "Demo Customer" },
  invoiceDate: "2026-08-07",
  dueDate: "2026-08-21",
  currency: "HKD",
  invoiceNumber: "AR-20260807-001",
  reference: "supplementary-reference",
  lineAmountType: "Exclusive",
  lines: [{
    description: "Accounting advisory services",
    quantity: "1.0000",
    unitAmount: "1200.0000",
    lineAmount: "1200.0000",
    taxAmount: "0.0000",
    accountCode: "200",
    taxType: "NONE",
  }],
  subTotal: "1200.0000",
  totalTax: "0.0000",
  total: "1200.0000",
};

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function providerWithClient(client: unknown): XeroAccountingProvider {
  const connection = {
    connectionId: providerConnectionId,
    tenantId,
    tenantName: "Tenant A",
  };
  const manager = {
    withClient: async <T>(
      _principal: unknown,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
    withWriteClient: async <T>(
      _principal: unknown,
      _authorization: unknown,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

function service(
  repository: InMemoryAccountingRepository,
  provider: AccountingProvider,
  writePolicy: { enabled: boolean; allowedTenantId?: string } = { enabled: true, allowedTenantId: tenantId },
): AccountingService {
  return new AccountingService({
    repository,
    provider,
    config: {
      publicBaseUrl: "https://xero-mcp.example.test",
      xeroWriteEnabled: writePolicy.enabled,
      ...(writePolicy.allowedTenantId ? { xeroAllowedTenantId: writePolicy.allowedTenantId } : {}),
    },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    unsafeAllowDirectMutationForTests: true,
  });
}

describe("controlled ACCREC draft schema", () => {
  it("requires the exact in-conversation draft confirmation literal", () => {
    expect(createDraftSalesInvoiceSchema.safeParse(salesInput).success).toBe(true);
    expect(createDraftSalesInvoiceSchema.safeParse({
      ...salesInput,
      user_confirmation: "yes",
    }).success).toBe(false);
    const { user_confirmation: _omitted, ...withoutConfirmation } = salesInput;
    expect(createDraftSalesInvoiceSchema.safeParse(withoutConfirmation).success).toBe(false);
  });

  it("prepares a customer-facing proposal with an ACCREC-bound server fingerprint and no write", async () => {
    const getSupplierBillDraftReferenceData = vi.fn().mockResolvedValue({
      tenant: { id: tenantId, name: "Tenant A" },
      contacts: [{ contactId, name: "Demo Customer", status: "ACTIVE", isCustomer: true }],
      contactsComplete: true,
      accounts: [{ code: "200", name: "Consulting Revenue", class: "REVENUE", status: "ACTIVE" }],
      taxRates: [{
        taxType: "NONE",
        name: "No Tax",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToRevenue: true,
      }],
    });
    const provider = {
      getSupplierBillDraftReferenceData,
      createDraftSalesInvoice: vi.fn(),
    } as unknown as AccountingProvider;
    const accounting = service(new InMemoryAccountingRepository(), provider);

    const prepared = await accounting.prepareSalesInvoiceDraft("actor-a", {
      source_ref: "agent2://material/customer-invoice-prepared",
      customer_name: "demo customer",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-PREP-001",
      authoritative_provider_field: "INVOICE_NUMBER",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Accounting advisory services",
        quantity: 1,
        unit_amount: 1200,
        account_name: "consulting revenue",
        tax_name: "no tax",
      }],
    });

    expect(prepared).toMatchObject({
      technicallyReady: true,
      requiresUserConfirmation: false,
      executionAllowed: false,
      evidence: { customer: { selected: { contactId } } },
      proposal: {
        request_id: expect.stringMatching(/^xero-accrec-draft:[a-f0-9]{48}$/),
        source_evidence_type: "SERVER_FINGERPRINTED_EXTRACTION",
      },
    });
    expect(prepared).not.toHaveProperty("readyForUserConfirmation");
    expect(prepared.blockers).toEqual([]);
    expect(prepared.evidence).not.toHaveProperty("supplier");
    expect(prepared.proposal).not.toHaveProperty("user_confirmation");
    expect(prepared.proposal?.source_sha256).toBe(hashObject(
      canonicalSalesInvoiceDraftExtractionFingerprint({
        ...prepared.proposal!,
        user_confirmation: "CONFIRMED_FOR_DRAFT",
      }),
    ));
    expect(createDraftSalesInvoiceSchema.safeParse({
      ...prepared.proposal,
      user_confirmation: "CONFIRMED_FOR_DRAFT",
    }).success).toBe(true);
    expect(provider.createDraftSalesInvoice).not.toHaveBeenCalled();
  });

  it("blocks AR preparation when Xero marks the exact tax rate inapplicable to revenue", async () => {
    const provider = {
      getSupplierBillDraftReferenceData: vi.fn().mockResolvedValue({
        tenant: { id: tenantId, name: "Tenant A" },
        contacts: [{ contactId, name: "Demo Customer", status: "ACTIVE", isCustomer: true }],
        contactsComplete: true,
        accounts: [{ code: "200", name: "Consulting Revenue", class: "REVENUE", status: "ACTIVE" }],
        taxRates: [{
          taxType: "OUTPUT",
          name: "Output Tax",
          status: "ACTIVE",
          displayTaxRate: "9.0000",
          effectiveRate: "9.0000",
          canApplyToRevenue: false,
        }],
      }),
      createDraftSalesInvoice: vi.fn(),
    } as unknown as AccountingProvider;

    const prepared = await service(new InMemoryAccountingRepository(), provider).prepareSalesInvoiceDraft("actor-a", {
      source_ref: "agent2://material/customer-invoice-tax-incompatible",
      customer_name: "Demo Customer",
      invoice_date: "2026-08-07",
      due_date: "2026-08-21",
      currency: "HKD",
      reference: "AR-TAX-INCOMPATIBLE",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Accounting advisory services",
        quantity: 1,
        unit_amount: 1200,
        account_name: "Consulting Revenue",
        tax_name: "Output Tax",
      }],
    });

    expect(prepared.proposal).toBeNull();
    expect(prepared.blockers).toContainEqual(expect.objectContaining({
      code: "INELIGIBLE_MATCH",
      path: "lines[0].tax_rate",
    }));
    expect(provider.createDraftSalesInvoice).not.toHaveBeenCalled();
  });
});

describe("Xero ACCREC provider write", () => {
  it("creates ACCREC+DRAFT with an idempotency key and verifies the exact InvoiceID readback", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, hasErrors: false }] },
      response: { headers: { "xero-correlation-id": "xero-create-sales-a" } },
    });
    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [{
          invoiceID: invoiceId,
          type: "ACCREC",
          status: "DRAFT",
          contact: { contactID: contactId, name: "Demo Customer" },
          date: "2026-08-07",
          dueDate: "2026-08-21",
          currencyCode: "HKD",
          invoiceNumber: "AR-20260807-001",
          reference: "supplementary-reference",
          lineAmountTypes: "Exclusive",
          lineItems: [{
            description: "Accounting advisory services",
            quantity: 1,
            unitAmount: 1200,
            lineAmount: 1200,
            taxAmount: 0,
            accountCode: "200",
            taxType: "NONE",
          }],
          subTotal: 1200,
          totalTax: 0,
          total: 1200,
        }],
      },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    const mutationRequestId = "xmr-sales-provider-test";
    const { user_confirmation: _confirmation, ...canonicalPayload } = salesInput;
    const recordWriteEvidence = vi.fn(async () => undefined);
    const result = await provider.createDraftSalesInvoice(
      providerWriteTestContext(providerConnectionId),
      salesInput,
      "zc:create:accrec:test-a",
      recordWriteEvidence,
      issueProviderWriteTestPermit({
        adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
        mutationRequestId,
        canonicalPayload,
        tenantId,
        connectionId: providerConnectionId,
      }),
      mutationRequestId,
    );

    expect(createInvoices).toHaveBeenCalledWith(
      tenantId,
      {
        invoices: [expect.objectContaining({
          type: "ACCREC",
          status: "DRAFT",
          contact: { contactID: contactId },
          invoiceNumber: "AR-20260807-001",
        })],
      },
      true,
      4,
      mutationRequestId,
    );
    expect(recordWriteEvidence).toHaveBeenCalledOnce();
    expect(getInvoices).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      invoice: { invoiceId, tenantId, type: "ACCREC", status: "DRAFT" },
      receipt: { operation: "CREATE_ACCREC_DRAFT", invoiceId, status: "DRAFT" },
    });
  });
});

describe("controlled ACCREC service write", () => {
  it("stops AR creation at the global write gate before validation or provider write", async () => {
    const listAccounts = vi.fn();
    const createDraftSalesInvoice = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts,
      listTaxRates: vi.fn(),
      getContact: vi.fn(),
      createDraftSalesInvoice,
    } as unknown as AccountingProvider;

    await expect(service(
      new InMemoryAccountingRepository(),
      provider,
      { enabled: false, allowedTenantId: tenantId },
    ).createDraftSalesInvoice("actor-a", salesInput)).rejects.toMatchObject({ code: "WRITE_GATE_DISABLED" });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(createDraftSalesInvoice).not.toHaveBeenCalled();
  });

  it("stops AR creation for a non-allowlisted legacy tenant before validation or provider write", async () => {
    const listAccounts = vi.fn();
    const createDraftSalesInvoice = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({
        actorId: "actor-a",
        tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        tenantName: "Tenant B",
      }),
      listAccounts,
      listTaxRates: vi.fn(),
      getContact: vi.fn(),
      createDraftSalesInvoice,
    } as unknown as AccountingProvider;

    await expect(service(
      new InMemoryAccountingRepository(),
      provider,
      { enabled: true, allowedTenantId: tenantId },
    ).createDraftSalesInvoice("actor-a", salesInput)).rejects.toMatchObject({ code: "STANDING_DELEGATION_REQUIRED" });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(createDraftSalesInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["EXPENSE", "canApplyToExpenses"],
    ["ASSET", "canApplyToAssets"],
    ["LIABILITY", "canApplyToLiabilities"],
    ["REVENUE", "canApplyToRevenue"],
    ["EQUITY", "canApplyToEquity"],
  ] as const)("rejects direct AR creation when the tax rate cannot apply to a %s account", async (accountClass, flag) => {
    const createDraftSalesInvoice = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: accountClass, status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        [flag]: false,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSalesInvoice,
    } as unknown as AccountingProvider;

    await expect(service(new InMemoryAccountingRepository(), provider).createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(createDraftSalesInvoice).not.toHaveBeenCalled();
  });

  it("binds operation kind, tenant, idempotency, exact readback, and never returns the AP authorise URL", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSalesInvoice = vi.fn().mockResolvedValue({
      invoice: salesInvoice,
      receipt: { operation: "CREATE_ACCREC_DRAFT", invoiceId },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: "REVENUE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([noneRevenueTaxRate]),
      getContact: vi.fn().mockResolvedValue({ contactId, name: "Demo Customer", status: "ACTIVE" }),
      createDraftSalesInvoice,
      getInvoice: vi.fn().mockResolvedValue(salesInvoice),
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider);

    const first = await accounting.createDraftSalesInvoice("actor-a", salesInput);
    const replay = await accounting.createDraftSalesInvoice("actor-a", salesInput);

    expect(first).toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      verifiedPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      invoice: { type: "ACCREC", tenantId },
      idempotentReplay: false,
    });
    expect(first).not.toHaveProperty("reviewUrl");
    expect(first).not.toHaveProperty("bill");
    expect(first).not.toHaveProperty("approvedPayloadHash");
    expect(replay).toMatchObject({ invoiceId, idempotentReplay: true });
    expect(createDraftSalesInvoice).toHaveBeenCalledOnce();
    expect(createDraftSalesInvoice.mock.calls[0]?.[2]).toMatch(/^zc:create:ACCREC:/);

    const posting = await repository.getPosting(first.postingRequestId);
    expect(posting).toMatchObject({
      documentType: "ACCREC",
      state: "DRAFT_READBACK_VERIFIED",
      tenantId,
      providerPayload: { invoiceId, type: "ACCREC", status: "DRAFT" },
      readbackSnapshot: { invoiceId, type: "ACCREC", status: "DRAFT" },
    });
    expect(reviewActionForPosting(posting!, "actor-a")).toBe("NONE");
    await expect(accounting.authoriseSupplierBill("actor-a", {
      posting_request_id: first.postingRequestId,
      invoice_id: invoiceId,
      expected_status: "DRAFT",
      approval_ref: "a".repeat(32),
      approved_payload_hash: first.verifiedPayloadHash,
      request_id: "must-not-authorise-accrec",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((provider as unknown as { authoriseSupplierBill?: ReturnType<typeof vi.fn> }).authoriseSupplierBill)
      .toBeUndefined();
  });

  it("rejects an ACCREC readback from a different tenant before durable success", async () => {
    const repository = new InMemoryAccountingRepository();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: "REVENUE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([noneRevenueTaxRate]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSalesInvoice: vi.fn().mockResolvedValue({
        invoice: { ...salesInvoice, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        receipt: { operation: "CREATE_ACCREC_DRAFT", invoiceId },
      }),
    } as unknown as AccountingProvider;

    await expect(service(repository, provider).createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "READBACK_MISMATCH" });
  });

  it.each([
    ["type", () => ({ ...salesInvoice, type: "ACCPAY" as const })],
    ["status", () => ({ ...salesInvoice, status: "AUTHORISED" as const })],
    ["contact", () => ({ ...salesInvoice, contact: { ...salesInvoice.contact, contactId: "33333333-3333-4333-8333-333333333333" } })],
    ["invoice date", () => ({ ...salesInvoice, invoiceDate: "2026-08-08" })],
    ["due date", () => ({ ...salesInvoice, dueDate: "2026-08-22" })],
    ["currency", () => ({ ...salesInvoice, currency: "USD" })],
    ["formal number", () => ({ ...salesInvoice, invoiceNumber: "AR-DIFFERENT" })],
    ["line description", () => ({
      ...salesInvoice,
      lines: [{ ...salesInvoice.lines[0]!, description: "Different service" }],
    })],
    ["line account", () => ({
      ...salesInvoice,
      lines: [{ ...salesInvoice.lines[0]!, accountCode: "201" }],
    })],
    ["line tax", () => ({
      ...salesInvoice,
      lines: [{ ...salesInvoice.lines[0]!, taxType: "OUTPUT" }],
    })],
    ["totals", () => ({ ...salesInvoice, total: "1199.0000" })],
  ])("rejects an AR readback whose %s differs from the confirmed draft", async (_field, mutate) => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSalesInvoice = vi.fn().mockResolvedValue({
      invoice: mutate(),
      receipt: { operation: "CREATE_ACCREC_DRAFT", invoiceId },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: "REVENUE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([noneRevenueTaxRate]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSalesInvoice,
    } as unknown as AccountingProvider;

    await expect(service(repository, provider).createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    expect(createDraftSalesInvoice).toHaveBeenCalledTimes(1);
  });

  it("keeps the duplicate guard after an ambiguous generic AR provider error and blocks every new request key", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSalesInvoice = vi.fn().mockRejectedValue(new AppError(
      "PROVIDER_ERROR",
      "Generic upstream 429 without structured Xero validation evidence.",
      { httpStatus: 502, retryable: true },
    ));
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: "REVENUE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([noneRevenueTaxRate]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSalesInvoice,
      getInvoice: vi.fn(),
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider);

    await expect(accounting.createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
    await expect(accounting.createDraftSalesInvoice("actor-a", {
      ...salesInput,
      request_id: "sales-create-20260807-new-key",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateState: "WRITE_RESULT_UNKNOWN" },
    });
    await expect(accounting.createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(createDraftSalesInvoice).toHaveBeenCalledTimes(1);
    expect(provider.getInvoice).not.toHaveBeenCalled();
  });

  it("recovers a known AR InvoiceID by readback only when the original request is replayed", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSalesInvoice = vi.fn().mockRejectedValue(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "Xero created the draft but immediate readback timed out.",
      { httpStatus: 502, retryable: false, details: { invoiceId } },
    ));
    const getInvoice = vi.fn().mockResolvedValue(salesInvoice);
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-a", tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "200", class: "REVENUE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([noneRevenueTaxRate]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSalesInvoice,
      getInvoice,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider);

    await expect(accounting.createDraftSalesInvoice("actor-a", salesInput))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", details: { invoiceId } });

    const recovered = await accounting.createDraftSalesInvoice("actor-a", salesInput);

    expect(recovered).toMatchObject({
      invoiceId,
      status: "DRAFT",
      readbackVerified: true,
      idempotentReplay: true,
    });
    expect(createDraftSalesInvoice).toHaveBeenCalledTimes(1);
    expect(getInvoice).toHaveBeenCalledWith("actor-a", invoiceId, "ACCREC");
  });

  it("does not collide ACCREC and ACCPAY duplicate identities in one tenant", async () => {
    const repository = new InMemoryAccountingRepository();
    const common = {
      postingRequestId: "pr_ap_abcdefghijklmnop",
      actorId: "actor-a",
      tenantId,
      sourceRef: salesInput.source_ref,
      sourceSha256: salesInput.source_sha256,
      sourceEvidenceType: salesInput.source_evidence_type,
      providerPayload: {
        invoiceType: "ACCPAY",
        contactId,
        reference: salesInput.reference,
      },
      requestPayloadHash: "a".repeat(64),
      providerPayloadHash: "a".repeat(64),
      requestId: "ap-request-a",
      createIdempotencyKey: "zc:create:ACCPAY:a",
      documentType: "ACCPAY" as const,
    };
    await repository.createOrGetPosting(common);

    const ar = await repository.createOrGetPosting({
      ...common,
      postingRequestId: "pr_ar_abcdefghijklmnop",
      sourceSha256: "b".repeat(64),
      requestId: "ar-request-a",
      createIdempotencyKey: "zc:create:ACCREC:a",
      documentType: "ACCREC",
      providerPayload: { ...common.providerPayload, invoiceType: "ACCREC" },
    });

    expect(ar.created).toBe(true);
    expect(ar.posting.documentType).toBe("ACCREC");
  });

  it("keeps one source document globally unique across AP and AR interpretations", async () => {
    const repository = new InMemoryAccountingRepository();
    const base = {
      postingRequestId: "pr_source_ap_abcdefghijk",
      actorId: "actor-a",
      tenantId,
      sourceRef: salesInput.source_ref,
      sourceSha256: salesInput.source_sha256,
      sourceEvidenceType: salesInput.source_evidence_type,
      providerPayload: { invoiceType: "ACCPAY", contactId, reference: "AP-ONE" },
      requestPayloadHash: "a".repeat(64),
      providerPayloadHash: "a".repeat(64),
      requestId: "ap-source-request-a",
      createIdempotencyKey: "zc:create:ACCPAY:source-a",
      documentType: "ACCPAY" as const,
    };
    await repository.createOrGetPosting(base);

    const duplicate = await repository.createOrGetPosting({
      ...base,
      postingRequestId: "pr_source_ar_abcdefghijk",
      requestId: "ar-source-request-a",
      documentType: "ACCREC",
      providerPayload: { invoiceType: "ACCREC", contactId, reference: "AR-TWO" },
      createIdempotencyKey: "zc:create:ACCREC:source-a",
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.posting.documentType).toBe("ACCPAY");
  });
});

describe("sales invoice legacy MCP isolation", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(closeables.splice(0).map((closeable) => closeable.close())));

  it("does not expose object-level sales preparation or creation to the Agent", async () => {
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const accounting = {
      withAudit,
    } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-a",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read", "xero.draft.write"],
    });
    const server = createAccountingMcpServer(accounting, context);
    const client = new Client({ name: "sales-invoice-contract", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("xero_prepare_sales_invoice_draft");
    expect(tools.tools.map((tool) => tool.name)).not.toContain("xero_create_draft_sales_invoice");
    expect(tools.tools.map((tool) => tool.name)).toContain("xero_execute_accounting_case");
    expect(withAudit).not.toHaveBeenCalled();
  });
});
