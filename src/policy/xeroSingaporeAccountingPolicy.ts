import { z } from "zod/v4";
import {
  resolveNativeDocumentLineAccounting,
  type AccountingCaseTarget,
  type EmployeeExpenseFact,
  type NativeDocumentFact,
  type PrepaymentFact,
} from "../domain/accountingCase.js";
import type {
  AccountingPolicyEnforcementContract,
  AccountingPolicyMonetaryRule,
  AccountingPolicyNativeDocumentDecision,
} from "../control-kernel/accountingPolicyEnforcementContract.js";

const SCALE_FACTOR = 10_000n;

/** Public business vocabulary is owned by the versioned jurisdiction policy. */
export const XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS = [
  "CONSULTING_REVENUE",
  "OFFICE_SUPPLIES",
  "CLOUD_SUBSCRIPTIONS",
] as const;

export const XERO_SINGAPORE_TAX_CLASS_KEYS = [
  "SG_STANDARD_RATED",
  "NO_TAX",
  "ZERO_RATED",
  "OUT_OF_SCOPE",
  "EXEMPT",
] as const;

export const XERO_SINGAPORE_ACCOUNTING_POLICY_VERSION = "xero-sg-accounting-policy-v8-2026h2";
export const XERO_SINGAPORE_ACCOUNTING_POLICY_PROJECTION_VERSION =
  "xero-sg-accounting-policy-projection:v4";

const XERO_SINGAPORE_MONETARY_RULE_VERSION = "currency-rounding:v1";

const SG_POLICY_PERIODS = Object.freeze([Object.freeze({
  policyPeriodId: "SG_GST_9_2024_TO_2026H2",
  startsOn: "2024-01-01",
  endsOn: "2026-12-31",
  rateBps: 900,
})]);

const SG_CATEGORY_POLICY: Readonly<Record<
  typeof XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS[number],
  Readonly<{ allowedRole: "CUSTOMER" | "SUPPLIER" }>
>> = Object.freeze({
  CONSULTING_REVENUE: Object.freeze({ allowedRole: "CUSTOMER" }),
  OFFICE_SUPPLIES: Object.freeze({ allowedRole: "SUPPLIER" }),
  CLOUD_SUBSCRIPTIONS: Object.freeze({ allowedRole: "SUPPLIER" }),
} as const);

const SG_CURRENCY_MINOR_UNIT_SCALES = Object.freeze({
  HKD: 2,
  JPY: 0,
  SGD: 2,
  USD: 2,
} as const);

const projectionSchema = z.object({
  schemaVersion: z.literal(XERO_SINGAPORE_ACCOUNTING_POLICY_PROJECTION_VERSION),
  policyId: z.literal("xero-singapore"),
  policyVersion: z.literal(XERO_SINGAPORE_ACCOUNTING_POLICY_VERSION),
  jurisdiction: z.literal("SG"),
  organisation: z.object({
    paysTax: z.boolean(),
  }).strict(),
  periods: z.array(z.object({
    policyPeriodId: z.string().min(1),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    rateBps: z.number().int().min(0).max(10_000),
  }).strict()).min(1),
  categories: z.record(z.string().min(1), z.object({
    allowedRole: z.enum(["CUSTOMER", "SUPPLIER"]),
  }).strict()),
  monetaryRules: z.object({
    ruleVersion: z.literal(XERO_SINGAPORE_MONETARY_RULE_VERSION),
    roundingMode: z.enum(["HALF_UP", "HALF_EVEN"]),
    taxAggregation: z.enum(["PER_LINE", "DOCUMENT_TOTAL"]),
    currencyMinorUnitScales: z.record(
      z.string().regex(/^[A-Z]{3}$/u),
      z.number().int().min(0).max(4),
    ),
  }).strict(),
}).strict();

type XeroSingaporePolicyProjection = z.infer<typeof projectionSchema>;

function decimalMinor(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const scaled = BigInt(whole) * SCALE_FACTOR + BigInt((fraction + "0000").slice(0, 4));
  return negative ? -scaled : scaled;
}

function minorUnitScale(value: number): AccountingPolicyMonetaryRule["minorUnitScale"] {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      return value;
    default:
      throw new Error("Accounting policy minor-unit scale is outside the fixed-decimal compiler range.");
  }
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const quotient = unsigned / divisor;
  const remainder = unsigned % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  return negative ? -rounded : rounded;
}

/** Round a fixed-four amount multiplied by a basis-point rate back to fixed four. */
function roundedPercentage(value: bigint, rateBps: number, scale: number): bigint {
  const divisor = 10n ** BigInt(8 - scale);
  const minorUnits = roundHalfUp(value * BigInt(rateBps), divisor);
  return minorUnits * (10n ** BigInt(4 - scale));
}

function monetaryRuleFromProjection(
  projection: XeroSingaporePolicyProjection,
  currency: string,
): AccountingPolicyMonetaryRule | undefined {
  const scale = projection.monetaryRules.currencyMinorUnitScales[currency];
  if (scale === undefined) return undefined;
  return Object.freeze({
    currency,
    minorUnitScale: minorUnitScale(scale),
    roundingMode: projection.monetaryRules.roundingMode,
    taxAggregation: projection.monetaryRules.taxAggregation,
  });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function defaultProjection(paysTax: boolean): XeroSingaporePolicyProjection {
  return projectionSchema.parse({
    schemaVersion: XERO_SINGAPORE_ACCOUNTING_POLICY_PROJECTION_VERSION,
    policyId: "xero-singapore",
    policyVersion: XERO_SINGAPORE_ACCOUNTING_POLICY_VERSION,
    jurisdiction: "SG",
    organisation: { paysTax },
    periods: SG_POLICY_PERIODS,
    categories: SG_CATEGORY_POLICY,
    monetaryRules: {
      ruleVersion: XERO_SINGAPORE_MONETARY_RULE_VERSION,
      roundingMode: "HALF_UP",
      taxAggregation: "PER_LINE",
      currencyMinorUnitScales: SG_CURRENCY_MINOR_UNIT_SCALES,
    },
  });
}

function nativeDecision(
  projection: XeroSingaporePolicyProjection,
  fact: NativeDocumentFact,
  target: AccountingCaseTarget,
): AccountingPolicyNativeDocumentDecision {
  const reasons: string[] = [];
  if (target.taxJurisdiction !== projection.jurisdiction) reasons.push("UNSUPPORTED_TAX_JURISDICTION");
  if (!monetaryRuleFromProjection(projection, fact.currency)) {
    reasons.push("ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED");
  }
  const expectedBasis = fact.documentKind === "CREDIT_NOTE"
    ? "ORIGINAL_TRANSACTION"
    : "DOCUMENT_DATE_NON_TRANSITION";
  if (fact.taxPolicyBasis === "TRANSITION_REVIEW_REQUIRED") reasons.push("SG_GST_TRANSITION_REVIEW_REQUIRED");
  else if (fact.taxPolicyBasis !== expectedBasis) reasons.push("SG_TAX_POLICY_BASIS_INVALID");
  if (fact.documentKind === "CREDIT_NOTE" &&
      (!fact.originalDocumentReference || !fact.originalDocumentReferenceKind ||
       !fact.originalDocumentDate || !fact.originalTransactionEvidenceHash)) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_REQUIRED");
  }
  const basisDate = fact.documentKind === "CREDIT_NOTE" ? fact.originalDocumentDate : fact.documentDate;
  const period = basisDate
    ? projection.periods.find((candidate) => basisDate >= candidate.startsOn && basisDate <= candidate.endsOn)
    : undefined;
  if (!period) reasons.push("SG_TAX_POLICY_PERIOD_UNSUPPORTED");

  const resolvedLines = fact.lines.map((line) => ({
    line,
    accounting: resolveNativeDocumentLineAccounting(fact, line),
  }));
  const expectedLineAmountType = resolvedLines.every(({ accounting }) => accounting.taxClass === "NO_TAX")
    ? "NO_TAX"
    : "EXCLUSIVE";
  if (fact.lineAmountType !== expectedLineAmountType) reasons.push("DOCUMENT_LINE_AMOUNT_TYPE_MISMATCH");

  const lineDecisions = resolvedLines.map(({ line, accounting }) => {
    const lineReasons: string[] = [];
    const category = projection.categories[accounting.accountingCategory];
    if (!category) lineReasons.push("ACCOUNTING_CATEGORY_POLICY_UNKNOWN");
    else if (category.allowedRole !== fact.counterpartyRole) {
      lineReasons.push("ACCOUNTING_CATEGORY_ROLE_MISMATCH");
    }

    const standardRated = accounting.taxClass === "SG_STANDARD_RATED";
    if (standardRated) {
      if (accounting.effectiveTaxRateBps <= 0) lineReasons.push("SG_EFFECTIVE_TAX_RATE_INVALID");
      if (period && accounting.effectiveTaxRateBps !== period.rateBps) {
        lineReasons.push("SG_EFFECTIVE_TAX_RATE_MISMATCH");
      }
      if (!projection.organisation.paysTax) lineReasons.push("ORGANISATION_NOT_GST_REGISTERED");
    } else if (accounting.effectiveTaxRateBps !== 0) {
      lineReasons.push("SG_ZERO_TAX_CLASS_RATE_MISMATCH");
    }

    let taxSemantics: string;
    switch (accounting.taxClass) {
      case "SG_STANDARD_RATED":
        taxSemantics = fact.counterpartyRole === "CUSTOMER" ? "STANDARD_OUTPUT" : "STANDARD_INPUT";
        break;
      case "NO_TAX":
        taxSemantics = "NO_TAX";
        break;
      case "ZERO_RATED":
        taxSemantics = fact.counterpartyRole === "CUSTOMER" ? "ZERO_RATED_OUTPUT" : "ZERO_RATED_INPUT";
        break;
      case "OUT_OF_SCOPE":
        taxSemantics = fact.counterpartyRole === "CUSTOMER" ? "OUT_OF_SCOPE_OUTPUT" : "OUT_OF_SCOPE_INPUT";
        break;
      case "EXEMPT":
        if (fact.counterpartyRole === "SUPPLIER") taxSemantics = "EXEMPT_INPUT";
        else if (accounting.exemptClassification === "REGULATION_33") {
          taxSemantics = "EXEMPT_OUTPUT_REGULATION_33";
        } else if (accounting.exemptClassification === "NON_REGULATION_33") {
          taxSemantics = "EXEMPT_OUTPUT_NON_REGULATION_33";
        } else {
          taxSemantics = "UNRESOLVED";
          lineReasons.push("ACCOUNTING_TAX_EXEMPT_CLASSIFICATION_REQUIRED");
        }
        break;
      default:
        taxSemantics = "UNRESOLVED";
        lineReasons.push("ACCOUNTING_TAX_CLASS_POLICY_UNKNOWN");
    }
    if (!standardRated && decimalMinor(line.sourceTax) !== 0n) {
      lineReasons.push(`${accounting.taxClass}_REQUIRES_ZERO_TAX`);
    }
    return Object.freeze({
      lineId: line.lineId,
      accountingCategory: accounting.accountingCategory,
      taxClass: accounting.taxClass,
      ...(accounting.exemptClassification
        ? { exemptClassification: accounting.exemptClassification }
        : {}),
      effectiveTaxRateBps: standardRated ? accounting.effectiveTaxRateBps : 0,
      taxSemantics,
      ...(period ? { taxPolicyPeriodId: period.policyPeriodId } : {}),
      // Tenant-local AccountID/code ownership belongs to the provider adapter.
      // The jurisdiction policy emits only the semantic category decision.
      lineFields: Object.freeze({}),
      reasonCodes: uniqueSorted(lineReasons),
    });
  });
  return Object.freeze({
    documentFields: Object.freeze({}),
    lineDecisions: Object.freeze(lineDecisions),
    reasonCodes: uniqueSorted([
      ...reasons,
      ...lineDecisions.flatMap((decision) => decision.reasonCodes),
    ]),
  });
}

function contractFromProjection(
  rawProjection: Readonly<Record<string, unknown>>,
): AccountingPolicyEnforcementContract {
  const projection = projectionSchema.parse(rawProjection);
  const sealedProjection = Object.freeze(structuredClone(projection)) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    policyId: projection.policyId,
    policyVersion: projection.policyVersion,
    jurisdiction: projection.jurisdiction,
    planProjection: sealedProjection,
    monetaryRule(currency: string) {
      return monetaryRuleFromProjection(projection, currency);
    },
    evaluateNativeDocument(fact: NativeDocumentFact, target: AccountingCaseTarget) {
      return nativeDecision(projection, fact, target);
    },
    validatePrepayment(fact: PrepaymentFact) {
      const reasons: string[] = [];
      const net = decimalMinor(fact.net);
      const tax = decimalMinor(fact.tax);
      const monetaryRule = monetaryRuleFromProjection(projection, fact.currency);
      if (!monetaryRule) reasons.push("ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED");
      else if (monetaryRule.roundingMode !== "HALF_UP" || monetaryRule.taxAggregation !== "PER_LINE") {
        reasons.push("ACCOUNTING_MONETARY_RULE_UNSUPPORTED");
      }
      const period = projection.periods.find((candidate) =>
        fact.date >= candidate.startsOn && fact.date <= candidate.endsOn);
      if (!period) reasons.push("SG_TAX_POLICY_PERIOD_UNSUPPORTED");
      else if (monetaryRule && monetaryRule.roundingMode === "HALF_UP" &&
          monetaryRule.taxAggregation === "PER_LINE" &&
          roundedPercentage(net, period.rateBps, monetaryRule.minorUnitScale) !== tax) {
        reasons.push("PREPAYMENT_GST_MISMATCH");
      }
      if (!projection.organisation.paysTax && tax !== 0n) reasons.push("ORGANISATION_NOT_GST_REGISTERED");
      if (!fact.customerConfirmed) reasons.push("PREPAYMENT_CUSTOMER_UNCONFIRMED");
      return uniqueSorted(reasons);
    },
    validateEmployeeExpense(fact: EmployeeExpenseFact) {
      const reasons: string[] = [];
      const monetaryRule = monetaryRuleFromProjection(projection, fact.currency);
      if (!monetaryRule) reasons.push("ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED");
      else if (monetaryRule.roundingMode !== "HALF_UP" || monetaryRule.taxAggregation !== "PER_LINE") {
        reasons.push("ACCOUNTING_MONETARY_RULE_UNSUPPORTED");
      }
      for (const line of fact.lines) {
        const net = decimalMinor(line.net);
        const tax = decimalMinor(line.tax);
        const period = projection.periods.find((candidate) =>
          line.expenseDate >= candidate.startsOn && line.expenseDate <= candidate.endsOn);
        if (line.taxSemantics === "NONE" && tax !== 0n) reasons.push("EXPENSE_NO_TAX_LINE_HAS_TAX");
        else if (line.taxSemantics === "STANDARD_INPUT") {
          if (!period) reasons.push("SG_TAX_POLICY_PERIOD_UNSUPPORTED");
          else if (monetaryRule && monetaryRule.roundingMode === "HALF_UP" &&
              monetaryRule.taxAggregation === "PER_LINE" &&
              roundedPercentage(net, period.rateBps, monetaryRule.minorUnitScale) !== tax) {
            reasons.push("EXPENSE_INPUT_GST_MISMATCH");
          }
          if (!projection.organisation.paysTax) reasons.push("ORGANISATION_NOT_GST_REGISTERED");
          if (line.receiptStatus === "MISSING") reasons.push("MISSING_RECEIPT_CANNOT_CLAIM_GST");
        } else if (line.taxSemantics !== "NONE") {
          reasons.push("EXPENSE_TAX_SEMANTICS_POLICY_UNKNOWN");
        }
      }
      return uniqueSorted(reasons);
    },
  });
}

export function createXeroSingaporeAccountingPolicy(
  input: Readonly<{ paysTax: boolean }>,
): AccountingPolicyEnforcementContract {
  return contractFromProjection(defaultProjection(input.paysTax));
}

export function createXeroSingaporeAccountingPolicyFromProjection(
  projection: Readonly<Record<string, unknown>>,
): AccountingPolicyEnforcementContract {
  return contractFromProjection(projection);
}
