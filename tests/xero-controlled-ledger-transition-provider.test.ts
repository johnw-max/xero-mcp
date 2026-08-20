import { describe, expect, it, vi } from "vitest";
import { XeroControlledLedgerTransitionProvider } from "../src/providers/xeroControlledLedgerTransitionProvider.js";
import { expectedXeroMutationReadbackStatus } from "../src/domain/xeroMutation.js";
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
const connectionId = "connection-ledger-transition-provider-test";
const salesInvoiceId = "22222222-2222-4222-8222-222222222222";
const supplierBillId = "33333333-3333-4333-8333-333333333333";
const manualJournalId = "44444444-4444-4444-8444-444444444444";
const principal = providerWriteTestContext(connectionId);

const salesInvoice = { invoiceId: salesInvoiceId, invoiceType: "ACCREC" as const, expectedStatus: "DRAFT" as const };
const supplierBill = { invoiceId: supplierBillId, invoiceType: "ACCPAY" as const, expectedStatus: "DRAFT" as const };
const manualJournal = { manualJournalId, expectedStatus: "DRAFT" as const };

function managerFor(accountingApi: Record<string, unknown>): XeroClientManager {
  const connection = {
    provider: "xero" as const,
    tenantId,
    connectionId,
    tenantName: "Ledger transition test tenant",
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
  } as unknown as XeroClientManager;
}

function permit(
  adapterOperation:
    | "XeroControlledLedgerTransitionProvider.authoriseSalesInvoice"
    | "XeroControlledLedgerTransitionProvider.authoriseSupplierBill"
    | "XeroControlledLedgerTransitionProvider.postManualJournal",
  mutationRequestId: string,
  canonicalPayload: unknown,
) {
  return issueProviderWriteTestPermit({ adapterOperation, mutationRequestId, canonicalPayload, tenantId, connectionId });
}

describe("XeroControlledLedgerTransitionProvider", () => {
  it("derives readback state from the closed transition operation while retaining DRAFT creates", () => {
    expect(expectedXeroMutationReadbackStatus("SALES_INVOICE", "CREATE_DRAFT")).toBe("DRAFT");
    expect(expectedXeroMutationReadbackStatus("SUPPLIER_BILL", "AUTHORISE")).toBe("AUTHORISED");
    expect(expectedXeroMutationReadbackStatus("MANUAL_JOURNAL", "POST")).toBe("POSTED");
  });

  it("authorises an ACCREC invoice and returns its receipt before the service-owned readback", async () => {
    const getInvoices = vi.fn()
      .mockResolvedValueOnce({ body: { invoices: [{ invoiceID: salesInvoiceId, type: "ACCREC", status: "DRAFT" }] } })
      .mockResolvedValueOnce({ body: { invoices: [{ invoiceID: salesInvoiceId, type: "ACCREC", status: "AUTHORISED" }] } });
    const updateInvoice = vi.fn().mockResolvedValue({
      response: { headers: { "xero-correlation-id": "authorise-sales-correlation" } },
      body: { invoices: [{ invoiceID: salesInvoiceId, status: "AUTHORISED" }] },
    });
    const provider = new XeroControlledLedgerTransitionProvider(managerFor({ getInvoices, updateInvoice }));
    const requestId = "transition-sales-authorise";

    await expect(provider.authoriseSalesInvoice(
      principal,
      salesInvoice,
      requestId,
      permit("XeroControlledLedgerTransitionProvider.authoriseSalesInvoice", requestId, salesInvoice),
    )).resolves.toEqual({
      objectId: salesInvoiceId,
      status: "AUTHORISED",
      receipt: {
        operation: "AUTHORISE_SALES_INVOICE",
        invoiceId: salesInvoiceId,
        providerRequestId: "authorise-sales-correlation",
      },
    });
    expect(updateInvoice).toHaveBeenCalledWith(
      tenantId,
      salesInvoiceId,
      { invoices: [{ status: "AUTHORISED" }] },
      4,
      requestId,
    );
    expect(getInvoices).toHaveBeenCalledTimes(1);
  });

  it("cannot use a sales-draft permit to authorise the exact same invoice", async () => {
    const getInvoices = vi.fn();
    const updateInvoice = vi.fn();
    const provider = new XeroControlledLedgerTransitionProvider(managerFor({ getInvoices, updateInvoice }));
    const requestId = "transition-draft-permit-rejected";
    const draftPermit = issueProviderWriteTestPermit({
      adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
      mutationRequestId: requestId,
      canonicalPayload: salesInvoice,
      tenantId,
      connectionId,
    });

    await expect(provider.authoriseSalesInvoice(principal, salesInvoice, requestId, draftPermit))
      .rejects.toMatchObject({ code: "FORBIDDEN", details: { providerMutationPossible: false } });
    expect(getInvoices).not.toHaveBeenCalled();
    expect(updateInvoice).not.toHaveBeenCalled();
  });

  it("authorises an ACCPAY bill and rejects a stale state before its update call", async () => {
    const updateInvoice = vi.fn().mockResolvedValue({ response: {}, body: { invoices: [{}] } });
    const authorisedReadback = vi.fn()
      .mockResolvedValueOnce({ body: { invoices: [{ invoiceID: supplierBillId, type: "ACCPAY", status: "DRAFT" }] } })
      .mockResolvedValueOnce({ body: { invoices: [{ invoiceID: supplierBillId, type: "ACCPAY", status: "AUTHORISED" }] } });
    const provider = new XeroControlledLedgerTransitionProvider(managerFor({ getInvoices: authorisedReadback, updateInvoice }));
    const requestId = "transition-bill-authorise";
    await expect(provider.authoriseSupplierBill(
      principal,
      supplierBill,
      requestId,
      permit("XeroControlledLedgerTransitionProvider.authoriseSupplierBill", requestId, supplierBill),
    )).resolves.toMatchObject({ objectId: supplierBillId, status: "AUTHORISED" });
    expect(updateInvoice).toHaveBeenCalledOnce();

    const staleUpdate = vi.fn();
    const staleProvider = new XeroControlledLedgerTransitionProvider(managerFor({
      getInvoices: vi.fn().mockResolvedValue({
        body: { invoices: [{ invoiceID: supplierBillId, type: "ACCPAY", status: "AUTHORISED" }] },
      }),
      updateInvoice: staleUpdate,
    }));
    const staleRequestId = "transition-bill-stale";
    await expect(staleProvider.authoriseSupplierBill(
      principal,
      supplierBill,
      staleRequestId,
      permit("XeroControlledLedgerTransitionProvider.authoriseSupplierBill", staleRequestId, supplierBill),
    )).rejects.toMatchObject({ code: "CONFLICT", details: { expectedStatus: "DRAFT", actualStatus: "AUTHORISED" } });
    expect(staleUpdate).not.toHaveBeenCalled();
  });

  it("classifies xero-node's serialized validation rejection as definitely rejected", async () => {
    const updateInvoice = vi.fn().mockRejectedValue(JSON.stringify({
      response: {
        statusCode: 400,
        body: { ErrorNumber: 10, Type: "ValidationException", Message: "Invoice cannot be authorised" },
      },
      body: { ErrorNumber: 10, Type: "ValidationException", Message: "Invoice cannot be authorised" },
    }));
    const provider = new XeroControlledLedgerTransitionProvider(managerFor({
      getInvoices: vi.fn().mockResolvedValue({
        body: { invoices: [{ invoiceID: supplierBillId, type: "ACCPAY", status: "DRAFT" }] },
      }),
      updateInvoice,
    }));
    const requestId = "transition-bill-serialized-validation-rejection";

    await expect(provider.authoriseSupplierBill(
      principal,
      supplierBill,
      requestId,
      permit("XeroControlledLedgerTransitionProvider.authoriseSupplierBill", requestId, supplierBill),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { writeOutcome: "DEFINITELY_REJECTED" },
    });
    expect(updateInvoice).toHaveBeenCalledOnce();
  });

  it("posts a manual journal with an exact POSTED readback and preserves unknown write outcomes", async () => {
    const getManualJournal = vi.fn()
      .mockResolvedValueOnce({ body: { manualJournals: [{ manualJournalID: manualJournalId, narration: "Month end", status: "DRAFT" }] } })
      .mockResolvedValueOnce({ body: { manualJournals: [{ manualJournalID: manualJournalId, narration: "Month end", status: "POSTED" }] } });
    const updateManualJournal = vi.fn().mockResolvedValue({
      response: { headers: { "x-request-id": "post-journal-request" } },
      body: { manualJournals: [{ manualJournalID: manualJournalId, status: "POSTED" }] },
    });
    const provider = new XeroControlledLedgerTransitionProvider(managerFor({ getManualJournal, updateManualJournal }));
    const requestId = "transition-journal-post";
    await expect(provider.postManualJournal(
      principal,
      manualJournal,
      requestId,
      permit("XeroControlledLedgerTransitionProvider.postManualJournal", requestId, manualJournal),
    )).resolves.toEqual({
      objectId: manualJournalId,
      status: "POSTED",
      receipt: {
        operation: "POST_MANUAL_JOURNAL",
        manualJournalId,
        providerRequestId: "post-journal-request",
      },
    });
    expect(updateManualJournal).toHaveBeenCalledWith(
      tenantId,
      manualJournalId,
      expect.objectContaining({
        manualJournals: [expect.objectContaining({ manualJournalID: manualJournalId, narration: "Month end", status: "POSTED" })],
      }),
      requestId,
    );

    const timedOut = new Error("timeout") as Error & { code: string };
    timedOut.code = "ETIMEDOUT";
    const unknownProvider = new XeroControlledLedgerTransitionProvider(managerFor({
      getManualJournal: vi.fn().mockResolvedValue({
        body: { manualJournals: [{ manualJournalID: manualJournalId, narration: "Month end", status: "DRAFT" }] },
      }),
      updateManualJournal: vi.fn().mockRejectedValue(timedOut),
    }));
    const unknownRequestId = "transition-journal-unknown";
    await expect(unknownProvider.postManualJournal(
      principal,
      manualJournal,
      unknownRequestId,
      permit("XeroControlledLedgerTransitionProvider.postManualJournal", unknownRequestId, manualJournal),
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
  });
});
