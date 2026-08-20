import type {
  AgedPayablesInput,
  AgedReceivablesInput,
  BalanceSheetInput,
  CreditNoteType,
  CreateDraftSalesInvoiceInput,
  CreateDraftSupplierBillInput,
  InvoiceType,
  ListContactsInput,
  ListCreditNotesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  PaymentType,
  ProfitAndLossInput,
} from "../domain/schemas.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import type {
  ListBankTransactionsInput,
  ListItemsInput,
  ListJournalsInput,
  ListContactGroupsInput,
  ListManualJournalsInput,
  ListPurchaseOrdersInput,
  ListQuotesInput,
  ListTrackingCategoriesInput,
} from "../domain/extendedReadSchemas.js";
import type { RequestContext } from "../security/requestContext.js";
import type {
  BankTransactionSnapshot,
  BankTransactionSummary,
  ItemSummary,
  JournalSummary,
  ManualJournalSnapshot,
  ManualJournalSummary,
  PurchaseOrderSnapshot,
  PurchaseOrderSummary,
  QuoteSnapshot,
  QuoteSummary,
} from "./xeroExtendedReadMapper.js";

export type AccountingPrincipal = string | RequestContext;

export interface ConnectionSummary {
  connected: boolean;
  tenant?: {
    id: string;
    name: string;
  };
  scopes: string[];
  tokenExpiresAt?: string;
  connectUrl?: string;
  connectUrlExpiresAt?: string;
  connectionLifecycle?: {
    organisationBinding: "ONE_IMMUTABLE_ORGANISATION_PER_TARGET_SESSION";
    currentTenantMeaning: "COMPATIBILITY_POINTER_NOT_LEDGER_TARGET";
    targetSessionLifetime: "SHORT_LIVED_SERVER_ENFORCED";
    accessTokenRefresh: "AUTOMATIC_NO_USER_ACTION";
    organisationChange: {
      supported: true;
      requiresFreshXeroOAuth: "ONLY_IF_ORGANISATION_NOT_ALREADY_AUTHORISED";
      silentChatSwitchAllowed: false;
      hostSteps: readonly [
        "ASK_AGENT_TO_SWITCH_XERO_ORGANISATION",
        "OPEN_SHORT_LIVED_CONFIRMATION_LINK",
        "SELECT_EXACTLY_ONE_XERO_ORGANISATION",
        "PIN_SELECTED_ORGANISATION",
        "VERIFY_WITH_PINNED_ORGANISATION_READ",
      ];
    };
  };
}

export interface OrganisationSummary {
  organisationId: string;
  name: string;
  legalName?: string;
  countryCode?: string;
  baseCurrency?: string;
  organisationType?: string;
  version?: string;
  /** Direct Xero Organisation fields. Omission means unknown; callers must not infer them from tax-rate lists. */
  paysTax?: boolean;
  financialYearEndDay?: number;
  financialYearEndMonth?: number;
  salesTaxBasis?: string;
  salesTaxPeriod?: string;
  defaultSalesTax?: string;
  defaultPurchasesTax?: string;
  periodLockDate?: string;
  endOfYearLockDate?: string;
  isDemoCompany?: boolean;
  organisationStatus?: string;
}

export interface AccountSummary {
  accountId?: string;
  code?: string;
  name?: string;
  type?: string;
  class?: string;
  status?: string;
  taxType?: string;
  systemAccount?: string;
}

export interface TaxRateSummary {
  name?: string;
  taxType?: string;
  status?: string;
  displayTaxRate?: string;
  effectiveRate?: string;
  canApplyToExpenses?: boolean;
  canApplyToAssets?: boolean;
  canApplyToLiabilities?: boolean;
  canApplyToRevenue?: boolean;
  canApplyToEquity?: boolean;
}

export interface ContactSummary {
  contactId: string;
  name?: string;
  /** Strong, server-read business identity fields used by Accounting Case matching. */
  email?: string;
  companyNumber?: string;
  accountNumber?: string;
  contactNumber?: string;
  status?: string;
  isSupplier?: boolean;
  isCustomer?: boolean;
  defaultCurrency?: string;
  purchasesDefaultAccountCode?: string;
  accountsPayableTaxType?: string;
}

export interface ContactSearchResult {
  contacts: ContactSummary[];
  /** Search returns one caller-selected bounded Xero page; this evidence prevents false claims of exhaustive matching. */
  pagination: ReadPageEvidence;
}

export interface ContactListResult {
  contacts: ContactSummary[];
  pagination: ReadPageEvidence;
}

export interface InvoiceLineSnapshot {
  lineItemId?: string;
  description: string;
  descriptionTruncated?: boolean;
  quantity: string;
  unitAmount: string;
  lineAmount?: string;
  taxAmount?: string;
  accountId?: string;
  accountCode: string;
  taxType: string;
}

export type SupplierBillLineSnapshot = InvoiceLineSnapshot;

export interface InvoiceSummary {
  invoiceId: string;
  type: InvoiceType;
  status: string;
  contact: {
    contactId: string;
    name?: string;
  };
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  currency?: string;
  currencyRate?: string;
  reference?: string;
  subTotal?: string;
  totalTax?: string;
  total?: string;
  amountDue?: string;
  amountPaid?: string;
  amountCredited?: string;
  fullyPaidOnDate?: string;
  attachmentsKnown?: boolean;
  hasAttachments?: boolean;
  updatedAt?: string;
}

export interface InvoiceListResult {
  invoices: InvoiceSummary[];
  pagination: {
    page: number;
    pageSize: number;
    returned: number;
    providerPageCount?: number;
    providerItemCount?: number;
    hasNextPage: boolean;
    hasNextPageIsEstimated: boolean;
    omittedInvalid: number;
    omittedOverflow?: number;
  };
}

export interface ReadPageEvidence {
  page: number;
  pageSize: number;
  returned: number;
  providerPageCount?: number;
  providerItemCount?: number;
  hasNextPage: boolean;
  hasNextPageIsEstimated: boolean;
  omittedInvalid: number;
  omittedOverflow?: number;
}

export interface CreditNoteSummary {
  creditNoteId: string;
  type: CreditNoteType;
  status: string;
  contact: {
    contactId: string;
    name?: string;
  };
  creditNoteNumber?: string;
  creditNoteDate?: string;
  dueDate?: string;
  fullyPaidOnDate?: string;
  currency?: string;
  reference?: string;
  subTotal?: string;
  totalTax?: string;
  total?: string;
  remainingCredit?: string;
  appliedAmount?: string;
  attachmentsKnown: boolean;
  hasAttachments?: boolean;
  associatedInvoiceIds: string[];
  associatedInvoiceIdCount: number;
  associatedInvoiceIdsTruncated: boolean;
  updatedAt?: string;
}

export interface CreditNoteListResult {
  creditNotes: CreditNoteSummary[];
  pagination: ReadPageEvidence;
}

/** Exact provider GET projection used by duplicate-history and readback controls. */
export interface CreditNoteSnapshot extends CreditNoteSummary {
  tenantId: string;
  lineAmountType?: string;
  lines: InvoiceLineSnapshot[];
  lineItemCount?: number;
  linesTruncated?: boolean;
}

export interface PaymentSummary {
  paymentId: string;
  type: PaymentType;
  status: string;
  paymentDate?: string;
  amount: string;
  currency?: string;
  currencyKnown: boolean;
  currencySource: "INVOICE" | "CREDIT_NOTE" | "PREPAYMENT" | "OVERPAYMENT" | "UNAVAILABLE";
  bankAmount?: string;
  bankCurrency?: string;
  bankCurrencyKnown: boolean;
  reference?: string;
  isReconciled?: boolean;
  contact?: {
    contactId: string;
    name?: string;
  };
  invoiceId?: string;
  invoiceNumber?: string;
  creditNoteId?: string;
  creditNoteNumber?: string;
  prepaymentId?: string;
  overpaymentId?: string;
  batchPaymentId?: string;
  account?: {
    accountId?: string;
    code?: string;
    name?: string;
  };
  updatedAt?: string;
}

export interface PaymentListResult {
  payments: PaymentSummary[];
  pagination: ReadPageEvidence;
}

export interface QuoteListResult {
  quotes: QuoteSummary[];
  pagination: ReadPageEvidence;
}

export interface PurchaseOrderListResult {
  purchaseOrders: PurchaseOrderSummary[];
  pagination: ReadPageEvidence;
}

export interface ManualJournalListResult {
  manualJournals: ManualJournalSummary[];
  pagination: ReadPageEvidence;
}

/**
 * `/Journals` pages by an offset on JournalNumber, not by page number, and
 * proves exhaustion only by returning an empty page - so this is not
 * `ReadPageEvidence` (there is no provider page/item count and no agent-facing
 * page_size). `hasNextPage`/`hasNextPageIsEstimated`/`omittedInvalid` are kept
 * in the same vocabulary as `ReadPageEvidence` on purpose, so the shared
 * "collection" read-evidence completeness heuristic in xeroReadEvidence.ts
 * reads this correctly without needing its own per-tool branch.
 */
export interface JournalPageEvidence {
  requestedOffset: number;
  returned: number;
  /** The highest raw JournalNumber seen in this page; pass as `offset` to continue. Absent only when this page was empty. */
  nextOffset?: number;
  /** True only when this call itself returned zero journals - the one signal Xero proves exhaustion with. */
  exhausted: boolean;
  hasNextPage: boolean;
  hasNextPageIsEstimated: boolean;
  omittedInvalid: number;
}

export interface JournalListResult {
  journals: JournalSummary[];
  pagination: JournalPageEvidence;
}

export interface TrackingOptionSummary {
  trackingOptionId: string;
  name?: string;
  status?: string;
}

export interface TrackingCategorySummary {
  trackingCategoryId: string;
  name?: string;
  status?: string;
  options: TrackingOptionSummary[];
  optionCount: number;
  optionsTruncated: boolean;
  omittedInvalidOptions: number;
}

export interface TrackingCategoryListResult {
  trackingCategories: TrackingCategorySummary[];
  pagination: ReadPageEvidence;
}

export interface ContactGroupSummary {
  contactGroupId: string;
  name?: string;
  status?: string;
}

export interface ContactGroupListResult {
  contactGroups: ContactGroupSummary[];
  pagination: ReadPageEvidence;
}

export interface ItemListResult {
  items: ItemSummary[];
  pagination: ReadPageEvidence;
}

export interface BankTransactionListResult {
  bankTransactions: BankTransactionSummary[];
  pagination: ReadPageEvidence;
}

export interface InvoiceSnapshot extends InvoiceSummary {
  tenantId: string;
  lineAmountType?: string;
  lines: InvoiceLineSnapshot[];
  lineItemCount?: number;
  linesTruncated?: boolean;
}

export type SupplierBillSnapshot = Omit<InvoiceSnapshot, "type"> & { type: "ACCPAY" };
export type SalesInvoiceSnapshot = Omit<InvoiceSnapshot, "type"> & { type: "ACCREC" };

export interface ProviderWriteResult {
  bill: SupplierBillSnapshot;
  receipt: Record<string, unknown>;
}

export interface ProviderSalesInvoiceWriteResult {
  invoice: SalesInvoiceSnapshot;
  receipt: Record<string, unknown>;
}

export interface ProviderDraftWriteEvidence {
  invoiceId: string;
  receipt: Record<string, unknown>;
}

export type RecordProviderDraftWriteEvidence = (
  evidence: ProviderDraftWriteEvidence,
) => Promise<void>;

export interface ActorTenantContext {
  actorId: string;
  tenantId: string;
  tenantName: string;
}

export interface SupplierBillDraftReferenceData {
  tenant: {
    id: string;
    name: string;
  };
  contacts: ContactSummary[];
  contactsComplete: boolean;
  accounts: AccountSummary[];
  taxRates: TaxRateSummary[];
}

export interface AccountingProvider {
  connectionStatus(principal: AccountingPrincipal): Promise<ConnectionSummary>;
  resolveContext(principal: AccountingPrincipal): Promise<ActorTenantContext>;
  getOrganisation(principal: AccountingPrincipal): Promise<OrganisationSummary>;
  listAccounts(principal: AccountingPrincipal): Promise<AccountSummary[]>;
  listTaxRates(principal: AccountingPrincipal): Promise<TaxRateSummary[]>;
  listContacts(principal: AccountingPrincipal, input: ListContactsInput): Promise<ContactListResult>;
  searchContacts(principal: AccountingPrincipal, query: string, limit: number, page?: number): Promise<ContactSearchResult>;
  getSupplierBillDraftReferenceData(
    principal: AccountingPrincipal,
    supplierQuery?: string,
  ): Promise<SupplierBillDraftReferenceData>;
  getContact(principal: AccountingPrincipal, contactId: string): Promise<ContactSummary | undefined>;
  listInvoices(principal: AccountingPrincipal, input: ListInvoicesInput): Promise<InvoiceListResult>;
  listCreditNotes(principal: AccountingPrincipal, input: ListCreditNotesInput): Promise<CreditNoteListResult>;
  listPayments(principal: AccountingPrincipal, input: ListPaymentsInput): Promise<PaymentListResult>;
  listQuotes(principal: AccountingPrincipal, input: ListQuotesInput): Promise<QuoteListResult>;
  getQuote(principal: AccountingPrincipal, quoteId: string): Promise<QuoteSnapshot>;
  listPurchaseOrders(
    principal: AccountingPrincipal,
    input: ListPurchaseOrdersInput,
  ): Promise<PurchaseOrderListResult>;
  getPurchaseOrder(principal: AccountingPrincipal, purchaseOrderId: string): Promise<PurchaseOrderSnapshot>;
  listManualJournals(
    principal: AccountingPrincipal,
    input: ListManualJournalsInput,
  ): Promise<ManualJournalListResult>;
  getManualJournal(principal: AccountingPrincipal, manualJournalId: string): Promise<ManualJournalSnapshot>;
  listItems(principal: AccountingPrincipal, input: ListItemsInput): Promise<ItemListResult>;
  getItem(principal: AccountingPrincipal, itemId: string): Promise<ItemSummary>;
  listBankTransactions(
    principal: AccountingPrincipal,
    input: ListBankTransactionsInput,
  ): Promise<BankTransactionListResult>;
  getBankTransaction(
    principal: AccountingPrincipal,
    bankTransactionId: string,
  ): Promise<BankTransactionSnapshot>;
  getInvoice(principal: AccountingPrincipal, invoiceId: string, expectedType?: InvoiceType): Promise<InvoiceSnapshot>;
  getCreditNote(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedType?: CreditNoteType,
  ): Promise<CreditNoteSnapshot>;
  getSupplierBill(principal: AccountingPrincipal, invoiceId: string): Promise<SupplierBillSnapshot>;
  createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderWriteResult>;
  createDraftSalesInvoice(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderSalesInvoiceWriteResult>;
  getTrialBalance(principal: AccountingPrincipal, date?: string): Promise<Record<string, unknown>>;
  listJournals(principal: AccountingPrincipal, input: ListJournalsInput): Promise<JournalListResult>;
  getProfitAndLoss(principal: AccountingPrincipal, input: ProfitAndLossInput): Promise<Record<string, unknown>>;
  getBalanceSheet(principal: AccountingPrincipal, input: BalanceSheetInput): Promise<Record<string, unknown>>;
  getAgedReceivables(principal: AccountingPrincipal, input: AgedReceivablesInput): Promise<Record<string, unknown>>;
  getAgedPayables(principal: AccountingPrincipal, input: AgedPayablesInput): Promise<Record<string, unknown>>;
  getPayment(principal: AccountingPrincipal, paymentId: string): Promise<PaymentSummary>;
  listTrackingCategories(
    principal: AccountingPrincipal,
    input: ListTrackingCategoriesInput,
  ): Promise<TrackingCategoryListResult>;
  listContactGroups(principal: AccountingPrincipal, input: ListContactGroupsInput): Promise<ContactGroupListResult>;
}
