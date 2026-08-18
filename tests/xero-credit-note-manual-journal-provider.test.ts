import { describe, expect, it, vi } from "vitest";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
} from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import {
  XeroCreditNoteManualJournalProvider,
} from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const revenueAccountId = "33333333-3333-4333-8333-333333333333";
const expenseAccountId = "44444444-4444-4444-8444-444444444444";
const creditNoteId = "55555555-5555-4555-8555-555555555555";
const manualJournalId = "66666666-6666-4666-8666-666666666666";
const connectionId = "connection-credit-journal-provider-test";
const principal = providerWriteTestContext(connectionId);

const credit = buildCreditNoteDraftPrimitive({
  source_ref: "work-material:provider-credit",
  source_unit_key: "provider-credit:1",
  reason: "Service credit",
  credit_note_type: "ACCRECCREDIT",
  contact_id: contactId,
  credit_note_date: "2026-08-07",
  currency: "SGD",
  reference: "PROVIDER-CN-001",
  authoritative_provider_field: "CREDIT_NOTE_NUMBER",
  line_amount_type: "Exclusive",
  lines: [{
    description: "Service credit",
    quantity: 1,
    unit_amount: 125.5,
    account_id: revenueAccountId,
    account_code: "200",
    tax_type: "OUTPUT",
  }],
});

const supplierCredit = buildCreditNoteDraftPrimitive({
  source_ref: "work-material:provider-supplier-credit",
  source_unit_key: "provider-supplier-credit:1",
  reason: "Supplier credit",
  credit_note_type: "ACCPAYCREDIT",
  contact_id: contactId,
  credit_note_date: "2026-08-07",
  currency: "SGD",
  reference: "PROVIDER-SCN-001",
  authoritative_provider_field: "CREDIT_NOTE_NUMBER",
  line_amount_type: "NoTax",
  lines: [{
    description: "Supplier credit",
    quantity: 1,
    unit_amount: 125.5,
    account_id: expenseAccountId,
    account_code: "400",
    tax_type: "NONE",
  }],
});

const journal = buildManualJournalDraftPrimitive({
  source_ref: "work-material:provider-journal",
  source_unit_key: "provider-journal:1",
  journal_date: "2026-08-07",
  narration: "Accrual",
  lines: [
    { account_id: expenseAccountId, account_code: "400", description: "Debit", line_amount: 125.5 },
    { account_id: revenueAccountId, account_code: "200", description: "Credit", line_amount: -125.5 },
  ],
});

function managerFor(accountingApi: Record<string, unknown>): XeroClientManager {
  return {
    withClient: async (_principal: unknown, callback: (client: unknown, connection: unknown) => unknown) =>
      callback({ accountingApi }, { tenantId, connectionId }),
    withWriteClient: async (
      _principal: unknown,
      _authorization: unknown,
      callback: (client: unknown, connection: unknown) => unknown,
    ) => callback({ accountingApi }, { tenantId, connectionId }),
  } as unknown as XeroClientManager;
}

function permit(
  adapterOperation:
    | "XeroCreditNoteManualJournalProvider.createCreditNoteDraft"
    | "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
  mutationRequestId: string,
  canonicalPayload: unknown,
) {
  return issueProviderWriteTestPermit({
    adapterOperation,
    mutationRequestId,
    canonicalPayload,
    tenantId,
    connectionId,
  });
}

describe("XeroCreditNoteManualJournalProvider", () => {
  it("creates and exactly reads an ACCPAYCREDIT identifier through CreditNoteNumber only", async () => {
    const createCreditNotes = vi.fn(async () => ({
      response: { headers: { "xero-correlation-id": "corr-supplier-credit" } },
      body: { creditNotes: [{ creditNoteID: creditNoteId }] },
    }));
    const getCreditNote = vi.fn(async () => ({
      response: {},
      body: { creditNotes: [{
        creditNoteID: creditNoteId,
        type: "ACCPAYCREDIT",
        status: "DRAFT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        currencyCode: "SGD",
        creditNoteNumber: "PROVIDER-SCN-001",
        lineAmountTypes: "NoTax",
        lineItems: [{
          description: "Supplier credit",
          quantity: 1,
          unitAmount: 125.5,
          lineAmount: 125.5,
          taxAmount: 0,
          accountID: expenseAccountId,
          accountCode: "400",
          taxType: "NONE",
        }],
        subTotal: 125.5,
        totalTax: 0,
        total: 125.5,
        remainingCredit: 125.5,
        appliedAmount: 0,
        sentToContact: false,
        allocations: [],
        payments: [],
        hasErrors: false,
        validationErrors: [],
      }] },
    }));
    const provider = new XeroCreditNoteManualJournalProvider(managerFor({ createCreditNotes, getCreditNote }));

    await expect(provider.createCreditNoteDraft(
      principal,
      supplierCredit.canonicalPayload,
      "xmr-supplier-credit",
      permit(
        "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
        "xmr-supplier-credit",
        supplierCredit.canonicalPayload,
      ),
    )).resolves.toMatchObject({ objectId: creditNoteId });
    const created = createCreditNotes.mock.calls[0]?.[1] as {
      creditNotes?: Array<Record<string, unknown>>;
    };
    expect(created.creditNotes?.[0]).toMatchObject({ creditNoteNumber: "PROVIDER-SCN-001" });
    expect(created.creditNotes?.[0]).not.toHaveProperty("reference");
    await expect(provider.readAndVerifyCreditNoteDraft(
      principal,
      creditNoteId,
      supplierCredit.canonicalPayload,
    )).resolves.toMatchObject({ ok: true });
  });

  it("uses idempotent DRAFT creates and exact GET readback for both object types", async () => {
    const creditRaw = {
      creditNoteID: creditNoteId,
      type: "ACCRECCREDIT",
      status: "DRAFT",
      contact: { contactID: contactId },
      date: "2026-08-07",
      currencyCode: "SGD",
      creditNoteNumber: "PROVIDER-CN-001",
      lineAmountTypes: "Exclusive",
      lineItems: [{
        description: "Service credit",
        quantity: 1,
        unitAmount: 125.5,
        lineAmount: 125.5,
        taxAmount: 0,
        accountID: revenueAccountId,
        accountCode: "200",
        taxType: "OUTPUT",
      }],
      subTotal: 125.5,
      totalTax: 0,
      total: 125.5,
      remainingCredit: 125.5,
      appliedAmount: 0,
      sentToContact: false,
      allocations: [],
      payments: [],
      hasErrors: false,
      validationErrors: [],
    };
    const journalRaw = {
      manualJournalID: manualJournalId,
      status: "DRAFT",
      date: "2026-08-07",
      narration: "Accrual",
      lineAmountTypes: "NoTax",
      showOnCashBasisReports: false,
      hasAttachments: false,
      attachments: [],
      validationErrors: [],
      journalLines: [
        {
          accountID: expenseAccountId,
          accountCode: "400",
          description: "Debit",
          lineAmount: 125.5,
          taxType: "NONE",
          taxAmount: 0,
        },
        {
          accountID: revenueAccountId,
          accountCode: "200",
          description: "Credit",
          lineAmount: -125.5,
          taxType: "NONE",
          taxAmount: 0,
        },
      ],
    };
    const createCreditNotes = vi.fn(async () => ({
      response: { headers: { "xero-correlation-id": "corr-credit" } },
      body: { creditNotes: [{ creditNoteID: creditNoteId }] },
    }));
    const getCreditNote = vi.fn(async () => ({ response: {}, body: { creditNotes: [creditRaw] } }));
    const createManualJournals = vi.fn(async () => ({
      response: { headers: { "x-request-id": "corr-journal" } },
      body: { manualJournals: [{ manualJournalID: manualJournalId }] },
    }));
    const getManualJournal = vi.fn(async () => ({ response: {}, body: { manualJournals: [journalRaw] } }));
    const provider = new XeroCreditNoteManualJournalProvider(managerFor({
      createCreditNotes,
      getCreditNote,
      createManualJournals,
      getManualJournal,
    }));

    await expect(provider.createCreditNoteDraft(
      principal,
      credit.canonicalPayload,
      "xmr-credit",
      permit(
        "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
        "xmr-credit",
        credit.canonicalPayload,
      ),
    )).resolves.toEqual({
      objectId: creditNoteId,
      receipt: { operation: "CREATE_CREDIT_NOTE_DRAFT", creditNoteId, providerRequestId: "corr-credit" },
    });
    expect(createCreditNotes).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({
        creditNotes: [expect.objectContaining({
          status: "DRAFT",
          creditNoteNumber: "PROVIDER-CN-001",
        })],
      }),
      true,
      4,
      "xmr-credit",
    );
    await expect(provider.readAndVerifyCreditNoteDraft(principal, creditNoteId, credit.canonicalPayload))
      .resolves.toMatchObject({ ok: true, snapshot: { creditNoteId } });
    expect(getCreditNote).toHaveBeenCalledWith(tenantId, creditNoteId, 4);

    await expect(provider.createManualJournalDraft(
      principal,
      journal.canonicalPayload,
      "xmr-journal",
      permit(
        "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
        "xmr-journal",
        journal.canonicalPayload,
      ),
    )).resolves.toEqual({
      objectId: manualJournalId,
      receipt: { operation: "CREATE_MANUAL_JOURNAL_DRAFT", manualJournalId, providerRequestId: "corr-journal" },
    });
    expect(createManualJournals).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({ manualJournals: [expect.objectContaining({ status: "DRAFT" })] }),
      true,
      "xmr-journal",
    );
    await expect(provider.readAndVerifyManualJournalDraft(principal, manualJournalId, journal.canonicalPayload))
      .resolves.toMatchObject({ ok: true, snapshot: { manualJournalId, balanceVerified: true } });
    expect(getManualJournal).toHaveBeenCalledWith(tenantId, manualJournalId);
  });

  it("distinguishes a definite Xero validation rejection from an unknown transport outcome", async () => {
    const rejected = new XeroCreditNoteManualJournalProvider(managerFor({
      createCreditNotes: vi.fn(async () => ({
        response: {},
        body: { creditNotes: [{ hasErrors: true, validationErrors: [{ message: "invalid" }] }] },
      })),
    }));
    await expect(rejected.createCreditNoteDraft(
      principal,
      credit.canonicalPayload,
      "xmr-rejected",
      permit(
        "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
        "xmr-rejected",
        credit.canonicalPayload,
      ),
    ))
      .rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        retryable: false,
        details: { writeOutcome: "DEFINITELY_REJECTED", validationErrorCount: 1 },
      });

    const unknown = new XeroCreditNoteManualJournalProvider(managerFor({
      createManualJournals: vi.fn(async () => {
        const error = new Error("socket timed out") as Error & { code: string };
        error.code = "ETIMEDOUT";
        throw error;
      }),
    }));
    await expect(unknown.createManualJournalDraft(
      principal,
      journal.canonicalPayload,
      "xmr-unknown",
      permit(
        "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
        "xmr-unknown",
        journal.canonicalPayload,
      ),
    ))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
  });
});
