import { z } from "zod/v4";
import type {
  AccountingCaseTarget,
  EmployeeExpenseFact,
  NativeDocumentFact,
  PrepaymentFact,
} from "../domain/accountingCase.js";
import type {
  AccountingPolicyEnforcementContract,
  AccountingPolicyMonetaryRule,
  AccountingPolicyNativeDocumentDecision,
} from "../control-kernel/accountingPolicyEnforcementContract.js";
import { LEDGER_CURRENCY_MINOR_UNITS } from "./ledgerCurrencyUnits.js";
import {
  parseXeroDeclaredLedgerBinding,
  xeroDeclaredLedgerAccount,
  xeroDeclaredLedgerAccountReason,
  xeroDeclaredLedgerTaxRate,
  xeroDeclaredLedgerTaxTypeReason,
  xeroTaxRateAppliesToAccountClass,
  type XeroDeclaredLedgerBinding,
} from "./xeroDeclaredLedgerBinding.js";

/**
 * The ledger-gateway replacement for the retired Singapore accounting policy.
 *
 * This implementation makes **no accounting judgment**. The caller declares the
 * exact Xero-native account code and TaxType for every line; this policy only
 * proves those declarations against the target tenant's live chart of accounts
 * and tax-rate table, and substitutes the tenant's *real* tax rate for the
 * caller's opinion so the compiler's zero-tolerance arithmetic decides whether
 * the declared tax amount is correct.
 *
 * ## Opaque carriers in the kernel decision
 *
 * `AccountingPolicyNativeDocumentLineDecision` keeps its historical field
 * names, but under this implementation they no longer carry jurisdiction
 * semantics:
 *
 * - `accountingCategory` carries the **declared Xero account code** verbatim.
 * - `taxClass` carries the **declared Xero TaxType** verbatim.
 * - `taxSemantics` is the same declared TaxType (identity, no mapping table).
 * - `effectiveTaxRateBps` is the **tenant's live rate** for that TaxType.
 * - `exemptClassification` / `taxPolicyPeriodId` are never emitted.
 *
 * The shared kernel treats all of these as opaque strings, so nothing downstream
 * may reinterpret them as the old semantic category / tax-class vocabulary.
 */

export const XERO_DECLARED_LEDGER_POLICY_ID = "xero-declared-ledger";
export const XERO_DECLARED_LEDGER_POLICY_VERSION = "v1";
export const XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION =
  "xero-declared-ledger-policy-projection:v1";

const DECLARED_LEDGER_MONETARY_RULE_VERSION = "currency-rounding:v1";

const projectionSchema = z.object({
  schemaVersion: z.literal(XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION),
  policyId: z.literal(XERO_DECLARED_LEDGER_POLICY_ID),
  policyVersion: z.literal(XERO_DECLARED_LEDGER_POLICY_VERSION),
  /** Tenant country code. Informational evidence; never used to select rules. */
  jurisdiction: z.string().min(1).max(16),
  organisation: z.object({
    /** Live provider evidence retained only for the organisation staleness check. */
    paysTax: z.boolean(),
  }).strict(),
  ledgerBinding: z.unknown(),
  monetaryRules: z.object({
    ruleVersion: z.literal(DECLARED_LEDGER_MONETARY_RULE_VERSION),
    roundingMode: z.enum(["HALF_UP", "HALF_EVEN"]),
    taxAggregation: z.enum(["PER_LINE", "DOCUMENT_TOTAL"]),
    currencyMinorUnitScales: z.record(
      z.string().regex(/^[A-Z]{3}$/u),
      z.number().int().min(0).max(4),
    ),
  }).strict(),
}).strict();

type XeroDeclaredLedgerPolicyProjection = z.infer<typeof projectionSchema>;

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

function monetaryRuleFromProjection(
  projection: XeroDeclaredLedgerPolicyProjection,
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

function nativeDecision(
  projection: XeroDeclaredLedgerPolicyProjection,
  binding: XeroDeclaredLedgerBinding,
  fact: NativeDocumentFact,
): AccountingPolicyNativeDocumentDecision {
  const reasons: string[] = [];
  if (!monetaryRuleFromProjection(projection, fact.currency)) {
    reasons.push("ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED");
  }
  if (fact.documentKind === "CREDIT_NOTE" &&
      (!fact.originalDocumentReference || !fact.originalDocumentReferenceKind ||
       !fact.originalDocumentDate || !fact.originalTransactionEvidenceHash)) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_REQUIRED");
  }

  const lineDecisions = fact.lines.map((line) => {
    const lineReasons: string[] = [];
    const account = xeroDeclaredLedgerAccount(binding, line.accountCode);
    if (!account) lineReasons.push(xeroDeclaredLedgerAccountReason(binding, line.accountCode));
    const taxRate = xeroDeclaredLedgerTaxRate(binding, line.taxType);
    if (!taxRate) lineReasons.push(xeroDeclaredLedgerTaxTypeReason(binding, line.taxType));
    if (account && taxRate && !xeroTaxRateAppliesToAccountClass(taxRate, account.accountClass)) {
      lineReasons.push("DECLARED_TAX_TYPE_NOT_APPLICABLE_TO_ACCOUNT_CLASS");
    }
    return Object.freeze({
      lineId: line.lineId,
      // Opaque carriers: the declared Xero-native coordinates, never a category.
      accountingCategory: account ? account.accountCode : line.accountCode,
      taxClass: line.taxType,
      // The tenant's live rate, not the caller's opinion.
      effectiveTaxRateBps: taxRate?.effectiveTaxRateBps ?? 0,
      taxSemantics: line.taxType,
      lineFields: Object.freeze({}),
      reasonCodes: uniqueSorted(lineReasons),
    });
  });

  // Xero's NoTax line-amount type is only self-consistent when every declared
  // TaxType resolves to a zero live rate. Any other combination must be
  // Exclusive so the provider computes tax from the sealed per-line rate.
  const everyLineZeroRated = lineDecisions.every((decision) => decision.effectiveTaxRateBps === 0);
  if (fact.lineAmountType !== "EXCLUSIVE" &&
      !(fact.lineAmountType === "NO_TAX" && everyLineZeroRated)) {
    reasons.push("DOCUMENT_LINE_AMOUNT_TYPE_MISMATCH");
  }

  return Object.freeze({
    documentFields: Object.freeze({}),
    lineDecisions: Object.freeze(lineDecisions),
    reasonCodes: uniqueSorted([
      ...reasons,
      ...lineDecisions.flatMap((decision) => decision.reasonCodes),
    ]),
  });
}

function monetaryStructureReasons(
  projection: XeroDeclaredLedgerPolicyProjection,
  currency: string,
): string[] {
  const monetaryRule = monetaryRuleFromProjection(projection, currency);
  if (!monetaryRule) return ["ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED"];
  if (monetaryRule.roundingMode !== "HALF_UP" || monetaryRule.taxAggregation !== "PER_LINE") {
    return ["ACCOUNTING_MONETARY_RULE_UNSUPPORTED"];
  }
  return [];
}

function contractFromProjection(
  rawProjection: Readonly<Record<string, unknown>>,
): AccountingPolicyEnforcementContract {
  const projection = projectionSchema.parse(rawProjection);
  const binding = parseXeroDeclaredLedgerBinding(projection.ledgerBinding);
  const sealedProjection = Object.freeze(structuredClone(projection)) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    policyId: projection.policyId,
    policyVersion: projection.policyVersion,
    jurisdiction: projection.jurisdiction,
    planProjection: sealedProjection,
    monetaryRule(currency: string) {
      return monetaryRuleFromProjection(projection, currency);
    },
    evaluateNativeDocument(fact: NativeDocumentFact, _target: AccountingCaseTarget) {
      return nativeDecision(projection, binding, fact);
    },
    validatePrepayment(fact: PrepaymentFact) {
      // Structural only. A prepayment carries no declared ledger coordinate, so
      // the gateway can prove arithmetic shape and explicit customer
      // confirmation, and nothing about its accounting treatment.
      return uniqueSorted([
        ...monetaryStructureReasons(projection, fact.currency),
        ...(fact.customerConfirmed ? [] : ["PREPAYMENT_CUSTOMER_UNCONFIRMED"]),
      ]);
    },
    validateEmployeeExpense(fact: EmployeeExpenseFact) {
      return uniqueSorted(monetaryStructureReasons(projection, fact.currency));
    },
  });
}

export function createXeroDeclaredLedgerPolicy(
  input: Readonly<{
    jurisdiction: string;
    paysTax: boolean;
    ledgerBinding: XeroDeclaredLedgerBinding;
  }>,
): AccountingPolicyEnforcementContract {
  return contractFromProjection(projectionSchema.parse({
    schemaVersion: XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
    policyId: XERO_DECLARED_LEDGER_POLICY_ID,
    policyVersion: XERO_DECLARED_LEDGER_POLICY_VERSION,
    jurisdiction: input.jurisdiction,
    organisation: { paysTax: input.paysTax },
    ledgerBinding: parseXeroDeclaredLedgerBinding(input.ledgerBinding),
    monetaryRules: {
      ruleVersion: DECLARED_LEDGER_MONETARY_RULE_VERSION,
      roundingMode: "HALF_UP",
      taxAggregation: "PER_LINE",
      currencyMinorUnitScales: LEDGER_CURRENCY_MINOR_UNITS,
    },
  }) as Readonly<Record<string, unknown>>);
}

export function createXeroDeclaredLedgerPolicyFromProjection(
  projection: Readonly<Record<string, unknown>>,
): AccountingPolicyEnforcementContract {
  return contractFromProjection(projection);
}

export function xeroDeclaredLedgerBindingFromPolicyProjection(
  projection: Readonly<Record<string, unknown>>,
): XeroDeclaredLedgerBinding {
  return parseXeroDeclaredLedgerBinding(projectionSchema.parse(projection).ledgerBinding);
}
