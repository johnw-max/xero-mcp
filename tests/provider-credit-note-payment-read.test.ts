import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { listCreditNotesSchema, listPaymentsSchema } from "../src/domain/schemas.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";

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
