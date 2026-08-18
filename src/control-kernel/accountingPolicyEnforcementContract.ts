import type {
  AccountingCaseTarget,
  EmployeeExpenseFact,
  NativeDocumentFact,
  NativeDocumentLine,
  PrepaymentFact,
} from "../domain/accountingCase.js";

/**
 * One immutable accounting-policy decision for a native ledger document.
 *
 * The shared compiler deliberately treats tax classes, tax semantics,
 * jurisdiction rules and chart-of-accounts references as opaque policy data.
 * A jurisdiction/tenant policy adapter owns their meaning and returns only the
 * deterministic projection that may be sealed into a Case plan.
 */
export interface AccountingPolicyNativeDocumentDecision {
  readonly documentFields: Readonly<Record<string, unknown>>;
  readonly lineDecisions: readonly AccountingPolicyNativeDocumentLineDecision[];
  readonly reasonCodes: readonly string[];
}

/**
 * One policy decision for one immutable source line; order is not identity.
 *
 * ## These field names are historical; they carry no semantics of their own
 *
 * The shared kernel treats `accountingCategory`, `taxClass`, `taxSemantics`,
 * `exemptClassification` and `taxPolicyPeriodId` as **opaque strings** chosen by
 * the injected policy adapter. They are sealed into the plan, compared for
 * equality, and hashed — never parsed, mapped, or ranked.
 *
 * Under the released ledger-gateway policy
 * (`src/policy/xeroDeclaredLedgerPolicy.ts`) the carriers are:
 *
 * - `accountingCategory` = the caller-declared **Xero account code**;
 * - `taxClass` = the caller-declared **Xero TaxType**;
 * - `taxSemantics` = the same TaxType (identity, no mapping table);
 * - `effectiveTaxRateBps` = the **target tenant's live rate** for that TaxType;
 * - `exemptClassification` / `taxPolicyPeriodId` = never emitted.
 *
 * They are explicitly **not** the retired semantic-category / jurisdiction
 * tax-class vocabulary, and no consumer may reinterpret them as such.
 */
export interface AccountingPolicyNativeDocumentLineDecision {
  readonly lineId: NativeDocumentLine["lineId"];
  readonly accountingCategory: string;
  readonly taxClass: string;
  readonly exemptClassification?: string;
  readonly effectiveTaxRateBps: number;
  readonly taxSemantics: string;
  readonly taxPolicyPeriodId?: string;
  readonly lineFields: Readonly<Record<string, unknown>>;
  readonly reasonCodes: readonly string[];
}

/**
 * Currency arithmetic owned by the injected accounting policy.
 *
 * Amounts remain fixed-decimal strings in the public contract.  The shared
 * compiler uses this rule with integer arithmetic only; a provider adapter
 * must never infer a scale or rounding convention from JavaScript Number.
 * Additional modes are named here so a later compiler can add them without
 * coupling the accounting-policy contract to one provider.  The current
 * compiler deliberately fails closed for every mode except HALF_UP/PER_LINE.
 */
export interface AccountingPolicyMonetaryRule {
  readonly currency: string;
  readonly minorUnitScale: 0 | 1 | 2 | 3 | 4;
  readonly roundingMode: "HALF_UP" | "HALF_EVEN";
  readonly taxAggregation: "PER_LINE" | "DOCUMENT_TOTAL";
}

/**
 * Provider-independent accounting policy injected separately from the ledger
 * provider adapter. The projection must contain every jurisdiction, tenant and
 * policy-profile input used by these methods so a persisted plan can be
 * deterministically rehydrated and revalidated.
 */
export interface AccountingPolicyEnforcementContract {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly jurisdiction: string;
  readonly planProjection: Readonly<Record<string, unknown>>;
  monetaryRule(currency: string): AccountingPolicyMonetaryRule | undefined;
  evaluateNativeDocument(
    fact: NativeDocumentFact,
    target: AccountingCaseTarget,
  ): AccountingPolicyNativeDocumentDecision;
  validatePrepayment(
    fact: PrepaymentFact,
    target: AccountingCaseTarget,
  ): readonly string[];
  validateEmployeeExpense(
    fact: EmployeeExpenseFact,
    target: AccountingCaseTarget,
  ): readonly string[];
}
