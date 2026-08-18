import type { AccountingCaseOperation } from "../domain/accountingCase.js";
import { hashObject, stableStringify } from "../security/hash.js";

const FIXED_FOUR = /^-?(?:0|[1-9]\d*)\.\d{4}$/u;

/** Runtime/release attestation for the exact economic readback policy. */
export const ACCOUNTING_CASE_READBACK_VALIDATOR_VERSION = "accounting-case-observed-line-readback-v4";

export type AccountingCaseReadbackEconomicsReason =
  | "MUTATION_READBACK_EVIDENCE_INCOMPLETE"
  | "CASE_AMOUNT_BRIDGE_INCOMPLETE"
  | "CASE_AMOUNT_BRIDGE_MISMATCH"
  | "CASE_AMOUNT_BRIDGE_LINE_MISMATCH"
  | "CASE_CANONICAL_ECONOMICS_MALFORMED"
  | "CASE_CANONICAL_ECONOMICS_INCONSISTENT"
  | "CASE_MONETARY_ROUNDING_RULE_MALFORMED"
  | "CASE_CANONICAL_CURRENCY_SCALE_MISMATCH"
  | "PROVIDER_DOCUMENT_READBACK_MISSING"
  | "PROVIDER_DOCUMENT_IDENTITY_MISMATCH"
  | "PROVIDER_DOCUMENT_LINES_TRUNCATED"
  | "PROVIDER_DOCUMENT_LINE_COUNT_MISMATCH"
  | "PROVIDER_DOCUMENT_LINE_ECONOMICS_MALFORMED"
  | "PROVIDER_DOCUMENT_LINE_AMOUNT_MISMATCH"
  | "PROVIDER_DOCUMENT_LINE_TAX_MISMATCH"
  | "PROVIDER_DOCUMENT_LINE_ACCOUNT_MISMATCH"
  | "PROVIDER_DOCUMENT_LINE_TAX_SEMANTICS_MISMATCH"
  | "PROVIDER_DOCUMENT_TOTALS_MALFORMED"
  | "PROVIDER_DOCUMENT_SUBTOTAL_MISMATCH"
  | "PROVIDER_DOCUMENT_TAX_TOTAL_MISMATCH"
  | "PROVIDER_DOCUMENT_GROSS_TOTAL_MISMATCH"
  | "PROVIDER_CREDIT_ECONOMICS_MISSING"
  | "PROVIDER_CREDIT_ECONOMICS_MALFORMED"
  | "PROVIDER_CREDIT_LINE_COUNT_MISMATCH"
  | "PROVIDER_CREDIT_LINE_AMOUNT_MISMATCH"
  | "PROVIDER_CREDIT_LINE_TAX_MISMATCH"
  | "PROVIDER_CREDIT_LINE_ACCOUNT_MISMATCH"
  | "PROVIDER_CREDIT_LINE_TAX_SEMANTICS_MISMATCH"
  | "PROVIDER_CREDIT_SUBTOTAL_MISMATCH"
  | "PROVIDER_CREDIT_TAX_TOTAL_MISMATCH"
  | "PROVIDER_CREDIT_GROSS_TOTAL_MISMATCH";

export type AccountingCaseReadbackEconomicsValidation =
  | { ok: true; applicability: "NOT_A_NATIVE_DOCUMENT" | "INVOICE_OR_BILL" | "CREDIT_NOTE" }
  | { ok: false; reasons: AccountingCaseReadbackEconomicsReason[] };

/**
 * Provider-neutral durable readback projection consumed by the shared
 * economics validator. Provider repositories/adapters own the translation
 * from their SDK and mutation domains into these immutable evidence fields.
 */
export interface LedgerDurableReadbackProjection {
  readonly state: string;
  readonly providerObjectId?: string;
  readonly writeReceipt?: Readonly<Record<string, unknown>>;
  readonly readbackSnapshot?: unknown;
  readonly readbackSnapshotHash?: string;
  readonly readbackCanonicalPayload?: unknown;
  readonly readbackPayloadHash?: string;
  readonly canonicalPayload?: unknown;
  readonly canonicalPayloadHash: string;
  readonly readbackStatus?: string;
}

/**
 * Provider-owned identity vocabulary for one durable readback. The shared
 * validator interprets only the applicability class; provider document kinds,
 * lifecycle statuses and evidence object types remain adapter-owned values.
 */
export type AccountingCaseReadbackExpectation =
  | Readonly<{ applicability: "NOT_A_NATIVE_DOCUMENT" }>
  | Readonly<{
      applicability: "INVOICE_OR_BILL";
      providerStatus: string;
      providerDocumentType: string;
    }>
  | Readonly<{
      applicability: "CREDIT_NOTE";
      providerStatus: string;
      providerEvidenceObjectType: string;
    }>;

interface CanonicalEconomics {
  lines: Array<{
    lineId: string;
    net: bigint;
    tax: bigint;
    accountingPolicyBindingHash: string;
    providerAccountBindingHash: string;
    providerTaxBindingHash: string;
    accountingCategory: string;
    taxClass: string;
    taxSemantics: string;
    effectiveTaxRateBps: number;
  }>;
  net: bigint;
  tax: bigint;
  gross: bigint;
}

interface CanonicalMonetaryRule {
  minorUnitScale: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function fixedFour(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !FIXED_FOUR.test(value)) return undefined;
  try {
    return BigInt(value.replace(".", ""));
  } catch {
    return undefined;
  }
}

function uniqueReasons(
  reasons: readonly AccountingCaseReadbackEconomicsReason[],
): AccountingCaseReadbackEconomicsReason[] {
  return [...new Set(reasons)];
}

function canonicalMonetaryRule(
  payload: Record<string, unknown>,
  reasons: AccountingCaseReadbackEconomicsReason[],
): CanonicalMonetaryRule | undefined {
  const raw = record(payload.monetaryRule);
  if (
    !raw ||
    raw.schemaVersion !== "accounting-case-monetary-rule:v1" ||
    raw.currency !== payload.currency ||
    typeof raw.minorUnitScale !== "number" ||
    !Number.isInteger(raw.minorUnitScale) ||
    raw.minorUnitScale < 0 || raw.minorUnitScale > 4 ||
    raw.roundingMode !== "HALF_UP" ||
    raw.taxAggregation !== "PER_LINE"
  ) {
    reasons.push("CASE_MONETARY_ROUNDING_RULE_MALFORMED");
    return undefined;
  }
  return { minorUnitScale: raw.minorUnitScale };
}

function isQuantized(value: bigint, rule: CanonicalMonetaryRule): boolean {
  return value % (10n ** BigInt(4 - rule.minorUnitScale)) === 0n;
}

function canonicalEconomics(
  operation: AccountingCaseOperation,
  reasons: AccountingCaseReadbackEconomicsReason[],
): CanonicalEconomics | undefined {
  const payload = operation.canonicalPayload;
  const monetaryRule = canonicalMonetaryRule(payload, reasons);
  if (!Array.isArray(payload.lines)) {
    reasons.push("CASE_CANONICAL_ECONOMICS_MALFORMED");
    return undefined;
  }
  const lines: CanonicalEconomics["lines"] = [];
  for (const value of payload.lines) {
    const line = record(value);
    const net = fixedFour(line?.net);
    const tax = fixedFour(line?.tax);
    if (
      net === undefined || tax === undefined ||
      typeof line?.lineId !== "string" || line.lineId.length === 0 ||
      typeof line.accountingPolicyBindingHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(line.accountingPolicyBindingHash) ||
      typeof line.providerAccountBindingHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(line.providerAccountBindingHash) ||
      typeof line.providerTaxBindingHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(line.providerTaxBindingHash) ||
      typeof line.accountingCategory !== "string" || line.accountingCategory.length === 0 ||
      typeof line.taxClass !== "string" || line.taxClass.length === 0 ||
      typeof line.taxSemantics !== "string" || line.taxSemantics.length === 0 ||
      typeof line.effectiveTaxRateBps !== "number" || !Number.isInteger(line.effectiveTaxRateBps) ||
      line.effectiveTaxRateBps < 0 || line.effectiveTaxRateBps > 10_000
    ) {
      reasons.push("CASE_CANONICAL_ECONOMICS_MALFORMED");
      return undefined;
    }
    lines.push({
      lineId: line.lineId,
      net,
      tax,
      accountingPolicyBindingHash: line.accountingPolicyBindingHash,
      providerAccountBindingHash: line.providerAccountBindingHash,
      providerTaxBindingHash: line.providerTaxBindingHash,
      accountingCategory: line.accountingCategory,
      taxClass: line.taxClass,
      taxSemantics: line.taxSemantics,
      effectiveTaxRateBps: line.effectiveTaxRateBps,
    });
  }
  if (lines.length === 0) {
    reasons.push("CASE_CANONICAL_ECONOMICS_MALFORMED");
    return undefined;
  }
  const net = fixedFour(payload.net);
  const tax = fixedFour(payload.tax);
  const gross = fixedFour(payload.gross);
  if (net === undefined || tax === undefined || gross === undefined) {
    reasons.push("CASE_CANONICAL_ECONOMICS_MALFORMED");
    return undefined;
  }
  const lineNet = lines.reduce((sum, line) => sum + line.net, 0n);
  const lineTax = lines.reduce((sum, line) => sum + line.tax, 0n);
  if (lineNet !== net || lineTax !== tax || net + tax !== gross) {
    reasons.push("CASE_CANONICAL_ECONOMICS_INCONSISTENT");
  }
  if (monetaryRule && (
    !isQuantized(net, monetaryRule) ||
    !isQuantized(tax, monetaryRule) ||
    !isQuantized(gross, monetaryRule) ||
    lines.some((line) => !isQuantized(line.net, monetaryRule) || !isQuantized(line.tax, monetaryRule))
  )) {
    reasons.push("CASE_CANONICAL_CURRENCY_SCALE_MISMATCH");
  }

  const bridge = operation.amountBridge;
  if (!bridge) {
    reasons.push("CASE_AMOUNT_BRIDGE_INCOMPLETE");
  } else {
    const sourceNet = fixedFour(bridge.sourceNet);
    const sourceTax = fixedFour(bridge.sourceTax);
    const sourceGross = fixedFour(bridge.sourceGross);
    const bridgeNet = fixedFour(bridge.canonicalNet);
    const bridgeTax = fixedFour(bridge.canonicalTax);
    const bridgeGross = fixedFour(bridge.canonicalGross);
    if (
      sourceNet === undefined || sourceTax === undefined || sourceGross === undefined ||
      bridgeNet === undefined || bridgeTax === undefined || bridgeGross === undefined ||
      !Array.isArray(bridge.sourceFactIds) || bridge.sourceFactIds.length === 0 ||
      bridge.sourceFactIds.some((factId) => typeof factId !== "string" || factId.length === 0) ||
      !/^[a-f0-9]{64}$/u.test(bridge.sourceLineHash)
    ) {
      reasons.push("CASE_AMOUNT_BRIDGE_INCOMPLETE");
    } else if (
      sourceNet + sourceTax !== sourceGross ||
      sourceNet !== bridgeNet || sourceTax !== bridgeTax || sourceGross !== bridgeGross ||
      bridgeNet !== net || bridgeTax !== tax || bridgeGross !== gross ||
      bridge.currency !== payload.currency ||
      bridge.formula !== "LINE_SUM_PLUS_TAX_EQUALS_GROSS" ||
      bridge.toleranceMinorUnits !== 0
    ) {
      reasons.push("CASE_AMOUNT_BRIDGE_MISMATCH");
    }
    if (!Array.isArray(bridge.lineBridges) || bridge.lineBridges.length !== lines.length) {
      reasons.push("CASE_AMOUNT_BRIDGE_LINE_MISMATCH");
    } else {
      for (const [index, canonicalLine] of lines.entries()) {
        const lineBridge = record(bridge.lineBridges[index]);
        if (
          lineBridge?.lineId !== canonicalLine.lineId ||
          fixedFour(lineBridge?.sourceTax) !== canonicalLine.tax ||
          fixedFour(lineBridge?.canonicalNet) !== canonicalLine.net ||
          fixedFour(lineBridge?.canonicalTax) !== canonicalLine.tax ||
          lineBridge?.effectiveTaxRateBps !== canonicalLine.effectiveTaxRateBps ||
          lineBridge?.accountingCategory !== canonicalLine.accountingCategory ||
          lineBridge?.taxClass !== canonicalLine.taxClass ||
          lineBridge?.taxSemantics !== canonicalLine.taxSemantics ||
          typeof lineBridge?.sourceLineHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(lineBridge.sourceLineHash)
        ) {
          reasons.push("CASE_AMOUNT_BRIDGE_LINE_MISMATCH");
          break;
        }
      }
    }
  }
  return { lines, net, tax, gross };
}

function baseMutationEvidenceReasons(
  request: LedgerDurableReadbackProjection,
  expectedProviderStatus: string,
): AccountingCaseReadbackEconomicsReason[] {
  const snapshot = record(request.readbackSnapshot);
  const readbackCanonicalPayload = record(request.readbackCanonicalPayload);
  if (
    request.state !== "READBACK_VERIFIED" ||
    !request.providerObjectId ||
    !request.writeReceipt || Object.keys(request.writeReceipt).length === 0 ||
    !snapshot ||
    snapshot.providerObjectId !== request.providerObjectId ||
    snapshot.status !== expectedProviderStatus ||
    request.readbackStatus !== expectedProviderStatus ||
    request.readbackSnapshotHash !== hashObject(snapshot) ||
    !readbackCanonicalPayload ||
    request.readbackPayloadHash !== hashObject(readbackCanonicalPayload) ||
    request.readbackPayloadHash !== request.canonicalPayloadHash ||
    stableStringify(readbackCanonicalPayload) !== stableStringify(request.canonicalPayload) ||
    stableStringify(snapshot.canonicalPayload) !== stableStringify(readbackCanonicalPayload)
  ) {
    return ["MUTATION_READBACK_EVIDENCE_INCOMPLETE"];
  }
  return [];
}

function validateInvoiceOrBill(
  operation: AccountingCaseOperation,
  request: LedgerDurableReadbackProjection,
  expectation: Extract<AccountingCaseReadbackExpectation, { applicability: "INVOICE_OR_BILL" }>,
): AccountingCaseReadbackEconomicsValidation {
  const reasons = baseMutationEvidenceReasons(request, expectation.providerStatus);
  const expected = canonicalEconomics(operation, reasons);
  const snapshot = record(request.readbackSnapshot);
  const evidence = record(snapshot?.evidence);
  const provider = record(evidence?.providerDocumentReadback);
  if (!provider) {
    reasons.push("PROVIDER_DOCUMENT_READBACK_MISSING");
    return { ok: false, reasons: uniqueReasons(reasons) };
  }
  if (
    provider.documentId !== request.providerObjectId ||
    provider.status !== expectation.providerStatus ||
    provider.type !== expectation.providerDocumentType
  ) {
    reasons.push("PROVIDER_DOCUMENT_IDENTITY_MISMATCH");
  }
  if (provider.linesTruncated !== false) reasons.push("PROVIDER_DOCUMENT_LINES_TRUNCATED");
  const lines = Array.isArray(provider.lines) ? provider.lines : undefined;
  if (
    !expected ||
    !lines ||
    !Number.isSafeInteger(provider.lineItemCount) ||
    provider.lineItemCount !== lines.length ||
    lines.length !== expected.lines.length
  ) {
    reasons.push("PROVIDER_DOCUMENT_LINE_COUNT_MISMATCH");
  } else {
    for (const [index, expectedLine] of expected.lines.entries()) {
      const providerLine = record(lines[index]);
      const lineAmount = fixedFour(providerLine?.lineAmount);
      const taxAmount = fixedFour(providerLine?.taxAmount);
      if (lineAmount === undefined || taxAmount === undefined) {
        reasons.push("PROVIDER_DOCUMENT_LINE_ECONOMICS_MALFORMED");
        continue;
      }
      if (lineAmount !== expectedLine.net) reasons.push("PROVIDER_DOCUMENT_LINE_AMOUNT_MISMATCH");
      if (taxAmount !== expectedLine.tax) reasons.push("PROVIDER_DOCUMENT_LINE_TAX_MISMATCH");
      if (providerLine?.accountingPolicyBindingHash !== expectedLine.accountingPolicyBindingHash) {
        reasons.push("PROVIDER_DOCUMENT_LINE_ACCOUNT_MISMATCH");
      }
      if (providerLine?.providerAccountBindingHash !== expectedLine.providerAccountBindingHash) {
        reasons.push("PROVIDER_DOCUMENT_LINE_ACCOUNT_MISMATCH");
      }
      if (providerLine?.providerTaxBindingHash !== expectedLine.providerTaxBindingHash) {
        reasons.push("PROVIDER_DOCUMENT_LINE_TAX_SEMANTICS_MISMATCH");
      }
    }
  }
  const subTotal = fixedFour(provider.subTotal);
  const totalTax = fixedFour(provider.totalTax);
  const total = fixedFour(provider.total);
  if (subTotal === undefined || totalTax === undefined || total === undefined) {
    reasons.push("PROVIDER_DOCUMENT_TOTALS_MALFORMED");
  } else if (expected) {
    if (subTotal !== expected.net) reasons.push("PROVIDER_DOCUMENT_SUBTOTAL_MISMATCH");
    if (totalTax !== expected.tax) reasons.push("PROVIDER_DOCUMENT_TAX_TOTAL_MISMATCH");
    if (total !== expected.gross) reasons.push("PROVIDER_DOCUMENT_GROSS_TOTAL_MISMATCH");
  }
  return reasons.length === 0
    ? { ok: true, applicability: "INVOICE_OR_BILL" }
    : { ok: false, reasons: uniqueReasons(reasons) };
}

function validateCreditNote(
  operation: AccountingCaseOperation,
  request: LedgerDurableReadbackProjection,
  expectation: Extract<AccountingCaseReadbackExpectation, { applicability: "CREDIT_NOTE" }>,
): AccountingCaseReadbackEconomicsValidation {
  const reasons = baseMutationEvidenceReasons(request, expectation.providerStatus);
  const expected = canonicalEconomics(operation, reasons);
  const snapshot = record(request.readbackSnapshot);
  const evidence = record(snapshot?.evidence);
  const providerEconomics = record(evidence?.providerEconomicsEvidence);
  if (
    !evidence ||
    evidence.objectType !== expectation.providerEvidenceObjectType ||
    evidence.creditDocumentId !== request.providerObjectId ||
    !providerEconomics
  ) {
    reasons.push("PROVIDER_CREDIT_ECONOMICS_MISSING");
    return { ok: false, reasons: uniqueReasons(reasons) };
  }
  const lineAmounts = Array.isArray(providerEconomics.lineAmounts)
    ? providerEconomics.lineAmounts.map(fixedFour)
    : undefined;
  const taxAmounts = Array.isArray(providerEconomics.taxAmounts)
    ? providerEconomics.taxAmounts.map(fixedFour)
    : undefined;
  const accountingPolicyBindingHashes = Array.isArray(providerEconomics.accountingPolicyBindingHashes)
    ? providerEconomics.accountingPolicyBindingHashes
    : undefined;
  const providerAccountBindingHashes = Array.isArray(providerEconomics.providerAccountBindingHashes)
    ? providerEconomics.providerAccountBindingHashes
    : undefined;
  const providerTaxBindingHashes = Array.isArray(providerEconomics.providerTaxBindingHashes)
    ? providerEconomics.providerTaxBindingHashes
    : undefined;
  const subTotal = fixedFour(providerEconomics.subTotal);
  const totalTax = fixedFour(providerEconomics.totalTax);
  const total = fixedFour(providerEconomics.total);
  if (
    !lineAmounts || lineAmounts.some((value) => value === undefined) ||
    !taxAmounts || taxAmounts.some((value) => value === undefined) ||
    !accountingPolicyBindingHashes || accountingPolicyBindingHashes.some((value) =>
      typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) ||
    !providerAccountBindingHashes || providerAccountBindingHashes.some((value) =>
      typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) ||
    !providerTaxBindingHashes || providerTaxBindingHashes.some((value) =>
      typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) ||
    subTotal === undefined || totalTax === undefined || total === undefined ||
    providerEconomics.noDiscountsVerified !== true ||
    "roundingTolerance" in providerEconomics ||
    "arithmeticVerified" in providerEconomics ||
    "lineBasisVerified" in providerEconomics ||
    "taxTotalVerified" in providerEconomics
  ) {
    reasons.push("PROVIDER_CREDIT_ECONOMICS_MALFORMED");
  }
  if (
    !expected || !lineAmounts || !taxAmounts || !accountingPolicyBindingHashes ||
    !providerAccountBindingHashes || !providerTaxBindingHashes ||
    lineAmounts.length !== expected.lines.length ||
    taxAmounts.length !== expected.lines.length ||
    accountingPolicyBindingHashes.length !== expected.lines.length ||
    providerAccountBindingHashes.length !== expected.lines.length ||
    providerTaxBindingHashes.length !== expected.lines.length
  ) {
    reasons.push("PROVIDER_CREDIT_LINE_COUNT_MISMATCH");
  } else {
    for (const [index, expectedLine] of expected.lines.entries()) {
      if (lineAmounts[index] !== expectedLine.net) reasons.push("PROVIDER_CREDIT_LINE_AMOUNT_MISMATCH");
      if (taxAmounts[index] !== expectedLine.tax) reasons.push("PROVIDER_CREDIT_LINE_TAX_MISMATCH");
      if (accountingPolicyBindingHashes[index] !== expectedLine.accountingPolicyBindingHash) {
        reasons.push("PROVIDER_CREDIT_LINE_ACCOUNT_MISMATCH");
      }
      if (providerAccountBindingHashes[index] !== expectedLine.providerAccountBindingHash) {
        reasons.push("PROVIDER_CREDIT_LINE_ACCOUNT_MISMATCH");
      }
      if (providerTaxBindingHashes[index] !== expectedLine.providerTaxBindingHash) {
        reasons.push("PROVIDER_CREDIT_LINE_TAX_SEMANTICS_MISMATCH");
      }
    }
  }
  if (expected) {
    if (subTotal !== undefined && subTotal !== expected.net) reasons.push("PROVIDER_CREDIT_SUBTOTAL_MISMATCH");
    if (totalTax !== undefined && totalTax !== expected.tax) reasons.push("PROVIDER_CREDIT_TAX_TOTAL_MISMATCH");
    if (total !== undefined && total !== expected.gross) reasons.push("PROVIDER_CREDIT_GROSS_TOTAL_MISMATCH");
  }
  return reasons.length === 0
    ? { ok: true, applicability: "CREDIT_NOTE" }
    : { ok: false, reasons: uniqueReasons(reasons) };
}

/**
 * Pure fail-closed validator for the last Case success projection. The generic
 * mutation lifecycle proves object identity and canonical provider proposal;
 * this validator additionally proves that the provider's observed economic
 * values equal the immutable Accounting Case and its amount bridge exactly.
 */
export function validateAccountingCaseReadbackEconomics(
  operation: AccountingCaseOperation,
  request: LedgerDurableReadbackProjection,
  expectation: AccountingCaseReadbackExpectation,
): AccountingCaseReadbackEconomicsValidation {
  if (expectation.applicability === "NOT_A_NATIVE_DOCUMENT") {
    return { ok: true, applicability: "NOT_A_NATIVE_DOCUMENT" };
  }
  if (expectation.applicability === "INVOICE_OR_BILL") {
    return validateInvoiceOrBill(operation, request, expectation);
  }
  return validateCreditNote(operation, request, expectation);
}
