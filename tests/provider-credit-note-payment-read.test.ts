import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { listCreditNotesSchema, listPaymentsSchema } from "../src/domain/schemas.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  capturedDateFields,
  loadXeroResponse,
} from "./fixtures/xero-provider-responses/index.js";

const contactId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const creditNoteId = "44444444-4444-4444-8444-444444444444";
const paymentId = "55555555-5555-4555-8555-555555555555";
const connection = {
  connectionId: "conn-a",
  actorId: "actor-a",
  provider: "xero" as const,
  tenantId: "tenant-a",
  tenantName: "Tenant A",
  grantedScopes: ["accounting.invoices.read", "accounting.payments.read"],
  tokenCiphertext: "test-only",
  tokenExpiresAt: new Date("2026-08-05T13:00:00Z"),
  refreshVersion: 0,
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-05T12:00:00Z"),
  updatedAt: new Date("2026-08-05T12:00:00Z"),
};

function providerWithClient(client: unknown): XeroAccountingProvider {
  const manager = {
    withClient: async <T>(
      _actorId: string,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

describe("bounded credit-note history reads", () => {
  it("constructs only reviewed filters and emits bounded allocation evidence", async () => {
    const allocations = Array.from({ length: 30 }, (_, index) => ({
      allocationID: `allocation-${index}`,
      amount: 1,
      date: "2026-07-10",
      invoice: { invoiceID: `${String(index).padStart(8, "0")}-3333-4333-8333-333333333333` },
    }));
    const getCreditNotes = vi.fn().mockResolvedValue({
      body: {
        creditNotes: [{
          creditNoteID: creditNoteId,
          type: "ACCPAYCREDIT",
          status: "PAID",
          contact: { contactID: contactId, name: "Greenpack" },
          creditNoteNumber: "CN-160",
          date: "2026-07-01",
          dueDate: "2026-07-31",
          fullyPaidOnDate: "2026-07-12",
          currencyCode: "HKD",
          reference: "RETURN-160",
          subTotal: 160,
          totalTax: 0,
          total: 160,
          remainingCredit: 0,
          appliedAmount: 160,
          hasAttachments: false,
          allocations,
          lineItems: [{ description: "must not be returned" }],
          updatedDateUTCString: "2026-07-12T12:00:00.000Z",
        }],
        pagination: { page: 2, pageSize: 20, pageCount: 3, itemCount: 41 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getCreditNotes } });
    const input = listCreditNotesSchema.parse({
      contact_id: contactId,
      date_from: "2026-07-01",
      date_to: "2026-07-31",
      status: "PAID",
      type: "ACCPAYCREDIT",
      page: 2,
      page_size: 20,
    });

    const result = await provider.listCreditNotes("actor-a", input);

    expect(getCreditNotes).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      `Type=="ACCPAYCREDIT" AND Status=="PAID" AND Contact.ContactID==Guid("${contactId}") AND Date>=DateTime(2026,7,1) AND Date<=DateTime(2026,7,31)`,
      "Date DESC",
      2,
      4,
      20,
    );
    expect(result.creditNotes[0]).toMatchObject({
      creditNoteId,
      type: "ACCPAYCREDIT",
      status: "PAID",
      contact: { contactId, name: "Greenpack" },
      currency: "HKD",
      total: "160.0000",
      remainingCredit: "0.0000",
      appliedAmount: "160.0000",
      attachmentsKnown: true,
      hasAttachments: false,
      associatedInvoiceIdCount: 30,
      associatedInvoiceIdsTruncated: true,
    });
    expect(result.creditNotes[0]?.associatedInvoiceIds).toHaveLength(25);
    expect(result.creditNotes[0]).not.toHaveProperty("lineItems");
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 20,
      returned: 1,
      providerPageCount: 3,
      providerItemCount: 41,
      hasNextPage: true,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
    });
  });

  it("caps an oversized provider page and exposes the overflow", async () => {
    const getCreditNotes = vi.fn().mockResolvedValue({
      body: {
        creditNotes: Array.from({ length: 3 }, (_, index) => ({
          creditNoteID: `${index}4444444-4444-4444-8444-444444444444`,
          type: "ACCPAYCREDIT",
          status: "PAID",
          contact: { contactID: contactId },
        })),
      },
    });
    const provider = providerWithClient({ accountingApi: { getCreditNotes } });

    const result = await provider.listCreditNotes("actor-a", listCreditNotesSchema.parse({ page_size: 2 }));

    expect(result.creditNotes).toHaveLength(2);
    expect(result.pagination).toMatchObject({ returned: 2, omittedOverflow: 1 });
  });
});

describe("credit-note reads against a captured Xero response", () => {
  it("keeps the captured credit_notes Date-field inventory the mapper already accounts for", () => {
    // proves: a future re-capture that shows a new field coming back as a Date
    // changes this list and forces a human to check mapCreditNoteSummary /
    // mapCreditNoteSnapshot for it, instead of the gap staying invisible.
    expect(capturedDateFields("credit_notes")).toEqual([
      "creditNotes[].allocations[].date",
      "creditNotes[].date",
      "creditNotes[].fullyPaidOnDate",
      "creditNotes[].updatedDateUTC",
    ]);
  });

  it("maps all five real captured credit notes, deriving associated invoice IDs from real allocations", async () => {
    // proves: every real row here carries a non-empty allocations array (these
    // are settled, PAID credit notes) - a hand-built fixture rarely bothers to
    // populate allocations at all, so associatedInvoiceIds/associatedInvoiceIdCount
    // derived from allocations[].invoice.invoiceID was only ever exercised
    // against data the test author invented.
    const { creditNotes } = loadXeroResponse("credit_notes") as {
      creditNotes: Array<Record<string, unknown>>;
    };
    const getCreditNotes = vi.fn().mockResolvedValue({ body: { creditNotes } });
    const provider = providerWithClient({ accountingApi: { getCreditNotes } });

    const result = await provider.listCreditNotes("actor-a", listCreditNotesSchema.parse({ page_size: 100 }));

    expect(result.creditNotes).toHaveLength(5);
    expect(result.creditNotes.find((note) => note.creditNoteNumber === "CN-0014")).toEqual({
      creditNoteId: "602f5486-664e-492f-b4d1-e12df1d4b8ba",
      type: "ACCRECCREDIT",
      status: "PAID",
      contact: { contactId: "37918a06-92f6-4edb-bfe0-1fc041c90f8b", name: "Boom FM" },
      attachmentsKnown: true,
      hasAttachments: false,
      associatedInvoiceIds: ["4c4db294-3633-45cd-8706-f0b3b0079609"],
      associatedInvoiceIdCount: 1,
      associatedInvoiceIdsTruncated: false,
      creditNoteNumber: "CN-0014",
      creditNoteDate: "2026-06-25",
      fullyPaidOnDate: "2026-06-25",
      currency: "USD",
      reference: "Training",
      subTotal: "500.0000",
      totalTax: "41.2500",
      total: "541.2500",
      remainingCredit: "0.0000",
      updatedAt: "2008-12-20T17:38:32.660Z",
    });
    // "Refund" and "OG laptop" carry reference: "" on the wire - must be
    // dropped, not surfaced as an empty string.
    const refund = result.creditNotes.find((note) => note.creditNoteNumber === "Refund");
    expect(refund).not.toHaveProperty("reference");
    expect(result.pagination).toMatchObject({
      returned: 5,
      hasNextPage: false,
      hasNextPageIsEstimated: true,
    });
  });

  it("reads the exact real captured AP credit note, including its empty line-item array", async () => {
    const { creditNotes } = loadXeroResponse("credit_notes") as {
      creditNotes: Array<Record<string, unknown>>;
    };
    const swanston = creditNotes.find((note) => note.creditNoteNumber === "Refund");
    const getCreditNote = vi.fn().mockResolvedValue({ body: { creditNotes: [swanston] } });
    const provider = providerWithClient({ accountingApi: { getCreditNote } });

    const result = await provider.getCreditNote("actor-a", "38b0ede6-a89d-4384-8d24-a3b3e8eaabb0", "ACCPAYCREDIT");

    expect(result).toMatchObject({
      creditNoteId: "38b0ede6-a89d-4384-8d24-a3b3e8eaabb0",
      type: "ACCPAYCREDIT",
      status: "PAID",
      contact: { contactId: "78b7299c-4f1f-46d2-acc3-44a46bd361b1", name: "Swanston Security" },
      tenantId: "tenant-a",
      subTotal: "23.5000",
      totalTax: "1.9400",
      total: "25.4400",
      lineAmountType: "Exclusive",
      lineItemCount: 0,
      linesTruncated: false,
    });
    expect(result.lines).toEqual([]);
    expect(result).not.toHaveProperty("reference");
  });
});

describe("bounded payment history reads", () => {
  it("requires a payment type for contact filtering", () => {
    expect(() => listPaymentsSchema.parse({ contact_id: contactId })).toThrow(/type is required/i);
  });

  it("uses the type-specific contact path and returns only evidenced currencies and associations", async () => {
    const getPayments = vi.fn().mockResolvedValue({
      body: {
        payments: [{
          paymentID: paymentId,
          paymentType: "ACCPAYPAYMENT",
          status: "AUTHORISED",
          date: "2026-07-20",
          amount: 600,
          bankAmount: 590,
          reference: "PAY-600",
          isReconciled: true,
          batchPaymentID: "66666666-6666-4666-8666-666666666666",
          account: {
            accountID: "77777777-7777-4777-8777-777777777777",
            code: "090",
            name: "Business Bank",
            currencyCode: "SGD",
            bankAccountNumber: "must-not-leak",
          },
          invoice: {
            invoiceID: invoiceId,
            invoiceNumber: "BILL-760",
            currencyCode: "HKD",
            contact: { contactID: contactId, name: "Greenpack" },
          },
          updatedDateUTCString: "2026-07-21T00:00:00.000Z",
        }],
        pagination: { page: 1, pageSize: 25, pageCount: 1, itemCount: 1 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getPayments } });
    const input = listPaymentsSchema.parse({
      contact_id: contactId,
      type: "ACCPAYPAYMENT",
      status: "AUTHORISED",
      date_from: "2026-07-01",
      date_to: "2026-07-31",
      page_size: 25,
    });

    const result = await provider.listPayments("actor-a", input);

    expect(getPayments).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      `PaymentType=="ACCPAYPAYMENT" AND Status=="AUTHORISED" AND Invoice.Contact.ContactID==Guid("${contactId}") AND Date>=DateTime(2026,7,1) AND Date<=DateTime(2026,7,31)`,
      "Date DESC",
      1,
      25,
    );
    expect(result.payments).toEqual([{
      paymentId,
      type: "ACCPAYPAYMENT",
      status: "AUTHORISED",
      paymentDate: "2026-07-20",
      amount: "600.0000",
      currency: "HKD",
      currencyKnown: true,
      currencySource: "INVOICE",
      bankAmount: "590.0000",
      bankCurrency: "SGD",
      bankCurrencyKnown: true,
      reference: "PAY-600",
      isReconciled: true,
      contact: { contactId, name: "Greenpack" },
      invoiceId,
      invoiceNumber: "BILL-760",
      batchPaymentId: "66666666-6666-4666-8666-666666666666",
      account: {
        accountId: "77777777-7777-4777-8777-777777777777",
        code: "090",
        name: "Business Bank",
      },
      updatedAt: "2026-07-21T00:00:00.000Z",
    }]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(result.pagination).toMatchObject({ hasNextPage: false, hasNextPageIsEstimated: false });
  });

  it("does not guess a transaction currency when Xero omits its associated document", async () => {
    const getPayments = vi.fn().mockResolvedValue({
      body: {
        payments: [{
          paymentID: paymentId,
          paymentType: "APCREDITPAYMENT",
          status: "AUTHORISED",
          amount: 160,
          account: { currencyCode: "SGD" },
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getPayments } });

    const result = await provider.listPayments("actor-a", listPaymentsSchema.parse({ page_size: 1 }));

    expect(result.payments[0]).toMatchObject({
      amount: "160.0000",
      currencyKnown: false,
      currencySource: "UNAVAILABLE",
      bankCurrency: "SGD",
      bankCurrencyKnown: true,
    });
    expect(result.payments[0]).not.toHaveProperty("currency");
    expect(result.payments[0]).not.toHaveProperty("creditNoteId");
  });

  it("returns a linked credit-note ID and currency only when Xero supplies that association", async () => {
    const getPayments = vi.fn().mockResolvedValue({
      body: {
        payments: [{
          paymentID: paymentId,
          paymentType: "APCREDITPAYMENT",
          status: "AUTHORISED",
          amount: 160,
          creditNoteNumber: "CN-160",
          creditNote: {
            creditNoteID: creditNoteId,
            creditNoteNumber: "CN-160",
            currencyCode: "HKD",
            contact: { contactID: contactId, name: "Greenpack" },
          },
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getPayments } });

    const result = await provider.listPayments("actor-a", listPaymentsSchema.parse({ page_size: 1 }));

    expect(result.payments[0]).toMatchObject({
      creditNoteId,
      creditNoteNumber: "CN-160",
      currency: "HKD",
      currencyKnown: true,
      currencySource: "CREDIT_NOTE",
      contact: { contactId, name: "Greenpack" },
    });
  });

  it("turns Xero's high-volume rejection into a narrowing instruction", async () => {
    const getPayments = vi.fn().mockRejectedValue(JSON.stringify({
      response: { statusCode: 400, body: { Type: "HighVolumeException" } },
      body: { Type: "HighVolumeException" },
    }));
    const provider = providerWithClient({ accountingApi: { getPayments } });

    await expect(
      provider.listPayments("actor-a", listPaymentsSchema.parse({ page_size: 50 })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
  });
});
