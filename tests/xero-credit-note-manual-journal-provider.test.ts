import { describe, expect, it, vi } from "vitest";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
} from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import {
  XeroCreditNoteManualJournalProvider,
} from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";
import type { LedgerProviderWritePermit } from "../src/security/xeroProviderWritePermit.js";
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
const expectedUpdatedAt = "2026-08-07T00:00:00.000Z";
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

function creditNoteReadback(overrides: Record<string, unknown> = {}) {
  return {
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
    updatedDateUTC: new Date(expectedUpdatedAt),
    ...overrides,
  };
}

function manualJournalReadback(overrides: Record<string, unknown> = {}) {
  return {
    manualJournalID: manualJournalId,
    status: "DRAFT",
    date: "2026-08-07",
    narration: "Accrual",
    lineAmountTypes: "NoTax",
    showOnCashBasisReports: false,
    hasAttachments: false,
    attachments: [],
    validationErrors: [],
    updatedDateUTC: new Date(expectedUpdatedAt),
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
    ...overrides,
  };
}

function managerFor(
  accountingApi: Record<string, unknown>,
  authorizationSink?: (authorization: unknown) => void,
): XeroClientManager {
  return {
    withClient: async (_principal: unknown, callback: (client: unknown, connection: unknown) => unknown) =>
      callback({ accountingApi }, { tenantId, connectionId }),
    withWriteClient: async (
      _principal: unknown,
      authorization: unknown,
      callback: (client: unknown, connection: unknown) => unknown,
    ) => {
      authorizationSink?.(authorization);
      return callback({ accountingApi }, { tenantId, connectionId });
    },
  } as unknown as XeroClientManager;
}

function permit(
  adapterOperation:
    | "XeroCreditNoteManualJournalProvider.createCreditNoteDraft"
    | "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft"
    | "XeroCreditNoteManualJournalProvider.createManualJournalDraft"
    | "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
  mutationRequestId: string,
  canonicalPayload: unknown,
) {
  if (adapterOperation.includes("update")) return {} as LedgerProviderWritePermit;
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

  it("replaces both drafts through exact same-ID UPDATE calls and returns durable receipts", async () => {
    const creditState = creditNoteReadback();
    const journalState = manualJournalReadback();
    const getCreditNote = vi.fn(async () => ({ body: { creditNotes: [creditState] } }));
    const getManualJournal = vi.fn(async () => ({ body: { manualJournals: [journalState] } }));
    const updateCreditNote = vi.fn(async () => ({
      response: { headers: { "xero-correlation-id": "corr-credit-update" } },
      body: { creditNotes: [creditState] },
    }));
    const updateManualJournal = vi.fn(async () => ({
      response: { headers: { "x-request-id": "corr-journal-update" } },
      body: { manualJournals: [journalState] },
    }));
    const authorizations: unknown[] = [];
    const provider = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote,
      updateCreditNote,
      getManualJournal,
      updateManualJournal,
    }, (authorization) => authorizations.push(authorization)));

    await expect(provider.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-credit-update",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-credit-update",
        credit.canonicalPayload,
      ),
    )).resolves.toEqual({
      objectId: creditNoteId,
      receipt: {
        operation: "UPDATE_CREDIT_NOTE_DRAFT",
        creditNoteId,
        status: "DRAFT",
        providerRequestId: "corr-credit-update",
      },
    });
    // The update path performs exactly one write-client preflight GET. The
    // receipt is returned immediately after the same-ID UPDATE response so a
    // later canonical readback cannot erase the provider correlation receipt.
    expect(getCreditNote).toHaveBeenCalledTimes(1);
    expect(updateCreditNote).toHaveBeenCalledWith(
      tenantId,
      creditNoteId,
      expect.objectContaining({
        creditNotes: [expect.objectContaining({
          creditNoteID: creditNoteId,
          type: "ACCRECCREDIT",
          status: "DRAFT",
          contact: { contactID: contactId },
          lineItems: [expect.objectContaining({ accountID: revenueAccountId, accountCode: "200" })],
        })],
      }),
      4,
      "xmr-credit-update",
    );

    await expect(provider.updateManualJournalDraft(
      principal,
      manualJournalId,
      expectedUpdatedAt,
      journal.canonicalPayload,
      "xmr-journal-update",
      permit(
        "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
        "xmr-journal-update",
        journal.canonicalPayload,
      ),
    )).resolves.toEqual({
      objectId: manualJournalId,
      receipt: {
        operation: "UPDATE_MANUAL_JOURNAL_DRAFT",
        manualJournalId,
        status: "DRAFT",
        providerRequestId: "corr-journal-update",
      },
    });
    expect(getManualJournal).toHaveBeenCalledTimes(1);
    expect(updateManualJournal).toHaveBeenCalledWith(
      tenantId,
      manualJournalId,
      expect.objectContaining({
        manualJournals: [expect.objectContaining({
          manualJournalID: manualJournalId,
          status: "DRAFT",
          lineAmountTypes: "NoTax",
          showOnCashBasisReports: false,
          journalLines: [expect.objectContaining({ taxType: "NONE" }), expect.objectContaining({ taxType: "NONE" })],
        })],
      }),
      "xmr-journal-update",
    );
    expect(authorizations).toEqual([
      expect.objectContaining({
        adapterOperation: "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        actionId: "credit_note.update_draft",
        mutationRequestId: "xmr-credit-update",
        providerIdempotencyKey: "xmr-credit-update",
        canonicalPayload: {
          targetXeroObjectId: creditNoteId,
          expectedUpdatedAt,
          replacement: credit.canonicalPayload,
        },
      }),
      expect.objectContaining({
        adapterOperation: "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
        actionId: "manual_journal.update_draft",
        mutationRequestId: "xmr-journal-update",
        providerIdempotencyKey: "xmr-journal-update",
        canonicalPayload: {
          targetXeroObjectId: manualJournalId,
          expectedUpdatedAt,
          replacement: journal.canonicalPayload,
        },
      }),
    ]);
  });

  it("rejects an invalid target, stale credit type, and non-DRAFT target without UPDATE or CREATE fallback", async () => {
    const updateCreditNote = vi.fn();
    const getCreditNote = vi.fn(async () => ({ body: { creditNotes: [creditNoteReadback()] } }));
    const provider = new XeroCreditNoteManualJournalProvider(managerFor({ getCreditNote, updateCreditNote }));

    await expect(provider.updateCreditNoteDraft(
      principal,
      "not-a-uuid",
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-invalid-target",
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(getCreditNote).not.toHaveBeenCalled();
    expect(updateCreditNote).not.toHaveBeenCalled();

    await expect(provider.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      supplierCredit.canonicalPayload,
      "xmr-type-mismatch",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-type-mismatch",
        supplierCredit.canonicalPayload,
      ),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { writeOutcome: "DEFINITELY_REJECTED" },
    });
    expect(updateCreditNote).not.toHaveBeenCalled();

    const postedGet = vi.fn(async () => ({ body: { creditNotes: [creditNoteReadback({ status: "AUTHORISED" })] } }));
    const postedUpdate = vi.fn();
    const posted = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: postedGet,
      updateCreditNote: postedUpdate,
    }));
    await expect(posted.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-posted-target",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-posted-target",
        credit.canonicalPayload,
      ),
    )).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(postedUpdate).not.toHaveBeenCalled();

    const staleUpdate = vi.fn();
    const stale = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: vi.fn(async () => ({
        body: { creditNotes: [creditNoteReadback({ updatedDateUTC: new Date("2026-08-07T00:00:01.000Z") })] },
      })),
      updateCreditNote: staleUpdate,
    }));
    await expect(stale.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-stale-credit",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-stale-credit",
        credit.canonicalPayload,
      ),
    )).rejects.toMatchObject({
      code: "CONFLICT",
      httpStatus: 409,
      details: {
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
        reasonCodes: ["STALE_DRAFT_VERSION"],
      },
    });
    expect(staleUpdate).not.toHaveBeenCalled();

    const missingVersionUpdate = vi.fn();
    const missingVersion = new XeroCreditNoteManualJournalProvider(managerFor({
      getManualJournal: vi.fn(async () => ({
        body: { manualJournals: [manualJournalReadback({ updatedDateUTC: undefined, updatedDateUTCString: undefined })] },
      })),
      updateManualJournal: missingVersionUpdate,
    }));
    await expect(missingVersion.updateManualJournalDraft(
      principal,
      manualJournalId,
      expectedUpdatedAt,
      journal.canonicalPayload,
      "xmr-missing-journal-version",
      permit(
        "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
        "xmr-missing-journal-version",
        journal.canonicalPayload,
      ),
    )).rejects.toMatchObject({
      code: "CONFLICT",
      httpStatus: 409,
      details: {
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
        reasonCodes: ["STALE_DRAFT_VERSION"],
      },
    });
    expect(missingVersionUpdate).not.toHaveBeenCalled();
  });

  it("classifies UPDATE rejection, transport uncertainty, and canonical readback drift separately", async () => {
    const rejected = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: vi.fn(async () => ({ body: { creditNotes: [creditNoteReadback()] } })),
      updateCreditNote: vi.fn(async () => ({
        response: {},
        body: { creditNotes: [{ creditNoteID: creditNoteId, hasErrors: true, validationErrors: [{ message: "invalid" }] }] },
      })),
    }));
    await expect(rejected.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-update-rejected",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-update-rejected",
        credit.canonicalPayload,
      ),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { writeOutcome: "DEFINITELY_REJECTED", validationErrorCount: 1 },
    });

    const timedOutUpdate = vi.fn(async () => {
      const error = new Error("socket timed out") as Error & { code: string };
      error.code = "ETIMEDOUT";
      throw error;
    });
    const unknown = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: vi.fn(async () => ({ body: { creditNotes: [creditNoteReadback()] } })),
      updateCreditNote: timedOutUpdate,
    }));
    await expect(unknown.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-update-unknown",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-update-unknown",
        credit.canonicalPayload,
      ),
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
    expect(timedOutUpdate).toHaveBeenCalledOnce();

    const preflightTimeout = Object.assign(new Error("preflight timed out"), { code: "ETIMEDOUT" });
    const preflightGet = vi.fn().mockRejectedValue(preflightTimeout);
    const preflightUpdate = vi.fn();
    const unavailable = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: preflightGet,
      updateCreditNote: preflightUpdate,
    }));
    await expect(unavailable.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-preflight-unavailable",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-preflight-unavailable",
        credit.canonicalPayload,
      ),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
      httpStatus: 503,
      details: {
        providerMutationPossible: false,
        reasonCodes: ["EXACT_DRAFT_TARGET_UNAVAILABLE"],
      },
    });
    expect(preflightUpdate).not.toHaveBeenCalled();

    let readbackStatus = "DRAFT";
    const driftedGet = vi.fn(async () => ({ body: { creditNotes: [creditNoteReadback({ status: readbackStatus })] } }));
    const drifted = new XeroCreditNoteManualJournalProvider(managerFor({
      getCreditNote: driftedGet,
      updateCreditNote: vi.fn(async () => {
        readbackStatus = "AUTHORISED";
        return { response: {}, body: { creditNotes: [creditNoteReadback()] } };
      }),
    }));
    await expect(drifted.updateCreditNoteDraft(
      principal,
      creditNoteId,
      expectedUpdatedAt,
      credit.canonicalPayload,
      "xmr-update-readback-drift",
      permit(
        "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
        "xmr-update-readback-drift",
        credit.canonicalPayload,
      ),
    )).resolves.toMatchObject({
      objectId: creditNoteId,
      receipt: {
        operation: "UPDATE_CREDIT_NOTE_DRAFT",
        creditNoteId,
        status: "DRAFT",
      },
    });
    expect(driftedGet).toHaveBeenCalledTimes(1);
    await expect(drifted.readAndVerifyCreditNoteDraft(
      principal,
      creditNoteId,
      credit.canonicalPayload,
    )).resolves.toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });
    expect(driftedGet).toHaveBeenCalledTimes(2);
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
