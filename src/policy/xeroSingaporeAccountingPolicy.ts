/**
 * RETIRED — Singapore accounting policy (ADR-002).
 *
 * The Xero MCP is a ledger gateway: it no longer decides which account or tax
 * treatment a transaction belongs to, and it holds no jurisdiction rule set,
 * category vocabulary, or tax-semantics mapping. The write path is served by
 * `src/policy/xeroDeclaredLedgerPolicy.ts`, which verifies caller-declared
 * Xero-native coordinates against the target tenant's live data.
 *
 * Nothing in `src/services/` or `src/mcp/` may reference this module. It
 * survives only as the durable *legacy* projection marker: Accounting Cases
 * compiled by an earlier release persisted this schema version, and both the
 * stored-projection compatibility gate and the Postgres recovery-readiness
 * query still need to recognise it to refuse a silent reinterpretation.
 */

/** Legacy public vocabulary. Retained for documentation of what was removed. */
export const XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS = [
  "CONSULTING_REVENUE",
  "OFFICE_SUPPLIES",
  "CLOUD_SUBSCRIPTIONS",
] as const;

/** Legacy public vocabulary. Retained for documentation of what was removed. */
export const XERO_SINGAPORE_TAX_CLASS_KEYS = [
  "SG_STANDARD_RATED",
  "NO_TAX",
  "ZERO_RATED",
  "OUT_OF_SCOPE",
  "EXEMPT",
] as const;

export const XERO_SINGAPORE_ACCOUNTING_POLICY_VERSION = "xero-sg-accounting-policy-v8-2026h2";

/**
 * Legacy sealed-projection schema version. Cases carrying this version were
 * compiled under the retired jurisdiction policy and must be prepared afresh;
 * they are never rehydrated by the current release.
 */
export const XERO_SINGAPORE_ACCOUNTING_POLICY_PROJECTION_VERSION =
  "xero-sg-accounting-policy-projection:v4";
