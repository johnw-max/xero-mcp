import type { XeroMutationRequest } from "../domain/xeroMutation.js";
import type { XeroAutonomousWriteAction } from "../policy/xeroAutonomousActions.js";
import {
  consumeLedgerProviderWritePermit,
  issueLedgerProviderWritePermit,
  type LedgerProviderWritePermit,
  type LedgerProviderWritePermitClaims,
  type LedgerProviderPermitContract,
} from "../control-kernel/ledgerProviderWritePermit.js";

export const XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS = [
  "XeroAccountingProvider.createDraftSupplierBill",
  "XeroAccountingProvider.createDraftSalesInvoice",
  "XeroControlledMutationProvider.createQuoteDraft",
  "XeroControlledMutationProvider.createPurchaseOrderDraft",
  "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
  "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
  "XeroContactItemMutationProvider.createContact",
  "XeroContactItemMutationProvider.updateContact",
  "XeroContactItemMutationProvider.createItem",
  "XeroContactItemMutationProvider.updateItem",
] as const;

export type XeroProviderWriteAdapterOperation = typeof XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS[number];

const XERO_PROVIDER_PERMIT_CONTRACT = Object.freeze({
  providerId: "xero",
  actionByAdapterOperation: Object.freeze({
    "XeroAccountingProvider.createDraftSupplierBill": "supplier_bill.create_draft",
    "XeroAccountingProvider.createDraftSalesInvoice": "customer_invoice.create_draft",
    "XeroControlledMutationProvider.createQuoteDraft": "quote.create_draft",
    "XeroControlledMutationProvider.createPurchaseOrderDraft": "purchase_order.create_draft",
    "XeroCreditNoteManualJournalProvider.createCreditNoteDraft": "credit_note.create_draft",
    "XeroCreditNoteManualJournalProvider.createManualJournalDraft": "manual_journal.create_draft",
    "XeroContactItemMutationProvider.createContact": "contact.create_basic",
    "XeroContactItemMutationProvider.updateContact": "contact.update_basic",
    "XeroContactItemMutationProvider.createItem": "item.create_basic_untracked",
    "XeroContactItemMutationProvider.updateItem": "item.update_basic_untracked",
  } satisfies Readonly<Record<XeroProviderWriteAdapterOperation, XeroAutonomousWriteAction>>),
}) satisfies LedgerProviderPermitContract;

const nativeRecoveryPermits = new WeakSet<object>();
export type XeroProviderWritePermitMode = "INITIAL_WRITE" | "NATIVE_IDEMPOTENCY_RECOVERY";

export type XeroProviderWritePermitClaims = Readonly<LedgerProviderWritePermitClaims & {
  providerId: "xero";
  adapterOperation: XeroProviderWriteAdapterOperation;
  actionId: XeroAutonomousWriteAction;
}>;

export type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";

export function issueXeroProviderWritePermit(input: Readonly<{
  adapterOperation: XeroProviderWriteAdapterOperation;
  request: Readonly<Pick<XeroMutationRequest,
    "mutationRequestId" | "canonicalPayloadHash" | "authorizationReceipt">>;
}>): LedgerProviderWritePermit {
  return issueLedgerProviderWritePermit({
    contract: XERO_PROVIDER_PERMIT_CONTRACT,
    adapterOperation: input.adapterOperation,
    request: input.request,
  });
}

/** Issues a fresh, independently consumable permit for the one CAS-claimed replay. */
export function issueXeroProviderWriteRecoveryPermit(input: Readonly<{
  adapterOperation: XeroProviderWriteAdapterOperation;
  request: Readonly<Pick<XeroMutationRequest,
    "mutationRequestId" | "canonicalPayloadHash" | "authorizationReceipt">>;
}>): LedgerProviderWritePermit {
  const permit = issueXeroProviderWritePermit(input);
  nativeRecoveryPermits.add(permit);
  return permit;
}

export function xeroProviderWritePermitMode(
  permit: LedgerProviderWritePermit | undefined,
): XeroProviderWritePermitMode {
  return permit && nativeRecoveryPermits.has(permit)
    ? "NATIVE_IDEMPOTENCY_RECOVERY"
    : "INITIAL_WRITE";
}

export function consumeXeroProviderWritePermit(
  permit: LedgerProviderWritePermit | undefined,
  expected: XeroProviderWritePermitClaims,
): XeroProviderWritePermitClaims {
  return consumeLedgerProviderWritePermit(permit, expected) as XeroProviderWritePermitClaims;
}
