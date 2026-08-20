import type { XeroMutationObjectType, XeroMutationOperation } from "./xeroMutation.js";

/**
 * Which surface an action is written through.
 *
 * `LEDGER_EVENT` changes what the books say, so it goes through the Accounting
 * Case: whole-plan preflight, source evidence, coverage receipts. That is what
 * lets the compiler refuse a bill whose supplier does not exist yet, before
 * anything is written, instead of leaving an orphan contact behind a failed bill.
 *
 * `REFERENCE_DATA` maintains the vocabulary the ledger uses and moves no
 * balance. Correcting a supplier's address is not a ledger event, and requiring
 * a document, a source bridge and a coverage receipt for it models it as
 * something it is not. It keeps the controls that still mean something -
 * idempotency, one-shot permit, exact readback, duplicate reservation, audit
 * trail - and drops the ceremony that only means something when a document and
 * a balance exist.
 *
 * The dividing rule, and the only one: reference data created as a *dependency*
 * of a ledger event stays on the ledger surface. That is why
 * `contact.create_basic` is LEDGER_EVENT while `contact.update_basic` is not -
 * creating the supplier is part of booking the bill; correcting its address later
 * is not.
 */
export type XeroWriteSurface = "LEDGER_EVENT" | "REFERENCE_DATA";

export interface XeroWriteActionDefinition {
  readonly objectType: XeroMutationObjectType;
  readonly operation: XeroMutationOperation;
  readonly surface: XeroWriteSurface;
  readonly providerAdapterOperation: string;
}

/**
 * The one place a write action is defined.
 *
 * An action's identity used to be spelled out independently in roughly fourteen
 * files - the autonomous action list, the mutation-pair lookup, the permit
 * contract, the adapter registry, the persistence mapping, the capability
 * catalog, the executor dispatch, and more. Nothing checked that a new action
 * reached all of them, so omitting one produced an action that was registered,
 * policy-approved, provider-backed, fully tested, and silently unreachable.
 * Six actions are in exactly that state today, each wired through six or seven
 * of the sites and missing the rest.
 *
 * Everything downstream derives from this table. Adding an entry without wiring
 * it is a compile error, not a silent gap.
 */
export const XERO_WRITE_ACTIONS = Object.freeze({
  "supplier_bill.create_draft": {
    objectType: "SUPPLIER_BILL",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroAccountingProvider.createDraftSupplierBill",
  },
  "supplier_bill.update_draft": {
    objectType: "SUPPLIER_BILL",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroAccountingProvider.updateDraftSupplierBill",
  },
  "customer_invoice.create_draft": {
    objectType: "SALES_INVOICE",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
  },
  "customer_invoice.update_draft": {
    objectType: "SALES_INVOICE",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroAccountingProvider.updateDraftSalesInvoice",
  },
  "customer_invoice.authorise": {
    objectType: "SALES_INVOICE",
    operation: "AUTHORISE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledLedgerTransitionProvider.authoriseSalesInvoice",
  },
  "supplier_bill.authorise": {
    objectType: "SUPPLIER_BILL",
    operation: "AUTHORISE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledLedgerTransitionProvider.authoriseSupplierBill",
  },
  "quote.create_draft": {
    objectType: "QUOTE",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledMutationProvider.createQuoteDraft",
  },
  "quote.update_draft": {
    objectType: "QUOTE",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledMutationProvider.updateQuoteDraft",
  },
  "purchase_order.create_draft": {
    objectType: "PURCHASE_ORDER",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledMutationProvider.createPurchaseOrderDraft",
  },
  "purchase_order.update_draft": {
    objectType: "PURCHASE_ORDER",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledMutationProvider.updatePurchaseOrderDraft",
  },
  "credit_note.create_draft": {
    objectType: "CREDIT_NOTE",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
  },
  "credit_note.update_draft": {
    objectType: "CREDIT_NOTE",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
  },
  "manual_journal.create_draft": {
    objectType: "MANUAL_JOURNAL",
    operation: "CREATE_DRAFT",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
  },
  "manual_journal.update_draft": {
    objectType: "MANUAL_JOURNAL",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
  },
  "manual_journal.post": {
    objectType: "MANUAL_JOURNAL",
    operation: "POST",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroControlledLedgerTransitionProvider.postManualJournal",
  },
  "customer_invoice.void": {
    objectType: "SALES_INVOICE",
    operation: "VOID",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.voidSalesInvoice",
  },
  "supplier_bill.void": {
    objectType: "SUPPLIER_BILL",
    operation: "VOID",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.voidSupplierBill",
  },
  "credit_note.authorise": {
    objectType: "CREDIT_NOTE",
    operation: "AUTHORISE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.authoriseCreditNote",
  },
  "credit_note.allocate": {
    objectType: "CREDIT_NOTE",
    operation: "ALLOCATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.allocateCreditNote",
  },
  "credit_note.refund": {
    objectType: "CREDIT_NOTE",
    operation: "REFUND",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.refundCreditNote",
  },
  "credit_note.void": {
    objectType: "CREDIT_NOTE",
    operation: "VOID",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.voidCreditNote",
  },
  "credit_note.unallocate": {
    objectType: "CREDIT_NOTE",
    operation: "UNALLOCATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.unallocateCreditNote",
  },
  "manual_journal.void": {
    objectType: "MANUAL_JOURNAL",
    operation: "VOID",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroLedgerAdjustmentProvider.voidManualJournal",
  },
  "tracking_category.create": {
    objectType: "TRACKING_CATEGORY",
    operation: "CREATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroTrackingMutationProvider.createCategory",
  },
  "tracking_category.update": {
    objectType: "TRACKING_CATEGORY",
    operation: "UPDATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroTrackingMutationProvider.updateCategory",
  },
  "tracking_option.create": {
    objectType: "TRACKING_OPTION",
    operation: "CREATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroTrackingMutationProvider.createOption",
  },
  "tracking_option.update": {
    objectType: "TRACKING_OPTION",
    operation: "UPDATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroTrackingMutationProvider.updateOption",
  },
  "payment.create": {
    objectType: "PAYMENT",
    operation: "CREATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroPaymentBankTransactionProvider.createPayment",
  },
  "payment.reverse": {
    objectType: "PAYMENT",
    operation: "REVERSE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroPaymentBankTransactionProvider.reversePayment",
  },
  "bank_transaction.create": {
    objectType: "BANK_TRANSACTION",
    operation: "CREATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroPaymentBankTransactionProvider.createBankTransaction",
  },
  "bank_transaction.update": {
    objectType: "BANK_TRANSACTION",
    operation: "UPDATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroPaymentBankTransactionProvider.updateBankTransaction",
  },
  "bank_transaction.reverse": {
    objectType: "BANK_TRANSACTION",
    operation: "REVERSE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroPaymentBankTransactionProvider.reverseBankTransaction",
  },
  "contact.create_basic": {
    objectType: "CONTACT",
    operation: "CREATE",
    surface: "LEDGER_EVENT",
    providerAdapterOperation: "XeroContactItemMutationProvider.createContact",
  },
  "contact.update_basic": {
    objectType: "CONTACT",
    operation: "UPDATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroContactItemMutationProvider.updateContact",
  },
  "item.create_basic_untracked": {
    objectType: "ITEM",
    operation: "CREATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroContactItemMutationProvider.createItem",
  },
  "item.update_basic_untracked": {
    objectType: "ITEM",
    operation: "UPDATE",
    surface: "REFERENCE_DATA",
    providerAdapterOperation: "XeroContactItemMutationProvider.updateItem",
  },
} as const satisfies Readonly<Record<string, XeroWriteActionDefinition>>);

export type XeroWriteActionId = keyof typeof XERO_WRITE_ACTIONS;

export const XERO_WRITE_ACTION_IDS = Object.freeze(
  Object.keys(XERO_WRITE_ACTIONS).sort() as readonly XeroWriteActionId[],
);

export function xeroWriteActionsOnSurface(surface: XeroWriteSurface): readonly XeroWriteActionId[] {
  return XERO_WRITE_ACTION_IDS.filter((id) => XERO_WRITE_ACTIONS[id].surface === surface);
}

/**
 * The write actions an agent can actually invoke today.
 *
 * This is the fact every other layer keeps getting wrong. The capability catalog
 * once marked six actions AVAILABLE_NOW - with rationales describing a
 * complete, gated, validated path - that no tool could reach, because the only
 * exposed write tools bind to the Accounting Case and the case executor
 * dispatched four actions. quote.create_draft and purchase_order.create_draft
 * were wired first (their own CommercialDocumentRoute family), then
 * manual_journal.create_draft (its own BalancedJournalRoute family) closed the
 * remaining ledger-event gap. The same public Case union now carries the
 * three already-safe reference-data actions as well; those actions reuse the
 * existing contact/item primitive provider path rather than reopening legacy
 * object-mutation tools.
 *
 * Reachability is stated here, once, and validated against the catalog.
 */
export const AGENT_REACHABLE_WRITE_ACTIONS = Object.freeze([
  "contact.create_basic",
  "contact.update_basic",
  "credit_note.create_draft",
  "credit_note.update_draft",
  "credit_note.authorise",
  "credit_note.allocate",
  "credit_note.refund",
  "credit_note.void",
  "credit_note.unallocate",
  "bank_transaction.create",
  "bank_transaction.update",
  "bank_transaction.reverse",
  "item.create_basic_untracked",
  "item.update_basic_untracked",
  "customer_invoice.create_draft",
  "customer_invoice.update_draft",
  "customer_invoice.authorise",
  "customer_invoice.void",
  "manual_journal.create_draft",
  "manual_journal.update_draft",
  "manual_journal.post",
  "manual_journal.void",
  "purchase_order.create_draft",
  "purchase_order.update_draft",
  "payment.create",
  "payment.reverse",
  "quote.create_draft",
  "quote.update_draft",
  "supplier_bill.create_draft",
  "supplier_bill.update_draft",
  "supplier_bill.authorise",
  "supplier_bill.void",
  "tracking_category.create",
  "tracking_category.update",
  "tracking_option.create",
  "tracking_option.update",
] as const satisfies readonly XeroWriteActionId[]);

export type AgentReachableWriteAction = typeof AGENT_REACHABLE_WRITE_ACTIONS[number];

export function isAgentReachableWriteAction(id: XeroWriteActionId): boolean {
  return (AGENT_REACHABLE_WRITE_ACTIONS as readonly XeroWriteActionId[]).includes(id);
}

/**
 * Ledger-event actions the Accounting Case executor cannot dispatch yet.
 *
 * Keeping the gap in one named list is the point: it used to be implicit in
 * whichever of the fourteen sites happened to be missing an entry, so nothing
 * could tell "not built" from "built and forgotten". Wiring an action means
 * removing it here, and the executor's exhaustive dispatch then refuses to
 * compile until it is handled.
 *
 * The three normal ledger-state transitions below have provider primitives but
 * are deliberately pending until their typed Case execution routes exist.
 * Keeping that gap named makes a provider-only action impossible to mistake
 * for a public capability.
 */
export const CASE_EXECUTOR_PENDING_ACTIONS = Object.freeze(
  [
  ] as const satisfies readonly XeroWriteActionId[],
);

export type CaseExecutorPendingAction = typeof CASE_EXECUTOR_PENDING_ACTIONS[number];

/** Ledger-event actions the Accounting Case executor dispatches today. */
export type CaseExecutorDispatchedAction = Exclude<
  Extract<XeroWriteActionId, ReturnType<typeof ledgerEventActionIdBrand>>,
  CaseExecutorPendingAction
>;

// Type-level helper: narrows XeroWriteActionId to the LEDGER_EVENT members.
declare function ledgerEventActionIdBrand(): {
  [K in XeroWriteActionId]: typeof XERO_WRITE_ACTIONS[K]["surface"] extends "LEDGER_EVENT" ? K
    : never;
}[XeroWriteActionId];

export function xeroWriteActionDefinition(id: XeroWriteActionId): XeroWriteActionDefinition {
  return XERO_WRITE_ACTIONS[id];
}
