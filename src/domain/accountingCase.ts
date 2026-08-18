import { hashObject } from "../security/hash.js";

export const ACCOUNTING_CASE_COMPILER_VERSION = "0.11.0";

export type AccountingFactOrigin =
  | "MODEL_EXTRACTED"
  | "AGENT_ASSERTED"
  | "SERVER_RESOLVED_PROVIDER_EVIDENCE";

/**
 * Mandatory source-document eligibility classification.  A missing boolean
 * used to collapse "not supplied" into "live document"; the three-state
 * value keeps uncertainty explicit and lets the compiler enforce the target
 * environment before it emits a provider operation.
 */
export type AccountingDocumentValidity =
  | "VALID_FOR_LIVE_BOOKS"
  | "TEST_OR_NOT_VALID"
  | "UNKNOWN";

/**
 * Source-supported meaning of the document reference.  It is explicit so a
 * provider adapter can reserve a formal number across revisions without
 * blocking a recurring label in every later period.
 */
export const ACCOUNTING_DOCUMENT_REFERENCE_KINDS = [
  "FORMAL_DOCUMENT_NUMBER",
  "GENERIC_RECURRING_REFERENCE",
] as const;

export type AccountingDocumentReferenceKind =
  typeof ACCOUNTING_DOCUMENT_REFERENCE_KINDS[number];

/**
 * Closed, extensible enum of upstream systems that may cite a source case
 * against this Case. Starting with exactly one member keeps the trust-on-
 * first-use binding conservative; a new system is added here deliberately.
 */
export const ACCOUNTING_CASE_SOURCE_SYSTEMS = ["GOOGLE_DRIVE"] as const;

export type AccountingCaseSourceSystem = typeof ACCOUNTING_CASE_SOURCE_SYSTEMS[number];

export const ACCOUNTING_FACT_KINDS = [
  "CONTACT_CANDIDATE",
  "NATIVE_DOCUMENT",
  "PAYMENT",
  "BANK_FEE",
  "PREPAYMENT",
  "EMPLOYEE_EXPENSE",
  "FX_SETTLEMENT",
  "OPENING_BALANCE_REVIEW",
  "BANK_STATEMENT_SUMMARY",
  "GOODS_RECEIPT_CONTROL",
  "ORIGINAL_TRANSACTION_EVIDENCE",
  "EVIDENCE",
  "CONTROL_FINDING",
] as const;

export type AccountingFactKind = typeof ACCOUNTING_FACT_KINDS[number];

export interface AccountingSourceUnit {
  unitId: string;
  /**
   * Bounded completeness contract for the facts submitted to this MCP. This
   * does not assert that the user supplied every real-world document.
   */
  expectedFactKinds: AccountingFactKind[];
}

export interface AccountingSourceArtifact {
  artifactId: string;
  label: string;
  units: AccountingSourceUnit[];
}

export interface AccountingCaseTarget {
  tenantId: string;
  environment: "TEST" | "PRODUCTION";
  baseCurrency: string;
  /** Opaque jurisdiction key interpreted only by the injected accounting policy. */
  taxJurisdiction: string;
  periodLockDate?: string | undefined;
  endOfYearLockDate?: string | undefined;
  organisationStatus: string;
}

/**
 * Source-supported, namespaced identity for a counterparty. Bare provider
 * company/account fields are useful collision evidence, but are not durable
 * legal identities because their issuer and uniqueness scope are unknown.
 */
export type ContactDurableIdentity =
  | Readonly<{
      kind: "LEGAL_REGISTRY";
      jurisdiction: string;
      registryScheme: string;
      number: string;
    }>
  | Readonly<{
      kind: "PROVIDER_TENANT_ACCOUNT";
      providerId: string;
      namespace: string;
      number: string;
    }>;

interface AccountingFactBase {
  factId: string;
  /** Stable identity across append-only corrections. */
  lineageKey: string;
  eventKey: string;
  sourceUnitIds: string[];
  origin: AccountingFactOrigin;
  revision: number;
  supersedesFactId?: string;
}

export interface ContactCandidateFact extends AccountingFactBase {
  kind: "CONTACT_CANDIDATE";
  /** Legal identity is role-neutral; these are only the submitted usage directions. */
  usageRoles: ("CUSTOMER" | "SUPPLIER")[];
  name: string;
  email?: string;
  /** Only this typed value may become a durable contact reservation. */
  durableIdentity?: ContactDurableIdentity;
  /** Legacy provider fields: collision/read-back evidence, never durable identity. */
  companyNumber?: string;
  accountNumber?: string;
  bankVerification?: "NOT_APPLICABLE" | "PENDING_CALLBACK" | "VERIFIED";
}

export type NativeDocumentRoute =
  | "SALES_INVOICE"
  | "SUPPLIER_BILL"
  | "CUSTOMER_CREDIT"
  | "SUPPLIER_CREDIT";

/**
 * Opaque provider-native ledger coordinate carried through the shared kernel.
 * Under the released ledger-gateway policy this is the caller-declared Xero
 * account code; the compiler never interprets or maps it.
 */
export type AccountingCategory = string;

/**
 * Opaque provider-native tax coordinate.  Under the released ledger-gateway
 * policy this is the caller-declared Xero TaxType, verified against the target
 * tenant's live tax-rate table by the injected policy adapter.
 */
export type AccountingTaxClass = string;

export type AccountingExemptClassification = string;

/**
 * Informational source-review record carried with a document.  Nothing in the
 * compiler, policy, provider adapter or execution path branches on it; it
 * exists so the submitted review conclusion stays auditable in the plan.
 */
export type AccountingTaxPolicyBasis = string;

export type AccountingTaxSemantics = string;

export interface NativeDocumentLine {
  lineId: string;
  description: string;
  quantity: string;
  unitAmount: string;
  sourceTax: string;
  /** Explicit provider-native account code declared for this exact line. */
  accountCode: string;
  /** Explicit provider-native TaxType declared for this exact line. */
  taxType: string;
}

export interface NativeDocumentFact extends AccountingFactBase {
  kind: "NATIVE_DOCUMENT";
  documentKind: "INVOICE" | "CREDIT_NOTE";
  counterpartyRole: "CUSTOMER" | "SUPPLIER";
  reference: string;
  referenceKind: AccountingDocumentReferenceKind;
  documentDate: string;
  dueDate?: string;
  currency: string;
  contactName: string;
  /** Source-supported namespace for resolving the existing counterparty. */
  contactDurableIdentity?: ContactDurableIdentity;
  /** Informational source-review record; no decision reads it. */
  taxPolicyBasis?: AccountingTaxPolicyBasis;
  /** Required for every credit note so its tax treatment is tied to the original transaction. */
  originalDocumentEventKey?: string;
  originalDocumentReference?: string;
  originalDocumentReferenceKind?: AccountingDocumentReferenceKind;
  originalDocumentDate?: string;
  /** Server-owned link to provider-neutral original-transaction evidence. */
  originalTransactionEvidenceHash?: string;
  lineAmountType: "EXCLUSIVE" | "NO_TAX";
  lines: NativeDocumentLine[];
  declaredNet: string;
  declaredTax: string;
  declaredGross: string;
  invoiceRate?: string;
  allocationStatus?: "UNALLOCATED";
  documentValidity: AccountingDocumentValidity;
}

export interface DeclaredNativeDocumentLineCoordinate {
  accountCode: string;
  taxType: string;
}

/**
 * Read the explicit provider-native coordinate a caller declared for one line.
 * Every line carries its own complete declaration; there is no document-level
 * default and no server-side inference.
 */
export function declaredNativeDocumentLineCoordinate(
  line: NativeDocumentLine,
): DeclaredNativeDocumentLineCoordinate {
  return { accountCode: line.accountCode, taxType: line.taxType };
}

export interface PaymentFact extends AccountingFactBase {
  kind: "PAYMENT";
  direction: "CUSTOMER_RECEIPT" | "SUPPLIER_PAYMENT";
  reference: string;
  paymentDate: string;
  currency: string;
  amount: string;
  relatedEventKey: string;
  cleared: boolean;
}

export interface BankFeeFact extends AccountingFactBase {
  kind: "BANK_FEE";
  date: string;
  currency: string;
  amount: string;
  taxSemantics: string;
}

export interface PrepaymentFact extends AccountingFactBase {
  kind: "PREPAYMENT";
  date: string;
  currency: string;
  gross: string;
  net: string;
  tax: string;
  customerName: string;
  customerConfirmed: boolean;
  servicePeriod: string;
}

export interface EmployeeExpenseLine {
  lineId: string;
  expenseDate: string;
  description: string;
  net: string;
  tax: string;
  gross: string;
  taxSemantics: string;
  receiptStatus: "PRESENT" | "MISSING";
}

export interface EmployeeExpenseFact extends AccountingFactBase {
  kind: "EMPLOYEE_EXPENSE";
  employeeName: string;
  submittedDate: string;
  approvalDate?: string;
  paymentDate?: string;
  currency: string;
  declaredGross: string;
  recognitionPolicy: "ACCRUAL_EXPENSE_DATE";
  lines: EmployeeExpenseLine[];
}

export interface FxSettlementFact extends AccountingFactBase {
  kind: "FX_SETTLEMENT";
  reference: string;
  settlementDate: string;
  foreignCurrency: string;
  foreignAmount: string;
  baseCurrency: string;
  settlementRate: string;
  invoiceBase: string;
  principalBase: string;
  realisedFxLoss: string;
  bankFeeBase: string;
  cashBase: string;
  invoiceEventKey: string;
  bankAccountRef: string;
  reconciled: boolean;
}

export interface OpeningBalanceFact extends AccountingFactBase {
  kind: "OPENING_BALANCE_REVIEW";
  date: string;
  currency: string;
  amount: string;
}

export interface BankStatementSummaryFact extends AccountingFactBase {
  kind: "BANK_STATEMENT_SUMMARY";
  accountRef: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  openingBalance: string;
  closingBalance: string;
  includedEventKeys: string[];
}

export interface GoodsReceiptControlFact extends AccountingFactBase {
  kind: "GOODS_RECEIPT_CONTROL";
  relatedBillEventKey: string;
  relatedCreditEventKey: string;
  billedQuantity: string;
  receivedQuantity: string;
  unitNet: string;
}

export interface EvidenceFact extends AccountingFactBase {
  kind: "EVIDENCE";
  evidenceRole:
    | "INBOUND_CUSTOMER_PO"
    | "REMITTANCE_ADVICE"
    | "EXPENSE_RECEIPT"
    | "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT"
    | "CONTROL_SUPPORT";
  relatedEventKey?: string;
  amount?: string;
  note: string;
}

export interface OriginalTransactionEvidenceLine {
  /** Provider-neutral stable key for consuming this original line at most once. */
  evidenceLineKey: string;
  description: string;
  quantity: string;
  unitAmount: string;
  net: string;
  tax: string;
  /** Provider-native account code read back from the original transaction. */
  accountCode: string;
  /** Provider-native TaxType read back from the original transaction. */
  taxType: string;
  effectiveTaxRateBps: number;
  taxSemantics: AccountingTaxSemantics;
}

/**
 * Server-resolved evidence for an already-posted original invoice or bill.
 * Provider object IDs, native status values, and native account/tax IDs are
 * deliberately absent. The provider adapter keeps those only in its sealed
 * internal projection, keyed by `evidenceHash`.
 */
export interface OriginalTransactionEvidenceFact extends AccountingFactBase {
  kind: "ORIGINAL_TRANSACTION_EVIDENCE";
  origin: "SERVER_RESOLVED_PROVIDER_EVIDENCE";
  creditEventKey: string;
  originalRoute: "SALES_INVOICE" | "SUPPLIER_BILL";
  /** Both historical invoice routes bind the provider's InvoiceNumber property. */
  authoritativeProviderField: "INVOICE_NUMBER";
  reference: string;
  referenceKind: AccountingDocumentReferenceKind;
  documentDate: string;
  currency: string;
  contactName: string;
  contactDurableIdentity?: ContactDurableIdentity;
  creditEligibility: "CREDITABLE_POSTED_TRANSACTION";
  lineAmountType: "EXCLUSIVE" | "NO_TAX";
  lines: OriginalTransactionEvidenceLine[];
  net: string;
  tax: string;
  gross: string;
  /** Digest of the adapter-owned complete semantic exact-GET projection. */
  sourceSnapshotSealHash: string;
  evidenceHash: string;
}

export function originalTransactionEvidenceHashProjection(
  fact: Omit<OriginalTransactionEvidenceFact, "evidenceHash"> | OriginalTransactionEvidenceFact,
): Readonly<Record<string, unknown>> {
  const { evidenceHash: _evidenceHash, ...projection } = fact as OriginalTransactionEvidenceFact;
  return projection;
}

export function originalTransactionEvidenceHash(
  fact: Omit<OriginalTransactionEvidenceFact, "evidenceHash"> | OriginalTransactionEvidenceFact,
): string {
  return hashObject(originalTransactionEvidenceHashProjection(fact));
}

export interface ControlFindingFact extends AccountingFactBase {
  kind: "CONTROL_FINDING";
  controlType: "THREE_WAY_MATCH" | "BANK_DETAILS_VERIFICATION" | "MISSING_RECEIPT";
  severity: "INFO" | "WARNING" | "BLOCK_NEW_PAYMENT_OR_BANK_CHANGE";
  relatedEventKey?: string;
  note: string;
}

export type AccountingFact =
  | ContactCandidateFact
  | NativeDocumentFact
  | PaymentFact
  | BankFeeFact
  | PrepaymentFact
  | EmployeeExpenseFact
  | FxSettlementFact
  | OpeningBalanceFact
  | BankStatementSummaryFact
  | GoodsReceiptControlFact
  | OriginalTransactionEvidenceFact
  | EvidenceFact
  | ControlFindingFact;

export type AccountingEventDisposition =
  | "AUTO_EXECUTE"
  | "EVIDENCE_ONLY"
  | "REVIEW_REQUIRED"
  | "BLOCKED_UNSUPPORTED"
  | "BLOCKED_VALIDATION";

export interface AccountingEvent {
  eventId: string;
  eventKey: string;
  primaryFactId?: string;
  primaryFactKind?: AccountingFactKind;
  factIds: string[];
  sourceUnitIds: string[];
  disposition: AccountingEventDisposition;
  route?: NativeDocumentRoute | "CONTACT_CREATE";
  reasonCodes: string[];
}

export interface AccountingAmountBridge {
  currency: string;
  sourceNet: string;
  sourceTax: string;
  sourceGross: string;
  canonicalNet: string;
  canonicalTax: string;
  canonicalGross: string;
  formula: "LINE_SUM_PLUS_TAX_EQUALS_GROSS";
  toleranceMinorUnits: 0;
  sourceFactIds: string[];
  sourceLineHash: string;
  lineBridges: Array<{
    lineId: string;
    sourceTax: string;
    canonicalNet: string;
    canonicalTax: string;
    effectiveTaxRateBps: number;
    accountingCategory: AccountingCategory;
    taxClass: AccountingTaxClass;
    taxSemantics: AccountingTaxSemantics;
    sourceLineHash: string;
  }>;
}

export const ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION =
  "accounting-case-business-identity:v2" as const;

export interface AccountingCaseBusinessIdentity {
  schemaVersion: typeof ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION;
  providerId: string;
  kind: string;
  canonicalFields: Readonly<Record<string, unknown>>;
}

/**
 * Provider-neutral collision scope for a prospective ledger write.
 *
 * `ALL_OCCURRENCES` is used when one provider coordinate names a single
 * durable object across source corrections. `DATED_OCCURRENCE` permits the
 * same coordinate on another source date, while retaining a hard collision
 * for same-date revisions.  A reservation conflicts when its coordinate hash
 * matches and either side is `ALL_OCCURRENCES`, or both dates match.
 */
export const ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION =
  "accounting-case-business-reservation:v1" as const;

export type AccountingCaseBusinessReservation = Readonly<{
  schemaVersion: typeof ACCOUNTING_CASE_BUSINESS_RESERVATION_SCHEMA_VERSION;
  providerId: string;
  kind: string;
  canonicalFields: Readonly<Record<string, unknown>>;
  coordinateHash: string;
} & (
  | { scope: "ALL_OCCURRENCES" }
  | { scope: "DATED_OCCURRENCE"; occurrenceDate: string }
)>;

export function accountingCaseBusinessReservationsOverlap(
  left: AccountingCaseBusinessReservation,
  right: AccountingCaseBusinessReservation,
): boolean {
  if (left.providerId !== right.providerId || left.kind !== right.kind) return false;
  const exactCoordinate = left.coordinateHash === right.coordinateHash;
  const labelSwitchAlias = (() => {
    if (left.kind !== "LEDGER_DOCUMENT_OCCURRENCE") return false;
    const leftFields = left.canonicalFields;
    const rightFields = right.canonicalFields;
    if (leftFields.route !== rightFields.route ||
        leftFields.reference !== rightFields.reference ||
        leftFields.normalizationVersion !== rightFields.normalizationVersion) return false;
    const kinds = new Set([leftFields.referenceKind, rightFields.referenceKind]);
    if (!kinds.has("FORMAL_DOCUMENT_NUMBER") ||
        !kinds.has("GENERIC_RECURRING_REFERENCE")) return false;
    // A caller must not evade an existing document reservation merely by
    // relabelling the same business token as a recurring Reference.  AP
    // coordinates remain contact-scoped; provider-unique AR coordinates are
    // intentionally tenant-scoped and therefore omit contact from the key.
    const leftContact = leftFields.contactId;
    const rightContact = rightFields.contactId;
    return typeof leftContact !== "string" ||
      typeof rightContact !== "string" ||
      leftContact === rightContact;
  })();
  if (!exactCoordinate && !labelSwitchAlias) return false;
  if (left.scope === "ALL_OCCURRENCES" || right.scope === "ALL_OCCURRENCES") return true;
  return left.occurrenceDate === right.occurrenceDate;
}

export interface AccountingCaseOperation {
  caseId: string;
  target: AccountingCaseTarget;
  operationId: string;
  eventId: string;
  actionId:
    | "contact.create_basic"
    | "customer_invoice.create_draft"
    | "supplier_bill.create_draft"
    | "credit_note.create_draft";
  nativeRoute: NativeDocumentRoute | "CONTACT_CREATE";
  dependencyEventKeys: string[];
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  businessIdentity: AccountingCaseBusinessIdentity;
  businessIdentityHash: string;
  businessReservation: AccountingCaseBusinessReservation;
  sourceRevisionHash: string;
  caseVersion: number;
  amountBridge?: AccountingAmountBridge;
  terminalState: "ELIGIBLE_FOR_PREFLIGHT" | "BLOCKED_VALIDATION";
  reasonCodes: string[];
}

export interface AccountingCoverageReceipt {
  receiptType: "ACCOUNTING_CASE_COVERAGE";
  expectedArtifactCount: number;
  expectedSourceUnitCount: number;
  expectedFactRequirementCount: number;
  satisfiedFactRequirementCount: number;
  missingFactRequirements: Array<{ sourceUnitId: string; factKind: AccountingFactKind }>;
  activeFactCount: number;
  eventCount: number;
  dispositionCounts: Record<AccountingEventDisposition, number>;
  submittedFactsProcessed: boolean;
  allLedgerMutationsVerified: false;
  coverageHash: string;
}

export interface CompiledAccountingCase {
  caseId: string;
  version: number;
  providerId: string;
  target: AccountingCaseTarget;
  sourceRevisionHash: string;
  compilerVersion: string;
  policyVersion: string;
  /** Opaque accounting-policy context sealed independently of the provider projection. */
  policyProjection: Readonly<Record<string, unknown>>;
  providerContractVersion: string;
  /** Opaque, provider-owned compile context; interpreted only by that provider adapter. */
  providerProjection: Readonly<Record<string, unknown>>;
  sources: AccountingSourceArtifact[];
  activeFacts: AccountingFact[];
  events: AccountingEvent[];
  operations: AccountingCaseOperation[];
  coverage: AccountingCoverageReceipt;
  status:
    | "BLOCKED_COVERAGE"
    | "BLOCKED_VALIDATION"
    | "PLANNED_NEEDS_PREFLIGHT"
    | "PLANNED_WITH_EXCEPTIONS";
  completionClaim: {
    suppliedSetCoverage: "COMPLETE" | "INCOMPLETE";
    ledgerWrite: "NOT_WRITTEN";
    wholeBusinessCompleteness: "NOT_ASSERTED";
  };
}
