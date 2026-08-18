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
} from "../domain/schemas.js";
import type {
  ListBankTransactionsInput,
  ListItemsInput,
  ListManualJournalsInput,
  ListPurchaseOrdersInput,
  ListQuotesInput,
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
  ContactSummary,
  CreditNoteListResult,
  CreditNoteSnapshot,
  CreditNoteSummary,
  InvoiceListResult,
  InvoiceSnapshot,
  InvoiceSummary,
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
} from "./types.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import { describeLegacyXeroScopePolicyProblems } from "./xeroScopes.js";
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
  mapManualJournalSnapshot,
  mapManualJournalSummary,
  mapPurchaseOrderSnapshot,
  mapPurchaseOrderSummary,
  mapQuoteSnapshot,
  mapQuoteSummary,
  XERO_QUOTE_PROVIDER_PAGE_CAPACITY,
  type BankTransactionSnapshot,
  type ItemSummary,
  type ManualJournalSnapshot,
  type PurchaseOrderSnapshot,
  type QuoteSnapshot,
} from "./xeroExtendedReadMapper.js";

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

function xeroDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const match = /^\/Date\((-?\d+)/.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = new Date(Number(match[1]));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
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
  if (invoice.updatedDateUTC instanceof Date) summary.updatedAt = invoice.updatedDateUTC.toISOString();
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
      if (organisation.periodLockDate) summary.periodLockDate = organisation.periodLockDate;
      if (organisation.endOfYearLockDate) summary.endOfYearLockDate = organisation.endOfYearLockDate;
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
          true,
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
    const invoice = response.body.invoices?.find((candidate) => candidate.invoiceID === invoiceId);
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
