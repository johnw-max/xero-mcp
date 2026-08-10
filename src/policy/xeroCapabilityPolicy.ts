/**
 * Product policy for Xero business actions.
 *
 * This catalog deliberately separates official Xero transport support from the
 * actions that this release permits an Agent to perform. It is a policy data
 * module only; importing it does not register MCP tools or grant OAuth scopes.
 */

export const XERO_BUSINESS_OBJECTS = [
  "SYSTEM",
  "ORGANISATION",
  "TAX_RATE",
  "REPORT",
  "CUSTOMER_INVOICE",
  "SUPPLIER_BILL",
  "PURCHASE_ORDER",
  "QUOTE",
  "CREDIT_NOTE",
  "MANUAL_JOURNAL",
  "CONTACT",
  "ACCOUNT",
  "ITEM",
  "ATTACHMENT",
  "PAYMENT",
  "BANK_TRANSACTION",
  "RECONCILIATION",
] as const;

export type XeroBusinessObject = (typeof XERO_BUSINESS_OBJECTS)[number];

export const XERO_RISK_CLASSES = [
  "READ_PREPARE",
  "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
  "DUAL_APPROVAL",
  "DISABLED",
] as const;

export type XeroRiskClass = (typeof XERO_RISK_CLASSES)[number];

export const XERO_RELEASE_DECISIONS = [
  "AVAILABLE_NOW",
  "PLANNED_CONTROLLED",
  "PREPARE_ONLY",
  "NOT_EXPOSED",
] as const;

export type XeroReleaseDecision = (typeof XERO_RELEASE_DECISIONS)[number];

export const XERO_OFFICIAL_SUPPORT_LEVELS = [
  "READ_ONLY",
  "READ_WRITE",
  "INDIRECT_READ_INPUTS",
  "NOT_LISTED",
  "NO_DIRECT_ACTION",
] as const;

export type XeroOfficialSupportLevel = (typeof XERO_OFFICIAL_SUPPORT_LEVELS)[number];

export const XERO_CONTROL_REQUIREMENTS = [
  "NONE",
  "EXPLICIT_CONFIRMATION",
  "DUAL_APPROVAL",
  "NOT_PERMITTED",
] as const;

export type XeroControlRequirement = (typeof XERO_CONTROL_REQUIREMENTS)[number];

export const XERO_CAPABILITY_PERMISSIONS = [
  "XERO_ACCOUNTING_READ",
  "XERO_DRAFT_WRITE",
  "XERO_DUAL_APPROVAL",
] as const;

export type XeroCapabilityPermission = (typeof XERO_CAPABILITY_PERMISSIONS)[number];

export interface XeroOfficialSupport {
  readonly accountingApi: XeroOfficialSupportLevel;
  readonly officialMcp: XeroOfficialSupportLevel;
  readonly note: string;
}

export interface XeroCapabilityPolicy {
  readonly actionId: string;
  readonly object: XeroBusinessObject;
  readonly label: string;
  readonly riskClass: XeroRiskClass;
  readonly officialSupport: XeroOfficialSupport;
  readonly releaseDecision: XeroReleaseDecision;
  readonly releaseRationale: string;
}

const INVOICE_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP cover ACCREC invoices; official transport support is not release approval.",
} as const satisfies XeroOfficialSupport;

const CONNECTION_STATUS_SUPPORT = {
  accountingApi: "NO_DIRECT_ACTION",
  officialMcp: "NOT_LISTED",
  note: "Connection status is a product transport and tenant-binding check, not a Xero accounting mutation.",
} as const satisfies XeroOfficialSupport;

const ORGANISATION_SUPPORT = {
  accountingApi: "READ_ONLY",
  officialMcp: "READ_ONLY",
  note: "Organisation identity is read from the server-bound Xero connection and Accounting API settings surface.",
} as const satisfies XeroOfficialSupport;

const TAX_RATE_SUPPORT = {
  accountingApi: "READ_ONLY",
  officialMcp: "READ_ONLY",
  note: "Tax rates are accounting settings reference data and are exposed read-only in this product.",
} as const satisfies XeroOfficialSupport;

const TRIAL_BALANCE_SUPPORT = {
  accountingApi: "READ_ONLY",
  officialMcp: "READ_ONLY",
  note: "The Accounting Reports API and official MCP expose trial-balance reads; this product keeps the result bounded.",
} as const satisfies XeroOfficialSupport;

const BILL_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and the official MCP invoice tools cover ACCPAY supplier bills.",
} as const satisfies XeroOfficialSupport;

const PURCHASE_ORDER_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "NOT_LISTED",
  note: "Accounting API supports purchase orders; the official MCP command catalog does not list a purchase-order tool.",
} as const satisfies XeroOfficialSupport;

const QUOTE_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP support quote reads and controlled writes.",
} as const satisfies XeroOfficialSupport;

const CREDIT_NOTE_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP support credit-note reads and writes.",
} as const satisfies XeroOfficialSupport;

const MANUAL_JOURNAL_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP support manual journals, including statuses this product intentionally withholds.",
} as const satisfies XeroOfficialSupport;

const CONTACT_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP support contact reads, creation, and updates.",
} as const satisfies XeroOfficialSupport;

const ACCOUNT_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_ONLY",
  note: "Accounting API supports chart-of-accounts writes; the official MCP catalog exposes account reads but no account write command.",
} as const satisfies XeroOfficialSupport;

const ITEM_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Accounting API and official MCP support item reads, creation, and updates.",
} as const satisfies XeroOfficialSupport;

const ATTACHMENT_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "NOT_LISTED",
  note: "Accounting Attachments endpoints support selected parent objects; the official MCP catalog has no attachment command.",
} as const satisfies XeroOfficialSupport;

const PAYMENT_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Official interfaces can create payments, but Xero has no harmless payment DRAFT state.",
} as const satisfies XeroOfficialSupport;

const BANK_TRANSACTION_SUPPORT = {
  accountingApi: "READ_WRITE",
  officialMcp: "READ_WRITE",
  note: "Official interfaces cover bank transactions, but these writes affect cash-account records and have no safe DRAFT state.",
} as const satisfies XeroOfficialSupport;

const RECONCILIATION_ANALYSIS_SUPPORT = {
  accountingApi: "INDIRECT_READ_INPUTS",
  officialMcp: "INDIRECT_READ_INPUTS",
  note: "Available accounting records can support candidate matching; this is not the same as completing Xero bank reconciliation.",
} as const satisfies XeroOfficialSupport;

const RECONCILIATION_FINALISE_SUPPORT = {
  accountingApi: "NO_DIRECT_ACTION",
  officialMcp: "NO_DIRECT_ACTION",
  note: "The public Accounting API and official MCP do not expose a generic final-reconciliation action.",
} as const satisfies XeroOfficialSupport;

const PURCHASE_ORDER_EXTERNAL_DELIVERY_SUPPORT = {
  accountingApi: "NO_DIRECT_ACTION",
  officialMcp: "NO_DIRECT_ACTION",
  note: "The public Accounting API can mark an approved purchase order as sent, but does not provide the actual email/delivery action.",
} as const satisfies XeroOfficialSupport;

const QUOTE_EXTERNAL_DELIVERY_SUPPORT = {
  accountingApi: "NO_DIRECT_ACTION",
  officialMcp: "NO_DIRECT_ACTION",
  note: "Setting quote status to SENT records state; it is not evidence that an email or other delivery was performed.",
} as const satisfies XeroOfficialSupport;

export const XERO_CAPABILITY_POLICIES = [
  {
    actionId: "system.connection_status",
    object: "SYSTEM",
    label: "Check the bound Xero connection and organisation identity",
    riskClass: "READ_PREPARE",
    officialSupport: CONNECTION_STATUS_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "This reports server-resolved connection identity without exposing credentials or mutating Xero.",
  },
  {
    actionId: "system.organisation_switch_prepare",
    object: "SYSTEM",
    label: "Start a user-confirmed Xero organisation switch",
    riskClass: "READ_PREPARE",
    officialSupport: CONNECTION_STATUS_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "This creates only a short-lived confirmation capability. The ledger changes only after exact user selection on the MCP-hosted page, and Xero accounting data is not mutated.",
  },
  {
    actionId: "organisation.read_prepare",
    object: "ORGANISATION",
    label: "Read the server-bound Xero organisation",
    riskClass: "READ_PREPARE",
    officialSupport: ORGANISATION_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Organisation identity is required to ground every accounting response in the exact bound tenant.",
  },
  {
    actionId: "tax_rate.read_prepare",
    object: "TAX_RATE",
    label: "Read active Xero tax rates for coding preparation",
    riskClass: "READ_PREPARE",
    officialSupport: TAX_RATE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Read-only tax reference data supports preparation without changing tax configuration.",
  },
  {
    actionId: "report.trial_balance_read",
    object: "REPORT",
    label: "Read a bounded trial balance report",
    riskClass: "READ_PREPARE",
    officialSupport: TRIAL_BALANCE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "The bounded report is read-only and supports accounting analysis without posting or reconciliation.",
  },
  {
    actionId: "customer_invoice.read_prepare",
    object: "CUSTOMER_INVOICE",
    label: "Read customer invoices and prepare analysis or a proposed draft",
    riskClass: "READ_PREPARE",
    officialSupport: INVOICE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing invoice reads can support history, ageing, duplicate checks, and preparation without mutation.",
  },
  {
    actionId: "customer_invoice.create_draft",
    object: "CUSTOMER_INVOICE",
    label: "Create an ACCREC customer invoice in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: INVOICE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "The code-level controlled draft path now enforces exact confirmation, idempotency, tenant binding, and exact read-back; runtime execution still requires the write gate and exact tenant allowlist.",
  },
  {
    actionId: "customer_invoice.update_draft",
    object: "CUSTOMER_INVOICE",
    label: "Update an existing ACCREC DRAFT invoice",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: INVOICE_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "The original object version and complete replacement payload must be confirmed to prevent stale overwrites.",
  },
  {
    actionId: "customer_invoice.submit_authorise_or_send",
    object: "CUSTOMER_INVOICE",
    label: "Submit, authorise, or send a customer invoice",
    riskClass: "DUAL_APPROVAL",
    officialSupport: INVOICE_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "These actions affect the ledger or create an external customer communication and need independent approval.",
  },
  {
    actionId: "customer_invoice.pay_void_or_delete",
    object: "CUSTOMER_INVOICE",
    label: "Pay, void, or delete a customer invoice",
    riskClass: "DISABLED",
    officialSupport: INVOICE_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Cash application and destructive/final status changes are outside the Agent write boundary.",
  },
  {
    actionId: "supplier_bill.read_prepare",
    object: "SUPPLIER_BILL",
    label: "Read supplier bills and prepare coding or a proposed draft",
    riskClass: "READ_PREPARE",
    officialSupport: BILL_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing ACCPAY reads support history, open-bill review, duplicate checks, and preparation without mutation.",
  },
  {
    actionId: "supplier_bill.create_draft",
    object: "SUPPLIER_BILL",
    label: "Create an ACCPAY supplier bill in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: BILL_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "This is the currently released controlled write and requires exact confirmation plus all write safeguards.",
  },
  {
    actionId: "supplier_bill.update_draft",
    object: "SUPPLIER_BILL",
    label: "Update an existing ACCPAY DRAFT bill",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: BILL_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Draft update needs object-version conflict protection and complete post-write comparison before release.",
  },
  {
    actionId: "supplier_bill.submit_or_authorise",
    object: "SUPPLIER_BILL",
    label: "Submit or authorise a supplier bill",
    riskClass: "DUAL_APPROVAL",
    officialSupport: BILL_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Ledger-impacting status changes require segregation of duties.",
  },
  {
    actionId: "supplier_bill.pay_void_or_delete",
    object: "SUPPLIER_BILL",
    label: "Pay, void, or delete a supplier bill",
    riskClass: "DISABLED",
    officialSupport: BILL_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Cash movement and destructive/final status changes remain outside the Agent boundary.",
  },
  {
    actionId: "purchase_order.read_prepare",
    object: "PURCHASE_ORDER",
    label: "Read purchase orders and prepare analysis or a proposed draft",
    riskClass: "READ_PREPARE",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "The dedicated read wrapper now provides bounded output and explicit pagination evidence without mutation.",
  },
  {
    actionId: "purchase_order.create_draft",
    object: "PURCHASE_ORDER",
    label: "Create a purchase order in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "The controlled DRAFT path binds OAuth tenant, source unit, immutable payload, exact confirmation, idempotency, and exact read-back; runtime execution still requires the write gate and tenant allowlist.",
  },
  {
    actionId: "purchase_order.update_draft",
    object: "PURCHASE_ORDER",
    label: "Update an existing DRAFT purchase order",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Require immutable intent and stale-version protection before allowing replacement of a draft.",
  },
  {
    actionId: "purchase_order.submit_or_authorise",
    object: "PURCHASE_ORDER",
    label: "Submit or authorise a purchase order",
    riskClass: "DUAL_APPROVAL",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "This creates a purchasing commitment and requires independent approval.",
  },
  {
    actionId: "purchase_order.mark_sent",
    object: "PURCHASE_ORDER",
    label: "Mark an approved purchase order as sent without delivering it",
    riskClass: "DUAL_APPROVAL",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "The sentToContact flag is a record-state change only; it requires approval and must never be reported as actual delivery.",
  },
  {
    actionId: "purchase_order.email_or_dispatch",
    object: "PURCHASE_ORDER",
    label: "Email or otherwise deliver a purchase order to a supplier",
    riskClass: "DUAL_APPROVAL",
    officialSupport: PURCHASE_ORDER_EXTERNAL_DELIVERY_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "External delivery is a separate communication action and is not provided by the public Accounting API/MCP wrapper.",
  },
  {
    actionId: "purchase_order.convert_to_bill_or_delete",
    object: "PURCHASE_ORDER",
    label: "Convert a purchase order to a bill or delete it",
    riskClass: "DISABLED",
    officialSupport: PURCHASE_ORDER_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Cross-document creation and destructive actions are not exposed in the current control model.",
  },
  {
    actionId: "quote.read_prepare",
    object: "QUOTE",
    label: "Read quotes and prepare analysis or a proposed draft",
    riskClass: "READ_PREPARE",
    officialSupport: QUOTE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Bounded quote reads and tenant-scoped service controls are present; quote writes remain unreleased.",
  },
  {
    actionId: "quote.create_draft",
    object: "QUOTE",
    label: "Create a quote in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: QUOTE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "The controlled DRAFT path validates exact references and economic read-back, and remains gated by OAuth tenant, explicit confirmation, idempotency, write gate, and tenant allowlist.",
  },
  {
    actionId: "quote.update_draft",
    object: "QUOTE",
    label: "Update an existing DRAFT quote",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: QUOTE_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Require object-version conflict checks and exact read-back before release.",
  },
  {
    actionId: "quote.mark_sent",
    object: "QUOTE",
    label: "Mark a quote as SENT without delivering it",
    riskClass: "DUAL_APPROVAL",
    officialSupport: QUOTE_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "SENT is a Xero record status, not proof of email delivery; changing it still needs independent approval.",
  },
  {
    actionId: "quote.email_or_dispatch",
    object: "QUOTE",
    label: "Email or otherwise deliver a quote to a customer",
    riskClass: "DUAL_APPROVAL",
    officialSupport: QUOTE_EXTERNAL_DELIVERY_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "External delivery represents price and terms and is separate from merely setting Xero status to SENT.",
  },
  {
    actionId: "quote.accept_decline_or_convert",
    object: "QUOTE",
    label: "Accept, decline, or convert a quote",
    riskClass: "DISABLED",
    officialSupport: QUOTE_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "The Agent must not impersonate customer acceptance or trigger cross-document finalisation.",
  },
  {
    actionId: "credit_note.read_prepare",
    object: "CREDIT_NOTE",
    label: "Read credit notes and prepare a proposed adjustment",
    riskClass: "READ_PREPARE",
    officialSupport: CREDIT_NOTE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing credit-note reads support history and adjustment analysis without mutation.",
  },
  {
    actionId: "credit_note.create_draft",
    object: "CREDIT_NOTE",
    label: "Create a credit note in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: CREDIT_NOTE_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled DRAFT creation enforces reason, source linkage, confirmation, duplicate controls, and exact read-back.",
  },
  {
    actionId: "credit_note.update_draft",
    object: "CREDIT_NOTE",
    label: "Update an existing DRAFT credit note",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: CREDIT_NOTE_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Require immutable intent and stale-version checks before changing a financial adjustment draft.",
  },
  {
    actionId: "credit_note.authorise_or_allocate",
    object: "CREDIT_NOTE",
    label: "Authorise or allocate a credit note",
    riskClass: "DUAL_APPROVAL",
    officialSupport: CREDIT_NOTE_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Authorisation or allocation changes reported balances and requires independent review.",
  },
  {
    actionId: "credit_note.refund_pay_void_or_delete",
    object: "CREDIT_NOTE",
    label: "Refund, pay, void, or delete a credit note",
    riskClass: "DISABLED",
    officialSupport: CREDIT_NOTE_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Cash movement and destructive/final changes remain outside the Agent boundary.",
  },
  {
    actionId: "manual_journal.read_prepare",
    object: "MANUAL_JOURNAL",
    label: "Read manual journals and prepare a balanced journal proposal",
    riskClass: "READ_PREPARE",
    officialSupport: MANUAL_JOURNAL_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Bounded journal history reads are available for analysis; protected-account and period checks remain mandatory before any future write.",
  },
  {
    actionId: "manual_journal.create_draft",
    object: "MANUAL_JOURNAL",
    label: "Create a balanced manual journal in DRAFT",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: MANUAL_JOURNAL_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled creation allows only balanced DRAFT entries with source evidence, explicit no-tax treatment, protected-account checks, and exact read-back.",
  },
  {
    actionId: "manual_journal.update_draft",
    object: "MANUAL_JOURNAL",
    label: "Update an existing DRAFT manual journal",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: MANUAL_JOURNAL_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Require full replacement confirmation, balance validation, and stale-version protection.",
  },
  {
    actionId: "manual_journal.post",
    object: "MANUAL_JOURNAL",
    label: "Post a manual journal",
    riskClass: "DUAL_APPROVAL",
    officialSupport: MANUAL_JOURNAL_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Posting changes the ledger and must remain segregated from Agent preparation.",
  },
  {
    actionId: "manual_journal.locked_period_void_or_delete",
    object: "MANUAL_JOURNAL",
    label: "Backdate into a locked period, void, or delete a manual journal",
    riskClass: "DISABLED",
    officialSupport: MANUAL_JOURNAL_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Period override and destructive actions are prohibited for the Agent.",
  },
  {
    actionId: "contact.read_prepare",
    object: "CONTACT",
    label: "Read, search, de-duplicate, and prepare contact changes",
    riskClass: "READ_PREPARE",
    officialSupport: CONTACT_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing contact reads and search can prepare a change without mutation.",
  },
  {
    actionId: "contact.create_basic",
    object: "CONTACT",
    label: "Create a contact with constrained basic identity fields",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: CONTACT_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled creation is limited to basic identity fields with duplicate detection, explicit confirmation, and exact read-back.",
  },
  {
    actionId: "contact.update_basic",
    object: "CONTACT",
    label: "Update constrained basic contact fields",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: CONTACT_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled updates require an exact field diff, immutable contact ID, stale-object comparison, confirmation, and exact read-back.",
  },
  {
    actionId: "contact.update_sensitive_or_archive",
    object: "CONTACT",
    label: "Change tax identity, payment terms, or archive a contact",
    riskClass: "DUAL_APPROVAL",
    officialSupport: CONTACT_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "These changes can affect tax, cash operations, or historical workflow and need independent approval.",
  },
  {
    actionId: "contact.bank_data_merge_delete_or_privacy_action",
    object: "CONTACT",
    label: "Change bank data, merge/delete contacts, or execute privacy operations",
    riskClass: "DISABLED",
    officialSupport: CONTACT_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Bank redirection, destructive merges, and legal privacy actions require specialised workflows outside this MCP.",
  },
  {
    actionId: "account.read_prepare",
    object: "ACCOUNT",
    label: "Read the chart of accounts and prepare mapping recommendations",
    riskClass: "READ_PREPARE",
    officialSupport: ACCOUNT_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing account reads can support coding recommendations without changing reporting structure.",
  },
  {
    actionId: "account.create_or_update_structure",
    object: "ACCOUNT",
    label: "Create an account or change code, type, or reporting structure",
    riskClass: "DUAL_APPROVAL",
    officialSupport: ACCOUNT_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Chart-of-accounts structure affects reporting across many transactions and needs independent approval.",
  },
  {
    actionId: "account.update_tax_or_archive",
    object: "ACCOUNT",
    label: "Change an account tax default or archive it",
    riskClass: "DUAL_APPROVAL",
    officialSupport: ACCOUNT_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Tax defaults and archival can silently affect future coding and require independent approval.",
  },
  {
    actionId: "account.modify_bank_system_or_delete",
    object: "ACCOUNT",
    label: "Modify a bank/system account or delete an account",
    riskClass: "DISABLED",
    officialSupport: ACCOUNT_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Protected accounts and destructive account operations are outside the Agent boundary.",
  },
  {
    actionId: "item.read_prepare",
    object: "ITEM",
    label: "Read items and prepare matching or change recommendations",
    riskClass: "READ_PREPARE",
    officialSupport: ITEM_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Bounded item reads are available for matching and duplicate analysis; item mutation remains unreleased.",
  },
  {
    actionId: "item.create_basic_untracked",
    object: "ITEM",
    label: "Create a basic untracked item",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: ITEM_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled creation allows only constrained untracked items after exact code duplicate checks, confirmation, and exact read-back.",
  },
  {
    actionId: "item.update_basic_untracked",
    object: "ITEM",
    label: "Update basic descriptive fields on an untracked item",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: ITEM_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Controlled updates require an exact field diff and exclude accounting defaults, prices, tax, and tracking fields.",
  },
  {
    actionId: "item.update_account_tax_price_or_tracking",
    object: "ITEM",
    label: "Change item accounts, tax, price, or inventory tracking",
    riskClass: "DUAL_APPROVAL",
    officialSupport: ITEM_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "These defaults can affect many future transactions and require independent approval.",
  },
  {
    actionId: "item.adjust_stock_value_or_delete",
    object: "ITEM",
    label: "Adjust stock quantity/value or delete a used item",
    riskClass: "DISABLED",
    officialSupport: ITEM_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Inventory valuation and destructive operations are outside the Agent boundary.",
  },
  {
    actionId: "attachment.read_prepare",
    object: "ATTACHMENT",
    label: "List, download, OCR, scan, and classify attachments",
    riskClass: "READ_PREPARE",
    officialSupport: ATTACHMENT_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Requires bounded binary handling, malware scanning, and source-authorisation controls before exposure.",
  },
  {
    actionId: "attachment.upload_to_confirmed_draft",
    object: "ATTACHMENT",
    label: "Upload an approved file to one confirmed DRAFT parent",
    riskClass: "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE",
    officialSupport: ATTACHMENT_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "Require fixed parent ID, source receipt, SHA-256, MIME/size allowlist, no overwrite, and includeOnline=false.",
  },
  {
    actionId: "attachment.upload_to_final_or_publish_online",
    object: "ATTACHMENT",
    label: "Upload to a final record or publish an attachment online",
    riskClass: "DUAL_APPROVAL",
    officialSupport: ATTACHMENT_SUPPORT,
    releaseDecision: "PREPARE_ONLY",
    releaseRationale: "Final-record evidence and customer-visible publication require independent approval.",
  },
  {
    actionId: "attachment.arbitrary_fetch_overwrite_or_guess_parent",
    object: "ATTACHMENT",
    label: "Fetch an arbitrary URL, overwrite a file, or guess its parent record",
    riskClass: "DISABLED",
    officialSupport: ATTACHMENT_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Untrusted fetches, silent replacement, and ambiguous attachment routing are prohibited.",
  },
  {
    actionId: "payment.read_prepare",
    object: "PAYMENT",
    label: "Read payments and prepare cash-application analysis",
    riskClass: "READ_PREPARE",
    officialSupport: PAYMENT_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Existing payment reads can support history and alignment analysis without cash mutation.",
  },
  {
    actionId: "payment.create",
    object: "PAYMENT",
    label: "Create or allocate a payment",
    riskClass: "DISABLED",
    officialSupport: PAYMENT_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Payments have no safe DRAFT and immediately change economic state.",
  },
  {
    actionId: "payment.delete_or_reverse",
    object: "PAYMENT",
    label: "Delete or reverse a payment",
    riskClass: "DISABLED",
    officialSupport: PAYMENT_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Reversal and destructive payment actions remain outside the Agent boundary.",
  },
  {
    actionId: "bank_transaction.read_prepare",
    object: "BANK_TRANSACTION",
    label: "Read bank transactions and prepare coding or matching suggestions",
    riskClass: "READ_PREPARE",
    officialSupport: BANK_TRANSACTION_SUPPORT,
    releaseDecision: "AVAILABLE_NOW",
    releaseRationale: "Bounded bank-transaction reads are available and explicitly distinguished from bank feeds and final reconciliation.",
  },
  {
    actionId: "bank_transaction.create",
    object: "BANK_TRANSACTION",
    label: "Create a spend-money or receive-money bank transaction",
    riskClass: "DISABLED",
    officialSupport: BANK_TRANSACTION_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Bank-account transactions have no safe DRAFT and affect cash records.",
  },
  {
    actionId: "bank_transaction.update_or_delete",
    object: "BANK_TRANSACTION",
    label: "Update or delete a bank transaction",
    riskClass: "DISABLED",
    officialSupport: BANK_TRANSACTION_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Cash-record mutation and destructive actions remain outside the Agent boundary.",
  },
  {
    actionId: "reconciliation.analyse_and_match_candidates",
    object: "RECONCILIATION",
    label: "Compare available records and propose reconciliation candidates",
    riskClass: "READ_PREPARE",
    officialSupport: RECONCILIATION_ANALYSIS_SUPPORT,
    releaseDecision: "PLANNED_CONTROLLED",
    releaseRationale: "The Agent may analyse available records, explain differences, and propose matches without claiming final reconciliation.",
  },
  {
    actionId: "reconciliation.finalise",
    object: "RECONCILIATION",
    label: "Finalise or mark bank reconciliation complete",
    riskClass: "DISABLED",
    officialSupport: RECONCILIATION_FINALISE_SUPPORT,
    releaseDecision: "NOT_EXPOSED",
    releaseRationale: "Final reconciliation is not a generic public API/MCP action and must remain in Xero UI.",
  },
] as const satisfies readonly XeroCapabilityPolicy[];

export type XeroCapabilityActionId = (typeof XERO_CAPABILITY_POLICIES)[number]["actionId"];

export interface AgentFacingXeroCapabilityDecision {
  readonly actionId: string;
  readonly object: XeroBusinessObject | "UNKNOWN";
  readonly label: string;
  readonly knownAction: boolean;
  readonly riskClass: XeroRiskClass;
  readonly releaseDecision: XeroReleaseDecision;
  readonly controlRequirement: XeroControlRequirement;
  /** Static catalog decision only; runtime connection and grants are evaluated separately. */
  readonly policyAllowsExecution: boolean;
  /** Static catalog decision only; this is never sufficient authority to mutate Xero. */
  readonly policyAllowsMutation: boolean;
  readonly requiredScopes: readonly ("xero.read" | "xero.draft.write")[];
  readonly requiredPermissions: readonly XeroCapabilityPermission[];
  readonly instruction: string;
}

function executionRequirementsFor(policy: XeroCapabilityPolicy): {
  requiredScopes: readonly ("xero.read" | "xero.draft.write")[];
  requiredPermissions: readonly XeroCapabilityPermission[];
} {
  switch (policy.riskClass) {
    case "READ_PREPARE":
      return {
        requiredScopes: Object.freeze(["xero.read"]),
        requiredPermissions: Object.freeze(["XERO_ACCOUNTING_READ"]),
      };
    case "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE":
      return {
        requiredScopes: Object.freeze(["xero.draft.write"]),
        requiredPermissions: Object.freeze(["XERO_DRAFT_WRITE"]),
      };
    case "DUAL_APPROVAL":
      return {
        requiredScopes: Object.freeze([]),
        requiredPermissions: Object.freeze(["XERO_DUAL_APPROVAL"]),
      };
    case "DISABLED":
      return {
        requiredScopes: Object.freeze([]),
        requiredPermissions: Object.freeze([]),
      };
  }
}

function controlRequirementFor(riskClass: XeroRiskClass): XeroControlRequirement {
  switch (riskClass) {
    case "READ_PREPARE":
      return "NONE";
    case "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE":
      return "EXPLICIT_CONFIRMATION";
    case "DUAL_APPROVAL":
      return "DUAL_APPROVAL";
    case "DISABLED":
      return "NOT_PERMITTED";
  }
}

function instructionFor(policy: XeroCapabilityPolicy): string {
  if (policy.releaseDecision === "PLANNED_CONTROLLED") {
    return "Not currently exposed: prepare a proposal only and do not mutate Xero.";
  }
  if (policy.releaseDecision === "PREPARE_ONLY") {
    return "Prepare a proposal only; do not execute until an independent dual-approval control is available.";
  }
  if (policy.releaseDecision === "NOT_EXPOSED") {
    return "Do not execute or mutate Xero; offer a safe read or preparation alternative.";
  }
  if (policy.riskClass === "READ_PREPARE") {
    return "Read, analyse, or prepare only; do not mutate Xero.";
  }
  if (policy.riskClass === "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE") {
    return "Execute only after exact user confirmation and all tenant, idempotency, audit, and read-back controls pass.";
  }

  // Catalog validation rejects AVAILABLE_NOW for these classes. Keeping this
  // fallback makes the projection fail closed if a future policy bypasses it.
  return "Do not execute or mutate Xero.";
}

function toAgentFacingDecision(
  policy: XeroCapabilityPolicy,
): AgentFacingXeroCapabilityDecision {
  const executableRisk =
    policy.riskClass === "READ_PREPARE" ||
    policy.riskClass === "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE";
  const policyAllowsExecution =
    policy.releaseDecision === "AVAILABLE_NOW" && executableRisk;
  const policyAllowsMutation =
    policy.releaseDecision === "AVAILABLE_NOW" &&
    policy.riskClass === "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE";
  const requirements = executionRequirementsFor(policy);

  return Object.freeze({
    actionId: policy.actionId,
    object: policy.object,
    label: policy.label,
    knownAction: true,
    riskClass: policy.riskClass,
    releaseDecision: policy.releaseDecision,
    controlRequirement: controlRequirementFor(policy.riskClass),
    policyAllowsExecution,
    policyAllowsMutation,
    requiredScopes: requirements.requiredScopes,
    requiredPermissions: requirements.requiredPermissions,
    instruction: instructionFor(policy),
  });
}

function validateCatalog(): void {
  const actionIds = new Set<string>();
  for (const catalogEntry of XERO_CAPABILITY_POLICIES) {
    // Widen the literal catalog entry so these guards continue to protect
    // future edits instead of being compiled away from today's exact values.
    const policy: XeroCapabilityPolicy = catalogEntry;
    if (actionIds.has(policy.actionId)) {
      throw new Error(`Duplicate Xero capability action ID: ${policy.actionId}`);
    }
    actionIds.add(policy.actionId);

    if (
      policy.releaseDecision === "AVAILABLE_NOW" &&
      (policy.riskClass === "DUAL_APPROVAL" || policy.riskClass === "DISABLED")
    ) {
      throw new Error(`Unsafe Xero capability marked AVAILABLE_NOW: ${policy.actionId}`);
    }
    if (
      policy.releaseDecision === "PREPARE_ONLY" &&
      policy.riskClass !== "DUAL_APPROVAL"
    ) {
      throw new Error(`PREPARE_ONLY capability must require dual approval: ${policy.actionId}`);
    }
    if (
      policy.releaseDecision === "NOT_EXPOSED" &&
      policy.riskClass !== "DISABLED"
    ) {
      throw new Error(`NOT_EXPOSED capability must be disabled: ${policy.actionId}`);
    }
  }

  const coveredObjects = new Set(XERO_CAPABILITY_POLICIES.map((policy) => policy.object));
  for (const object of XERO_BUSINESS_OBJECTS) {
    if (!coveredObjects.has(object)) {
      throw new Error(`Missing Xero capability policy for business object: ${object}`);
    }
  }
}

validateCatalog();

const POLICY_BY_ACTION_ID: ReadonlyMap<string, XeroCapabilityPolicy> = new Map(
  XERO_CAPABILITY_POLICIES.map((policy) => [policy.actionId, policy]),
);

const AGENT_FACING_POLICIES = Object.freeze(
  XERO_CAPABILITY_POLICIES.map((policy) => toAgentFacingDecision(policy)),
);

/**
 * Returns the policy projection safe to include in Agent instructions or a
 * capability-discovery response. Official transport support and internal
 * rationale are intentionally omitted so they cannot be mistaken for consent.
 */
export function listAgentFacingXeroCapabilityPolicies(): readonly AgentFacingXeroCapabilityDecision[] {
  return AGENT_FACING_POLICIES;
}

/**
 * Looks up one Agent-facing decision. Unknown identifiers always resolve to a
 * disabled, non-executable result instead of being ignored or default-allowed.
 */
export function lookupAgentFacingXeroCapabilityDecision(
  actionId: string,
): AgentFacingXeroCapabilityDecision {
  const policy = POLICY_BY_ACTION_ID.get(actionId);
  if (policy) return toAgentFacingDecision(policy);

  return Object.freeze({
    actionId,
    object: "UNKNOWN",
    label: "Unknown Xero action",
    knownAction: false,
    riskClass: "DISABLED",
    releaseDecision: "NOT_EXPOSED",
    controlRequirement: "NOT_PERMITTED",
    policyAllowsExecution: false,
    policyAllowsMutation: false,
    requiredScopes: Object.freeze([]),
    requiredPermissions: Object.freeze([]),
    instruction: "Unknown Xero action: do not execute or mutate Xero.",
  });
}
