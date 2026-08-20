import { hashObject } from "../security/hash.js";
import type {
  AllocateCreditNotePayload,
  AuthoriseCreditNotePayload,
  LedgerAdjustmentAction,
  RefundCreditNotePayload,
  UnallocateCreditNotePayload,
  VoidCreditNotePayload,
  VoidInvoicePayload,
  VoidManualJournalPayload,
} from "./xeroLedgerAdjustment.js";
import type {
  CanonicalBankTransactionCreatePayload,
  CanonicalBankTransactionReversePayload,
  CanonicalBankTransactionUpdatePayload,
  CanonicalPaymentCreatePayload,
  CanonicalPaymentReversePayload,
} from "./xeroPaymentBankTransaction.js";

export const ACCOUNTING_CASE_COMPILER_VERSION = "0.13.0";

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

/**
 * Closed reference-data facts. These are deliberately individual Case fact
 * kinds rather than a generic object/patch envelope: the only public
 * maintenance paths are the already-reviewed safe Contact and untracked Item
 * primitives, with their own preflight, provider receipt, exact read-back and
 * recovery behavior.
 */
export interface ContactBasicUpdateFact extends AccountingFactBase {
  kind: "CONTACT_BASIC_UPDATE";
  contactId: string;
  patch: ContactBasicPatch;
}

export interface ItemBasicCreateUntrackedFact extends AccountingFactBase {
  kind: "ITEM_BASIC_CREATE_UNTRACKED";
  item: ItemBasicCreateUntracked;
}

export interface ItemBasicUpdateUntrackedFact extends AccountingFactBase {
  kind: "ITEM_BASIC_UPDATE_UNTRACKED";
  itemId: string;
  patch: ItemBasicPatch;
}

export type TrackingReferenceDataAction =
  | "tracking_category.create"
  | "tracking_category.update"
  | "tracking_option.create"
  | "tracking_option.update";

/** One closed typed fact family for the four safe ACTIVE tracking mutations. */
export interface TrackingReferenceDataFact extends AccountingFactBase {
  kind: "TRACKING_REFERENCE_DATA";
  action: TrackingReferenceDataAction;
  name: string;
  trackingCategoryId?: string;
  trackingOptionId?: string;
}

/** Exact, deliberately small public Contact patch vocabulary. */
export interface ContactBasicPhonePatch {
  phone_type: "DEFAULT" | "DDI" | "MOBILE" | "FAX" | "OFFICE";
  phone_number: string;
  area_code?: string;
  country_code?: string;
}

export interface ContactBasicAddressPatch {
  address_type: "POBOX" | "STREET";
  line_1?: string;
  line_2?: string;
  line_3?: string;
  line_4?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  attention_to?: string;
}

export interface ContactBasicPatch {
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  company_number?: string;
  account_number?: string;
  phones?: ContactBasicPhonePatch[];
  addresses?: ContactBasicAddressPatch[];
}

/** Exact, deliberately small untracked Item vocabulary. */
export interface ItemBasicCreateUntracked {
  code: string;
  name?: string;
  description?: string;
  purchase_description?: string;
  is_sold: boolean;
  is_purchased: boolean;
}

export interface ItemBasicPatch {
  name?: string;
  description?: string;
  purchase_description?: string;
  is_sold?: boolean;
  is_purchased?: boolean;
}

export type NativeDocumentRoute =
  | "SALES_INVOICE"
  | "SUPPLIER_BILL"
  | "CUSTOMER_CREDIT"
  | "SUPPLIER_CREDIT";

/**
 * Quotes and purchase orders are structurally invoice-/bill-shaped -- a
 * counterparty, lines, dates -- but they are not ledger events: Xero posts no
 * journal lines for either and neither ever appears on the Journals endpoint.
 * This is a deliberately disjoint route family, not a widened
 * NativeDocumentRoute. Every place keyed on the four historical routes
 * (business-coordinate authority, business-coordinate history, firm-
 * governance authority) stays exhaustive over exactly those four because a
 * value of this type can never be passed where a NativeDocumentRoute is
 * required -- the compiler refuses, rather than silently mis-routing through
 * machinery built for documents that post to the general ledger.
 */
export type CommercialDocumentRoute = "QUOTE" | "PURCHASE_ORDER";

/**
 * A manual journal posts directly to the general ledger -- unlike
 * CommercialDocumentRoute, "it is not a ledger event" is not the reason it
 * stays out of NativeDocumentRoute. The reason is structural: it has no
 * counterparty and no ACCREC/ACCPAY document type. xeroBusinessCoordinateHistory's
 * ACCREC/ACCPAY duplicate check has nothing to say about an object with
 * neither, and #executeNativeDocument requires a contactName unconditionally
 * (#assertSealedContactBinding) -- routing a journal through either would
 * mean fabricating a counterparty the source fact never asserted. Kept as a
 * single-member union, not a bare string literal, for the same reason
 * CommercialDocumentRoute is named rather than inlined: every switch over
 * AccountingCaseOperation["nativeRoute"] names it explicitly instead of
 * falling through an else branch built for a different route family.
 */
export type BalancedJournalRoute = "MANUAL_JOURNAL";

/**
 * One closed route family for replacing an existing Xero DRAFT document.
 * The exact provider UUID and optimistic version are part of the fact; the
 * nested replacement remains one of the already-released complete create
 * document shapes.  It is intentionally not a patch and not six generic
 * object-mutation routes.
 */
export type DraftDocumentUpdateRoute = "DRAFT_DOCUMENT_UPDATE";

export type DraftDocumentUpdateAction =
  | "customer_invoice.update_draft"
  | "supplier_bill.update_draft"
  | "quote.update_draft"
  | "purchase_order.update_draft"
  | "credit_note.update_draft"
  | "manual_journal.update_draft";

/**
 * Closed route for promoting one already-existing Xero draft. It is kept
 * disjoint from NativeDocumentRoute because it mutates an exact provider UUID
 * rather than creating a new document from source economics.
 */
export type LedgerStateTransitionRoute = "LEDGER_STATE_TRANSITION";

export type LedgerStateTransitionAction =
  | "customer_invoice.authorise"
  | "supplier_bill.authorise"
  | "manual_journal.post";

/** Typed Case routes for the three released reference-data mutations only. */
export type ReferenceDataRoute =
  | "CONTACT_BASIC_UPDATE"
  | "ITEM_BASIC_CREATE_UNTRACKED"
  | "ITEM_BASIC_UPDATE_UNTRACKED"
  | "TRACKING_REFERENCE_DATA";


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

export interface CommercialDocumentLine {
  lineId: string;
  description: string;
  quantity: string;
  unitAmount: string;
  /** Explicit provider-native account code declared for this exact line. */
  accountCode: string;
  /** Explicit provider-native TaxType declared for this exact line. */
  taxType: string;
}

/**
 * A quote or a purchase order: invoice-/bill-shaped (a counterparty, lines,
 * dates, a currency) but not a ledger event, since Xero posts no journal
 * lines for either. Kept as its own fact kind -- not a NativeDocumentFact
 * variant -- so it can never be routed through machinery built for documents
 * that post to the general ledger (see CommercialDocumentRoute).
 *
 * There is deliberately no declaredNet/declaredTax/declaredGross here: Xero
 * computes tax on these objects itself from each line's TaxType, and the
 * released adapter reports only an entered (pre-tax) line total, not a
 * caller-asserted net/tax/gross split for the compiler to reconcile against.
 */
export interface CommercialDocumentFact extends AccountingFactBase {
  kind: "COMMERCIAL_DOCUMENT";
  documentKind: "QUOTE" | "PURCHASE_ORDER";
  /** QUOTE is always CUSTOMER-facing; PURCHASE_ORDER is always SUPPLIER-facing. */
  counterpartyRole: "CUSTOMER" | "SUPPLIER";
  reference: string;
  documentDate: string;
  /** QUOTE only, and required for it: when the quoted price stops being valid. */
  expiryDate?: string;
  /** PURCHASE_ORDER only, both optional logistics dates. */
  expectedArrivalDate?: string;
  deliveryDate?: string;
  currency: string;
  contactName: string;
  /** Source-supported namespace for resolving the existing counterparty. */
  contactDurableIdentity?: ContactDurableIdentity;
  lineAmountType: "EXCLUSIVE" | "INCLUSIVE" | "NO_TAX";
  lines: CommercialDocumentLine[];
  documentValidity: AccountingDocumentValidity;
}

export interface BalancedJournalLine {
  lineId: string;
  description: string;
  /** Explicit provider-native account code declared for this exact line. */
  accountCode: string;
  /** Explicit provider-native TaxType declared for this exact line. */
  taxType: string;
  /** Exactly one of debit/credit is present on every line -- enforced at the schema boundary. */
  debit?: string;
  credit?: string;
}

/**
 * A manual (general) journal: N debit/credit lines, a narration and a date.
 * Kept parallel to, not merged into, NativeDocumentFact -- see the design
 * record this fact type implements (docs/MANUAL-JOURNAL-DESIGN-2026-08-20.md)
 * for why the earlier LedgerEventFact-union proposal was overturned. A
 * journal has no counterparty, so there is deliberately no contactName or
 * counterpartyRole here, and no ACCREC/ACCPAY document type, so no
 * reference/referenceKind either -- Xero's ManualJournal carries no natural
 * unique number the way an Invoice's InvoiceNumber does. There is also no
 * declaredNet/declaredTax/declaredGross: a journal's only caller-declared
 * total is the balance of its own lines (see JOURNAL_NOT_BALANCED in
 * accountingCaseCompiler.ts), not a source figure to reconcile against.
 */
export interface BalancedJournalFact extends AccountingFactBase {
  kind: "BALANCED_JOURNAL";
  narration: string;
  date: string;
  lines: BalancedJournalLine[];
  documentValidity: AccountingDocumentValidity;
}

export type DraftDocumentUpdateReplacement =
  | NativeDocumentFact
  | CommercialDocumentFact
  | BalancedJournalFact;

export interface DraftDocumentUpdateFact extends AccountingFactBase {
  kind: "DRAFT_DOCUMENT_UPDATE";
  actionId: DraftDocumentUpdateAction;
  targetXeroObjectId: string;
  /** ISO-8601 instant with an explicit UTC offset, sealed into the permit. */
  expectedUpdatedAt: string;
  /** Complete DRAFT replacement; never a partial patch. */
  replacement: DraftDocumentUpdateReplacement;
}

export type LedgerStateTransitionFact = AccountingFactBase & Readonly<{
  kind: "LEDGER_STATE_TRANSITION";
  actionId: LedgerStateTransitionAction;
  targetXeroObjectId: string;
}>;

export type LedgerAdjustmentRoute = "LEDGER_ADJUSTMENT";

/** One exact existing-object ledger adjustment using the provider canonical schema. */
export type LedgerAdjustmentFact = AccountingFactBase & Readonly<
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "customer_invoice.void"; payload: VoidInvoicePayload & { invoiceType: "ACCREC" } }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "supplier_bill.void"; payload: VoidInvoicePayload & { invoiceType: "ACCPAY" } }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "credit_note.authorise"; payload: AuthoriseCreditNotePayload }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "credit_note.allocate"; payload: AllocateCreditNotePayload }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "credit_note.refund"; payload: RefundCreditNotePayload }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "credit_note.void"; payload: VoidCreditNotePayload }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "credit_note.unallocate"; payload: UnallocateCreditNotePayload }
  | { kind: "LEDGER_ADJUSTMENT"; actionId: "manual_journal.void"; payload: VoidManualJournalPayload }
>;

export type PaymentBankLedgerRoute = "PAYMENT_BANK_LEDGER";
export type PaymentBankLedgerAction = "payment.create" | "payment.reverse" |
  "bank_transaction.create" | "bank_transaction.update" | "bank_transaction.reverse";
export type PaymentBankLedgerFact = AccountingFactBase & Readonly<
  | { kind: "PAYMENT_BANK_LEDGER"; actionId: "payment.create"; payload: CanonicalPaymentCreatePayload }
  | { kind: "PAYMENT_BANK_LEDGER"; actionId: "payment.reverse"; payload: CanonicalPaymentReversePayload }
  | { kind: "PAYMENT_BANK_LEDGER"; actionId: "bank_transaction.create"; payload: CanonicalBankTransactionCreatePayload }
  | { kind: "PAYMENT_BANK_LEDGER"; actionId: "bank_transaction.update"; payload: CanonicalBankTransactionUpdatePayload }
  | { kind: "PAYMENT_BANK_LEDGER"; actionId: "bank_transaction.reverse"; payload: CanonicalBankTransactionReversePayload }
>;


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
  | ContactBasicUpdateFact
  | ItemBasicCreateUntrackedFact
  | ItemBasicUpdateUntrackedFact
  | TrackingReferenceDataFact
  | NativeDocumentFact
  | CommercialDocumentFact
  | BalancedJournalFact
  | DraftDocumentUpdateFact
  | LedgerStateTransitionFact
  | LedgerAdjustmentFact
  | PaymentBankLedgerFact
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
  route?: NativeDocumentRoute | CommercialDocumentRoute | BalancedJournalRoute | DraftDocumentUpdateRoute |
    LedgerStateTransitionRoute | LedgerAdjustmentRoute | PaymentBankLedgerRoute | ReferenceDataRoute | "CONTACT_CREATE";
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
    | "credit_note.create_draft"
    | "quote.create_draft"
    | "purchase_order.create_draft"
    | "manual_journal.create_draft"
    | DraftDocumentUpdateAction
    | "customer_invoice.authorise"
    | "supplier_bill.authorise"
    | "manual_journal.post"
    | "contact.update_basic"
    | "item.create_basic_untracked"
    | "item.update_basic_untracked"
    | TrackingReferenceDataAction
    | LedgerAdjustmentAction
    | PaymentBankLedgerAction;
  nativeRoute:
    | NativeDocumentRoute
    | CommercialDocumentRoute
    | BalancedJournalRoute
    | DraftDocumentUpdateRoute
    | LedgerStateTransitionRoute
    | LedgerAdjustmentRoute
    | PaymentBankLedgerRoute
    | ReferenceDataRoute
    | "CONTACT_CREATE";
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
