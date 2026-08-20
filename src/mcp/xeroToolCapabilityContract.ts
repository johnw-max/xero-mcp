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
  "xero_start_organisation_switch",
  "xero_pin_current_organisation",
  "xero_prepare_accounting_case",
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
    "READ_PREPARE" | "AUTONOMOUS_CONTROLLED_WRITE"
  >;
  readonly mutating: boolean;
  /**
   * Scopes accepted at the MCP routing boundary. Accounting Case execute is
   * state-dependent: read may enter for recovery/replay, while fresh writes
   * are still required to satisfy requiredMcpScope inside the Case service.
   */
  readonly entryMcpScopesAnyOf: readonly XeroToolRequiredMcpScope[];
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
  xero_start_organisation_switch: ["system.organisation_switch_prepare"],
  xero_pin_current_organisation: ["system.ledger_target_session_issue"],
  xero_get_organisation: ["organisation.read_prepare"],
  xero_list_accounts: ["account.read_prepare"],
  xero_list_tax_rates: ["tax_rate.read_prepare"],
  xero_list_contacts: ["contact.read_prepare"],
  xero_get_contact: ["contact.read_prepare"],
  xero_search_contacts: ["contact.read_prepare"],
  xero_prepare_accounting_case: ["organisation.read_prepare"],
  xero_execute_accounting_case: [
    "contact.create_basic",
    "customer_invoice.create_draft",
    "supplier_bill.create_draft",
    "credit_note.create_draft",
    "quote.create_draft",
    "purchase_order.create_draft",
  ],
  xero_get_accounting_case_status: ["organisation.read_prepare"],
  xero_list_accounting_cases: ["organisation.read_prepare"],
  xero_list_invoices: ["customer_invoice.read_prepare", "supplier_bill.read_prepare"],
  xero_list_credit_notes: ["credit_note.read_prepare"],
  xero_get_credit_note: ["credit_note.read_prepare"],
  xero_list_payments: ["payment.read_prepare"],
  xero_list_quotes: ["quote.read_prepare"],
  xero_get_quote: ["quote.read_prepare"],
  xero_list_purchase_orders: ["purchase_order.read_prepare"],
  xero_get_purchase_order: ["purchase_order.read_prepare"],
  xero_list_manual_journals: ["manual_journal.read_prepare"],
  xero_get_manual_journal: ["manual_journal.read_prepare"],
  xero_list_items: ["item.read_prepare"],
  xero_get_item: ["item.read_prepare"],
  xero_list_bank_transactions: ["bank_transaction.read_prepare"],
  xero_get_bank_transaction: ["bank_transaction.read_prepare"],
  xero_get_invoice: ["customer_invoice.read_prepare", "supplier_bill.read_prepare"],
  xero_get_supplier_bill: ["supplier_bill.read_prepare"],
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
    riskClass !== "AUTONOMOUS_CONTROLLED_WRITE"
  ) {
    throw new Error(`Xero public tool maps to a non-executable risk class: ${toolName}`);
  }

  const mutating = riskClass === "AUTONOMOUS_CONTROLLED_WRITE";
  const statefulPreparation = STATEFUL_PREPARATION_TOOL_NAMES.has(toolName);
  const requiredMcpScope: XeroToolRequiredMcpScope = mutating
    ? "xero.draft.write"
    : "xero.read";
  const requiredPermission = mutating ? "XERO_DRAFT_WRITE" : "XERO_ACCOUNTING_READ";
  const entryMcpScopesAnyOf: readonly XeroToolRequiredMcpScope[] =
    toolName === "xero_execute_accounting_case"
      ? ["xero.read", "xero.draft.write"]
      : [requiredMcpScope];

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
    entryMcpScopesAnyOf: Object.freeze([...entryMcpScopesAnyOf]),
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
