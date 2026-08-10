import {
  lookupAgentFacingXeroCapabilityDecision,
  type XeroCapabilityActionId,
  type XeroCapabilityPermission,
  type XeroRiskClass,
} from "../policy/xeroCapabilityPolicy.js";
import { TOOL_ALLOWLIST, type AccountingToolName } from "./toolNames.js";

export type XeroToolRequiredMcpScope = "xero.read" | "xero.draft.write";

export interface XeroToolAnnotationsContract {
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: false;
  readonly openWorldHint?: false;
}

const STATEFUL_PREPARATION_TOOL_NAMES: ReadonlySet<AccountingToolName> = new Set([
  "xero_prepare_quote_draft",
  "xero_prepare_purchase_order_draft",
  "xero_prepare_credit_note_draft",
  "xero_prepare_manual_journal_draft",
  "xero_prepare_contact_create",
  "xero_prepare_contact_update",
  "xero_prepare_item_create",
  "xero_prepare_item_update",
]);

export interface XeroToolCapabilityBinding {
  readonly toolName: AccountingToolName;
  /**
   * A tool may cover more than one policy action when one Xero endpoint reads
   * both ACCREC and ACCPAY records. Every mapped action must have the same risk
   * class and execution requirements.
   */
  readonly actionIds: readonly XeroCapabilityActionId[];
  readonly riskClass: Extract<
    XeroRiskClass,
    "READ_PREPARE" | "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE"
  >;
  readonly mutating: boolean;
  readonly requiredMcpScope: XeroToolRequiredMcpScope;
  readonly requiredPermission: Extract<
    XeroCapabilityPermission,
    "XERO_ACCOUNTING_READ" | "XERO_DRAFT_WRITE"
  >;
  readonly annotations: XeroToolAnnotationsContract;
}

/**
 * Reviewed public-tool to business-action mapping.
 *
 * This object is deliberately exhaustive over TOOL_ALLOWLIST. Adding a public
 * tool without first assigning an AVAILABLE_NOW policy action is therefore a
 * compile-time error and a release-test failure.
 */
export const XERO_TOOL_CAPABILITY_ACTION_IDS = {
  xero_connection_status: ["system.connection_status"],
  xero_get_organisation: ["organisation.read_prepare"],
  xero_list_accounts: ["account.read_prepare"],
  xero_list_tax_rates: ["tax_rate.read_prepare"],
  xero_list_contacts: ["contact.read_prepare"],
  xero_get_contact: ["contact.read_prepare"],
  xero_search_contacts: ["contact.read_prepare"],
  xero_prepare_contact_create: ["contact.read_prepare"],
  xero_create_contact: ["contact.create_basic"],
  xero_prepare_contact_update: ["contact.read_prepare"],
  xero_update_contact: ["contact.update_basic"],
  xero_list_invoices: ["customer_invoice.read_prepare", "supplier_bill.read_prepare"],
  xero_list_credit_notes: ["credit_note.read_prepare"],
  xero_prepare_credit_note_draft: ["credit_note.read_prepare"],
  xero_create_credit_note_draft: ["credit_note.create_draft"],
  xero_list_payments: ["payment.read_prepare"],
  xero_list_quotes: ["quote.read_prepare"],
  xero_get_quote: ["quote.read_prepare"],
  xero_list_purchase_orders: ["purchase_order.read_prepare"],
  xero_get_purchase_order: ["purchase_order.read_prepare"],
  xero_list_manual_journals: ["manual_journal.read_prepare"],
  xero_get_manual_journal: ["manual_journal.read_prepare"],
  xero_prepare_manual_journal_draft: ["manual_journal.read_prepare"],
  xero_create_manual_journal_draft: ["manual_journal.create_draft"],
  xero_list_items: ["item.read_prepare"],
  xero_get_item: ["item.read_prepare"],
  xero_prepare_item_create: ["item.read_prepare"],
  xero_create_item: ["item.create_basic_untracked"],
  xero_prepare_item_update: ["item.read_prepare"],
  xero_update_item: ["item.update_basic_untracked"],
  xero_list_bank_transactions: ["bank_transaction.read_prepare"],
  xero_get_bank_transaction: ["bank_transaction.read_prepare"],
  xero_get_invoice: ["customer_invoice.read_prepare", "supplier_bill.read_prepare"],
  xero_get_supplier_bill: ["supplier_bill.read_prepare"],
  xero_prepare_supplier_bill_draft: ["supplier_bill.read_prepare"],
  xero_create_draft_supplier_bill: ["supplier_bill.create_draft"],
  xero_prepare_sales_invoice_draft: ["customer_invoice.read_prepare"],
  xero_create_draft_sales_invoice: ["customer_invoice.create_draft"],
  xero_prepare_quote_draft: ["quote.read_prepare"],
  xero_create_quote_draft: ["quote.create_draft"],
  xero_prepare_purchase_order_draft: ["purchase_order.read_prepare"],
  xero_create_purchase_order_draft: ["purchase_order.create_draft"],
  xero_get_trial_balance: ["report.trial_balance_read"],
} as const satisfies {
  readonly [ToolName in AccountingToolName]: readonly XeroCapabilityActionId[];
};

function buildBinding(toolName: AccountingToolName): XeroToolCapabilityBinding {
  const actionIds: readonly XeroCapabilityActionId[] =
    XERO_TOOL_CAPABILITY_ACTION_IDS[toolName];
  if (actionIds.length === 0) {
    throw new Error(`Xero public tool has no capability action: ${toolName}`);
  }

  const decisions = actionIds.map((actionId) =>
    lookupAgentFacingXeroCapabilityDecision(actionId),
  );
  for (const decision of decisions) {
    if (!decision.knownAction || decision.releaseDecision !== "AVAILABLE_NOW") {
      throw new Error(
        `Xero public tool maps to an unavailable capability: ${toolName} -> ${decision.actionId}`,
      );
    }
  }

  const riskClasses = new Set(decisions.map((decision) => decision.riskClass));
  if (riskClasses.size !== 1) {
    throw new Error(`Xero public tool mixes risk classes: ${toolName}`);
  }
  const riskClass = decisions[0]?.riskClass;
  if (
    riskClass !== "READ_PREPARE" &&
    riskClass !== "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE"
  ) {
    throw new Error(`Xero public tool maps to a non-executable risk class: ${toolName}`);
  }

  const mutating = riskClass === "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE";
  const statefulPreparation = STATEFUL_PREPARATION_TOOL_NAMES.has(toolName);
  const requiredMcpScope: XeroToolRequiredMcpScope = mutating
    ? "xero.draft.write"
    : "xero.read";
  const requiredPermission = mutating ? "XERO_DRAFT_WRITE" : "XERO_ACCOUNTING_READ";

  for (const decision of decisions) {
    if (
      decision.requiredScopes.length !== 1 ||
      decision.requiredScopes[0] !== requiredMcpScope ||
      decision.requiredPermissions.length !== 1 ||
      decision.requiredPermissions[0] !== requiredPermission
    ) {
      throw new Error(
        `Xero public tool requirements disagree with capability policy: ${toolName} -> ${decision.actionId}`,
      );
    }
  }

  return Object.freeze({
    toolName,
    actionIds: Object.freeze([...actionIds]),
    riskClass,
    mutating,
    requiredMcpScope,
    requiredPermission,
    annotations: Object.freeze(statefulPreparation
      ? {
          readOnlyHint: false,
          idempotentHint: false,
          destructiveHint: false,
          openWorldHint: false,
        }
      : {
          readOnlyHint: !mutating,
          idempotentHint: true,
          destructiveHint: false,
        }),
  });
}

export const XERO_TOOL_POLICY_BINDINGS: Readonly<
  Record<AccountingToolName, XeroToolCapabilityBinding>
> = Object.freeze(
  Object.fromEntries(
    TOOL_ALLOWLIST.map((toolName) => [toolName, buildBinding(toolName)]),
  ) as Record<AccountingToolName, XeroToolCapabilityBinding>,
);

export function getXeroToolPolicyBinding(
  toolName: AccountingToolName,
): XeroToolCapabilityBinding {
  return XERO_TOOL_POLICY_BINDINGS[toolName];
}
