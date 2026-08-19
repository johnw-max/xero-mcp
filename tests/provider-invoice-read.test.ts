import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { listInvoicesSchema } from "../src/domain/schemas.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  capturedDateFields,
  loadXeroResponse,
} from "./fixtures/xero-provider-responses/index.js";

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
      false,
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

  it("always requests summaryOnly=false so Xero returns exact pagination for the history walk", async () => {
    // Production incident: with summaryOnly=true, Xero's Invoices endpoint
    // omits response.body.pagination entirely (confirmed empirically against
    // the live API), which forced the business-coordinate history walk in
    // xeroBusinessCoordinateHistory.ts to fail closed with
    // PROVIDER_PAGINATION_ESTIMATED / PROVIDER_ITEM_COUNT_MISSING_OR_INVALID
    // on every supplier-bill write. Passing summaryOnly=false restores the
    // exact pageCount/itemCount Xero already returns for this query shape.
    const getInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [], pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 0 } },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    await provider.listInvoices("actor-a", listInvoicesSchema.parse({ page_size: 100 }));

    expect(getInvoices).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      undefined,
      "Date DESC",
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      false,
      undefined,
      4,
      false,
      100,
      undefined,
    );
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

describe("provider invoice reads against a captured Xero response", () => {
  it("keeps the captured invoice_accpay Date-field inventory the mapper already accounts for", () => {
    // proves: if a future re-capture shows Xero returning a NEW field as a
    // Date (e.g. amountDue), this list changes and forces a human to check
    // whether mapInvoiceSummary/mapInvoiceSnapshot handle it - rather than the
    // gap staying invisible because nobody happened to assert on that field.
    expect(capturedDateFields("invoice_accpay")).toEqual([
      "invoices[].date",
      "invoices[].dueDate",
      "invoices[].updatedDateUTC",
    ]);
  });

  it("maps a real captured Xero AP invoice list page, dropping its empty reference", async () => {
    // proves: real Xero sends reference: "" rather than omitting the key, and
    // updatedDateUTC as a live Date alongside a separate updatedDateUTCString.
    // mapInvoiceSummary must prefer the Date branch and must treat "" as
    // absent - a hand-built fixture that omitted an empty reference outright
    // would never exercise the falsy-empty-string branch.
    const body = loadXeroResponse("invoice_accpay") as {
      invoices: Array<Record<string, unknown>>;
      pagination: Record<string, number>;
    };
    const getInvoices = vi.fn().mockResolvedValue({ body, response: { headers: {} } });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const result = await provider.listInvoices("actor-a", listInvoicesSchema.parse({ page_size: 100 }));

    expect(result.invoices).toEqual([{
      invoiceId: "483e4412-488a-405c-9115-0a6f3aacf6a6",
      type: "ACCPAY",
      status: "DRAFT",
      contact: { contactId: "23cb74b0-6e82-4d6a-af84-1e635a4fb59b", name: "Northwind Logistics LLC" },
      invoiceNumber: "NW-8842",
      invoiceDate: "2026-08-14",
      dueDate: "2026-09-13",
      currency: "USD",
      currencyRate: "1.0000",
      subTotal: "2400.0000",
      totalTax: "0.0000",
      total: "2400.0000",
      amountDue: "2400.0000",
      amountPaid: "0.0000",
      amountCredited: "0.0000",
      attachmentsKnown: true,
      hasAttachments: false,
      updatedAt: "2026-08-19T09:11:54.120Z",
    }]);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 100,
      returned: 1,
      providerPageCount: 1,
      providerItemCount: 1,
      hasNextPage: false,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
    });
  });

  it("reads the exact real captured AP invoice, including its one real line item", async () => {
    const [invoice] = loadXeroResponse("invoice_accpay").invoices as Array<Record<string, unknown>>;
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [invoice] }, response: { headers: {} } });
    const provider = providerWithClient({ accountingApi: { getInvoices } });

    const result = await provider.getInvoice("actor-a", "483e4412-488a-405c-9115-0a6f3aacf6a6", "ACCPAY");

    expect(result).toMatchObject({
      invoiceId: "483e4412-488a-405c-9115-0a6f3aacf6a6",
      tenantId: "tenant-a",
      lineAmountType: "Exclusive",
      lineItemCount: 1,
      linesTruncated: false,
    });
    expect(result.lines).toEqual([{
      lineItemId: "77ec3279-8bb0-441d-9728-eef4326d0185",
      description: "Freight forwarding — August",
      quantity: "1.0000",
      unitAmount: "2400.0000",
      lineAmount: "2400.0000",
      taxAmount: "0.0000",
      accountId: "c4b1c463-9913-4672-a8b8-01a3b546126f",
      accountCode: "425",
      taxType: "NONE",
    }]);

    await expect(provider.getSupplierBill("actor-a", "483e4412-488a-405c-9115-0a6f3aacf6a6")).resolves
      .toMatchObject({ type: "ACCPAY", lineItemCount: 1 });
  });
});
