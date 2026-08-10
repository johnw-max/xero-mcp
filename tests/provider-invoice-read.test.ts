import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { listInvoicesSchema } from "../src/domain/schemas.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";

const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const connection = {
  connectionId: "conn-a",
  actorId: "actor-a",
  provider: "xero" as const,
  tenantId: "tenant-a",
  tenantName: "Tenant A",
  grantedScopes: ["accounting.invoices"],
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

function xeroInvoice(type: "ACCPAY" | "ACCREC", lineCount = 1) {
  return {
    invoiceID: invoiceId,
    type,
    status: "PAID",
    contact: { contactID: contactId, name: "Acme Limited" },
    invoiceNumber: "INV-2026-001",
    date: "2026-07-01",
    dueDate: "2026-07-31",
    fullyPaidOnDate: "2026-07-20",
    currencyCode: "HKD",
    reference: "PO-42",
    lineAmountTypes: "NoTax",
    subTotal: 100,
    totalTax: 0,
    total: 100,
    amountDue: 0,
    amountPaid: 90,
    amountCredited: 10,
    hasAttachments: true,
    updatedDateUTCString: "2026-07-20T10:11:12.000Z",
    lineItems: Array.from({ length: lineCount }, (_, index) => ({
      lineItemID: `line-${index}`,
      description: `Line ${index}`,
      quantity: 1,
      unitAmount: 1,
      lineAmount: 1,
      taxAmount: 0,
      accountCode: "200",
      taxType: "NONE",
    })),
  };
}

describe("provider invoice history reads", () => {
  it("constructs only reviewed Xero filters and returns an Agent-sized summary page", async () => {
    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [xeroInvoice("ACCREC")],
        pagination: { page: 2, pageSize: 25, pageCount: 4, itemCount: 76 },
      },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { getInvoices } });
    const input = listInvoicesSchema.parse({
      type: "ACCREC",
      contact_id: contactId,
      statuses: ["AUTHORISED", "PAID"],
      date_from: "2026-01-01",
      date_to: "2026-08-05",
      page: 2,
      page_size: 25,
      search_term: "ACME",
      include_archived: true,
      order: "UPDATED_AT_DESC",
    });

    const result = await provider.listInvoices("actor-a", input);

    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      'Type=="ACCREC" AND Date>=DateTime(2026,1,1) AND Date<=DateTime(2026,8,5)',
      "UpdatedDateUTC DESC",
      undefined,
      undefined,
      [contactId],
      ["AUTHORISED", "PAID"],
      2,
      true,
      undefined,
      4,
      true,
      25,
      "ACME",
    );
    expect(result).toEqual({
      invoices: [{
        invoiceId,
        type: "ACCREC",
        status: "PAID",
        contact: { contactId, name: "Acme Limited" },
        invoiceNumber: "INV-2026-001",
        invoiceDate: "2026-07-01",
        dueDate: "2026-07-31",
        fullyPaidOnDate: "2026-07-20",
        currency: "HKD",
        reference: "PO-42",
        subTotal: "100.0000",
        totalTax: "0.0000",
        total: "100.0000",
        amountDue: "0.0000",
        amountPaid: "90.0000",
        amountCredited: "10.0000",
        attachmentsKnown: true,
        hasAttachments: true,
        updatedAt: "2026-07-20T10:11:12.000Z",
      }],
      pagination: {
        page: 2,
        pageSize: 25,
        returned: 1,
        providerPageCount: 4,
        providerItemCount: 76,
        hasNextPage: true,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    });
    expect(result.invoices[0]).not.toHaveProperty("lines");
  });

  it("does not turn Xero's summary-only attachment omission into a false value", async () => {
    const invoice = xeroInvoice("ACCREC") as ReturnType<typeof xeroInvoice> & { hasAttachments?: boolean };
    delete invoice.hasAttachments;
    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [invoice] },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const result = await provider.listInvoices("actor-a", listInvoicesSchema.parse({ page_size: 1 }));

    expect(result.invoices[0]).toMatchObject({ attachmentsKnown: false });
    expect(result.invoices[0]).not.toHaveProperty("hasAttachments");
  });

  it("enforces page_size locally even if Xero returns an oversized page", async () => {
    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [xeroInvoice("ACCPAY"), xeroInvoice("ACCREC"), xeroInvoice("ACCPAY")] },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const result = await provider.listInvoices("actor-a", listInvoicesSchema.parse({ page_size: 2 }));

    expect(result.invoices).toHaveLength(2);
    expect(result.pagination).toMatchObject({ returned: 2, omittedOverflow: 1 });
  });

  it("turns Xero HighVolumeException into a non-retryable narrowing instruction", async () => {
    const getInvoices = vi.fn().mockRejectedValue(JSON.stringify({
      response: { statusCode: 400, body: { Type: "HighVolumeException" } },
      body: { Type: "HighVolumeException" },
    }));
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    await expect(
      provider.listInvoices("actor-a", listInvoicesSchema.parse({ page_size: 50 })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
  });

  it("uses Xero's normalized current page when computing hasNextPage", async () => {
    const getInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [xeroInvoice("ACCREC")],
        pagination: { page: 4, pageSize: 25, pageCount: 4, itemCount: 76 },
      },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const result = await provider.listInvoices("actor-a", listInvoicesSchema.parse({ page: 3, page_size: 25 }));

    expect(result.pagination).toMatchObject({ page: 4, hasNextPage: false });
  });

  it.each(["ACCPAY", "ACCREC"] as const)(
    "gets an exact %s invoice and caps line output without hiding truncation",
    async (type) => {
      const getInvoices = vi.fn().mockResolvedValue({
        body: { invoices: [xeroInvoice(type, 101)] },
        response: { headers: {} },
      });
      const provider = providerWithClient({ accountingApi: { getInvoices } });

      const result = await provider.getInvoice("actor-a", invoiceId, type);

      expect(result).toMatchObject({
        invoiceId,
        type,
        amountDue: "0.0000",
        amountPaid: "90.0000",
        amountCredited: "10.0000",
        hasAttachments: true,
        lineItemCount: 101,
        linesTruncated: true,
      });
      expect(result.lines).toHaveLength(100);
      expect(getInvoices).toHaveBeenCalledWith(
        "tenant-a",
        undefined,
        undefined,
        undefined,
        [invoiceId],
        undefined,
        undefined,
        undefined,
        1,
        false,
        undefined,
        4,
        false,
        1,
      );
    },
  );

  it("keeps the supplier-bill read compatible and ACCPAY-only", async () => {
    const getInvoices = vi.fn()
      .mockResolvedValueOnce({ body: { invoices: [xeroInvoice("ACCPAY", 101)] }, response: { headers: {} } })
      .mockResolvedValueOnce({ body: { invoices: [xeroInvoice("ACCREC")] }, response: { headers: {} } });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const bill = await provider.getSupplierBill("actor-a", invoiceId);
    expect(bill.type).toBe("ACCPAY");
    expect(bill.lines).toHaveLength(101);
    expect(bill.linesTruncated).toBe(false);

    await expect(provider.getSupplierBill("actor-a", invoiceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
