import {
  lookupAgentFacingXeroCapabilityDecision,
  type AgentFacingXeroCapabilityDecision,
  type XeroBusinessObject,
  type XeroCapabilityPermission,
} from "./xeroCapabilityPolicy.js";

export const XERO_EFFECTIVE_DENY_REASONS = [
  "UNKNOWN_ACTION",
  "POLICY_NOT_AVAILABLE",
  "CONNECTION_NOT_READY",
  "TENANT_BINDING_MISMATCH",
  "MISSING_MCP_SCOPE",
  "MISSING_PERMISSION",
  "MISSING_XERO_OAUTH_SCOPE",
  "WRITE_GATE_CLOSED",
  "WRITE_TENANT_NOT_ALLOWED",
  "CONFIRMATION_NOT_VERIFIED",
] as const;

export type XeroEffectiveDenyReason = (typeof XERO_EFFECTIVE_DENY_REASONS)[number];

export interface XeroEffectiveCapabilityContext {
  readonly connectionConnected: boolean;
  readonly connectionId?: string;
  /** Tenant resolved from the live Xero connection, never from tool input. */
  readonly connectionTenantId?: string;
  /** Tenant recorded in the server-side installation/binding. */
  readonly boundTenantId?: string;
  readonly grantedMcpScopes: readonly string[];
  readonly grantedPermissions: readonly XeroCapabilityPermission[];
  readonly grantedXeroOAuthScopes: readonly string[];
  readonly writeGateEnabled: boolean;
  readonly allowedWriteTenantId?: string;
  readonly explicitConfirmationVerified: boolean;
}

export interface XeroEffectiveCapabilityDecision {
  readonly actionId: string;
  readonly policy: AgentFacingXeroCapabilityDecision;
  readonly allowed: boolean;
  readonly mutation: boolean;
  readonly denyReasons: readonly XeroEffectiveDenyReason[];
  /** Every inner array is an any-of Xero OAuth scope requirement. */
  readonly requiredXeroOAuthScopeAnyOf: readonly (readonly string[])[];
}

const INVOICE_READ = [
  "accounting.invoices.read",
  "accounting.invoices",
  "accounting.transactions.read",
  "accounting.transactions",
] as const;
const INVOICE_WRITE = ["accounting.invoices", "accounting.transactions"] as const;
const CONTACT_READ = ["accounting.contacts.read", "accounting.contacts"] as const;
const CONTACT_WRITE = ["accounting.contacts"] as const;
const SETTINGS_READ = ["accounting.settings.read", "accounting.settings"] as const;
const SETTINGS_WRITE = ["accounting.settings"] as const;
const ATTACHMENT_READ = ["accounting.attachments.read", "accounting.attachments"] as const;
const ATTACHMENT_WRITE = ["accounting.attachments"] as const;
const TRIAL_BALANCE_READ = [
  "accounting.reports.trialbalance.read",
  "accounting.reports.read",
] as const;
const MANUAL_JOURNAL_READ = [
  "accounting.manualjournals.read",
  "accounting.manualjournals",
] as const;
const MANUAL_JOURNAL_WRITE = ["accounting.manualjournals"] as const;
const PAYMENT_READ = [
  "accounting.payments.read",
  "accounting.transactions.read",
  "accounting.transactions",
] as const;
const BANK_TRANSACTION_READ = [
  "accounting.banktransactions.read",
  "accounting.banktransactions",
  "accounting.transactions.read",
  "accounting.transactions",
] as const;
const BANK_TRANSACTION_WRITE = [
  "accounting.banktransactions",
  "accounting.transactions",
] as const;

function oauthRequirements(
  object: XeroBusinessObject,
  mutation: boolean,
): readonly (readonly string[])[] {
  switch (object) {
    case "SYSTEM":
      return [];
    case "ORGANISATION":
    case "TAX_RATE":
      return [SETTINGS_READ];
    case "REPORT":
      return mutation ? [] : [TRIAL_BALANCE_READ];
    case "CUSTOMER_INVOICE":
    case "SUPPLIER_BILL":
      return [mutation ? INVOICE_WRITE : INVOICE_READ];
    case "PURCHASE_ORDER":
    case "QUOTE":
    case "CREDIT_NOTE":
      // Xero's granular invoice scopes cover invoices, credit notes, quotes,
      // and purchase orders. The broad transaction scopes remain accepted
      // only as migration compatibility for older applications.
      return [mutation ? INVOICE_WRITE : INVOICE_READ];
    case "ITEM":
      return [mutation ? SETTINGS_WRITE : SETTINGS_READ];
    case "ATTACHMENT":
      return [mutation ? ATTACHMENT_WRITE : ATTACHMENT_READ];
    case "MANUAL_JOURNAL":
      return [mutation ? MANUAL_JOURNAL_WRITE : MANUAL_JOURNAL_READ];
    case "CONTACT":
      return [mutation ? CONTACT_WRITE : CONTACT_READ];
    case "ACCOUNT":
      return [mutation ? SETTINGS_WRITE : SETTINGS_READ];
    case "PAYMENT":
      return mutation ? [] : [PAYMENT_READ];
    case "BANK_TRANSACTION":
      return [mutation ? BANK_TRANSACTION_WRITE : BANK_TRANSACTION_READ];
    case "RECONCILIATION":
      // Candidate matching needs both accounting-document and bank-transaction inputs.
      return mutation ? [] : [INVOICE_READ, BANK_TRANSACTION_READ];
  }
}

function exactNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/**
 * Computes effective authority without granting it. The static product policy
 * is necessary but never sufficient: any missing runtime prerequisite denies
 * execution. This evaluator is deliberately not wired to MCP registration yet.
 */
export function evaluateEffectiveXeroCapability(
  actionId: string,
  context: XeroEffectiveCapabilityContext,
): XeroEffectiveCapabilityDecision {
  const policy = lookupAgentFacingXeroCapabilityDecision(actionId);
  const denyReasons: XeroEffectiveDenyReason[] = [];
  const connectionStatusDiagnostic =
    policy.knownAction && policy.actionId === "system.connection_status";
  // Determine the requested action's nature independently of whether policy
  // currently releases it; an unreleased draft action must not be evaluated as
  // a read merely because policyAllowsMutation is false.
  const mutation = policy.riskClass === "CONFIRMED_DRAFT_OR_LOW_RISK_WRITE";

  if (!policy.knownAction) denyReasons.push("UNKNOWN_ACTION");
  if (!policy.policyAllowsExecution) denyReasons.push("POLICY_NOT_AVAILABLE");

  if (!connectionStatusDiagnostic) {
    if (!context.connectionConnected || !exactNonEmpty(context.connectionId)) {
      denyReasons.push("CONNECTION_NOT_READY");
    }
    if (
      !exactNonEmpty(context.connectionTenantId) ||
      !exactNonEmpty(context.boundTenantId) ||
      context.connectionTenantId !== context.boundTenantId
    ) {
      denyReasons.push("TENANT_BINDING_MISMATCH");
    }
  }

  const grantedMcpScopes = new Set(context.grantedMcpScopes);
  if (policy.requiredScopes.some((scope) => !grantedMcpScopes.has(scope))) {
    denyReasons.push("MISSING_MCP_SCOPE");
  }
  const grantedPermissions = new Set(context.grantedPermissions);
  if (policy.requiredPermissions.some((permission) => !grantedPermissions.has(permission))) {
    denyReasons.push("MISSING_PERMISSION");
  }

  const requiredXeroOAuthScopeAnyOf = policy.object === "UNKNOWN"
    ? []
    : oauthRequirements(policy.object, mutation);
  const grantedXeroOAuthScopes = new Set(context.grantedXeroOAuthScopes);
  if (
    requiredXeroOAuthScopeAnyOf.some((alternatives) =>
      !alternatives.some((scope) => grantedXeroOAuthScopes.has(scope)),
    )
  ) {
    denyReasons.push("MISSING_XERO_OAUTH_SCOPE");
  }

  if (mutation) {
    if (!context.writeGateEnabled) denyReasons.push("WRITE_GATE_CLOSED");
    if (
      !exactNonEmpty(context.allowedWriteTenantId) ||
      !exactNonEmpty(context.connectionTenantId) ||
      context.allowedWriteTenantId !== context.connectionTenantId
    ) {
      denyReasons.push("WRITE_TENANT_NOT_ALLOWED");
    }
    if (!context.explicitConfirmationVerified) {
      denyReasons.push("CONFIRMATION_NOT_VERIFIED");
    }
  }

  return Object.freeze({
    actionId,
    policy,
    allowed: denyReasons.length === 0,
    mutation,
    denyReasons: Object.freeze(denyReasons),
    requiredXeroOAuthScopeAnyOf: Object.freeze(requiredXeroOAuthScopeAnyOf),
  });
}
