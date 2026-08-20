import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../src/db/repository.js";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
} from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import {
  prepareContactCreate,
  prepareContactUpdate,
  prepareItemCreate,
  prepareItemUpdate,
} from "../src/domain/xeroContactItemPrimitives.js";
import {
  buildPurchaseOrderDraftPrimitive,
  buildQuoteDraftPrimitive,
} from "../src/domain/xeroQuotePurchaseOrderDraft.js";
import {
  canonicalBankTransactionCreatePayload,
  canonicalBankTransactionReversePayload,
  canonicalBankTransactionUpdatePayload,
  canonicalPaymentCreatePayload,
  canonicalPaymentReversePayload,
} from "../src/domain/xeroPaymentBankTransaction.js";
import {
  canonicalTrackingCategoryCreatePayload,
  canonicalTrackingCategoryUpdatePayload,
  canonicalTrackingOptionCreatePayload,
  canonicalTrackingOptionUpdatePayload,
} from "../src/domain/xeroTrackingCanonical.js";
import { XeroContactItemMutationProvider } from "../src/providers/xeroContactItemMutationProvider.js";
import { XeroControlledMutationProvider } from "../src/providers/xeroControlledMutationProvider.js";
import { XeroCreditNoteManualJournalProvider } from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import { XeroControlledLedgerTransitionProvider } from "../src/providers/xeroControlledLedgerTransitionProvider.js";
import { XeroLedgerAdjustmentProvider } from "../src/providers/xeroLedgerAdjustmentProvider.js";
import { XeroPaymentBankTransactionProvider } from "../src/providers/xeroPaymentBankTransactionProvider.js";
import { XeroTrackingMutationProvider } from "../src/providers/xeroTrackingMutationProvider.js";
import {
  XeroClientManager,
  type XeroProviderWriteAuthorization,
} from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import type { AccountingPrincipal } from "../src/providers/types.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from "../src/security/xeroProviderWritePermitContext.js";
import { XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS } from "../src/security/xeroProviderWritePermit.js";
import type { LedgerProviderWritePermit } from "../src/control-kernel/ledgerProviderWritePermit.js";
import type { XeroProviderWriteAdapterOperation } from "../src/security/xeroProviderWritePermit.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const tenantId = "tenant-provider-boundary";
const connectionId = "connection-provider-boundary";
const canonicalPayload = Object.freeze({ objectType: "QUOTE", reference: "Q-001" });
const mutationRequestId = "xmr-provider-boundary";
const adapterOperation = "XeroControlledMutationProvider.createQuoteDraft" as const;
const actionId = "quote.create_draft" as const;
const requiredXeroScopes = [
  "offline_access",
  "accounting.settings.read",
  "accounting.settings",
  "accounting.contacts.read",
  "accounting.contacts",
  "accounting.invoices.read",
  "accounting.invoices",
  "accounting.payments.read",
  "accounting.payments",
  "accounting.manualjournals.read",
  "accounting.manualjournals",
  "accounting.banktransactions.read",
  "accounting.banktransactions",
  "accounting.reports.read",
  "accounting.journals.read",
  "accounting.reports.trialbalance.read",
] as const;

type WriterContract = Readonly<{
  name: string;
  adapterOperation: XeroProviderWriteAdapterOperation;
  mutationRequestId: string;
  canonicalPayload: unknown;
  sdkMutation: ReturnType<typeof vi.fn>;
  sdkExposesIdempotencyKey?: boolean;
  invoke: (
    principal: AccountingPrincipal,
    permit: LedgerProviderWritePermit | undefined,
    tamperPayload?: boolean,
  ) => Promise<unknown>;
}>;

async function realManagerBoundary() {
  const repository = new InMemoryAccountingRepository();
  const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 17));
  const principal = Object.freeze({
    ...providerWriteTestContext(connectionId),
    bindingRevision: 1,
    targetSessionExpiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  });
  const now = new Date();
  const tokenJson = JSON.stringify({
    access_token: "real-boundary-access",
    refresh_token: "real-boundary-refresh",
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    scope: requiredXeroScopes.join(" "),
  });
  await repository.saveProviderAuthorization({
    authorizationId: "authorization-provider-test",
    workspaceId: principal.workspaceId,
    authorizedBySubject: principal.subjectId,
    provider: "xero",
    providerSubject: "xero-user-provider-test",
    grantedScopes: [...requiredXeroScopes],
    tokenCiphertext: cipher.encrypt(tokenJson, "authorization-provider-test"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.upsertAuthorizedProviderConnection(principal.workspaceId, {
    connectionId,
    authorizationId: "authorization-provider-test",
    provider: "xero",
    providerConnectionId: "xero-connection-provider-test",
    tenantId,
    tenantName: "Provider Boundary Tenant",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveOAuthInstallation({
    installationId: principal.oauthInstallationId,
    workspaceId: principal.workspaceId,
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    agentId: principal.agentId,
    clientId: "provider-boundary-client",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: principal.bindingId,
    installationId: principal.oauthInstallationId,
    workspaceId: principal.workspaceId,
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    agentId: principal.agentId,
    connectionId,
    policyId: "provider-boundary-policy",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveLedgerTargetSession({
    sessionId: principal.targetSessionId,
    sessionHash: principal.targetSessionHash,
    installationId: principal.oauthInstallationId,
    bindingId: principal.bindingId,
    connectionId,
    bindingRevision: principal.bindingRevision,
    createdAt: now,
    expiresAt: principal.targetSessionExpiresAt,
  });

  const initialize = vi.fn().mockResolvedValue(undefined);
  const refreshToken = vi.fn();
  const createQuotes = vi.fn().mockResolvedValue({
    body: { quotes: [{ quoteID: "55555555-5555-4555-8555-555555555555" }] },
    response: { headers: { "xero-correlation-id": "provider-boundary-request" } },
  });
  const getItem = vi.fn().mockResolvedValue({ body: { items: [] } });
  const client = {
    initialize,
    setTokenSet: vi.fn(),
    refreshToken,
    readTokenSet: vi.fn(() => ({ access_token: "real-boundary-access" })),
    accountingApi: { createQuotes, getItem },
  };
  const manager = new XeroClientManager({
    repository,
    cipher,
    config: {
      clientId: "xero-client",
      clientSecret: "xero-secret",
      redirectUri: "https://example.test/oauth/xero/callback",
      scopes: [...requiredXeroScopes],
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    legacyWriteEnabled: false,
  });
  const createClient = vi.spyOn(manager, "createOAuthClient").mockReturnValue(client as never);
  const decrypt = vi.spyOn(cipher, "decrypt");
  const updateToken = vi.spyOn(repository, "updateProviderAuthorizationToken");
  const markTokenFailed = vi.spyOn(repository, "markProviderAuthorizationStatus");
  const provider = new XeroControlledMutationProvider(manager);
  const payload = buildQuoteDraftPrimitive({
    source_ref: "work://real-manager-boundary",
    source_unit_key: "real-manager-boundary:1",
    source_sha256: "6".repeat(64),
    contact_id: "11111111-1111-4111-8111-111111111111",
    quote_date: "2026-08-13",
    expiry_date: "2026-08-31",
    currency: "SGD",
    reference: "Q-REAL-BOUNDARY",
    line_amount_type: "Exclusive",
    lines: [{ description: "Boundary line", quantity: 1, unit_amount: 10, account_code: "200", tax_type: "NONE" }],
  }).canonicalPayload;
  return {
    repository,
    cipher,
    principal,
    manager,
    provider,
    payload,
    createClient,
    initialize,
    refreshToken,
    createQuotes,
    getItem,
    decrypt,
    updateToken,
    markTokenFailed,
  };
}

function typescriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptSources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function rawWriterContracts(actualConnection: Readonly<{ tenantId: string; connectionId: string }>): WriterContract[] {
  const contactId = "11111111-1111-4111-8111-111111111111";
  const itemId = "22222222-2222-4222-8222-222222222222";
  const accountId = "33333333-3333-4333-8333-333333333333";
  const supplierBillUpdateId = "55555555-5555-4555-8555-555555555555";
  const salesInvoiceUpdateId = "77777777-7777-4777-8777-777777777777";
  const quoteUpdateId = "88888888-8888-4888-8888-888888888888";
  const purchaseOrderUpdateId = "99999999-9999-4999-8999-999999999999";
  const creditNoteUpdateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const manualJournalUpdateId = "66666666-6666-4666-8666-666666666666";
  const voidSalesInvoiceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const voidSupplierBillId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const adjustmentCreditNoteId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const allocationCreditNoteId = "14141414-1414-4141-8141-141414141414";
  const allocationInvoiceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const refundCreditNoteId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const voidCreditNoteId = "15151515-1515-4151-8151-151515151515";
  const voidManualJournalId = "16161616-1616-4161-8161-161616161616";
  const paymentId = "12121212-1212-4121-8121-121212121212";
  const bankTransactionId = "13131313-1313-4131-8131-131313131313";
  const expectedUpdatedAt = "2026-08-13T00:00:00.000Z";
  const makeSdkMutation = () => vi.fn(async () => {
    const error = new Error("SDK mutation reached") as Error & { code: string };
    error.code = "ETIMEDOUT";
    throw error;
  });
  const sdk = {
    createInvoices: makeSdkMutation(),
    createQuotes: makeSdkMutation(),
    createPurchaseOrders: makeSdkMutation(),
    createCreditNotes: makeSdkMutation(),
    createManualJournals: makeSdkMutation(),
    createContacts: makeSdkMutation(),
    updateContact: makeSdkMutation(),
    createItems: makeSdkMutation(),
    updateItem: makeSdkMutation(),
    updateInvoice: makeSdkMutation(),
    updateQuote: makeSdkMutation(),
    updatePurchaseOrder: makeSdkMutation(),
    updateCreditNote: makeSdkMutation(),
    updateManualJournal: makeSdkMutation(),
    createTrackingCategory: makeSdkMutation(),
    updateTrackingCategory: makeSdkMutation(),
    createTrackingOptions: makeSdkMutation(),
    updateTrackingOptions: makeSdkMutation(),
    createCreditNoteAllocation: makeSdkMutation(),
    deleteCreditNoteAllocations: makeSdkMutation(),
    createPayment: makeSdkMutation(),
    deletePayment: makeSdkMutation(),
    createBankTransactions: makeSdkMutation(),
    updateBankTransaction: makeSdkMutation(),
    getInvoices: vi.fn(async (
      _tenantId: string,
      _ifModifiedSince: unknown,
      _where: unknown,
      _order: unknown,
      ids: string[] | undefined,
    ) => ({
      body: {
        invoices: [{
          invoiceID: ids?.[0],
          type: ids?.[0] === supplierBillUpdateId || ids?.[0] === voidSupplierBillId ? "ACCPAY" : "ACCREC",
          status: [voidSalesInvoiceId, voidSupplierBillId, allocationInvoiceId].includes(ids?.[0] ?? "")
            ? "AUTHORISED"
            : "DRAFT",
          contact: { contactID: contactId, name: "Boundary Contact" },
          invoiceNumber: "INV-BOUNDARY",
          reference: "INV-BOUNDARY",
          date: "2026-08-13",
          dueDate: "2026-08-31",
          currencyCode: "SGD",
          lineAmountTypes: "Exclusive",
          subTotal: 10,
          totalTax: 0,
          total: 10,
          amountDue: 10,
          amountPaid: 0,
          amountCredited: 0,
          payments: [],
          creditNotes: [],
          prepayments: [],
          overpayments: [],
          updatedDateUTCString: expectedUpdatedAt,
          lineItems: [{
            description: "Boundary line",
            quantity: 1,
            unitAmount: 10,
            lineAmount: 10,
            taxAmount: 0,
            accountCode: "200",
            taxType: "NONE",
          }],
        }],
      },
    })),
    getQuote: vi.fn(async (_tenantId: string, id: string) => ({
      body: { quotes: [{ quoteID: id, status: "DRAFT", updatedDateUTC: expectedUpdatedAt }] },
    })),
    getPurchaseOrder: vi.fn(async (_tenantId: string, id: string) => ({
      body: { purchaseOrders: [{ purchaseOrderID: id, status: "DRAFT", updatedDateUTC: expectedUpdatedAt }] },
    })),
    getCreditNote: vi.fn(async (_tenantId: string, id: string) => ({
      body: { creditNotes: [{
        creditNoteID: id,
        type: "ACCRECCREDIT",
        status: [allocationCreditNoteId, refundCreditNoteId, voidCreditNoteId].includes(id)
          ? "AUTHORISED"
          : "DRAFT",
        contact: { contactID: contactId },
        currencyCode: "SGD",
        remainingCredit: 10,
        appliedAmount: 0,
        allocations: id === allocationCreditNoteId ? [{
          allocationID: allocationInvoiceId,
          invoice: { invoiceID: allocationInvoiceId },
          amount: 1,
          date: "2026-08-13",
        }] : [],
        payments: [],
        updatedDateUTC: new Date(expectedUpdatedAt),
      }] },
    })),
    getManualJournal: vi.fn(async (_tenantId: string, id: string) => ({
      body: { manualJournals: [{
        manualJournalID: id,
        narration: "Boundary journal",
        status: id === manualJournalUpdateId ? "DRAFT" : "POSTED",
        updatedDateUTC: new Date(expectedUpdatedAt),
      }] },
    })),
    getTrackingCategories: vi.fn(async () => ({
      body: {
        trackingCategories: [{
          trackingCategoryID: accountId,
          name: "Boundary Tracking",
          status: "ACTIVE",
          options: [{
            trackingOptionID: itemId,
            name: "Boundary Option",
            status: "ACTIVE",
            trackingCategoryID: accountId,
          }],
        }],
      },
    })),
    getTrackingCategory: vi.fn(async (_tenantId: string, id: string) => ({
      body: {
        trackingCategories: [{
          trackingCategoryID: id,
          name: "Boundary Tracking",
          status: "ACTIVE",
          options: [{
            trackingOptionID: itemId,
            name: "Boundary Option",
            status: "ACTIVE",
            trackingCategoryID: id,
          }],
        }],
      },
    })),
    getPayment: vi.fn(async (_tenantId: string, id: string) => ({
      body: {
        payments: [{
          paymentID: id,
          status: "AUTHORISED",
          paymentType: "ACCRECPAYMENT",
          invoice: { invoiceID: allocationInvoiceId },
          account: { accountID: accountId },
          date: "2026-08-13",
          amount: 10,
        }],
      },
    })),
    getBankTransaction: vi.fn(async (_tenantId: string, id: string) => ({
      body: {
        bankTransactions: [{
          bankTransactionID: id,
          type: "SPEND",
          status: "AUTHORISED",
          isReconciled: false,
          updatedDateUTC: new Date(expectedUpdatedAt),
        }],
      },
    })),
    getContact: vi.fn(async (_tenantId: string, id: string) => ({
      body: { contacts: [{ contactID: id, contactStatus: "ACTIVE" }] },
    })),
    getAccounts: vi.fn(async () => ({
      body: {
        accounts: [
          { accountID: accountId, code: "090", type: "BANK", status: "ACTIVE", enablePaymentsToAccount: true },
          { accountID: itemId, code: "400", type: "EXPENSE", status: "ACTIVE" },
        ],
      },
    })),
    getTaxRates: vi.fn(async () => ({
      body: { taxRates: [{ taxType: "NONE", status: "ACTIVE" }, { taxType: "INPUT", status: "ACTIVE" }] },
    })),
  };
  const connection = {
    provider: "xero" as const,
    tenantName: "Boundary Tenant",
    status: "ACTIVE" as const,
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
    updatedAt: new Date("2026-08-13T00:00:00.000Z"),
    ...actualConnection,
  };
  const manager = {
    withClient: async <T>(
      _principal: AccountingPrincipal,
      callback: (client: unknown, connection: unknown) => Promise<T>,
    ): Promise<T> => callback({ accountingApi: sdk }, connection),
    withWriteClient: async <T>(
      principal: AccountingPrincipal,
      authorization: XeroProviderWriteAuthorization,
      callback: (client: unknown, connection: unknown) => Promise<T>,
    ): Promise<T> => {
      consumeXeroProviderWritePermitAtMutationBoundary({
        ...authorization,
        principal,
        connection,
      });
      return callback({ accountingApi: sdk }, connection);
    },
  } as unknown as XeroClientManager;
  const invoiceProvider = new XeroAccountingProvider({} as AccountingRepository, manager);
  const controlledProvider = new XeroControlledMutationProvider(manager);
  const adjustmentProvider = new XeroCreditNoteManualJournalProvider(manager);
  const contactItemProvider = new XeroContactItemMutationProvider(manager, { contactNamespace: "zcboundary" });
  const transitionProvider = new XeroControlledLedgerTransitionProvider(manager);
  const trackingProvider = new XeroTrackingMutationProvider(manager);
  const ledgerAdjustmentProvider = new XeroLedgerAdjustmentProvider(manager);
  const paymentBankProvider = new XeroPaymentBankTransactionProvider(manager);

  const invoiceInput = {
    request_id: "invoice-boundary",
    source_ref: "work://invoice-boundary",
    source_sha256: "1".repeat(64),
    source_evidence_type: "AGENT_ASSERTED_UNVERIFIED" as const,
    user_confirmation: "CONFIRMED_FOR_DRAFT" as const,
    contact_id: contactId,
    invoice_date: "2026-08-13",
    due_date: "2026-08-31",
    currency: "SGD",
    reference: "INV-BOUNDARY",
    authoritative_provider_field: "INVOICE_NUMBER" as const,
    line_amount_type: "Exclusive" as const,
    lines: [{
      description: "Boundary line",
      quantity: 1,
      unit_amount: 10,
      account_code: "200",
      tax_type: "NONE",
    }],
  };
  const { user_confirmation: _confirmation, ...invoiceCanonical } = invoiceInput;
  const invoiceUpdateReplacement = { ...invoiceCanonical, status: "DRAFT" as const };
  const quote = buildQuoteDraftPrimitive({
    source_ref: "work://quote-boundary",
    source_unit_key: "quote-boundary:1",
    source_sha256: "2".repeat(64),
    contact_id: contactId,
    quote_date: "2026-08-13",
    expiry_date: "2026-08-31",
    currency: "SGD",
    reference: "Q-BOUNDARY",
    line_amount_type: "Exclusive",
    lines: [{ description: "Quote line", quantity: 1, unit_amount: 10, account_code: "200", tax_type: "NONE" }],
  }).canonicalPayload;
  const purchaseOrder = buildPurchaseOrderDraftPrimitive({
    source_ref: "work://po-boundary",
    source_unit_key: "po-boundary:1",
    source_sha256: "3".repeat(64),
    contact_id: contactId,
    purchase_order_date: "2026-08-13",
    expected_arrival_date: "2026-08-20",
    currency: "SGD",
    reference: "PO-BOUNDARY",
    line_amount_type: "Exclusive",
    lines: [{ description: "PO line", quantity: 1, unit_amount: 10, account_code: "400", tax_type: "NONE" }],
  }).canonicalPayload;
  const creditNote = buildCreditNoteDraftPrimitive({
    source_ref: "work://credit-boundary",
    source_unit_key: "credit-boundary:1",
    source_sha256: "4".repeat(64),
    reason: "Boundary credit",
    credit_note_type: "ACCRECCREDIT",
    contact_id: contactId,
    credit_note_date: "2026-08-13",
    currency: "SGD",
    reference: "CN-BOUNDARY",
    authoritative_provider_field: "CREDIT_NOTE_NUMBER",
    line_amount_type: "Exclusive",
    lines: [{
      description: "Credit line",
      quantity: 1,
      unit_amount: 10,
      account_id: accountId,
      account_code: "200",
      tax_type: "NONE",
    }],
  }).canonicalPayload;
  const manualJournal = buildManualJournalDraftPrimitive({
    source_ref: "work://journal-boundary",
    source_unit_key: "journal-boundary:1",
    source_sha256: "5".repeat(64),
    journal_date: "2026-08-13",
    narration: "Boundary journal",
    lines: [
      { account_id: accountId, account_code: "400", description: "Debit", line_amount: 10 },
      { account_id: "44444444-4444-4444-8444-444444444444", account_code: "200", description: "Credit", line_amount: -10 },
    ],
  }).canonicalPayload;
  const contactCreate = prepareContactCreate({ name: "Boundary Contact" }, {
    namespace: "zcboundary",
    externalKey: "contact-create",
  });
  const contactUpdate = prepareContactUpdate({
    contact_id: contactId,
    expected_updated_at: "2026-08-13T00:00:00.000Z",
    patch: { name: "Boundary Contact Updated" },
  }, {
    contactId,
    name: "Boundary Contact",
    contactNumberEvidence: { kind: "ABSENT" },
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  const itemCreate = prepareItemCreate({ code: "BOUNDARY", name: "Boundary Item" });
  const itemUpdate = prepareItemUpdate({
    item_id: itemId,
    expected_updated_at: "2026-08-13T00:00:00.000Z",
    patch: { name: "Boundary Item Updated" },
  }, {
    itemId,
    code: "BOUNDARY",
    name: "Boundary Item",
    isSold: true,
    isPurchased: true,
    isTrackedAsInventory: false,
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  const mutateCanonical = <T extends { canonicalPayload: Record<string, unknown> }>(prepared: T): T => ({
    ...prepared,
    canonicalPayload: { ...prepared.canonicalPayload, boundaryTamper: true },
  });
  const salesInvoiceAuthorisation = {
    invoiceId: contactId,
    invoiceType: "ACCREC" as const,
    expectedStatus: "DRAFT" as const,
  };
  const supplierBillAuthorisation = {
    invoiceId: "55555555-5555-4555-8555-555555555555",
    invoiceType: "ACCPAY" as const,
    expectedStatus: "DRAFT" as const,
  };
  const manualJournalPost = {
    manualJournalId: manualJournalUpdateId,
    expectedStatus: "DRAFT" as const,
  };
  const trackingCategoryCreate = canonicalTrackingCategoryCreatePayload({ name: "Boundary Tracking New" });
  const trackingCategoryUpdate = canonicalTrackingCategoryUpdatePayload({
    trackingCategoryId: accountId,
    name: "Boundary Tracking Renamed",
  });
  const trackingOptionCreate = canonicalTrackingOptionCreatePayload({
    trackingCategoryId: accountId,
    name: "Boundary Option New",
  });
  const trackingOptionUpdate = canonicalTrackingOptionUpdatePayload({
    trackingCategoryId: accountId,
    trackingOptionId: itemId,
    name: "Boundary Option Renamed",
  });
  const voidSalesInvoice = {
    invoiceId: voidSalesInvoiceId,
    invoiceType: "ACCREC" as const,
    expectedStatus: "AUTHORISED" as const,
  };
  const voidSupplierBill = {
    invoiceId: voidSupplierBillId,
    invoiceType: "ACCPAY" as const,
    expectedStatus: "AUTHORISED" as const,
  };
  const authoriseCreditNote = {
    creditNoteId: adjustmentCreditNoteId,
    creditNoteType: "ACCRECCREDIT" as const,
    expectedStatus: "DRAFT" as const,
  };
  const allocateCreditNote = {
    creditNoteId: allocationCreditNoteId,
    creditNoteType: "ACCRECCREDIT" as const,
    targetInvoiceId: allocationInvoiceId,
    targetInvoiceType: "ACCREC" as const,
    amount: "1.0000",
    allocationDate: "2026-08-13",
    expectedCreditStatus: "AUTHORISED" as const,
    expectedTargetStatus: "AUTHORISED" as const,
  };
  const unallocateCreditNote = {
    creditNoteId: allocationCreditNoteId,
    allocationId: allocationInvoiceId,
    expectedStatus: "AUTHORISED" as const,
  };
  const refundCreditNote = {
    creditNoteId: refundCreditNoteId,
    creditNoteType: "ACCRECCREDIT" as const,
    bankAccountId: accountId,
    amount: "1.0000",
    refundDate: "2026-08-13",
    expectedStatus: "AUTHORISED" as const,
  };
  const voidCreditNote = {
    creditNoteId: voidCreditNoteId,
    creditNoteType: "ACCRECCREDIT" as const,
    expectedStatus: "AUTHORISED" as const,
  };
  const voidManualJournal = {
    manualJournalId: voidManualJournalId,
    expectedStatus: "POSTED" as const,
  };
  const paymentCreate = canonicalPaymentCreatePayload({
    invoiceId: allocationInvoiceId,
    invoiceType: "ACCREC",
    bankAccountId: accountId,
    paymentDate: "2026-08-13",
    amount: "1.0000",
    reference: "PAY-BOUNDARY",
  });
  const paymentReverse = canonicalPaymentReversePayload({ paymentId });
  const bankTransactionCreate = canonicalBankTransactionCreatePayload({
    type: "SPEND",
    contactId,
    bankAccountId: accountId,
    transactionDate: "2026-08-13",
    reference: "BANK-BOUNDARY",
    lineAmountType: "EXCLUSIVE",
    lines: [{
      description: "Boundary expense",
      quantity: "1",
      unitAmount: "1",
      accountCode: "400",
      taxType: "NONE",
      trackingOptionIds: [itemId],
    }],
  });
  const bankTransactionUpdate = canonicalBankTransactionUpdatePayload({
    bankTransactionId,
    expectedUpdatedAt,
    type: bankTransactionCreate.type,
    contactId: bankTransactionCreate.contactId,
    bankAccountId: bankTransactionCreate.bankAccountId,
    transactionDate: bankTransactionCreate.transactionDate,
    reference: bankTransactionCreate.reference,
    lineAmountType: bankTransactionCreate.lineAmountType,
    lines: bankTransactionCreate.lines,
  });
  const bankTransactionReverse = canonicalBankTransactionReversePayload({ bankTransactionId });

  return [
    {
      name: "supplier bill",
      adapterOperation: "XeroAccountingProvider.createDraftSupplierBill",
      mutationRequestId: "xmr-boundary-ap",
      canonicalPayload: invoiceCanonical,
      sdkMutation: sdk.createInvoices,
      invoke: (principal, permit, tamper) => invoiceProvider.createDraftSupplierBill(
        principal,
        tamper ? { ...invoiceInput, reference: "INV-TAMPERED" } : invoiceInput,
        "idem-boundary-ap",
        async () => undefined,
        permit,
        "xmr-boundary-ap",
      ),
    },
    {
      name: "sales invoice",
      adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
      mutationRequestId: "xmr-boundary-ar",
      canonicalPayload: invoiceCanonical,
      sdkMutation: sdk.createInvoices,
      invoke: (principal, permit, tamper) => invoiceProvider.createDraftSalesInvoice(
        principal,
        tamper ? { ...invoiceInput, reference: "INV-TAMPERED" } : invoiceInput,
        "idem-boundary-ar",
        async () => undefined,
        permit,
        "xmr-boundary-ar",
      ),
    },
    {
      name: "supplier bill DRAFT update",
      adapterOperation: "XeroAccountingProvider.updateDraftSupplierBill",
      mutationRequestId: "xmr-boundary-ap-update",
      canonicalPayload: {
        targetXeroObjectId: supplierBillUpdateId,
        expectedUpdatedAt,
        replacement: invoiceUpdateReplacement,
      },
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => invoiceProvider.updateDraftSupplierBill(
        principal,
        supplierBillUpdateId,
        expectedUpdatedAt,
        tamper ? { ...invoiceUpdateReplacement, reference: "AP-UPDATE-TAMPERED" } : invoiceUpdateReplacement,
        "xmr-boundary-ap-update",
        async () => undefined,
        permit,
        "xmr-boundary-ap-update",
      ),
    },
    {
      name: "sales invoice DRAFT update",
      adapterOperation: "XeroAccountingProvider.updateDraftSalesInvoice",
      mutationRequestId: "xmr-boundary-ar-update",
      canonicalPayload: {
        targetXeroObjectId: salesInvoiceUpdateId,
        expectedUpdatedAt,
        replacement: invoiceUpdateReplacement,
      },
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => invoiceProvider.updateDraftSalesInvoice(
        principal,
        salesInvoiceUpdateId,
        expectedUpdatedAt,
        tamper ? { ...invoiceUpdateReplacement, reference: "AR-UPDATE-TAMPERED" } : invoiceUpdateReplacement,
        "xmr-boundary-ar-update",
        async () => undefined,
        permit,
        "xmr-boundary-ar-update",
      ),
    },
    {
      name: "sales invoice authorise",
      adapterOperation: "XeroControlledLedgerTransitionProvider.authoriseSalesInvoice",
      mutationRequestId: "xmr-boundary-ar-authorise",
      canonicalPayload: salesInvoiceAuthorisation,
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => transitionProvider.authoriseSalesInvoice(
        principal,
        tamper ? { ...salesInvoiceAuthorisation, invoiceId: "77777777-7777-4777-8777-777777777777" } : salesInvoiceAuthorisation,
        "xmr-boundary-ar-authorise",
        permit,
      ),
    },
    {
      name: "supplier bill authorise",
      adapterOperation: "XeroControlledLedgerTransitionProvider.authoriseSupplierBill",
      mutationRequestId: "xmr-boundary-ap-authorise",
      canonicalPayload: supplierBillAuthorisation,
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => transitionProvider.authoriseSupplierBill(
        principal,
        tamper ? { ...supplierBillAuthorisation, invoiceId: "88888888-8888-4888-8888-888888888888" } : supplierBillAuthorisation,
        "xmr-boundary-ap-authorise",
        permit,
      ),
    },
    {
      name: "quote",
      adapterOperation: "XeroControlledMutationProvider.createQuoteDraft",
      mutationRequestId: "xmr-boundary-quote",
      canonicalPayload: quote,
      sdkMutation: sdk.createQuotes,
      invoke: (principal, permit, tamper) => controlledProvider.createQuoteDraft(
        principal,
        tamper ? { ...quote, reference: "Q-TAMPERED" } : quote,
        "xmr-boundary-quote",
        permit,
      ),
    },
    {
      name: "quote DRAFT update",
      adapterOperation: "XeroControlledMutationProvider.updateQuoteDraft",
      mutationRequestId: "xmr-boundary-quote-update",
      canonicalPayload: { targetXeroObjectId: quoteUpdateId, expectedUpdatedAt, replacement: quote },
      sdkMutation: sdk.updateQuote,
      invoke: (principal, permit, tamper) => controlledProvider.updateQuoteDraft(
        principal,
        quoteUpdateId,
        expectedUpdatedAt,
        tamper ? { ...quote, reference: "Q-UPDATE-TAMPERED" } : quote,
        "xmr-boundary-quote-update",
        permit,
      ),
    },
    {
      name: "purchase order",
      adapterOperation: "XeroControlledMutationProvider.createPurchaseOrderDraft",
      mutationRequestId: "xmr-boundary-po",
      canonicalPayload: purchaseOrder,
      sdkMutation: sdk.createPurchaseOrders,
      invoke: (principal, permit, tamper) => controlledProvider.createPurchaseOrderDraft(
        principal,
        tamper ? { ...purchaseOrder, reference: "PO-TAMPERED" } : purchaseOrder,
        "xmr-boundary-po",
        permit,
      ),
    },
    {
      name: "purchase order DRAFT update",
      adapterOperation: "XeroControlledMutationProvider.updatePurchaseOrderDraft",
      mutationRequestId: "xmr-boundary-po-update",
      canonicalPayload: { targetXeroObjectId: purchaseOrderUpdateId, expectedUpdatedAt, replacement: purchaseOrder },
      sdkMutation: sdk.updatePurchaseOrder,
      invoke: (principal, permit, tamper) => controlledProvider.updatePurchaseOrderDraft(
        principal,
        purchaseOrderUpdateId,
        expectedUpdatedAt,
        tamper ? { ...purchaseOrder, reference: "PO-UPDATE-TAMPERED" } : purchaseOrder,
        "xmr-boundary-po-update",
        permit,
      ),
    },
    {
      name: "credit note",
      adapterOperation: "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
      mutationRequestId: "xmr-boundary-credit",
      canonicalPayload: creditNote,
      sdkMutation: sdk.createCreditNotes,
      invoke: (principal, permit, tamper) => adjustmentProvider.createCreditNoteDraft(
        principal,
        tamper ? { ...creditNote, reference: "CN-TAMPERED" } : creditNote,
        "xmr-boundary-credit",
        permit,
      ),
    },
    {
      name: "credit note DRAFT update",
      adapterOperation: "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
      mutationRequestId: "xmr-boundary-credit-update",
      canonicalPayload: { targetXeroObjectId: creditNoteUpdateId, expectedUpdatedAt, replacement: creditNote },
      sdkMutation: sdk.updateCreditNote,
      invoke: (principal, permit, tamper) => adjustmentProvider.updateCreditNoteDraft(
        principal,
        creditNoteUpdateId,
        expectedUpdatedAt,
        tamper ? { ...creditNote, reference: "CN-UPDATE-TAMPERED" } : creditNote,
        "xmr-boundary-credit-update",
        permit,
      ),
    },
    {
      name: "manual journal",
      adapterOperation: "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
      mutationRequestId: "xmr-boundary-journal",
      canonicalPayload: manualJournal,
      sdkMutation: sdk.createManualJournals,
      invoke: (principal, permit, tamper) => adjustmentProvider.createManualJournalDraft(
        principal,
        tamper ? { ...manualJournal, narration: "Tampered" } : manualJournal,
        "xmr-boundary-journal",
        permit,
      ),
    },
    {
      name: "manual journal DRAFT update",
      adapterOperation: "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
      mutationRequestId: "xmr-boundary-journal-update",
      canonicalPayload: { targetXeroObjectId: manualJournalUpdateId, expectedUpdatedAt, replacement: manualJournal },
      sdkMutation: sdk.updateManualJournal,
      invoke: (principal, permit, tamper) => adjustmentProvider.updateManualJournalDraft(
        principal,
        manualJournalUpdateId,
        expectedUpdatedAt,
        tamper ? { ...manualJournal, narration: "Update tampered" } : manualJournal,
        "xmr-boundary-journal-update",
        permit,
      ),
    },
    {
      name: "manual journal post",
      adapterOperation: "XeroControlledLedgerTransitionProvider.postManualJournal",
      mutationRequestId: "xmr-boundary-journal-post",
      canonicalPayload: manualJournalPost,
      sdkMutation: sdk.updateManualJournal,
      invoke: (principal, permit, tamper) => transitionProvider.postManualJournal(
        principal,
        tamper ? { ...manualJournalPost, manualJournalId: "99999999-9999-4999-8999-999999999999" } : manualJournalPost,
        "xmr-boundary-journal-post",
        permit,
      ),
    },
    {
      name: "tracking category create",
      adapterOperation: "XeroTrackingMutationProvider.createCategory",
      mutationRequestId: "xmr-boundary-tracking-category-create",
      canonicalPayload: trackingCategoryCreate,
      sdkMutation: sdk.createTrackingCategory,
      invoke: (principal, permit, tamper) => trackingProvider.createCategory(
        principal,
        tamper ? { ...trackingCategoryCreate, name: "Tracking tampered" } : trackingCategoryCreate,
        "xmr-boundary-tracking-category-create",
        (permit ?? {}) as never,
      ),
    },
    {
      name: "tracking category update",
      adapterOperation: "XeroTrackingMutationProvider.updateCategory",
      mutationRequestId: "xmr-boundary-tracking-category-update",
      canonicalPayload: trackingCategoryUpdate,
      sdkMutation: sdk.updateTrackingCategory,
      invoke: (principal, permit, tamper) => trackingProvider.updateCategory(
        principal,
        tamper ? { ...trackingCategoryUpdate, name: "Tracking update tampered" } : trackingCategoryUpdate,
        "xmr-boundary-tracking-category-update",
        (permit ?? {}) as never,
      ),
    },
    {
      name: "tracking option create",
      adapterOperation: "XeroTrackingMutationProvider.createOption",
      mutationRequestId: "xmr-boundary-tracking-option-create",
      canonicalPayload: trackingOptionCreate,
      sdkMutation: sdk.createTrackingOptions,
      invoke: (principal, permit, tamper) => trackingProvider.createOption(
        principal,
        tamper ? { ...trackingOptionCreate, name: "Option tampered" } : trackingOptionCreate,
        "xmr-boundary-tracking-option-create",
        (permit ?? {}) as never,
      ),
    },
    {
      name: "tracking option update",
      adapterOperation: "XeroTrackingMutationProvider.updateOption",
      mutationRequestId: "xmr-boundary-tracking-option-update",
      canonicalPayload: trackingOptionUpdate,
      sdkMutation: sdk.updateTrackingOptions,
      invoke: (principal, permit, tamper) => trackingProvider.updateOption(
        principal,
        tamper ? { ...trackingOptionUpdate, name: "Option update tampered" } : trackingOptionUpdate,
        "xmr-boundary-tracking-option-update",
        (permit ?? {}) as never,
      ),
    },
    {
      name: "sales invoice void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidSalesInvoice",
      mutationRequestId: "xmr-boundary-sales-invoice-void",
      canonicalPayload: voidSalesInvoice,
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.voidSalesInvoice(
        principal,
        tamper ? { ...voidSalesInvoice, invoiceId: voidSupplierBillId } : voidSalesInvoice,
        "xmr-boundary-sales-invoice-void",
        permit,
      ),
    },
    {
      name: "supplier bill void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidSupplierBill",
      mutationRequestId: "xmr-boundary-supplier-bill-void",
      canonicalPayload: voidSupplierBill,
      sdkMutation: sdk.updateInvoice,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.voidSupplierBill(
        principal,
        tamper ? { ...voidSupplierBill, invoiceId: voidSalesInvoiceId } : voidSupplierBill,
        "xmr-boundary-supplier-bill-void",
        permit,
      ),
    },
    {
      name: "credit note authorise",
      adapterOperation: "XeroLedgerAdjustmentProvider.authoriseCreditNote",
      mutationRequestId: "xmr-boundary-credit-note-authorise",
      canonicalPayload: authoriseCreditNote,
      sdkMutation: sdk.updateCreditNote,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.authoriseCreditNote(
        principal,
        tamper ? { ...authoriseCreditNote, creditNoteId: creditNoteUpdateId } : authoriseCreditNote,
        "xmr-boundary-credit-note-authorise",
        permit,
      ),
    },
    {
      name: "credit note allocate",
      adapterOperation: "XeroLedgerAdjustmentProvider.allocateCreditNote",
      mutationRequestId: "xmr-boundary-credit-note-allocate",
      canonicalPayload: allocateCreditNote,
      sdkMutation: sdk.createCreditNoteAllocation,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.allocateCreditNote(
        principal,
        tamper ? { ...allocateCreditNote, targetInvoiceId: voidSalesInvoiceId } : allocateCreditNote,
        "xmr-boundary-credit-note-allocate",
        permit,
      ),
    },
    {
      name: "credit note unallocate",
      adapterOperation: "XeroLedgerAdjustmentProvider.unallocateCreditNote",
      mutationRequestId: "xmr-boundary-credit-note-unallocate",
      canonicalPayload: unallocateCreditNote,
      sdkMutation: sdk.deleteCreditNoteAllocations,
      sdkExposesIdempotencyKey: false,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.unallocateCreditNote(
        principal,
        tamper ? { ...unallocateCreditNote, allocationId: voidCreditNoteId } : unallocateCreditNote,
        "xmr-boundary-credit-note-unallocate",
        permit,
      ),
    },
    {
      name: "credit note refund",
      adapterOperation: "XeroLedgerAdjustmentProvider.refundCreditNote",
      mutationRequestId: "xmr-boundary-credit-note-refund",
      canonicalPayload: refundCreditNote,
      sdkMutation: sdk.createPayment,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.refundCreditNote(
        principal,
        tamper ? { ...refundCreditNote, amount: "2.0000" } : refundCreditNote,
        "xmr-boundary-credit-note-refund",
        permit,
      ),
    },
    {
      name: "credit note void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidCreditNote",
      mutationRequestId: "xmr-boundary-credit-note-void",
      canonicalPayload: voidCreditNote,
      sdkMutation: sdk.updateCreditNote,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.voidCreditNote(
        principal,
        tamper ? { ...voidCreditNote, creditNoteId: adjustmentCreditNoteId } : voidCreditNote,
        "xmr-boundary-credit-note-void",
        permit,
      ),
    },
    {
      name: "manual journal void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidManualJournal",
      mutationRequestId: "xmr-boundary-manual-journal-void",
      canonicalPayload: voidManualJournal,
      sdkMutation: sdk.updateManualJournal,
      invoke: (principal, permit, tamper) => ledgerAdjustmentProvider.voidManualJournal(
        principal,
        tamper ? { ...voidManualJournal, manualJournalId: voidCreditNoteId } : voidManualJournal,
        "xmr-boundary-manual-journal-void",
        permit,
      ),
    },
    {
      name: "payment create",
      adapterOperation: "XeroPaymentBankTransactionProvider.createPayment",
      mutationRequestId: "xmr-boundary-payment-create",
      canonicalPayload: paymentCreate,
      sdkMutation: sdk.createPayment,
      invoke: (principal, permit, tamper) => paymentBankProvider.createPayment(
        principal,
        tamper ? { ...paymentCreate, amount: "2.0000" } : paymentCreate,
        "xmr-boundary-payment-create",
        permit,
      ),
    },
    {
      name: "payment reverse",
      adapterOperation: "XeroPaymentBankTransactionProvider.reversePayment",
      mutationRequestId: "xmr-boundary-payment-reverse",
      canonicalPayload: paymentReverse,
      sdkMutation: sdk.deletePayment,
      invoke: (principal, permit, tamper) => paymentBankProvider.reversePayment(
        principal,
        tamper ? { ...paymentReverse, paymentId: bankTransactionId } : paymentReverse,
        "xmr-boundary-payment-reverse",
        permit,
      ),
    },
    {
      name: "bank transaction create",
      adapterOperation: "XeroPaymentBankTransactionProvider.createBankTransaction",
      mutationRequestId: "xmr-boundary-bank-transaction-create",
      canonicalPayload: bankTransactionCreate,
      sdkMutation: sdk.createBankTransactions,
      invoke: (principal, permit, tamper) => paymentBankProvider.createBankTransaction(
        principal,
        tamper ? { ...bankTransactionCreate, reference: "BANK-TAMPERED" } : bankTransactionCreate,
        "xmr-boundary-bank-transaction-create",
        permit,
      ),
    },
    {
      name: "bank transaction update",
      adapterOperation: "XeroPaymentBankTransactionProvider.updateBankTransaction",
      mutationRequestId: "xmr-boundary-bank-transaction-update",
      canonicalPayload: {
        targetXeroObjectId: bankTransactionId,
        expectedUpdatedAt,
        replacement: bankTransactionUpdate,
      },
      sdkMutation: sdk.updateBankTransaction,
      invoke: (principal, permit, tamper) => paymentBankProvider.updateBankTransaction(
        principal,
        tamper ? { ...bankTransactionUpdate, reference: "BANK-UPDATE-TAMPERED" } : bankTransactionUpdate,
        "xmr-boundary-bank-transaction-update",
        permit,
      ),
    },
    {
      name: "bank transaction reverse",
      adapterOperation: "XeroPaymentBankTransactionProvider.reverseBankTransaction",
      mutationRequestId: "xmr-boundary-bank-transaction-reverse",
      canonicalPayload: bankTransactionReverse,
      sdkMutation: sdk.updateBankTransaction,
      invoke: (principal, permit, tamper) => paymentBankProvider.reverseBankTransaction(
        principal,
        tamper ? { ...bankTransactionReverse, bankTransactionId: paymentId } : bankTransactionReverse,
        "xmr-boundary-bank-transaction-reverse",
        permit,
      ),
    },
    {
      name: "contact create",
      adapterOperation: "XeroContactItemMutationProvider.createContact",
      mutationRequestId: "xmr-boundary-contact-create",
      canonicalPayload: contactCreate.canonicalPayload,
      sdkMutation: sdk.createContacts,
      invoke: (principal, permit, tamper) => contactItemProvider.createContact(
        principal,
        tamper ? mutateCanonical(contactCreate) : contactCreate,
        "xmr-boundary-contact-create",
        permit,
      ),
    },
    {
      name: "contact update",
      adapterOperation: "XeroContactItemMutationProvider.updateContact",
      mutationRequestId: "xmr-boundary-contact-update",
      canonicalPayload: contactUpdate.canonicalPayload,
      sdkMutation: sdk.updateContact,
      invoke: (principal, permit, tamper) => contactItemProvider.updateContact(
        principal,
        tamper ? mutateCanonical(contactUpdate) : contactUpdate,
        "xmr-boundary-contact-update",
        permit,
      ),
    },
    {
      name: "item create",
      adapterOperation: "XeroContactItemMutationProvider.createItem",
      mutationRequestId: "xmr-boundary-item-create",
      canonicalPayload: itemCreate.canonicalPayload,
      sdkMutation: sdk.createItems,
      invoke: (principal, permit, tamper) => contactItemProvider.createItem(
        principal,
        tamper ? mutateCanonical(itemCreate) : itemCreate,
        "xmr-boundary-item-create",
        permit,
      ),
    },
    {
      name: "item update",
      adapterOperation: "XeroContactItemMutationProvider.updateItem",
      mutationRequestId: "xmr-boundary-item-update",
      canonicalPayload: itemUpdate.canonicalPayload,
      sdkMutation: sdk.updateItem,
      invoke: (principal, permit, tamper) => contactItemProvider.updateItem(
        principal,
        tamper ? mutateCanonical(itemUpdate) : itemUpdate,
        "xmr-boundary-item-update",
        permit,
      ),
    },
  ];
}

function permit() {
  return issueProviderWriteTestPermit({
    adapterOperation,
    mutationRequestId,
    canonicalPayload,
    tenantId,
    connectionId,
  });
}

function consume(options: Readonly<{
  permit?: ReturnType<typeof permit>;
  principal?: ReturnType<typeof providerWriteTestContext>;
  connection?: { tenantId: string; connectionId: string };
  payload?: unknown;
  providerIdempotencyKey?: string;
}> = {}) {
  return consumeXeroProviderWritePermitAtMutationBoundary({
    permit: options.permit,
    principal: options.principal ?? providerWriteTestContext(connectionId),
    connection: {
      provider: "xero",
      tenantName: "Provider Boundary Tenant",
      status: "ACTIVE",
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
      updatedAt: new Date("2026-08-13T00:00:00.000Z"),
      ...(options.connection ?? { tenantId, connectionId }),
    },
    adapterOperation,
    actionId,
    mutationRequestId,
    providerIdempotencyKey: options.providerIdempotencyKey ?? mutationRequestId,
    canonicalPayload: options.payload ?? canonicalPayload,
  });
}

describe("Xero provider write permit live-boundary claims", () => {
  it("accepts the exact OAuth identity, manager connection, target and persisted payload once", () => {
    const authority = permit();
    expect(consume({ permit: authority })).toMatchObject({
      providerId: "xero",
      adapterOperation,
      actionId,
      mutationRequestId,
      tenantId,
      connectionId,
      targetSessionId: "target-session-provider-test",
    });
    expect(() => consume({ permit: authority })).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED", providerMutationPossible: false }),
    }));
  });

  it("fails closed without a permit", () => {
    expect(() => consume()).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "INVALID", providerMutationPossible: false }),
    }));
  });

  it("rejects a mismatched provider idempotency key before consuming the permit", () => {
    const authority = permit();
    expect(() => consume({ permit: authority, providerIdempotencyKey: "xmr-provider-other" })).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({
        reasonCodes: ["PROVIDER_IDEMPOTENCY_KEY_MISMATCH"],
        providerMutationPossible: false,
        writeOutcome: "DEFINITELY_REJECTED",
      }),
    }));
    expect(consume({ permit: authority })).toMatchObject({ mutationRequestId });
  });

  it.each([
    ["manager connection", {
      connection: { tenantId, connectionId: "connection-other" },
    }, "CONNECTION_MISMATCH"],
    ["manager tenant", {
      connection: { tenantId: "tenant-other", connectionId },
    }, "TENANT_MISMATCH"],
    ["target session", {
      principal: Object.freeze({
        ...providerWriteTestContext(connectionId),
        targetSessionId: "target-session-other",
      }),
    }, "TARGET_SESSION_MISMATCH"],
    ["canonical payload", {
      payload: { ...canonicalPayload, reference: "Q-TAMPERED" },
    }, "PAYLOAD_MISMATCH"],
  ] as const)("poisons a permit presented with the wrong %s", (_label, options, reason) => {
    const authority = permit();
    expect(() => consume({ ...options, permit: authority })).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: reason, providerMutationPossible: false }),
    }));
    expect(() => consume({ permit: authority })).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    }));
  });

  it("rejects a legacy string principal at the provider boundary", () => {
    expect(() => consumeXeroProviderWritePermitAtMutationBoundary({
      permit: permit(),
      principal: "legacy-actor",
      connection: {
        provider: "xero",
        connectionId,
        actorId: "legacy-actor",
        tenantId,
        tenantName: "Legacy Tenant",
        grantedScopes: [],
        tokenCiphertext: "test-only",
        tokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshVersion: 1,
        status: "ACTIVE",
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        updatedAt: new Date("2026-08-13T00:00:00.000Z"),
      },
      adapterOperation,
      actionId,
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload,
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("real manager credential boundary is permit-first", () => {
  const assertNoCredentialOrProviderSideEffect = (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => {
    expect(runtime.createClient).not.toHaveBeenCalled();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.decrypt).not.toHaveBeenCalled();
    expect(runtime.refreshToken).not.toHaveBeenCalled();
    expect(runtime.updateToken).not.toHaveBeenCalled();
    expect(runtime.markTokenFailed).not.toHaveBeenCalled();
    expect(runtime.createQuotes).not.toHaveBeenCalled();
  };

  it("rejects a missing permit before client initialization, token decrypt, refresh, state mutation, or SDK write", async () => {
    const runtime = await realManagerBoundary();

    await expect(runtime.provider.createQuoteDraft(
      runtime.principal,
      runtime.payload,
      "xmr-real-missing",
      undefined,
    )).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "INVALID", providerMutationPossible: false }),
    });

    assertNoCredentialOrProviderSideEffect(runtime);
  });

  it("rejects every wrong bound claim before client initialization, token decrypt, refresh, state mutation, or SDK write", async () => {
    const scenarios = [
      {
        name: "tenant",
        expectedReason: "TENANT_MISMATCH",
        permitInput: (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => ({
          mutationRequestId: "xmr-real-wrong-tenant",
          canonicalPayload: runtime.payload,
          tenantId: "tenant-wrong",
          connectionId,
          context: runtime.principal,
        }),
      },
      {
        name: "connection",
        expectedReason: "CONNECTION_MISMATCH",
        permitInput: (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => ({
          mutationRequestId: "xmr-real-wrong-connection",
          canonicalPayload: runtime.payload,
          tenantId,
          connectionId: "connection-wrong",
          context: runtime.principal,
        }),
      },
      {
        name: "target session",
        expectedReason: "TARGET_SESSION_MISMATCH",
        permitInput: (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => ({
          mutationRequestId: "xmr-real-wrong-target",
          canonicalPayload: runtime.payload,
          tenantId,
          connectionId,
          context: Object.freeze({ ...runtime.principal, targetSessionId: "target-session-wrong" }),
        }),
      },
      {
        name: "canonical payload",
        expectedReason: "PAYLOAD_MISMATCH",
        permitInput: (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => ({
          mutationRequestId: "xmr-real-wrong-payload",
          canonicalPayload: { ...runtime.payload, reference: "Q-WRONG" },
          tenantId,
          connectionId,
          context: runtime.principal,
        }),
      },
      {
        name: "mutation request",
        expectedReason: "MUTATION_REQUEST_MISMATCH",
        permitInput: (runtime: Awaited<ReturnType<typeof realManagerBoundary>>) => ({
          mutationRequestId: "xmr-real-issued-for-other-request",
          canonicalPayload: runtime.payload,
          tenantId,
          connectionId,
          context: runtime.principal,
        }),
      },
    ] as const;

    for (const scenario of scenarios) {
      const runtime = await realManagerBoundary();
      const invokedMutationRequestId = scenario.name === "mutation request"
        ? "xmr-real-actual-request"
        : scenario.permitInput(runtime).mutationRequestId;
      const authority = issueProviderWriteTestPermit({
        adapterOperation,
        ...scenario.permitInput(runtime),
      });

      await expect(runtime.provider.createQuoteDraft(
        runtime.principal,
        runtime.payload,
        invokedMutationRequestId,
        authority,
      )).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: expect.objectContaining({
          permitReason: scenario.expectedReason,
          providerMutationPossible: false,
        }),
      });
      assertNoCredentialOrProviderSideEffect(runtime);
    }
  });

  it("rejects a consumed permit before client initialization, token decrypt, refresh, state mutation, or SDK write", async () => {
    const runtime = await realManagerBoundary();
    const authority = issueProviderWriteTestPermit({
      adapterOperation,
      mutationRequestId: "xmr-real-consumed",
      canonicalPayload: runtime.payload,
      tenantId,
      connectionId,
      context: runtime.principal,
    });
    consumeXeroProviderWritePermitAtMutationBoundary({
      permit: authority,
      principal: runtime.principal,
      connection: {
        provider: "xero",
        connectionId,
        authorizationId: "authorization-provider-test",
        tenantId,
        tenantName: "Provider Boundary Tenant",
        status: "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      adapterOperation,
      actionId,
      mutationRequestId: "xmr-real-consumed",
      providerIdempotencyKey: "xmr-real-consumed",
      canonicalPayload: runtime.payload,
    });

    await expect(runtime.provider.createQuoteDraft(
      runtime.principal,
      runtime.payload,
      "xmr-real-consumed",
      authority,
    )).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED", providerMutationPossible: false }),
    });

    assertNoCredentialOrProviderSideEffect(runtime);
  });

  it("preserves a valid permitted write through client initialization, decrypt, and the exact SDK mutation", async () => {
    const runtime = await realManagerBoundary();
    const authority = issueProviderWriteTestPermit({
      adapterOperation,
      mutationRequestId: "xmr-real-valid",
      canonicalPayload: runtime.payload,
      tenantId,
      connectionId,
      context: runtime.principal,
    });

    await expect(runtime.provider.createQuoteDraft(
      runtime.principal,
      runtime.payload,
      "xmr-real-valid",
      authority,
    )).resolves.toMatchObject({
      objectId: "55555555-5555-4555-8555-555555555555",
      receipt: { operation: "CREATE_QUOTE_DRAFT" },
    });

    expect(runtime.createClient).toHaveBeenCalledOnce();
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(runtime.decrypt).toHaveBeenCalledOnce();
    expect(runtime.refreshToken).not.toHaveBeenCalled();
    expect(runtime.updateToken).not.toHaveBeenCalled();
    expect(runtime.markTokenFailed).not.toHaveBeenCalled();
    expect(runtime.createQuotes).toHaveBeenCalledOnce();
  });

  it.each([
    ["successful refresh", false],
    ["refresh-race recovery", true],
  ] as const)("fails closed when %s returns a token with downgraded Xero scopes", async (_label, refreshRace) => {
    const runtime = await realManagerBoundary();
    const authorization = await runtime.repository.getProviderAuthorization(
      "authorization-provider-test",
      runtime.principal.workspaceId,
      runtime.principal.subjectId,
    );
    if (!authorization) throw new Error("test authorization missing");
    const downgradedScopes = requiredXeroScopes.filter((scope) => scope !== "accounting.invoices");
    const downgradedToken = JSON.stringify({
      access_token: "real-boundary-downgraded-access",
      refresh_token: "real-boundary-downgraded-refresh",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      scope: downgradedScopes.join(" "),
    });
    const expiredAuthorization = await runtime.repository.updateProviderAuthorizationToken(
      authorization.authorizationId,
      authorization.workspaceId,
      authorization.refreshVersion,
      runtime.cipher.encrypt(
        JSON.stringify({
          access_token: "real-boundary-expired-access",
          refresh_token: "real-boundary-expired-refresh",
          expires_at: 1,
          scope: requiredXeroScopes.join(" "),
        }),
        authorization.authorizationId,
      ),
      new Date(1),
      requiredXeroScopes,
    );
    if (!expiredAuthorization) throw new Error("test authorization expiry update failed");
    const installDowngradedToken = async () => runtime.repository.updateProviderAuthorizationToken(
      expiredAuthorization.authorizationId,
      expiredAuthorization.workspaceId,
      expiredAuthorization.refreshVersion,
      runtime.cipher.encrypt(downgradedToken, expiredAuthorization.authorizationId),
      new Date(Date.now() + 3_600_000),
      downgradedScopes,
    );
    if (refreshRace) {
      runtime.refreshToken.mockImplementationOnce(async () => {
        await installDowngradedToken();
        throw new Error("stale refresh token was already rotated");
      });
    } else {
      runtime.refreshToken.mockResolvedValueOnce({
        access_token: "real-boundary-downgraded-access",
        refresh_token: "real-boundary-downgraded-refresh",
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        scope: downgradedScopes.join(" "),
      });
    }
    const authority = issueProviderWriteTestPermit({
      adapterOperation,
      mutationRequestId: "xmr-refresh-downgraded",
      canonicalPayload: runtime.payload,
      tenantId,
      connectionId,
      context: runtime.principal,
    });

    await expect(runtime.provider.createQuoteDraft(
      runtime.principal,
      runtime.payload,
      "xmr-refresh-downgraded",
      authority,
    )).rejects.toMatchObject({
      code: "SCOPE_MISSING",
      details: expect.objectContaining({
        providerMutationPossible: false,
        writeOutcome: "DEFINITELY_REJECTED",
      }),
    });
    expect(runtime.createQuotes).not.toHaveBeenCalled();
    expect(runtime.markTokenFailed).not.toHaveBeenCalled();
  });

  it("preserves an ordinary read while exposing no mutation-capable SDK method", async () => {
    const runtime = await realManagerBoundary();

    await expect(runtime.provider.getItemByCode(runtime.principal, "READ-ONLY"))
      .resolves.toBeUndefined();
    expect(runtime.getItem).toHaveBeenCalledOnce();
    expect(runtime.createQuotes).not.toHaveBeenCalled();

    await expect(runtime.manager.withClient(runtime.principal, async (client) => {
      const bypass = client as unknown as { accountingApi: { createQuotes: () => Promise<unknown> } };
      return bypass.accountingApi.createQuotes();
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: expect.objectContaining({
        reasonCodes: ["READ_CLIENT_METHOD_DENIED"],
        providerMutationPossible: false,
      }),
    });
    expect(runtime.createQuotes).not.toHaveBeenCalled();
  });
});

describe("all raw action writers fail before Xero SDK mutation", () => {
  const expectedConnection = { tenantId, connectionId } as const;
  const principal = providerWriteTestContext(connectionId);
  const rawWriterCount = rawWriterContracts(expectedConnection).length;
  const authorityFor = (writer: WriterContract) => issueProviderWriteTestPermit({
    adapterOperation: writer.adapterOperation,
    mutationRequestId: writer.mutationRequestId,
    canonicalPayload: writer.canonicalPayload,
    tenantId,
    connectionId,
  });

  it("blocks every writer when no permit is presented", async () => {
    for (const writer of rawWriterContracts(expectedConnection)) {
      await expect(writer.invoke(principal, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(writer.sdkMutation, writer.name).not.toHaveBeenCalled();
    }
  });

  it("keeps every raw writer in the manager permit registry", () => {
    const inventory = rawWriterContracts(expectedConnection).map((writer) => writer.adapterOperation).sort();
    expect([...XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS].sort()).toEqual(inventory);
  });

  it("blocks every writer on the wrong live connection or tenant", async () => {
    for (const writer of rawWriterContracts({ tenantId, connectionId: "connection-other" })) {
      await expect(writer.invoke(principal, authorityFor(writer))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(writer.sdkMutation, writer.name).not.toHaveBeenCalled();
    }
    for (const writer of rawWriterContracts({ tenantId: "tenant-other", connectionId })) {
      await expect(writer.invoke(principal, authorityFor(writer))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(writer.sdkMutation, writer.name).not.toHaveBeenCalled();
    }
  });

  it("blocks every writer on a wrong target session", async () => {
    const wrongTarget = Object.freeze({ ...principal, targetSessionId: "target-session-other" });
    for (const writer of rawWriterContracts(expectedConnection)) {
      await expect(writer.invoke(wrongTarget, authorityFor(writer))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(writer.sdkMutation, writer.name).not.toHaveBeenCalled();
    }
  });

  it("blocks every writer when its actual canonical payload differs from the persisted proposal", async () => {
    for (const writer of rawWriterContracts(expectedConnection)) {
      await expect(writer.invoke(principal, authorityFor(writer), true)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(writer.sdkMutation, writer.name).not.toHaveBeenCalled();
    }
  });

  it("cannot reuse a consumed permit after the Xero SDK mutation fails", async () => {
    const writer = rawWriterContracts(expectedConnection)
      .find((candidate) => candidate.adapterOperation === adapterOperation) as WriterContract;
    const authority = authorityFor(writer);
    await expect(writer.invoke(principal, authority)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(writer.sdkMutation).toHaveBeenCalledTimes(1);
    await expect(writer.invoke(principal, authority)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    });
    expect(writer.sdkMutation).toHaveBeenCalledTimes(1);
  });

  it(`passes the exact mutation request ID as the SDK idempotency key for SDK writers that expose one`, async () => {
    for (const writer of rawWriterContracts(expectedConnection)) {
      const authority = authorityFor(writer);
      await expect(writer.invoke(principal, authority)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
      expect(writer.sdkMutation, writer.name).toHaveBeenCalled();
      const args = writer.sdkMutation.mock.calls.at(-1) as unknown[];
      if (writer.sdkExposesIdempotencyKey !== false) {
        expect(args.at(-1), writer.name).toBe(writer.mutationRequestId);
      }
    }
  });

  it("does not consume write authority during a readback-only operation", async () => {
    const quoteContract = rawWriterContracts(expectedConnection)
      .find((candidate) => candidate.adapterOperation === adapterOperation) as WriterContract;
    const getItem = vi.fn(async () => ({ body: { items: [] } }));
    const createQuotes = vi.fn(async () => {
      const error = new Error("SDK create failed") as Error & { code: string };
      error.code = "ETIMEDOUT";
      throw error;
    });
    const connection = { provider: "xero" as const, tenantName: "Boundary Tenant", status: "ACTIVE" as const, ...expectedConnection };
    const manager = {
      withClient: async <T>(
        _principal: AccountingPrincipal,
        callback: (client: unknown, connection: unknown) => Promise<T>,
      ): Promise<T> => callback({ accountingApi: { getItem, createQuotes } }, connection),
      withWriteClient: async <T>(
        principal: AccountingPrincipal,
        authorization: XeroProviderWriteAuthorization,
        callback: (client: unknown, connection: unknown) => Promise<T>,
      ): Promise<T> => {
        consumeXeroProviderWritePermitAtMutationBoundary({ ...authorization, principal, connection });
        return callback({ accountingApi: { getItem, createQuotes } }, connection);
      },
    } as unknown as XeroClientManager;
    const provider = new XeroControlledMutationProvider(manager);
    const authority = authorityFor(quoteContract);

    await expect(provider.getItemByCode(principal, "READBACK-ONLY")).resolves.toBeUndefined();
    await expect(provider.createQuoteDraft(
      principal,
      quoteContract.canonicalPayload as Parameters<XeroControlledMutationProvider["createQuoteDraft"]>[1],
      quoteContract.mutationRequestId,
      authority,
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(createQuotes).toHaveBeenCalledTimes(1);
  });
});

describe("all Xero SDK mutation sinks are permit-gated", () => {
  const contracts = [
    ["src/providers/xeroProvider.ts", "createDraftSupplierBill", "XeroAccountingProvider.createDraftSupplierBill", "supplier_bill.create_draft", "createInvoices"],
    ["src/providers/xeroProvider.ts", "createDraftSalesInvoice", "XeroAccountingProvider.createDraftSalesInvoice", "customer_invoice.create_draft", "createInvoices"],
    ["src/providers/xeroProvider.ts", "#updateDraftInvoice", undefined, undefined, "updateInvoice"],
    ["src/providers/xeroControlledLedgerTransitionProvider.ts", "#authoriseInvoice", undefined, undefined, "updateInvoice"],
    ["src/providers/xeroControlledMutationProvider.ts", "createQuoteDraft", "XeroControlledMutationProvider.createQuoteDraft", "quote.create_draft", "createQuotes"],
    ["src/providers/xeroControlledMutationProvider.ts", "updateQuoteDraft", "XeroControlledMutationProvider.updateQuoteDraft", "quote.update_draft", "updateQuote"],
    ["src/providers/xeroControlledMutationProvider.ts", "createPurchaseOrderDraft", "XeroControlledMutationProvider.createPurchaseOrderDraft", "purchase_order.create_draft", "createPurchaseOrders"],
    ["src/providers/xeroControlledMutationProvider.ts", "updatePurchaseOrderDraft", "XeroControlledMutationProvider.updatePurchaseOrderDraft", "purchase_order.update_draft", "updatePurchaseOrder"],
    ["src/providers/xeroCreditNoteManualJournalProvider.ts", "createCreditNoteDraft", "XeroCreditNoteManualJournalProvider.createCreditNoteDraft", "credit_note.create_draft", "createCreditNotes"],
    ["src/providers/xeroCreditNoteManualJournalProvider.ts", "updateCreditNoteDraft", "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft", "credit_note.update_draft", "updateCreditNote"],
    ["src/providers/xeroCreditNoteManualJournalProvider.ts", "createManualJournalDraft", "XeroCreditNoteManualJournalProvider.createManualJournalDraft", "manual_journal.create_draft", "createManualJournals"],
    ["src/providers/xeroCreditNoteManualJournalProvider.ts", "updateManualJournalDraft", "XeroCreditNoteManualJournalProvider.updateManualJournalDraft", "manual_journal.update_draft", "updateManualJournal"],
    ["src/providers/xeroControlledLedgerTransitionProvider.ts", "postManualJournal", "XeroControlledLedgerTransitionProvider.postManualJournal", "manual_journal.post", "updateManualJournal"],
    ["src/providers/xeroContactItemMutationProvider.ts", "createContact", "XeroContactItemMutationProvider.createContact", "contact.create_basic", "createContacts"],
    ["src/providers/xeroContactItemMutationProvider.ts", "updateContact", "XeroContactItemMutationProvider.updateContact", "contact.update_basic", "updateContact"],
    ["src/providers/xeroContactItemMutationProvider.ts", "createItem", "XeroContactItemMutationProvider.createItem", "item.create_basic_untracked", "createItems"],
    ["src/providers/xeroContactItemMutationProvider.ts", "updateItem", "XeroContactItemMutationProvider.updateItem", "item.update_basic_untracked", "updateItem"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "#voidInvoice", undefined, undefined, "updateInvoice"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "authoriseCreditNote", "XeroLedgerAdjustmentProvider.authoriseCreditNote", "credit_note.authorise", "updateCreditNote"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "allocateCreditNote", "XeroLedgerAdjustmentProvider.allocateCreditNote", "credit_note.allocate", "createCreditNoteAllocation"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "unallocateCreditNote", "XeroLedgerAdjustmentProvider.unallocateCreditNote", "credit_note.unallocate", "deleteCreditNoteAllocations"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "refundCreditNote", "XeroLedgerAdjustmentProvider.refundCreditNote", "credit_note.refund", "createPayment"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "voidCreditNote", "XeroLedgerAdjustmentProvider.voidCreditNote", "credit_note.void", "updateCreditNote"],
    ["src/providers/xeroLedgerAdjustmentProvider.ts", "voidManualJournal", "XeroLedgerAdjustmentProvider.voidManualJournal", "manual_journal.void", "updateManualJournal"],
    ["src/providers/xeroPaymentBankTransactionProvider.ts", "createPayment", "XeroPaymentBankTransactionProvider.createPayment", "payment.create", "createPayment"],
    ["src/providers/xeroPaymentBankTransactionProvider.ts", "reversePayment", "XeroPaymentBankTransactionProvider.reversePayment", "payment.reverse", "deletePayment"],
    ["src/providers/xeroPaymentBankTransactionProvider.ts", "createBankTransaction", "XeroPaymentBankTransactionProvider.createBankTransaction", "bank_transaction.create", "createBankTransactions"],
    ["src/providers/xeroPaymentBankTransactionProvider.ts", "updateBankTransaction", "XeroPaymentBankTransactionProvider.updateBankTransaction", "bank_transaction.update", "updateBankTransaction"],
    ["src/providers/xeroPaymentBankTransactionProvider.ts", "reverseBankTransaction", "XeroPaymentBankTransactionProvider.reverseBankTransaction", "bank_transaction.reverse", "updateBankTransaction"],
  ] as const;

  it.each(contracts)("routes %s#%s through the manager-owned permit-first client boundary", (
    relativePath,
    method,
    operation,
    action,
    sdkMethod,
  ) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
    const methodStart = source.indexOf(`  async ${method}`);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    const nextMethod = source.indexOf("\n  async ", methodStart + 10);
    const body = source.slice(methodStart, nextMethod < 0 ? undefined : nextMethod);
    const managerBoundaryAt = Math.max(
      body.indexOf("withWriteClient(principal, {"),
      body.indexOf("withWriteClient(principal, authorization,"),
    );
    const sdkMutationAt = Math.max(
      body.indexOf(`accountingApi.${sdkMethod}(`),
      body.indexOf(`api.${sdkMethod}(`),
    );
    expect(managerBoundaryAt).toBeGreaterThanOrEqual(0);
    if (operation && action) {
      expect(body).toContain(`adapterOperation: "${operation}"`);
      expect(body).toContain(`actionId: "${action}"`);
    }
    expect(sdkMutationAt).toBeGreaterThan(managerBoundaryAt);
    expect(body).not.toContain("consumeXeroProviderWritePermitAtMutationBoundary(");
    expect(body).not.toContain("withClient(principal");
  });

  it("has no mutation sink, adapter consumer, ordinary-read-client, or raw-token bypass drift", () => {
    const adapterSources = [...new Set(contracts.map(([path]) => path))]
      .map((path) => readFileSync(resolve(process.cwd(), path), "utf8"))
      .join("\n");
    const managerSource = readFileSync(resolve(process.cwd(), "src/providers/xeroClientManager.ts"), "utf8");
    const productionSources = typescriptSources(resolve(process.cwd(), "src"))
      .map((path) => ({ path, source: readFileSync(path, "utf8") }));
    const mutationSinks = productionSources.flatMap(({ path, source }) =>
      [...source.matchAll(/(?:accountingApi|api)\.((?:create|update|delete)[A-Z][A-Za-z0-9_]*)\(/gu)]
        .map((match) => `${path.slice(process.cwd().length + 1)}:${match[1]}`));
    const expectedSinks = [
      ...contracts.map(
        ([path, _method, _operation, _action, sdkMethod]) => `${path}:${sdkMethod}`,
      ),
      "src/providers/xeroTrackingMutationProvider.ts:createTrackingCategory",
      "src/providers/xeroTrackingMutationProvider.ts:updateTrackingCategory",
      "src/providers/xeroTrackingMutationProvider.ts:createTrackingOptions",
      "src/providers/xeroTrackingMutationProvider.ts:updateTrackingOptions",
    ];

    expect(mutationSinks.sort()).toEqual([...expectedSinks].sort());
    expect(adapterSources.match(/withWriteClient\(principal, (?:\{|authorization)/gu)).toHaveLength(contracts.length);
    expect(adapterSources).not.toContain("consumeXeroProviderWritePermitAtMutationBoundary(");
    expect(adapterSources).not.toContain("consumeLedgerProviderWritePermit(");
    expect(managerSource.match(/consumeXeroProviderWritePermitAtMutationBoundary\(\{/gu)).toHaveLength(1);
    expect(managerSource.indexOf("consumeXeroProviderWritePermitAtMutationBoundary({"))
      .toBeLessThan(managerSource.indexOf("let client = await this.#createClient(resolved);"));
    const readTokenCallers = productionSources
      .filter(({ path, source }) => !path.endsWith("/xeroClientManager.ts") && source.includes("readTokenSet().access_token"))
      .map(({ path }) => path.slice(process.cwd().length + 1));
    expect(readTokenCallers).toEqual([]);
    const accountingProviderSource = readFileSync(resolve(process.cwd(), "src/providers/xeroProvider.ts"), "utf8");
    const trialBalanceStart = accountingProviderSource.indexOf("  async getTrialBalance(");
    const trialBalanceEnd = accountingProviderSource.indexOf("\n  async ", trialBalanceStart + 10);
    const trialBalanceMethod = accountingProviderSource.slice(trialBalanceStart, trialBalanceEnd);
    expect(trialBalanceMethod).toContain("#manager.getTrialBalance(");
    expect(trialBalanceMethod).not.toContain("accessToken");
    expect(managerSource).not.toContain("withReadAccessToken");
    expect(managerSource).toContain("#trialBalanceTransport.getTrialBalance(");
    const trialBalanceTransport = readFileSync(
      resolve(process.cwd(), "src/providers/xeroTrialBalanceTransport.ts"),
      "utf8",
    );
    expect(trialBalanceTransport).toContain('method: "GET"');
    expect(trialBalanceTransport).not.toMatch(/method:\s*"(?:POST|PUT|PATCH|DELETE)"/u);
    expect(productionSources.map(({ source }) => source).join("\n")).not.toContain(".withAccessToken(");
    // The invoice update sink is a complete DRAFT-only replacement shared by
    // two separately permitted business actions; it cannot promote state.
    expect(accountingProviderSource.match(/accountingApi\.updateInvoice\(/gu)).toHaveLength(1);
    const draftInvoiceUpdateStart = accountingProviderSource.indexOf("  async #updateDraftInvoice(");
    const draftInvoiceUpdateEnd = accountingProviderSource.indexOf("\n  async ", draftInvoiceUpdateStart + 10);
    const draftInvoiceUpdateBody = accountingProviderSource.slice(draftInvoiceUpdateStart, draftInvoiceUpdateEnd);
    expect(draftInvoiceUpdateBody).toContain('"XeroAccountingProvider.updateDraftSupplierBill"');
    expect(draftInvoiceUpdateBody).toContain('"supplier_bill.update_draft"');
    expect(draftInvoiceUpdateBody).toContain('"XeroAccountingProvider.updateDraftSalesInvoice"');
    expect(draftInvoiceUpdateBody).toContain('"customer_invoice.update_draft"');
    expect(draftInvoiceUpdateBody).toContain("targetXeroObjectId: normalized.targetXeroObjectId");
    expect(draftInvoiceUpdateBody).toContain("expectedUpdatedAt");
    expect(draftInvoiceUpdateBody).toContain("replacement: normalized.replacementPayload");
    const transitionSource = readFileSync(
      resolve(process.cwd(), "src/providers/xeroControlledLedgerTransitionProvider.ts"),
      "utf8",
    );
    expect(transitionSource.match(/accountingApi\.updateInvoice\(/gu)).toHaveLength(1);
    expect(transitionSource.match(/accountingApi\.updateManualJournal\(/gu)).toHaveLength(1);
    expect(transitionSource).not.toContain("async setStatus");
    expect(transitionSource).toContain('"XeroControlledLedgerTransitionProvider.authoriseSalesInvoice"');
    expect(transitionSource).toContain('"customer_invoice.authorise"');
    expect(transitionSource).toContain('"XeroControlledLedgerTransitionProvider.authoriseSupplierBill"');
    expect(transitionSource).toContain('"supplier_bill.authorise"');
  });
});
