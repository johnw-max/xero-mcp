import type {
  CreditNoteType,
  CreateDraftSalesInvoiceInput,
  CreateDraftSupplierBillInput,
  InvoiceType,
  ListContactsInput,
  ListCreditNotesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  PaymentType,
} from "../domain/schemas.js";
import type {
  ListBankTransactionsInput,
  ListItemsInput,
  ListManualJournalsInput,
  ListPurchaseOrdersInput,
  ListQuotesInput,
} from "../domain/extendedReadSchemas.js";
import type { RequestContext } from "../security/requestContext.js";
import type {
  BankTransactionSnapshot,
  BankTransactionSummary,
  ItemSummary,
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
    organisationBinding: "EXACTLY_ONE_CURRENT_ORGANISATION_PER_MCP_INSTALLATION";
    accessTokenRefresh: "AUTOMATIC_NO_USER_ACTION";
    organisationChange: {
      supported: true;
      requiresFreshXeroOAuth: "ONLY_IF_ORGANISATION_NOT_ALREADY_AUTHORISED";
      silentChatSwitchAllowed: false;
      hostSteps: readonly [
        "ASK_AGENT_TO_SWITCH_XERO_ORGANISATION",
        "OPEN_SHORT_LIVED_CONFIRMATION_LINK",
        "SELECT_EXACTLY_ONE_XERO_ORGANISATION",
        "RETURN_TO_AGENT_AND_VERIFY_CONNECTION_STATUS",
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
  canApplyToExpenses?: boolean;
  canApplyToAssets?: boolean;
  canApplyToLiabilities?: boolean;
  canApplyToRevenue?: boolean;
  canApplyToEquity?: boolean;
}

export interface ContactSummary {
  contactId: string;
  name?: string;
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
  getSupplierBill(principal: AccountingPrincipal, invoiceId: string): Promise<SupplierBillSnapshot>;
  createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
  ): Promise<ProviderWriteResult>;
  createDraftSalesInvoice(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    idempotencyKey: string,
    recordWriteEvidence?: RecordProviderDraftWriteEvidence,
  ): Promise<ProviderSalesInvoiceWriteResult>;
  authoriseSupplierBill(
    principal: AccountingPrincipal,
    invoiceId: string,
    idempotencyKey: string,
  ): Promise<ProviderWriteResult>;
  getTrialBalance(principal: AccountingPrincipal, date?: string): Promise<Record<string, unknown>>;
}
