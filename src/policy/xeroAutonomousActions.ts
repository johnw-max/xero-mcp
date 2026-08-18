import type { XeroMutationObjectType, XeroMutationOperation } from "../domain/xeroMutation.js";

export const XERO_AUTONOMOUS_WRITE_ACTIONS = [
  "supplier_bill.create_draft",
  "customer_invoice.create_draft",
  "quote.create_draft",
  "purchase_order.create_draft",
  "credit_note.create_draft",
  "manual_journal.create_draft",
  "contact.create_basic",
  "contact.update_basic",
  "item.create_basic_untracked",
  "item.update_basic_untracked",
] as const;

export type XeroAutonomousWriteAction = typeof XERO_AUTONOMOUS_WRITE_ACTIONS[number];

const ACTION_BY_MUTATION = Object.freeze({
  "SUPPLIER_BILL:CREATE_DRAFT": "supplier_bill.create_draft",
  "SALES_INVOICE:CREATE_DRAFT": "customer_invoice.create_draft",
  "QUOTE:CREATE_DRAFT": "quote.create_draft",
  "PURCHASE_ORDER:CREATE_DRAFT": "purchase_order.create_draft",
  "CREDIT_NOTE:CREATE_DRAFT": "credit_note.create_draft",
  "MANUAL_JOURNAL:CREATE_DRAFT": "manual_journal.create_draft",
  "CONTACT:CREATE": "contact.create_basic",
  "CONTACT:UPDATE": "contact.update_basic",
  "ITEM:CREATE": "item.create_basic_untracked",
  "ITEM:UPDATE": "item.update_basic_untracked",
} as const satisfies Readonly<Record<string, XeroAutonomousWriteAction>>);

export function xeroAutonomousActionForMutation(
  objectType: XeroMutationObjectType,
  operation: XeroMutationOperation,
): XeroAutonomousWriteAction | undefined {
  return (ACTION_BY_MUTATION as Readonly<Record<string, XeroAutonomousWriteAction | undefined>>)[
    `${objectType}:${operation}`
  ];
}

