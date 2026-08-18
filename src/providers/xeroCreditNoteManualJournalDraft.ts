import {
  CreditNote,
  CurrencyCode,
  LineAmountTypes,
  ManualJournal,
  type CreditNotes,
  type ManualJournals,
} from "xero-node";
import {
  parseCanonicalCreditNoteDraftPayload,
  parseCanonicalManualJournalDraftPayload,
  type CanonicalCreditNoteDraftPayload,
  type CanonicalCreditNoteDraftLine,
  type CanonicalDraftLineAmountType,
  type CanonicalManualJournalDraftPayload,
  type CanonicalManualJournalDraftLine,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import { hashObject } from "../security/hash.js";

const PROVIDER_LINE_AMOUNT_TYPE: Readonly<Record<CanonicalDraftLineAmountType, LineAmountTypes>> = {
  EXCLUSIVE: LineAmountTypes.Exclusive,
  INCLUSIVE: LineAmountTypes.Inclusive,
  NO_TAX: LineAmountTypes.NoTax,
};

function xeroCurrency(value: string): CurrencyCode {
  const code = CurrencyCode[value as keyof typeof CurrencyCode];
  if (!code) throw new Error("Unsupported canonical Xero currency.");
  return code;
}

function creditNoteType(value: "ACCRECCREDIT" | "ACCPAYCREDIT"): CreditNote.TypeEnum {
  return value === "ACCRECCREDIT" ? CreditNote.TypeEnum.ACCRECCREDIT : CreditNote.TypeEnum.ACCPAYCREDIT;
}

function creditLine(line: CanonicalCreditNoteDraftLine) {
  return {
    description: line.description,
    quantity: Number(line.quantity),
    unitAmount: Number(line.unitAmount),
    accountID: line.accountId,
    accountCode: line.accountCode,
    taxType: line.taxType,
    ...(line.itemCode ? { itemCode: line.itemCode } : {}),
    ...(line.trackingOptionIds.length > 0
      ? { tracking: line.trackingOptionIds.map((trackingOptionID) => ({ trackingOptionID })) }
      : {}),
  };
}

function journalLine(line: CanonicalManualJournalDraftLine) {
  return {
    accountID: line.accountId,
    accountCode: line.accountCode,
    description: line.description,
    lineAmount: Number(line.lineAmount),
    taxType: "NONE",
    ...(line.trackingOptionIds.length > 0
      ? { tracking: line.trackingOptionIds.map((trackingOptionID) => ({ trackingOptionID })) }
      : {}),
  };
}

export function toXeroCreditNoteCreatePayload(input: unknown): CreditNotes {
  const value = parseCanonicalCreditNoteDraftPayload(input);
  return {
    creditNotes: [{
      type: creditNoteType(value.creditNoteType),
      contact: { contactID: value.contactId },
      date: value.creditNoteDate,
      status: CreditNote.StatusEnum.DRAFT,
      lineAmountTypes: PROVIDER_LINE_AMOUNT_TYPE[value.lineAmountType],
      currencyCode: xeroCurrency(value.currency),
      ...(value.authoritativeProviderField === "CREDIT_NOTE_NUMBER"
        ? { creditNoteNumber: value.reference }
        : { reference: value.reference }),
      lineItems: value.lines.map(creditLine),
    }],
  };
}

export function toXeroManualJournalCreatePayload(input: unknown): ManualJournals {
  const value = parseCanonicalManualJournalDraftPayload(input);
  return {
    manualJournals: [{
      narration: value.narration,
      date: value.journalDate,
      status: ManualJournal.StatusEnum.DRAFT,
      lineAmountTypes: LineAmountTypes.NoTax,
      showOnCashBasisReports: false,
      journalLines: value.lines.map(journalLine),
    }],
  };
}

type ProviderRecord = Record<string, unknown>;

export interface CreditNoteProviderEconomicsEvidence {
  lineAmounts: string[];
  taxAmounts: string[];
  accountIds: string[];
  accountCodes: string[];
  taxTypes: string[];
  subTotal: string;
  totalTax: string;
  total: string;
  noDiscountsVerified: true;
}

export interface CreditNoteDraftReadbackSnapshot {
  objectType: "CREDIT_NOTE";
  creditNoteId: string;
  canonicalPayload: CanonicalCreditNoteDraftPayload;
  providerEconomicsEvidence: CreditNoteProviderEconomicsEvidence;
}

export interface ManualJournalProviderTaxEvidence {
  taxTypes: "NONE"[];
  taxAmounts: string[];
  allNoneAndZero: true;
}

export interface ManualJournalDraftReadbackSnapshot {
  objectType: "MANUAL_JOURNAL";
  manualJournalId: string;
  canonicalPayload: CanonicalManualJournalDraftPayload;
  providerTaxEvidence: ManualJournalProviderTaxEvidence;
  balanceVerified: true;
}

export type DraftReadbackMappingResult<TSnapshot> =
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; reason: "MALFORMED_PROVIDER_READBACK" };

type DraftVerificationReason =
  | "MALFORMED_PROVIDER_READBACK"
  | "EXPECTED_OBJECT_ID_INVALID"
  | "EXPECTED_CANONICAL_INVALID"
  | "XERO_OBJECT_ID_MISMATCH"
  | "CANONICAL_PAYLOAD_MISMATCH";

export type DraftReadbackVerificationResult<TSnapshot, TCanonical> =
  | {
      ok: true;
      snapshot: TSnapshot;
      readbackCanonicalPayload: TCanonical;
      readbackCanonicalPayloadHash: string;
    }
  | {
      ok: false;
      reasons: DraftVerificationReason[];
      snapshot?: TSnapshot;
      readbackCanonicalPayload?: TCanonical;
    };

const SCALE = 10_000n;
const MAX_SCALED_PROVIDER_AMOUNT = 9_000_000_000_000_000n;

function providerRecord(value: unknown): ProviderRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderRecord
    : undefined;
}

function providerText(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value !== value.trim() || /[\u0000-\u001F\u007F]/u.test(value)
  ) return undefined;
  return value;
}

function providerUuid(value: unknown): string | undefined {
  const candidate = providerText(value, 36);
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

function providerScaledAmount(value: unknown): bigint | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const scaledNumber = value * Number(SCALE);
  if (!Number.isSafeInteger(Math.round(scaledNumber))) return undefined;
  if (Math.abs(scaledNumber - Math.round(scaledNumber)) >= 1e-7) return undefined;
  const scaled = BigInt(Math.round(scaledNumber));
  return scaled >= -MAX_SCALED_PROVIDER_AMOUNT && scaled <= MAX_SCALED_PROVIDER_AMOUNT
    ? scaled
    : undefined;
}

function fixedFour(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(4, "0")}`;
}

function roundedProduct(quantity: bigint, unitAmount: bigint): bigint {
  return (quantity * unitAmount + SCALE / 2n) / SCALE;
}

function absoluteDifference(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function providerHasNoValidationErrors(value: ProviderRecord): boolean {
  if (value.hasErrors !== undefined && value.hasErrors !== false) return false;
  if (value.validationErrors === undefined) return true;
  return Array.isArray(value.validationErrors) && value.validationErrors.length === 0;
}

function absentOrEmptyArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function providerTracking(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const values: string[] = [];
  for (const entry of value) {
    const tracking = providerRecord(entry);
    const trackingOptionId = providerUuid(tracking?.trackingOptionID);
    if (!tracking || !trackingOptionId) return undefined;
    values.push(trackingOptionId);
  }
  if (new Set(values).size !== values.length) return undefined;
  return values.sort();
}

function accountCodeFromProvider(value: unknown): string | undefined {
  const candidate = providerText(value, 10);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/.test(candidate) ? candidate : undefined;
}

function taxTypeFromProvider(value: unknown): string | undefined {
  const candidate = providerText(value, 100);
  return candidate && /^[A-Z0-9][A-Z0-9._:-]{0,99}$/.test(candidate) ? candidate : undefined;
}

function itemCodeFromProvider(value: unknown): string | undefined {
  const candidate = providerText(value, 30);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,29}$/.test(candidate) ? candidate : undefined;
}

function providerCreditLineAmountType(value: unknown): CanonicalDraftLineAmountType | undefined {
  if (value === "Exclusive") return "EXCLUSIVE";
  if (value === "Inclusive") return "INCLUSIVE";
  if (value === "NoTax") return "NO_TAX";
  return undefined;
}

interface MappedCreditLines {
  canonicalLines: CanonicalCreditNoteDraftLine[];
  enteredLineSubtotal: bigint;
  lineAmounts: bigint[];
  taxAmounts: bigint[];
}

function mapCreditLines(value: unknown): MappedCreditLines | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return undefined;
  const canonicalLines: CanonicalCreditNoteDraftLine[] = [];
  const lineAmounts: bigint[] = [];
  const taxAmounts: bigint[] = [];
  let enteredLineSubtotal = 0n;
  for (const entry of value) {
    const line = providerRecord(entry);
    const description = providerText(line?.description, 4_000);
    const quantity = providerScaledAmount(line?.quantity);
    const unitAmount = providerScaledAmount(line?.unitAmount);
    const lineAmount = providerScaledAmount(line?.lineAmount);
    const taxAmount = providerScaledAmount(line?.taxAmount);
    const accountId = providerUuid(line?.accountID);
    const accountCode = accountCodeFromProvider(line?.accountCode);
    const taxType = taxTypeFromProvider(line?.taxType);
    const candidateItemCode = line?.itemCode === undefined ? undefined : itemCodeFromProvider(line.itemCode);
    const trackingOptionIds = providerTracking(line?.tracking);
    const discountRate = line?.discountRate === undefined ? 0n : providerScaledAmount(line.discountRate);
    const discountAmount = line?.discountAmount === undefined ? 0n : providerScaledAmount(line.discountAmount);
    if (
      !line || !description || quantity === undefined || quantity <= 0n || unitAmount === undefined || unitAmount < 0n ||
      lineAmount === undefined || lineAmount < 0n || taxAmount === undefined || taxAmount < 0n ||
      !accountId || !accountCode || !taxType ||
      (line.itemCode !== undefined && !candidateItemCode) || !trackingOptionIds ||
      discountRate !== 0n || discountAmount !== 0n
    ) return undefined;
    const enteredLineAmount = roundedProduct(quantity, unitAmount);
    if (absoluteDifference(lineAmount, enteredLineAmount) > 50n) return undefined;
    enteredLineSubtotal += enteredLineAmount;
    lineAmounts.push(lineAmount);
    taxAmounts.push(taxAmount);
    canonicalLines.push({
      description,
      quantity: fixedFour(quantity),
      unitAmount: fixedFour(unitAmount),
      enteredLineAmount: fixedFour(enteredLineAmount),
      accountId,
      accountCode,
      taxType,
      ...(candidateItemCode ? { itemCode: candidateItemCode } : {}),
      trackingOptionIds,
    });
  }
  return { canonicalLines, enteredLineSubtotal, lineAmounts, taxAmounts };
}

export function mapCreditNoteDraftReadback(
  input: unknown,
  expectedAuthoritativeProviderField: CanonicalCreditNoteDraftPayload["authoritativeProviderField"],
): DraftReadbackMappingResult<CreditNoteDraftReadbackSnapshot> {
  if (
    expectedAuthoritativeProviderField !== "CREDIT_NOTE_NUMBER" &&
    expectedAuthoritativeProviderField !== "REFERENCE"
  ) return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
  try {
    const creditNote = providerRecord(input);
    const creditNoteId = providerUuid(creditNote?.creditNoteID);
    const contact = providerRecord(creditNote?.contact);
    const contactId = providerUuid(contact?.contactID);
    const creditNoteDate = providerText(creditNote?.date, 10);
    const currency = providerText(creditNote?.currencyCode, 3);
    const reference = providerText(
      expectedAuthoritativeProviderField === "CREDIT_NOTE_NUMBER"
        ? creditNote?.creditNoteNumber
        : creditNote?.reference,
      255,
    );
    const lineAmountType = providerCreditLineAmountType(creditNote?.lineAmountTypes);
    const mappedLines = mapCreditLines(creditNote?.lineItems);
    const subTotal = providerScaledAmount(creditNote?.subTotal);
    const totalTax = providerScaledAmount(creditNote?.totalTax);
    const total = providerScaledAmount(creditNote?.total);
    const appliedAmount = creditNote?.appliedAmount === undefined ? 0n : providerScaledAmount(creditNote.appliedAmount);
    const remainingCredit = creditNote?.remainingCredit === undefined
      ? undefined
      : providerScaledAmount(creditNote.remainingCredit);
    if (
      !creditNote || !providerHasNoValidationErrors(creditNote) || !creditNoteId || !contactId ||
      creditNote.status !== "DRAFT" ||
      (creditNote.type !== "ACCRECCREDIT" && creditNote.type !== "ACCPAYCREDIT") ||
      !creditNoteDate || !currency || !reference || !lineAmountType || !mappedLines ||
      subTotal === undefined || subTotal < 0n || totalTax === undefined || totalTax < 0n ||
      total === undefined || total < 0n || appliedAmount !== 0n ||
      (remainingCredit !== undefined && remainingCredit !== total) ||
      (creditNote.sentToContact !== undefined && creditNote.sentToContact !== false) ||
      creditNote.fullyPaidOnDate !== undefined ||
      !absentOrEmptyArray(creditNote.allocations) || !absentOrEmptyArray(creditNote.payments)
    ) return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };

    const lineAmountTotal = mappedLines.lineAmounts.reduce((sum, amount) => sum + amount, 0n);
    const taxAmountTotal = mappedLines.taxAmounts.reduce((sum, amount) => sum + amount, 0n);
    const lineBasis = lineAmountType === "INCLUSIVE" ? total : subTotal;
    if (
      absoluteDifference(subTotal + totalTax, total) > 1n ||
      lineAmountTotal !== lineBasis ||
      taxAmountTotal !== totalTax ||
      (lineAmountType === "NO_TAX" && (totalTax !== 0n || taxAmountTotal !== 0n))
    ) return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };

    const canonicalPayload = parseCanonicalCreditNoteDraftPayload({
      schemaVersion: "xero-controlled-draft:v1",
      objectType: "CREDIT_NOTE",
      operation: "CREATE_DRAFT",
      status: "DRAFT",
      creditNoteType: creditNote.type,
      contactId,
      creditNoteDate,
      currency,
      reference,
      authoritativeProviderField: expectedAuthoritativeProviderField,
      lineAmountType,
      lines: mappedLines.canonicalLines,
      enteredLineSubtotal: fixedFour(mappedLines.enteredLineSubtotal),
    });
    return {
      ok: true,
      snapshot: {
        objectType: "CREDIT_NOTE",
        creditNoteId,
        canonicalPayload,
        providerEconomicsEvidence: {
          lineAmounts: mappedLines.lineAmounts.map(fixedFour),
          taxAmounts: mappedLines.taxAmounts.map(fixedFour),
          accountIds: mappedLines.canonicalLines.map((line) => line.accountId),
          accountCodes: mappedLines.canonicalLines.map((line) => line.accountCode),
          taxTypes: mappedLines.canonicalLines.map((line) => line.taxType),
          subTotal: fixedFour(subTotal),
          totalTax: fixedFour(totalTax),
          total: fixedFour(total),
          noDiscountsVerified: true,
        },
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
  }
}

interface MappedJournalLines {
  canonicalLines: CanonicalManualJournalDraftLine[];
  taxTypes: "NONE"[];
  taxAmounts: bigint[];
  debits: bigint;
  credits: bigint;
  net: bigint;
}

function mapJournalLines(value: unknown): MappedJournalLines | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) return undefined;
  const canonicalLines: CanonicalManualJournalDraftLine[] = [];
  const taxTypes: "NONE"[] = [];
  const taxAmounts: bigint[] = [];
  let debits = 0n;
  let credits = 0n;
  let net = 0n;
  for (const entry of value) {
    const line = providerRecord(entry);
    const accountId = providerUuid(line?.accountID);
    const accountCode = accountCodeFromProvider(line?.accountCode);
    const description = providerText(line?.description, 4_000);
    const lineAmount = providerScaledAmount(line?.lineAmount);
    const taxAmount = line?.taxAmount === undefined ? 0n : providerScaledAmount(line.taxAmount);
    const trackingOptionIds = providerTracking(line?.tracking);
    if (
      !line || !accountId || !accountCode || !description || lineAmount === undefined || lineAmount === 0n ||
      line.taxType !== "NONE" || taxAmount !== 0n || !trackingOptionIds ||
      (line.isBlank !== undefined && line.isBlank !== false)
    ) return undefined;
    net += lineAmount;
    if (lineAmount > 0n) debits += lineAmount;
    if (lineAmount < 0n) credits += -lineAmount;
    taxTypes.push("NONE");
    taxAmounts.push(0n);
    canonicalLines.push({
      accountId,
      accountCode,
      description,
      lineAmount: fixedFour(lineAmount),
      taxType: "NONE",
      trackingOptionIds,
    });
  }
  return { canonicalLines, taxTypes, taxAmounts, debits, credits, net };
}

export function mapManualJournalDraftReadback(
  input: unknown,
): DraftReadbackMappingResult<ManualJournalDraftReadbackSnapshot> {
  try {
    const journal = providerRecord(input);
    const manualJournalId = providerUuid(journal?.manualJournalID);
    const journalDate = providerText(journal?.date, 10);
    const narration = providerText(journal?.narration, 255);
    const mappedLines = mapJournalLines(journal?.journalLines);
    if (
      !journal || !providerHasNoValidationErrors(journal) || !manualJournalId || !journalDate || !narration ||
      journal.status !== "DRAFT" || journal.lineAmountTypes !== "NoTax" ||
      journal.showOnCashBasisReports !== false || !mappedLines || mappedLines.net !== 0n ||
      (journal.url !== undefined && journal.url !== null && journal.url !== "") ||
      (journal.hasAttachments !== undefined && journal.hasAttachments !== false) ||
      !absentOrEmptyArray(journal.attachments)
    ) return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };

    const canonicalPayload = parseCanonicalManualJournalDraftPayload({
      schemaVersion: "xero-controlled-draft:v1",
      objectType: "MANUAL_JOURNAL",
      operation: "CREATE_DRAFT",
      status: "DRAFT",
      journalDate,
      narration,
      lineAmountType: "NO_TAX",
      showOnCashBasisReports: false,
      lines: mappedLines.canonicalLines,
      debitTotal: fixedFour(mappedLines.debits),
      creditTotal: fixedFour(mappedLines.credits),
      netAmount: "0.0000",
    });
    return {
      ok: true,
      snapshot: {
        objectType: "MANUAL_JOURNAL",
        manualJournalId,
        canonicalPayload,
        providerTaxEvidence: {
          taxTypes: mappedLines.taxTypes,
          taxAmounts: mappedLines.taxAmounts.map(fixedFour),
          allNoneAndZero: true,
        },
        balanceVerified: true,
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_PROVIDER_READBACK" };
  }
}

export function verifyCreditNoteDraftReadback(
  expectedCreditNoteId: string,
  expectedCanonical: unknown,
  readback: unknown,
): DraftReadbackVerificationResult<CreditNoteDraftReadbackSnapshot, CanonicalCreditNoteDraftPayload> {
  const normalizedExpectedId = providerUuid(expectedCreditNoteId);
  if (!normalizedExpectedId) return { ok: false, reasons: ["EXPECTED_OBJECT_ID_INVALID"] };
  let expected: CanonicalCreditNoteDraftPayload;
  try {
    expected = parseCanonicalCreditNoteDraftPayload(expectedCanonical);
  } catch {
    return { ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] };
  }
  const mapped = mapCreditNoteDraftReadback(readback, expected.authoritativeProviderField);
  if (!mapped.ok) return { ok: false, reasons: [mapped.reason] };
  const reasons: DraftVerificationReason[] = [];
  if (mapped.snapshot.creditNoteId !== normalizedExpectedId) reasons.push("XERO_OBJECT_ID_MISMATCH");
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

export function verifyManualJournalDraftReadback(
  expectedManualJournalId: string,
  expectedCanonical: unknown,
  readback: unknown,
): DraftReadbackVerificationResult<ManualJournalDraftReadbackSnapshot, CanonicalManualJournalDraftPayload> {
  const normalizedExpectedId = providerUuid(expectedManualJournalId);
  if (!normalizedExpectedId) return { ok: false, reasons: ["EXPECTED_OBJECT_ID_INVALID"] };
  let expected: CanonicalManualJournalDraftPayload;
  try {
    expected = parseCanonicalManualJournalDraftPayload(expectedCanonical);
  } catch {
    return { ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] };
  }
  const mapped = mapManualJournalDraftReadback(readback);
  if (!mapped.ok) return { ok: false, reasons: [mapped.reason] };
  const reasons: DraftVerificationReason[] = [];
  if (mapped.snapshot.manualJournalId !== normalizedExpectedId) reasons.push("XERO_OBJECT_ID_MISMATCH");
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
