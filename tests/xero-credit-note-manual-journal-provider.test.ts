import { describe, expect, it, vi } from "vitest";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
} from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import {
  XeroCreditNoteManualJournalProvider,
} from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const revenueAccountId = "33333333-3333-4333-8333-333333333333";
const expenseAccountId = "44444444-4444-4444-8444-444444444444";
const creditNoteId = "55555555-5555-4555-8555-555555555555";
const manualJournalId = "66666666-6666-4666-8666-666666666666";

const credit = buildCreditNoteDraftPrimitive({
  source_ref: "work-material:provider-credit",
  source_unit_key: "provider-credit:1",
  reason: "Service credit",
  credit_note_type: "ACCRECCREDIT",
  contact_id: contactId,
  credit_note_date: "2026-08-07",
  currency: "SGD",
  reference: "PROVIDER-CN-001",
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
      callback({ accountingApi }, { tenantId }),
  } as unknown as XeroClientManager;
}

describe("XeroCreditNoteManualJournalProvider", () => {
  it("uses idempotent DRAFT creates and exact GET readback for both object types", async () => {
    const creditRaw = {
      creditNoteID: creditNoteId,
      type: "ACCRECCREDIT",
      status: "DRAFT",
      contact: { contactID: contactId },
      date: "2026-08-07",
      currencyCode: "SGD",
      reference: "PROVIDER-CN-001",
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

    await expect(provider.createCreditNoteDraft("actor", credit.canonicalPayload, "idem-credit")).resolves.toEqual({
      objectId: creditNoteId,
      receipt: { operation: "CREATE_CREDIT_NOTE_DRAFT", creditNoteId, providerRequestId: "corr-credit" },
    });
    expect(createCreditNotes).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({ creditNotes: [expect.objectContaining({ status: "DRAFT" })] }),
      true,
      4,
      "idem-credit",
    );
    await expect(provider.readAndVerifyCreditNoteDraft("actor", creditNoteId, credit.canonicalPayload))
      .resolves.toMatchObject({ ok: true, snapshot: { creditNoteId } });
    expect(getCreditNote).toHaveBeenCalledWith(tenantId, creditNoteId, 4);

    await expect(provider.createManualJournalDraft("actor", journal.canonicalPayload, "idem-journal")).resolves.toEqual({
      objectId: manualJournalId,
      receipt: { operation: "CREATE_MANUAL_JOURNAL_DRAFT", manualJournalId, providerRequestId: "corr-journal" },
    });
    expect(createManualJournals).toHaveBeenCalledWith(
      tenantId,
      expect.objectContaining({ manualJournals: [expect.objectContaining({ status: "DRAFT" })] }),
      true,
      "idem-journal",
    );
    await expect(provider.readAndVerifyManualJournalDraft("actor", manualJournalId, journal.canonicalPayload))
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
    await expect(rejected.createCreditNoteDraft("actor", credit.canonicalPayload, "idem-rejected"))
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
    await expect(unknown.createManualJournalDraft("actor", journal.canonicalPayload, "idem-unknown"))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
  });
});
