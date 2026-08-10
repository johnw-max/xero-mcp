import { CurrencyCode } from "xero-node";
import { z } from "zod/v4";
import { hashObject } from "../security/hash.js";

const MONEY_SCALE = 10_000n;

const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");

const xeroId = z.string().uuid().transform((value) => value.toLowerCase());
const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeCompactText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), "must not contain control characters")
  .transform((value) => value.replace(/\s+/gu, " "));
const canonicalCompactText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value === value.trim(), "must already be trimmed")
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), "must not contain control characters")
  .refine((value) => !/\s{2,}/u.test(value), "must already use canonical whitespace");
const sourceUnitKey = safeCompactText(255);
const accountCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/);
const taxType = z.string().trim().regex(/^[A-Z0-9][A-Z0-9._:-]{0,99}$/);
const itemCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,29}$/);
const trackingOptionIds = z.array(xeroId)
  .max(2)
  .refine((values) => new Set(values).size === values.length, "must not contain duplicates");

const supportedCurrencies = new Set<string>(Object.values(CurrencyCode).map(String));
const currency = z.string().regex(/^[A-Z]{3}$/).refine(
  (value) => supportedCurrencies.has(value),
  "must be supported by the Xero SDK",
);

function atMostFourDecimalPlaces(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7;
}

const fourDecimalNonNegative = z.number().finite().min(0).max(1_000_000_000).refine(
  atMostFourDecimalPlaces,
  "must have at most four decimal places",
);
const fourDecimalPositive = fourDecimalNonNegative.refine((value) => value > 0, "must be greater than zero");
const fourDecimalSignedNonZero = z.number().finite().min(-900_000_000_000).max(900_000_000_000)
  .refine(atMostFourDecimalPlaces, "must have at most four decimal places")
  .refine((value) => value !== 0, "must not be zero");

const creditNoteLineSchema = z.object({
  description: safeCompactText(4_000),
  quantity: fourDecimalPositive.max(1_000_000),
  unit_amount: fourDecimalNonNegative,
  account_id: xeroId,
  account_code: accountCode,
  tax_type: taxType,
  item_code: itemCode.optional(),
  tracking_option_ids: trackingOptionIds.optional(),
}).strict().refine((value) => value.quantity * value.unit_amount <= 900_000_000_000, {
  message: "entered line amount exceeds the controlled draft limit",
  path: ["unit_amount"],
});

const manualJournalLineSchema = z.object({
  account_id: xeroId,
  account_code: accountCode,
  description: safeCompactText(4_000),
  line_amount: fourDecimalSignedNonZero,
  tracking_option_ids: trackingOptionIds.optional(),
}).strict();

export const prepareCreditNoteDraftInputSchema = z.object({
  source_ref: safeCompactText(512),
  source_sha256: sourceSha256.optional(),
  source_unit_key: sourceUnitKey,
  reason: safeCompactText(255),
  credit_note_type: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  contact_id: xeroId,
  credit_note_date: realDate,
  currency,
  reference: safeCompactText(255),
  line_amount_type: z.enum(["Exclusive", "Inclusive", "NoTax"]),
  lines: z.array(creditNoteLineSchema).min(1).max(20),
}).strict();

export const prepareManualJournalDraftInputSchema = z.object({
  source_ref: safeCompactText(512),
  source_sha256: sourceSha256.optional(),
  source_unit_key: sourceUnitKey,
  journal_date: realDate,
  narration: safeCompactText(255),
  lines: z.array(manualJournalLineSchema).min(2).max(50),
}).strict().superRefine((value, context) => {
  const amounts = value.lines.map((line) => scaledDecimal(line.line_amount));
  if (!amounts.some((amount) => amount > 0n) || !amounts.some((amount) => amount < 0n)) {
    context.addIssue({
      code: "custom",
      path: ["lines"],
      message: "manual journal must contain at least one debit and one credit",
    });
  }
  if (amounts.reduce((sum, amount) => sum + amount, 0n) !== 0n) {
    context.addIssue({
      code: "custom",
      path: ["lines"],
      message: "manual journal line amounts must balance exactly to zero",
    });
  }
});

export type PrepareCreditNoteDraftInput = z.infer<typeof prepareCreditNoteDraftInputSchema>;
export type PrepareManualJournalDraftInput = z.infer<typeof prepareManualJournalDraftInputSchema>;
export type CanonicalDraftLineAmountType = "EXCLUSIVE" | "INCLUSIVE" | "NO_TAX";

export interface CanonicalCreditNoteDraftLine {
  description: string;
  quantity: string;
  unitAmount: string;
  enteredLineAmount: string;
  accountId: string;
  accountCode: string;
  taxType: string;
  itemCode?: string;
  trackingOptionIds: string[];
}

export interface CanonicalCreditNoteDraftPayload {
  schemaVersion: "xero-controlled-draft:v1";
  objectType: "CREDIT_NOTE";
  operation: "CREATE_DRAFT";
  status: "DRAFT";
  creditNoteType: "ACCRECCREDIT" | "ACCPAYCREDIT";
  contactId: string;
  creditNoteDate: string;
  currency: string;
  reference: string;
  lineAmountType: CanonicalDraftLineAmountType;
  lines: CanonicalCreditNoteDraftLine[];
  enteredLineSubtotal: string;
}

export interface CanonicalManualJournalDraftLine {
  accountId: string;
  accountCode: string;
  description: string;
  lineAmount: string;
  taxType: "NONE";
  trackingOptionIds: string[];
}

export interface CanonicalManualJournalDraftPayload {
  schemaVersion: "xero-controlled-draft:v1";
  objectType: "MANUAL_JOURNAL";
  operation: "CREATE_DRAFT";
  status: "DRAFT";
  journalDate: string;
  narration: string;
  lineAmountType: "NO_TAX";
  showOnCashBasisReports: false;
  lines: CanonicalManualJournalDraftLine[];
  debitTotal: string;
  creditTotal: string;
  netAmount: "0.0000";
}

export interface PreparedCreditNoteDraft {
  objectType: "CREDIT_NOTE";
  operation: "CREATE_DRAFT";
  sourceRef: string;
  sourceSha256: string;
  sourceUnitKey: string;
  sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" | "SERVER_FINGERPRINTED_EXTRACTION";
  reason: string;
  canonicalPayload: CanonicalCreditNoteDraftPayload;
  canonicalPayloadHash: string;
  confirmationSummaryHash: string;
  confirmationPhrase: string;
}

export interface PreparedManualJournalDraft {
  objectType: "MANUAL_JOURNAL";
  operation: "CREATE_DRAFT";
  sourceRef: string;
  sourceSha256: string;
  sourceUnitKey: string;
  sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" | "SERVER_FINGERPRINTED_EXTRACTION";
  canonicalPayload: CanonicalManualJournalDraftPayload;
  canonicalPayloadHash: string;
  confirmationSummaryHash: string;
  confirmationPhrase: string;
}

const fixedFourUnsigned = z.string().regex(/^\d{1,18}\.\d{4}$/);
const fixedFourSigned = z.string().regex(/^-?\d{1,18}\.\d{4}$/).refine((value) => value !== "-0.0000");
const boundedFixedFourUnsigned = (minimum: bigint, maximum: bigint) => fixedFourUnsigned.refine((value) => {
  const scaled = BigInt(value.replace(".", ""));
  return scaled >= minimum && scaled <= maximum;
}, "is outside the controlled draft range");
const boundedFixedFourSigned = (minimum: bigint, maximum: bigint) => fixedFourSigned.refine((value) => {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const scaled = BigInt(unsigned.replace(".", "")) * (negative ? -1n : 1n);
  return scaled >= minimum && scaled <= maximum;
}, "is outside the controlled draft range");
const canonicalQuantity = boundedFixedFourUnsigned(1n, 10_000_000_000n);
const canonicalUnitAmount = boundedFixedFourUnsigned(0n, 10_000_000_000_000n);
const canonicalDocumentAmount = boundedFixedFourUnsigned(0n, 9_000_000_000_000_000n);
const canonicalSignedJournalAmount = boundedFixedFourSigned(
  -9_000_000_000_000_000n,
  9_000_000_000_000_000n,
).refine((value) => value !== "0.0000", "must not be zero");

const canonicalCreditNoteLineSchema = z.object({
  description: canonicalCompactText(4_000),
  quantity: canonicalQuantity,
  unitAmount: canonicalUnitAmount,
  enteredLineAmount: canonicalDocumentAmount,
  accountId: xeroId,
  accountCode,
  taxType,
  itemCode: itemCode.optional(),
  trackingOptionIds,
}).strict();

const canonicalManualJournalLineSchema = z.object({
  accountId: xeroId,
  accountCode,
  description: canonicalCompactText(4_000),
  lineAmount: canonicalSignedJournalAmount,
  taxType: z.literal("NONE"),
  trackingOptionIds,
}).strict();

function parseFixedFour(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const scaled = BigInt(unsigned.replace(".", ""));
  return negative ? -scaled : scaled;
}

function creditAmountsAreConsistent(value: {
  lines: Array<{ quantity: string; unitAmount: string; enteredLineAmount: string }>;
  enteredLineSubtotal: string;
}): boolean {
  let total = 0n;
  for (const line of value.lines) {
    const product = roundedProduct(parseFixedFour(line.quantity), parseFixedFour(line.unitAmount));
    if (product !== parseFixedFour(line.enteredLineAmount)) return false;
    total += product;
  }
  return total === parseFixedFour(value.enteredLineSubtotal);
}

function journalAmountsAreConsistent(value: {
  lines: Array<{ lineAmount: string; taxType: "NONE" }>;
  debitTotal: string;
  creditTotal: string;
  netAmount: string;
}): boolean {
  let debits = 0n;
  let credits = 0n;
  let net = 0n;
  for (const line of value.lines) {
    const amount = parseFixedFour(line.lineAmount);
    if (amount === 0n || line.taxType !== "NONE") return false;
    net += amount;
    if (amount > 0n) debits += amount;
    if (amount < 0n) credits += -amount;
  }
  return net === 0n && parseFixedFour(value.netAmount) === 0n &&
    debits === parseFixedFour(value.debitTotal) && credits === parseFixedFour(value.creditTotal);
}

export const canonicalCreditNoteDraftPayloadSchema = z.object({
  schemaVersion: z.literal("xero-controlled-draft:v1"),
  objectType: z.literal("CREDIT_NOTE"),
  operation: z.literal("CREATE_DRAFT"),
  status: z.literal("DRAFT"),
  creditNoteType: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  contactId: xeroId,
  creditNoteDate: realDate,
  currency,
  reference: canonicalCompactText(255),
  lineAmountType: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]),
  lines: z.array(canonicalCreditNoteLineSchema).min(1).max(20),
  enteredLineSubtotal: canonicalDocumentAmount,
}).strict().refine(creditAmountsAreConsistent, {
  path: ["enteredLineSubtotal"],
  message: "canonical line amounts and subtotal must be internally consistent",
});

export const canonicalManualJournalDraftPayloadSchema = z.object({
  schemaVersion: z.literal("xero-controlled-draft:v1"),
  objectType: z.literal("MANUAL_JOURNAL"),
  operation: z.literal("CREATE_DRAFT"),
  status: z.literal("DRAFT"),
  journalDate: realDate,
  narration: canonicalCompactText(255),
  lineAmountType: z.literal("NO_TAX"),
  showOnCashBasisReports: z.literal(false),
  lines: z.array(canonicalManualJournalLineSchema).min(2).max(50),
  debitTotal: canonicalDocumentAmount,
  creditTotal: canonicalDocumentAmount,
  netAmount: z.literal("0.0000"),
}).strict().refine(journalAmountsAreConsistent, {
  path: ["netAmount"],
  message: "canonical journal lines must remain exactly balanced",
});

export function parseCanonicalCreditNoteDraftPayload(input: unknown): CanonicalCreditNoteDraftPayload {
  const parsed = canonicalCreditNoteDraftPayloadSchema.parse(input);
  return {
    ...parsed,
    lines: parsed.lines.map(({ itemCode: candidateItemCode, ...line }) => ({
      ...line,
      ...(candidateItemCode ? { itemCode: candidateItemCode } : {}),
    })),
  };
}

export function parseCanonicalManualJournalDraftPayload(input: unknown): CanonicalManualJournalDraftPayload {
  return canonicalManualJournalDraftPayloadSchema.parse(input);
}

function scaledDecimal(value: number): bigint {
  return BigInt(Math.round(value * Number(MONEY_SCALE)));
}

function roundedProduct(quantity: bigint, unitAmount: bigint): bigint {
  return (quantity * unitAmount + MONEY_SCALE / 2n) / MONEY_SCALE;
}

function fixedFour(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

const LINE_AMOUNT_TYPE_CANONICAL: Readonly<
  Record<PrepareCreditNoteDraftInput["line_amount_type"], CanonicalDraftLineAmountType>
> = {
  Exclusive: "EXCLUSIVE",
  Inclusive: "INCLUSIVE",
  NoTax: "NO_TAX",
};

function preparedSource(
  sourceRefValue: string,
  sourceSha256Value: string | undefined,
  sourceUnitKeyValue: string,
  canonicalPayload: unknown,
  extraIntent?: unknown,
): {
  sourceSha256: string;
  sourceEvidenceType: PreparedCreditNoteDraft["sourceEvidenceType"];
} {
  return sourceSha256Value
    ? { sourceSha256: sourceSha256Value, sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" }
    : {
        sourceSha256: hashObject({
          sourceRef: sourceRefValue,
          sourceUnitKey: sourceUnitKeyValue,
          canonicalExtraction: canonicalPayload,
          ...(extraIntent === undefined ? {} : { extraIntent }),
        }),
        sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      };
}

export function buildCreditNoteDraftPrimitive(input: unknown): PreparedCreditNoteDraft {
  const value = prepareCreditNoteDraftInputSchema.parse(input);
  let subtotal = 0n;
  const lines: CanonicalCreditNoteDraftLine[] = value.lines.map((line) => {
    const quantity = scaledDecimal(line.quantity);
    const unitAmount = scaledDecimal(line.unit_amount);
    const enteredLineAmount = roundedProduct(quantity, unitAmount);
    subtotal += enteredLineAmount;
    return {
      description: line.description,
      quantity: fixedFour(quantity),
      unitAmount: fixedFour(unitAmount),
      enteredLineAmount: fixedFour(enteredLineAmount),
      accountId: line.account_id,
      accountCode: line.account_code,
      taxType: line.tax_type,
      ...(line.item_code ? { itemCode: line.item_code } : {}),
      trackingOptionIds: [...(line.tracking_option_ids ?? [])].sort(),
    };
  });
  const canonicalPayload: CanonicalCreditNoteDraftPayload = {
    schemaVersion: "xero-controlled-draft:v1",
    objectType: "CREDIT_NOTE",
    operation: "CREATE_DRAFT",
    status: "DRAFT",
    creditNoteType: value.credit_note_type,
    contactId: value.contact_id,
    creditNoteDate: value.credit_note_date,
    currency: value.currency,
    reference: value.reference,
    lineAmountType: LINE_AMOUNT_TYPE_CANONICAL[value.line_amount_type],
    lines,
    enteredLineSubtotal: fixedFour(subtotal),
  };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const source = preparedSource(
    value.source_ref,
    value.source_sha256,
    value.source_unit_key,
    canonicalPayload,
    { reason: value.reason },
  );
  const confirmationSummaryHash = hashObject({
    objectType: canonicalPayload.objectType,
    sourceUnitKey: value.source_unit_key,
    reasonHash: hashObject({ reason: value.reason }),
    sourceSha256: source.sourceSha256,
    sourceRefHash: hashObject({ sourceRef: value.source_ref }),
    canonicalPayloadHash,
  });
  const displayType = value.credit_note_type === "ACCRECCREDIT" ? "Customer Credit Note" : "Supplier Credit Note";
  return {
    objectType: "CREDIT_NOTE",
    operation: "CREATE_DRAFT",
    sourceRef: value.source_ref,
    sourceSha256: source.sourceSha256,
    sourceUnitKey: value.source_unit_key,
    sourceEvidenceType: source.sourceEvidenceType,
    reason: value.reason,
    canonicalPayload,
    canonicalPayloadHash,
    confirmationSummaryHash,
    confirmationPhrase: `确认创建 ${displayType} 草稿｜联系人 ${value.contact_id.slice(0, 8)}…｜日期 ${value.credit_note_date}｜录入行合计 ${value.currency} ${fixedFour(subtotal)}｜${canonicalPayload.lineAmountType}｜原因 ${value.reason.slice(0, 32)}｜来源 ${source.sourceSha256.slice(0, 8).toUpperCase()}｜校验 ${canonicalPayloadHash.slice(0, 10).toUpperCase()}`,
  };
}

export function buildManualJournalDraftPrimitive(input: unknown): PreparedManualJournalDraft {
  const value = prepareManualJournalDraftInputSchema.parse(input);
  let debits = 0n;
  let credits = 0n;
  const lines: CanonicalManualJournalDraftLine[] = value.lines.map((line) => {
    const amount = scaledDecimal(line.line_amount);
    if (amount > 0n) debits += amount;
    if (amount < 0n) credits += -amount;
    return {
      accountId: line.account_id,
      accountCode: line.account_code,
      description: line.description,
      lineAmount: fixedFour(amount),
      taxType: "NONE",
      trackingOptionIds: [...(line.tracking_option_ids ?? [])].sort(),
    };
  });
  const canonicalPayload: CanonicalManualJournalDraftPayload = {
    schemaVersion: "xero-controlled-draft:v1",
    objectType: "MANUAL_JOURNAL",
    operation: "CREATE_DRAFT",
    status: "DRAFT",
    journalDate: value.journal_date,
    narration: value.narration,
    lineAmountType: "NO_TAX",
    showOnCashBasisReports: false,
    lines,
    debitTotal: fixedFour(debits),
    creditTotal: fixedFour(credits),
    netAmount: "0.0000",
  };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const source = preparedSource(
    value.source_ref,
    value.source_sha256,
    value.source_unit_key,
    canonicalPayload,
  );
  const confirmationSummaryHash = hashObject({
    objectType: canonicalPayload.objectType,
    sourceUnitKey: value.source_unit_key,
    sourceSha256: source.sourceSha256,
    sourceRefHash: hashObject({ sourceRef: value.source_ref }),
    canonicalPayloadHash,
  });
  return {
    objectType: "MANUAL_JOURNAL",
    operation: "CREATE_DRAFT",
    sourceRef: value.source_ref,
    sourceSha256: source.sourceSha256,
    sourceUnitKey: value.source_unit_key,
    sourceEvidenceType: source.sourceEvidenceType,
    canonicalPayload,
    canonicalPayloadHash,
    confirmationSummaryHash,
    confirmationPhrase: `确认创建 Manual Journal 草稿｜日期 ${value.journal_date}｜借方 ${fixedFour(debits)}｜贷方 ${fixedFour(credits)}｜NoTax/NONE｜来源 ${source.sourceSha256.slice(0, 8).toUpperCase()}｜校验 ${canonicalPayloadHash.slice(0, 10).toUpperCase()}`,
  };
}
