import { describe, expect, it } from "vitest";
import {
  bankTransactionStatusSchema,
  bankTransactionTypeSchema,
  getBankTransactionSchema,
  getPaymentSchema,
  getItemSchema,
  getManualJournalSchema,
  getPurchaseOrderSchema,
  getQuoteSchema,
  listBankTransactionsSchema,
  listContactGroupsSchema,
  listItemsSchema,
  listJournalsSchema,
  listManualJournalsSchema,
  listPurchaseOrdersSchema,
  listQuotesSchema,
  listTrackingCategoriesSchema,
  manualJournalStatusSchema,
  purchaseOrderStatusSchema,
  quoteStatusSchema,
} from "../src/domain/extendedReadSchemas.js";

const xeroId = "11111111-1111-4111-8111-111111111111";

const forbiddenCallerControls = [
  { tenant_id: "tenant-b" },
  { xero_tenant_id: "tenant-b" },
  { headers: { "xero-tenant-id": "tenant-b" } },
  { where: 'Status=="AUTHORISED"' },
  { order: "Total DESC" },
  { endpoint: "/BankTransactions" },
];

const listSchemas = [
  listQuotesSchema,
  listPurchaseOrdersSchema,
  listManualJournalsSchema,
  listItemsSchema,
  listBankTransactionsSchema,
];

describe("extended read-only Xero schemas", () => {
  it("uses the official Xero status sets", () => {
    for (const status of ["DRAFT", "SENT", "DECLINED", "ACCEPTED", "INVOICED", "DELETED"]) {
      expect(quoteStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of ["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "DELETED"]) {
      expect(purchaseOrderStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of ["DRAFT", "POSTED", "DELETED", "VOIDED"]) {
      expect(manualJournalStatusSchema.safeParse(status).success).toBe(true);
    }
    for (const status of ["AUTHORISED", "DELETED"]) {
      expect(bankTransactionStatusSchema.safeParse(status).success).toBe(true);
    }

    expect(quoteStatusSchema.safeParse("AUTHORISED").success).toBe(false);
    expect(purchaseOrderStatusSchema.safeParse("PAID").success).toBe(false);
    expect(manualJournalStatusSchema.safeParse("AUTHORISED").success).toBe(false);
    expect(manualJournalStatusSchema.safeParse("ARCHIVED").success).toBe(false);
    expect(bankTransactionStatusSchema.safeParse("DRAFT").success).toBe(false);
    expect(bankTransactionStatusSchema.safeParse("VOIDED").success).toBe(false);
  });

  it("uses the official bank-transaction type values, including hyphenated variants", () => {
    for (const type of [
      "RECEIVE",
      "RECEIVE-OVERPAYMENT",
      "RECEIVE-PREPAYMENT",
      "SPEND",
      "SPEND-OVERPAYMENT",
      "SPEND-PREPAYMENT",
      "RECEIVE-TRANSFER",
      "SPEND-TRANSFER",
    ]) {
      expect(bankTransactionTypeSchema.safeParse(type).success).toBe(true);
    }

    expect(bankTransactionTypeSchema.safeParse("RECEIVEOVERPAYMENT").success).toBe(false);
    expect(bankTransactionTypeSchema.safeParse("PAYMENT").success).toBe(false);
  });

  it("accepts bounded quote filters and independently validates issue and expiry ranges", () => {
    expect(listQuotesSchema.parse({})).toEqual({ page: 1, page_size: 50, sort: "DATE_DESC" });
    expect(listQuotesSchema.parse({
      status: "ACCEPTED",
      contact_id: xeroId,
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      expiry_date_from: "2026-08-08",
      expiry_date_to: "2026-12-31",
      quote_number: "QU-00042",
      page: 2,
      page_size: 100,
      sort: "EXPIRY_DATE_ASC",
    })).toMatchObject({ status: "ACCEPTED", page: 2, page_size: 100 });

    expect(listQuotesSchema.safeParse({ date_from: "2026-08-08", date_to: "2026-08-07" }).success).toBe(false);
    expect(listQuotesSchema.safeParse({ expiry_date_from: "2026-08-08", expiry_date_to: "2026-08-07" }).success).toBe(false);
    expect(listQuotesSchema.safeParse({ quote_number: "x".repeat(256) }).success).toBe(false);
  });

  it("accepts only reviewed purchase-order filters", () => {
    expect(listPurchaseOrdersSchema.parse({})).toEqual({ page: 1, page_size: 50, sort: "DATE_DESC" });
    expect(listPurchaseOrdersSchema.parse({
      status: "SUBMITTED",
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      page: 1_000,
      page_size: 100,
      sort: "UPDATED_AT_DESC",
    })).toMatchObject({ status: "SUBMITTED", page: 1_000, page_size: 100 });

    expect(listPurchaseOrdersSchema.safeParse({ date_from: "2026-08-08", date_to: "2026-08-07" }).success).toBe(false);
    expect(listPurchaseOrdersSchema.safeParse({ status: "PAID" }).success).toBe(false);
  });

  it("accepts bounded manual-journal filters without exposing a raw where clause", () => {
    expect(listManualJournalsSchema.parse({})).toEqual({ page: 1, page_size: 50, sort: "DATE_DESC" });
    expect(listManualJournalsSchema.parse({
      status: "POSTED",
      date_from: "2025-07-01",
      date_to: "2026-06-30",
      search_term: "year-end accrual",
      page: 4,
      page_size: 25,
      sort: "UPDATED_AT_ASC",
    })).toMatchObject({ status: "POSTED", search_term: "year-end accrual", page: 4 });

    expect(listManualJournalsSchema.safeParse({ search_term: "x".repeat(101) }).success).toBe(false);
    expect(listManualJournalsSchema.safeParse({ date_from: "2026-02-30" }).success).toBe(false);
  });

  it("accepts bounded item discovery using official Item boolean properties", () => {
    expect(listItemsSchema.parse({})).toEqual({ page: 1, page_size: 50, sort: "CODE_ASC" });
    expect(listItemsSchema.parse({
      is_sold: true,
      is_purchased: false,
      is_tracked_as_inventory: true,
      search_term: "consulting",
      page: 3,
      page_size: 20,
      sort: "NAME_DESC",
    })).toMatchObject({ is_sold: true, is_purchased: false, page: 3 });

    expect(listItemsSchema.safeParse({ search_term: "x" }).success).toBe(false);
    expect(listItemsSchema.safeParse({ search_term: "x".repeat(101) }).success).toBe(false);
    expect(listItemsSchema.safeParse({ status: "ACTIVE" }).success).toBe(false);
  });

  it("accepts reconciliation-oriented bank-transaction filters without enabling writes", () => {
    expect(listBankTransactionsSchema.parse({})).toEqual({ page: 1, page_size: 50, sort: "DATE_DESC" });
    expect(listBankTransactionsSchema.parse({
      type: "SPEND",
      status: "AUTHORISED",
      is_reconciled: false,
      contact_id: xeroId,
      bank_account_id: "22222222-2222-4222-8222-222222222222",
      invoice_number: "PP-0042",
      date_from: "2026-08-01",
      date_to: "2026-08-07",
      search_term: "CARD-REF-42",
      page: 10,
      page_size: 100,
      sort: "UPDATED_AT_DESC",
    })).toMatchObject({ type: "SPEND", is_reconciled: false, invoice_number: "PP-0042", page_size: 100 });

    expect(listBankTransactionsSchema.safeParse({ date_from: "2026-08-08", date_to: "2026-08-07" }).success).toBe(false);
    expect(listBankTransactionsSchema.safeParse({ type: "PAYMENT" }).success).toBe(false);
  });

  it("keeps journal continuation, exact payment, tracking, and contact-group reads bounded and typed", () => {
    expect(listJournalsSchema.parse({})).toEqual({});
    expect(listJournalsSchema.parse({ offset: 101 })).toEqual({ offset: 101 });
    expect(listJournalsSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(listJournalsSchema.safeParse({ page: 2 }).success).toBe(false);

    expect(getPaymentSchema.parse({ payment_id: xeroId })).toEqual({ payment_id: xeroId });
    expect(getPaymentSchema.safeParse({ payment_id: "not-a-xero-id" }).success).toBe(false);

    expect(listTrackingCategoriesSchema.parse({})).toEqual({ include_archived: false, limit: 100 });
    expect(listTrackingCategoriesSchema.parse({ include_archived: true, limit: 12 }))
      .toEqual({ include_archived: true, limit: 12 });
    expect(listTrackingCategoriesSchema.safeParse({ where: 'Name=="Region"' }).success).toBe(false);

    expect(listContactGroupsSchema.parse({})).toEqual({ limit: 100 });
    expect(listContactGroupsSchema.parse({ limit: 12 })).toEqual({ limit: 12 });
    expect(listContactGroupsSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("bounds every logical result window to at most 100,000 records", () => {
    for (const schema of listSchemas) {
      expect(schema.safeParse({ page: 1_000, page_size: 100 }).success).toBe(true);
      expect(schema.safeParse({ page: 1_001, page_size: 100 }).success).toBe(false);
      expect(schema.safeParse({ page: 1, page_size: 101 }).success).toBe(false);
      expect(schema.safeParse({ page: 0 }).success).toBe(false);
    }
  });

  it("rejects tenant, header, endpoint, raw where, and raw order controls on every list", () => {
    for (const schema of listSchemas) {
      for (const input of forbiddenCallerControls) {
        expect(schema.safeParse(input).success).toBe(false);
      }
    }
  });

  it("requires an exact Xero UUID and no routing extras for every get", () => {
    const exactGets = [
      [getQuoteSchema, "quote_id"],
      [getPurchaseOrderSchema, "purchase_order_id"],
      [getManualJournalSchema, "manual_journal_id"],
      [getItemSchema, "item_id"],
      [getBankTransactionSchema, "bank_transaction_id"],
    ] as const;

    for (const [schema, key] of exactGets) {
      expect(schema.safeParse({ [key]: xeroId }).success).toBe(true);
      expect(schema.safeParse({ [key]: "not-a-uuid" }).success).toBe(false);
      expect(schema.safeParse({ [key]: xeroId, tenant_id: "tenant-b" }).success).toBe(false);
      expect(schema.safeParse({ [key]: xeroId, headers: {} }).success).toBe(false);
    }
  });
});
