import { CurrencyCode } from "xero-node";
import { z } from "zod/v4";
import { hashObject } from "../security/hash.js";

const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const xeroId = z.string().uuid().transform((value) => value.toLowerCase());
const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRef = z.string().trim().min(1).max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
  .refine((value) => !/^https?:\/\//i.test(value), "must be an opaque reference, not a URL")
  .refine((value) => !value.includes("?") && !value.includes("#"), "must not contain URL query or fragment data");
const sourceUnitKey = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");
const supportedCurrencies = new Set<string>(Object.values(CurrencyCode).map(String));
const currency = z.string().regex(/^[A-Z]{3}$/).refine(
  (value) => supportedCurrencies.has(value),
  "must be supported by the Xero SDK",
);

const fourDecimalNonNegative = z.number().min(0).refine(
  (value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7,
  "must have at most four decimal places",
);

const fourDecimalPositive = fourDecimalNonNegative.refine((value) => value > 0, "must be greater than zero");

const draftLineSchema = z.object({
  description: z.string().trim().min(1).max(4_000),
  quantity: fourDecimalPositive.max(1_000_000),
  unit_amount: fourDecimalNonNegative.max(1_000_000_000),
  account_code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/),
  tax_type: z.string().trim().regex(/^[A-Z0-9][A-Z0-9._:-]{0,99}$/),
  item_code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,29}$/).optional(),
  tracking_option_ids: z.array(xeroId)
    .max(2)
    .refine((values) => new Set(values).size === values.length, "must not contain duplicates")
    .optional(),
}).strict().refine((value) => value.quantity * value.unit_amount <= 1_000_000_000_000, {
  message: "entered line amount exceeds the controlled draft limit",
  path: ["unit_amount"],
});

const commonDraftFields = {
  source_ref: sourceRef,
  source_unit_key: sourceUnitKey,
  source_sha256: sourceSha256.optional(),
  contact_id: xeroId,
  currency,
  reference: z.string().trim().min(1).max(255),
  line_amount_type: z.enum(["Exclusive", "Inclusive", "NoTax"]),
  lines: z.array(draftLineSchema).min(1).max(20),
};

export const prepareQuoteDraftInputSchema = z.object({
  ...commonDraftFields,
  quote_date: realDate,
  expiry_date: realDate,
}).strict().refine((value) => value.expiry_date >= value.quote_date, {
  message: "expiry_date must not be before quote_date",
  path: ["expiry_date"],
});

export const preparePurchaseOrderDraftInputSchema = z.object({
  ...commonDraftFields,
  purchase_order_date: realDate,
  expected_arrival_date: realDate.optional(),
  delivery_date: realDate.optional(),
}).strict().refine(
  (value) => !value.expected_arrival_date || value.expected_arrival_date >= value.purchase_order_date,
  {
    message: "expected_arrival_date must not be before purchase_order_date",
    path: ["expected_arrival_date"],
  },
).refine((value) => !value.delivery_date || value.delivery_date >= value.purchase_order_date, {
  message: "delivery_date must not be before purchase_order_date",
  path: ["delivery_date"],
});

export type PrepareQuoteDraftInput = z.infer<typeof prepareQuoteDraftInputSchema>;
export type PreparePurchaseOrderDraftInput = z.infer<typeof preparePurchaseOrderDraftInputSchema>;

export type CanonicalLineAmountType = "EXCLUSIVE" | "INCLUSIVE" | "NO_TAX";

export interface CanonicalControlledDraftLine {
  description: string;
  quantity: string;
  unitAmount: string;
  enteredLineSubtotal: string;
  accountCode: string;
  taxType: string;
  itemCode?: string;
  trackingOptionIds: string[];
}

interface CanonicalControlledDraftBase {
  schemaVersion: "xero-controlled-draft:v1";
  operation: "CREATE_DRAFT";
  status: "DRAFT";
  contactId: string;
  currency: string;
  reference: string;
  lineAmountType: CanonicalLineAmountType;
  lines: CanonicalControlledDraftLine[];
  enteredLineSubtotal: string;
}

export interface CanonicalQuoteDraftPayload extends CanonicalControlledDraftBase {
  objectType: "QUOTE";
  quoteDate: string;
  expiryDate: string;
}

export interface CanonicalPurchaseOrderDraftPayload extends CanonicalControlledDraftBase {
  objectType: "PURCHASE_ORDER";
  purchaseOrderDate: string;
  expectedArrivalDate?: string;
  deliveryDate?: string;
}

export interface PreparedControlledDraft<TCanonical> {
  objectType: "QUOTE" | "PURCHASE_ORDER";
  operation: "CREATE_DRAFT";
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" | "SERVER_FINGERPRINTED_EXTRACTION";
  canonicalPayload: TCanonical;
  canonicalPayloadHash: string;
  confirmationSummaryHash: string;
  /** The only human-facing confirmation artifact produced by this primitive. */
  confirmationPhrase: string;
}

const fixedFourString = z.string().regex(/^\d{1,16}\.\d{4}$/);
const boundedFixedFourString = (minimum: bigint, maximum: bigint) => fixedFourString.refine((value) => {
  const scaled = BigInt(value.replace(".", ""));
  return scaled >= minimum && scaled <= maximum;
}, "is outside the controlled draft range");
const canonicalQuantity = boundedFixedFourString(1n, 10_000_000_000n);
const canonicalUnitAmount = boundedFixedFourString(0n, 10_000_000_000_000n);
const canonicalLineSubtotal = boundedFixedFourString(0n, 10_000_000_000_000_000n);
const canonicalDocumentLineSubtotal = boundedFixedFourString(0n, 200_000_000_000_000_000n);
const canonicalLineSchema = z.object({
  description: z.string().min(1).max(4_000).refine((value) => value === value.trim()),
  quantity: canonicalQuantity,
  unitAmount: canonicalUnitAmount,
  enteredLineSubtotal: canonicalLineSubtotal,
  accountCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/),
  taxType: z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,99}$/),
  itemCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,29}$/).optional(),
  trackingOptionIds: z.array(xeroId)
    .max(2)
    .refine((values) => new Set(values).size === values.length, "must not contain duplicates"),
}).strict();

const canonicalBaseShape = {
  schemaVersion: z.literal("xero-controlled-draft:v1"),
  operation: z.literal("CREATE_DRAFT"),
  status: z.literal("DRAFT"),
  contactId: xeroId,
  currency,
  reference: z.string().min(1).max(255).refine((value) => value === value.trim()),
  lineAmountType: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]),
  lines: z.array(canonicalLineSchema).min(1).max(20),
  enteredLineSubtotal: canonicalDocumentLineSubtotal,
};

const LINE_AMOUNT_TYPE_CANONICAL: Readonly<Record<PrepareQuoteDraftInput["line_amount_type"], CanonicalLineAmountType>> = {
  Exclusive: "EXCLUSIVE",
  Inclusive: "INCLUSIVE",
  NoTax: "NO_TAX",
};

const MONEY_SCALE = 10_000n;

function scaledDecimal(value: number): bigint {
  return BigInt(Math.round(value * Number(MONEY_SCALE)));
}

function enteredLineSubtotal(quantity: number, unitAmount: number): bigint {
  const product = scaledDecimal(quantity) * scaledDecimal(unitAmount);
  return (product + MONEY_SCALE / 2n) / MONEY_SCALE;
}

function fixedFour(value: bigint): string {
  const whole = value / MONEY_SCALE;
  const fraction = (value % MONEY_SCALE).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

function parseFixedFour(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function canonicalAmountsAreConsistent(value: {
  lines: Array<{ quantity: string; unitAmount: string; enteredLineSubtotal: string }>;
  enteredLineSubtotal: string;
}): boolean {
  let total = 0n;
  for (const line of value.lines) {
    const amount = (parseFixedFour(line.quantity) * parseFixedFour(line.unitAmount) + MONEY_SCALE / 2n)
      / MONEY_SCALE;
    if (amount !== parseFixedFour(line.enteredLineSubtotal)) return false;
    total += amount;
  }
  return total === parseFixedFour(value.enteredLineSubtotal);
}

export const canonicalQuoteDraftPayloadSchema = z.object({
  ...canonicalBaseShape,
  objectType: z.literal("QUOTE"),
  quoteDate: realDate,
  expiryDate: realDate,
}).strict().refine((value) => value.expiryDate >= value.quoteDate, {
  message: "expiryDate must not be before quoteDate",
  path: ["expiryDate"],
}).refine(canonicalAmountsAreConsistent, {
  message: "canonical line amounts and total must be internally consistent",
  path: ["enteredLineSubtotal"],
});

export const canonicalPurchaseOrderDraftPayloadSchema = z.object({
  ...canonicalBaseShape,
  objectType: z.literal("PURCHASE_ORDER"),
  purchaseOrderDate: realDate,
  expectedArrivalDate: realDate.optional(),
  deliveryDate: realDate.optional(),
}).strict().refine((value) => !value.deliveryDate || value.deliveryDate >= value.purchaseOrderDate, {
  message: "deliveryDate must not be before purchaseOrderDate",
  path: ["deliveryDate"],
}).refine(
  (value) => !value.expectedArrivalDate || value.expectedArrivalDate >= value.purchaseOrderDate,
  { message: "expectedArrivalDate must not be before purchaseOrderDate", path: ["expectedArrivalDate"] },
).refine(canonicalAmountsAreConsistent, {
  message: "canonical line amounts and total must be internally consistent",
  path: ["enteredLineSubtotal"],
});

export function parseCanonicalQuoteDraftPayload(input: unknown): CanonicalQuoteDraftPayload {
  const value = canonicalQuoteDraftPayloadSchema.parse(input);
  return {
    ...value,
    lines: value.lines.map(({ itemCode, ...line }) => ({
      ...line,
      ...(itemCode ? { itemCode } : {}),
    })),
  };
}

export function parseCanonicalPurchaseOrderDraftPayload(input: unknown): CanonicalPurchaseOrderDraftPayload {
  const value = canonicalPurchaseOrderDraftPayloadSchema.parse(input);
  const { expectedArrivalDate, deliveryDate, lines, ...required } = value;
  return {
    ...required,
    ...(expectedArrivalDate ? { expectedArrivalDate } : {}),
    ...(deliveryDate ? { deliveryDate } : {}),
    lines: lines.map(({ itemCode, ...line }) => ({
      ...line,
      ...(itemCode ? { itemCode } : {}),
    })),
  };
}

function canonicalLines(lines: PrepareQuoteDraftInput["lines"]): {
  lines: CanonicalControlledDraftLine[];
  enteredLineSubtotal: string;
} {
  let total = 0n;
  const canonical = lines.map((line) => {
    const amount = enteredLineSubtotal(line.quantity, line.unit_amount);
    total += amount;
    return {
      description: line.description,
      quantity: fixedFour(scaledDecimal(line.quantity)),
      unitAmount: fixedFour(scaledDecimal(line.unit_amount)),
      enteredLineSubtotal: fixedFour(amount),
      accountCode: line.account_code,
      taxType: line.tax_type,
      ...(line.item_code ? { itemCode: line.item_code } : {}),
      trackingOptionIds: [...(line.tracking_option_ids ?? [])].sort(),
    };
  });
  return { lines: canonical, enteredLineSubtotal: fixedFour(total) };
}

function prepared<TCanonical extends CanonicalQuoteDraftPayload | CanonicalPurchaseOrderDraftPayload>(
  canonicalPayload: TCanonical,
  sourceRef: string,
  sourceUnitKeyValue: string,
  sourceSha256Value: string | undefined,
  displayName: "Quote" | "Purchase Order",
  endDate?: string,
): PreparedControlledDraft<TCanonical> {
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const sourceEvidenceType = sourceSha256Value
    ? "AGENT_ASSERTED_UNVERIFIED" as const
    : "SERVER_FINGERPRINTED_EXTRACTION" as const;
  const effectiveSourceSha256 = sourceSha256Value ?? hashObject({
    sourceRef,
    sourceUnitKey: sourceUnitKeyValue,
    canonicalExtraction: canonicalPayload,
  });
  const confirmationSummaryHash = hashObject({
    objectType: canonicalPayload.objectType,
    contactId: canonicalPayload.contactId,
    startDate: canonicalPayload.objectType === "QUOTE"
      ? canonicalPayload.quoteDate
      : canonicalPayload.purchaseOrderDate,
    endDate,
    currency: canonicalPayload.currency,
    lineAmountType: canonicalPayload.lineAmountType,
    enteredLineSubtotal: canonicalPayload.enteredLineSubtotal,
    canonicalPayloadHash,
    sourceSha256: effectiveSourceSha256,
    sourceRefHash: hashObject({ sourceRef }),
    sourceUnitKey: sourceUnitKeyValue,
  });
  const startDate = canonicalPayload.objectType === "QUOTE"
    ? canonicalPayload.quoteDate
    : canonicalPayload.purchaseOrderDate;
  return {
    objectType: canonicalPayload.objectType,
    operation: "CREATE_DRAFT",
    sourceRef,
    sourceUnitKey: sourceUnitKeyValue,
    sourceSha256: effectiveSourceSha256,
    sourceEvidenceType,
    canonicalPayload,
    canonicalPayloadHash,
    confirmationSummaryHash,
    confirmationPhrase: `确认创建 ${displayName} 草稿｜联系人 ${canonicalPayload.contactId.slice(0, 8)}…｜日期 ${startDate}${endDate ? `→${endDate}` : ""}｜录入行合计 ${canonicalPayload.currency} ${canonicalPayload.enteredLineSubtotal}｜${canonicalPayload.lineAmountType}｜来源 ${effectiveSourceSha256.slice(0, 8).toUpperCase()}｜校验 ${canonicalPayloadHash.slice(0, 10).toUpperCase()}`,
  };
}

export function buildQuoteDraftPrimitive(input: unknown): PreparedControlledDraft<CanonicalQuoteDraftPayload> {
  const value = prepareQuoteDraftInputSchema.parse(input);
  const normalizedLines = canonicalLines(value.lines);
  const canonicalPayload: CanonicalQuoteDraftPayload = {
    schemaVersion: "xero-controlled-draft:v1",
    objectType: "QUOTE",
    operation: "CREATE_DRAFT",
    status: "DRAFT",
    contactId: value.contact_id,
    quoteDate: value.quote_date,
    expiryDate: value.expiry_date,
    currency: value.currency,
    reference: value.reference,
    lineAmountType: LINE_AMOUNT_TYPE_CANONICAL[value.line_amount_type],
    ...normalizedLines,
  };
  return prepared(
    canonicalPayload,
    value.source_ref,
    value.source_unit_key,
    value.source_sha256,
    "Quote",
    value.expiry_date,
  );
}

export function buildPurchaseOrderDraftPrimitive(
  input: unknown,
): PreparedControlledDraft<CanonicalPurchaseOrderDraftPayload> {
  const value = preparePurchaseOrderDraftInputSchema.parse(input);
  const normalizedLines = canonicalLines(value.lines);
  const canonicalPayload: CanonicalPurchaseOrderDraftPayload = {
    schemaVersion: "xero-controlled-draft:v1",
    objectType: "PURCHASE_ORDER",
    operation: "CREATE_DRAFT",
    status: "DRAFT",
    contactId: value.contact_id,
    purchaseOrderDate: value.purchase_order_date,
    ...(value.expected_arrival_date ? { expectedArrivalDate: value.expected_arrival_date } : {}),
    ...(value.delivery_date ? { deliveryDate: value.delivery_date } : {}),
    currency: value.currency,
    reference: value.reference,
    lineAmountType: LINE_AMOUNT_TYPE_CANONICAL[value.line_amount_type],
    ...normalizedLines,
  };
  return prepared(
    canonicalPayload,
    value.source_ref,
    value.source_unit_key,
    value.source_sha256,
    "Purchase Order",
    value.delivery_date ?? value.expected_arrival_date,
  );
}
