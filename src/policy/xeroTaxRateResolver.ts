import type { AccountSummary, TaxRateSummary } from "../providers/types.js";

/**
 * Direction label retained for provider adapters that still describe a document
 * side. It is evidence only: tax applicability is proven from Xero's own
 * `CanApplyTo*` attributes, never from an MCP-owned direction policy.
 */
export type XeroTaxDirection = "INPUT" | "OUTPUT";

type KnownAccountClass = "EXPENSE" | "ASSET" | "LIABILITY" | "REVENUE" | "EQUITY";

export type XeroTaxRateResolutionFailureCode =
  | "UNKNOWN_ACCOUNT_CLASS"
  | "NO_UNIQUE_ACTIVE_TAX_RATE"
  | "MISSING_TAX_RATE_EVIDENCE"
  | "TAX_RATE_EVIDENCE_INCONSISTENT"
  | "TAX_NOT_APPLICABLE_TO_ACCOUNT_CLASS";

export type XeroTaxRateResolution =
  | {
      ok: true;
      taxRate: TaxRateSummary;
      accountClass: KnownAccountClass;
      /** The tenant's own rate for this TaxType, not an MCP-owned expectation. */
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
 * Verify one caller-declared Xero TaxType against the target tenant's live tax
 * table and the exact account it will be written to.
 *
 * This is verification, not judgment. The MCP holds no list of permitted tax
 * types and no direction policy; it proves only that
 *
 *  1. the declared TaxType resolves to exactly one explicitly ACTIVE TaxRate,
 *  2. that TaxRate carries canonical, self-consistent rate evidence, and
 *  3. Xero itself says the rate may be applied to that account's class.
 *
 * Display names are deliberately ignored: a tenant-renamed label is evidence
 * only and must never select tax semantics.
 */
export function resolveStableXeroTaxRate(input: {
  taxRates: readonly TaxRateSummary[];
  taxType: string;
  account: AccountSummary;
}): XeroTaxRateResolution {
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
  if (displayRate !== effectiveRate) {
    return {
      ok: false,
      code: "TAX_RATE_EVIDENCE_INCONSISTENT",
      message: `Tax type ${input.taxType} reports a DisplayTaxRate that differs from its EffectiveRate.`,
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
    expectedRate: fixedRate(effectiveRate),
  };
}
