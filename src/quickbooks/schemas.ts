import { z } from "zod/v4";
import { Buffer } from "node:buffer";
import { QUICKBOOKS_REPORTS, QUICKBOOKS_TRANSACTION_ENTITIES } from "../providers/quickbooksProvider.js";

const yyyyMmDd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const providerId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
const taxCodeId = providerId.refine((value) => /^\d+$/.test(value), {
  message: "must use a numeric TaxCode Id returned by quickbooks_list_tax_codes; for NON/no-tax use global_tax_calculation=NotApplicable and omit tax_code_id",
});
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const nonNegativeMoney = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);
const money = nonNegativeMoney.refine(
  (value) => Number(value) > 0,
  "must be greater than zero",
);

export const quickBooksNoInputSchema = z.object({}).strict();

export const quickBooksSearchVendorsSchema = z.object({
  query: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const quickBooksSearchCustomersSchema = quickBooksSearchVendorsSchema;

export const quickBooksListItemsSchema = quickBooksNoInputSchema;

export const quickBooksListTransactionsSchema = z.object({
  entity: z.enum(QUICKBOOKS_TRANSACTION_ENTITIES),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  customer_id: providerId.optional(),
  vendor_id: providerId.optional(),
  open_only: z.boolean().optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  page_size: z.number().int().min(1).max(50).default(25),
}).strict().superRefine((value, context) => {
  if (value.date_from && value.date_to && value.date_to < value.date_from) {
    context.addIssue({ code: "custom", message: "date_to must not be before date_from", path: ["date_to"] });
  }
  const customerEntities = ["Invoice", "Payment", "CreditMemo", "SalesReceipt", "RefundReceipt"];
  const vendorEntities = ["Purchase", "BillPayment", "VendorCredit"];
  if (value.customer_id && !customerEntities.includes(value.entity)) {
    context.addIssue({ code: "custom", message: `${value.entity} does not support customer_id`, path: ["customer_id"] });
  }
  if (value.vendor_id && !vendorEntities.includes(value.entity)) {
    context.addIssue({ code: "custom", message: `${value.entity} does not support vendor_id`, path: ["vendor_id"] });
  }
  if (value.customer_id && value.vendor_id) {
    context.addIssue({ code: "custom", message: "use either customer_id or vendor_id, not both", path: ["vendor_id"] });
  }
  if (value.open_only && value.entity !== "Invoice") {
    context.addIssue({ code: "custom", message: "open_only is currently supported for Invoice only", path: ["open_only"] });
  }
});

export const quickBooksGetTransactionSchema = z.object({
  entity: z.enum(QUICKBOOKS_TRANSACTION_ENTITIES),
  transaction_id: providerId,
}).strict();

export const quickBooksRunReportSchema = z.object({
  report: z.enum(QUICKBOOKS_REPORTS),
  start_date: yyyyMmDd.optional(),
  end_date: yyyyMmDd.optional(),
  as_of_date: yyyyMmDd.optional(),
  accounting_method: z.enum(["Cash", "Accrual"]).optional(),
  customer_id: providerId.optional(),
  vendor_id: providerId.optional(),
  max_rows: z.number().int().min(1).max(1_000).default(250),
  view: z.enum(["normalized", "raw", "both"]).default("normalized"),
}).strict().superRefine((value, context) => {
  if (value.start_date && value.end_date && value.end_date < value.start_date) {
    context.addIssue({ code: "custom", message: "end_date must not be before start_date", path: ["end_date"] });
  }
  if (value.as_of_date && (value.start_date || value.end_date)) {
    context.addIssue({
      code: "custom",
      message: "use either as_of_date or start_date/end_date; mixing point-in-time and period windows is ambiguous",
      path: ["as_of_date"],
    });
  }
  if (value.customer_id && value.vendor_id) {
    context.addIssue({ code: "custom", message: "use either customer_id or vendor_id, not both", path: ["vendor_id"] });
  }
  const customerReports = ["CustomerBalance", "AgedReceivables"];
  const vendorReports = ["VendorBalance", "AgedPayables", "VendorExpenses"];
  if (value.customer_id && !customerReports.includes(value.report)) {
    context.addIssue({ code: "custom", message: `${value.report} does not support customer_id`, path: ["customer_id"] });
  }
  if (value.vendor_id && !vendorReports.includes(value.report)) {
    context.addIssue({ code: "custom", message: `${value.report} does not support vendor_id`, path: ["vendor_id"] });
  }
});

export const quickBooksListBillsSchema = z.object({
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  page_size: z.number().int().min(1).max(100).default(25),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
});

export const quickBooksGetBillSchema = z.object({
  bill_id: providerId,
}).strict();

export const quickBooksHashSourceDocumentSchema = z.object({
  source_ref: z.string().trim().min(1).max(256).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u),
  content: z.string().min(1).max(262_144).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 262_144,
    "UTF-8 content must not exceed 262144 bytes",
  ),
}).strict();

const quickBooksBillLineSchema = z.object({
  account_id: providerId,
  amount: money,
  description: z.string().trim().min(1).max(4_000).optional(),
  tax_code_id: taxCodeId.optional(),
}).strict();

export const quickBooksPrepareSupplierBillSchema = z.object({
  request_id: requestId,
  source_ref: z.string().trim().min(1).max(256).regex(/^[^\r\n\u0000-\u001f\u007f]+$/u),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0{64}$/.test(value), {
    message: "must be a real content digest, not the all-zero placeholder",
  }),
  source_digest_provenance: z.enum([
    "AGENT_SUPPLIED_TEXT_FINGERPRINT",
    "HOST_PROVIDED_ORIGINAL_FILE_SHA256",
    "EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256",
  ]).default("EXTERNALLY_SUPPLIED_UNVERIFIED_SHA256"),
  vendor_id: providerId,
  txn_date: yyyyMmDd,
  due_date: yyyyMmDd.optional(),
  doc_number: z.string().trim().min(1).max(21).optional(),
  missing_doc_number_reason: z.string().trim().min(3).max(256).optional(),
  currency_code: z.string().regex(/^[A-Z]{3}$/).optional(),
  memo: z.string().trim().min(1).max(3_000).optional(),
  approval_ref: z.string().trim().min(1).max(256).optional(),
  supporting_evidence: z.array(z.object({
    kind: z.enum(["approval", "coding", "correspondence", "other"]),
    ref: z.string().trim().min(1).max(256),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).refine((value) => !/^0{64}$/.test(value)),
  }).strict()).max(20).default([]),
  global_tax_calculation: z.enum(["TaxExcluded", "TaxInclusive", "NotApplicable"]),
  invoice_total: money,
  tax_total: nonNegativeMoney,
  lines: z.array(quickBooksBillLineSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.due_date && value.due_date < value.txn_date) {
    context.addIssue({ code: "custom", message: "due_date must not be before txn_date", path: ["due_date"] });
  }
  if (!value.doc_number && !value.missing_doc_number_reason) {
    context.addIssue({ code: "custom", message: "provide doc_number or explain why it is missing", path: ["missing_doc_number_reason"] });
  }
  if (value.doc_number && value.missing_doc_number_reason) {
    context.addIssue({ code: "custom", message: "omit missing_doc_number_reason when doc_number is present", path: ["missing_doc_number_reason"] });
  }
  if (value.global_tax_calculation === "NotApplicable" && value.lines.some((line) => line.tax_code_id)) {
    context.addIssue({ code: "custom", message: "tax_code_id must be omitted when global_tax_calculation is NotApplicable", path: ["lines"] });
  }
  if (value.global_tax_calculation !== "NotApplicable" && value.lines.some((line) => !line.tax_code_id)) {
    context.addIssue({ code: "custom", message: "every line needs a QuickBooks tax_code_id for TaxExcluded or TaxInclusive", path: ["lines"] });
  }
  const cents = (amount: string) => Math.round(Number(amount) * 100);
  const lineCents = value.lines.reduce((total, line) => total + cents(line.amount), 0);
  const invoiceCents = cents(value.invoice_total);
  const taxCents = cents(value.tax_total);
  if (value.global_tax_calculation === "NotApplicable" && taxCents !== 0) {
    context.addIssue({ code: "custom", message: "tax_total must be zero when tax is NotApplicable", path: ["tax_total"] });
  }
  const expectedInvoiceCents = value.global_tax_calculation === "TaxExcluded" ? lineCents + taxCents : lineCents;
  if (invoiceCents !== expectedInvoiceCents) {
    context.addIssue({
      code: "custom",
      message: `invoice_total does not reconcile: expected ${(expectedInvoiceCents / 100).toFixed(2)} from lines and tax_total`,
      path: ["invoice_total"],
    });
  }
  if (taxCents > invoiceCents) {
    context.addIssue({ code: "custom", message: "tax_total cannot exceed invoice_total", path: ["tax_total"] });
  }
});

export const quickBooksTrialBalanceSchema = z.object({
  date: yyyyMmDd.optional(),
}).strict();

export type QuickBooksSearchVendorsInput = z.infer<typeof quickBooksSearchVendorsSchema>;
export type QuickBooksSearchCustomersInput = z.infer<typeof quickBooksSearchCustomersSchema>;
export type QuickBooksListTransactionsInput = z.infer<typeof quickBooksListTransactionsSchema>;
export type QuickBooksGetTransactionInput = z.infer<typeof quickBooksGetTransactionSchema>;
export type QuickBooksRunReportInput = z.infer<typeof quickBooksRunReportSchema>;
export type QuickBooksListBillsToolInput = z.infer<typeof quickBooksListBillsSchema>;
export type QuickBooksGetBillInput = z.infer<typeof quickBooksGetBillSchema>;
export type QuickBooksHashSourceDocumentInput = z.infer<typeof quickBooksHashSourceDocumentSchema>;
export type QuickBooksPrepareSupplierBillToolInput = z.infer<typeof quickBooksPrepareSupplierBillSchema>;
export type QuickBooksTrialBalanceInput = z.infer<typeof quickBooksTrialBalanceSchema>;
