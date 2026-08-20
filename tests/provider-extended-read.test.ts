import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import {
  listBankTransactionsSchema,
  listContactGroupsSchema,
  listItemsSchema,
  listJournalsSchema,
  listManualJournalsSchema,
  listPurchaseOrdersSchema,
  listQuotesSchema,
  listTrackingCategoriesSchema,
} from "../src/domain/extendedReadSchemas.js";
import {
  agedPayablesSchema,
  agedReceivablesSchema,
  balanceSheetSchema,
  profitAndLossSchema,
} from "../src/domain/schemas.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

const quoteId = "11111111-1111-4111-8111-111111111111";
const purchaseOrderId = "22222222-2222-4222-8222-222222222222";
const manualJournalId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const bankTransactionId = "55555555-5555-4555-8555-555555555555";

const connection = {
  connectionId: "conn-a",
  actorId: "actor-a",
  provider: "xero" as const,
  tenantId: "tenant-a",
  tenantName: "Tenant A",
  grantedScopes: [
    "accounting.invoices.read",
    "accounting.manualjournals.read",
    "accounting.banktransactions.read",
  ],
  tokenCiphertext: "test-only",
  tokenExpiresAt: new Date("2026-08-07T13:00:00Z"),
  refreshVersion: 0,
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-07T12:00:00Z"),
  updatedAt: new Date("2026-08-07T12:00:00Z"),
};

function providerWithClient(client: unknown): XeroAccountingProvider {
  const manager = {
    withClient: async <T>(
      _principal: unknown,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

function numberedQuote(index: number) {
  return {
    quoteID: `quote-${index}`,
    quoteNumber: `QU-${String(index).padStart(3, "0")}`,
    status: "DRAFT",
  };
}

describe("Xero extended provider reads", () => {
  it("maps logical quote pages onto Xero's fixed 100-record pages without gaps", async () => {
    const getQuotes = vi.fn().mockImplementation(async (
      _tenantId: string,
      _ifModifiedSince: Date | undefined,
      _dateFrom: string | undefined,
      _dateTo: string | undefined,
      _expiryDateFrom: string | undefined,
      _expiryDateTo: string | undefined,
      _contactId: string | undefined,
      _status: string | undefined,
      providerPage: number,
    ) => ({
      body: {
        quotes: Array.from({ length: 100 }, (_, offset) => numberedQuote((providerPage - 1) * 100 + offset + 1)),
      },
    }));
    const provider = providerWithClient({ accountingApi: { getQuotes } });

    const pageTwo = await provider.listQuotes("actor-a", listQuotesSchema.parse({
      page: 2,
      page_size: 25,
    }));
    const crossingPage = await provider.listQuotes("actor-a", listQuotesSchema.parse({
      page: 4,
      page_size: 30,
    }));

    expect(pageTwo.quotes.map((quote) => quote.quoteNumber)).toEqual(
      Array.from({ length: 25 }, (_, offset) => `QU-${String(offset + 26).padStart(3, "0")}`),
    );
    expect(crossingPage.quotes.map((quote) => quote.quoteNumber)).toEqual(
      Array.from({ length: 30 }, (_, offset) => `QU-${String(offset + 91).padStart(3, "0")}`),
    );
    expect(getQuotes.mock.calls.map((call) => call[8])).toEqual([1, 1, 2]);
    expect(pageTwo.pagination).toMatchObject({
      page: 2,
      pageSize: 25,
      returned: 25,
      hasNextPage: true,
      hasNextPageIsEstimated: true,
    });
  });

  it("passes purchase-order pagination to Xero and preserves exact completeness metadata", async () => {
    const getPurchaseOrders = vi.fn().mockResolvedValue({
      body: {
        purchaseOrders: [{ purchaseOrderID: purchaseOrderId, status: "SUBMITTED" }],
        pagination: { page: 2, pageSize: 40, pageCount: 3, itemCount: 81 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getPurchaseOrders } });
    const result = await provider.listPurchaseOrders("actor-a", listPurchaseOrdersSchema.parse({
      status: "SUBMITTED",
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      page: 2,
      page_size: 40,
      sort: "UPDATED_AT_DESC",
    }));

    expect(getPurchaseOrders).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      "SUBMITTED",
      "2026-01-01",
      "2026-08-07",
      "UpdatedDateUTC DESC",
      2,
      40,
    );
    expect(result).toMatchObject({
      purchaseOrders: [{ purchaseOrderId, status: "SUBMITTED" }],
      pagination: {
        page: 2,
        pageSize: 40,
        providerPageCount: 3,
        providerItemCount: 81,
        hasNextPage: true,
        hasNextPageIsEstimated: false,
      },
    });
  });

  it("uses reviewed manual-journal filters and page arguments", async () => {
    const getManualJournals = vi.fn().mockResolvedValue({
      body: {
        manualJournals: [{ manualJournalID: manualJournalId, status: "POSTED", narration: "Accrual" }],
        pagination: { page: 1, pageSize: 25, pageCount: 1, itemCount: 1 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getManualJournals } });
    const result = await provider.listManualJournals("actor-a", listManualJournalsSchema.parse({
      status: "POSTED",
      search_term: "accrual",
      page_size: 25,
    }));

    expect(getManualJournals).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      'Status=="POSTED" AND Narration.Contains("accrual")',
      "Date DESC",
      1,
      25,
    );
    expect(result.manualJournals).toEqual([expect.objectContaining({ manualJournalId, status: "POSTED" })]);
    expect(result.pagination.hasNextPageIsEstimated).toBe(false);
  });

  it("implements real local offset pagination for Xero Items and keeps end completeness conservative", async () => {
    const getItems = vi.fn().mockResolvedValue({
      body: {
        items: Array.from({ length: 45 }, (_, offset) => ({
          itemID: `item-${offset + 1}`,
          code: `ITEM-${String(offset + 1).padStart(3, "0")}`,
          statusAttributeString: "OK",
        })),
      },
    });
    const provider = providerWithClient({ accountingApi: { getItems } });

    const pageTwo = await provider.listItems("actor-a", listItemsSchema.parse({
      is_sold: true,
      page: 2,
      page_size: 20,
      sort: "CODE_ASC",
    }));
    const pageThree = await provider.listItems("actor-a", listItemsSchema.parse({
      is_sold: true,
      page: 3,
      page_size: 20,
      sort: "CODE_ASC",
    }));

    expect(getItems).toHaveBeenCalledWith("tenant-a", undefined, "IsSold==true", "Code ASC", 4);
    expect(pageTwo.items[0]?.code).toBe("ITEM-021");
    expect(pageTwo.items.at(-1)?.code).toBe("ITEM-040");
    expect(pageThree.items.map((item) => item.code)).toEqual([
      "ITEM-041",
      "ITEM-042",
      "ITEM-043",
      "ITEM-044",
      "ITEM-045",
    ]);
    expect(pageThree.pagination).toMatchObject({
      page: 3,
      pageSize: 20,
      returned: 5,
      hasNextPage: false,
      hasNextPageIsEstimated: true,
    });
  });

  it("uses InvoiceNumber for RECEIVE-PREPAYMENT matching and returns reconciliation evidence", async () => {
    const getBankTransactions = vi.fn().mockResolvedValue({
      body: {
        bankTransactions: [{
          bankTransactionID: bankTransactionId,
          type: "RECEIVE-PREPAYMENT",
          status: "AUTHORISED",
          invoiceNumber: "PP-0042",
          reference: "secondary-ref",
          isReconciled: false,
          currencyRate: "7.8123456789",
        }],
        pagination: { page: 1, pageSize: 50, pageCount: 1, itemCount: 1 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getBankTransactions } });
    const result = await provider.listBankTransactions("actor-a", listBankTransactionsSchema.parse({
      type: "RECEIVE-PREPAYMENT",
      search_term: "PP-0042",
    }));

    expect(getBankTransactions).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      'Type=="RECEIVE-PREPAYMENT" AND InvoiceNumber.Contains("PP-0042")',
      "Date DESC",
      1,
      4,
      50,
    );
    expect(result.bankTransactions).toEqual([expect.objectContaining({
      bankTransactionId,
      invoiceNumber: "PP-0042",
      isReconciled: false,
      currencyRate: "7.8123456789",
    })]);
  });

  it("rejects mismatched IDs from every exact-record endpoint", async () => {
    const wrongId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const provider = providerWithClient({
      accountingApi: {
        getQuote: vi.fn().mockResolvedValue({ body: { quotes: [{ quoteID: wrongId, status: "DRAFT" }] } }),
        getPurchaseOrder: vi.fn().mockResolvedValue({
          body: { purchaseOrders: [{ purchaseOrderID: wrongId, status: "DRAFT" }] },
        }),
        getManualJournal: vi.fn().mockResolvedValue({
          body: { manualJournals: [{ manualJournalID: wrongId, status: "DRAFT" }] },
        }),
        getItem: vi.fn().mockResolvedValue({ body: { items: [{ itemID: wrongId }] } }),
        getBankTransaction: vi.fn().mockResolvedValue({
          body: { bankTransactions: [{ bankTransactionID: wrongId, type: "SPEND", status: "AUTHORISED" }] },
        }),
      },
    });

    await expect(provider.getQuote("actor-a", quoteId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.getPurchaseOrder("actor-a", purchaseOrderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.getManualJournal("actor-a", manualJournalId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.getItem("actor-a", itemId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(provider.getBankTransaction("actor-a", bankTransactionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Xero item reads against a captured Xero response", () => {
  it("maps every real captured Xero item, treating an empty purchaseDetails object as absent", async () => {
    // proves: the real BOOK item carries purchaseDetails: {} (an empty
    // object, not a missing key). mapItemDefaults must still resolve that to
    // "no purchase defaults" rather than emitting an empty object - a
    // hand-built fixture would typically just omit the key and never
    // exercise the empty-object branch.
    const { items } = loadXeroResponse("items") as { items: Array<Record<string, unknown>> };
    const getItems = vi.fn().mockResolvedValue({ body: { items } });
    const provider = providerWithClient({ accountingApi: { getItems } });

    const result = await provider.listItems("actor-a", listItemsSchema.parse({ page: 1, page_size: 20 }));

    expect(result.items).toHaveLength(items.length);
    expect(result.items.find((item) => item.code === "BOOK")).toEqual({
      itemId: "8bbaf73c-5a32-4458-addf-bd30a36c8551",
      code: "BOOK",
      name: "Fish out of Water: Finding Your Brand",
      description: "'Fish out of Water: Finding Your Brand",
      purchaseDescription: "'Fish out of Water: Finding Your Brand",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      salesDetails: { accountCode: "200", taxType: "TAX001", unitPrice: "19.9500" },
      projectionIncomplete: false,
      omittedFields: [],
      updatedAt: "2026-08-07T01:34:58.243Z",
    });
  });

  it("gets one exact real captured Xero item by ID", async () => {
    const { items } = loadXeroResponse("items") as { items: Array<Record<string, unknown>> };
    const getItem = vi.fn().mockResolvedValue({ body: { items } });
    const provider = providerWithClient({ accountingApi: { getItem } });

    const result = await provider.getItem("actor-a", "8bbaf73c-5a32-4458-addf-bd30a36c8551");

    expect(result.code).toBe("BOOK");
    expect(result).not.toHaveProperty("purchaseDetails");
  });

  it("maps the remaining bounded ledger, report, payment, and reference-data reads to exact SDK calls", async () => {
    const paymentId = "66666666-6666-4666-8666-666666666666";
    const categoryId = "77777777-7777-4777-8777-777777777777";
    const optionId = "88888888-8888-4888-8888-888888888888";
    const groupId = "99999999-9999-4999-8999-999999999999";
    const getJournals = vi.fn().mockResolvedValue({
      body: {
        journals: [{
          journalID: "journal-1",
          journalNumber: 41,
          journalLines: [{ accountCode: "200", netAmount: 10 }],
        }],
      },
    });
    const getReportProfitAndLoss = vi.fn().mockResolvedValue({ body: { reports: [{ reportName: "Profit and Loss" }] } });
    const getReportBalanceSheet = vi.fn().mockResolvedValue({ body: { reports: [{ reportName: "Balance Sheet" }] } });
    const getReportAgedReceivablesByContact = vi.fn().mockResolvedValue({ body: { reports: [{ reportName: "Aged Receivables" }] } });
    const getReportAgedPayablesByContact = vi.fn().mockResolvedValue({ body: { reports: [{ reportName: "Aged Payables" }] } });
    const getPayment = vi.fn().mockResolvedValue({
      body: {
        payments: [{
          paymentID: paymentId,
          paymentType: "ACCRECPAYMENT",
          status: "AUTHORISED",
          amount: 10,
          invoice: { invoiceID: "invoice-1", currencyCode: "SGD" },
        }],
      },
    });
    const getTrackingCategories = vi.fn().mockResolvedValue({
      body: {
        trackingCategories: [{
          trackingCategoryID: categoryId,
          name: "Region",
          status: "ACTIVE",
          options: [{ trackingOptionID: optionId, name: "East", status: "ACTIVE" }],
        }],
      },
    });
    const getContactGroups = vi.fn().mockResolvedValue({
      body: { contactGroups: [{ contactGroupID: groupId, name: "Priority", status: "ACTIVE" }] },
    });
    const provider = providerWithClient({
      accountingApi: {
        getJournals,
        getReportProfitAndLoss,
        getReportBalanceSheet,
        getReportAgedReceivablesByContact,
        getReportAgedPayablesByContact,
        getPayment,
        getTrackingCategories,
        getContactGroups,
      },
    });

    await expect(provider.listJournals("actor-a", listJournalsSchema.parse({ offset: 40 })))
      .resolves.toMatchObject({ journals: [{ journalNumber: 41 }], pagination: { nextOffset: 41 } });
    await expect(provider.getProfitAndLoss("actor-a", profitAndLossSchema.parse({
      date_from: "2026-01-01", date_to: "2026-01-31", periods: 1, timeframe: "MONTH",
    }))).resolves.toMatchObject({ reports: [{ reportName: "Profit and Loss" }] });
    await expect(provider.getBalanceSheet("actor-a", balanceSheetSchema.parse({
      date: "2026-01-31", periods: 2, timeframe: "MONTH",
    }))).resolves.toMatchObject({ reports: [{ reportName: "Balance Sheet" }] });
    await expect(provider.getAgedReceivables("actor-a", agedReceivablesSchema.parse({
      contact_id: quoteId, date: "2026-01-31",
    }))).resolves.toMatchObject({ reports: [{ reportName: "Aged Receivables" }] });
    await expect(provider.getAgedPayables("actor-a", agedPayablesSchema.parse({
      contact_id: quoteId, date_from: "2026-01-01", date_to: "2026-01-31",
    }))).resolves.toMatchObject({ reports: [{ reportName: "Aged Payables" }] });
    await expect(provider.getPayment("actor-a", paymentId)).resolves.toMatchObject({
      paymentId, amount: "10.0000", currency: "SGD",
    });
    await expect(provider.listTrackingCategories("actor-a", listTrackingCategoriesSchema.parse({})))
      .resolves.toMatchObject({ trackingCategories: [{ trackingCategoryId: categoryId, options: [{ trackingOptionId: optionId }] }] });
    await expect(provider.listContactGroups("actor-a", listContactGroupsSchema.parse({})))
      .resolves.toMatchObject({ contactGroups: [{ contactGroupId: groupId, name: "Priority" }] });

    expect(getJournals).toHaveBeenCalledWith("tenant-a", undefined, 40);
    expect(getReportProfitAndLoss).toHaveBeenCalledWith("tenant-a", "2026-01-01", "2026-01-31", 1, "MONTH");
    expect(getReportBalanceSheet).toHaveBeenCalledWith("tenant-a", "2026-01-31", 2, "MONTH");
    expect(getReportAgedReceivablesByContact).toHaveBeenCalledWith("tenant-a", quoteId, "2026-01-31", undefined, undefined);
    expect(getReportAgedPayablesByContact).toHaveBeenCalledWith("tenant-a", quoteId, undefined, "2026-01-01", "2026-01-31");
    expect(getPayment).toHaveBeenCalledWith("tenant-a", paymentId);
    expect(getTrackingCategories).toHaveBeenCalledWith("tenant-a", undefined, "Name ASC", false);
    expect(getContactGroups).toHaveBeenCalledWith("tenant-a", undefined, "Name ASC");
  });
});
