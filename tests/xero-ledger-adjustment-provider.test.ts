import { describe, expect, it, vi } from "vitest";
import { XeroLedgerAdjustmentProvider } from "../src/providers/xeroLedgerAdjustmentProvider.js";
import type { AccountingPrincipal } from "../src/providers/types.js";
import type {
  XeroClientManager,
  XeroProviderWriteAuthorization,
} from "../src/providers/xeroClientManager.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from "../src/security/xeroProviderWritePermitContext.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const connectionId = "connection-ledger-adjustment-provider-test";
const creditNoteId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const allocationId = "44444444-4444-4444-8444-444444444444";
const principal = providerWriteTestContext(connectionId);

const allocation = {
  creditNoteId,
  creditNoteType: "ACCRECCREDIT" as const,
  targetInvoiceId: invoiceId,
  targetInvoiceType: "ACCREC" as const,
  amount: "10.0000",
  allocationDate: "2026-08-20",
  expectedCreditStatus: "AUTHORISED" as const,
  expectedTargetStatus: "AUTHORISED" as const,
};

function managerFor(accountingApi: Record<string, unknown>): XeroClientManager {
  const connection = {
    provider: "xero" as const,
    tenantId,
    connectionId,
    tenantName: "Ledger adjustment test tenant",
    status: "ACTIVE" as const,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  };
  return {
    withWriteClient: async <T>(
      requestPrincipal: AccountingPrincipal,
      authorization: XeroProviderWriteAuthorization,
      callback: (client: unknown, resolvedConnection: unknown) => Promise<T>,
    ): Promise<T> => {
      consumeXeroProviderWritePermitAtMutationBoundary({
        ...authorization,
        principal: requestPrincipal,
        connection,
      });
      return callback({ accountingApi }, connection);
    },
    withClient: async <T>(
      _requestPrincipal: AccountingPrincipal,
      callback: (client: unknown, resolvedConnection: unknown) => Promise<T>,
    ): Promise<T> => callback({ accountingApi }, connection),
  } as unknown as XeroClientManager;
}

function permit(
  adapterOperation: Parameters<typeof issueProviderWriteTestPermit>[0]["adapterOperation"],
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

describe("XeroLedgerAdjustmentProvider", () => {
  it("persists a receipt target before GET-only allocation verification, then validates both exact IDs", async () => {
    const getCreditNote = vi.fn()
      .mockResolvedValueOnce({ body: { creditNotes: [{
        creditNoteID: creditNoteId,
        type: "ACCRECCREDIT",
        status: "AUTHORISED",
        contact: { contactID: "55555555-5555-4555-8555-555555555555" },
        currencyCode: "USD",
        remainingCredit: 100,
        allocations: [],
      }] } })
      .mockResolvedValueOnce({ body: { creditNotes: [{
        creditNoteID: creditNoteId,
        type: "ACCRECCREDIT",
        status: "AUTHORISED",
        contact: { contactID: "55555555-5555-4555-8555-555555555555" },
        currencyCode: "USD",
        remainingCredit: 90,
        allocations: [{
          allocationID: allocationId,
          invoice: { invoiceID: invoiceId },
          amount: 10,
          date: new Date("2026-08-20T00:00:00.000Z"),
        }],
      }] } });
    const getInvoices = vi.fn()
      .mockResolvedValueOnce({ body: { invoices: [{
        invoiceID: invoiceId,
        type: "ACCREC",
        status: "AUTHORISED",
        contact: { contactID: "55555555-5555-4555-8555-555555555555" },
        currencyCode: "USD",
        amountDue: 100,
      }] } })
      .mockResolvedValueOnce({ body: { invoices: [{
        invoiceID: invoiceId,
        type: "ACCREC",
        status: "AUTHORISED",
        contact: { contactID: "55555555-5555-4555-8555-555555555555" },
        currencyCode: "USD",
        amountDue: 90,
      }] } });
    const createCreditNoteAllocation = vi.fn().mockResolvedValue({
      response: { headers: { "xero-correlation-id": "allocation-correlation" } },
      body: { allocations: [{ allocationID: allocationId }] },
    });
    const provider = new XeroLedgerAdjustmentProvider(managerFor({
      getCreditNote,
      getInvoices,
      createCreditNoteAllocation,
    }));
    const requestId = "allocate-credit-note-1";

    const write = await provider.allocateCreditNote(
      principal,
      allocation,
      requestId,
      permit("XeroLedgerAdjustmentProvider.allocateCreditNote", requestId, allocation),
    );

    expect(write).toEqual({
      objectId: creditNoteId,
      status: "AUTHORISED",
      receipt: {
        operation: "ALLOCATE_CREDIT_NOTE",
        creditNoteId,
        targetInvoiceId: invoiceId,
        allocationId,
        providerRequestId: "allocation-correlation",
      },
    });
    expect(getCreditNote).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledTimes(1);
    expect(createCreditNoteAllocation).toHaveBeenCalledWith(
      tenantId,
      creditNoteId,
      { allocations: [{ invoice: { invoiceID: invoiceId }, amount: 10, date: "2026-08-20" }] },
      true,
      requestId,
    );

    await expect(provider.readAndVerifyAdjustment(
      principal,
      "credit_note.allocate",
      allocation,
      write.receipt,
    )).resolves.toMatchObject({ objectId: creditNoteId, status: "AUTHORISED" });
    expect(getCreditNote).toHaveBeenCalledTimes(2);
    expect(getInvoices).toHaveBeenCalledTimes(2);
  });

  it("rejects a paid invoice void during the exact pre-write read without sending an update", async () => {
    const voidInput = { invoiceId, invoiceType: "ACCREC" as const, expectedStatus: "AUTHORISED" as const };
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [{
      invoiceID: invoiceId,
      type: "ACCREC",
      status: "AUTHORISED",
      amountPaid: 1,
      amountCredited: 0,
      payments: [{ paymentID: "66666666-6666-4666-8666-666666666666" }],
    }] } });
    const updateInvoice = vi.fn();
    const provider = new XeroLedgerAdjustmentProvider(managerFor({ getInvoices, updateInvoice }));
    const requestId = "void-sales-invoice-paid";

    await expect(provider.voidSalesInvoice(
      principal,
      voidInput,
      requestId,
      permit("XeroLedgerAdjustmentProvider.voidSalesInvoice", requestId, voidInput),
    )).rejects.toMatchObject({ code: "STALE_PREFLIGHT", details: { providerMutationPossible: false } });
    expect(updateInvoice).not.toHaveBeenCalled();
  });

  it("unallocates one exact Credit Note allocation and verifies it disappears on a separate GET", async () => {
    const input = { creditNoteId, allocationId, expectedStatus: "AUTHORISED" as const };
    const getCreditNote = vi.fn()
      .mockResolvedValueOnce({ body: { creditNotes: [{
        creditNoteID: creditNoteId,
        status: "AUTHORISED",
        allocations: [{ allocationID: allocationId, invoice: { invoiceID: invoiceId }, amount: 10, date: "2026-08-20" }],
      }] } })
      .mockResolvedValueOnce({ body: { creditNotes: [{
        creditNoteID: creditNoteId,
        status: "AUTHORISED",
        allocations: [],
      }] } });
    const deleteCreditNoteAllocations = vi.fn().mockResolvedValue({
      response: { headers: { "xero-correlation-id": "unallocate-correlation" } },
      body: { allocationID: allocationId, isDeleted: true },
    });
    const provider = new XeroLedgerAdjustmentProvider(managerFor({ getCreditNote, deleteCreditNoteAllocations }));
    const requestId = "unallocate-credit-note-1";
    const write = await provider.unallocateCreditNote(
      principal,
      input,
      requestId,
      permit("XeroLedgerAdjustmentProvider.unallocateCreditNote", requestId, input),
    );
    expect(write).toEqual({
      objectId: creditNoteId,
      status: "AUTHORISED",
      receipt: {
        operation: "UNALLOCATE_CREDIT_NOTE",
        creditNoteId,
        allocationId,
        allocationDeleted: true,
        providerRequestId: "unallocate-correlation",
      },
    });
    expect(deleteCreditNoteAllocations).toHaveBeenCalledWith(tenantId, creditNoteId, allocationId);
    await expect(provider.readAndVerifyAdjustment(principal, "credit_note.unallocate", input, write.receipt))
      .resolves.toMatchObject({ objectId: creditNoteId, status: "AUTHORISED", snapshot: { allocationRemoved: true } });
    expect(getCreditNote).toHaveBeenCalledTimes(2);
  });

  it("marks a transport interruption after the void mutation starts as unknown", async () => {
    const voidInput = { invoiceId, invoiceType: "ACCREC" as const, expectedStatus: "AUTHORISED" as const };
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [{
      invoiceID: invoiceId,
      type: "ACCREC",
      status: "AUTHORISED",
      amountPaid: 0,
      amountCredited: 0,
      payments: [],
      creditNotes: [],
      prepayments: [],
      overpayments: [],
    }] } });
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const updateInvoice = vi.fn().mockRejectedValue(timeout);
    const provider = new XeroLedgerAdjustmentProvider(managerFor({ getInvoices, updateInvoice }));
    const requestId = "void-sales-invoice-timeout";

    await expect(provider.voidSalesInvoice(
      principal,
      voidInput,
      requestId,
      permit("XeroLedgerAdjustmentProvider.voidSalesInvoice", requestId, voidInput),
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
    expect(updateInvoice).toHaveBeenCalledOnce();
  });
});
