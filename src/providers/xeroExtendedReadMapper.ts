import {
  listBankTransactionsSchema,
  listItemsSchema,
  listManualJournalsSchema,
  listPurchaseOrdersSchema,
  listQuotesSchema,
  type BankTransactionSort,
  type ItemSort,
  type ManualJournalSort,
  type PurchaseOrderStatus,
  type PurchaseOrderSort,
  type QuoteSort,
} from "../domain/extendedReadSchemas.js";
import type { ReadPageEvidence } from "./types.js";
import { xeroProviderDate as xeroDate, xeroProviderInstant } from "./xeroProviderDate.js";

export const MAX_EXTENDED_READ_LINES = 100;
export const MAX_EXTENDED_READ_TRACKING = 2;
export const XERO_QUOTE_PROVIDER_PAGE_CAPACITY = 100;
const MAX_HEADER_TEXT = 512;
const MAX_NAME_TEXT = 255;
const MAX_LINE_DESCRIPTION = 512;

type ProviderObject = Record<string, unknown>;

export interface AttachmentEvidence {
  attachmentsKnown: boolean;
  hasAttachments?: boolean;
}

export interface ProjectionEvidence {
  projectionIncomplete: boolean;
  omittedFields: string[];
}

export interface ExtendedTrackingSnapshot {
  trackingCategoryId?: string;
  trackingOptionId?: string;
  name?: string;
  option?: string;
}

export interface ExtendedLineSnapshot {
  lineItemId?: string;
  description?: string;
  descriptionTruncated?: boolean;
  quantity?: string;
  unitAmount?: string;
  lineAmount?: string;
  taxAmount?: string;
  accountId?: string;
  accountCode?: string;
  itemCode?: string;
  taxType?: string;
  discountRate?: string;
  discountAmount?: string;
  tracking: ExtendedTrackingSnapshot[];
  trackingCount: number;
  trackingTruncated: boolean;
  omittedInvalidTracking: number;
}

export interface ManualJournalLineSnapshot {
  description?: string;
  descriptionTruncated?: boolean;
  lineAmount?: string;
  taxAmount?: string;
  accountId?: string;
  accountCode?: string;
  taxType?: string;
  tracking: ExtendedTrackingSnapshot[];
  trackingCount: number;
  trackingTruncated: boolean;
  omittedInvalidTracking: number;
}

export interface ExtendedContactReference {
  contactId: string;
  name?: string;
}

export interface ExtendedAccountReference {
  accountId?: string;
  code?: string;
  name?: string;
  currency?: string;
}

export interface QuoteSummary extends AttachmentEvidence, ProjectionEvidence {
  quoteId: string;
  status: string;
  contact?: ExtendedContactReference;
  quoteNumber?: string;
  reference?: string;
  quoteDate?: string;
  expiryDate?: string;
  currency?: string;
  currencyRate?: string;
  lineAmountType?: string;
  subTotal?: string;
  totalTax?: string;
  total?: string;
  totalDiscount?: string;
  updatedAt?: string;
}

export interface QuoteSnapshot extends QuoteSummary {
  lines: ExtendedLineSnapshot[];
  lineItemCount: number;
  linesTruncated: boolean;
  omittedInvalidLines: number;
}

export interface PurchaseOrderSummary extends AttachmentEvidence, ProjectionEvidence {
  purchaseOrderId: string;
  status: string;
  contact?: ExtendedContactReference;
  purchaseOrderNumber?: string;
  reference?: string;
  purchaseOrderDate?: string;
  deliveryDate?: string;
  expectedArrivalDate?: string;
  currency?: string;
  currencyRate?: string;
  lineAmountType?: string;
  sentToContact?: boolean;
  subTotal?: string;
  totalTax?: string;
  total?: string;
  totalDiscount?: string;
  updatedAt?: string;
}

export interface PurchaseOrderSnapshot extends PurchaseOrderSummary {
  lines: ExtendedLineSnapshot[];
  lineItemCount: number;
  linesTruncated: boolean;
  omittedInvalidLines: number;
}

export interface ManualJournalSummary extends AttachmentEvidence, ProjectionEvidence {
  manualJournalId: string;
  status: string;
  narration?: string;
  narrationTruncated?: boolean;
  journalDate?: string;
  lineAmountType?: string;
  showOnCashBasisReports?: boolean;
  updatedAt?: string;
}

export interface ManualJournalSnapshot extends ManualJournalSummary {
  lines: ManualJournalLineSnapshot[];
  lineItemCount: number;
  linesTruncated: boolean;
  omittedInvalidLines: number;
}

export interface ItemAccountingDefaults {
  unitPrice?: string;
  accountCode?: string;
  cogsAccountCode?: string;
  taxType?: string;
}

export interface ItemSummary extends ProjectionEvidence {
  itemId: string;
  code?: string;
  name?: string;
  providerResultStatus?: string;
  description?: string;
  descriptionTruncated?: boolean;
  purchaseDescription?: string;
  purchaseDescriptionTruncated?: boolean;
  isSold?: boolean;
  isPurchased?: boolean;
  isTrackedAsInventory?: boolean;
  inventoryAssetAccountCode?: string;
  quantityOnHand?: string;
  totalCostPool?: string;
  salesDetails?: ItemAccountingDefaults;
  purchaseDetails?: ItemAccountingDefaults;
  updatedAt?: string;
}

export interface BankTransactionSummary extends AttachmentEvidence, ProjectionEvidence {
  bankTransactionId: string;
  type: string;
  status: string;
  contact?: ExtendedContactReference;
  bankAccount?: ExtendedAccountReference;
  isReconciled?: boolean;
  transactionDate?: string;
  reference?: string;
  invoiceNumber?: string;
  currency?: string;
  currencyRate?: string;
  lineAmountType?: string;
  subTotal?: string;
  totalTax?: string;
  total?: string;
  prepaymentId?: string;
  overpaymentId?: string;
  updatedAt?: string;
}

export interface BankTransactionSnapshot extends BankTransactionSummary {
  lines: ExtendedLineSnapshot[];
  lineItemCount: number;
  linesTruncated: boolean;
  omittedInvalidLines: number;
}

export interface ProviderPaginationShape {
  page?: number;
  pageSize?: number;
  pageCount?: number;
  itemCount?: number;
}

export interface ExtendedReadPageOptions {
  /** Xero Quotes uses a fixed provider page capacity even when Agent output is smaller. */
  providerPageCapacity?: number;
  /** Use only when the provider endpoint proves the returned collection is exhaustive. */
  providerCollectionComplete?: boolean;
}

export interface QuoteLogicalPagePlan {
  providerPage: number;
  inPageOffset: number;
  fetchNextProviderPage: boolean;
}

function providerObject(value: unknown): ProviderObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderObject
    : undefined;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maxLength);
}

function providerId(value: unknown): string | undefined {
  return boundedText(value, 128);
}

function providerBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function decimal(value: unknown): string | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed.toFixed(4) : undefined;
}

/**
 * Currency rates must not be rounded to the four decimal places used for
 * ordinary money fields. Preserve provider strings and at least six decimal
 * places for numeric SDK values.
 */
function preciseDecimal(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
  if (raw.length === 0 || !Number.isFinite(Number(raw))) return undefined;
  if (/e/i.test(raw)) {
    return Number(raw).toFixed(12).replace(/(\.\d{6}?)0+$/u, "$1");
  }
  const [whole, fraction = ""] = raw.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

function projectionEvidence(
  value: ProviderObject,
  omittedProviderFields: readonly string[],
): ProjectionEvidence {
  const omittedFields = omittedProviderFields.filter((field) => value[field] !== undefined);
  return {
    projectionIncomplete: omittedFields.length > 0,
    omittedFields,
  };
}

function mapTracking(value: unknown): ExtendedTrackingSnapshot | undefined {
  const tracking = providerObject(value);
  if (!tracking) return undefined;
  const trackingCategoryId = providerId(tracking.trackingCategoryID);
  const trackingOptionId = providerId(tracking.trackingOptionID);
  const name = boundedText(tracking.name, MAX_NAME_TEXT);
  const option = boundedText(tracking.option, MAX_NAME_TEXT);
  if (!trackingCategoryId && !trackingOptionId && !name && !option) return undefined;
  return {
    ...(trackingCategoryId ? { trackingCategoryId } : {}),
    ...(trackingOptionId ? { trackingOptionId } : {}),
    ...(name ? { name } : {}),
    ...(option ? { option } : {}),
  };
}

function boundedTracking(value: unknown): Pick<
  ExtendedLineSnapshot,
  "tracking" | "trackingCount" | "trackingTruncated" | "omittedInvalidTracking"
> {
  const source = Array.isArray(value) ? value : [];
  const tracking: ExtendedTrackingSnapshot[] = [];
  let omittedInvalidTracking = 0;
  for (const entry of source) {
    const mapped = mapTracking(entry);
    if (!mapped) omittedInvalidTracking += 1;
    else if (tracking.length < MAX_EXTENDED_READ_TRACKING) tracking.push(mapped);
  }
  return {
    tracking,
    trackingCount: source.length,
    trackingTruncated: source.length > tracking.length + omittedInvalidTracking,
    omittedInvalidTracking,
  };
}

function xeroUpdatedAt(value: ProviderObject): string | undefined {
  const candidate = value.updatedDateUTC ?? value.updatedDateUTCString;
  const instant = xeroProviderInstant(candidate);
  if (instant) return instant.toISOString();
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? boundedText(candidate, 64) : parsed.toISOString();
}

function status(value: unknown): string {
  return boundedText(value, 64) ?? "UNKNOWN";
}

function currency(value: unknown): string | undefined {
  const candidate = boundedText(value, 16);
  return candidate && /^[A-Z]{3}$/.test(candidate) ? candidate : undefined;
}

function attachmentEvidence(value: ProviderObject): AttachmentEvidence {
  if (typeof value.hasAttachments === "boolean") {
    return { attachmentsKnown: true, hasAttachments: value.hasAttachments };
  }
  if (Array.isArray(value.attachments)) {
    return { attachmentsKnown: true, hasAttachments: value.attachments.length > 0 };
  }
  return { attachmentsKnown: false };
}

function contactReference(value: unknown): ExtendedContactReference | undefined {
  const contact = providerObject(value);
  const contactId = providerId(contact?.contactID);
  if (!contactId) return undefined;
  const name = boundedText(contact?.name, MAX_NAME_TEXT);
  return {
    contactId,
    ...(name ? { name } : {}),
  };
}

function accountReference(value: unknown): ExtendedAccountReference | undefined {
  const account = providerObject(value);
  if (!account) return undefined;
  const accountId = providerId(account.accountID);
  const code = boundedText(account.code, 10);
  const name = boundedText(account.name, 150);
  const accountCurrency = currency(account.currencyCode);
  if (!accountId && !code && !name && !accountCurrency) return undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    ...(accountCurrency ? { currency: accountCurrency } : {}),
  };
}

function textWithTruncation(
  value: unknown,
  maxLength: number,
): { text?: string; truncated?: boolean } {
  const text = boundedText(value, maxLength);
  if (!text) return {};
  return {
    text,
    ...(typeof value === "string" && value.length > maxLength ? { truncated: true } : {}),
  };
}

function mapExtendedLine(value: unknown): ExtendedLineSnapshot | undefined {
  const line = providerObject(value);
  if (!line) return undefined;
  const description = textWithTruncation(line.description, MAX_LINE_DESCRIPTION);
  const lineItemId = providerId(line.lineItemID);
  const quantity = decimal(line.quantity);
  const unitAmount = decimal(line.unitAmount);
  const lineAmount = decimal(line.lineAmount);
  const taxAmount = decimal(line.taxAmount);
  const accountId = providerId(line.accountID);
  const accountCode = boundedText(line.accountCode, 10);
  const itemCode = boundedText(line.itemCode, 30);
  const taxType = boundedText(line.taxType, 100);
  const discountRate = decimal(line.discountRate);
  const discountAmount = decimal(line.discountAmount);
  const tracking = boundedTracking(line.tracking);
  const core: Omit<
    ExtendedLineSnapshot,
    "tracking" | "trackingCount" | "trackingTruncated" | "omittedInvalidTracking"
  > = {
    ...(lineItemId ? { lineItemId } : {}),
    ...(description.text ? { description: description.text } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unitAmount !== undefined ? { unitAmount } : {}),
    ...(lineAmount !== undefined ? { lineAmount } : {}),
    ...(taxAmount !== undefined ? { taxAmount } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountCode ? { accountCode } : {}),
    ...(itemCode ? { itemCode } : {}),
    ...(taxType ? { taxType } : {}),
    ...(discountRate !== undefined ? { discountRate } : {}),
    ...(discountAmount !== undefined ? { discountAmount } : {}),
  };
  if (Object.keys(core).length === 0 && tracking.tracking.length === 0) return undefined;
  return { ...core, ...tracking };
}

function mapManualJournalLine(value: unknown): ManualJournalLineSnapshot | undefined {
  const line = providerObject(value);
  if (!line) return undefined;
  const description = textWithTruncation(line.description, MAX_LINE_DESCRIPTION);
  const lineAmount = decimal(line.lineAmount);
  const taxAmount = decimal(line.taxAmount);
  const accountId = providerId(line.accountID);
  const accountCode = boundedText(line.accountCode, 10);
  const taxType = boundedText(line.taxType, 100);
  const tracking = boundedTracking(line.tracking);
  const core: Omit<
    ManualJournalLineSnapshot,
    "tracking" | "trackingCount" | "trackingTruncated" | "omittedInvalidTracking"
  > = {
    ...(description.text ? { description: description.text } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(lineAmount !== undefined ? { lineAmount } : {}),
    ...(taxAmount !== undefined ? { taxAmount } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountCode ? { accountCode } : {}),
    ...(taxType ? { taxType } : {}),
  };
  if (Object.keys(core).length === 0 && tracking.tracking.length === 0) return undefined;
  return { ...core, ...tracking };
}

function boundedLines<T>(
  value: unknown,
  mapper: (line: unknown) => T | undefined,
): {
  lines: T[];
  lineItemCount: number;
  linesTruncated: boolean;
  omittedInvalidLines: number;
} {
  const source = Array.isArray(value) ? value : [];
  const lines: T[] = [];
  let omittedInvalidLines = 0;
  for (const item of source) {
    const mapped = mapper(item);
    if (!mapped) {
      omittedInvalidLines += 1;
    } else if (lines.length < MAX_EXTENDED_READ_LINES) {
      lines.push(mapped);
    }
  }
  return {
    lines,
    lineItemCount: source.length,
    linesTruncated: lines.length < source.length,
    omittedInvalidLines,
  };
}

function commonMoneyFields(value: ProviderObject): Pick<
  QuoteSummary,
  "subTotal" | "totalTax" | "total" | "totalDiscount"
> {
  const subTotal = decimal(value.subTotal);
  const totalTax = decimal(value.totalTax);
  const total = decimal(value.total);
  const totalDiscount = decimal(value.totalDiscount);
  return {
    ...(subTotal !== undefined ? { subTotal } : {}),
    ...(totalTax !== undefined ? { totalTax } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(totalDiscount !== undefined ? { totalDiscount } : {}),
  };
}

export function mapQuoteSummary(input: unknown): QuoteSummary | undefined {
  const quote = providerObject(input);
  const quoteId = providerId(quote?.quoteID);
  if (!quote || !quoteId) return undefined;
  const contact = contactReference(quote.contact);
  const quoteNumber = boundedText(quote.quoteNumber, 255);
  const reference = boundedText(quote.reference, MAX_HEADER_TEXT);
  const quoteDate = xeroDate(quote.date) ?? xeroDate(quote.dateString);
  const expiryDate = xeroDate(quote.expiryDate) ?? xeroDate(quote.expiryDateString);
  const quoteCurrency = currency(quote.currencyCode);
  const currencyRate = preciseDecimal(quote.currencyRate);
  const lineAmountType = boundedText(quote.lineAmountTypes, 32);
  const updatedAt = xeroUpdatedAt(quote);
  return {
    quoteId,
    status: status(quote.status),
    ...(contact ? { contact } : {}),
    ...(quoteNumber ? { quoteNumber } : {}),
    ...(reference ? { reference } : {}),
    ...(quoteDate ? { quoteDate } : {}),
    ...(expiryDate ? { expiryDate } : {}),
    ...(quoteCurrency ? { currency: quoteCurrency } : {}),
    ...(currencyRate !== undefined ? { currencyRate } : {}),
    ...(lineAmountType ? { lineAmountType } : {}),
    ...commonMoneyFields(quote),
    ...attachmentEvidence(quote),
    ...projectionEvidence(quote, ["lineItems", "terms", "title", "summary"]),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function mapQuoteSnapshot(input: unknown): QuoteSnapshot | undefined {
  const quote = providerObject(input);
  const summary = mapQuoteSummary(input);
  if (!quote || !summary) return undefined;
  return {
    ...summary,
    ...boundedLines(quote.lineItems, mapExtendedLine),
    ...projectionEvidence(quote, ["terms", "title", "summary"]),
  };
}

export function mapPurchaseOrderSummary(input: unknown): PurchaseOrderSummary | undefined {
  const purchaseOrder = providerObject(input);
  const purchaseOrderId = providerId(purchaseOrder?.purchaseOrderID);
  if (!purchaseOrder || !purchaseOrderId) return undefined;
  const contact = contactReference(purchaseOrder.contact);
  const purchaseOrderNumber = boundedText(purchaseOrder.purchaseOrderNumber, 255);
  const reference = boundedText(purchaseOrder.reference, MAX_HEADER_TEXT);
  const purchaseOrderDate = xeroDate(purchaseOrder.date);
  const deliveryDate = xeroDate(purchaseOrder.deliveryDate);
  const expectedArrivalDate = xeroDate(purchaseOrder.expectedArrivalDate);
  const purchaseOrderCurrency = currency(purchaseOrder.currencyCode);
  const currencyRate = preciseDecimal(purchaseOrder.currencyRate);
  const lineAmountType = boundedText(purchaseOrder.lineAmountTypes, 32);
  const sentToContact = providerBoolean(purchaseOrder.sentToContact);
  const updatedAt = xeroUpdatedAt(purchaseOrder);
  return {
    purchaseOrderId,
    status: status(purchaseOrder.status),
    ...(contact ? { contact } : {}),
    ...(purchaseOrderNumber ? { purchaseOrderNumber } : {}),
    ...(reference ? { reference } : {}),
    ...(purchaseOrderDate ? { purchaseOrderDate } : {}),
    ...(deliveryDate ? { deliveryDate } : {}),
    ...(expectedArrivalDate ? { expectedArrivalDate } : {}),
    ...(purchaseOrderCurrency ? { currency: purchaseOrderCurrency } : {}),
    ...(currencyRate !== undefined ? { currencyRate } : {}),
    ...(lineAmountType ? { lineAmountType } : {}),
    ...(sentToContact !== undefined ? { sentToContact } : {}),
    ...commonMoneyFields(purchaseOrder),
    ...attachmentEvidence(purchaseOrder),
    ...projectionEvidence(purchaseOrder, [
      "lineItems",
      "attentionTo",
      "telephone",
      "deliveryAddress",
      "deliveryInstructions",
    ]),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function mapPurchaseOrderSnapshot(input: unknown): PurchaseOrderSnapshot | undefined {
  const purchaseOrder = providerObject(input);
  const summary = mapPurchaseOrderSummary(input);
  if (!purchaseOrder || !summary) return undefined;
  return {
    ...summary,
    ...boundedLines(purchaseOrder.lineItems, mapExtendedLine),
    ...projectionEvidence(purchaseOrder, [
      "attentionTo",
      "telephone",
      "deliveryAddress",
      "deliveryInstructions",
    ]),
  };
}

export function mapManualJournalSummary(input: unknown): ManualJournalSummary | undefined {
  const journal = providerObject(input);
  const manualJournalId = providerId(journal?.manualJournalID);
  if (!journal || !manualJournalId) return undefined;
  const narration = textWithTruncation(journal.narration, MAX_HEADER_TEXT);
  const journalDate = xeroDate(journal.date);
  const lineAmountType = boundedText(journal.lineAmountTypes, 32);
  const showOnCashBasisReports = providerBoolean(journal.showOnCashBasisReports);
  const updatedAt = xeroUpdatedAt(journal);
  return {
    manualJournalId,
    status: status(journal.status),
    ...(narration.text ? { narration: narration.text } : {}),
    ...(narration.truncated ? { narrationTruncated: true } : {}),
    ...(journalDate ? { journalDate } : {}),
    ...(lineAmountType ? { lineAmountType } : {}),
    ...(showOnCashBasisReports !== undefined ? { showOnCashBasisReports } : {}),
    ...attachmentEvidence(journal),
    ...projectionEvidence(journal, ["journalLines", "url", "validationErrors"]),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function mapManualJournalSnapshot(input: unknown): ManualJournalSnapshot | undefined {
  const journal = providerObject(input);
  const summary = mapManualJournalSummary(input);
  if (!journal || !summary) return undefined;
  return {
    ...summary,
    ...boundedLines(journal.journalLines, mapManualJournalLine),
    ...projectionEvidence(journal, ["url", "validationErrors"]),
  };
}

function mapItemDefaults(value: unknown): ItemAccountingDefaults | undefined {
  const details = providerObject(value);
  if (!details) return undefined;
  const unitPrice = decimal(details.unitPrice);
  const accountCode = boundedText(details.accountCode, 10);
  const cogsAccountCode = boundedText(details.cOGSAccountCode, 10);
  const taxType = boundedText(details.taxType, 100);
  if (unitPrice === undefined && !accountCode && !cogsAccountCode && !taxType) return undefined;
  return {
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    ...(accountCode ? { accountCode } : {}),
    ...(cogsAccountCode ? { cogsAccountCode } : {}),
    ...(taxType ? { taxType } : {}),
  };
}

export function mapItemSummary(input: unknown): ItemSummary | undefined {
  const item = providerObject(input);
  const itemId = providerId(item?.itemID);
  if (!item || !itemId) return undefined;
  const code = boundedText(item.code, 30);
  const name = boundedText(item.name, 50);
  const itemDescription = textWithTruncation(item.description, MAX_LINE_DESCRIPTION);
  const purchaseDescription = textWithTruncation(item.purchaseDescription, MAX_LINE_DESCRIPTION);
  const isSold = providerBoolean(item.isSold);
  const isPurchased = providerBoolean(item.isPurchased);
  const isTrackedAsInventory = providerBoolean(item.isTrackedAsInventory);
  const inventoryAssetAccountCode = boundedText(item.inventoryAssetAccountCode, 10);
  const quantityOnHand = decimal(item.quantityOnHand);
  const totalCostPool = decimal(item.totalCostPool);
  const salesDetails = mapItemDefaults(item.salesDetails);
  const purchaseDetails = mapItemDefaults(item.purchaseDetails);
  const updatedAt = xeroUpdatedAt(item);
  const providerResultStatus = boundedText(item.statusAttributeString, 64);
  return {
    itemId,
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    ...(providerResultStatus ? { providerResultStatus } : {}),
    ...(itemDescription.text ? { description: itemDescription.text } : {}),
    ...(itemDescription.truncated ? { descriptionTruncated: true } : {}),
    ...(purchaseDescription.text ? { purchaseDescription: purchaseDescription.text } : {}),
    ...(purchaseDescription.truncated ? { purchaseDescriptionTruncated: true } : {}),
    ...(isSold !== undefined ? { isSold } : {}),
    ...(isPurchased !== undefined ? { isPurchased } : {}),
    ...(isTrackedAsInventory !== undefined ? { isTrackedAsInventory } : {}),
    ...(inventoryAssetAccountCode ? { inventoryAssetAccountCode } : {}),
    ...(quantityOnHand !== undefined ? { quantityOnHand } : {}),
    ...(totalCostPool !== undefined ? { totalCostPool } : {}),
    ...(salesDetails ? { salesDetails } : {}),
    ...(purchaseDetails ? { purchaseDetails } : {}),
    ...projectionEvidence(item, ["validationErrors"]),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function mapBankTransactionSummary(input: unknown): BankTransactionSummary | undefined {
  const transaction = providerObject(input);
  const bankTransactionId = providerId(transaction?.bankTransactionID);
  if (!transaction || !bankTransactionId) return undefined;
  const contact = contactReference(transaction.contact);
  const bankAccount = accountReference(transaction.bankAccount);
  const isReconciled = providerBoolean(transaction.isReconciled);
  const transactionDate = xeroDate(transaction.date);
  const reference = boundedText(transaction.reference, MAX_HEADER_TEXT);
  const invoiceNumber = boundedText(transaction.invoiceNumber, 255);
  const transactionCurrency = currency(transaction.currencyCode);
  const currencyRate = preciseDecimal(transaction.currencyRate);
  const lineAmountType = boundedText(transaction.lineAmountTypes, 32);
  const subTotal = decimal(transaction.subTotal);
  const totalTax = decimal(transaction.totalTax);
  const total = decimal(transaction.total);
  const prepaymentId = providerId(transaction.prepaymentID);
  const overpaymentId = providerId(transaction.overpaymentID);
  const updatedAt = xeroUpdatedAt(transaction);
  return {
    bankTransactionId,
    type: status(transaction.type),
    status: status(transaction.status),
    ...(contact ? { contact } : {}),
    ...(bankAccount ? { bankAccount } : {}),
    ...(isReconciled !== undefined ? { isReconciled } : {}),
    ...(transactionDate ? { transactionDate } : {}),
    ...(reference ? { reference } : {}),
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(transactionCurrency ? { currency: transactionCurrency } : {}),
    ...(currencyRate !== undefined ? { currencyRate } : {}),
    ...(lineAmountType ? { lineAmountType } : {}),
    ...(subTotal !== undefined ? { subTotal } : {}),
    ...(totalTax !== undefined ? { totalTax } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(prepaymentId ? { prepaymentId } : {}),
    ...(overpaymentId ? { overpaymentId } : {}),
    ...attachmentEvidence(transaction),
    ...projectionEvidence(transaction, ["lineItems", "url", "validationErrors"]),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function mapBankTransactionSnapshot(input: unknown): BankTransactionSnapshot | undefined {
  const transaction = providerObject(input);
  const summary = mapBankTransactionSummary(input);
  if (!transaction || !summary) return undefined;
  return {
    ...summary,
    ...boundedLines(transaction.lineItems, mapExtendedLine),
    ...projectionEvidence(transaction, ["url", "validationErrors"]),
  };
}

const QUOTE_ORDER: Readonly<Record<QuoteSort, string>> = {
  DATE_ASC: "Date ASC",
  DATE_DESC: "Date DESC",
  EXPIRY_DATE_ASC: "ExpiryDate ASC",
  EXPIRY_DATE_DESC: "ExpiryDate DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

const PURCHASE_ORDER_ORDER: Readonly<Record<PurchaseOrderSort, string>> = {
  DATE_ASC: "Date ASC",
  DATE_DESC: "Date DESC",
  DELIVERY_DATE_ASC: "DeliveryDate ASC",
  DELIVERY_DATE_DESC: "DeliveryDate DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

const MANUAL_JOURNAL_ORDER: Readonly<Record<ManualJournalSort, string>> = {
  DATE_ASC: "Date ASC",
  DATE_DESC: "Date DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

const ITEM_ORDER: Readonly<Record<ItemSort, string>> = {
  CODE_ASC: "Code ASC",
  CODE_DESC: "Code DESC",
  NAME_ASC: "Name ASC",
  NAME_DESC: "Name DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

const BANK_TRANSACTION_ORDER: Readonly<Record<BankTransactionSort, string>> = {
  DATE_ASC: "Date ASC",
  DATE_DESC: "Date DESC",
  UPDATED_AT_ASC: "UpdatedDateUTC ASC",
  UPDATED_AT_DESC: "UpdatedDateUTC DESC",
};

function xeroDateTime(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `DateTime(${year},${month},${day})`;
}

/** JSON string escaping prevents a caller term from breaking out of a reviewed Xero expression. */
function xeroStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export function buildQuoteReadQuery(input: unknown): {
  dateFrom?: string;
  dateTo?: string;
  expiryDateFrom?: string;
  expiryDateTo?: string;
  contactID?: string;
  status?: string;
  providerPage: number;
  inPageOffset: number;
  fetchNextProviderPage: boolean;
  order: string;
  quoteNumber?: string;
  resultLimit: number;
} {
  const value = listQuotesSchema.parse(input);
  const logicalOffset = (value.page - 1) * value.page_size;
  const inPageOffset = logicalOffset % XERO_QUOTE_PROVIDER_PAGE_CAPACITY;
  return {
    ...(value.date_from ? { dateFrom: value.date_from } : {}),
    ...(value.date_to ? { dateTo: value.date_to } : {}),
    ...(value.expiry_date_from ? { expiryDateFrom: value.expiry_date_from } : {}),
    ...(value.expiry_date_to ? { expiryDateTo: value.expiry_date_to } : {}),
    ...(value.contact_id ? { contactID: value.contact_id } : {}),
    ...(value.status ? { status: value.status } : {}),
    providerPage: Math.floor(logicalOffset / XERO_QUOTE_PROVIDER_PAGE_CAPACITY) + 1,
    inPageOffset,
    fetchNextProviderPage: inPageOffset + value.page_size > XERO_QUOTE_PROVIDER_PAGE_CAPACITY,
    order: QUOTE_ORDER[value.sort],
    ...(value.quote_number ? { quoteNumber: value.quote_number } : {}),
    resultLimit: value.page_size,
  };
}

export function buildPurchaseOrderReadQuery(input: unknown): {
  status?: PurchaseOrderStatus;
  dateFrom?: string;
  dateTo?: string;
  order: string;
  page: number;
  pageSize: number;
} {
  const value = listPurchaseOrdersSchema.parse(input);
  return {
    ...(value.status ? { status: value.status } : {}),
    ...(value.date_from ? { dateFrom: value.date_from } : {}),
    ...(value.date_to ? { dateTo: value.date_to } : {}),
    order: PURCHASE_ORDER_ORDER[value.sort],
    page: value.page,
    pageSize: value.page_size,
  };
}

export function buildManualJournalReadQuery(input: unknown): {
  where?: string;
  order: string;
  page: number;
  pageSize: number;
} {
  const value = listManualJournalsSchema.parse(input);
  const clauses: string[] = [];
  if (value.status) clauses.push(`Status==${xeroStringLiteral(value.status)}`);
  if (value.date_from) clauses.push(`Date>=${xeroDateTime(value.date_from)}`);
  if (value.date_to) clauses.push(`Date<=${xeroDateTime(value.date_to)}`);
  if (value.search_term) clauses.push(`Narration.Contains(${xeroStringLiteral(value.search_term)})`);
  return {
    ...(clauses.length > 0 ? { where: clauses.join(" AND ") } : {}),
    order: MANUAL_JOURNAL_ORDER[value.sort],
    page: value.page,
    pageSize: value.page_size,
  };
}

export function buildItemReadQuery(input: unknown): {
  where?: string;
  order: string;
  localPage: number;
  localPageSize: number;
} {
  const value = listItemsSchema.parse(input);
  const clauses: string[] = [];
  if (value.is_sold !== undefined) clauses.push(`IsSold==${value.is_sold}`);
  if (value.is_purchased !== undefined) clauses.push(`IsPurchased==${value.is_purchased}`);
  if (value.is_tracked_as_inventory !== undefined) {
    clauses.push(`IsTrackedAsInventory==${value.is_tracked_as_inventory}`);
  }
  if (value.search_term) {
    const literal = xeroStringLiteral(value.search_term);
    clauses.push(`(Code.Contains(${literal}) OR Name.Contains(${literal}))`);
  }
  return {
    ...(clauses.length > 0 ? { where: clauses.join(" AND ") } : {}),
    order: ITEM_ORDER[value.sort],
    localPage: value.page,
    localPageSize: value.page_size,
  };
}

export function buildBankTransactionReadQuery(input: unknown): {
  where?: string;
  order: string;
  page: number;
  pageSize: number;
  unitdp: 4;
} {
  const value = listBankTransactionsSchema.parse(input);
  const clauses: string[] = [];
  if (value.type) clauses.push(`Type==${xeroStringLiteral(value.type)}`);
  if (value.status) clauses.push(`Status==${xeroStringLiteral(value.status)}`);
  if (value.is_reconciled !== undefined) clauses.push(`IsReconciled==${value.is_reconciled}`);
  if (value.contact_id) clauses.push(`Contact.ContactID==Guid(${xeroStringLiteral(value.contact_id)})`);
  if (value.bank_account_id) {
    clauses.push(`BankAccount.AccountID==Guid(${xeroStringLiteral(value.bank_account_id)})`);
  }
  if (value.date_from) clauses.push(`Date>=${xeroDateTime(value.date_from)}`);
  if (value.date_to) clauses.push(`Date<=${xeroDateTime(value.date_to)}`);
  if (value.invoice_number) clauses.push(`InvoiceNumber==${xeroStringLiteral(value.invoice_number)}`);
  if (value.search_term) {
    const field = value.type === "RECEIVE-PREPAYMENT" ? "InvoiceNumber" : "Reference";
    clauses.push(`${field}.Contains(${xeroStringLiteral(value.search_term)})`);
  }
  return {
    ...(clauses.length > 0 ? { where: clauses.join(" AND ") } : {}),
    order: BANK_TRANSACTION_ORDER[value.sort],
    page: value.page,
    pageSize: value.page_size,
    unitdp: 4,
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Locally caps one provider page and preserves whether `hasNextPage` is exact
 * provider evidence or only an estimate. It never treats a short Agent-facing
 * projection as proof that the provider dataset is complete.
 */
export function mapBoundedExtendedReadPage<T, Mapped>(
  providerRecords: readonly T[] | undefined,
  input: { page: number; page_size: number },
  mapper: (record: T) => Mapped | undefined,
  providerPagination?: ProviderPaginationShape,
  options: ExtendedReadPageOptions = {},
): { records: Mapped[]; pagination: ReadPageEvidence } {
  const source = providerRecords ?? [];
  const bounded = source.slice(0, input.page_size);
  const records = bounded
    .map(mapper)
    .filter((record): record is Mapped => record !== undefined);
  const currentPage = positiveInteger(providerPagination?.page) ?? input.page;
  const providerPageSize = positiveInteger(providerPagination?.pageSize);
  const providerPageCount = positiveInteger(providerPagination?.pageCount);
  const providerItemCount = typeof providerPagination?.itemCount === "number"
    && Number.isInteger(providerPagination.itemCount)
    && providerPagination.itemCount >= 0
    ? providerPagination.itemCount
    : undefined;
  const capacity = positiveInteger(options.providerPageCapacity) ?? input.page_size;
  const hasExactPageCount = providerPageCount !== undefined;
  const collectionComplete = options.providerCollectionComplete === true;
  return {
    records,
    pagination: {
      page: currentPage,
      pageSize: providerPageSize ?? input.page_size,
      returned: records.length,
      ...(providerPageCount !== undefined ? { providerPageCount } : {}),
      ...(providerItemCount !== undefined ? { providerItemCount } : {}),
      hasNextPage: hasExactPageCount
        ? currentPage < providerPageCount
        : collectionComplete
          ? false
          : source.length >= capacity,
      hasNextPageIsEstimated: !hasExactPageCount && !collectionComplete,
      omittedInvalid: bounded.length - records.length,
      ...(source.length > bounded.length ? { omittedOverflow: source.length - bounded.length } : {}),
    },
  };
}
