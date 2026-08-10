import {
  CurrencyCode,
  LineAmountTypes,
  PurchaseOrder,
  QuoteLineAmountTypes,
  QuoteStatusCodes,
  type PurchaseOrders,
  type Quotes,
} from "xero-node";
import {
  buildPurchaseOrderDraftPrimitive,
  buildQuoteDraftPrimitive,
  parseCanonicalPurchaseOrderDraftPayload,
  parseCanonicalQuoteDraftPayload,
  type CanonicalControlledDraftLine,
  type CanonicalLineAmountType,
  type CanonicalPurchaseOrderDraftPayload,
  type CanonicalQuoteDraftPayload,
  type PrepareQuoteDraftInput,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import { hashObject } from "../security/hash.js";

const QUOTE_LINE_AMOUNT_TYPES: Readonly<Record<CanonicalLineAmountType, QuoteLineAmountTypes>> = {
  EXCLUSIVE: QuoteLineAmountTypes.EXCLUSIVE,
  INCLUSIVE: QuoteLineAmountTypes.INCLUSIVE,
  NO_TAX: QuoteLineAmountTypes.NOTAX,
};

const PURCHASE_ORDER_LINE_AMOUNT_TYPES: Readonly<Record<CanonicalLineAmountType, LineAmountTypes>> = {
  EXCLUSIVE: LineAmountTypes.Exclusive,
  INCLUSIVE: LineAmountTypes.Inclusive,
  NO_TAX: LineAmountTypes.NoTax,
};

function xeroCurrency(value: string): CurrencyCode {
  const code = CurrencyCode[value as keyof typeof CurrencyCode];
  if (!code) throw new Error("Unsupported canonical Xero currency.");
  return code;
}

function xeroLine(line: CanonicalControlledDraftLine) {
  return {
    description: line.description,
    quantity: Number(line.quantity),
    unitAmount: Number(line.unitAmount),
    accountCode: line.accountCode,
    taxType: line.taxType,
    ...(line.itemCode ? { itemCode: line.itemCode } : {}),
    ...(line.trackingOptionIds.length > 0
      ? { tracking: line.trackingOptionIds.map((trackingOptionID) => ({ trackingOptionID })) }
      : {}),
  };
}

export function toXeroQuoteCreatePayload(input: unknown): Quotes {
  const value = parseCanonicalQuoteDraftPayload(input);
  return {
    quotes: [{
      status: QuoteStatusCodes.DRAFT,
      contact: { contactID: value.contactId },
      date: value.quoteDate,
      expiryDate: value.expiryDate,
      currencyCode: xeroCurrency(value.currency),
      reference: value.reference,
      lineAmountTypes: QUOTE_LINE_AMOUNT_TYPES[value.lineAmountType],
      lineItems: value.lines.map(xeroLine),
    }],
  };
}

export function toXeroPurchaseOrderCreatePayload(input: unknown): PurchaseOrders {
  const value = parseCanonicalPurchaseOrderDraftPayload(input);
  return {
    purchaseOrders: [{
      status: PurchaseOrder.StatusEnum.DRAFT,
      contact: { contactID: value.contactId },
      date: value.purchaseOrderDate,
      ...(value.expectedArrivalDate ? { expectedArrivalDate: value.expectedArrivalDate } : {}),
      ...(value.deliveryDate ? { deliveryDate: value.deliveryDate } : {}),
      currencyCode: xeroCurrency(value.currency),
      reference: value.reference,
      lineAmountTypes: PURCHASE_ORDER_LINE_AMOUNT_TYPES[value.lineAmountType],
      lineItems: value.lines.map(xeroLine),
    }],
  };
}

type ProviderRecord = Record<string, unknown>;
type ProviderLineInput = PrepareQuoteDraftInput["lines"][number];

export interface QuoteDraftReadbackSnapshot {
  objectType: "QUOTE";
  quoteId: string;
  canonicalPayload: CanonicalQuoteDraftPayload;
  providerTotalsVerified: true;
  providerTotalsEvidence: ProviderTotalsEvidence;
  providerLineAmountEvidence: ProviderLineAmountEvidence;
}

export interface PurchaseOrderDraftReadbackSnapshot {
  objectType: "PURCHASE_ORDER";
  purchaseOrderId: string;
  canonicalPayload: CanonicalPurchaseOrderDraftPayload;
  providerTotalsVerified: true;
  providerTotalsEvidence: ProviderTotalsEvidence;
  providerLineAmountEvidence: ProviderLineAmountEvidence;
}

export interface ProviderLineAmountEvidence {
  verificationRole: "NON_CANONICAL_EVIDENCE";
  values: Array<string | null>;
  observedCount: number;
  missingCount: number;
  amountsMatchEntered: true;
}

export interface ProviderTotalsEvidence {
  subTotal: string;
  totalTax: string;
  total: string;
  arithmeticVerified: true;
  lineBasisVerified: true;
}

export type DraftReadbackMappingResult<TSnapshot> =
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; reason: "MALFORMED_PROVIDER_READBACK" };

export type DraftReadbackVerificationResult<TSnapshot, TCanonical> =
  | {
      ok: true;
      snapshot: TSnapshot;
      readbackCanonicalPayload: TCanonical;
      readbackCanonicalPayloadHash: string;
    }
  | {
      ok: false;
      reasons: Array<
        | "MALFORMED_PROVIDER_READBACK"
        | "EXPECTED_OBJECT_ID_INVALID"
        | "EXPECTED_CANONICAL_INVALID"
        | "XERO_OBJECT_ID_MISMATCH"
        | "CANONICAL_PAYLOAD_MISMATCH"
      >;
      snapshot?: TSnapshot;
      readbackCanonicalPayload?: TCanonical;
    };

/**
 * These helpers are deliberately state-free. A missing/ambiguous create
 * receipt remains WRITE_RESULT_UNKNOWN in the calling workflow; a false
 * verification result is where that workflow decides READBACK_MISMATCH.
 */

function providerRecord(value: unknown): ProviderRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderRecord
    : undefined;
}

function providerTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    return undefined;
  }
  return value;
}

function providerUuid(value: unknown): string | undefined {
  const text = providerTrimmedString(value, 36);
  return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)
    ? text.toLowerCase()
    : undefined;
}

function providerNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7 ? value : undefined;
}

function providerHasNoValidationErrors(value: ProviderRecord): boolean {
  if (value.hasErrors !== undefined && value.hasErrors !== false) return false;
  if (value.validationErrors === undefined) return true;
  return Array.isArray(value.validationErrors) && value.validationErrors.length === 0;
}

function providerTracking(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const optionIds: string[] = [];
  for (const candidate of value) {
    const tracking = providerRecord(candidate);
    const optionId = providerUuid(tracking?.trackingOptionID);
    if (!tracking || !optionId) return undefined;
    optionIds.push(optionId);
  }
  if (new Set(optionIds).size !== optionIds.length) return undefined;
  return optionIds.sort();
}

function providerLines(value: unknown): {
  lines: ProviderLineInput[];
  lineAmountEvidence: ProviderLineAmountEvidence;
} | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return undefined;
  const lines: ProviderLineInput[] = [];
  const lineAmountValues: Array<string | null> = [];
  for (const candidate of value) {
    const line = providerRecord(candidate);
    if (!line) return undefined;
    const description = providerTrimmedString(line.description, 4_000);
    const quantity = providerNumber(line.quantity);
    const unitAmount = providerNumber(line.unitAmount);
    const lineAmount = line.lineAmount === undefined ? undefined : providerNumber(line.lineAmount);
    const discountRate = line.discountRate === undefined ? 0 : providerNumber(line.discountRate);
    const discountAmount = line.discountAmount === undefined ? 0 : providerNumber(line.discountAmount);
    const accountCode = providerTrimmedString(line.accountCode, 10);
    const taxType = providerTrimmedString(line.taxType, 100);
    const itemCode = line.itemCode === undefined ? undefined : providerTrimmedString(line.itemCode, 30);
    const trackingOptionIds = providerTracking(line.tracking);
    if (
      !description || quantity === undefined || unitAmount === undefined ||
      lineAmount === undefined || discountRate === undefined || discountAmount === undefined ||
      Math.abs(discountRate) > 1e-7 || Math.abs(discountAmount) > 1e-7 ||
      Math.abs(lineAmount - quantity * unitAmount) > 0.011 ||
      !accountCode || !taxType ||
      (line.itemCode !== undefined && !itemCode) || !trackingOptionIds
    ) {
      return undefined;
    }
    lines.push({
      description,
      quantity,
      unit_amount: unitAmount,
      account_code: accountCode,
      tax_type: taxType,
      ...(itemCode ? { item_code: itemCode } : {}),
      tracking_option_ids: trackingOptionIds,
    });
    lineAmountValues.push(lineAmount.toFixed(4));
  }
  const observedCount = lineAmountValues.filter((value) => value !== null).length;
  return {
    lines,
    lineAmountEvidence: {
      verificationRole: "NON_CANONICAL_EVIDENCE",
      values: lineAmountValues,
      observedCount,
      missingCount: lineAmountValues.length - observedCount,
      amountsMatchEntered: true,
    },
  };
}

function providerTotals(
  record: ProviderRecord,
  lineAmountType: PrepareQuoteDraftInput["line_amount_type"],
  lineAmountEvidence: ProviderLineAmountEvidence,
): ProviderTotalsEvidence | undefined {
  const subTotal = providerNumber(record.subTotal);
  const totalTax = providerNumber(record.totalTax);
  const total = providerNumber(record.total);
  if (subTotal === undefined || totalTax === undefined || total === undefined) return undefined;
  if (subTotal < 0 || totalTax < 0 || total < 0 || Math.abs(subTotal + totalTax - total) > 0.021) return undefined;
  const lineTotal = lineAmountEvidence.values.reduce(
    (sum, value) => sum + (value === null ? Number.NaN : Number(value)),
    0,
  );
  if (!Number.isFinite(lineTotal)) return undefined;
  const lineBasis = lineAmountType === "Inclusive" ? total : subTotal;
  if (Math.abs(lineBasis - lineTotal) > 0.021) return undefined;
  return {
    subTotal: subTotal.toFixed(4),
    totalTax: totalTax.toFixed(4),
    total: total.toFixed(4),
    arithmeticVerified: true,
    lineBasisVerified: true,
  };
}

function quoteLineAmountType(value: unknown): PrepareQuoteDraftInput["line_amount_type"] | undefined {
  if (value === "EXCLUSIVE") return "Exclusive";
  if (value === "INCLUSIVE") return "Inclusive";
  if (value === "NOTAX") return "NoTax";
  return undefined;
}

function purchaseOrderLineAmountType(value: unknown): PrepareQuoteDraftInput["line_amount_type"] | undefined {
  if (value === "Exclusive") return "Exclusive";
  if (value === "Inclusive") return "Inclusive";
  if (value === "NoTax") return "NoTax";
  return undefined;
}

export function mapQuoteDraftReadback(
  input: unknown,
): DraftReadbackMappingResult<QuoteDraftReadbackSnapshot> {
  try {
    const quote = providerRecord(input);
    const quoteId = providerUuid(quote?.quoteID);
    const contact = providerRecord(quote?.contact);
    const contactId = providerUuid(contact?.contactID);
    const quoteDate = providerTrimmedString(quote?.date, 10);
    const expiryDate = providerTrimmedString(quote?.expiryDate, 10);
    const currency = providerTrimmedString(quote?.currencyCode, 3);
    const reference = providerTrimmedString(quote?.reference, 255);
    const lineAmountType = quoteLineAmountType(quote?.lineAmountTypes);
    const mappedLines = providerLines(quote?.lineItems);
    const totals = quote && lineAmountType && mappedLines
      ? providerTotals(quote, lineAmountType, mappedLines.lineAmountEvidence)
      : undefined;
    if (
      !quote || !providerHasNoValidationErrors(quote) || quote.status !== "DRAFT" || !quoteId || !contactId ||
      !quoteDate || !expiryDate || !currency || !reference || !lineAmountType || !mappedLines || !totals
    ) {
      return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
    }
    const canonicalPayload = buildQuoteDraftPrimitive({
      source_ref: `xero-readback://quote/${quoteId}`,
      source_unit_key: "exact-readback:quote",
      contact_id: contactId,
      quote_date: quoteDate,
      expiry_date: expiryDate,
      currency,
      reference,
      line_amount_type: lineAmountType,
      lines: mappedLines.lines,
    }).canonicalPayload;
    return {
      ok: true,
      snapshot: {
        objectType: "QUOTE",
        quoteId,
        canonicalPayload,
        providerTotalsVerified: true,
        providerTotalsEvidence: totals,
        providerLineAmountEvidence: mappedLines.lineAmountEvidence,
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
  }
}

export function mapPurchaseOrderDraftReadback(
  input: unknown,
): DraftReadbackMappingResult<PurchaseOrderDraftReadbackSnapshot> {
  try {
    const purchaseOrder = providerRecord(input);
    const purchaseOrderId = providerUuid(purchaseOrder?.purchaseOrderID);
    const contact = providerRecord(purchaseOrder?.contact);
    const contactId = providerUuid(contact?.contactID);
    const purchaseOrderDate = providerTrimmedString(purchaseOrder?.date, 10);
    const expectedArrivalDate = purchaseOrder?.expectedArrivalDate === undefined
      ? undefined
      : providerTrimmedString(purchaseOrder.expectedArrivalDate, 10);
    const deliveryDate = purchaseOrder?.deliveryDate === undefined
      ? undefined
      : providerTrimmedString(purchaseOrder.deliveryDate, 10);
    const currency = providerTrimmedString(purchaseOrder?.currencyCode, 3);
    const reference = providerTrimmedString(purchaseOrder?.reference, 255);
    const lineAmountType = purchaseOrderLineAmountType(purchaseOrder?.lineAmountTypes);
    const mappedLines = providerLines(purchaseOrder?.lineItems);
    const totals = purchaseOrder && lineAmountType && mappedLines
      ? providerTotals(purchaseOrder, lineAmountType, mappedLines.lineAmountEvidence)
      : undefined;
    if (
      !purchaseOrder || !providerHasNoValidationErrors(purchaseOrder) || purchaseOrder.status !== "DRAFT" ||
      (purchaseOrder.sentToContact !== undefined && purchaseOrder.sentToContact !== false) ||
      !purchaseOrderId || !contactId || !purchaseOrderDate || !currency || !reference ||
      !lineAmountType || !mappedLines || !totals ||
      (purchaseOrder.expectedArrivalDate !== undefined && !expectedArrivalDate) ||
      (purchaseOrder.deliveryDate !== undefined && !deliveryDate)
    ) {
      return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
    }
    const canonicalPayload = buildPurchaseOrderDraftPrimitive({
      source_ref: `xero-readback://purchase-order/${purchaseOrderId}`,
      source_unit_key: "exact-readback:purchase-order",
      contact_id: contactId,
      purchase_order_date: purchaseOrderDate,
      ...(expectedArrivalDate ? { expected_arrival_date: expectedArrivalDate } : {}),
      ...(deliveryDate ? { delivery_date: deliveryDate } : {}),
      currency,
      reference,
      line_amount_type: lineAmountType,
      lines: mappedLines.lines,
    }).canonicalPayload;
    return {
      ok: true,
      snapshot: {
        objectType: "PURCHASE_ORDER",
        purchaseOrderId,
        canonicalPayload,
        providerTotalsVerified: true,
        providerTotalsEvidence: totals,
        providerLineAmountEvidence: mappedLines.lineAmountEvidence,
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
  }
}

export function verifyQuoteDraftReadback(
  expectedQuoteId: string,
  expectedCanonical: unknown,
  readback: unknown,
): DraftReadbackVerificationResult<QuoteDraftReadbackSnapshot, CanonicalQuoteDraftPayload> {
  if (!providerUuid(expectedQuoteId)) return { ok: false, reasons: ["EXPECTED_OBJECT_ID_INVALID"] };
  let expected: CanonicalQuoteDraftPayload;
  try {
    expected = parseCanonicalQuoteDraftPayload(expectedCanonical);
  } catch {
    return { ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] };
  }
  const mapped = mapQuoteDraftReadback(readback);
  if (!mapped.ok) return { ok: false, reasons: [mapped.reason] };
  const reasons: Array<"XERO_OBJECT_ID_MISMATCH" | "CANONICAL_PAYLOAD_MISMATCH"> = [];
  if (mapped.snapshot.quoteId !== expectedQuoteId.toLowerCase()) reasons.push("XERO_OBJECT_ID_MISMATCH");
  const readbackCanonicalPayloadHash = hashObject(mapped.snapshot.canonicalPayload);
  if (readbackCanonicalPayloadHash !== hashObject(expected)) reasons.push("CANONICAL_PAYLOAD_MISMATCH");
  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      ...(reasons.includes("CANONICAL_PAYLOAD_MISMATCH") ? {
        snapshot: mapped.snapshot,
        readbackCanonicalPayload: mapped.snapshot.canonicalPayload,
      } : {}),
    };
  }
  return {
    ok: true,
    snapshot: mapped.snapshot,
    readbackCanonicalPayload: mapped.snapshot.canonicalPayload,
    readbackCanonicalPayloadHash,
  };
}

export function verifyPurchaseOrderDraftReadback(
  expectedPurchaseOrderId: string,
  expectedCanonical: unknown,
  readback: unknown,
): DraftReadbackVerificationResult<PurchaseOrderDraftReadbackSnapshot, CanonicalPurchaseOrderDraftPayload> {
  if (!providerUuid(expectedPurchaseOrderId)) return { ok: false, reasons: ["EXPECTED_OBJECT_ID_INVALID"] };
  let expected: CanonicalPurchaseOrderDraftPayload;
  try {
    expected = parseCanonicalPurchaseOrderDraftPayload(expectedCanonical);
  } catch {
    return { ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] };
  }
  const mapped = mapPurchaseOrderDraftReadback(readback);
  if (!mapped.ok) return { ok: false, reasons: [mapped.reason] };
  const reasons: Array<"XERO_OBJECT_ID_MISMATCH" | "CANONICAL_PAYLOAD_MISMATCH"> = [];
  if (mapped.snapshot.purchaseOrderId !== expectedPurchaseOrderId.toLowerCase()) reasons.push("XERO_OBJECT_ID_MISMATCH");
  const readbackCanonicalPayloadHash = hashObject(mapped.snapshot.canonicalPayload);
  if (readbackCanonicalPayloadHash !== hashObject(expected)) reasons.push("CANONICAL_PAYLOAD_MISMATCH");
  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      ...(reasons.includes("CANONICAL_PAYLOAD_MISMATCH") ? {
        snapshot: mapped.snapshot,
        readbackCanonicalPayload: mapped.snapshot.canonicalPayload,
      } : {}),
    };
  }
  return {
    ok: true,
    snapshot: mapped.snapshot,
    readbackCanonicalPayload: mapped.snapshot.canonicalPayload,
    readbackCanonicalPayloadHash,
  };
}
