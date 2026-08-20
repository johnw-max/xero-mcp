import {
  Account,
  Contact,
  CreditNote,
  CurrencyCode,
  Invoice,
  LineAmountTypes,
  Payment,
  TaxRate,
} from "xero-node";
import type {
  AgedPayablesInput,
  AgedReceivablesInput,
  BalanceSheetInput,
  CreateDraftSalesInvoiceInput,
  CreateDraftSupplierBillInput,
  CreditNoteType,
  InvoiceOrder,
  InvoiceType,
  ListContactsInput,
  ListCreditNotesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  PaymentType,
  ProfitAndLossInput,
} from "../domain/schemas.js";
import type {
  ListBankTransactionsInput,
  ListContactGroupsInput,
  ListItemsInput,
  ListJournalsInput,
  ListManualJournalsInput,
  ListPurchaseOrdersInput,
  ListQuotesInput,
  ListTrackingCategoriesInput,
} from "../domain/extendedReadSchemas.js";
import type { AccountingRepository } from "../db/repository.js";
import { AppError } from "../errors.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import { xeroProviderWritePermitMode } from "../security/xeroProviderWritePermit.js";
import { XeroClientManager, type XeroReadClient } from "./xeroClientManager.js";
import type {
  AccountingPrincipal,
  AccountingProvider,
  AccountSummary,
  ActorTenantContext,
  ConnectionSummary,
  ContactSearchResult,
  ContactListResult,
  ContactGroupListResult,
  ContactSummary,
  CreditNoteListResult,
  CreditNoteSnapshot,
  CreditNoteSummary,
  InvoiceListResult,
  InvoiceSnapshot,
  InvoiceSummary,
  JournalListResult,
  OrganisationSummary,
  PaymentListResult,
  PaymentSummary,
  BankTransactionListResult,
  ItemListResult,
  ManualJournalListResult,
  PurchaseOrderListResult,
  QuoteListResult,
  ProviderWriteResult,
  ProviderSalesInvoiceWriteResult,
  RecordProviderDraftWriteEvidence,
  SalesInvoiceSnapshot,
  SupplierBillSnapshot,
  SupplierBillDraftReferenceData,
  TaxRateSummary,
  TrackingCategoryListResult,
} from "./types.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import { describeLegacyXeroScopePolicyProblems } from "./xeroScopes.js";
import { xeroProviderInstant } from "./xeroProviderDate.js";
import {
  buildBankTransactionReadQuery,
  buildItemReadQuery,
  buildManualJournalReadQuery,
  buildPurchaseOrderReadQuery,
  buildQuoteReadQuery,
  mapBankTransactionSnapshot,
  mapBankTransactionSummary,
  mapBoundedExtendedReadPage,
  mapItemSummary,
  mapJournalsPage,
  mapManualJournalSnapshot,
  mapManualJournalSummary,
  mapPurchaseOrderSnapshot,
  mapPurchaseOrderSummary,
  mapQuoteSnapshot,
  mapQuoteSummary,
  mapXeroReportEnvelope,
  XERO_QUOTE_PROVIDER_PAGE_CAPACITY,
  type BankTransactionSnapshot,
  type ItemSummary,
  type ManualJournalSnapshot,
  type PurchaseOrderSnapshot,
  type QuoteSnapshot,
} from "./xeroExtendedReadMapper.js";
import { xeroProviderDate as xeroDate } from "./xeroProviderDate.js";

type XeroInvoice = InstanceType<typeof Invoice>;
type XeroCreditNote = InstanceType<typeof CreditNote>;
type XeroPayment = InstanceType<typeof Payment>;
type XeroAccount = InstanceType<typeof Account>;
type XeroTaxRate = InstanceType<typeof TaxRate>;
type XeroContact = InstanceType<typeof Contact>;

const MAX_AGENT_INVOICE_LINES = 100;
const MAX_ASSOCIATED_INVOICE_IDS = 25;

function assertDraftWriteEvidenceRecorder(
  recordWriteEvidence: RecordProviderDraftWriteEvidence | undefined,
): asserts recordWriteEvidence is RecordProviderDraftWriteEvidence {
  if (recordWriteEvidence) return;
  throw new AppError(
    "CONFIGURATION_ERROR",
    "A durable Xero draft write-evidence recorder is required before any provider mutation.",
    {
      httpStatus: 500,
      retryable: false,
      details: {
        providerMutationPossible: false,
        reasonCodes: ["WRITE_EVIDENCE_CALLBACK_REQUIRED"],
      },
    },
  );
}

const INVOICE_ORDER: Record<InvoiceOrder, string> = {
  DATE_ASC: "Date ASC",
  DATE_DESC: "Date DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

function decimal(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(4);
}

function boundedProviderText(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maxLength);
}

function accountingInvoiceType(value: unknown): InvoiceType | undefined {
  if (value === Invoice.TypeEnum.ACCPAY) return "ACCPAY";
  if (value === Invoice.TypeEnum.ACCREC) return "ACCREC";
  return undefined;
}

function accountingCreditNoteType(value: unknown): CreditNoteType | undefined {
  if (value === CreditNote.TypeEnum.ACCPAYCREDIT) return "ACCPAYCREDIT";
  if (value === CreditNote.TypeEnum.ACCRECCREDIT) return "ACCRECCREDIT";
  return undefined;
}

const PAYMENT_TYPES = new Set<PaymentType>([
  "ACCRECPAYMENT",
  "ACCPAYPAYMENT",
  "ARCREDITPAYMENT",
  "APCREDITPAYMENT",
  "AROVERPAYMENTPAYMENT",
  "ARPREPAYMENTPAYMENT",
  "APPREPAYMENTPAYMENT",
  "APOVERPAYMENTPAYMENT",
]);

function accountingPaymentType(value: unknown): PaymentType | undefined {
  const type = typeof value === "string" ? value : String(value ?? "");
  return PAYMENT_TYPES.has(type as PaymentType) ? type as PaymentType : undefined;
}

function xeroDateTime(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `DateTime(${year},${month},${day})`;
}

function invoiceWhere(input: ListInvoicesInput): string | undefined {
  const clauses: string[] = [];
  if (input.type) clauses.push(`Type=="${input.type}"`);
  if (input.date_from) clauses.push(`Date>=${xeroDateTime(input.date_from)}`);
  if (input.date_to) clauses.push(`Date<=${xeroDateTime(input.date_to)}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

function contactWhere(input: ListContactsInput): string {
  const clauses = [`ContactStatus=="${input.status}"`];
  if (input.is_supplier !== undefined) clauses.push(`IsSupplier==${input.is_supplier}`);
  if (input.is_customer !== undefined) clauses.push(`IsCustomer==${input.is_customer}`);
  return clauses.join(" AND ");
}

function creditNoteWhere(input: ListCreditNotesInput): string | undefined {
  const clauses: string[] = [];
  if (input.type) clauses.push(`Type=="${input.type}"`);
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.contact_id) clauses.push(`Contact.ContactID==Guid("${input.contact_id}")`);
  if (input.date_from) clauses.push(`Date>=${xeroDateTime(input.date_from)}`);
  if (input.date_to) clauses.push(`Date<=${xeroDateTime(input.date_to)}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

const PAYMENT_CONTACT_PATH: Readonly<Record<PaymentType, string>> = {
  ACCRECPAYMENT: "Invoice.Contact.ContactID",
  ACCPAYPAYMENT: "Invoice.Contact.ContactID",
  ARCREDITPAYMENT: "CreditNote.Contact.ContactID",
  APCREDITPAYMENT: "CreditNote.Contact.ContactID",
  AROVERPAYMENTPAYMENT: "Overpayment.Contact.ContactID",
  ARPREPAYMENTPAYMENT: "Prepayment.Contact.ContactID",
  APPREPAYMENTPAYMENT: "Prepayment.Contact.ContactID",
  APOVERPAYMENTPAYMENT: "Overpayment.Contact.ContactID",
};

function paymentWhere(input: ListPaymentsInput): string | undefined {
  const clauses: string[] = [];
  if (input.type) clauses.push(`PaymentType=="${input.type}"`);
  if (input.status) clauses.push(`Status=="${input.status}"`);
  if (input.contact_id && input.type) {
    clauses.push(`${PAYMENT_CONTACT_PATH[input.type]}==Guid("${input.contact_id}")`);
  }
  if (input.date_from) clauses.push(`Date>=${xeroDateTime(input.date_from)}`);
  if (input.date_to) clauses.push(`Date<=${xeroDateTime(input.date_to)}`);
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

function parseXeroSdkError(error: unknown): {
  code?: string;
  status?: number;
  body?: unknown;
} {
  let candidate: unknown = error;
  if (typeof error === "string") {
    try {
      candidate = JSON.parse(error);
    } catch {
      return { body: error };
    }
  }
  if (!candidate || typeof candidate !== "object") return {};
  const value = candidate as {
    code?: unknown;
    body?: unknown;
    response?: { status?: unknown; statusCode?: unknown; body?: unknown };
  };
  const statusCandidate = value.response?.statusCode ?? value.response?.status;
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof statusCandidate === "number" ? { status: statusCandidate } : {}),
    ...(value.body !== undefined
      ? { body: value.body }
      : value.response?.body !== undefined
        ? { body: value.response.body }
        : {}),
  };
}

function xeroErrorBodyText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 10_000);
  try {
    return JSON.stringify(body).slice(0, 10_000);
  } catch {
    return "";
  }
}

function isHighVolumeQueryError(error: unknown): boolean {
  const candidate = parseXeroSdkError(error);
  return candidate.status === 400 && /high\s*volume(?:exception)?/i.test(xeroErrorBodyText(candidate.body));
}

function providerRequestId(response: { headers?: unknown }): string | undefined {
  if (!response.headers || typeof response.headers !== "object") return undefined;
  const headers = response.headers as Record<string, unknown>;
  const value = headers["xero-correlation-id"] ?? headers["x-request-id"];
  return typeof value === "string" ? value : undefined;
}

function persistedInvoiceCanonicalPayload(
  input: CreateDraftSupplierBillInput | CreateDraftSalesInvoiceInput,
): Record<string, unknown> {
  const { user_confirmation: _confirmation, ...canonicalPayload } = input;
  return canonicalPayload as unknown as Record<string, unknown>;
}

/**
 * Existing-document updates accept the sealed, complete draft projection,
 * rather than a patch. The Case compiler uses provider-neutral field names
 * while the older direct draft path uses snake case; this small compatibility
 * union keeps both paths on the same action-specific transport.
 */
export interface InvoiceDraftUpdateCanonicalPayload {
  readonly schemaVersion?: string;
  readonly route?: string;
  readonly documentKind?: string;
  readonly type?: string;
  readonly contactId?: string;
  readonly xeroContactId?: string;
  readonly contact_id?: string;
  readonly documentDate?: string;
  readonly invoiceDate?: string;
  readonly invoice_date?: string;
  readonly dueDate?: string;
  readonly due_date?: string;
  readonly currency?: string;
  readonly currencyRate?: number | string;
  readonly invoiceRate?: number | string;
  readonly currency_rate?: number | string;
  readonly reference?: string;
  readonly invoiceNumber?: string;
  readonly authoritativeProviderField?: "INVOICE_NUMBER" | "REFERENCE" | string;
  readonly authoritative_provider_field?: "INVOICE_NUMBER" | "REFERENCE" | string;
  readonly lineAmountType?: string;
  readonly line_amount_type?: string;
  readonly lines?: readonly InvoiceDraftUpdateCanonicalLine[];
  readonly net?: number | string;
  readonly tax?: number | string;
  readonly gross?: number | string;
  readonly subTotal?: number | string;
  readonly totalTax?: number | string;
  readonly total?: number | string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export interface InvoiceDraftUpdateCanonicalLine {
  readonly description: string;
  readonly quantity: number | string;
  readonly unitAmount?: number | string;
  readonly unit_amount?: number | string;
  readonly lineAmount?: number | string;
  readonly line_amount?: number | string;
  readonly accountId?: string;
  readonly account_id?: string;
  readonly accountCode?: string;
  readonly account_code?: string;
  readonly taxType?: string;
  readonly tax_type?: string;
  readonly [key: string]: unknown;
}

export interface InvoiceDraftUpdateRequest {
  readonly targetXeroObjectId: string;
  readonly replacement: InvoiceDraftUpdateCanonicalPayload;
}

interface NormalizedInvoiceDraftUpdate {
  readonly targetXeroObjectId: string;
  readonly replacementPayload: Record<string, unknown>;
  readonly contactId: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly currency: CurrencyCode;
  readonly currencyCode: string;
  readonly currencyRate?: number;
  readonly reference: string;
  readonly authoritativeProviderField: "INVOICE_NUMBER" | "REFERENCE";
  readonly lineAmountType: LineAmountTypes;
  readonly canonicalLineAmountType: "Exclusive" | "Inclusive" | "NoTax";
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unitAmount: number;
    readonly accountId?: string;
    readonly accountCode: string;
    readonly taxType: string;
  }[];
}

function draftUpdateValidation(message: string, invalidFields: readonly string[] = []): AppError {
  return new AppError("VALIDATION_FAILED", message, {
    httpStatus: 422,
    retryable: false,
    details: {
      providerMutationPossible: false,
      reasonCodes: ["INVOICE_DRAFT_UPDATE_INPUT_INVALID"],
      ...(invalidFields.length > 0 ? { invalidFields: [...invalidFields] } : {}),
    },
  });
}

function exactInvoiceId(value: unknown): string | undefined {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    return undefined;
  }
  return value;
}

function expectedUpdatedAtInstant(value: unknown): number | undefined {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

function expectedUpdatedAtConflict(
  message: string,
  reasonCode: string,
  expectedUpdatedAt?: string,
  actualUpdatedAt?: string,
): AppError {
  const actualInstant = expectedUpdatedAtInstant(actualUpdatedAt);
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
      ...(actualInstant !== undefined ? { actualUpdatedAt: new Date(actualInstant).toISOString() } : {}),
      reasonCodes: [reasonCode],
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
    },
  });
}

function draftDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : undefined;
}

function draftDecimal(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(number) || number <= 0 || Math.abs(number * 10_000 - Math.round(number * 10_000)) > 1e-7) {
    return undefined;
  }
  return number;
}

function draftNonNegativeDecimal(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || Math.abs(number * 10_000 - Math.round(number * 10_000)) > 1e-7) {
    return undefined;
  }
  return number;
}

function optionalDraftDecimal(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(number) && number > 0 &&
    Math.abs(number * 10_000 - Math.round(number * 10_000)) <= 1e-7
    ? number
    : undefined;
}

function canonicalLineAmountType(value: unknown): {
  provider: LineAmountTypes;
  canonical: "Exclusive" | "Inclusive" | "NoTax";
} | undefined {
  switch (value) {
    case "EXCLUSIVE":
    case "Exclusive":
      return { provider: LineAmountTypes.Exclusive, canonical: "Exclusive" };
    case "INCLUSIVE":
    case "Inclusive":
      return { provider: LineAmountTypes.Inclusive, canonical: "Inclusive" };
    case "NO_TAX":
    case "NoTax":
    case "NOTAX":
      return { provider: LineAmountTypes.NoTax, canonical: "NoTax" };
    default:
      return undefined;
  }
}

function normalizeInvoiceDraftUpdate(
  targetXeroObjectId: unknown,
  input: unknown,
  expectedType: "ACCPAY" | "ACCREC",
): NormalizedInvoiceDraftUpdate {
  const target = exactInvoiceId(targetXeroObjectId);
  if (!target) throw draftUpdateValidation("The existing invoice target must be an exact Xero UUID.", ["targetXeroObjectId"]);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw draftUpdateValidation("An existing invoice DRAFT update requires the complete canonical payload.", ["canonicalPayload"]);
  }
  const value = input as Record<string, unknown>;
  const declaredType = value.type;
  if (declaredType !== undefined && declaredType !== expectedType) {
    throw draftUpdateValidation("The invoice DRAFT update route does not match the sealed Xero invoice type.", ["type"]);
  }
  if (value.status !== undefined && value.status !== "DRAFT") {
    throw draftUpdateValidation("An invoice DRAFT replacement must keep status DRAFT.", ["status"]);
  }
  const contactId = exactInvoiceId(value.xeroContactId ?? value.contactId ?? value.contact_id);
  const invoiceDate = draftDate(value.documentDate ?? value.invoiceDate ?? value.invoice_date);
  const dueDate = draftDate(value.dueDate ?? value.due_date);
  const currencyCode = typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency)
    ? value.currency
    : undefined;
  const currency = currencyCode
    ? CurrencyCode[currencyCode as keyof typeof CurrencyCode]
    : undefined;
  const currencyRateValue = value.invoiceRate ?? value.currencyRate ?? value.currency_rate;
  const currencyRate = optionalDraftDecimal(currencyRateValue);
  const referenceValue = value.reference ?? value.invoiceNumber;
  const reference = typeof referenceValue === "string" && referenceValue.trim().length > 0 && referenceValue.length <= 255
    ? referenceValue.trim()
    : undefined;
  const authoritativeFieldValue = value.authoritativeProviderField ?? value.authoritative_provider_field;
  const authoritativeProviderField = authoritativeFieldValue === undefined
    ? "INVOICE_NUMBER"
    : authoritativeFieldValue === "INVOICE_NUMBER" || authoritativeFieldValue === "REFERENCE"
      ? authoritativeFieldValue
      : undefined;
  const lineAmountType = canonicalLineAmountType(value.lineAmountType ?? value.line_amount_type);
  const rawLines = value.lines;
  const lines = Array.isArray(rawLines) && rawLines.length > 0 && rawLines.length <= 20
    ? rawLines.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
      const line = candidate as Record<string, unknown>;
      const description = typeof line.description === "string" && line.description.trim().length > 0 &&
        line.description.length <= 4_000 ? line.description.trim() : undefined;
      const quantity = draftDecimal(line.quantity);
      const unitAmount = draftNonNegativeDecimal(line.unitAmount ?? line.unit_amount);
      const accountIdValue = line.accountId ?? line.account_id;
      const accountId = accountIdValue === undefined ? undefined : exactInvoiceId(accountIdValue);
      const accountCodeValue = line.accountCode ?? line.account_code;
      const accountCode = typeof accountCodeValue === "string" && accountCodeValue.trim().length > 0 &&
        accountCodeValue.length <= 10 ? accountCodeValue.trim() : undefined;
      const taxValue = line.taxType ?? line.tax_type;
      const taxType = typeof taxValue === "string" && taxValue.trim().length > 0 && taxValue.length <= 100
        ? taxValue.trim()
        : undefined;
      if (!description || quantity === undefined || unitAmount === undefined || !accountCode || !taxType ||
          (accountIdValue !== undefined && !accountId)) return undefined;
      return {
        description,
        quantity,
        unitAmount,
        ...(accountId ? { accountId } : {}),
        accountCode,
        taxType,
      };
    }).filter((line): line is NonNullable<typeof line> => line !== undefined)
    : [];
  if (!contactId || !invoiceDate || !dueDate || dueDate < invoiceDate || !currency || !currencyCode ||
      !reference || authoritativeProviderField === undefined || !lineAmountType ||
      (currencyRateValue !== undefined && currencyRate === undefined) ||
      (expectedType === "ACCPAY" && authoritativeProviderField !== "INVOICE_NUMBER") ||
      !Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 20 ||
      lines.length !== (Array.isArray(rawLines) ? rawLines.length : 0)) {
    const fields = [
      ...(!contactId ? ["contactId"] : []),
      ...(!invoiceDate ? ["documentDate"] : []),
      ...(!dueDate ? ["dueDate"] : []),
      ...(invoiceDate && dueDate && dueDate < invoiceDate ? ["dueDate"] : []),
      ...(!currency ? ["currency"] : []),
      ...(!reference ? ["reference"] : []),
      ...(authoritativeProviderField === undefined ? ["authoritativeProviderField"] : []),
      ...(currencyRateValue !== undefined && currencyRate === undefined ? ["currencyRate"] : []),
      ...(expectedType === "ACCPAY" && authoritativeProviderField !== "INVOICE_NUMBER"
        ? ["authoritativeProviderField"]
        : []),
      ...(!lineAmountType ? ["lineAmountType"] : []),
      ...(lines.length !== (Array.isArray(rawLines) ? rawLines.length : 0) ? ["lines"] : []),
    ];
    throw draftUpdateValidation("The invoice DRAFT replacement is not a complete canonical payload.", fields);
  }
  return {
    targetXeroObjectId: target,
    replacementPayload: { ...value },
    contactId,
    invoiceDate,
    dueDate,
    currency,
    currencyCode,
    ...(currencyRate !== undefined ? { currencyRate } : {}),
    reference,
    authoritativeProviderField,
    lineAmountType: lineAmountType.provider,
    canonicalLineAmountType: lineAmountType.canonical,
    lines,
  };
}

function invoiceDraftReadbackMismatches(
  expected: NormalizedInvoiceDraftUpdate,
  actual: InvoiceSnapshot,
  expectedType: "ACCPAY" | "ACCREC",
): string[] {
  const mismatches: string[] = [];
  const sameDecimal = (left: number | string | undefined, right: string | undefined): boolean =>
    left !== undefined && right !== undefined && Number(left).toFixed(4) === Number(right).toFixed(4);
  if (actual.invoiceId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase()) mismatches.push("invoiceId");
  if (actual.type !== expectedType) mismatches.push("type");
  if (actual.status !== "DRAFT") mismatches.push("status");
  if (actual.contact.contactId.toLowerCase() !== expected.contactId.toLowerCase()) mismatches.push("contactId");
  if (actual.invoiceDate !== expected.invoiceDate) mismatches.push("invoiceDate");
  if (actual.dueDate !== expected.dueDate) mismatches.push("dueDate");
  if (actual.currency !== expected.currencyCode) mismatches.push("currency");
  if (expected.currencyRate !== undefined && !sameDecimal(expected.currencyRate, actual.currencyRate)) {
    mismatches.push("currencyRate");
  }
  if (expected.authoritativeProviderField === "INVOICE_NUMBER") {
    if (actual.invoiceNumber !== expected.reference) mismatches.push("invoiceNumber");
  } else if (actual.reference !== expected.reference) {
    mismatches.push("reference");
  }
  if (actual.lineAmountType !== expected.canonicalLineAmountType) mismatches.push("lineAmountType");
  if (actual.lines.length !== expected.lines.length || actual.lineItemCount !== expected.lines.length) {
    mismatches.push("lines");
  } else {
    expected.lines.forEach((expectedLine, index) => {
      const actualLine = actual.lines[index];
      if (!actualLine || actualLine.description !== expectedLine.description ||
          !sameDecimal(expectedLine.quantity, actualLine.quantity) ||
          !sameDecimal(expectedLine.unitAmount, actualLine.unitAmount) ||
          actualLine.accountCode !== expectedLine.accountCode || actualLine.taxType !== expectedLine.taxType ||
          (expectedLine.accountId !== undefined &&
            actualLine.accountId?.toLowerCase() !== expectedLine.accountId.toLowerCase())) {
        mismatches.push("lines[" + index + "]");
      }
    });
  }
  for (const [inputField, snapshotField] of [
    ["net", actual.subTotal],
    ["subTotal", actual.subTotal],
    ["tax", actual.totalTax],
    ["totalTax", actual.totalTax],
    ["gross", actual.total],
    ["total", actual.total],
  ] as const) {
    const expectedValue = expected.replacementPayload[inputField];
    if (expectedValue !== undefined && !sameDecimal(expectedValue as number | string, snapshotField)) {
      mismatches.push(inputField);
    }
  }
  if (actual.subTotal === undefined || actual.totalTax === undefined || actual.total === undefined) {
    mismatches.push("economicTotals");
  }
  return [...new Set(mismatches)];
}

function invoiceDraftProviderRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: {
      ...details,
      writeOutcome: "DEFINITELY_REJECTED",
    },
  });
}

function invoiceDraftWriteUnknown(message: string, cause?: unknown, details?: Record<string, unknown>): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause ? { cause } : {}),
    ...(details ? { details } : {}),
  });
}

function invoiceDraftPreflightUnavailable(cause: unknown): AppError {
  return new AppError("PROVIDER_ERROR", "The exact Xero invoice target could not be read before the DRAFT replacement.", {
    httpStatus: 503,
    retryable: true,
    cause,
    details: {
      failureLayer: "PROVIDER_PREFLIGHT",
      reasonCodes: ["EXACT_TARGET_PREFLIGHT_FAILED"],
      recoveryAction: "RETRY_AFTER_PROVIDER_RECOVERS",
      providerMutationPossible: false,
    },
  });
}

function mapContact(contact: XeroContact): ContactSummary | undefined {
  if (!contact.contactID) return undefined;
  const summary: ContactSummary = { contactId: contact.contactID };
  if (contact.name) summary.name = contact.name;
  if (contact.emailAddress) summary.email = contact.emailAddress.trim().toLowerCase();
  if (contact.companyNumber) summary.companyNumber = contact.companyNumber;
  if (contact.accountNumber) summary.accountNumber = contact.accountNumber;
  if (contact.contactNumber) summary.contactNumber = contact.contactNumber;
  if (contact.contactStatus) summary.status = String(contact.contactStatus);
  if (contact.isSupplier !== undefined) summary.isSupplier = contact.isSupplier;
  if (contact.isCustomer !== undefined) summary.isCustomer = contact.isCustomer;
  if (contact.defaultCurrency) summary.defaultCurrency = String(contact.defaultCurrency);
  if (contact.purchasesDefaultAccountCode) summary.purchasesDefaultAccountCode = contact.purchasesDefaultAccountCode;
  if (contact.accountsPayableTaxType) summary.accountsPayableTaxType = contact.accountsPayableTaxType;
  return summary;
}

function mapInvoiceSummary(invoice: XeroInvoice): InvoiceSummary | undefined {
  const type = accountingInvoiceType(invoice.type);
  if (!invoice.invoiceID || !type || !invoice.contact?.contactID) return undefined;

  const summary: InvoiceSummary = {
    invoiceId: invoice.invoiceID,
    type,
    status: String(invoice.status ?? "UNKNOWN"),
    contact: { contactId: invoice.contact.contactID },
  };
  if (invoice.hasAttachments !== undefined) {
    summary.attachmentsKnown = true;
    summary.hasAttachments = invoice.hasAttachments;
  } else if (invoice.attachments !== undefined) {
    summary.attachmentsKnown = true;
    summary.hasAttachments = invoice.attachments.length > 0;
  } else {
    // Xero intentionally omits HasAttachments when summaryOnly=true. Keep the
    // distinction between "unknown" and a verified false value.
    summary.attachmentsKnown = false;
  }
  if (invoice.contact.name) summary.contact.name = invoice.contact.name;
  if (invoice.invoiceNumber) summary.invoiceNumber = invoice.invoiceNumber;
  const invoiceDate = xeroDate(invoice.date);
  const dueDate = xeroDate(invoice.dueDate);
  const fullyPaidOnDate = xeroDate(invoice.fullyPaidOnDate);
  if (invoiceDate) summary.invoiceDate = invoiceDate;
  if (dueDate) summary.dueDate = dueDate;
  if (fullyPaidOnDate) summary.fullyPaidOnDate = fullyPaidOnDate;
  if (invoice.currencyCode) summary.currency = String(invoice.currencyCode);
  const currencyRate = decimal(invoice.currencyRate);
  if (currencyRate !== undefined) summary.currencyRate = currencyRate;
  if (invoice.reference) summary.reference = invoice.reference;
  const subTotal = decimal(invoice.subTotal);
  const totalTax = decimal(invoice.totalTax);
  const total = decimal(invoice.total);
  const amountDue = decimal(invoice.amountDue);
  const amountPaid = decimal(invoice.amountPaid);
  const amountCredited = decimal(invoice.amountCredited);
  if (subTotal !== undefined) summary.subTotal = subTotal;
  if (totalTax !== undefined) summary.totalTax = totalTax;
  if (total !== undefined) summary.total = total;
  if (amountDue !== undefined) summary.amountDue = amountDue;
  if (amountPaid !== undefined) summary.amountPaid = amountPaid;
  if (amountCredited !== undefined) summary.amountCredited = amountCredited;
  const updatedAt = xeroProviderInstant(invoice.updatedDateUTC) ?? xeroProviderInstant(invoice.updatedDateUTCString);
  if (updatedAt) summary.updatedAt = updatedAt.toISOString();
  else if (invoice.updatedDateUTCString) summary.updatedAt = invoice.updatedDateUTCString;
  return summary;
}

function mapCreditNoteSummary(creditNote: XeroCreditNote): CreditNoteSummary | undefined {
  const type = accountingCreditNoteType(creditNote.type);
  if (!creditNote.creditNoteID || !type || !creditNote.contact?.contactID) return undefined;

  const allAssociatedInvoiceIds = [...new Set(
    (creditNote.allocations ?? [])
      .map((allocation) => allocation.invoice?.invoiceID)
      .filter((invoiceId): invoiceId is string => typeof invoiceId === "string" && invoiceId.length > 0),
  )];
  const associatedInvoiceIds = allAssociatedInvoiceIds.slice(0, MAX_ASSOCIATED_INVOICE_IDS);
  const summary: CreditNoteSummary = {
    creditNoteId: creditNote.creditNoteID,
    type,
    status: String(creditNote.status ?? "UNKNOWN"),
    contact: { contactId: creditNote.contact.contactID },
    attachmentsKnown: creditNote.hasAttachments !== undefined,
    ...(creditNote.hasAttachments !== undefined ? { hasAttachments: creditNote.hasAttachments } : {}),
    associatedInvoiceIds,
    associatedInvoiceIdCount: allAssociatedInvoiceIds.length,
    associatedInvoiceIdsTruncated: associatedInvoiceIds.length < allAssociatedInvoiceIds.length,
  };
  const contactName = boundedProviderText(creditNote.contact.name, 255);
  const creditNoteNumber = boundedProviderText(creditNote.creditNoteNumber, 255);
  const reference = boundedProviderText(creditNote.reference, 512);
  const creditNoteDate = xeroDate(creditNote.date);
  const dueDate = xeroDate(creditNote.dueDate);
  const fullyPaidOnDate = xeroDate(creditNote.fullyPaidOnDate);
  if (contactName) summary.contact.name = contactName;
  if (creditNoteNumber) summary.creditNoteNumber = creditNoteNumber;
  if (creditNoteDate) summary.creditNoteDate = creditNoteDate;
  if (dueDate) summary.dueDate = dueDate;
  if (fullyPaidOnDate) summary.fullyPaidOnDate = fullyPaidOnDate;
  if (creditNote.currencyCode) summary.currency = String(creditNote.currencyCode);
  if (reference) summary.reference = reference;
  const subTotal = decimal(creditNote.subTotal);
  const totalTax = decimal(creditNote.totalTax);
  const total = decimal(creditNote.total);
  const remainingCredit = decimal(creditNote.remainingCredit);
  const appliedAmount = decimal(creditNote.appliedAmount);
  if (subTotal !== undefined) summary.subTotal = subTotal;
  if (totalTax !== undefined) summary.totalTax = totalTax;
  if (total !== undefined) summary.total = total;
  if (remainingCredit !== undefined) summary.remainingCredit = remainingCredit;
  if (appliedAmount !== undefined) summary.appliedAmount = appliedAmount;
  if (creditNote.updatedDateUTC instanceof Date) summary.updatedAt = creditNote.updatedDateUTC.toISOString();
  else if (creditNote.updatedDateUTCString) summary.updatedAt = creditNote.updatedDateUTCString;
  return summary;
}

function mapCreditNoteSnapshot(
  tenantId: string,
  creditNote: XeroCreditNote,
  maxLines?: number,
): CreditNoteSnapshot {
  const summary = mapCreditNoteSummary(creditNote);
  if (!summary) {
    if (!creditNote.creditNoteID || !accountingCreditNoteType(creditNote.type)) {
      throw new AppError("NOT_FOUND", "The requested Xero credit note was not found.", { httpStatus: 404 });
    }
    throw new AppError("READBACK_MISMATCH", "The Xero credit-note readback did not include its contact identifier.", {
      httpStatus: 502,
    });
  }
  const allLines = creditNote.lineItems ?? [];
  const selectedLines = maxLines === undefined ? allLines : allLines.slice(0, maxLines);
  const snapshot: CreditNoteSnapshot = {
    ...summary,
    tenantId,
    lines: selectedLines.map((line) => ({
      ...(line.lineItemID ? { lineItemId: line.lineItemID } : {}),
      description: line.description ?? "",
      quantity: decimal(line.quantity) ?? "0.0000",
      unitAmount: decimal(line.unitAmount) ?? "0.0000",
      ...(decimal(line.lineAmount) ? { lineAmount: decimal(line.lineAmount) as string } : {}),
      ...(decimal(line.taxAmount) ? { taxAmount: decimal(line.taxAmount) as string } : {}),
      ...(line.accountID ? { accountId: line.accountID } : {}),
      accountCode: line.accountCode ?? "",
      taxType: line.taxType ?? "",
    })),
    lineItemCount: allLines.length,
    linesTruncated: selectedLines.length < allLines.length,
  };
  if (creditNote.lineAmountTypes) snapshot.lineAmountType = String(creditNote.lineAmountTypes);
  return snapshot;
}

function mapPaymentSummary(payment: XeroPayment): PaymentSummary | undefined {
  const type = accountingPaymentType(payment.paymentType);
  const amount = decimal(payment.amount);
  if (!payment.paymentID || !type || amount === undefined) return undefined;

  const invoice = payment.invoice && !Array.isArray(payment.invoice) ? payment.invoice : undefined;
  const creditNote = payment.creditNote && !Array.isArray(payment.creditNote) ? payment.creditNote : undefined;
  const prepayment = payment.prepayment && !Array.isArray(payment.prepayment) ? payment.prepayment : undefined;
  const overpayment = payment.overpayment && !Array.isArray(payment.overpayment) ? payment.overpayment : undefined;
  const currencyEvidence = (() => {
    if (["ACCRECPAYMENT", "ACCPAYPAYMENT"].includes(type) && invoice?.currencyCode) {
      return { currency: String(invoice.currencyCode), currencySource: "INVOICE" as const };
    }
    if (["ARCREDITPAYMENT", "APCREDITPAYMENT"].includes(type) && creditNote?.currencyCode) {
      return { currency: String(creditNote.currencyCode), currencySource: "CREDIT_NOTE" as const };
    }
    if (["ARPREPAYMENTPAYMENT", "APPREPAYMENTPAYMENT"].includes(type) && prepayment?.currencyCode) {
      return { currency: String(prepayment.currencyCode), currencySource: "PREPAYMENT" as const };
    }
    if (["AROVERPAYMENTPAYMENT", "APOVERPAYMENTPAYMENT"].includes(type) && overpayment?.currencyCode) {
      return { currency: String(overpayment.currencyCode), currencySource: "OVERPAYMENT" as const };
    }
    return { currencySource: "UNAVAILABLE" as const };
  })();
  const associatedContact = ["ACCRECPAYMENT", "ACCPAYPAYMENT"].includes(type)
    ? invoice?.contact
    : ["ARCREDITPAYMENT", "APCREDITPAYMENT"].includes(type)
      ? creditNote?.contact
      : ["ARPREPAYMENTPAYMENT", "APPREPAYMENTPAYMENT"].includes(type)
        ? prepayment?.contact
        : overpayment?.contact;
  const contact = associatedContact?.contactID
    ? {
      contactId: associatedContact.contactID,
      ...(boundedProviderText(associatedContact.name, 255)
        ? { name: boundedProviderText(associatedContact.name, 255) as string }
        : {}),
    }
    : undefined;
  const accountCode = boundedProviderText(payment.account?.code, 10);
  const accountName = boundedProviderText(payment.account?.name, 150);
  const account = payment.account && !Array.isArray(payment.account)
    ? {
      ...(payment.account.accountID ? { accountId: payment.account.accountID } : {}),
      ...(accountCode ? { code: accountCode } : {}),
      ...(accountName ? { name: accountName } : {}),
    }
    : undefined;
  const paymentDate = xeroDate(payment.date);
  const bankAmount = decimal(payment.bankAmount);
  const reference = boundedProviderText(payment.reference, 512);
  const bankCurrency = payment.account?.currencyCode ? String(payment.account.currencyCode) : undefined;

  return {
    paymentId: payment.paymentID,
    type,
    status: String(payment.status ?? "UNKNOWN"),
    ...(paymentDate ? { paymentDate } : {}),
    amount,
    ...currencyEvidence,
    currencyKnown: currencyEvidence.currency !== undefined,
    ...(bankAmount !== undefined ? { bankAmount } : {}),
    ...(bankCurrency ? { bankCurrency } : {}),
    bankCurrencyKnown: bankCurrency !== undefined,
    ...(reference ? { reference } : {}),
    ...(payment.isReconciled !== undefined ? { isReconciled: payment.isReconciled } : {}),
    ...(contact ? { contact } : {}),
    ...(invoice?.invoiceID ? { invoiceId: invoice.invoiceID } : {}),
    ...(boundedProviderText(payment.invoiceNumber ?? invoice?.invoiceNumber, 255)
      ? { invoiceNumber: boundedProviderText(payment.invoiceNumber ?? invoice?.invoiceNumber, 255) as string }
      : {}),
    ...(creditNote?.creditNoteID ? { creditNoteId: creditNote.creditNoteID } : {}),
    ...(boundedProviderText(payment.creditNoteNumber ?? creditNote?.creditNoteNumber, 255)
      ? { creditNoteNumber: boundedProviderText(payment.creditNoteNumber ?? creditNote?.creditNoteNumber, 255) as string }
      : {}),
    ...(prepayment?.prepaymentID ? { prepaymentId: prepayment.prepaymentID } : {}),
    ...(overpayment?.overpaymentID ? { overpaymentId: overpayment.overpaymentID } : {}),
    ...(payment.batchPaymentID ? { batchPaymentId: payment.batchPaymentID } : {}),
    ...(account && Object.keys(account).length > 0 ? { account } : {}),
    ...(payment.updatedDateUTC instanceof Date
      ? { updatedAt: payment.updatedDateUTC.toISOString() }
      : payment.updatedDateUTCString
        ? { updatedAt: payment.updatedDateUTCString }
        : {}),
  };
}

function mapInvoiceSnapshot(
  tenantId: string,
  invoice: XeroInvoice,
  maxLines?: number,
): InvoiceSnapshot {
  const summary = mapInvoiceSummary(invoice);
  if (!summary) {
    if (!invoice.invoiceID || !accountingInvoiceType(invoice.type)) {
      throw new AppError("NOT_FOUND", "The requested Xero invoice was not found.", { httpStatus: 404 });
    }
    throw new AppError("READBACK_MISMATCH", "The Xero invoice readback did not include its contact identifier.", {
      httpStatus: 502,
    });
  }

  const allLines = invoice.lineItems ?? [];
  const selectedLines = maxLines === undefined ? allLines : allLines.slice(0, maxLines);
  const snapshot: InvoiceSnapshot = {
    ...summary,
    tenantId,
    lines: selectedLines.map((line) => ({
      ...(line.lineItemID ? { lineItemId: line.lineItemID } : {}),
      description: line.description ?? "",
      quantity: decimal(line.quantity) ?? "0.0000",
      unitAmount: decimal(line.unitAmount) ?? "0.0000",
      ...(decimal(line.lineAmount) ? { lineAmount: decimal(line.lineAmount) as string } : {}),
      ...(decimal(line.taxAmount) ? { taxAmount: decimal(line.taxAmount) as string } : {}),
      ...(line.accountID ? { accountId: line.accountID } : {}),
      accountCode: line.accountCode ?? "",
      taxType: line.taxType ?? "",
    })),
    lineItemCount: allLines.length,
    linesTruncated: selectedLines.length < allLines.length,
  };
  if (invoice.lineAmountTypes) snapshot.lineAmountType = String(invoice.lineAmountTypes);
  return snapshot;
}

export class XeroAccountingProvider implements AccountingProvider {
  readonly #repository: AccountingRepository;
  readonly #manager: XeroClientManager;
  readonly #xeroWriteEnabled: boolean;

  constructor(
    repository: AccountingRepository,
    manager: XeroClientManager,
    xeroWriteEnabled = true,
  ) {
    this.#repository = repository;
    this.#manager = manager;
    this.#xeroWriteEnabled = xeroWriteEnabled;
  }

  async connectionStatus(principal: AccountingPrincipal): Promise<ConnectionSummary> {
    if (typeof principal === "string" || principal.legacyDemo) {
      const actorId = typeof principal === "string" ? principal : principal.actorId;
      const connections = await this.#repository.listActiveConnections(actorId);
      if (connections.length === 0) return { connected: false, scopes: [] };
      if (connections.length > 1) {
        throw new AppError("AMBIGUOUS_CONNECTION", "The demo has more than one active Xero organisation.", {
          httpStatus: 409,
        });
      }
      const connection = connections[0] as (typeof connections)[number];
      if (describeLegacyXeroScopePolicyProblems(
        connection.grantedScopes,
        this.#xeroWriteEnabled,
      ).length > 0) {
        return { connected: false, scopes: connection.grantedScopes };
      }
      return {
        connected: true,
        tenant: { id: connection.tenantId, name: connection.tenantName },
        scopes: connection.grantedScopes,
        tokenExpiresAt: connection.tokenExpiresAt.toISOString(),
      };
    }

    try {
      const resolved = await this.#manager.resolveConnection(principal);
      if (resolved.mode !== "OAUTH") {
        throw new AppError("FORBIDDEN", "An OAuth request resolved to a legacy Xero connection.", {
          httpStatus: 403,
        });
      }
      return {
        connected: true,
        tenant: { id: resolved.connection.tenantId, name: resolved.connection.tenantName },
        scopes: resolved.authorization.grantedScopes,
        tokenExpiresAt: resolved.authorization.tokenExpiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_CONNECTED") {
        return { connected: false, scopes: [] };
      }
      throw error;
    }
  }

  async resolveContext(principal: AccountingPrincipal): Promise<ActorTenantContext> {
    const resolved = await this.#manager.resolveConnection(principal);
    return {
      actorId: typeof principal === "string" ? principal : principal.actorId,
      tenantId: resolved.connection.tenantId,
      tenantName: resolved.connection.tenantName,
    };
  }

  async getOrganisation(principal: AccountingPrincipal): Promise<OrganisationSummary> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getOrganisations(connection.tenantId);
      const organisation = response.body.organisations?.find(
        (candidate) => candidate.organisationID === connection.tenantId,
      );
      if (!organisation?.organisationID || !organisation.name) {
        throw new AppError("NOT_FOUND", "The connected Xero organisation could not be read.", { httpStatus: 404 });
      }
      const summary: OrganisationSummary = {
        organisationId: organisation.organisationID,
        name: organisation.name,
      };
      if (organisation.legalName) summary.legalName = organisation.legalName;
      if (organisation.countryCode) summary.countryCode = String(organisation.countryCode);
      if (organisation.baseCurrency) summary.baseCurrency = String(organisation.baseCurrency);
      if (organisation.organisationType) summary.organisationType = String(organisation.organisationType);
      if (organisation.version) summary.version = String(organisation.version);
      if (typeof organisation.paysTax === "boolean") summary.paysTax = organisation.paysTax;
      if (typeof organisation.financialYearEndDay === "number" && Number.isInteger(organisation.financialYearEndDay)) {
        summary.financialYearEndDay = organisation.financialYearEndDay;
      }
      if (typeof organisation.financialYearEndMonth === "number" && Number.isInteger(organisation.financialYearEndMonth)) {
        summary.financialYearEndMonth = organisation.financialYearEndMonth;
      }
      if (organisation.salesTaxBasis) summary.salesTaxBasis = String(organisation.salesTaxBasis);
      if (organisation.salesTaxPeriod) summary.salesTaxPeriod = String(organisation.salesTaxPeriod);
      if (organisation.defaultSalesTax) summary.defaultSalesTax = organisation.defaultSalesTax;
      if (organisation.defaultPurchasesTax) summary.defaultPurchasesTax = organisation.defaultPurchasesTax;
      // Xero hands these back as Date objects, not the calendar strings the rest
      // of the summary carries. Passing them through raw fails schema validation
      // for the whole target, and the lock-date guard downstream compares them as
      // strings — so an unnormalised value silently decides period locks wrong.
      const periodLockDate = xeroDate(organisation.periodLockDate);
      if (periodLockDate) summary.periodLockDate = periodLockDate;
      const endOfYearLockDate = xeroDate(organisation.endOfYearLockDate);
      if (endOfYearLockDate) summary.endOfYearLockDate = endOfYearLockDate;
      if (typeof organisation.isDemoCompany === "boolean") summary.isDemoCompany = organisation.isDemoCompany;
      if (organisation.organisationStatus) summary.organisationStatus = organisation.organisationStatus;
      return summary;
    });
  }

  async listAccounts(principal: AccountingPrincipal): Promise<AccountSummary[]> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getAccounts(
        connection.tenantId,
        undefined,
        'Status=="ACTIVE"',
        "Code ASC",
      );
      return (response.body.accounts ?? []).map((account: XeroAccount) => ({
        ...(account.accountID ? { accountId: account.accountID } : {}),
        ...(account.code ? { code: account.code } : {}),
        ...(account.name ? { name: account.name } : {}),
        ...(account.type ? { type: String(account.type) } : {}),
        ...(account._class ? { class: String(account._class) } : {}),
        ...(account.status ? { status: String(account.status) } : {}),
        ...(account.taxType ? { taxType: account.taxType } : {}),
        ...(account.systemAccount ? { systemAccount: String(account.systemAccount) } : {}),
      }));
    });
  }

  async listTaxRates(principal: AccountingPrincipal): Promise<TaxRateSummary[]> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getTaxRates(connection.tenantId, 'Status=="ACTIVE"', "Name ASC");
      return (response.body.taxRates ?? []).map((tax: XeroTaxRate) => ({
        ...(tax.name ? { name: tax.name } : {}),
        ...(tax.taxType ? { taxType: tax.taxType } : {}),
        ...(tax.status ? { status: String(tax.status) } : {}),
        ...(decimal(tax.displayTaxRate) ? { displayTaxRate: decimal(tax.displayTaxRate) as string } : {}),
        ...(decimal(tax.effectiveRate) ? { effectiveRate: decimal(tax.effectiveRate) as string } : {}),
        ...(tax.canApplyToExpenses !== undefined ? { canApplyToExpenses: tax.canApplyToExpenses } : {}),
        ...(tax.canApplyToAssets !== undefined ? { canApplyToAssets: tax.canApplyToAssets } : {}),
        ...(tax.canApplyToLiabilities !== undefined ? { canApplyToLiabilities: tax.canApplyToLiabilities } : {}),
        ...(tax.canApplyToRevenue !== undefined ? { canApplyToRevenue: tax.canApplyToRevenue } : {}),
        ...(tax.canApplyToEquity !== undefined ? { canApplyToEquity: tax.canApplyToEquity } : {}),
      }));
    });
  }

  async listContacts(
    principal: AccountingPrincipal,
    input: ListContactsInput,
  ): Promise<ContactListResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getContacts(
        connection.tenantId,
        undefined,
        contactWhere(input),
        "Name ASC",
        undefined,
        input.page,
        input.status !== "ACTIVE",
        false,
        undefined,
        input.limit,
      );
      const providerContacts = response.body.contacts ?? [];
      const boundedProviderContacts = providerContacts.slice(0, input.limit);
      const contacts = boundedProviderContacts
        .map((contact: XeroContact) => mapContact(contact))
        .filter((contact): contact is ContactSummary => contact !== undefined);
      const providerPageCount = response.body.pagination?.pageCount;
      const currentPage = response.body.pagination?.page ?? input.page;
      return {
        contacts,
        pagination: {
          page: currentPage,
          pageSize: response.body.pagination?.pageSize ?? input.limit,
          returned: contacts.length,
          ...(providerPageCount !== undefined ? { providerPageCount } : {}),
          ...(response.body.pagination?.itemCount !== undefined
            ? { providerItemCount: response.body.pagination.itemCount }
            : {}),
          hasNextPage: providerPageCount !== undefined
            ? currentPage < providerPageCount
            : providerContacts.length >= input.limit,
          hasNextPageIsEstimated: providerPageCount === undefined,
          omittedInvalid: boundedProviderContacts.length - contacts.length,
          ...(providerContacts.length > boundedProviderContacts.length
            ? { omittedOverflow: providerContacts.length - boundedProviderContacts.length }
            : {}),
        },
      };
    });
  }

  async searchContacts(
    principal: AccountingPrincipal,
    query: string,
    limit: number,
    page = 1,
  ): Promise<ContactSearchResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getContacts(
        connection.tenantId,
        undefined,
        undefined,
        "Name ASC",
        undefined,
        page,
        false,
        true,
        query,
        limit,
      );
      const providerContacts = response.body.contacts ?? [];
      const boundedProviderContacts = providerContacts.slice(0, limit);
      const contacts = boundedProviderContacts
        .map((contact: XeroContact) => mapContact(contact))
        .filter((contact): contact is ContactSummary => contact !== undefined);
      const providerPageCount = response.body.pagination?.pageCount;
      const hasProviderPageCount = providerPageCount !== undefined;
      const currentPage = response.body.pagination?.page ?? page;
      return {
        contacts,
        pagination: {
          page: currentPage,
          pageSize: response.body.pagination?.pageSize ?? limit,
          returned: contacts.length,
          ...(providerPageCount !== undefined ? { providerPageCount } : {}),
          ...(response.body.pagination?.itemCount !== undefined
            ? { providerItemCount: response.body.pagination.itemCount }
            : {}),
          hasNextPage: hasProviderPageCount
            ? currentPage < providerPageCount
            : providerContacts.length >= limit,
          hasNextPageIsEstimated: !hasProviderPageCount,
          omittedInvalid: boundedProviderContacts.length - contacts.length,
          ...(providerContacts.length > boundedProviderContacts.length
            ? { omittedOverflow: providerContacts.length - boundedProviderContacts.length }
            : {}),
        },
      };
    });
  }

  async getSupplierBillDraftReferenceData(
    principal: AccountingPrincipal,
    supplierQuery?: string,
  ): Promise<SupplierBillDraftReferenceData> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const [accountsResponse, taxRatesResponse, contactsResponse] = await Promise.all([
        client.accountingApi.getAccounts(
          connection.tenantId,
          undefined,
          'Status=="ACTIVE"',
          "Code ASC",
        ),
        client.accountingApi.getTaxRates(connection.tenantId, 'Status=="ACTIVE"', "Name ASC"),
        supplierQuery
          ? client.accountingApi.getContacts(
            connection.tenantId,
            undefined,
            undefined,
            "Name ASC",
            undefined,
            1,
            false,
            true,
            supplierQuery,
            100,
          )
          : Promise.resolve({ body: { contacts: [] } }),
      ]);
      const contactsBody = contactsResponse.body as {
        contacts?: XeroContact[];
        pagination?: { pageCount?: number };
      };

      return {
        tenant: { id: connection.tenantId, name: connection.tenantName },
        contacts: (contactsBody.contacts ?? [])
          .map((contact: XeroContact) => mapContact(contact))
          .filter((contact): contact is ContactSummary => contact !== undefined)
          .slice(0, 100),
        contactsComplete: supplierQuery === undefined ||
          (contactsBody.pagination?.pageCount !== undefined
            ? contactsBody.pagination.pageCount <= 1
            : (contactsBody.contacts ?? []).length < 100),
        accounts: (accountsResponse.body.accounts ?? []).map((account: XeroAccount) => ({
          ...(account.accountID ? { accountId: account.accountID } : {}),
          ...(account.code ? { code: account.code } : {}),
          ...(account.name ? { name: account.name } : {}),
          ...(account.type ? { type: String(account.type) } : {}),
          ...(account._class ? { class: String(account._class) } : {}),
          ...(account.status ? { status: String(account.status) } : {}),
          ...(account.taxType ? { taxType: account.taxType } : {}),
          ...(account.systemAccount ? { systemAccount: String(account.systemAccount) } : {}),
        })),
        taxRates: (taxRatesResponse.body.taxRates ?? []).map((tax: XeroTaxRate) => ({
          ...(tax.name ? { name: tax.name } : {}),
          ...(tax.taxType ? { taxType: tax.taxType } : {}),
          ...(tax.status ? { status: String(tax.status) } : {}),
          ...(decimal(tax.displayTaxRate) ? { displayTaxRate: decimal(tax.displayTaxRate) as string } : {}),
          ...(decimal(tax.effectiveRate) ? { effectiveRate: decimal(tax.effectiveRate) as string } : {}),
          ...(tax.canApplyToExpenses !== undefined ? { canApplyToExpenses: tax.canApplyToExpenses } : {}),
          ...(tax.canApplyToAssets !== undefined ? { canApplyToAssets: tax.canApplyToAssets } : {}),
          ...(tax.canApplyToLiabilities !== undefined ? { canApplyToLiabilities: tax.canApplyToLiabilities } : {}),
          ...(tax.canApplyToRevenue !== undefined ? { canApplyToRevenue: tax.canApplyToRevenue } : {}),
          ...(tax.canApplyToEquity !== undefined ? { canApplyToEquity: tax.canApplyToEquity } : {}),
        })),
      };
    });
  }

  async getContact(principal: AccountingPrincipal, contactId: string): Promise<ContactSummary | undefined> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getContacts(
        connection.tenantId,
        undefined,
        undefined,
        undefined,
        [contactId],
        1,
        true,
        false,
        undefined,
        1,
      );
      const normalizedContactId = contactId.toLowerCase();
      const contact = response.body.contacts?.find(
        (candidate) => candidate.contactID?.toLowerCase() === normalizedContactId,
      );
      return contact ? mapContact(contact) : undefined;
    });
  }

  async listInvoices(principal: AccountingPrincipal, input: ListInvoicesInput): Promise<InvoiceListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const response = await client.accountingApi.getInvoices(
          connection.tenantId,
          undefined,
          invoiceWhere(input),
          INVOICE_ORDER[input.order],
          undefined,
          undefined,
          input.contact_id ? [input.contact_id] : undefined,
          input.statuses,
          input.page,
          input.include_archived,
          undefined,
          4,
          // summaryOnly must be false (or omitted): empirically, Xero's
          // Invoices endpoint drops response.body.pagination entirely
          // (no pageCount/itemCount at all, not even estimated) whenever
          // summaryOnly=true, regardless of page/pageSize/includeArchived.
          // With it false the same query returns exact pageCount/itemCount,
          // which the provider-business-coordinate history walk requires to
          // ever leave PROVIDER_PAGINATION_ESTIMATED /
          // PROVIDER_ITEM_COUNT_MISSING_OR_INVALID. mapInvoiceSummary already
          // handles both shapes (see its hasAttachments branch below).
          false,
          input.page_size,
          input.search_term,
        );
        const providerInvoices = response.body.invoices ?? [];
        const boundedProviderInvoices = providerInvoices.slice(0, input.page_size);
        const invoices = boundedProviderInvoices
          .map((invoice: XeroInvoice) => mapInvoiceSummary(invoice))
          .filter((invoice): invoice is InvoiceSummary => invoice !== undefined);
        const providerPageCount = response.body.pagination?.pageCount;
        const hasProviderPageCount = providerPageCount !== undefined;
        const currentPage = response.body.pagination?.page ?? input.page;

        return {
          invoices,
          pagination: {
            page: currentPage,
            pageSize: response.body.pagination?.pageSize ?? input.page_size,
            returned: invoices.length,
            ...(providerPageCount !== undefined ? { providerPageCount } : {}),
            ...(response.body.pagination?.itemCount !== undefined
              ? { providerItemCount: response.body.pagination.itemCount }
              : {}),
            hasNextPage: hasProviderPageCount
              ? currentPage < providerPageCount
              : providerInvoices.length >= input.page_size,
            hasNextPageIsEstimated: !hasProviderPageCount,
            omittedInvalid: boundedProviderInvoices.length - invoices.length,
            ...(providerInvoices.length > boundedProviderInvoices.length
              ? { omittedOverflow: providerInvoices.length - boundedProviderInvoices.length }
              : {}),
          },
        };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this history query as too broad. Narrow the date range, contact, type, or statuses and retry with Date or UpdatedAt ordering.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async listCreditNotes(
    principal: AccountingPrincipal,
    input: ListCreditNotesInput,
  ): Promise<CreditNoteListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const response = await client.accountingApi.getCreditNotes(
          connection.tenantId,
          undefined,
          creditNoteWhere(input),
          "Date DESC",
          input.page,
          4,
          input.page_size,
        );
        const providerCreditNotes = response.body.creditNotes ?? [];
        const boundedProviderCreditNotes = providerCreditNotes.slice(0, input.page_size);
        const creditNotes = boundedProviderCreditNotes
          .map((creditNote: XeroCreditNote) => mapCreditNoteSummary(creditNote))
          .filter((creditNote): creditNote is CreditNoteSummary => creditNote !== undefined);
        const providerPageCount = response.body.pagination?.pageCount;
        const currentPage = response.body.pagination?.page ?? input.page;

        return {
          creditNotes,
          pagination: {
            page: currentPage,
            pageSize: response.body.pagination?.pageSize ?? input.page_size,
            returned: creditNotes.length,
            ...(providerPageCount !== undefined ? { providerPageCount } : {}),
            ...(response.body.pagination?.itemCount !== undefined
              ? { providerItemCount: response.body.pagination.itemCount }
              : {}),
            hasNextPage: providerPageCount !== undefined
              ? currentPage < providerPageCount
              : providerCreditNotes.length >= input.page_size,
            hasNextPageIsEstimated: providerPageCount === undefined,
            omittedInvalid: boundedProviderCreditNotes.length - creditNotes.length,
            ...(providerCreditNotes.length > boundedProviderCreditNotes.length
              ? { omittedOverflow: providerCreditNotes.length - boundedProviderCreditNotes.length }
              : {}),
          },
        };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this credit-note history query as too broad. Narrow the date range, contact, status, or type and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async listPayments(principal: AccountingPrincipal, input: ListPaymentsInput): Promise<PaymentListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const response = await client.accountingApi.getPayments(
          connection.tenantId,
          undefined,
          paymentWhere(input),
          "Date DESC",
          input.page,
          input.page_size,
        );
        const providerPayments = response.body.payments ?? [];
        const boundedProviderPayments = providerPayments.slice(0, input.page_size);
        const payments = boundedProviderPayments
          .map((payment: XeroPayment) => mapPaymentSummary(payment))
          .filter((payment): payment is PaymentSummary => payment !== undefined);
        const providerPageCount = response.body.pagination?.pageCount;
        const currentPage = response.body.pagination?.page ?? input.page;

        return {
          payments,
          pagination: {
            page: currentPage,
            pageSize: response.body.pagination?.pageSize ?? input.page_size,
            returned: payments.length,
            ...(providerPageCount !== undefined ? { providerPageCount } : {}),
            ...(response.body.pagination?.itemCount !== undefined
              ? { providerItemCount: response.body.pagination.itemCount }
              : {}),
            hasNextPage: providerPageCount !== undefined
              ? currentPage < providerPageCount
              : providerPayments.length >= input.page_size,
            hasNextPageIsEstimated: providerPageCount === undefined,
            omittedInvalid: boundedProviderPayments.length - payments.length,
            ...(providerPayments.length > boundedProviderPayments.length
              ? { omittedOverflow: providerPayments.length - boundedProviderPayments.length }
              : {}),
          },
        };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this payment history query as too broad. Narrow the date range, contact, status, or type and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async listQuotes(principal: AccountingPrincipal, input: ListQuotesInput): Promise<QuoteListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const query = buildQuoteReadQuery(input);
        const getProviderPage = (page: number) => client.accountingApi.getQuotes(
          connection.tenantId,
          undefined,
          query.dateFrom,
          query.dateTo,
          query.expiryDateFrom,
          query.expiryDateTo,
          query.contactID,
          query.status,
          page,
          query.order,
          query.quoteNumber,
        );
        const firstResponse = await getProviderPage(query.providerPage);
        const firstPage = firstResponse.body.quotes ?? [];
        const needsSecondPage = query.fetchNextProviderPage &&
          firstPage.length >= XERO_QUOTE_PROVIDER_PAGE_CAPACITY;
        const secondPage = needsSecondPage
          ? (await getProviderPage(query.providerPage + 1)).body.quotes ?? []
          : [];
        const logicalSource = [...firstPage, ...secondPage].slice(query.inPageOffset);
        const mapped = mapBoundedExtendedReadPage(
          logicalSource,
          input,
          mapQuoteSummary,
          undefined,
          { providerPageCapacity: input.page_size },
        );
        return { quotes: mapped.records, pagination: mapped.pagination };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this quote query as too broad. Narrow the date range, contact, status, or quote number and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async getQuote(principal: AccountingPrincipal, quoteId: string): Promise<QuoteSnapshot> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getQuote(connection.tenantId, quoteId);
      const quote = response.body.quotes?.find((candidate) => candidate.quoteID === quoteId);
      const snapshot = mapQuoteSnapshot(quote);
      if (!snapshot || snapshot.quoteId !== quoteId) {
        throw new AppError("NOT_FOUND", "The requested Xero quote was not found.", { httpStatus: 404 });
      }
      return snapshot;
    });
  }

  async listPurchaseOrders(
    principal: AccountingPrincipal,
    input: ListPurchaseOrdersInput,
  ): Promise<PurchaseOrderListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const query = buildPurchaseOrderReadQuery(input);
        const response = await client.accountingApi.getPurchaseOrders(
          connection.tenantId,
          undefined,
          query.status,
          query.dateFrom,
          query.dateTo,
          query.order,
          query.page,
          query.pageSize,
        );
        const mapped = mapBoundedExtendedReadPage(
          response.body.purchaseOrders,
          input,
          mapPurchaseOrderSummary,
          response.body.pagination,
        );
        return { purchaseOrders: mapped.records, pagination: mapped.pagination };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this purchase-order query as too broad. Narrow the date range or status and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async getPurchaseOrder(
    principal: AccountingPrincipal,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderSnapshot> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getPurchaseOrder(connection.tenantId, purchaseOrderId);
      const purchaseOrder = response.body.purchaseOrders?.find(
        (candidate) => candidate.purchaseOrderID === purchaseOrderId,
      );
      const snapshot = mapPurchaseOrderSnapshot(purchaseOrder);
      if (!snapshot || snapshot.purchaseOrderId !== purchaseOrderId) {
        throw new AppError("NOT_FOUND", "The requested Xero purchase order was not found.", { httpStatus: 404 });
      }
      return snapshot;
    });
  }

  async listManualJournals(
    principal: AccountingPrincipal,
    input: ListManualJournalsInput,
  ): Promise<ManualJournalListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const query = buildManualJournalReadQuery(input);
        const response = await client.accountingApi.getManualJournals(
          connection.tenantId,
          undefined,
          query.where,
          query.order,
          query.page,
          query.pageSize,
        );
        const mapped = mapBoundedExtendedReadPage(
          response.body.manualJournals,
          input,
          mapManualJournalSummary,
          response.body.pagination,
        );
        return { manualJournals: mapped.records, pagination: mapped.pagination };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this manual-journal query as too broad. Narrow the date range, status, or narration and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async getManualJournal(
    principal: AccountingPrincipal,
    manualJournalId: string,
  ): Promise<ManualJournalSnapshot> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getManualJournal(connection.tenantId, manualJournalId);
      const journal = response.body.manualJournals?.find(
        (candidate) => candidate.manualJournalID === manualJournalId,
      );
      const snapshot = mapManualJournalSnapshot(journal);
      if (!snapshot || snapshot.manualJournalId !== manualJournalId) {
        throw new AppError("NOT_FOUND", "The requested Xero manual journal was not found.", { httpStatus: 404 });
      }
      return snapshot;
    });
  }

  async listItems(principal: AccountingPrincipal, input: ListItemsInput): Promise<ItemListResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const query = buildItemReadQuery(input);
      const response = await client.accountingApi.getItems(
        connection.tenantId,
        undefined,
        query.where,
        query.order,
        4,
      );
      const providerItems = response.body.items ?? [];
      const localOffset = (query.localPage - 1) * query.localPageSize;
      const logicalSource = providerItems.slice(localOffset, localOffset + query.localPageSize + 1);
      const mapped = mapBoundedExtendedReadPage(
        logicalSource,
        input,
        mapItemSummary,
        undefined,
        { providerPageCapacity: input.page_size },
      );
      return { items: mapped.records, pagination: mapped.pagination };
    });
  }

  async getItem(principal: AccountingPrincipal, itemId: string): Promise<ItemSummary> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getItem(connection.tenantId, itemId, 4);
      const item = response.body.items?.find((candidate) => candidate.itemID === itemId);
      const summary = mapItemSummary(item);
      if (!summary || summary.itemId !== itemId) {
        throw new AppError("NOT_FOUND", "The requested Xero item was not found.", { httpStatus: 404 });
      }
      return summary;
    });
  }

  async listBankTransactions(
    principal: AccountingPrincipal,
    input: ListBankTransactionsInput,
  ): Promise<BankTransactionListResult> {
    try {
      return await this.#manager.withClient(principal, async (client, connection) => {
        const query = buildBankTransactionReadQuery(input);
        const response = await client.accountingApi.getBankTransactions(
          connection.tenantId,
          undefined,
          query.where,
          query.order,
          query.page,
          query.unitdp,
          query.pageSize,
        );
        const mapped = mapBoundedExtendedReadPage(
          response.body.bankTransactions,
          input,
          mapBankTransactionSummary,
          response.body.pagination,
        );
        return { bankTransactions: mapped.records, pagination: mapped.pagination };
      });
    } catch (error) {
      if (isHighVolumeQueryError(error)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Xero rejected this bank-transaction query as too broad. Narrow the date range, bank account, type, or reconciliation state and retry.",
          { httpStatus: 422, retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  async getBankTransaction(
    principal: AccountingPrincipal,
    bankTransactionId: string,
  ): Promise<BankTransactionSnapshot> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getBankTransaction(
        connection.tenantId,
        bankTransactionId,
        4,
      );
      const transaction = response.body.bankTransactions?.find(
        (candidate) => candidate.bankTransactionID === bankTransactionId,
      );
      const snapshot = mapBankTransactionSnapshot(transaction);
      if (!snapshot || snapshot.bankTransactionId !== bankTransactionId) {
        throw new AppError("NOT_FOUND", "The requested Xero bank transaction was not found.", { httpStatus: 404 });
      }
      return snapshot;
    });
  }

  async getInvoice(principal: AccountingPrincipal, invoiceId: string, expectedType?: InvoiceType): Promise<InvoiceSnapshot> {
    return this.#manager.withClient(principal, (client, connection) =>
      this.#getInvoice(client, connection.tenantId, invoiceId, expectedType, MAX_AGENT_INVOICE_LINES),
    );
  }

  async getCreditNote(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedType?: CreditNoteType,
  ): Promise<CreditNoteSnapshot> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getCreditNote(connection.tenantId, creditNoteId, 4);
      const creditNote = response.body.creditNotes?.find((candidate) =>
        candidate.creditNoteID?.toLowerCase() === creditNoteId.toLowerCase());
      const type = accountingCreditNoteType(creditNote?.type);
      if (!creditNote || !type || (expectedType !== undefined && type !== expectedType)) {
        throw new AppError("NOT_FOUND", "The requested Xero credit note was not found.", { httpStatus: 404 });
      }
      return mapCreditNoteSnapshot(connection.tenantId, creditNote, MAX_AGENT_INVOICE_LINES);
    });
  }

  async getSupplierBill(principal: AccountingPrincipal, invoiceId: string): Promise<SupplierBillSnapshot> {
    return this.#manager.withClient(principal, (client, connection) =>
      this.#getSupplierBill(client, connection.tenantId, invoiceId),
    );
  }

  /**
   * Replaces an existing ACCPAY DRAFT in one bounded provider action.
   *
   * The exact GET is intentionally inside withWriteClient and immediately
   * precedes updateInvoice. The body always carries the complete canonical
   * contact, dates, currency, reference and line set; no patch or create
   * fallback is possible on this route.
   */
  async updateDraftSupplierBill(
    principal: AccountingPrincipal,
    targetXeroObjectId: string,
    expectedUpdatedAt: string,
    input: InvoiceDraftUpdateCanonicalPayload,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderWriteResult> {
    return this.#updateDraftInvoice(
      principal,
      targetXeroObjectId,
      expectedUpdatedAt,
      input,
      idempotencyKey,
      "ACCPAY",
      recordWriteEvidence,
      providerWritePermit,
      mutationRequestId,
    ) as Promise<ProviderWriteResult>;
  }

  /**
   * Replaces an existing ACCREC DRAFT in one bounded provider action.
   * ACCREC is selected by this method, never by an input type flag.
   */
  async updateDraftSalesInvoice(
    principal: AccountingPrincipal,
    targetXeroObjectId: string,
    expectedUpdatedAt: string,
    input: InvoiceDraftUpdateCanonicalPayload,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderSalesInvoiceWriteResult> {
    return this.#updateDraftInvoice(
      principal,
      targetXeroObjectId,
      expectedUpdatedAt,
      input,
      idempotencyKey,
      "ACCREC",
      recordWriteEvidence,
      providerWritePermit,
      mutationRequestId,
    ) as Promise<ProviderSalesInvoiceWriteResult>;
  }

  async #updateDraftInvoice(
    principal: AccountingPrincipal,
    targetXeroObjectId: string,
    expectedUpdatedAt: string,
    input: InvoiceDraftUpdateCanonicalPayload,
    idempotencyKey: string,
    expectedType: "ACCPAY" | "ACCREC",
    recordWriteEvidence: RecordProviderDraftWriteEvidence | undefined,
    providerWritePermit: LedgerProviderWritePermit | undefined,
    mutationRequestId: string | undefined,
  ): Promise<ProviderWriteResult | ProviderSalesInvoiceWriteResult> {
    const expectedUpdatedAtEpoch = expectedUpdatedAtInstant(expectedUpdatedAt);
    if (expectedUpdatedAtEpoch === undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The invoice DRAFT update expectedUpdatedAt must be an ISO datetime.",
        {
          httpStatus: 422,
          retryable: false,
          details: { providerMutationPossible: false, path: "expectedUpdatedAt" },
        },
      );
    }
    const normalized = normalizeInvoiceDraftUpdate(targetXeroObjectId, input, expectedType);
    assertDraftWriteEvidenceRecorder(recordWriteEvidence);
    const providerIdempotencyKey = mutationRequestId ?? idempotencyKey;
    const providerType = expectedType === "ACCPAY" ? Invoice.TypeEnum.ACCPAY : Invoice.TypeEnum.ACCREC;
    const invoicePayload = {
      invoiceID: normalized.targetXeroObjectId,
      type: providerType,
      status: Invoice.StatusEnum.DRAFT,
      contact: { contactID: normalized.contactId },
      date: normalized.invoiceDate,
      dueDate: normalized.dueDate,
      currencyCode: normalized.currency,
      ...(normalized.currencyRate !== undefined ? { currencyRate: normalized.currencyRate } : {}),
      ...(expectedType === "ACCPAY" || normalized.authoritativeProviderField === "INVOICE_NUMBER"
        ? { invoiceNumber: normalized.reference }
        : { reference: normalized.reference }),
      lineAmountTypes: normalized.lineAmountType,
      // This is the complete replacement set. Deliberately omit lineItemID:
      // caller-provided line IDs would turn the action into a patch.
      lineItems: normalized.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        ...(line.accountId ? { accountID: line.accountId } : {}),
        accountCode: line.accountCode,
        taxType: line.taxType,
      })),
    };

    return this.#manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: expectedType === "ACCPAY"
        ? "XeroAccountingProvider.updateDraftSupplierBill"
        : "XeroAccountingProvider.updateDraftSalesInvoice",
      actionId: expectedType === "ACCPAY" ? "supplier_bill.update_draft" : "customer_invoice.update_draft",
      mutationRequestId: providerIdempotencyKey,
      providerIdempotencyKey,
      canonicalPayload: {
        targetXeroObjectId: normalized.targetXeroObjectId,
        expectedUpdatedAt,
        replacement: normalized.replacementPayload,
      },
    }, async (client, connection) => {
      let updateReceipt: Record<string, unknown> | undefined;
      let mutationStarted = false;
      try {
        // Preflight and post-write reads deliberately use this same exact
        // provider projection. The type is fixed by the action route.
        let before: InvoiceSnapshot;
        try {
          before = await this.#getInvoice(
            client,
            connection.tenantId,
            normalized.targetXeroObjectId,
            expectedType,
            MAX_AGENT_INVOICE_LINES,
          );
        } catch (error) {
          if (error instanceof AppError && error.code === "NOT_FOUND") {
            throw invoiceDraftProviderRejected(
              "Xero did not return the exact invoice DRAFT update target.",
              {
                objectId: normalized.targetXeroObjectId,
                reasonCodes: ["EXACT_TARGET_NOT_FOUND"],
                providerMutationPossible: false,
              },
            );
          }
          throw error;
        }
        if (before.status !== "DRAFT") {
          throw new AppError("CONFLICT", "The existing Xero invoice is no longer in DRAFT state.", {
            httpStatus: 409,
            details: {
              objectId: normalized.targetXeroObjectId,
              expectedStatus: Invoice.StatusEnum.DRAFT,
              actualStatus: before.status,
              reasonCodes: ["TARGET_NOT_DRAFT"],
              writeOutcome: "DEFINITELY_REJECTED",
              providerMutationPossible: false,
            },
          });
        }
        const actualUpdatedAtEpoch = expectedUpdatedAtInstant(before.updatedAt);
        if (actualUpdatedAtEpoch === undefined) {
          throw expectedUpdatedAtConflict(
            "The exact Xero invoice has no readable updated timestamp.",
            "UPDATED_AT_UNAVAILABLE",
            expectedUpdatedAt,
            before.updatedAt,
          );
        }
        if (actualUpdatedAtEpoch !== expectedUpdatedAtEpoch) {
          throw expectedUpdatedAtConflict(
            "The existing Xero invoice changed after the expected DRAFT version.",
            "STALE_UPDATED_AT",
            expectedUpdatedAt,
            before.updatedAt,
          );
        }

        mutationStarted = true;
        const updated = await client.accountingApi.updateInvoice(
          connection.tenantId,
          normalized.targetXeroObjectId,
          { invoices: [invoicePayload] },
          4,
          providerIdempotencyKey,
        );
        const returned = updated.body?.invoices?.[0];
        if (returned?.hasErrors || (returned?.validationErrors?.length ?? 0) > 0) {
          throw invoiceDraftProviderRejected("Xero rejected the invoice DRAFT replacement.", {
            validationErrorCount: returned?.validationErrors?.length ?? 0,
          });
        }
        if (!returned?.invoiceID) {
          throw invoiceDraftWriteUnknown("Xero returned no InvoiceID for the invoice DRAFT replacement; recovery is required.");
        }
        if (returned.invoiceID.toLowerCase() !== normalized.targetXeroObjectId.toLowerCase()) {
          throw invoiceDraftWriteUnknown("Xero returned a different InvoiceID after the invoice DRAFT replacement.");
        }
        if (returned.type !== undefined && returned.type !== providerType) {
          throw invoiceDraftWriteUnknown("Xero returned the wrong invoice type after the invoice DRAFT replacement.");
        }
        if (returned.status !== undefined && returned.status !== Invoice.StatusEnum.DRAFT) {
          throw invoiceDraftWriteUnknown("Xero returned a non-DRAFT status after the invoice DRAFT replacement.");
        }
        updateReceipt = {
          operation: expectedType === "ACCPAY" ? "UPDATE_ACCPAY_DRAFT" : "UPDATE_ACCREC_DRAFT",
          invoiceId: normalized.targetXeroObjectId,
          ...(updated.response && providerRequestId(updated.response)
            ? { providerRequestId: providerRequestId(updated.response) }
            : {}),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (!mutationStarted) {
          if (classifyXeroWriteException(error) === "UNKNOWN") {
            throw invoiceDraftPreflightUnavailable(error);
          }
          throw invoiceDraftProviderRejected("Xero rejected the exact invoice DRAFT update target preflight.", {
            objectId: normalized.targetXeroObjectId,
            reasonCodes: ["EXACT_TARGET_PREFLIGHT_REJECTED"],
            providerMutationPossible: false,
          });
        }
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw invoiceDraftWriteUnknown("The invoice DRAFT replacement result is unknown and requires recovery.", error);
        }
        throw invoiceDraftProviderRejected("Xero rejected the invoice DRAFT replacement.");
      }

      try {
        await recordWriteEvidence({
          invoiceId: normalized.targetXeroObjectId,
          receipt: updateReceipt!,
        });
      } catch (error) {
        throw invoiceDraftWriteUnknown(
          "Xero returned an InvoiceID but its write receipt could not be persisted before readback.",
          error,
          { invoiceId: normalized.targetXeroObjectId },
        );
      }

      let readback: InvoiceSnapshot;
      try {
        readback = await this.#getInvoice(
          client,
          connection.tenantId,
          normalized.targetXeroObjectId,
          expectedType,
          MAX_AGENT_INVOICE_LINES,
        );
      } catch (error) {
        throw invoiceDraftWriteUnknown(
          "The invoice DRAFT replacement could not be exactly read back.",
          error,
          { invoiceId: normalized.targetXeroObjectId },
        );
      }
      const mismatches = invoiceDraftReadbackMismatches(normalized, readback, expectedType);
      if (mismatches.length > 0) {
        throw invoiceDraftWriteUnknown(
          "The invoice DRAFT replacement readback did not match the complete canonical payload.",
          undefined,
          {
            invoiceId: normalized.targetXeroObjectId,
            reasonCodes: ["READBACK_MISMATCH"],
            mismatchFields: mismatches,
          },
        );
      }
      const receipt = { ...updateReceipt!, status: readback.status };
      return expectedType === "ACCPAY"
        ? { bill: readback as SupplierBillSnapshot, receipt }
        : { invoice: readback as SalesInvoiceSnapshot, receipt };
    });
  }

  async createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderWriteResult> {
    assertDraftWriteEvidenceRecorder(recordWriteEvidence);
    if (input.authoritative_provider_field !== "INVOICE_NUMBER") {
      throw new AppError("VALIDATION_FAILED", "Supplier bills must use Xero InvoiceNumber as their authoritative coordinate.", {
        httpStatus: 422,
        details: { reasonCodes: ["AUTHORITATIVE_PROVIDER_FIELD_ROUTE_MISMATCH"] },
      });
    }
    const currency = CurrencyCode[input.currency as keyof typeof CurrencyCode];
    if (!currency) {
      throw new AppError("VALIDATION_FAILED", "The requested currency is not supported by the Xero SDK.", {
        httpStatus: 422,
      });
    }
    const lineAmountTypes = LineAmountTypes[input.line_amount_type];
    const providerIdempotencyKey = mutationRequestId ?? idempotencyKey;
    const payload = {
      invoices: [
        {
          type: Invoice.TypeEnum.ACCPAY,
          status: Invoice.StatusEnum.DRAFT,
          contact: { contactID: input.contact_id },
          date: input.invoice_date,
          dueDate: input.due_date,
          currencyCode: currency,
          ...(input.currency_rate !== undefined ? { currencyRate: input.currency_rate } : {}),
          invoiceNumber: input.reference,
          lineAmountTypes,
          lineItems: input.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unitAmount: line.unit_amount,
            ...(line.account_id ? { accountID: line.account_id } : {}),
            accountCode: line.account_code,
            taxType: line.tax_type,
          })),
        },
      ],
    };

    return this.#manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroAccountingProvider.createDraftSupplierBill",
      actionId: "supplier_bill.create_draft",
      mutationRequestId: providerIdempotencyKey,
      providerIdempotencyKey,
      canonicalPayload: persistedInvoiceCanonicalPayload(input),
    }, async (client, connection) => {

      let createdInvoiceId: string | undefined;
      let createReceipt: Record<string, unknown> | undefined;
      try {
        const created = await client.accountingApi.createInvoices(
          connection.tenantId,
          payload,
          true,
          4,
          providerIdempotencyKey,
        );
        const invoice = created.body?.invoices?.[0];
        if (invoice?.hasErrors || (invoice?.validationErrors?.length ?? 0) > 0) {
          throw new AppError("PROVIDER_ERROR", "Xero did not return a valid draft supplier bill.", {
            httpStatus: 422,
            details: { writeOutcome: "DEFINITELY_REJECTED" },
          });
        }
        if (!invoice?.invoiceID) {
          throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned no InvoiceID for the draft supplier bill; recovery is required.", {
            httpStatus: 502,
            retryable: false,
          });
        }
        createdInvoiceId = invoice.invoiceID;
        createReceipt = {
          operation: xeroProviderWritePermitMode(providerWritePermit) === "NATIVE_IDEMPOTENCY_RECOVERY"
            ? "NATIVE_IDEMPOTENCY_RECOVERY"
            : "CREATE_DRAFT",
          invoiceId: invoice.invoiceID,
          ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero draft write result is unknown and requires recovery.", {
            httpStatus: 502,
            retryable: false,
            cause: error,
          });
        }
        throw new AppError("PROVIDER_ERROR", "Xero rejected the draft supplier bill.", {
          httpStatus: 422,
          cause: error,
          details: { writeOutcome: "DEFINITELY_REJECTED" },
        });
      }

      try {
        await recordWriteEvidence?.({ invoiceId: createdInvoiceId, receipt: createReceipt });
      } catch (error) {
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "Xero returned a draft InvoiceID but its write receipt could not be persisted before readback.",
          {
            httpStatus: 503,
            retryable: false,
            cause: error,
            details: { invoiceId: createdInvoiceId },
          },
        );
      }

      try {
        const readback = await this.#getSupplierBill(client, connection.tenantId, createdInvoiceId);
        return {
          bill: readback,
          receipt: {
            ...createReceipt,
            status: readback.status,
          },
        };
      } catch (error) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero created a draft but its exact readback was not verified.", {
          httpStatus: 502,
          retryable: false,
          details: { invoiceId: createdInvoiceId },
          cause: error,
        });
      }
    });
  }

  async createDraftSalesInvoice(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderSalesInvoiceWriteResult> {
    assertDraftWriteEvidenceRecorder(recordWriteEvidence);
    const currency = CurrencyCode[input.currency as keyof typeof CurrencyCode];
    if (!currency) {
      throw new AppError("VALIDATION_FAILED", "The requested currency is not supported by the Xero SDK.", {
        httpStatus: 422,
      });
    }
    const lineAmountTypes = LineAmountTypes[input.line_amount_type];
    const providerIdempotencyKey = mutationRequestId ?? idempotencyKey;
    const payload = {
      invoices: [{
        type: Invoice.TypeEnum.ACCREC,
        status: Invoice.StatusEnum.DRAFT,
        contact: { contactID: input.contact_id },
        date: input.invoice_date,
        dueDate: input.due_date,
        currencyCode: currency,
        ...(input.currency_rate !== undefined ? { currencyRate: input.currency_rate } : {}),
        ...(input.authoritative_provider_field === "INVOICE_NUMBER"
          ? { invoiceNumber: input.reference }
          : { reference: input.reference }),
        lineAmountTypes,
        lineItems: input.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unit_amount,
          ...(line.account_id ? { accountID: line.account_id } : {}),
          accountCode: line.account_code,
          taxType: line.tax_type,
        })),
      }],
    };

    return this.#manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
      actionId: "customer_invoice.create_draft",
      mutationRequestId: providerIdempotencyKey,
      providerIdempotencyKey,
      canonicalPayload: persistedInvoiceCanonicalPayload(input),
    }, async (client, connection) => {

      let createdInvoiceId: string | undefined;
      let createReceipt: Record<string, unknown> | undefined;
      try {
        const created = await client.accountingApi.createInvoices(
          connection.tenantId,
          payload,
          true,
          4,
          providerIdempotencyKey,
        );
        const invoice = created.body?.invoices?.[0];
        if (invoice?.hasErrors || (invoice?.validationErrors?.length ?? 0) > 0) {
          throw new AppError("PROVIDER_ERROR", "Xero did not return a valid draft sales invoice.", {
            httpStatus: 422,
            details: { writeOutcome: "DEFINITELY_REJECTED" },
          });
        }
        if (!invoice?.invoiceID) {
          throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned no InvoiceID for the draft sales invoice; recovery is required.", {
            httpStatus: 502,
            retryable: false,
          });
        }
        createdInvoiceId = invoice.invoiceID;
        createReceipt = {
          operation: xeroProviderWritePermitMode(providerWritePermit) === "NATIVE_IDEMPOTENCY_RECOVERY"
            ? "NATIVE_IDEMPOTENCY_RECOVERY"
            : "CREATE_ACCREC_DRAFT",
          invoiceId: invoice.invoiceID,
          ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero sales-invoice draft result is unknown and requires recovery.", {
            httpStatus: 502,
            retryable: false,
            cause: error,
          });
        }
        throw new AppError("PROVIDER_ERROR", "Xero rejected the draft sales invoice.", {
          httpStatus: 422,
          cause: error,
          details: { writeOutcome: "DEFINITELY_REJECTED" },
        });
      }

      try {
        await recordWriteEvidence?.({ invoiceId: createdInvoiceId, receipt: createReceipt });
      } catch (error) {
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "Xero returned a sales-invoice ID but its write receipt could not be persisted before readback.",
          {
            httpStatus: 503,
            retryable: false,
            cause: error,
            details: { invoiceId: createdInvoiceId },
          },
        );
      }

      try {
        const readback = await this.#getInvoice(client, connection.tenantId, createdInvoiceId, "ACCREC");
        return {
          invoice: readback as SalesInvoiceSnapshot,
          receipt: { ...createReceipt, status: readback.status },
        };
      } catch (error) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero created a draft sales invoice but its exact readback was not verified.", {
          httpStatus: 502,
          retryable: false,
          details: { invoiceId: createdInvoiceId },
          cause: error,
        });
      }
    });
  }

  async getTrialBalance(principal: AccountingPrincipal, date?: string): Promise<Record<string, unknown>> {
    return this.#manager.getTrialBalance(principal, date);
  }

  /**
   * The ledger itself: the actual debit/credit lines a document produced.
   * Unlike getTrialBalance this goes through the ordinary SDK call, not the
   * dedicated bounded transport - `/Journals` responses are pages of a fixed,
   * provider-controlled batch size, not the whole-COA-at-once shape that made
   * Trial Balance need its own streaming boundary (see
   * docs/XERO-TRIAL-BALANCE-PROVIDER-RESOURCE-BOUNDARY.md).
   */
  async listJournals(principal: AccountingPrincipal, input: ListJournalsInput): Promise<JournalListResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getJournals(
        connection.tenantId,
        undefined,
        ...(input.offset === undefined ? [] : [input.offset]),
      );
      return mapJournalsPage(response.body.journals, input.offset === undefined ? {} : { offset: input.offset });
    });
  }

  async getProfitAndLoss(
    principal: AccountingPrincipal,
    input: ProfitAndLossInput,
  ): Promise<Record<string, unknown>> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getReportProfitAndLoss(
        connection.tenantId,
        input.date_from,
        input.date_to,
        input.periods,
        input.timeframe,
      );
      return mapXeroReportEnvelope(response.body);
    });
  }

  async getBalanceSheet(
    principal: AccountingPrincipal,
    input: BalanceSheetInput,
  ): Promise<Record<string, unknown>> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getReportBalanceSheet(
        connection.tenantId,
        input.date,
        input.periods,
        input.timeframe,
      );
      return mapXeroReportEnvelope(response.body);
    });
  }

  async getAgedReceivables(
    principal: AccountingPrincipal,
    input: AgedReceivablesInput,
  ): Promise<Record<string, unknown>> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getReportAgedReceivablesByContact(
        connection.tenantId,
        input.contact_id,
        input.date,
        input.date_from,
        input.date_to,
      );
      return mapXeroReportEnvelope(response.body);
    });
  }

  async getAgedPayables(
    principal: AccountingPrincipal,
    input: AgedPayablesInput,
  ): Promise<Record<string, unknown>> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getReportAgedPayablesByContact(
        connection.tenantId,
        input.contact_id,
        input.date,
        input.date_from,
        input.date_to,
      );
      return mapXeroReportEnvelope(response.body);
    });
  }

  async getPayment(principal: AccountingPrincipal, paymentId: string): Promise<PaymentSummary> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getPayment(connection.tenantId, paymentId);
      const payment = response.body.payments?.find((candidate) => candidate.paymentID === paymentId);
      const summary = payment === undefined ? undefined : mapPaymentSummary(payment);
      if (!summary || summary.paymentId !== paymentId) {
        throw new AppError("NOT_FOUND", "The requested Xero payment was not found.", { httpStatus: 404 });
      }
      return summary;
    });
  }

  async listTrackingCategories(
    principal: AccountingPrincipal,
    input: ListTrackingCategoriesInput,
  ): Promise<TrackingCategoryListResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getTrackingCategories(
        connection.tenantId,
        undefined,
        "Name ASC",
        input.include_archived,
      );
      const source = response.body.trackingCategories ?? [];
      const trackingCategories = source.slice(0, input.limit).flatMap((category) => {
        if (!category.trackingCategoryID) return [];
        const rawOptions = category.options ?? [];
        const options = rawOptions.slice(0, 100).flatMap((option) => option.trackingOptionID
          ? [{
              trackingOptionId: option.trackingOptionID,
              ...(option.name ? { name: option.name } : {}),
              ...(option.status ? { status: String(option.status) } : {}),
            }]
          : []);
        return [{
          trackingCategoryId: category.trackingCategoryID,
          ...(category.name ? { name: category.name } : {}),
          ...(category.status ? { status: String(category.status) } : {}),
          options,
          optionCount: rawOptions.length,
          optionsTruncated: rawOptions.length > 100,
          omittedInvalidOptions: rawOptions.slice(0, 100).length - options.length,
        }];
      });
      return {
        trackingCategories,
        pagination: {
          page: 1,
          pageSize: input.limit,
          returned: trackingCategories.length,
          hasNextPage: source.length > input.limit,
          hasNextPageIsEstimated: true,
          omittedInvalid: source.slice(0, input.limit).length - trackingCategories.length,
          ...(source.length > input.limit ? { omittedOverflow: source.length - input.limit } : {}),
        },
      };
    });
  }

  async listContactGroups(
    principal: AccountingPrincipal,
    input: ListContactGroupsInput,
  ): Promise<ContactGroupListResult> {
    return this.#manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getContactGroups(connection.tenantId, undefined, "Name ASC");
      const source = response.body.contactGroups ?? [];
      const contactGroups = source.slice(0, input.limit).flatMap((group) => group.contactGroupID
        ? [{
            contactGroupId: group.contactGroupID,
            ...(group.name ? { name: group.name } : {}),
            ...(group.status ? { status: String(group.status) } : {}),
          }]
        : []);
      return {
        contactGroups,
        pagination: {
          page: 1,
          pageSize: input.limit,
          returned: contactGroups.length,
          hasNextPage: source.length > input.limit,
          hasNextPageIsEstimated: true,
          omittedInvalid: source.slice(0, input.limit).length - contactGroups.length,
          ...(source.length > input.limit ? { omittedOverflow: source.length - input.limit } : {}),
        },
      };
    });
  }

  async #getInvoice(
    client: XeroReadClient,
    tenantId: string,
    invoiceId: string,
    expectedType?: InvoiceType,
    maxLines?: number,
  ): Promise<InvoiceSnapshot> {
    const response = await client.accountingApi.getInvoices(
      tenantId,
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
    const invoice = response.body.invoices?.find(
      (candidate) => candidate.invoiceID?.toLowerCase() === invoiceId.toLowerCase(),
    );
    const type = accountingInvoiceType(invoice?.type);
    if (!invoice || !type || (expectedType !== undefined && type !== expectedType)) {
      throw new AppError("NOT_FOUND", "The requested Xero invoice was not found.", { httpStatus: 404 });
    }
    return mapInvoiceSnapshot(tenantId, invoice, maxLines);
  }

  async #getSupplierBill(client: XeroReadClient, tenantId: string, invoiceId: string): Promise<SupplierBillSnapshot> {
    const invoice = await this.#getInvoice(client, tenantId, invoiceId, "ACCPAY");
    return invoice as SupplierBillSnapshot;
  }
}
