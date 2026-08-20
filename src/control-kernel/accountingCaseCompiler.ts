import { hashObject } from "../security/hash.js";
import {
  ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
  ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
  accountingCaseBusinessReservationsOverlap,
  ACCOUNTING_CASE_COMPILER_VERSION,
  originalTransactionEvidenceHash,
  type AccountingAmountBridge,
  type AccountingCaseOperation,
  type AccountingCaseTarget,
  type AccountingEvent,
  type AccountingEventDisposition,
  type AccountingFact,
  type AccountingFactKind,
  type AccountingSourceArtifact,
  type BalancedJournalFact,
  type BalancedJournalRoute,
  type BankStatementSummaryFact,
  type CommercialDocumentFact,
  type CommercialDocumentRoute,
  type CompiledAccountingCase,
  type ContactCandidateFact,
  type EmployeeExpenseFact,
  type FxSettlementFact,
  type GoodsReceiptControlFact,
  type LedgerStateTransitionFact,
  type LedgerStateTransitionRoute,
  type LedgerAdjustmentFact,
  type LedgerAdjustmentRoute,
  type PaymentBankLedgerFact,
  type PaymentBankLedgerRoute,
  type DraftDocumentUpdateFact,
  type NativeDocumentFact,
  type NativeDocumentRoute,
  type OriginalTransactionEvidenceFact,
  type PrepaymentFact,
  type ReferenceDataRoute,
} from "../domain/accountingCase.js";
import { parseLedgerAdjustmentPayload } from "../domain/xeroLedgerAdjustment.js";
import {
  prepareAccountingCaseSchema,
  type PrepareAccountingCaseInput,
} from "../domain/accountingCaseSchemas.js";
import type { AccountingCaseProviderEnforcementContract } from "./accountingCaseProviderContract.js";
import type {
  AccountingPolicyEnforcementContract,
  AccountingPolicyNativeDocumentDecision,
} from "./accountingPolicyEnforcementContract.js";
import {
  formatAccountingFixedFour,
  parseAccountingFixedDecimal,
  quantizeAccountingLineNet,
  quantizeAccountingLineTax,
  resolveSupportedAccountingMonetaryRule,
  type SupportedAccountingMonetaryRule,
} from "./accountingMonetary.js";

const SCALE_FACTOR = 10_000n;

export type AccountingCaseCompilationReason =
  | "ACCOUNTING_TAX_EXEMPT_CLASSIFICATION_REQUIRED"
  | "ACCOUNTING_POLICY_JURISDICTION_MISMATCH"
  | "MULTIPLE_PRIMARY_EFFECTS"
  | "PAYMENT_NATIVE_DOCUMENT_RELATION_MISSING"
  | "PAYMENT_DIRECTION_MISMATCH"
  | "PAYMENT_DOCUMENT_BRIDGE_MISMATCH"
  | "FX_SUPPLIER_INVOICE_RELATION_MISSING"
  | "FX_CURRENCY_RELATION_INVALID"
  | "EVIDENCE_EVENT_RELATION_MISSING"
  | "CONTROL_EVENT_RELATION_MISSING"
  | "GOODS_RECEIPT_RELATION_MISSING"
  | "PLANNED_BUSINESS_DUPLICATE"
  | "ACCOUNTING_MONETARY_RULE_INVALID"
  | "ACCOUNTING_POLICY_LINE_DECISION_INVALID"
  | "SOURCE_FACT_KIND_UNDECLARED";

/**
 * Deterministic source/graph failures are user-data validation findings, not
 * Provider failures.  Keep a typed diagnostic at the compiler boundary so
 * every caller can preserve one stable reason/path without message matching.
 */
export class AccountingCaseCompilationError extends Error {
  readonly reasonCode: AccountingCaseCompilationReason;
  readonly path: string;

  constructor(reasonCode: AccountingCaseCompilationReason, path: string, message: string) {
    super(message);
    this.name = "AccountingCaseCompilationError";
    this.reasonCode = reasonCode;
    this.path = path;
  }
}

function compilationFailure(
  reasonCode: AccountingCaseCompilationReason,
  path: string,
  message: string,
): never {
  throw new AccountingCaseCompilationError(reasonCode, path, message);
}

const PRIMARY_FACT_KINDS = new Set<AccountingFactKind>([
  "CONTACT_CANDIDATE",
  "CONTACT_BASIC_UPDATE",
  "ITEM_BASIC_CREATE_UNTRACKED",
  "ITEM_BASIC_UPDATE_UNTRACKED",
  "TRACKING_REFERENCE_DATA",
  "NATIVE_DOCUMENT",
  "COMMERCIAL_DOCUMENT",
  "BALANCED_JOURNAL",
  "DRAFT_DOCUMENT_UPDATE",
  "LEDGER_STATE_TRANSITION",
  "LEDGER_ADJUSTMENT",
  "PAYMENT_BANK_LEDGER",
  "PAYMENT",
  "BANK_FEE",
  "PREPAYMENT",
  "EMPLOYEE_EXPENSE",
  "FX_SETTLEMENT",
  "OPENING_BALANCE_REVIEW",
  "BANK_STATEMENT_SUMMARY",
  "GOODS_RECEIPT_CONTROL",
]);

function decimalMinor(value: string): bigint {
  return parseAccountingFixedDecimal(value);
}

function fixedFour(value: bigint): string {
  return formatAccountingFixedFour(value);
}

function normalizedOriginalReference(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

function multiplyScaled(left: bigint, right: bigint): { value: bigint; exact: boolean } {
  const product = left * right;
  return { value: product / SCALE_FACTOR, exact: product % SCALE_FACTOR === 0n };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function contactSupportsNativeDocument(
  contact: ContactCandidateFact,
  document: NativeDocumentFact,
): boolean {
  if (!contact.usageRoles.includes(document.counterpartyRole)) return false;
  if (contact.name.toLocaleLowerCase("en") !== document.contactName.toLocaleLowerCase("en")) return false;
  if (contact.durableIdentity !== undefined || document.contactDurableIdentity !== undefined) {
    return contact.durableIdentity !== undefined && document.contactDurableIdentity !== undefined &&
      hashObject(contact.durableIdentity) === hashObject(document.contactDurableIdentity);
  }
  return true;
}

function activeFacts(facts: readonly AccountingFact[]): AccountingFact[] {
  const superseded = new Set(facts.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
  return facts.filter((fact) => !superseded.has(fact.factId))
    .sort((a, b) => a.factId.localeCompare(b.factId));
}

function nativeRoute(fact: NativeDocumentFact): NativeDocumentRoute {
  if (fact.documentKind === "INVOICE") {
    return fact.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
  }
  return fact.counterpartyRole === "CUSTOMER" ? "CUSTOMER_CREDIT" : "SUPPLIER_CREDIT";
}

function nativeAction(route: NativeDocumentRoute): AccountingCaseOperation["actionId"] {
  switch (route) {
    case "SALES_INVOICE": return "customer_invoice.create_draft";
    case "SUPPLIER_BILL": return "supplier_bill.create_draft";
    case "CUSTOMER_CREDIT":
    case "SUPPLIER_CREDIT": return "credit_note.create_draft";
  }
}

function sealedBusinessIdentity(
  provider: AccountingCaseProviderEnforcementContract,
  fact: ContactCandidateFact | NativeDocumentFact,
  target: AccountingCaseTarget,
) {
  const projection = provider.businessIdentity(fact, target);
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: provider.providerId,
    kind: projection.kind,
    canonicalFields: Object.freeze(structuredClone(projection.canonicalFields)),
  });
  const coordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: provider.providerId,
    kind: projection.reservation.kind,
    canonicalFields: Object.freeze(structuredClone(projection.reservation.canonicalFields)),
  });
  const businessReservation = projection.reservation.scope === "DATED_OCCURRENCE"
    ? Object.freeze({
        ...coordinate,
        coordinateHash: hashObject(coordinate),
        scope: "DATED_OCCURRENCE" as const,
        occurrenceDate: projection.reservation.occurrenceDate,
      })
    : Object.freeze({
        ...coordinate,
        coordinateHash: hashObject(coordinate),
        scope: "ALL_OCCURRENCES" as const,
      });
  return Object.freeze({
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation,
  });
}

function eventId(caseId: string, eventKey: string): string {
  return `evt_${hashObject({ caseId, eventKey }).slice(0, 24)}`;
}

function lineCompilation(
  fact: NativeDocumentFact,
  policyDecision: AccountingPolicyNativeDocumentDecision,
  monetaryRule: SupportedAccountingMonetaryRule,
): {
  lines: Array<Record<string, unknown>>;
  lineBridges: AccountingAmountBridge["lineBridges"];
  net: bigint;
  tax: bigint;
  gross: bigint;
  /** True when the policy rejected any line, so compiled tax is not an observation. */
  anyLineRejected: boolean;
  reasonCodes: string[];
} {
  let net = 0n;
  let tax = 0n;
  const reasonCodes: string[] = [...policyDecision.reasonCodes];
  const decisionsByLineId = new Map(policyDecision.lineDecisions.map((decision) => [decision.lineId, decision]));
  if (
    decisionsByLineId.size !== fact.lines.length ||
    policyDecision.lineDecisions.length !== fact.lines.length ||
    fact.lines.some((line) => !decisionsByLineId.has(line.lineId))
  ) {
    compilationFailure(
      "ACCOUNTING_POLICY_LINE_DECISION_INVALID",
      `facts.${fact.factId}.lines`,
      "Accounting policy must return exactly one decision for every immutable source line.",
    );
  }
  const lineBridges: AccountingAmountBridge["lineBridges"] = [];
  let anyLineRejected = false;
  const lines = fact.lines.map((line) => {
    const lineDecision = decisionsByLineId.get(line.lineId)!;
    reasonCodes.push(...lineDecision.reasonCodes);
    // A rejected line's rate is a placeholder, not an observation: the policy
    // could not bind it to the ledger. Reconciling declared amounts against it
    // manufactures amount findings that point at figures which are usually
    // correct, burying the one reason that actually blocked the line. Report
    // the policy's own reasons and stop deriving from them.
    const lineRejected = lineDecision.reasonCodes.length > 0;
    anyLineRejected ||= lineRejected;
    const calculatedNet = quantizeAccountingLineNet(
      decimalMinor(line.quantity), decimalMinor(line.unitAmount), monetaryRule,
    );
    const calculatedTax = quantizeAccountingLineTax(
      calculatedNet, lineDecision.effectiveTaxRateBps, monetaryRule,
    );
    if (!lineRejected && decimalMinor(line.sourceTax) !== calculatedTax) {
      reasonCodes.push("SOURCE_LINE_TAX_MISMATCH");
    }
    net += calculatedNet;
    tax += calculatedTax;
    lineBridges.push({
      lineId: line.lineId,
      sourceTax: fixedFour(decimalMinor(line.sourceTax)),
      canonicalNet: fixedFour(calculatedNet),
      canonicalTax: fixedFour(calculatedTax),
      effectiveTaxRateBps: lineDecision.effectiveTaxRateBps,
      accountingCategory: lineDecision.accountingCategory,
      taxClass: lineDecision.taxClass,
      taxSemantics: lineDecision.taxSemantics,
      sourceLineHash: hashObject(line),
    });
    return {
      lineId: line.lineId,
      description: line.description,
      quantity: fixedFour(decimalMinor(line.quantity)),
      unitAmount: fixedFour(decimalMinor(line.unitAmount)),
      net: fixedFour(calculatedNet),
      tax: fixedFour(calculatedTax),
      accountingCategory: lineDecision.accountingCategory,
      taxClass: lineDecision.taxClass,
      ...(lineDecision.exemptClassification
        ? { exemptClassification: lineDecision.exemptClassification }
        : {}),
      effectiveTaxRateBps: lineDecision.effectiveTaxRateBps,
      taxSemantics: lineDecision.taxSemantics,
      ...(lineDecision.taxPolicyPeriodId
        ? { taxPolicyPeriodId: lineDecision.taxPolicyPeriodId }
        : {}),
      ...lineDecision.lineFields,
    };
  });
  return { lines, lineBridges, net, tax, gross: net + tax, anyLineRejected, reasonCodes: uniqueSorted(reasonCodes) };
}

function amountBridge(
  fact: NativeDocumentFact,
  policyDecision: AccountingPolicyNativeDocumentDecision,
  monetaryRule: SupportedAccountingMonetaryRule,
): { bridge: AccountingAmountBridge; reasonCodes: string[] } {
  const declaredNet = decimalMinor(fact.declaredNet);
  const declaredTax = decimalMinor(fact.declaredTax);
  const declaredGross = decimalMinor(fact.declaredGross);
  const compiled = lineCompilation(fact, policyDecision, monetaryRule);
  const reasonCodes = [...compiled.reasonCodes];
  // Declared-value arithmetic is the caller's own claim and is always checkable.
  if (declaredNet + declaredTax !== declaredGross) reasonCodes.push("SOURCE_NET_PLUS_TAX_MISMATCH");
  // Net never depends on a tax rate, so it stays checkable too.
  if (compiled.net !== declaredNet) reasonCodes.push("SOURCE_NET_MISMATCH");
  // Compiled tax and gross do depend on the per-line rate. When any line was
  // rejected its rate is a placeholder, so these two comparisons would report
  // the caller's correct figures as wrong and hide the real reason.
  if (!compiled.anyLineRejected) {
    if (compiled.tax !== declaredTax) reasonCodes.push("SOURCE_TAX_MISMATCH");
    if (compiled.gross !== declaredGross) reasonCodes.push("SOURCE_GROSS_MISMATCH");
  }
  return {
    bridge: {
      currency: fact.currency,
      sourceNet: fixedFour(declaredNet),
      sourceTax: fixedFour(declaredTax),
      sourceGross: fixedFour(declaredGross),
      canonicalNet: fixedFour(compiled.net),
      canonicalTax: fixedFour(compiled.tax),
      canonicalGross: fixedFour(compiled.gross),
      formula: "LINE_SUM_PLUS_TAX_EQUALS_GROSS",
      toleranceMinorUnits: 0,
      sourceFactIds: [fact.factId],
      sourceLineHash: hashObject(fact.lines),
      lineBridges: compiled.lineBridges,
    },
    reasonCodes: uniqueSorted(reasonCodes),
  };
}

function originalTransactionEvidenceReasons(
  fact: NativeDocumentFact,
  allFacts: readonly AccountingFact[],
  target: AccountingCaseTarget,
  policy: AccountingPolicyEnforcementContract,
): string[] {
  const matches = allFacts.filter((candidate): candidate is OriginalTransactionEvidenceFact =>
    candidate.kind === "ORIGINAL_TRANSACTION_EVIDENCE" && candidate.creditEventKey === fact.eventKey);
  if (matches.length === 0) return ["CREDIT_ORIGINAL_TRANSACTION_NOT_FOUND"];
  if (matches.length > 1) return ["CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_AMBIGUOUS"];
  const evidence = matches[0]!;
  const expectedRoute = fact.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
  const expectedProviderField = "INVOICE_NUMBER";
  const reasons: string[] = [];
  if (evidence.evidenceHash !== originalTransactionEvidenceHash(evidence)) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_HASH_MISMATCH");
  }
  if (fact.originalTransactionEvidenceHash !== evidence.evidenceHash) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_LINK_MISMATCH");
  }
  if (
    evidence.origin !== "SERVER_RESOLVED_PROVIDER_EVIDENCE" ||
    evidence.creditEligibility !== "CREDITABLE_POSTED_TRANSACTION"
  ) reasons.push("CREDIT_ORIGINAL_TRANSACTION_NOT_CREDITABLE");
  if (
    evidence.originalRoute !== expectedRoute ||
    evidence.authoritativeProviderField !== expectedProviderField ||
    evidence.reference !== normalizedOriginalReference(fact.originalDocumentReference) ||
    evidence.referenceKind !== fact.originalDocumentReferenceKind ||
    evidence.documentDate !== fact.originalDocumentDate ||
    evidence.currency !== fact.currency ||
    evidence.contactName.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") !==
      fact.contactName.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") ||
    hashObject(evidence.contactDurableIdentity ?? null) !== hashObject(fact.contactDurableIdentity ?? null)
  ) reasons.push("CREDIT_ORIGINAL_TRANSACTION_IDENTITY_MISMATCH");
  if (evidence.lineAmountType !== fact.lineAmountType) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_LINE_AMOUNT_TYPE_MISMATCH");
  }
  if (decimalMinor(evidence.net) + decimalMinor(evidence.tax) !== decimalMinor(evidence.gross)) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_TOTALS_INVALID");
  }

  const policyDecision = policy.evaluateNativeDocument(fact, target);
  const decisionByLineId = new Map(policyDecision.lineDecisions.map((decision) => [decision.lineId, decision]));
  const resolvedMoney = resolveSupportedAccountingMonetaryRule(policy, fact.currency);
  if (!resolvedMoney.rule) return uniqueSorted([...reasons, ...resolvedMoney.reasonCodes]);
  const residual = evidence.lines
    .map((line) => ({
      ...line,
      quantityRemaining: decimalMinor(line.quantity),
      netRemaining: decimalMinor(line.net),
      taxRemaining: decimalMinor(line.tax),
    }))
    .sort((left, right) => left.evidenceLineKey.localeCompare(right.evidenceLineKey));
  const evidenceNet = evidence.lines.reduce((sum, line) => sum + decimalMinor(line.net), 0n);
  const evidenceTax = evidence.lines.reduce((sum, line) => sum + decimalMinor(line.tax), 0n);
  if (evidenceNet !== decimalMinor(evidence.net) || evidenceTax !== decimalMinor(evidence.tax)) {
    reasons.push("CREDIT_ORIGINAL_TRANSACTION_LINE_TOTALS_MISMATCH");
  }

  for (const line of [...fact.lines].sort((left, right) => left.lineId.localeCompare(right.lineId))) {
    const decision = decisionByLineId.get(line.lineId);
    if (!decision) {
      reasons.push("CREDIT_ORIGINAL_TRANSACTION_POLICY_LINE_MISSING");
      continue;
    }
    const quantity = decimalMinor(line.quantity);
    const unitAmount = decimalMinor(line.unitAmount);
    const net = quantizeAccountingLineNet(quantity, unitAmount, resolvedMoney.rule);
    const tax = quantizeAccountingLineTax(net, decision.effectiveTaxRateBps, resolvedMoney.rule);
    const candidate = residual.find((originalLine) =>
      // The decision carriers hold the declared provider-native coordinates,
      // so this compares account code and TaxType against the original.
      originalLine.accountCode === decision.accountingCategory &&
      originalLine.taxType === decision.taxClass &&
      originalLine.effectiveTaxRateBps === decision.effectiveTaxRateBps &&
      originalLine.taxSemantics === decision.taxSemantics &&
      decimalMinor(originalLine.unitAmount) === unitAmount &&
      originalLine.quantityRemaining >= quantity &&
      originalLine.netRemaining >= net &&
      originalLine.taxRemaining >= tax);
    if (!candidate) {
      reasons.push("CREDIT_LINE_NOT_A_CONSUMABLE_ORIGINAL_SUBSET");
      continue;
    }
    candidate.quantityRemaining -= quantity;
    candidate.netRemaining -= net;
    candidate.taxRemaining -= tax;
  }
  return uniqueSorted(reasons);
}

function operationForNative(
  fact: NativeDocumentFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    dependencyEventKeys: string[];
    policy: AccountingPolicyEnforcementContract;
    provider: AccountingCaseProviderEnforcementContract;
  },
): AccountingCaseOperation {
  const routeDecision = context.provider.evaluateNativeRoute(fact, context.target);
  const route = routeDecision.route;
  const policyDecision = context.policy.evaluateNativeDocument(fact, context.target);
  const resolvedMoney = resolveSupportedAccountingMonetaryRule(context.policy, fact.currency);
  if (!resolvedMoney.rule) {
    compilationFailure(
      "ACCOUNTING_MONETARY_RULE_INVALID",
      `facts.${fact.factId}.currency`,
      `Accounting policy has no supported deterministic monetary rule for ${fact.currency}.`,
    );
  }
  const monetaryRule = resolvedMoney.rule;
  const { bridge, reasonCodes: bridgeReasons } = amountBridge(fact, policyDecision, monetaryRule);
  const reasons = [...bridgeReasons];
  if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
  if (fact.documentValidity === "TEST_OR_NOT_VALID" && context.target.environment !== "TEST") {
    reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
  }
  reasons.push(...routeDecision.reasonCodes);
  const compiledLinesWithoutProvider = lineCompilation(fact, policyDecision, monetaryRule).lines;
  const policyLineDecisionById = new Map(policyDecision.lineDecisions.map((decision) => [decision.lineId, decision]));
  const taxBindings = compiledLinesWithoutProvider.map((line) =>
    context.provider.taxBinding(fact, String(line.taxSemantics)));
  const categoryBindings = compiledLinesWithoutProvider.map((line) =>
    context.provider.accountingCategoryBinding(
      fact,
      String(line.accountingCategory),
      String(line.taxSemantics),
    ));
  reasons.push(...categoryBindings.flatMap((binding) => binding.reasonCodes));
  const compiledLines: Array<Record<string, unknown>> = compiledLinesWithoutProvider.map((line, index) => ({
    ...line,
    accountingPolicyBindingHash: hashObject((() => {
      const decision = policyLineDecisionById.get(String(line.lineId))!;
      return {
        accountingCategory: decision.accountingCategory,
        taxClass: decision.taxClass,
        ...(decision.exemptClassification ? { exemptClassification: decision.exemptClassification } : {}),
        effectiveTaxRateBps: decision.effectiveTaxRateBps,
        taxSemantics: decision.taxSemantics,
        ...(decision.taxPolicyPeriodId ? { taxPolicyPeriodId: decision.taxPolicyPeriodId } : {}),
        policyFields: decision.lineFields,
        providerAccountBinding: categoryBindings[index]!.bindingProjection,
      };
    })()),
    providerAccountBindingHash: hashObject(categoryBindings[index]!.bindingProjection),
    providerTaxBindingHash: hashObject(taxBindings[index]!.lineFields),
    providerAccountBinding: categoryBindings[index]!.bindingProjection,
    ...categoryBindings[index]!.canonicalFields,
    ...taxBindings[index]!.lineFields,
  }));
  const uniformTaxSemantics = uniqueSorted(compiledLines.map((line) => String(line.taxSemantics)));
  const uniformTaxPolicyPeriods = uniqueSorted(compiledLines.flatMap((line) =>
    typeof line.taxPolicyPeriodId === "string" ? [line.taxPolicyPeriodId] : []));
  const uniformProviderDocumentFields = taxBindings.length > 0 && taxBindings.every((binding) =>
    hashObject(binding.documentFields) === hashObject(taxBindings[0]!.documentFields))
    ? taxBindings[0]!.documentFields
    : Object.freeze({});
  const businessIdentity = sealedBusinessIdentity(context.provider, fact, context.target);
  const providerCoordinateFields = businessIdentity.businessIdentity.canonicalFields;
  const canonicalPayload: Record<string, unknown> = {
    schemaVersion: "accounting-case-native-document:v11",
    route,
    documentKind: fact.documentKind,
    counterpartyRole: fact.counterpartyRole,
    reference: fact.reference,
    referenceKind: fact.referenceKind,
    ...(typeof providerCoordinateFields.authoritativeProviderField === "string"
      ? { authoritativeProviderField: providerCoordinateFields.authoritativeProviderField }
      : {}),
    ...(typeof providerCoordinateFields.uniquenessAuthority === "string"
      ? { uniquenessAuthority: providerCoordinateFields.uniquenessAuthority }
      : {}),
    documentDate: fact.documentDate,
    ...(fact.dueDate ? { dueDate: fact.dueDate } : {}),
    currency: fact.currency,
    monetaryRule: Object.freeze({
      schemaVersion: "accounting-case-monetary-rule:v1",
      currency: monetaryRule.currency,
      minorUnitScale: monetaryRule.minorUnitScale,
      roundingMode: monetaryRule.roundingMode,
      taxAggregation: monetaryRule.taxAggregation,
    }),
    contactName: fact.contactName,
    ...(fact.contactDurableIdentity ? { contactDurableIdentity: fact.contactDurableIdentity } : {}),
    ...context.provider.contactBinding(fact).canonicalFields,
    ...(fact.taxPolicyBasis ? { taxPolicyBasis: fact.taxPolicyBasis } : {}),
    ...(fact.originalDocumentReference ? { originalDocumentReference: fact.originalDocumentReference } : {}),
    ...(fact.originalDocumentReferenceKind
      ? { originalDocumentReferenceKind: fact.originalDocumentReferenceKind }
      : {}),
    ...(fact.originalDocumentDate ? { originalDocumentDate: fact.originalDocumentDate } : {}),
    ...(fact.originalTransactionEvidenceHash
      ? { originalTransactionEvidenceHash: fact.originalTransactionEvidenceHash }
      : {}),
    ...(uniformTaxPolicyPeriods.length === 1
      ? { taxPolicyPeriodId: uniformTaxPolicyPeriods[0] }
      : {}),
    ...policyDecision.documentFields,
    ...uniformProviderDocumentFields,
    ...(uniformTaxSemantics.length === 1 ? { taxSemantics: uniformTaxSemantics[0] } : {}),
    lineAmountType: fact.lineAmountType,
    lines: compiledLines,
    net: bridge.canonicalNet,
    tax: bridge.canonicalTax,
    gross: bridge.canonicalGross,
    ...(fact.invoiceRate ? { invoiceRate: fixedFour(decimalMinor(fact.invoiceRate)) } : {}),
    ...(fact.allocationStatus ? { allocationStatus: fact.allocationStatus } : {}),
    documentValidity: fact.documentValidity,
    liveBooksEligible: fact.documentValidity === "VALID_FOR_LIVE_BOOKS",
    testTenantOnly: fact.documentValidity === "TEST_OR_NOT_VALID",
    status: "DRAFT",
  };
  const actionId = nativeAction(route);
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const operationIdentity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId,
    canonicalPayloadHash,
  };
  const operationReasons = uniqueSorted(reasons);
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(operationIdentity).slice(0, 24)}`,
    eventId: operationIdentity.eventId,
    actionId,
    nativeRoute: route,
    dependencyEventKeys: uniqueSorted(context.dependencyEventKeys),
    canonicalPayload,
    canonicalPayloadHash,
    ...businessIdentity,
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    amountBridge: bridge,
    terminalState: operationReasons.length === 0 ? "ELIGIBLE_FOR_PREFLIGHT" : "BLOCKED_VALIDATION",
    reasonCodes: operationReasons,
  };
}

function contactSupportsCommercialDocument(
  contact: ContactCandidateFact,
  document: CommercialDocumentFact,
): boolean {
  if (!contact.usageRoles.includes(document.counterpartyRole)) return false;
  if (contact.name.toLocaleLowerCase("en") !== document.contactName.toLocaleLowerCase("en")) return false;
  if (contact.durableIdentity !== undefined || document.contactDurableIdentity !== undefined) {
    return contact.durableIdentity !== undefined && document.contactDurableIdentity !== undefined &&
      hashObject(contact.durableIdentity) === hashObject(document.contactDurableIdentity);
  }
  return true;
}

function commercialContactDependencies(fact: CommercialDocumentFact, facts: readonly AccountingFact[]): string[] {
  return facts.flatMap((candidate) => candidate.kind === "CONTACT_CANDIDATE" &&
    contactSupportsCommercialDocument(candidate, fact)
    ? [candidate.eventKey]
    : []);
}

/**
 * Server-resolved binding for a commercial-document fact's counterparty.
 * Deliberately a plain, provider-neutral shape passed in alongside `provider`
 * rather than a method on AccountingCaseProviderEnforcementContract: that
 * contract's contactBinding() only accepts ContactCandidateFact |
 * NativeDocumentFact, so a CommercialDocumentFact could never be passed to
 * it -- which is the point (see the doc comment on CommercialDocumentRoute).
 */
export interface AccountingCaseCommercialContactBinding {
  readonly contactId: string;
  readonly identity?: Readonly<Record<string, unknown>>;
}

/**
 * Kept provider-neutral and inline, deliberately not delegated to a Xero-
 * named policy function: unlike evaluateXeroNativeRouteContract (which
 * encodes what the released Xero adapter can express), this is not an
 * adapter-capability limit. A quote must go to a customer and a purchase
 * order to a supplier, and a quote needs an expiry, regardless of provider.
 * The reason codes match XeroCommercialDocumentRouteContractReason in
 * xeroNativeRouteContract.ts (used for the execution-time re-check there) by
 * construction, not by shared code, since that file is Xero-specific policy
 * this provider-neutral compiler must not import.
 */
function commercialDocumentRouteReasonCodes(
  fact: Pick<CommercialDocumentFact, "documentKind" | "counterpartyRole" | "expiryDate">,
): string[] {
  const reasons: string[] = [];
  switch (fact.documentKind) {
    case "QUOTE":
      if (fact.counterpartyRole !== "CUSTOMER") reasons.push("QUOTE_COUNTERPARTY_MUST_BE_CUSTOMER");
      if (!fact.expiryDate) reasons.push("QUOTE_EXPIRY_DATE_REQUIRED");
      break;
    case "PURCHASE_ORDER":
      if (fact.counterpartyRole !== "SUPPLIER") reasons.push("PURCHASE_ORDER_COUNTERPARTY_MUST_BE_SUPPLIER");
      break;
    default: {
      const unreachable: never = fact.documentKind;
      throw new Error(`Unhandled commercial document kind: ${String(unreachable)}`);
    }
  }
  return reasons;
}

function operationForCommercialDocument(
  fact: CommercialDocumentFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    dependencyEventKeys: string[];
    providerId: string;
    contactBindings: ReadonlyMap<string, AccountingCaseCommercialContactBinding>;
  },
): AccountingCaseOperation {
  const route: CommercialDocumentRoute = fact.documentKind;
  const reasons = commercialDocumentRouteReasonCodes(fact);
  if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
  if (fact.documentValidity === "TEST_OR_NOT_VALID" && context.target.environment !== "TEST") {
    reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
  }
  if (context.target.periodLockDate && fact.documentDate <= context.target.periodLockDate) {
    reasons.push("DOCUMENT_DATE_IN_PERIOD_LOCK");
  }
  if (context.target.endOfYearLockDate && fact.documentDate <= context.target.endOfYearLockDate) {
    reasons.push("DOCUMENT_DATE_IN_END_OF_YEAR_LOCK");
  }
  const binding = context.contactBindings.get(fact.factId);
  if (!binding) {
    // factDisposition only reaches AUTO_EXECUTE (and therefore this function)
    // once a contact binding exists, so a miss here is an internal
    // invariant break, not a normal validation finding.
    compilationFailure(
      "ACCOUNTING_POLICY_LINE_DECISION_INVALID",
      `facts.${fact.factId}.contactName`,
      "A commercial-document operation was compiled with no resolved counterparty binding.",
    );
  }
  const normalizedLines = fact.lines.map((line) => ({
    lineId: line.lineId,
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    accountCode: line.accountCode,
    taxType: line.taxType,
  }));
  const normalizedReference = fact.reference.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
  const canonicalPayload: Record<string, unknown> = {
    schemaVersion: "accounting-case-commercial-document:v1",
    route,
    documentKind: fact.documentKind,
    counterpartyRole: fact.counterpartyRole,
    reference: fact.reference,
    documentDate: fact.documentDate,
    ...(fact.expiryDate ? { expiryDate: fact.expiryDate } : {}),
    ...(fact.expectedArrivalDate ? { expectedArrivalDate: fact.expectedArrivalDate } : {}),
    ...(fact.deliveryDate ? { deliveryDate: fact.deliveryDate } : {}),
    currency: fact.currency,
    contactName: fact.contactName,
    ...(fact.contactDurableIdentity ? { contactDurableIdentity: fact.contactDurableIdentity } : {}),
    xeroContactId: binding.contactId,
    xeroContactIdentity: binding.identity,
    lineAmountType: fact.lineAmountType,
    lines: normalizedLines,
    documentValidity: fact.documentValidity,
    liveBooksEligible: fact.documentValidity === "VALID_FOR_LIVE_BOOKS",
    testTenantOnly: fact.documentValidity === "TEST_OR_NOT_VALID",
    status: "DRAFT",
  };
  const actionId = fact.documentKind === "QUOTE"
    ? "quote.create_draft" as const
    : "purchase_order.create_draft" as const;
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const operationIdentity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId,
    canonicalPayloadHash,
  };
  // Own reservation namespace ("COMMERCIAL_DOCUMENT_OCCURRENCE"), disjoint from
  // the native-document "LEDGER_DOCUMENT_OCCURRENCE" kind, so this can never
  // collide with -- or be aliased against -- an invoice/credit-note reservation.
  const businessIdentityCanonicalFields = Object.freeze({
    route,
    contactId: binding.contactId,
    reference: normalizedReference,
  });
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "COMMERCIAL_DOCUMENT_OCCURRENCE",
    canonicalFields: businessIdentityCanonicalFields,
  });
  const reservationCoordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "COMMERCIAL_DOCUMENT_OCCURRENCE",
    canonicalFields: businessIdentityCanonicalFields,
  });
  const businessReservation = Object.freeze({
    ...reservationCoordinate,
    coordinateHash: hashObject(reservationCoordinate),
    scope: "ALL_OCCURRENCES" as const,
  });
  const operationReasons = uniqueSorted(reasons);
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(operationIdentity).slice(0, 24)}`,
    eventId: operationIdentity.eventId,
    actionId,
    nativeRoute: route,
    dependencyEventKeys: uniqueSorted(context.dependencyEventKeys),
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation,
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: operationReasons.length === 0 ? "ELIGIBLE_FOR_PREFLIGHT" : "BLOCKED_VALIDATION",
    reasonCodes: operationReasons,
  };
}

/**
 * Debits-equal-credits is a recording identity, not a provider-adapter
 * capability limit -- true for every accounting system, not just Xero's -- so
 * it is computed here, inline, the same way commercialDocumentRouteReasonCodes
 * above keeps QUOTE/PURCHASE_ORDER's universal shape rules out of the
 * Xero-specific xeroNativeRouteContract.ts. Xero's own manual-journal adapter
 * additionally hard-codes every line's TaxType to "NONE"
 * (canonicalManualJournalDraftPayloadSchema in xeroCreditNoteManualJournalDraft.ts)
 * -- that half genuinely is an adapter capability limit, so it is duplicated
 * (not shared) in evaluateXeroBalancedJournalRouteContract, matching the same
 * redundant-by-construction idiom used for the commercial-document reasons.
 *
 * Called from validationReasons() below -- i.e. while compileAccountingCase()
 * is still assembling `events` and `operations` -- not at execution time.
 * JOURNAL_NOT_BALANCED, when present, blocks the event's disposition to
 * BLOCKED_VALIDATION before any operation for that fact is ever built (see
 * the AUTO_EXECUTE gate in compileAccountingCase's operations flatMap), and
 * either way -- present or absent -- becomes part of the returned
 * CompiledAccountingCase, which XeroAccountingCaseService seals into
 * `compiledPlanHash` (accountingCasePlanHash(binding, compiled) in
 * accountingCasePersistence.ts) immediately after compilation. There is no
 * later point at which this identity is decided or could be redecided: it is
 * fixed the moment the plan hash is taken, not at preflight, prepare or
 * execute.
 */
function balancedJournalRouteReasonCodes(
  fact: Pick<BalancedJournalFact, "lines">,
): string[] {
  const reasons: string[] = [];
  let debits = 0n;
  let credits = 0n;
  for (const line of fact.lines) {
    if (line.taxType !== "NONE") reasons.push("MANUAL_JOURNAL_TAX_TYPE_UNSUPPORTED");
    if (line.debit !== undefined) debits += decimalMinor(line.debit);
    if (line.credit !== undefined) credits += decimalMinor(line.credit);
  }
  if (debits !== credits) reasons.push("JOURNAL_NOT_BALANCED");
  return reasons;
}

/**
 * A balanced journal's own reservation coordinate -- see "六、日记账去重是本设计里
 * 最难的一处" in docs/MANUAL-JOURNAL-DESIGN-2026-08-20.md. Xero's ManualJournal has
 * no InvoiceNumber-equivalent natural unique number, so unlike every other
 * operation kind this coordinate is a content hash, not a caller-declared
 * reference: normalized narration + date + each line's {accountCode,
 * signed amount}, line order ignored (two journals naming the same accounts
 * for the same amounts on the same date are "the same journal" regardless of
 * which line was typed first). This treats two journals as colliding
 * exactly when they are byte-identical in narration, date and every line --
 * including a genuinely-intended same-day repeat, for example a recurring
 * accrual deliberately posted twice. That is a deliberate, disclosed limit,
 * not an oversight: a manual journal carries no caller-supplied reference to
 * key a coordinate on the way CommercialDocumentFact's `reference` field
 * does, so this server cannot distinguish "the same journal, deliberately
 * repeated" from "the same journal, accidentally repeated" without one. A
 * caller that means to post the same journal twice must make the postings
 * distinguishable (vary the narration, or a line) -- the reservation is not
 * weakened to accept an unqualified duplicate silently.
 */
function balancedJournalReservationCanonicalFields(
  fact: Pick<BalancedJournalFact, "narration" | "date" | "lines">,
): Readonly<Record<string, unknown>> {
  const normalizedNarration = fact.narration.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
  const normalizedLines = fact.lines
    .map((line) => ({
      accountCode: line.accountCode,
      debit: line.debit !== undefined ? fixedFour(decimalMinor(line.debit)) : null,
      credit: line.credit !== undefined ? fixedFour(decimalMinor(line.credit)) : null,
    }))
    .sort((left, right) =>
      left.accountCode.localeCompare(right.accountCode) ||
      (left.debit ?? "").localeCompare(right.debit ?? "") ||
      (left.credit ?? "").localeCompare(right.credit ?? ""));
  return Object.freeze({
    route: "MANUAL_JOURNAL" as const,
    narration: normalizedNarration,
    date: fact.date,
    lines: normalizedLines,
  });
}

function operationForBalancedJournal(
  fact: BalancedJournalFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    providerId: string;
  },
): AccountingCaseOperation {
  const route: BalancedJournalRoute = "MANUAL_JOURNAL";
  const reasons = balancedJournalRouteReasonCodes(fact);
  if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
  if (fact.documentValidity === "TEST_OR_NOT_VALID" && context.target.environment !== "TEST") {
    reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
  }
  if (context.target.periodLockDate && fact.date <= context.target.periodLockDate) {
    reasons.push("DOCUMENT_DATE_IN_PERIOD_LOCK");
  }
  if (context.target.endOfYearLockDate && fact.date <= context.target.endOfYearLockDate) {
    reasons.push("DOCUMENT_DATE_IN_END_OF_YEAR_LOCK");
  }
  const normalizedLines = fact.lines.map((line) => ({
    lineId: line.lineId,
    description: line.description,
    accountCode: line.accountCode,
    taxType: line.taxType,
    ...(line.debit !== undefined ? { debit: line.debit } : {}),
    ...(line.credit !== undefined ? { credit: line.credit } : {}),
  }));
  const canonicalPayload: Record<string, unknown> = {
    schemaVersion: "accounting-case-balanced-journal:v1",
    route,
    narration: fact.narration,
    date: fact.date,
    lines: normalizedLines,
    documentValidity: fact.documentValidity,
    liveBooksEligible: fact.documentValidity === "VALID_FOR_LIVE_BOOKS",
    testTenantOnly: fact.documentValidity === "TEST_OR_NOT_VALID",
    status: "DRAFT",
  };
  const actionId = "manual_journal.create_draft" as const;
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const operationIdentity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId,
    canonicalPayloadHash,
  };
  // Own reservation namespace ("BALANCED_JOURNAL_OCCURRENCE"), disjoint from
  // both native-document "LEDGER_DOCUMENT_OCCURRENCE" and commercial-document
  // "COMMERCIAL_DOCUMENT_OCCURRENCE", so this can never collide with -- or be
  // aliased against -- an invoice, credit note, quote or purchase order.
  const businessIdentityCanonicalFields = balancedJournalReservationCanonicalFields(fact);
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "BALANCED_JOURNAL_OCCURRENCE",
    canonicalFields: businessIdentityCanonicalFields,
  });
  const reservationCoordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "BALANCED_JOURNAL_OCCURRENCE",
    canonicalFields: businessIdentityCanonicalFields,
  });
  const businessReservation = Object.freeze({
    ...reservationCoordinate,
    coordinateHash: hashObject(reservationCoordinate),
    scope: "ALL_OCCURRENCES" as const,
  });
  const operationReasons = uniqueSorted(reasons);
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(operationIdentity).slice(0, 24)}`,
    eventId: operationIdentity.eventId,
    actionId,
    nativeRoute: route,
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation,
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: operationReasons.length === 0 ? "ELIGIBLE_FOR_PREFLIGHT" : "BLOCKED_VALIDATION",
    reasonCodes: operationReasons,
  };
}

function operationForDraftDocumentUpdate(
  fact: DraftDocumentUpdateFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    policy: AccountingPolicyEnforcementContract;
    provider: AccountingCaseProviderEnforcementContract;
    contactBindings: ReadonlyMap<string, AccountingCaseCommercialContactBinding>;
    allFacts: readonly AccountingFact[];
  },
): AccountingCaseOperation {
  const replacementOperation = fact.replacement.kind === "NATIVE_DOCUMENT"
    ? operationForNative(fact.replacement, {
        caseId: context.caseId,
        caseVersion: context.caseVersion,
        target: context.target,
        sourceRevisionHash: context.sourceRevisionHash,
        dependencyEventKeys: contactDependencies(fact.replacement, context.allFacts),
        policy: context.policy,
        provider: context.provider,
      })
    : fact.replacement.kind === "COMMERCIAL_DOCUMENT"
      ? operationForCommercialDocument(fact.replacement, {
          caseId: context.caseId,
          caseVersion: context.caseVersion,
          target: context.target,
          sourceRevisionHash: context.sourceRevisionHash,
          dependencyEventKeys: commercialContactDependencies(fact.replacement, context.allFacts),
          providerId: context.provider.providerId,
          contactBindings: context.contactBindings,
        })
      : operationForBalancedJournal(fact.replacement, {
          caseId: context.caseId,
          caseVersion: context.caseVersion,
          target: context.target,
          sourceRevisionHash: context.sourceRevisionHash,
          providerId: context.provider.providerId,
        });
  const expectedAction = (() => {
    switch (replacementOperation.nativeRoute) {
      case "SALES_INVOICE": return "customer_invoice.update_draft" as const;
      case "SUPPLIER_BILL": return "supplier_bill.update_draft" as const;
      case "CUSTOMER_CREDIT":
      case "SUPPLIER_CREDIT": return "credit_note.update_draft" as const;
      case "QUOTE": return "quote.update_draft" as const;
      case "PURCHASE_ORDER": return "purchase_order.update_draft" as const;
      case "MANUAL_JOURNAL": return "manual_journal.update_draft" as const;
      default: {
        throw new Error(`Unhandled update replacement route: ${String(replacementOperation.nativeRoute)}`);
      }
    }
  })();
  const reasonCodes = [...replacementOperation.reasonCodes];
  if (fact.actionId !== expectedAction) reasonCodes.push("ACTION_ROUTE_MISMATCH");
  const canonicalPayload = Object.freeze({
    targetXeroObjectId: fact.targetXeroObjectId,
    expectedUpdatedAt: fact.expectedUpdatedAt,
    replacement: replacementOperation.canonicalPayload,
  });
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const operationIdentity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId: fact.actionId,
    canonicalPayloadHash,
  };
  const coordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.provider.providerId,
    kind: "DRAFT_DOCUMENT_UPDATE_TARGET",
    canonicalFields: Object.freeze({
      actionId: fact.actionId,
      targetXeroObjectId: fact.targetXeroObjectId.toLowerCase(),
    }),
  });
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.provider.providerId,
    kind: "DRAFT_DOCUMENT_UPDATE_TARGET",
    canonicalFields: coordinate.canonicalFields,
  });
  const operationReasons = uniqueSorted(reasonCodes);
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(operationIdentity).slice(0, 24)}`,
    eventId: operationIdentity.eventId,
    actionId: fact.actionId,
    nativeRoute: "DRAFT_DOCUMENT_UPDATE",
    dependencyEventKeys: replacementOperation.dependencyEventKeys,
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation: Object.freeze({
      ...coordinate,
      coordinateHash: hashObject(coordinate),
      scope: "ALL_OCCURRENCES" as const,
    }),
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    ...(replacementOperation.amountBridge ? { amountBridge: replacementOperation.amountBridge } : {}),
    terminalState: operationReasons.length === 0 ? "ELIGIBLE_FOR_PREFLIGHT" : "BLOCKED_VALIDATION",
    reasonCodes: operationReasons,
  };
}

function validatePrepayment(fact: PrepaymentFact): string[] {
  const reasons: string[] = [];
  const net = decimalMinor(fact.net);
  const tax = decimalMinor(fact.tax);
  const gross = decimalMinor(fact.gross);
  if (net + tax !== gross) reasons.push("PREPAYMENT_NET_PLUS_TAX_MISMATCH");
  return reasons;
}

function validateExpense(fact: EmployeeExpenseFact): string[] {
  const reasons: string[] = [];
  let total = 0n;
  for (const line of fact.lines) {
    const net = decimalMinor(line.net);
    const tax = decimalMinor(line.tax);
    const gross = decimalMinor(line.gross);
    total += gross;
    if (net + tax !== gross) reasons.push("EXPENSE_LINE_NET_PLUS_TAX_MISMATCH");
    if (line.expenseDate > fact.submittedDate) reasons.push("EXPENSE_DATE_AFTER_SUBMISSION");
  }
  if (total !== decimalMinor(fact.declaredGross)) reasons.push("EXPENSE_DECLARED_TOTAL_MISMATCH");
  if (fact.approvalDate && fact.approvalDate < fact.submittedDate) reasons.push("APPROVAL_BEFORE_SUBMISSION");
  if (fact.paymentDate && fact.approvalDate && fact.paymentDate < fact.approvalDate) reasons.push("PAYMENT_BEFORE_APPROVAL");
  return uniqueSorted(reasons);
}

function eventGroups(facts: readonly AccountingFact[]): Map<string, AccountingFact[]> {
  const groups = new Map<string, AccountingFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.eventKey) ?? [];
    group.push(fact);
    groups.set(fact.eventKey, group);
  }
  return groups;
}

function primaryFact(facts: readonly AccountingFact[]): AccountingFact | undefined {
  return facts.find((fact) => PRIMARY_FACT_KINDS.has(fact.kind));
}

function controlsForPrimary(
  primary: AccountingFact,
  groupedFacts: readonly AccountingFact[],
  allFacts: readonly AccountingFact[],
): AccountingFact[] {
  const direct = groupedFacts.filter((fact) => fact.kind === "CONTROL_FINDING");
  if (primary.kind !== "PAYMENT" || primary.cleared) return direct;

  const relatedDocument = allFacts.find((fact): fact is NativeDocumentFact =>
    fact.kind === "NATIVE_DOCUMENT" && fact.eventKey === primary.relatedEventKey);
  if (!relatedDocument) return direct;
  const relatedContactEventKeys = new Set(allFacts.flatMap((fact) =>
    fact.kind === "CONTACT_CANDIDATE" &&
    contactSupportsNativeDocument(fact, relatedDocument)
      ? [fact.eventKey]
      : []));
  const inherited = allFacts.filter((fact) =>
    fact.kind === "CONTROL_FINDING" &&
    fact.controlType === "BANK_DETAILS_VERIFICATION" &&
    fact.severity === "BLOCK_NEW_PAYMENT_OR_BANK_CHANGE" &&
    (relatedContactEventKeys.has(fact.eventKey) ||
      (fact.relatedEventKey !== undefined && relatedContactEventKeys.has(fact.relatedEventKey))));
  return [...new Map([...direct, ...inherited].map((fact) => [fact.factId, fact])).values()];
}

function assertEconomicGraph(facts: readonly AccountingFact[]): void {
  const groups = eventGroups(facts);
  for (const [key, grouped] of groups) {
    const primaries = grouped.filter((fact) => PRIMARY_FACT_KINDS.has(fact.kind));
    if (primaries.length > 1) compilationFailure(
      "MULTIPLE_PRIMARY_EFFECTS",
      `events.${key}`,
      `Accounting event ${key} has multiple primary effects.`,
    );
  }
  const primaryByKey = new Map([...groups].flatMap(([key, grouped]) => {
    const primary = primaryFact(grouped);
    return primary ? [[key, primary] as const] : [];
  }));
  for (const fact of facts) {
    if (fact.kind === "PAYMENT") {
      const related = primaryByKey.get(fact.relatedEventKey);
      if (!related || related.kind !== "NATIVE_DOCUMENT") compilationFailure(
        "PAYMENT_NATIVE_DOCUMENT_RELATION_MISSING",
        `facts.${fact.factId}.relatedEventKey`,
        `Payment ${fact.factId} has no native document relation.`,
      );
      const route = nativeRoute(related);
      const expected = fact.direction === "CUSTOMER_RECEIPT" ? "SALES_INVOICE" : "SUPPLIER_BILL";
      if (route !== expected) compilationFailure(
        "PAYMENT_DIRECTION_MISMATCH",
        `facts.${fact.factId}.direction`,
        `Payment ${fact.factId} has an incompatible document direction.`,
      );
      if (
        fact.currency !== related.currency ||
        decimalMinor(fact.amount) !== decimalMinor(related.declaredGross) ||
        fact.paymentDate < related.documentDate
      ) compilationFailure(
        "PAYMENT_DOCUMENT_BRIDGE_MISMATCH",
        `facts.${fact.factId}`,
        `Payment ${fact.factId} does not bridge to its document.`,
      );
    }
    if (fact.kind === "FX_SETTLEMENT") {
      const invoice = primaryByKey.get(fact.invoiceEventKey);
      if (!invoice || invoice.kind !== "NATIVE_DOCUMENT" || nativeRoute(invoice) !== "SUPPLIER_BILL") {
        compilationFailure(
          "FX_SUPPLIER_INVOICE_RELATION_MISSING",
          `facts.${fact.factId}.invoiceEventKey`,
          `FX settlement ${fact.factId} has no supplier invoice relation.`,
        );
      }
      if (invoice.currency !== fact.foreignCurrency || !invoice.invoiceRate || fact.baseCurrency === fact.foreignCurrency) {
        compilationFailure(
          "FX_CURRENCY_RELATION_INVALID",
          `facts.${fact.factId}`,
          `FX settlement ${fact.factId} currency relation is invalid.`,
        );
      }
    }
    if (fact.kind === "EVIDENCE" && fact.relatedEventKey && !groups.has(fact.relatedEventKey)) {
      compilationFailure(
        "EVIDENCE_EVENT_RELATION_MISSING",
        `facts.${fact.factId}.relatedEventKey`,
        `Evidence ${fact.factId} points to an unknown event.`,
      );
    }
    if (fact.kind === "CONTROL_FINDING" && fact.relatedEventKey && !groups.has(fact.relatedEventKey)) {
      compilationFailure(
        "CONTROL_EVENT_RELATION_MISSING",
        `facts.${fact.factId}.relatedEventKey`,
        `Control finding ${fact.factId} points to an unknown event.`,
      );
    }
    if (fact.kind === "GOODS_RECEIPT_CONTROL") {
      if (!primaryByKey.has(fact.relatedBillEventKey) || !primaryByKey.has(fact.relatedCreditEventKey)) {
        compilationFailure(
          "GOODS_RECEIPT_RELATION_MISSING",
          `facts.${fact.factId}`,
          `Goods receipt ${fact.factId} has an unknown bill or credit relation.`,
        );
      }
    }
  }
}

function validateFx(fact: FxSettlementFact, facts: readonly AccountingFact[]): string[] {
  const invoice = facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.kind === "NATIVE_DOCUMENT" && candidate.eventKey === fact.invoiceEventKey);
  if (!invoice?.invoiceRate) return ["FX_INVOICE_RATE_REQUIRED"];
  const reasons: string[] = [];
  const foreign = decimalMinor(fact.foreignAmount);
  const invoiceBase = multiplyScaled(foreign, decimalMinor(invoice.invoiceRate));
  const principal = multiplyScaled(foreign, decimalMinor(fact.settlementRate));
  if (!invoiceBase.exact || invoiceBase.value !== decimalMinor(fact.invoiceBase)) reasons.push("FX_INVOICE_BASE_MISMATCH");
  if (!principal.exact || principal.value !== decimalMinor(fact.principalBase)) reasons.push("FX_SETTLEMENT_PRINCIPAL_MISMATCH");
  if (principal.value - invoiceBase.value !== decimalMinor(fact.realisedFxLoss)) reasons.push("FX_REALISED_LOSS_MISMATCH");
  if (principal.value + decimalMinor(fact.bankFeeBase) !== decimalMinor(fact.cashBase)) reasons.push("FX_CASH_BRIDGE_MISMATCH");
  if (fact.settlementDate < invoice.documentDate) reasons.push("FX_SETTLEMENT_BEFORE_INVOICE");
  return uniqueSorted(reasons);
}

function validateGoodsReceipt(fact: GoodsReceiptControlFact, facts: readonly AccountingFact[]): string[] {
  const bill = facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.kind === "NATIVE_DOCUMENT" && candidate.eventKey === fact.relatedBillEventKey);
  const credit = facts.find((candidate): candidate is NativeDocumentFact =>
    candidate.kind === "NATIVE_DOCUMENT" && candidate.eventKey === fact.relatedCreditEventKey);
  if (!bill || !credit || nativeRoute(bill) !== "SUPPLIER_BILL" || nativeRoute(credit) !== "SUPPLIER_CREDIT") {
    return ["GOODS_RECEIPT_ROUTE_MISMATCH"];
  }
  const reasons: string[] = [];
  const billedLineQuantity = bill.lines.reduce((sum, line) => sum + decimalMinor(line.quantity), 0n);
  if (billedLineQuantity !== decimalMinor(fact.billedQuantity)) reasons.push("BILLED_QUANTITY_MISMATCH");
  const shortage = decimalMinor(fact.billedQuantity) - decimalMinor(fact.receivedQuantity);
  const expectedCredit = multiplyScaled(shortage, decimalMinor(fact.unitNet));
  if (!expectedCredit.exact || expectedCredit.value !== decimalMinor(credit.declaredNet)) reasons.push("SHORTAGE_CREDIT_MISMATCH");
  if (credit.documentDate < bill.documentDate) reasons.push("CREDIT_BEFORE_BILL");
  return uniqueSorted(reasons);
}

function validateBankSummary(fact: BankStatementSummaryFact, facts: readonly AccountingFact[]): string[] {
  const byEvent = new Map(facts.filter((candidate) => PRIMARY_FACT_KINDS.has(candidate.kind))
    .map((candidate) => [candidate.eventKey, candidate]));
  let movement = 0n;
  const reasons: string[] = [];
  for (const eventKey of fact.includedEventKeys) {
    const event = byEvent.get(eventKey);
    if (!event) {
      reasons.push("BANK_SUMMARY_EVENT_MISSING");
      continue;
    }
    if (event.kind === "PAYMENT") {
      if (event.currency !== fact.currency) reasons.push("BANK_SUMMARY_CURRENCY_MISMATCH");
      movement += event.direction === "CUSTOMER_RECEIPT" ? decimalMinor(event.amount) : -decimalMinor(event.amount);
    } else if (event.kind === "BANK_FEE") {
      if (event.currency !== fact.currency) reasons.push("BANK_SUMMARY_CURRENCY_MISMATCH");
      movement -= decimalMinor(event.amount);
    } else if (event.kind === "PREPAYMENT") {
      if (event.currency !== fact.currency) reasons.push("BANK_SUMMARY_CURRENCY_MISMATCH");
      movement += decimalMinor(event.gross);
    } else {
      reasons.push("BANK_SUMMARY_EVENT_KIND_INVALID");
    }
  }
  if (decimalMinor(fact.openingBalance) + movement !== decimalMinor(fact.closingBalance)) {
    reasons.push("BANK_STATEMENT_ROLL_FORWARD_MISMATCH");
  }
  return uniqueSorted(reasons);
}

function validationReasons(
  fact: AccountingFact,
  allFacts: readonly AccountingFact[],
  target: AccountingCaseTarget,
  policy: AccountingPolicyEnforcementContract,
  provider: AccountingCaseProviderEnforcementContract,
): string[] {
  switch (fact.kind) {
    case "CONTACT_CANDIDATE": {
      const limits = provider.capabilityBounds.contact;
      const providerReasons = [
        ...(fact.name.length > limits.maxNameLength ? ["PROVIDER_CONTACT_NAME_LIMIT_EXCEEDED"] : []),
        ...(fact.email && fact.email.length > limits.maxEmailLength
          ? ["PROVIDER_CONTACT_EMAIL_LIMIT_EXCEEDED"] : []),
        ...(fact.companyNumber && fact.companyNumber.length > limits.maxCompanyNumberLength
          ? ["PROVIDER_CONTACT_COMPANY_NUMBER_LIMIT_EXCEEDED"] : []),
        ...(fact.accountNumber && fact.accountNumber.length > limits.maxAccountNumberLength
          ? ["PROVIDER_CONTACT_ACCOUNT_NUMBER_LIMIT_EXCEEDED"] : []),
        ...(fact.durableIdentity && fact.durableIdentity.number.length > limits.maxDurableIdentityNumberLength
          ? ["PROVIDER_CONTACT_DURABLE_IDENTITY_NUMBER_LIMIT_EXCEEDED"] : []),
      ];
      if (providerReasons.length > 0) return uniqueSorted(providerReasons);
      if (provider.contactBinding(fact).resolvedId) return [];
      if (
        fact.durableIdentity?.kind === "PROVIDER_TENANT_ACCOUNT" &&
        fact.durableIdentity.providerId.toLocaleLowerCase("en") !== provider.providerId.toLocaleLowerCase("en")
      ) return ["CONTACT_ACCOUNT_IDENTITY_PROVIDER_MISMATCH"];
      return [];
    }
    case "NATIVE_DOCUMENT": {
      const limits = provider.capabilityBounds.nativeDocuments[
        provider.evaluateNativeRoute(fact, target).route
      ];
      const providerReasons: string[] = [];
      if (fact.lines.length > limits.maxLines) {
        providerReasons.push("PROVIDER_NATIVE_LINE_COUNT_LIMIT_EXCEEDED");
      }
      const maxQuantity = decimalMinor(limits.maxQuantity);
      const maxUnitAmount = decimalMinor(limits.maxUnitAmount);
      const maxEnteredLineAmount = decimalMinor(limits.maxEnteredLineAmount);
      for (const line of fact.lines) {
        const quantity = decimalMinor(line.quantity);
        const unitAmount = decimalMinor(line.unitAmount);
        if (quantity > maxQuantity) providerReasons.push("PROVIDER_NATIVE_QUANTITY_LIMIT_EXCEEDED");
        if (unitAmount > maxUnitAmount) providerReasons.push("PROVIDER_NATIVE_UNIT_AMOUNT_LIMIT_EXCEEDED");
        if (quantity * unitAmount > maxEnteredLineAmount * SCALE_FACTOR) {
          providerReasons.push("PROVIDER_NATIVE_ENTERED_LINE_AMOUNT_LIMIT_EXCEEDED");
        }
      }
      const policyDecision = policy.evaluateNativeDocument(fact, target);
      const resolvedMoney = resolveSupportedAccountingMonetaryRule(policy, fact.currency);
      const reasons = resolvedMoney.rule
        ? amountBridge(fact, policyDecision, resolvedMoney.rule).reasonCodes
        : uniqueSorted([...policyDecision.reasonCodes, ...resolvedMoney.reasonCodes]);
      if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
      if (fact.documentValidity === "TEST_OR_NOT_VALID" && target.environment !== "TEST") {
        reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
      }
      reasons.push(...provider.evaluateNativeRoute(fact, target).reasonCodes);
      if (target.periodLockDate && fact.documentDate <= target.periodLockDate) {
        reasons.push("DOCUMENT_DATE_IN_PERIOD_LOCK");
      }
      if (target.endOfYearLockDate && fact.documentDate <= target.endOfYearLockDate) {
        reasons.push("DOCUMENT_DATE_IN_END_OF_YEAR_LOCK");
      }
      const contact = allFacts.find((candidate): candidate is ContactCandidateFact =>
        candidate.kind === "CONTACT_CANDIDATE" &&
        contactSupportsNativeDocument(candidate, fact));
      const documentContactId = provider.contactBinding(fact).resolvedId;
      const candidateContactId = contact ? provider.contactBinding(contact).resolvedId : undefined;
      if (documentContactId && candidateContactId && documentContactId !== candidateContactId) {
        reasons.push("CONTACT_BINDING_ID_MISMATCH");
      }
      if (fact.documentKind === "CREDIT_NOTE") {
        reasons.push(...originalTransactionEvidenceReasons(fact, allFacts, target, policy));
      }
      return uniqueSorted([...providerReasons, ...reasons]);
    }
    case "COMMERCIAL_DOCUMENT": {
      const reasons = commercialDocumentRouteReasonCodes(fact);
      if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
      if (fact.documentValidity === "TEST_OR_NOT_VALID" && target.environment !== "TEST") {
        reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
      }
      if (target.periodLockDate && fact.documentDate <= target.periodLockDate) {
        reasons.push("DOCUMENT_DATE_IN_PERIOD_LOCK");
      }
      if (target.endOfYearLockDate && fact.documentDate <= target.endOfYearLockDate) {
        reasons.push("DOCUMENT_DATE_IN_END_OF_YEAR_LOCK");
      }
      return uniqueSorted(reasons);
    }
    case "BALANCED_JOURNAL": {
      const reasons = balancedJournalRouteReasonCodes(fact);
      if (fact.documentValidity === "UNKNOWN") reasons.push("DOCUMENT_VALIDITY_UNKNOWN");
      if (fact.documentValidity === "TEST_OR_NOT_VALID" && target.environment !== "TEST") {
        reasons.push("NON_LIVE_DOCUMENT_REQUIRES_TEST_TENANT");
      }
      if (target.periodLockDate && fact.date <= target.periodLockDate) {
        reasons.push("DOCUMENT_DATE_IN_PERIOD_LOCK");
      }
      if (target.endOfYearLockDate && fact.date <= target.endOfYearLockDate) {
        reasons.push("DOCUMENT_DATE_IN_END_OF_YEAR_LOCK");
      }
      return uniqueSorted(reasons);
    }
    case "DRAFT_DOCUMENT_UPDATE":
      return validationReasons(fact.replacement, allFacts, target, policy, provider);
    case "PREPAYMENT": return uniqueSorted([
      ...validatePrepayment(fact),
      ...policy.validatePrepayment(fact, target),
    ]);
    case "EMPLOYEE_EXPENSE": return uniqueSorted([
      ...validateExpense(fact),
      ...policy.validateEmployeeExpense(fact, target),
    ]);
    case "FX_SETTLEMENT": return validateFx(fact, allFacts);
    case "BANK_STATEMENT_SUMMARY": return validateBankSummary(fact, allFacts);
    case "GOODS_RECEIPT_CONTROL": return validateGoodsReceipt(fact, allFacts);
    case "ORIGINAL_TRANSACTION_EVIDENCE": return fact.evidenceHash === originalTransactionEvidenceHash(fact)
      ? []
      : ["CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_HASH_MISMATCH"];
    default: return [];
  }
}

function factDisposition(
  groupedFacts: readonly AccountingFact[],
  allFacts: readonly AccountingFact[],
  target: AccountingCaseTarget,
  policy: AccountingPolicyEnforcementContract,
  provider: AccountingCaseProviderEnforcementContract,
  commercialContactBindings: ReadonlyMap<string, AccountingCaseCommercialContactBinding>,
): { disposition: AccountingEventDisposition; reasonCodes: string[] } {
  const primary = primaryFact(groupedFacts);
  if (!primary) {
    const controlCodes = groupedFacts
      .filter((fact) => fact.kind === "CONTROL_FINDING")
      .map((fact) => `CONTROL_${fact.controlType}_${fact.severity}`);
    return { disposition: "EVIDENCE_ONLY", reasonCodes: uniqueSorted(controlCodes) };
  }
  const applicableControls = controlsForPrimary(primary, groupedFacts, allFacts);
  const controlCodes = applicableControls
    .filter((fact) => fact.kind === "CONTROL_FINDING")
    .map((fact) => `CONTROL_${fact.controlType}_${fact.severity}`);
  const validation = validationReasons(primary, allFacts, target, policy, provider);
  const reasons = uniqueSorted([...validation, ...controlCodes]);
  const hardControl = applicableControls.some((fact) => fact.kind === "CONTROL_FINDING" &&
    fact.severity === "BLOCK_NEW_PAYMENT_OR_BANK_CHANGE");
  if (validation.length > 0) {
    return { disposition: "BLOCKED_VALIDATION", reasonCodes: reasons };
  }
  if (hardControl && primary.kind === "PAYMENT") {
    return {
      disposition: "BLOCKED_UNSUPPORTED",
      reasonCodes: uniqueSorted(["NATIVE_WRITE_ROUTE_NOT_RELEASED", ...reasons]),
    };
  }
  if (primary.kind === "NATIVE_DOCUMENT") {
    const unresolvedContact = allFacts.some((candidate) =>
      candidate.kind === "CONTACT_CANDIDATE" &&
      contactSupportsNativeDocument(candidate, primary) &&
      !provider.contactBinding(candidate).resolvedId) && !provider.contactBinding(primary).resolvedId;
    if (!provider.contactBinding(primary).resolvedId) {
      return {
        disposition: "REVIEW_REQUIRED",
        reasonCodes: uniqueSorted([
          unresolvedContact
            ? "PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION"
            : provider.unresolvedContactReasonCode,
          ...reasons,
        ]),
      };
    }
  }
  // Commercial documents (quote/purchase order) are resolved through the
  // separate commercialContactBindings map, not provider.contactBinding(),
  // because that method only accepts ContactCandidateFact | NativeDocumentFact.
  if (primary.kind === "COMMERCIAL_DOCUMENT") {
    const unresolvedContact = allFacts.some((candidate) =>
      candidate.kind === "CONTACT_CANDIDATE" &&
      contactSupportsCommercialDocument(candidate, primary) &&
      !provider.contactBinding(candidate).resolvedId) && !commercialContactBindings.has(primary.factId);
    if (!commercialContactBindings.has(primary.factId)) {
      return {
        disposition: "REVIEW_REQUIRED",
        reasonCodes: uniqueSorted([
          unresolvedContact
            ? "PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION"
            : provider.unresolvedContactReasonCode,
          ...reasons,
        ]),
      };
    }
  }
  if (primary.kind === "DRAFT_DOCUMENT_UPDATE") {
    const replacement = primary.replacement;
    if (replacement.kind === "NATIVE_DOCUMENT" && !provider.contactBinding(replacement).resolvedId) {
      return {
        disposition: "REVIEW_REQUIRED",
        reasonCodes: uniqueSorted([provider.unresolvedContactReasonCode, ...reasons]),
      };
    }
    if (replacement.kind === "COMMERCIAL_DOCUMENT" && !commercialContactBindings.has(primary.factId)) {
      return {
        disposition: "REVIEW_REQUIRED",
        reasonCodes: uniqueSorted([provider.unresolvedContactReasonCode, ...reasons]),
      };
    }
  }
  switch (primary.kind) {
    case "CONTACT_CANDIDATE":
      return provider.contactBinding(primary).resolvedId
        ? { disposition: "EVIDENCE_ONLY", reasonCodes: uniqueSorted(["CONTACT_ALREADY_RESOLVED", ...reasons]) }
        : primary.durableIdentity
          ? { disposition: "AUTO_EXECUTE", reasonCodes: reasons }
          : {
              disposition: "REVIEW_REQUIRED",
              reasonCodes: uniqueSorted(["CONTACT_DURABLE_IDENTITY_REQUIRED", ...reasons]),
          };
    case "CONTACT_BASIC_UPDATE":
    case "ITEM_BASIC_CREATE_UNTRACKED":
    case "ITEM_BASIC_UPDATE_UNTRACKED":
    case "TRACKING_REFERENCE_DATA":
      return { disposition: "AUTO_EXECUTE", reasonCodes: reasons };
    case "NATIVE_DOCUMENT": return { disposition: "AUTO_EXECUTE", reasonCodes: reasons };
    // Informational, not blocking: unlike invoices/bills/credit notes, there
    // is no pre-write "does this already exist in Xero" duplicate check for
    // quotes/purchase orders (see CommercialDocumentRoute) -- Xero posts no
    // journal lines for either, so the GL-duplicate engine does not apply,
    // and building a replacement now would be untestable without captured
    // real response fixtures. Said explicitly here rather than left silent.
    case "COMMERCIAL_DOCUMENT": return {
      disposition: "AUTO_EXECUTE",
      reasonCodes: uniqueSorted(["EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE", ...reasons]),
    };
    // Informational, not blocking -- same idiom as COMMERCIAL_DOCUMENT above,
    // for the same underlying reason stated in docs/MANUAL-JOURNAL-DESIGN-2026-08-20.md:
    // a human posting the identical journal by hand in the Xero web UI is not
    // detectable by this server today. Xero's ManualJournal has no natural
    // unique number to check the way an Invoice's InvoiceNumber does, so
    // this is said explicitly rather than silently omitted.
    case "BALANCED_JOURNAL": return {
      disposition: "AUTO_EXECUTE",
      reasonCodes: uniqueSorted(["EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE", ...reasons]),
    };
    case "DRAFT_DOCUMENT_UPDATE":
      return { disposition: "AUTO_EXECUTE", reasonCodes: reasons };
    case "LEDGER_STATE_TRANSITION":
    case "LEDGER_ADJUSTMENT":
    case "PAYMENT_BANK_LEDGER":
      return { disposition: "AUTO_EXECUTE", reasonCodes: reasons };
    case "ORIGINAL_TRANSACTION_EVIDENCE": return { disposition: "EVIDENCE_ONLY", reasonCodes: reasons };
    case "OPENING_BALANCE_REVIEW": return { disposition: "REVIEW_REQUIRED", reasonCodes: uniqueSorted(["OPENING_BALANCE_POLICY_REQUIRED", ...reasons]) };
    case "BANK_STATEMENT_SUMMARY":
    case "GOODS_RECEIPT_CONTROL": return { disposition: "EVIDENCE_ONLY", reasonCodes: reasons };
    case "PAYMENT":
    case "BANK_FEE":
    case "PREPAYMENT":
    case "EMPLOYEE_EXPENSE":
    case "FX_SETTLEMENT": return {
      disposition: "BLOCKED_UNSUPPORTED",
      reasonCodes: uniqueSorted(["NATIVE_WRITE_ROUTE_NOT_RELEASED", ...reasons]),
    };
    case "EVIDENCE":
    case "CONTROL_FINDING": return { disposition: "EVIDENCE_ONLY", reasonCodes: reasons };
  }
}

function contactDependencies(fact: NativeDocumentFact, facts: readonly AccountingFact[]): string[] {
  return facts.flatMap((candidate) => candidate.kind === "CONTACT_CANDIDATE" &&
    contactSupportsNativeDocument(candidate, fact)
    ? [candidate.eventKey]
    : []);
}

function operationForContact(
  fact: ContactCandidateFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    provider: AccountingCaseProviderEnforcementContract;
  },
): AccountingCaseOperation {
  const canonicalPayload = {
    schemaVersion: "accounting-case-contact:v4",
    usageRoles: [...fact.usageRoles],
    name: fact.name,
    ...(fact.email ? { email: fact.email } : {}),
    ...(fact.durableIdentity ? { durableIdentity: fact.durableIdentity } : {}),
    ...(fact.companyNumber ? { companyNumber: fact.companyNumber } : {}),
    ...(fact.accountNumber ? { accountNumber: fact.accountNumber } : {}),
    ...context.provider.contactBinding(fact).canonicalFields,
  };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const businessIdentity = sealedBusinessIdentity(context.provider, fact, context.target);
  const identity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId: "contact.create_basic",
    canonicalPayloadHash,
  };
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(identity).slice(0, 24)}`,
    eventId: identity.eventId,
    actionId: "contact.create_basic",
    nativeRoute: "CONTACT_CREATE",
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    ...businessIdentity,
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    reasonCodes: [],
  };
}

type ReferenceDataFact = Extract<AccountingFact, {
  kind: "CONTACT_BASIC_UPDATE" | "ITEM_BASIC_CREATE_UNTRACKED" | "ITEM_BASIC_UPDATE_UNTRACKED" |
    "TRACKING_REFERENCE_DATA";
}>;

/**
 * Case-native wrapper for the three safe reference-data primitives. This is
 * intentionally a closed switch: adding an arbitrary object type or a new
 * generic patch field requires an explicit compiler, service and provider
 * decision instead of becoming silently writable through the Case surface.
 */
function operationForReferenceData(
  fact: ReferenceDataFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    providerId: string;
  },
): AccountingCaseOperation {
  const route: ReferenceDataRoute = fact.kind;
  const mapped = (() => {
    switch (fact.kind) {
      case "CONTACT_BASIC_UPDATE":
        return {
          actionId: "contact.update_basic" as const,
          objectType: "CONTACT" as const,
          operation: "UPDATE" as const,
          target: { contactId: fact.contactId },
          input: { contactId: fact.contactId, patch: fact.patch },
        };
      case "ITEM_BASIC_CREATE_UNTRACKED":
        return {
          actionId: "item.create_basic_untracked" as const,
          objectType: "ITEM" as const,
          operation: "CREATE" as const,
          target: { code: fact.item.code },
          input: { item: fact.item },
        };
      case "ITEM_BASIC_UPDATE_UNTRACKED":
        return {
          actionId: "item.update_basic_untracked" as const,
          objectType: "ITEM" as const,
          operation: "UPDATE" as const,
          target: { itemId: fact.itemId },
          input: { itemId: fact.itemId, patch: fact.patch },
        };
      case "TRACKING_REFERENCE_DATA": {
        const ids = {
          ...(fact.trackingCategoryId ? { trackingCategoryId: fact.trackingCategoryId } : {}),
          ...(fact.trackingOptionId ? { trackingOptionId: fact.trackingOptionId } : {}),
        };
        return {
          actionId: fact.action,
          objectType: fact.action.startsWith("tracking_category.") ? "TRACKING_CATEGORY" as const : "TRACKING_OPTION" as const,
          operation: fact.action.endsWith(".create") ? "CREATE" as const : "UPDATE" as const,
          target: fact.action.endsWith(".create")
            ? { actionId: fact.action, ...ids, name: fact.name }
            : { actionId: fact.action, ...ids },
          input: { actionId: fact.action, ...ids, name: fact.name },
        };
      }
      default: {
        const unreachable: never = fact;
        throw new Error(`Unhandled reference-data fact: ${String(unreachable)}`);
      }
    }
  })();
  const canonicalPayload = {
    schemaVersion: "accounting-case-reference-data:v1",
    route,
    actionId: mapped.actionId,
    objectType: mapped.objectType,
    operation: mapped.operation,
    ...mapped.input,
  };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const operationIdentity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId: mapped.actionId,
    canonicalPayloadHash,
  };
  const coordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "REFERENCE_DATA_TARGET",
    canonicalFields: Object.freeze({ route, actionId: mapped.actionId, ...mapped.target }),
  });
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "REFERENCE_DATA_TARGET",
    canonicalFields: coordinate.canonicalFields,
  });
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(operationIdentity).slice(0, 24)}`,
    eventId: operationIdentity.eventId,
    actionId: mapped.actionId,
    nativeRoute: route,
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation: Object.freeze({
      ...coordinate,
      coordinateHash: hashObject(coordinate),
      scope: "ALL_OCCURRENCES" as const,
    }),
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    reasonCodes: [],
  };
}

function operationForLedgerStateTransition(
  fact: LedgerStateTransitionFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    providerId: string;
  },
): AccountingCaseOperation {
  const canonicalPayload = (() => {
    switch (fact.actionId) {
      case "customer_invoice.authorise":
        return {
          invoiceId: fact.targetXeroObjectId,
          invoiceType: "ACCREC" as const,
          expectedStatus: "DRAFT" as const,
        };
      case "supplier_bill.authorise":
        return {
          invoiceId: fact.targetXeroObjectId,
          invoiceType: "ACCPAY" as const,
          expectedStatus: "DRAFT" as const,
        };
      case "manual_journal.post":
        return {
          manualJournalId: fact.targetXeroObjectId,
          expectedStatus: "DRAFT" as const,
        };
      default: {
        const unreachable: never = fact.actionId;
        throw new Error(`Unhandled ledger-state action: ${String(unreachable)}`);
      }
    }
  })();
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const identity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId: fact.actionId,
    canonicalPayloadHash,
  };
  const coordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "LEDGER_STATE_TARGET",
    canonicalFields: Object.freeze({
      actionId: fact.actionId,
      targetXeroObjectId: fact.targetXeroObjectId,
    }),
  });
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "LEDGER_STATE_TARGET",
    canonicalFields: coordinate.canonicalFields,
  });
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(identity).slice(0, 24)}`,
    eventId: identity.eventId,
    actionId: fact.actionId,
    nativeRoute: "LEDGER_STATE_TRANSITION",
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation: Object.freeze({
      ...coordinate,
      coordinateHash: hashObject(coordinate),
      scope: "ALL_OCCURRENCES" as const,
    }),
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    reasonCodes: [],
  };
}

function operationForLedgerAdjustment(
  fact: LedgerAdjustmentFact,
  context: {
    caseId: string;
    caseVersion: number;
    target: AccountingCaseTarget;
    sourceRevisionHash: string;
    providerId: string;
  },
): AccountingCaseOperation {
  const canonicalPayload = parseLedgerAdjustmentPayload(fact.actionId, fact.payload);
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const identity = {
    caseId: context.caseId,
    caseVersion: context.caseVersion,
    sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey),
    actionId: fact.actionId,
    canonicalPayloadHash,
  };
  const targetXeroObjectId = "invoiceId" in canonicalPayload
    ? canonicalPayload.invoiceId
    : "creditNoteId" in canonicalPayload
      ? canonicalPayload.creditNoteId
      : canonicalPayload.manualJournalId;
  const coordinate = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "LEDGER_ADJUSTMENT_TARGET",
    canonicalFields: Object.freeze({ actionId: fact.actionId, targetXeroObjectId }),
  });
  const businessIdentity = Object.freeze({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId,
    kind: "LEDGER_ADJUSTMENT_TARGET",
    canonicalFields: coordinate.canonicalFields,
  });
  return {
    caseId: context.caseId,
    target: context.target,
    operationId: `op_${hashObject(identity).slice(0, 24)}`,
    eventId: identity.eventId,
    actionId: fact.actionId,
    nativeRoute: "LEDGER_ADJUSTMENT",
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash: hashObject(businessIdentity),
    businessReservation: Object.freeze({
      ...coordinate,
      coordinateHash: hashObject(coordinate),
      scope: "ALL_OCCURRENCES" as const,
    }),
    sourceRevisionHash: context.sourceRevisionHash,
    caseVersion: context.caseVersion,
    terminalState: "ELIGIBLE_FOR_PREFLIGHT",
    reasonCodes: [],
  };
}

function operationForPaymentBankLedger(
  fact: PaymentBankLedgerFact,
  context: { caseId: string; caseVersion: number; target: AccountingCaseTarget; sourceRevisionHash: string; providerId: string },
): AccountingCaseOperation {
  const canonicalPayload = fact.payload as unknown as Record<string, unknown>;
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const identity = { caseId: context.caseId, caseVersion: context.caseVersion, sourceRevisionHash: context.sourceRevisionHash,
    eventId: eventId(context.caseId, fact.eventKey), actionId: fact.actionId, canonicalPayloadHash };
  const targetXeroObjectId = fact.actionId === "payment.reverse" ? fact.payload.paymentId
    : (fact.actionId === "bank_transaction.update" || fact.actionId === "bank_transaction.reverse")
      ? fact.payload.bankTransactionId : undefined;
  const coordinate = Object.freeze({ schemaVersion: ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION,
    providerId: context.providerId, kind: "PAYMENT_BANK_LEDGER_TARGET",
    canonicalFields: Object.freeze({ actionId: fact.actionId, ...(targetXeroObjectId ? { targetXeroObjectId } : { canonicalPayloadHash }) }) });
  const businessIdentity = Object.freeze({ schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: context.providerId, kind: "PAYMENT_BANK_LEDGER_TARGET", canonicalFields: coordinate.canonicalFields });
  return { caseId: context.caseId, target: context.target, operationId: `op_${hashObject(identity).slice(0, 24)}`,
    eventId: identity.eventId, actionId: fact.actionId, nativeRoute: "PAYMENT_BANK_LEDGER", dependencyEventKeys: [],
    canonicalPayload, canonicalPayloadHash, businessIdentity, businessIdentityHash: hashObject(businessIdentity),
    businessReservation: Object.freeze({ ...coordinate, coordinateHash: hashObject(coordinate), scope: "ALL_OCCURRENCES" as const }),
    sourceRevisionHash: context.sourceRevisionHash, caseVersion: context.caseVersion,
    terminalState: "ELIGIBLE_FOR_PREFLIGHT", reasonCodes: [] };
}


function plannedBusinessKeys(operation: AccountingCaseOperation): string[] {
  const payload = operation.canonicalPayload;
  if (operation.actionId === "contact.create_basic") {
    const keys: Array<Record<string, unknown>> = [{
      kind: "CONTACT_NAME",
      actionId: operation.actionId,
      value: typeof payload.name === "string" ? payload.name.trim().toLocaleLowerCase("en") : null,
    }, {
      kind: "EXACT_CANONICAL_PAYLOAD",
      actionId: operation.actionId,
      canonicalPayloadHash: operation.canonicalPayloadHash,
    }, {
      kind: "PROVIDER_BUSINESS_IDENTITY",
      actionId: operation.actionId,
      businessIdentityHash: operation.businessIdentityHash,
    }];
    // Email is deliberately only a collision signal. It can stop two
    // ambiguous contacts in one plan, but cannot become their durable key.
    if (typeof payload.email === "string") keys.push({
      kind: "CONTACT_EMAIL_COLLISION",
      actionId: operation.actionId,
      value: payload.email.trim().toLocaleLowerCase("en"),
    });
    return keys.map((key) => hashObject(key));
  }
  return [
    hashObject({
      kind: "EXACT_CANONICAL_PAYLOAD",
      actionId: operation.actionId,
      canonicalPayloadHash: operation.canonicalPayloadHash,
    }),
  ];
}

function businessReservationsOverlap(
  left: AccountingCaseOperation,
  right: AccountingCaseOperation,
): boolean {
  if (left.actionId !== right.actionId) return false;
  return accountingCaseBusinessReservationsOverlap(left.businessReservation, right.businessReservation);
}

function assertNoPlannedBusinessDuplicates(operations: readonly AccountingCaseOperation[]): void {
  const identities = new Map<string, string>();
  for (const operation of operations) {
    for (const identity of plannedBusinessKeys(operation)) {
      const existing = identities.get(identity);
      if (existing) {
        compilationFailure(
          "PLANNED_BUSINESS_DUPLICATE",
          `operations.${operation.operationId}`,
          `Accounting Case operations ${existing} and ${operation.operationId} have the same planned provider business identity.`,
        );
      }
      identities.set(identity, operation.operationId);
    }
    const existingReservation = operations.find((candidate) =>
      candidate.operationId !== operation.operationId &&
      candidate.operationId.localeCompare(operation.operationId) < 0 &&
      businessReservationsOverlap(candidate, operation));
    if (existingReservation) {
      compilationFailure(
        "PLANNED_BUSINESS_DUPLICATE",
        `operations.${operation.operationId}`,
        `Accounting Case operations ${existingReservation.operationId} and ${operation.operationId} have overlapping provider business reservations.`,
      );
    }
  }
}

export function validateCompiledOperationAgainstSource(
  operation: AccountingCaseOperation,
  sourceFact: NativeDocumentFact,
  policy: AccountingPolicyEnforcementContract,
  provider: AccountingCaseProviderEnforcementContract,
): string[] {
  const expected = operationForNative(sourceFact, {
    caseId: operation.caseId,
    caseVersion: operation.caseVersion,
    target: operation.target,
    sourceRevisionHash: operation.sourceRevisionHash,
    dependencyEventKeys: operation.dependencyEventKeys,
    policy,
    provider,
  });
  const reasons: string[] = [];
  if (operation.actionId !== expected.actionId) reasons.push("ACTION_ROUTE_MISMATCH");
  if (operation.nativeRoute !== expected.nativeRoute) reasons.push("NATIVE_ROUTE_REQUIRED");
  if (operation.eventId !== expected.eventId) reasons.push("EVENT_ID_MISMATCH");
  if (operation.operationId !== expected.operationId) reasons.push("OPERATION_ID_MISMATCH");
  if (operation.canonicalPayloadHash !== hashObject(operation.canonicalPayload)) reasons.push("CANONICAL_PAYLOAD_HASH_MISMATCH");
  if (operation.businessIdentityHash !== hashObject(operation.businessIdentity)) reasons.push("BUSINESS_IDENTITY_HASH_MISMATCH");
  if (operation.businessIdentityHash !== expected.businessIdentityHash) reasons.push("BUSINESS_IDENTITY_MISMATCH");
  if (hashObject(operation.businessReservation) !== hashObject(expected.businessReservation)) {
    reasons.push("BUSINESS_IDENTITY_MISMATCH");
  }
  if (hashObject(operation.canonicalPayload) !== hashObject(expected.canonicalPayload)) reasons.push("CANONICAL_PAYLOAD_MISMATCH");
  if (operation.canonicalPayloadHash !== expected.canonicalPayloadHash) reasons.push("EXPECTED_PAYLOAD_HASH_MISMATCH");
  if (operation.amountBridge?.sourceNet !== expected.amountBridge?.sourceNet ||
      operation.amountBridge?.canonicalNet !== expected.amountBridge?.canonicalNet) {
    reasons.push("SOURCE_NET_MISMATCH");
  }
  if (operation.amountBridge?.sourceTax !== expected.amountBridge?.sourceTax ||
      operation.amountBridge?.canonicalTax !== expected.amountBridge?.canonicalTax) {
    reasons.push("SOURCE_TAX_MISMATCH");
  }
  if (operation.amountBridge?.sourceGross !== expected.amountBridge?.sourceGross ||
      operation.amountBridge?.canonicalGross !== expected.amountBridge?.canonicalGross) {
    reasons.push("SOURCE_GROSS_MISMATCH");
  }
  if (operation.amountBridge &&
      decimalMinor(operation.amountBridge.canonicalNet) + decimalMinor(operation.amountBridge.canonicalTax) !==
        decimalMinor(operation.amountBridge.canonicalGross)) {
    reasons.push("CANONICAL_TOTAL_MISMATCH");
  }
  if (hashObject(operation.amountBridge) !== hashObject(expected.amountBridge)) reasons.push("AMOUNT_BRIDGE_MISMATCH");
  if (operation.terminalState !== expected.terminalState) reasons.push("VALIDATION_STATE_MISMATCH");
  return uniqueSorted(reasons);
}

export function compileAccountingCase(
  raw: PrepareAccountingCaseInput,
  policy: AccountingPolicyEnforcementContract,
  provider: AccountingCaseProviderEnforcementContract,
  /**
   * Server-resolved counterparty bindings for COMMERCIAL_DOCUMENT facts,
   * keyed by factId. A sibling to the provider's own contactBinding(), kept
   * as a separate plain map rather than added to that interface because
   * AccountingCaseProviderEnforcementContract#contactBinding only accepts
   * ContactCandidateFact | NativeDocumentFact -- see CommercialDocumentRoute.
   */
  commercialContactBindings: ReadonlyMap<string, AccountingCaseCommercialContactBinding> = new Map(),
): CompiledAccountingCase {
  const input = prepareAccountingCaseSchema.parse(raw) as PrepareAccountingCaseInput;
  const sourceArtifacts = [...input.sources]
    .map((source) => ({
      ...source,
      units: [...source.units]
        .map((unit) => ({ ...unit, expectedFactKinds: [...unit.expectedFactKinds].sort() }))
        .sort((a, b) => a.unitId.localeCompare(b.unitId)),
    }))
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId)) as AccountingSourceArtifact[];
  const facts = activeFacts(input.facts as AccountingFact[]);
  assertEconomicGraph(facts);

  if (input.target.taxJurisdiction !== policy.jurisdiction) {
    compilationFailure(
      "ACCOUNTING_POLICY_JURISDICTION_MISMATCH",
      "target.taxJurisdiction",
      "The Accounting Case target is outside the injected accounting policy jurisdiction.",
    );
  }

  const units = sourceArtifacts.flatMap((source) => source.units);
  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  for (const fact of facts) {
    for (const sourceUnitId of fact.sourceUnitIds) {
      const unit = unitById.get(sourceUnitId);
      if (!unit?.expectedFactKinds.includes(fact.kind) &&
          fact.origin !== "SERVER_RESOLVED_PROVIDER_EVIDENCE") {
        compilationFailure(
          "SOURCE_FACT_KIND_UNDECLARED",
          `facts.${fact.factId}.sourceUnitIds`,
          `Fact ${fact.factId} kind ${fact.kind} is not declared for source unit ${sourceUnitId}.`,
        );
      }
    }
  }

  const sourceRevisionHash = hashObject({
    sources: sourceArtifacts,
    facts: [...input.facts].sort((a, b) => a.factId.localeCompare(b.factId)).map((fact) => ({
      ...fact,
      sourceUnitIds: uniqueSorted(fact.sourceUnitIds),
    })),
    policyProjection: policy.planProjection,
    providerProjection: provider.planProjection,
  });
  const caseVersion = input.expectedVersion + 1;
  const groups = eventGroups(facts);
  const events: AccountingEvent[] = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([eventKey, groupedFacts]) => {
      const primary = primaryFact(groupedFacts);
      const decision = factDisposition(groupedFacts, facts, input.target, policy, provider, commercialContactBindings);
      let route: NativeDocumentRoute | CommercialDocumentRoute | BalancedJournalRoute | ReferenceDataRoute |
        LedgerStateTransitionRoute | LedgerAdjustmentRoute | PaymentBankLedgerRoute |
        "DRAFT_DOCUMENT_UPDATE" | "CONTACT_CREATE" | undefined;
      if (primary?.kind === "NATIVE_DOCUMENT") {
        route = provider.evaluateNativeRoute(primary, input.target).route;
      }
      if (primary?.kind === "COMMERCIAL_DOCUMENT") route = primary.documentKind;
      if (primary?.kind === "BALANCED_JOURNAL") route = "MANUAL_JOURNAL";
      if (primary?.kind === "DRAFT_DOCUMENT_UPDATE") route = "DRAFT_DOCUMENT_UPDATE";
      if (primary?.kind === "LEDGER_STATE_TRANSITION") route = "LEDGER_STATE_TRANSITION";
      if (primary?.kind === "LEDGER_ADJUSTMENT") route = "LEDGER_ADJUSTMENT";
      if (primary?.kind === "PAYMENT_BANK_LEDGER") route = "PAYMENT_BANK_LEDGER";
      if (primary?.kind === "CONTACT_CANDIDATE") route = "CONTACT_CREATE";
      if (
        primary?.kind === "CONTACT_BASIC_UPDATE" ||
        primary?.kind === "ITEM_BASIC_CREATE_UNTRACKED" ||
        primary?.kind === "ITEM_BASIC_UPDATE_UNTRACKED" ||
        primary?.kind === "TRACKING_REFERENCE_DATA"
      ) route = primary.kind;
      return {
        eventId: eventId(input.caseId, eventKey),
        eventKey,
        ...(primary ? { primaryFactId: primary.factId, primaryFactKind: primary.kind } : {}),
        factIds: uniqueSorted(groupedFacts.map((fact) => fact.factId)),
        sourceUnitIds: uniqueSorted(groupedFacts.flatMap((fact) => fact.sourceUnitIds)),
        disposition: decision.disposition,
        ...(route ? { route } : {}),
        reasonCodes: decision.reasonCodes,
      };
    });

  const operationContext = {
    caseId: input.caseId,
    caseVersion,
    target: input.target,
    sourceRevisionHash,
    policy,
    provider,
  };
  const hasGlobalDocumentEligibilityBlock = facts.some((fact) =>
    fact.kind === "DRAFT_DOCUMENT_UPDATE"
      ? fact.replacement.documentValidity === "UNKNOWN" ||
        (fact.replacement.documentValidity === "TEST_OR_NOT_VALID" && input.target.environment === "PRODUCTION")
      : (fact.kind === "NATIVE_DOCUMENT" || fact.kind === "COMMERCIAL_DOCUMENT" || fact.kind === "BALANCED_JOURNAL") &&
        (fact.documentValidity === "UNKNOWN" ||
          (fact.documentValidity === "TEST_OR_NOT_VALID" && input.target.environment === "PRODUCTION")));
  const operations = (hasGlobalDocumentEligibilityBlock ? [] : facts.flatMap((fact): AccountingCaseOperation[] => {
    const event = events.find((candidate) => candidate.eventKey === fact.eventKey);
    if (event?.disposition !== "AUTO_EXECUTE") return [];
    if (fact.kind === "CONTACT_CANDIDATE" && !provider.contactBinding(fact).resolvedId) {
      return [operationForContact(fact, operationContext)];
    }
    if (fact.kind === "NATIVE_DOCUMENT") {
      return [operationForNative(fact, {
        ...operationContext,
        dependencyEventKeys: contactDependencies(fact, facts),
      })];
    }
    if (fact.kind === "COMMERCIAL_DOCUMENT") {
      return [operationForCommercialDocument(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        dependencyEventKeys: commercialContactDependencies(fact, facts),
        providerId: provider.providerId,
        contactBindings: commercialContactBindings,
      })];
    }
    if (fact.kind === "BALANCED_JOURNAL") {
      return [operationForBalancedJournal(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        providerId: provider.providerId,
      })];
    }
    if (fact.kind === "DRAFT_DOCUMENT_UPDATE") {
      return [operationForDraftDocumentUpdate(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        policy,
        provider,
        contactBindings: commercialContactBindings,
        allFacts: facts,
      })];
    }
    if (fact.kind === "LEDGER_STATE_TRANSITION") {
      return [operationForLedgerStateTransition(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        providerId: provider.providerId,
      })];
    }
    if (fact.kind === "LEDGER_ADJUSTMENT") {
      return [operationForLedgerAdjustment(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        providerId: provider.providerId,
      })];
    }
    if (fact.kind === "PAYMENT_BANK_LEDGER") {
      return [operationForPaymentBankLedger(fact, { caseId: input.caseId, caseVersion, target: input.target,
        sourceRevisionHash, providerId: provider.providerId })];
    }
    if (
      fact.kind === "CONTACT_BASIC_UPDATE" ||
      fact.kind === "ITEM_BASIC_CREATE_UNTRACKED" ||
      fact.kind === "ITEM_BASIC_UPDATE_UNTRACKED" ||
      fact.kind === "TRACKING_REFERENCE_DATA"
    ) {
      return [operationForReferenceData(fact, {
        caseId: input.caseId,
        caseVersion,
        target: input.target,
        sourceRevisionHash,
        providerId: provider.providerId,
      })];
    }
    return [];
  })).sort((a, b) => a.operationId.localeCompare(b.operationId));
  assertNoPlannedBusinessDuplicates(operations);

  const requirements = units.flatMap((unit) => unit.expectedFactKinds.map((factKind) => ({
    sourceUnitId: unit.unitId,
    factKind,
  })));
  const missingFactRequirements = requirements.filter((requirement) => !facts.some((fact) =>
    fact.kind === requirement.factKind && fact.sourceUnitIds.includes(requirement.sourceUnitId)));
  const dispositionCounts: Record<AccountingEventDisposition, number> = {
    AUTO_EXECUTE: 0,
    EVIDENCE_ONLY: 0,
    REVIEW_REQUIRED: 0,
    BLOCKED_UNSUPPORTED: 0,
    BLOCKED_VALIDATION: 0,
  };
  for (const event of events) dispositionCounts[event.disposition] += 1;
  const submittedFactsProcessed = missingFactRequirements.length === 0;
  const coverageBase = {
    receiptType: "ACCOUNTING_CASE_COVERAGE" as const,
    expectedArtifactCount: sourceArtifacts.length,
    expectedSourceUnitCount: units.length,
    expectedFactRequirementCount: requirements.length,
    satisfiedFactRequirementCount: requirements.length - missingFactRequirements.length,
    missingFactRequirements,
    activeFactCount: facts.length,
    eventCount: events.length,
    dispositionCounts,
    submittedFactsProcessed,
    allLedgerMutationsVerified: false as const,
  };
  const hasValidationFailure = events.some((event) => event.disposition === "BLOCKED_VALIDATION") ||
    operations.some((operation) => operation.terminalState === "BLOCKED_VALIDATION");
  const hasExceptions = events.some((event) => ["REVIEW_REQUIRED", "BLOCKED_UNSUPPORTED"].includes(event.disposition));
  const status = !submittedFactsProcessed
    ? "BLOCKED_COVERAGE" as const
    : hasValidationFailure
      ? "BLOCKED_VALIDATION" as const
      : hasExceptions
        ? "PLANNED_WITH_EXCEPTIONS" as const
        : "PLANNED_NEEDS_PREFLIGHT" as const;
  return {
    caseId: input.caseId,
    version: caseVersion,
    providerId: provider.providerId,
    target: input.target,
    sourceRevisionHash,
    compilerVersion: ACCOUNTING_CASE_COMPILER_VERSION,
    policyVersion: policy.policyVersion,
    policyProjection: policy.planProjection,
    providerContractVersion: provider.contractVersion,
    providerProjection: provider.planProjection,
    sources: sourceArtifacts,
    activeFacts: facts,
    events,
    operations,
    coverage: { ...coverageBase, coverageHash: hashObject(coverageBase) },
    status,
    completionClaim: {
      suppliedSetCoverage: submittedFactsProcessed ? "COMPLETE" : "INCOMPLETE",
      ledgerWrite: "NOT_WRITTEN",
      wholeBusinessCompleteness: "NOT_ASSERTED",
    },
  };
}
