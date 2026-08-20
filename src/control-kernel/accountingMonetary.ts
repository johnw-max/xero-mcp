import type {
  AccountingPolicyEnforcementContract,
  AccountingPolicyMonetaryRule,
} from "./accountingPolicyEnforcementContract.js";

export const ACCOUNTING_FIXED_DECIMAL_SCALE = 4;
export const ACCOUNTING_FIXED_DECIMAL_FACTOR = 10_000n;

export type SupportedAccountingMonetaryRule = AccountingPolicyMonetaryRule & Readonly<{
  roundingMode: "HALF_UP";
  taxAggregation: "PER_LINE";
}>;

/** Parse the bounded canonical decimal vocabulary used by the shared kernel. */
export function parseAccountingFixedDecimal(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u.test(value)) {
    throw new Error("Accounting amount is not a bounded fixed-four decimal string.");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const scaled = BigInt(whole) * ACCOUNTING_FIXED_DECIMAL_FACTOR +
    BigInt((fraction + "0".repeat(ACCOUNTING_FIXED_DECIMAL_SCALE)).slice(0, ACCOUNTING_FIXED_DECIMAL_SCALE));
  return negative ? -scaled : scaled;
}

export function formatAccountingFixedFour(value: bigint): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  return `${negative ? "-" : ""}${unsigned / ACCOUNTING_FIXED_DECIMAL_FACTOR}.${
    (unsigned % ACCOUNTING_FIXED_DECIMAL_FACTOR).toString().padStart(ACCOUNTING_FIXED_DECIMAL_SCALE, "0")
  }`;
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error("Accounting monetary divisor must be positive.");
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const quotient = unsigned / divisor;
  const remainder = unsigned % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  return negative ? -rounded : rounded;
}

/**
 * Quantize a scale-eight product to fixed-four at the policy currency scale.
 * Compiler, preflight bridge and adapters must use this one implementation.
 */
export function quantizeAccountingScaleEight(
  value: bigint,
  rule: SupportedAccountingMonetaryRule,
): bigint {
  const divisor = 10n ** BigInt(8 - rule.minorUnitScale);
  const minorUnits = roundHalfUp(value, divisor);
  return minorUnits * (10n ** BigInt(ACCOUNTING_FIXED_DECIMAL_SCALE - rule.minorUnitScale));
}

export function quantizeAccountingLineNet(
  quantityFixedFour: bigint,
  unitAmountFixedFour: bigint,
  rule: SupportedAccountingMonetaryRule,
): bigint {
  return quantizeAccountingScaleEight(quantityFixedFour * unitAmountFixedFour, rule);
}

export function quantizeAccountingLineTax(
  lineNetFixedFour: bigint,
  effectiveTaxRateBps: number,
  rule: SupportedAccountingMonetaryRule,
): bigint {
  if (!Number.isInteger(effectiveTaxRateBps) || effectiveTaxRateBps < 0 || effectiveTaxRateBps > 10_000) {
    throw new Error("Accounting effective tax rate is outside the basis-point contract.");
  }
  return quantizeAccountingScaleEight(lineNetFixedFour * BigInt(effectiveTaxRateBps), rule);
}

export function resolveSupportedAccountingMonetaryRule(
  policy: AccountingPolicyEnforcementContract,
  currency: string,
): { rule?: SupportedAccountingMonetaryRule; reasonCodes: string[] } {
  const candidate = policy.monetaryRule(currency);
  if (!candidate) return { reasonCodes: ["ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED"] };
  const reasons: string[] = [];
  if (candidate.currency !== currency) reasons.push("ACCOUNTING_MONETARY_CURRENCY_MISMATCH");
  if (
    !Number.isInteger(candidate.minorUnitScale) || candidate.minorUnitScale < 0 ||
    candidate.minorUnitScale > ACCOUNTING_FIXED_DECIMAL_SCALE
  ) reasons.push("ACCOUNTING_MONETARY_MINOR_UNIT_SCALE_INVALID");
  if (candidate.roundingMode !== "HALF_UP") reasons.push("ACCOUNTING_MONETARY_ROUNDING_MODE_UNSUPPORTED");
  if (candidate.taxAggregation !== "PER_LINE") reasons.push("ACCOUNTING_TAX_AGGREGATION_UNSUPPORTED");
  return reasons.length > 0
    ? { reasonCodes: [...new Set(reasons)].sort((left, right) => left.localeCompare(right)) }
    : { rule: candidate as SupportedAccountingMonetaryRule, reasonCodes: [] };
}

/** Rehydrate only an already sealed, currently supported monetary decision. */
export function parseSealedAccountingMonetaryRule(
  value: unknown,
  expectedCurrency: string,
): SupportedAccountingMonetaryRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== "accounting-case-monetary-rule:v1" ||
    record.currency !== expectedCurrency ||
    typeof record.minorUnitScale !== "number" || !Number.isInteger(record.minorUnitScale) ||
    record.minorUnitScale < 0 || record.minorUnitScale > ACCOUNTING_FIXED_DECIMAL_SCALE ||
    record.roundingMode !== "HALF_UP" || record.taxAggregation !== "PER_LINE"
  ) return undefined;
  return Object.freeze({
    currency: expectedCurrency,
    minorUnitScale: record.minorUnitScale as 0 | 1 | 2 | 3 | 4,
    roundingMode: "HALF_UP",
    taxAggregation: "PER_LINE",
  });
}
