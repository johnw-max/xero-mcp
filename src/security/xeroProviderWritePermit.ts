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

import { XERO_WRITE_ACTIONS, type XeroWriteActionId } from "../domain/xeroWriteActions.js";

export type XeroProviderWriteAdapterOperation = typeof XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS[number];

const XERO_PROVIDER_PERMIT_CONTRACT = Object.freeze({
  providerId: "xero",
  // Derived from the write-action registry rather than restated. A permit that
  // named an adapter the registry does not know, or omitted one it does, used to
  // be a silent gap; now the record type below cannot be satisfied without both.
  actionByAdapterOperation: Object.freeze(
    Object.fromEntries(
      (Object.keys(XERO_WRITE_ACTIONS) as XeroWriteActionId[]).map((actionId) =>
        [XERO_WRITE_ACTIONS[actionId].providerAdapterOperation, actionId]
      ),
    ) as Readonly<Record<XeroProviderWriteAdapterOperation, XeroAutonomousWriteAction>>,
  ),
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
