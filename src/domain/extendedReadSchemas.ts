import { z } from "zod/v4";

const yyyyMmDd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const xeroId = z.string().uuid();
const pageSchema = z.number().int().min(1).max(1_000).default(1);
const pageSizeSchema = z.number().int().min(1).max(100).default(50);
const searchTermSchema = z.string().trim().min(2).max(100);

const isBoundedWindow = (value: { page: number; page_size: number }): boolean => (
  value.page * value.page_size <= 100_000
);

export const quoteStatusSchema = z.enum([
  "DRAFT",
  "SENT",
  "DECLINED",
  "ACCEPTED",
  "INVOICED",
  "DELETED",
]);

export const quoteSortSchema = z.enum([
  "DATE_ASC",
  "DATE_DESC",
  "EXPIRY_DATE_ASC",
  "EXPIRY_DATE_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

/**
 * `sort` is a reviewed public enum, not Xero's raw `order` expression. The
 * provider must translate it. `page_size` bounds the Agent-facing result even
 * though Xero's Quotes endpoint currently pages in fixed batches of up to 100.
 */
export const listQuotesSchema = z.object({
  status: quoteStatusSchema.optional(),
  contact_id: xeroId.optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  expiry_date_from: yyyyMmDd.optional(),
  expiry_date_to: yyyyMmDd.optional(),
  quote_number: z.string().trim().min(1).max(255).optional(),
  page: pageSchema,
  page_size: pageSizeSchema,
  sort: quoteSortSchema.default("DATE_DESC"),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine(
  (value) => !value.expiry_date_from || !value.expiry_date_to || value.expiry_date_to >= value.expiry_date_from,
  {
    message: "expiry_date_to must not be before expiry_date_from",
    path: ["expiry_date_to"],
  },
).refine(isBoundedWindow, {
  message: "page and page_size must not scan beyond the 100,000-item logical window",
  path: ["page"],
});

export const getQuoteSchema = z.object({
  quote_id: xeroId,
}).strict();

export const purchaseOrderStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "AUTHORISED",
  "BILLED",
  "DELETED",
]);

export const purchaseOrderSortSchema = z.enum([
  "DATE_ASC",
  "DATE_DESC",
  "DELIVERY_DATE_ASC",
  "DELIVERY_DATE_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

export const listPurchaseOrdersSchema = z.object({
  status: purchaseOrderStatusSchema.optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  page: pageSchema,
  page_size: pageSizeSchema,
  sort: purchaseOrderSortSchema.default("DATE_DESC"),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine(isBoundedWindow, {
  message: "page and page_size must not scan beyond the 100,000-item window",
  path: ["page"],
});

export const getPurchaseOrderSchema = z.object({
  purchase_order_id: xeroId,
}).strict();

export const manualJournalStatusSchema = z.enum([
  "DRAFT",
  "POSTED",
  "DELETED",
  "VOIDED",
]);

export const manualJournalSortSchema = z.enum([
  "DATE_ASC",
  "DATE_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

export const listManualJournalsSchema = z.object({
  status: manualJournalStatusSchema.optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  search_term: searchTermSchema.optional(),
  page: pageSchema,
  page_size: pageSizeSchema,
  sort: manualJournalSortSchema.default("DATE_DESC"),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine(isBoundedWindow, {
  message: "page and page_size must not scan beyond the 100,000-item window",
  path: ["page"],
});

export const getManualJournalSchema = z.object({
  manual_journal_id: xeroId,
}).strict();

export const getCreditNoteSchema = z.object({
  credit_note_id: xeroId,
}).strict();

export const itemSortSchema = z.enum([
  "CODE_ASC",
  "CODE_DESC",
  "NAME_ASC",
  "NAME_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

/**
 * Xero does not expose a status enum for Items. These filters mirror the
 * official IsSold, IsPurchased, and IsTrackedAsInventory properties.
 */
export const listItemsSchema = z.object({
  is_sold: z.boolean().optional(),
  is_purchased: z.boolean().optional(),
  is_tracked_as_inventory: z.boolean().optional(),
  search_term: searchTermSchema.optional(),
  page: pageSchema,
  page_size: pageSizeSchema,
  sort: itemSortSchema.default("CODE_ASC"),
}).strict().refine(isBoundedWindow, {
  message: "page and page_size must not scan beyond the 100,000-item logical window",
  path: ["page"],
});

export const getItemSchema = z.object({
  item_id: xeroId,
}).strict();

export const bankTransactionTypeSchema = z.enum([
  "RECEIVE",
  "RECEIVE-OVERPAYMENT",
  "RECEIVE-PREPAYMENT",
  "SPEND",
  "SPEND-OVERPAYMENT",
  "SPEND-PREPAYMENT",
  "RECEIVE-TRANSFER",
  "SPEND-TRANSFER",
]);

export const bankTransactionStatusSchema = z.enum([
  "AUTHORISED",
  "DELETED",
]);

export const bankTransactionSortSchema = z.enum([
  "DATE_ASC",
  "DATE_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

export const listBankTransactionsSchema = z.object({
  type: bankTransactionTypeSchema.optional(),
  status: bankTransactionStatusSchema.optional(),
  is_reconciled: z.boolean().optional(),
  contact_id: xeroId.optional(),
  bank_account_id: xeroId.optional(),
  invoice_number: z.string().trim().min(1).max(255).optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  search_term: searchTermSchema.optional(),
  page: pageSchema,
  page_size: pageSizeSchema,
  sort: bankTransactionSortSchema.default("DATE_DESC"),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine(isBoundedWindow, {
  message: "page and page_size must not scan beyond the 100,000-item window",
  path: ["page"],
});

export const getBankTransactionSchema = z.object({
  bank_transaction_id: xeroId,
}).strict();

export type QuoteStatus = z.infer<typeof quoteStatusSchema>;
export type QuoteSort = z.infer<typeof quoteSortSchema>;
export type ListQuotesInput = z.infer<typeof listQuotesSchema>;
export type GetQuoteInput = z.infer<typeof getQuoteSchema>;
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;
export type PurchaseOrderSort = z.infer<typeof purchaseOrderSortSchema>;
export type ListPurchaseOrdersInput = z.infer<typeof listPurchaseOrdersSchema>;
export type GetPurchaseOrderInput = z.infer<typeof getPurchaseOrderSchema>;
export type ManualJournalStatus = z.infer<typeof manualJournalStatusSchema>;
export type ManualJournalSort = z.infer<typeof manualJournalSortSchema>;
export type ListManualJournalsInput = z.infer<typeof listManualJournalsSchema>;
export type GetManualJournalInput = z.infer<typeof getManualJournalSchema>;
export type GetCreditNoteInput = z.infer<typeof getCreditNoteSchema>;
export type ItemSort = z.infer<typeof itemSortSchema>;
export type ListItemsInput = z.infer<typeof listItemsSchema>;
export type GetItemInput = z.infer<typeof getItemSchema>;
export type BankTransactionType = z.infer<typeof bankTransactionTypeSchema>;
export type BankTransactionStatus = z.infer<typeof bankTransactionStatusSchema>;
export type BankTransactionSort = z.infer<typeof bankTransactionSortSchema>;
export type ListBankTransactionsInput = z.infer<typeof listBankTransactionsSchema>;
export type GetBankTransactionInput = z.infer<typeof getBankTransactionSchema>;
