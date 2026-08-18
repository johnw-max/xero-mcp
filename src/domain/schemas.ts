import { z } from "zod/v4";

const yyyyMmDd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const xeroId = z.string().uuid();
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const fourDecimalNumber = z.number().positive().refine(
  (value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7,
  "must have at most four decimal places",
);

export const noInputSchema = z.object({}).strict();

export const listAccountsSchema = z.object({
  account_class: z.enum(["ASSET", "EQUITY", "EXPENSE", "LIABILITY", "REVENUE"]).optional(),
}).strict();

export const searchContactsSchema = z.object({
  query: z.string().trim().min(2).max(100),
  limit: z.number().int().min(1).max(25).default(10),
  page: z.number().int().min(1).max(1_000).default(1),
}).strict();

export const listContactsSchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED", "GDPRREQUEST"]).default("ACTIVE"),
  is_supplier: z.boolean().optional(),
  is_customer: z.boolean().optional(),
  page: z.number().int().min(1).max(1_000).default(1),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();

export const getContactSchema = z.object({
  contact_id: xeroId,
}).strict();

export const getSupplierBillSchema = z.object({
  invoice_id: xeroId,
}).strict();

export const invoiceTypeSchema = z.enum(["ACCPAY", "ACCREC"]);

export const invoiceStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "DELETED",
  "AUTHORISED",
  "PAID",
  "VOIDED",
]);

export const invoiceOrderSchema = z.enum([
  "DATE_ASC",
  "DATE_DESC",
  "UPDATED_AT_ASC",
  "UPDATED_AT_DESC",
]);

export const listInvoicesSchema = z.object({
  type: invoiceTypeSchema.optional(),
  contact_id: xeroId.optional(),
  statuses: z.array(invoiceStatusSchema)
    .min(1)
    .max(6)
    .refine((values) => new Set(values).size === values.length, "statuses must not contain duplicates")
    .optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  page_size: z.number().int().min(1).max(100).default(50),
  search_term: z.string().trim().min(1).max(100).optional(),
  include_archived: z.boolean().default(false),
  order: invoiceOrderSchema.default("DATE_DESC"),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine((value) => value.page * value.page_size <= 100_000, {
  message: "page and page_size must not scan beyond Xero's 100,000-item window",
  path: ["page"],
});

export const getInvoiceSchema = z.object({
  invoice_id: xeroId,
  type: invoiceTypeSchema.optional(),
}).strict();

export const creditNoteTypeSchema = z.enum(["ACCPAYCREDIT", "ACCRECCREDIT"]);

export const creditNoteStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "DELETED",
  "AUTHORISED",
  "PAID",
  "VOIDED",
]);

export const listCreditNotesSchema = z.object({
  contact_id: xeroId.optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  status: creditNoteStatusSchema.optional(),
  type: creditNoteTypeSchema.optional(),
  page: z.number().int().min(1).max(1_000).default(1),
  page_size: z.number().int().min(1).max(100).default(50),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine((value) => value.page * value.page_size <= 100_000, {
  message: "page and page_size must not scan beyond Xero's 100,000-item window",
  path: ["page"],
});

export const paymentTypeSchema = z.enum([
  "ACCRECPAYMENT",
  "ACCPAYPAYMENT",
  "ARCREDITPAYMENT",
  "APCREDITPAYMENT",
  "AROVERPAYMENTPAYMENT",
  "ARPREPAYMENTPAYMENT",
  "APPREPAYMENTPAYMENT",
  "APOVERPAYMENTPAYMENT",
]);

export const paymentStatusSchema = z.enum(["AUTHORISED", "DELETED"]);

export const listPaymentsSchema = z.object({
  contact_id: xeroId.optional(),
  date_from: yyyyMmDd.optional(),
  date_to: yyyyMmDd.optional(),
  status: paymentStatusSchema.optional(),
  type: paymentTypeSchema.optional(),
  page: z.number().int().min(1).max(1_000).default(1),
  page_size: z.number().int().min(1).max(100).default(50),
}).strict().refine((value) => !value.date_from || !value.date_to || value.date_to >= value.date_from, {
  message: "date_to must not be before date_from",
  path: ["date_to"],
}).refine((value) => !value.contact_id || value.type !== undefined, {
  message: "type is required with contact_id so the server can use one reviewed Xero association path",
  path: ["type"],
}).refine((value) => value.page * value.page_size <= 100_000, {
  message: "page and page_size must not scan beyond Xero's 100,000-item window",
  path: ["page"],
});

const draftLineSchema = z.object({
  description: z.string().trim().min(1).max(4_000),
  quantity: fourDecimalNumber.max(1_000_000),
  unit_amount: fourDecimalNumber.max(1_000_000_000),
  /** Server-resolved provider binding; public preparation schemas do not expose this field. */
  account_id: xeroId.optional(),
  account_code: z.string().trim().min(1).max(10),
  tax_type: z.string().trim().min(1).max(100),
}).strict();

const supplierBillDraftPreparationLineSchema = z.object({
  description: z.string().trim().min(1).max(4_000).optional(),
  quantity: fourDecimalNumber.max(1_000_000).optional(),
  unit_amount: fourDecimalNumber.max(1_000_000_000).optional(),
  account_code: z.string().trim().min(1).max(10).optional(),
  account_name: z.string().trim().min(1).max(255).optional(),
  tax_type: z.string().trim().min(1).max(100).optional(),
  tax_name: z.string().trim().min(1).max(255).optional(),
}).strict();

const salesInvoiceDraftPreparationLineSchema = supplierBillDraftPreparationLineSchema;
const invoiceAuthoritativeProviderFieldSchema = z.enum(["INVOICE_NUMBER", "REFERENCE"]);

/**
 * Fields are intentionally optional here. The preparation tool reports missing
 * accounting evidence as structured blockers instead of letting an Agent turn
 * an absent value into a guessed Xero identifier.
 */
export const prepareSupplierBillDraftSchema = z.object({
  source_ref: z.string().trim().min(1).max(512).optional(),
  source_unit_key: z.string().trim().min(1).max(256).optional(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  supplier_name: z.string().trim().min(1).max(255).optional(),
  supplier_contact_number: z.string().trim().min(1).max(100).optional(),
  invoice_date: yyyyMmDd.optional(),
  due_date: yyyyMmDd.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  currency_rate: fourDecimalNumber.optional(),
  reference: z.string().trim().min(1).max(255).optional(),
  authoritative_provider_field: z.literal("INVOICE_NUMBER").optional(),
  line_amount_type: z.enum(["Exclusive", "Inclusive", "NoTax"]).optional(),
  lines: z.array(supplierBillDraftPreparationLineSchema).max(20).optional(),
}).strict();

export const prepareSalesInvoiceDraftSchema = z.object({
  source_ref: z.string().trim().min(1).max(512).optional(),
  source_unit_key: z.string().trim().min(1).max(256).optional(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  customer_name: z.string().trim().min(1).max(255).optional(),
  customer_contact_number: z.string().trim().min(1).max(100).optional(),
  invoice_date: yyyyMmDd.optional(),
  due_date: yyyyMmDd.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  currency_rate: fourDecimalNumber.optional(),
  reference: z.string().trim().min(1).max(255).optional(),
  authoritative_provider_field: invoiceAuthoritativeProviderFieldSchema.optional(),
  line_amount_type: z.enum(["Exclusive", "Inclusive", "NoTax"]).optional(),
  lines: z.array(salesInvoiceDraftPreparationLineSchema).max(20).optional(),
}).strict();

export const sourceEvidenceTypeSchema = z.enum([
  "AGENT_ASSERTED_UNVERIFIED",
  "SERVER_FINGERPRINTED_EXTRACTION",
]);

export const createDraftSupplierBillSchema = z.object({
  request_id: requestId,
  source_ref: z.string().trim().min(1).max(512),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_evidence_type: sourceEvidenceTypeSchema,
  user_confirmation: z.literal("CONFIRMED_FOR_DRAFT"),
  contact_id: xeroId,
  invoice_date: yyyyMmDd,
  due_date: yyyyMmDd,
  currency: z.string().regex(/^[A-Z]{3}$/),
  currency_rate: fourDecimalNumber.optional(),
  reference: z.string().trim().min(1).max(255),
  authoritative_provider_field: invoiceAuthoritativeProviderFieldSchema,
  line_amount_type: z.enum(["Exclusive", "Inclusive", "NoTax"]),
  lines: z.array(draftLineSchema).min(1).max(20),
}).strict().refine((value) => value.due_date >= value.invoice_date, {
  message: "due_date must not be before invoice_date",
  path: ["due_date"],
});

/**
 * Sales invoices use the same reviewed accounting fields as supplier bills,
 * but are exposed through a distinct schema/tool so ACCREC can never be
 * selected by an Agent-controlled type flag.
 */
export const createDraftSalesInvoiceSchema = createDraftSupplierBillSchema;

export const authoriseSupplierBillSchema = z.object({
  posting_request_id: z.string().regex(/^pr_[A-Za-z0-9_-]{16,}$/),
  invoice_id: xeroId,
  expected_status: z.literal("DRAFT"),
  approval_ref: z.string().min(32).max(256),
  approved_payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_id: requestId,
}).strict();

export const trialBalanceSchema = z.object({
  date: yyyyMmDd.optional(),
}).strict();

export type ListAccountsInput = z.infer<typeof listAccountsSchema>;
export type ListContactsInput = z.infer<typeof listContactsSchema>;
export type GetContactInput = z.infer<typeof getContactSchema>;
export type SearchContactsInput = z.infer<typeof searchContactsSchema>;
export type GetSupplierBillInput = z.infer<typeof getSupplierBillSchema>;
export type InvoiceType = z.infer<typeof invoiceTypeSchema>;
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export type InvoiceOrder = z.infer<typeof invoiceOrderSchema>;
export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;
export type GetInvoiceInput = z.infer<typeof getInvoiceSchema>;
export type CreditNoteType = z.infer<typeof creditNoteTypeSchema>;
export type CreditNoteStatus = z.infer<typeof creditNoteStatusSchema>;
export type ListCreditNotesInput = z.infer<typeof listCreditNotesSchema>;
export type PaymentType = z.infer<typeof paymentTypeSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;
export type SourceEvidenceType = z.infer<typeof sourceEvidenceTypeSchema>;
export type CreateDraftSupplierBillInput = z.infer<typeof createDraftSupplierBillSchema>;
export type PrepareSupplierBillDraftInput = z.infer<typeof prepareSupplierBillDraftSchema>;
export type CreateDraftSalesInvoiceInput = z.infer<typeof createDraftSalesInvoiceSchema>;
export type PrepareSalesInvoiceDraftInput = z.infer<typeof prepareSalesInvoiceDraftSchema>;
export type AuthoriseSupplierBillInput = z.infer<typeof authoriseSupplierBillSchema>;
export type TrialBalanceInput = z.infer<typeof trialBalanceSchema>;
