import type { XeroMutationObjectType, XeroMutationOperation } from "../domain/xeroMutation.js";
import { XERO_WRITE_ACTIONS, type XeroWriteActionId } from "../domain/xeroWriteActions.js";

export const XERO_AUTONOMOUS_WRITE_ACTIONS = [
  "supplier_bill.create_draft",
  "supplier_bill.update_draft",
  "supplier_bill.authorise",
  "customer_invoice.create_draft",
  "customer_invoice.update_draft",
  "customer_invoice.authorise",
  "quote.create_draft",
  "quote.update_draft",
  "purchase_order.create_draft",
  "purchase_order.update_draft",
  "credit_note.create_draft",
  "credit_note.update_draft",
  "manual_journal.create_draft",
  "manual_journal.update_draft",
  "manual_journal.post",
  "contact.create_basic",
  "contact.update_basic",
  "item.create_basic_untracked",
  "item.update_basic_untracked",
  "tracking_category.create",
  "tracking_category.update",
  "tracking_option.create",
  "tracking_option.update",
  "customer_invoice.void",
  "supplier_bill.void",
  "credit_note.authorise",
  "credit_note.allocate",
  "credit_note.refund",
  "credit_note.void",
  "credit_note.unallocate",
  "manual_journal.void",
  "payment.create",
  "payment.reverse",
  "bank_transaction.create",
  "bank_transaction.update",
  "bank_transaction.reverse",
] as const;

export type XeroAutonomousWriteAction = typeof XERO_AUTONOMOUS_WRITE_ACTIONS[number];

// The list above stays an explicit tuple because z.enum needs one, but it may not
// drift from the registry. These two assignments fail to compile if either side
// gains a member the other lacks, which is the failure that produced six
// registered-but-unreachable actions.
const _everyRegistryActionIsListed: XeroAutonomousWriteAction = null as unknown as XeroWriteActionId;
const _everyListedActionIsInRegistry: XeroWriteActionId = null as unknown as XeroAutonomousWriteAction;
void _everyRegistryActionIsListed;
void _everyListedActionIsInRegistry;

// Derived, not restated: the mutation pair for each action lives in the registry.
const ACTION_BY_MUTATION: Readonly<Record<string, XeroAutonomousWriteAction>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(XERO_WRITE_ACTIONS) as XeroWriteActionId[]).map((actionId) => {
      const definition = XERO_WRITE_ACTIONS[actionId];
      return [`${definition.objectType}:${definition.operation}`, actionId];
    }),
  ) as Record<string, XeroAutonomousWriteAction>,
);

export function xeroAutonomousActionForMutation(
  objectType: XeroMutationObjectType,
  operation: XeroMutationOperation,
): XeroAutonomousWriteAction | undefined {
  return (ACTION_BY_MUTATION as Readonly<Record<string, XeroAutonomousWriteAction | undefined>>)[
    `${objectType}:${operation}`
  ];
}
