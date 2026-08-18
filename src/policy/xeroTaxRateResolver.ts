import type { AccountSummary, TaxRateSummary } from "../providers/types.js";

export type XeroTaxDirection = "INPUT" | "OUTPUT";

type KnownAccountClass = "EXPENSE" | "ASSET" | "LIABILITY" | "REVENUE" | "EQUITY";

interface StableTaxPolicy {
  direction: XeroTaxDirection | "BOTH";
  expectedRateScaled4: bigint;
}

/**
 * Stable TaxTypes emitted by the SG Accounting Case compiler. Display names
 * are deliberately absent: tenant-renamed labels are evidence only and must
 * never select tax semantics.
 */
const STABLE_TAX_POLICIES: Readonly<Record<string, StableTaxPolicy>> = Object.freeze({
  INPUTY24: { direction: "INPUT", expectedRateScaled4: 90_000n },
  OUTPUTY24: { direction: "OUTPUT", expectedRateScaled4: 90_000n },
  NONE: { direction: "BOTH", expectedRateScaled4: 0n },
  EPINPUT: { direction: "INPUT", expectedRateScaled4: 0n },
  ES33OUTPUT: { direction: "OUTPUT", expectedRateScaled4: 0n },
  ESN33OUTPUT: { direction: "OUTPUT", expectedRateScaled4: 0n },
  ZERORATEDINPUT: { direction: "INPUT", expectedRateScaled4: 0n },
  ZERORATEDOUTPUT: { direction: "OUTPUT", expectedRateScaled4: 0n },
  OPINPUT: { direction: "INPUT", expectedRateScaled4: 0n },
  OSOUTPUT2: { direction: "OUTPUT", expectedRateScaled4: 0n },
});

export type XeroTaxRateResolutionFailureCode =
  | "UNSUPPORTED_STABLE_TAX_TYPE"
  | "TAX_DIRECTION_MISMATCH"
  | "UNKNOWN_ACCOUNT_CLASS"
  | "NO_UNIQUE_ACTIVE_TAX_RATE"
  | "MISSING_TAX_RATE_EVIDENCE"
  | "TAX_RATE_MISMATCH"
  | "TAX_NOT_APPLICABLE_TO_ACCOUNT_CLASS";

export type XeroTaxRateResolution =
  | {
      ok: true;
      taxRate: TaxRateSummary;
      accountClass: KnownAccountClass;
      expectedRate: string;
    }
  | {
      ok: false;
      code: XeroTaxRateResolutionFailureCode;
      message: string;
    };

function parseRateScaled4(value: string | undefined): bigint | undefined {
  if (value === undefined || value !== value.trim()) return undefined;
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) return undefined;
  const whole = match[1];
  if (whole === undefined) return undefined;
  const fraction = (match[2] ?? "").padEnd(4, "0");
  return (BigInt(whole) * 10_000n) + BigInt(fraction || "0");
}

function fixedRate(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = (value % 10_000n).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

function knownAccountClass(value: string | undefined): KnownAccountClass | undefined {
  const normalized = value?.toUpperCase();
  switch (normalized) {
    case "EXPENSE":
    case "ASSET":
    case "LIABILITY":
    case "REVENUE":
    case "EQUITY":
      return normalized;
    default:
      return undefined;
  }
}

function appliesToAccountClass(tax: TaxRateSummary, accountClass: KnownAccountClass): boolean {
  switch (accountClass) {
    case "EXPENSE": return tax.canApplyToExpenses === true;
    case "ASSET": return tax.canApplyToAssets === true;
    case "LIABILITY": return tax.canApplyToLiabilities === true;
    case "REVENUE": return tax.canApplyToRevenue === true;
    case "EQUITY": return tax.canApplyToEquity === true;
  }
}

/**
 * Resolve one exact Provider TaxRate for a compiler-emitted stable TaxType.
 * Every field used for a write decision is fail-closed: missing status/rates,
 * duplicate active rows, unknown account class and absent applicability flags
 * are all rejections, not defaults.
 */
export function resolveStableXeroTaxRate(input: {
  taxRates: readonly TaxRateSummary[];
  taxType: string;
  direction: XeroTaxDirection;
  account: AccountSummary;
}): XeroTaxRateResolution {
  const policy = STABLE_TAX_POLICIES[input.taxType];
  if (!policy) {
    return {
      ok: false,
      code: "UNSUPPORTED_STABLE_TAX_TYPE",
      message: `Tax type ${input.taxType} is not in the deterministic Accounting Case tax policy.`,
    };
  }
  if (policy.direction !== "BOTH" && policy.direction !== input.direction) {
    return {
      ok: false,
      code: "TAX_DIRECTION_MISMATCH",
      message: `Tax type ${input.taxType} is not valid for the ${input.direction} document direction.`,
    };
  }

  const accountClass = knownAccountClass(input.account.class);
  if (!accountClass) {
    return {
      ok: false,
      code: "UNKNOWN_ACCOUNT_CLASS",
      message: "The exact Xero account has no known account class, so tax applicability cannot be proven.",
    };
  }

  const activeMatches = input.taxRates.filter((tax) =>
    tax.taxType === input.taxType && tax.status === "ACTIVE");
  if (activeMatches.length !== 1) {
    return {
      ok: false,
      code: "NO_UNIQUE_ACTIVE_TAX_RATE",
      message: `Tax type ${input.taxType} did not resolve to exactly one explicitly ACTIVE Xero TaxRate.`,
    };
  }
  const selected = activeMatches[0]!;
  const displayRate = parseRateScaled4(selected.displayTaxRate);
  const effectiveRate = parseRateScaled4(selected.effectiveRate);
  if (displayRate === undefined || effectiveRate === undefined) {
    return {
      ok: false,
      code: "MISSING_TAX_RATE_EVIDENCE",
      message: `Tax type ${input.taxType} is missing a canonical DisplayTaxRate or EffectiveRate.`,
    };
  }
  if (displayRate !== policy.expectedRateScaled4 || effectiveRate !== policy.expectedRateScaled4) {
    return {
      ok: false,
      code: "TAX_RATE_MISMATCH",
      message: `Tax type ${input.taxType} does not match the deterministic ${fixedRate(policy.expectedRateScaled4)}% rate policy.`,
    };
  }
  if (!appliesToAccountClass(selected, accountClass)) {
    return {
      ok: false,
      code: "TAX_NOT_APPLICABLE_TO_ACCOUNT_CLASS",
      message: `Tax type ${input.taxType} is not explicitly applicable to ${accountClass} accounts.`,
    };
  }
  return {
    ok: true,
    taxRate: selected,
    accountClass,
    expectedRate: fixedRate(policy.expectedRateScaled4),
  };
}
