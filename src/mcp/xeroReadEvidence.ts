import type { ActorTenantContext } from "../providers/types.js";
import { hashObject } from "../security/hash.js";
import { safeLedgerTargetReference } from "../security/ledgerTargetReference.js";
import type { RequestContext } from "../security/requestContext.js";
import { XERO_RELEASE_VERSION } from "../xeroRelease.js";
import type { AccountingToolName } from "./toolNames.js";

export type XeroReadCapabilityId =
  | "connector.connection.status.read"
  | "ledger.target.resolve"
  | "ledger.reference.accounts.read"
  | "ledger.reference.tax.read"
  | "ledger.reference.counterparty.read"
  | "ledger.reference.item.read"
  | "ledger.transaction.search"
  | "ledger.object.read_exact"
  | "ledger.report.trial_balance.read";

type XeroReadKind = "connection" | "target" | "collection" | "exact" | "report";

interface XeroReadEvidenceProfile {
  readonly capabilityId: XeroReadCapabilityId;
  readonly kind: XeroReadKind;
}

/**
 * Ordinary external reads only. Stateful preparation and every write keep their
 * existing receipts and are intentionally excluded from this table.
 */
const XERO_READ_EVIDENCE_PROFILES: Partial<Record<AccountingToolName, XeroReadEvidenceProfile>> = {
  xero_connection_status: { capabilityId: "connector.connection.status.read", kind: "connection" },
  xero_get_organisation: { capabilityId: "ledger.target.resolve", kind: "target" },
  xero_list_accounts: { capabilityId: "ledger.reference.accounts.read", kind: "collection" },
  xero_list_tax_rates: { capabilityId: "ledger.reference.tax.read", kind: "collection" },
  xero_list_contacts: { capabilityId: "ledger.reference.counterparty.read", kind: "collection" },
  xero_get_contact: { capabilityId: "ledger.reference.counterparty.read", kind: "exact" },
  xero_search_contacts: { capabilityId: "ledger.reference.counterparty.read", kind: "collection" },
  xero_list_invoices: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_list_credit_notes: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_list_payments: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_list_quotes: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_get_quote: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_list_purchase_orders: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_get_purchase_order: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_list_manual_journals: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_get_manual_journal: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_list_items: { capabilityId: "ledger.reference.item.read", kind: "collection" },
  xero_get_item: { capabilityId: "ledger.reference.item.read", kind: "exact" },
  xero_list_bank_transactions: { capabilityId: "ledger.transaction.search", kind: "collection" },
  xero_get_bank_transaction: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_get_invoice: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_get_supplier_bill: { capabilityId: "ledger.object.read_exact", kind: "exact" },
  xero_get_trial_balance: { capabilityId: "ledger.report.trial_balance.read", kind: "report" },
};

interface NormalizedXeroReadEvidenceBase {
  readonly result_class: "succeeded";
  readonly fact_origin: "MCP_READ";
  readonly source_system: "xero";
  readonly capability_id: XeroReadCapabilityId;
  readonly tool_call_or_audit_ref: string;
  readonly capability_revision: string;
  readonly observed_at: string;
  readonly query_bounds: Record<string, unknown>;
  readonly completeness: Record<string, unknown>;
  readonly output_hash: string;
  readonly fact_paths: readonly string[];
  readonly base_currency?: string | null;
  /** Safe correlation only; the raw target_session_ref is never returned here. */
  readonly target_session_ref_safe?: string;
}

export type NormalizedXeroReadEvidence = NormalizedXeroReadEvidenceBase & (
  | {
      readonly destination_role: "connector_control_plane";
      /** Compatibility fields are explicitly null and never constitute target proof. */
      readonly bound_target_ref_safe: null;
      readonly organisation_display_name: null;
      readonly binding_revision: null;
      readonly connection_ref_safe: string | null;
      readonly connection_state: "connected" | "disconnected" | "unknown";
    }
  | {
      readonly destination_role: "ledger_sor";
      readonly bound_target_ref_safe: string | null;
      readonly organisation_display_name: string | null;
      readonly binding_revision: string | null;
      readonly connection_ref_safe?: never;
      readonly connection_state?: never;
    }
);

export const XERO_READ_FACT_PATH_MAX_COUNT = 32;
export const XERO_READ_FACT_PATH_MAX_UTF8_BYTES = 256;
export const XERO_READ_FACT_PATHS_MAX_JSON_UTF8_BYTES = 4 * 1_024;

export const XERO_READ_METADATA_MAX_COUNT = 32;
export const XERO_READ_METADATA_MAX_UTF8_BYTES = 256;
export const XERO_READ_METADATA_MAX_JSON_UTF8_BYTES = 4 * 1_024;
const XERO_READ_QUERY_MAX_KEY_UTF8_BYTES = 128;
const XERO_READ_QUERY_MAX_ARRAY_ITEMS = 64;
const XERO_READ_QUERY_MAX_VISITED_NODES = 256;
const XERO_READ_QUERY_MAX_NESTING_DEPTH = 8;

const SAFE_TRUNCATION_FIELD_NAMES = new Set([
  "associatedInvoiceIdsTruncated",
  "descriptionTruncated",
  "linesTruncated",
  "narrationTruncated",
  "projectionIncomplete",
  "purchaseDescriptionTruncated",
  "trackingTruncated",
]);

const SENSITIVE_READ_RESULT_KEYS = new Set([
  "accessToken",
  "access_token",
  "authorizationId",
  "bindingId",
  "clientSecret",
  "client_secret",
  "connectionId",
  "oauthInstallationId",
  "organisationId",
  "organisationID",
  "refreshToken",
  "refresh_token",
  "tenantId",
  "tenant_id",
  "tokenId",
]);

const XERO_SAFE_READ_MAX_VISITED_NODES = 20_000;
const XERO_SAFE_READ_MAX_NESTING_DEPTH = 64;
const XERO_SAFE_READ_MAX_UTF8_BYTES = 2 * 1_024 * 1_024;
const XERO_SAFE_READ_MAX_STRING_UTF8_BYTES = 256 * 1_024;
const SAFE_READ_TRUNCATION_MARKER = "[MCP read projection omitted by safety bound]";

interface SafeReadProjectionState {
  readonly active: WeakSet<object>;
  visitedNodes: number;
  utf8Bytes: number;
  truncated: boolean;
}

function defineSafe(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function boundedSafeReadString(value: string, state: SafeReadProjectionState): string {
  const remaining = Math.max(0, XERO_SAFE_READ_MAX_UTF8_BYTES - state.utf8Bytes);
  const budget = Math.min(XERO_SAFE_READ_MAX_STRING_UTF8_BYTES, remaining);
  if (Buffer.byteLength(value, "utf8") <= budget) {
    state.utf8Bytes += Buffer.byteLength(value, "utf8");
    return value;
  }
  state.truncated = true;
  const suffix = "...[MCP read string truncated]";
  const prefixBudget = Math.max(0, budget - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  let prefixBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + bytes > prefixBudget) break;
    prefix += character;
    prefixBytes += bytes;
  }
  const bounded = budget >= Buffer.byteLength(suffix, "utf8") ? `${prefix}${suffix}` : SAFE_READ_TRUNCATION_MARKER;
  state.utf8Bytes += Math.min(budget, Buffer.byteLength(bounded, "utf8"));
  return bounded;
}

function safeXeroReadValue(
  value: unknown,
  state: SafeReadProjectionState,
  parentKey: string | undefined,
  depth: number,
): unknown {
  if (
    state.visitedNodes >= XERO_SAFE_READ_MAX_VISITED_NODES ||
    state.utf8Bytes >= XERO_SAFE_READ_MAX_UTF8_BYTES ||
    depth > XERO_SAFE_READ_MAX_NESTING_DEPTH
  ) {
    state.truncated = true;
    return SAFE_READ_TRUNCATION_MARKER;
  }
  state.visitedNodes += 1;
  if (typeof value === "string") return boundedSafeReadString(value, state);
  if (!value || typeof value !== "object") {
    if (typeof value === "bigint") {
      state.truncated = true;
      return "[MCP converted non-JSON integer]";
    }
    if (["function", "symbol", "undefined"].includes(typeof value)) {
      state.truncated = true;
      return null;
    }
    return value;
  }
  if (state.active.has(value)) {
    state.truncated = true;
    return "[MCP omitted circular provider value]";
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const entry of value) {
        if (
          state.visitedNodes >= XERO_SAFE_READ_MAX_VISITED_NODES ||
          state.utf8Bytes >= XERO_SAFE_READ_MAX_UTF8_BYTES
        ) {
          state.truncated = true;
          result.push(SAFE_READ_TRUNCATION_MARKER);
          break;
        }
        result.push(safeXeroReadValue(entry, state, undefined, depth + 1));
      }
      return result;
    }

    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_READ_RESULT_KEYS.has(key)) continue;
      if (parentKey === "tenant" && key === "id") continue;
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (
        state.visitedNodes >= XERO_SAFE_READ_MAX_VISITED_NODES ||
        state.utf8Bytes + keyBytes > XERO_SAFE_READ_MAX_UTF8_BYTES
      ) {
        state.truncated = true;
        break;
      }
      state.utf8Bytes += keyBytes;
      defineSafe(result, key, safeXeroReadValue(child, state, key, depth + 1));
    }
    return result;
  } finally {
    state.active.delete(value);
  }
}

/**
 * Removes connection locators and credential material from Agent-facing read
 * payloads under hard node/depth/byte bounds. A top-level marker makes any
 * safety projection visible to downstream completeness logic.
 */
export function safeXeroReadResult(value: unknown): unknown {
  const state: SafeReadProjectionState = {
    active: new WeakSet<object>(),
    visitedNodes: 0,
    utf8Bytes: 0,
    truncated: false,
  };
  const result = safeXeroReadValue(value, state, undefined, 0);
  if (!state.truncated) return result;
  if (Array.isArray(result)) {
    if (result.at(-1) !== SAFE_READ_TRUNCATION_MARKER) result.push(SAFE_READ_TRUNCATION_MARKER);
    return result;
  }
  if (result && typeof result === "object") {
    defineSafe(result as Record<string, unknown>, "mcpProjectionTruncated", true);
  }
  return result;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedMetadataString(value: string, maxUtf8Bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxUtf8Bytes) return value;
  const suffix = `...[sha256:${hashObject(value).slice(0, 16)}]`;
  const prefixBudget = Math.max(0, maxUtf8Bytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  let prefixBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + bytes > prefixBudget) break;
    prefix += character;
    prefixBytes += bytes;
  }
  return `${prefix}${suffix}`;
}

function safeQueryKey(key: string): string {
  if (Buffer.byteLength(key, "utf8") <= XERO_READ_QUERY_MAX_KEY_UTF8_BYTES) return key;
  return `metadata_key_sha256_${hashObject(key).slice(0, 32)}`;
}

function safeQueryValue(value: unknown): unknown {
  const state = { visitedNodes: 0 };
  const visit = (candidate: unknown, depth: number): unknown => {
    state.visitedNodes += 1;
    if (state.visitedNodes > XERO_READ_QUERY_MAX_VISITED_NODES) {
      return "[query metadata omitted: node limit]";
    }
    if (depth > XERO_READ_QUERY_MAX_NESTING_DEPTH) {
      return "[query metadata omitted: nesting limit]";
    }
    if (Array.isArray(candidate)) {
      const bounded = candidate.slice(0, XERO_READ_QUERY_MAX_ARRAY_ITEMS)
        .map((entry) => visit(entry, depth + 1));
      if (candidate.length > XERO_READ_QUERY_MAX_ARRAY_ITEMS) {
        bounded.push(`[${candidate.length - XERO_READ_QUERY_MAX_ARRAY_ITEMS} additional items omitted]`);
      }
      return bounded;
    }
    if (!candidate || typeof candidate !== "object") {
      if (typeof candidate === "bigint") return "[query metadata omitted: non-JSON integer]";
      if (["function", "symbol", "undefined"].includes(typeof candidate)) return null;
      return typeof candidate === "string"
        ? boundedMetadataString(candidate, 512)
        : candidate;
    }
    const result = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(candidate as Record<string, unknown>);
    for (const [index, [key, child]] of entries.entries()) {
      if (index >= XERO_READ_METADATA_MAX_COUNT) {
        defineSafe(result, "additional_keys_omitted", entries.length - index);
        break;
      }
      const sensitiveKey = /(?:tenant|token|secret|password|credential|oauth|authorization|binding|connection)/iu
        .test(key);
      const safeKey = sensitiveKey
        ? `redacted_key_sha256_${hashObject(key).slice(0, 32)}`
        : safeQueryKey(key);
      if (sensitiveKey) {
        defineSafe(result, safeKey, "[REDACTED]");
        continue;
      }
      defineSafe(result, safeKey, visit(child, depth + 1));
    }
    return result;
  };

  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= XERO_READ_METADATA_MAX_JSON_UTF8_BYTES) {
    return result;
  }
  return {
    metadata_omitted_due_to_bound: true,
    metadata_hash: `sha256:${hashObject(result)}`,
  };
}

function factPaths(result: unknown, profile: XeroReadEvidenceProfile): string[] {
  if (profile.kind === "target") {
    const record = objectRecord(result);
    if (!record) return ["/result"];
    const targetPaths = ["name", "baseCurrency"]
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => `/result/${key}`);
    return targetPaths.length > 0 ? targetPaths : ["/result"];
  }
  if (Array.isArray(result) || !result || typeof result !== "object") return ["/result"];
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length > XERO_READ_FACT_PATH_MAX_COUNT) return ["/result"];
  const paths: string[] = [];
  for (const key of keys) {
    const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
    const candidate = `/result/${escaped}`;
    // A shortened JSON Pointer would no longer identify a real field. Fall
    // back to the valid parent pointer whenever exact paths cannot be bounded.
    if (Buffer.byteLength(candidate, "utf8") > XERO_READ_FACT_PATH_MAX_UTF8_BYTES) {
      return ["/result"];
    }
    const next = [...paths, candidate];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > XERO_READ_FACT_PATHS_MAX_JSON_UTF8_BYTES) {
      return ["/result"];
    }
    paths.push(candidate);
  }
  return paths.length > 0 ? paths : ["/result"];
}

function paginationEvidence(result: unknown): Record<string, unknown> | undefined {
  const pagination = objectRecord(objectRecord(result)?.pagination);
  if (!pagination) return undefined;
  return safeQueryValue(pagination) as Record<string, unknown>;
}

function truncatedFields(result: unknown): string[] {
  const record = objectRecord(result);
  if (!record) return [];
  const matches = Object.entries(record)
    .filter(([key, value]) => /(?:truncated|incomplete)$/iu.test(key) && value === true)
    .map(([key]) => key);
  const bounded: string[] = [];
  for (const [index, key] of matches.entries()) {
    if (index >= XERO_READ_METADATA_MAX_COUNT) break;
    const safeKey = SAFE_TRUNCATION_FIELD_NAMES.has(key)
      ? key
      : `field_name_omitted_sha256_${hashObject(key).slice(0, 32)}`;
    const next = [...bounded, safeKey];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > XERO_READ_METADATA_MAX_JSON_UTF8_BYTES) {
      const remainderHash = `additional_field_names_omitted_sha256_${hashObject(matches.slice(index)).slice(0, 32)}`;
      if (
        Buffer.byteLength(JSON.stringify([...bounded, remainderHash]), "utf8") <=
          XERO_READ_METADATA_MAX_JSON_UTF8_BYTES
      ) bounded.push(remainderHash);
      break;
    }
    bounded.push(safeKey);
  }
  if (matches.length > XERO_READ_METADATA_MAX_COUNT && bounded.length < XERO_READ_METADATA_MAX_COUNT) {
    bounded.push(
      `additional_field_names_omitted_sha256_${hashObject(matches.slice(XERO_READ_METADATA_MAX_COUNT)).slice(0, 32)}`,
    );
  }
  return bounded;
}

function readCompleteness(
  profile: XeroReadEvidenceProfile,
  result: unknown,
): Record<string, unknown> {
  const pagination = paginationEvidence(result);
  if (profile.kind === "connection") {
    return {
      status: "connection_status_observation",
      scope: "connection_binding_resolution",
      ledger_data_completeness: "not_applicable",
    };
  }
  if (profile.kind === "target") {
    const record = objectRecord(result);
    const requiredFieldsPresent = typeof record?.name === "string" && record.name.length > 0 &&
      typeof record.baseCurrency === "string" && record.baseCurrency.length > 0;
    return {
      status: requiredFieldsPresent ? "complete" : "required_target_fields_missing",
      scope: "active_server_bound_xero_organisation",
    };
  }
  if (profile.kind === "report") {
    const mcpTruncated = pagination?.mcpTruncated === true;
    return {
      status: mcpTruncated ? "bounded_report_truncated" : "bounded_provider_response",
      scope: "single_xero_provider_response",
      mcp_truncated: mcpTruncated,
      provider_completeness: pagination?.providerCompleteness ?? "not_verified",
    };
  }
  if (profile.kind === "collection") {
    const declaredPageComplete = pagination
      ? pagination.hasNextPage === false &&
        pagination.hasNextPageIsEstimated === false &&
        Number(pagination.omittedInvalid ?? 0) === 0 &&
        Number(pagination.omittedOverflow ?? 0) === 0
      : "not_independently_verified";
    return {
      status: "bounded_query_result",
      scope: pagination ? "declared_provider_page" : "single_provider_response",
      ...(pagination ? { pagination } : {}),
      within_declared_query_bounds: "not_independently_verified",
      declared_page_complete: declaredPageComplete,
      whole_ledger_complete: false,
    };
  }
  const omittedOrTruncated = truncatedFields(result);
  return {
    status: "exact_object_identity",
    scope: "exact_provider_object_id",
    provider_field_completeness: "not_independently_verified",
    omitted_or_truncated_fields: omittedOrTruncated,
  };
}

function targetRef(tenantId: string | undefined): string | null {
  return tenantId
    ? `xero-target:${hashObject({ provider: "xero", tenantId }).slice(0, 32)}`
    : null;
}

function connectionRef(context: RequestContext, tenantId: string | undefined): string | null {
  if (
    !context.legacyDemo &&
    context.bindingId &&
    context.connectionId &&
    Number.isSafeInteger(context.bindingRevision) &&
    (context.bindingRevision ?? 0) > 0
  ) {
    return `xero-connection:${hashObject({
      provider: "xero",
      bindingId: context.bindingId,
      connectionId: context.connectionId,
      bindingRevision: context.bindingRevision,
    }).slice(0, 32)}`;
  }
  if (!tenantId) return null;
  return `xero-connection:${hashObject({
    provider: "xero",
    tenantId,
    source: "legacy-server-connection",
  }).slice(0, 32)}`;
}

function connectionState(result: Record<string, unknown> | undefined): "connected" | "disconnected" | "unknown" {
  if (result?.connected === true) return "connected";
  if (result?.connected === false) return "disconnected";
  return "unknown";
}

function safeDisplayName(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 512 ? value : `${value.slice(0, 512)}...[display name truncated]`;
}

function bindingRevision(context: RequestContext, tenantId: string | undefined): string | null {
  if (!tenantId) return null;
  if (context.legacyDemo) {
    return `xero-legacy-binding:${hashObject({
      provider: "xero",
      tenantId,
      source: "legacy-configured-target",
    }).slice(0, 32)}`;
  }
  if (
    !context.bindingId ||
    !context.connectionId ||
    !Number.isSafeInteger(context.bindingRevision) ||
    (context.bindingRevision ?? 0) < 1
  ) return null;
  return `xero-binding-revision:${hashObject({
    bindingId: context.bindingId,
    connectionId: context.connectionId,
    tenantId,
    bindingRevision: context.bindingRevision,
  }).slice(0, 32)}`;
}

function readQueryBounds(
  profile: XeroReadEvidenceProfile,
  input: unknown,
): Record<string, unknown> {
  const requested = safeQueryValue(input) as Record<string, unknown>;
  if (profile.kind === "connection") {
    return {
      target_scope: "connection_binding_resolution",
      requested,
    };
  }
  if (profile.kind !== "report") {
    return {
      target_scope: "active_server_bound_xero_organisation",
      requested,
    };
  }
  const inputRecord = objectRecord(input);
  const date = typeof inputRecord?.date === "string" ? inputRecord.date : undefined;
  return {
    target_scope: "active_server_bound_xero_organisation",
    requested,
    effective_provider_query: {
      paymentsOnly: false,
      date: date ?? null,
      date_resolution: date ? "explicit_request_date" : "provider_default_unresolved",
      reproducible_as_of: date !== undefined,
    },
  };
}

export function getXeroReadEvidenceProfile(
  toolName: string,
): XeroReadEvidenceProfile | undefined {
  return XERO_READ_EVIDENCE_PROFILES[toolName as AccountingToolName];
}

export function buildNormalizedXeroReadEvidence(options: {
  readonly toolName: string;
  readonly auditCallId: string;
  readonly requestContext: RequestContext;
  readonly tenantContext?: ActorTenantContext;
  readonly input: unknown;
  readonly safeResult: unknown;
  readonly observedAt?: Date;
}): NormalizedXeroReadEvidence | undefined {
  const profile = getXeroReadEvidenceProfile(options.toolName);
  if (!profile) return undefined;
  const result = objectRecord(options.safeResult);
  const organisationDisplayName = profile.kind === "connection"
    ? null
    : profile.kind === "target" && typeof result?.name === "string"
      ? safeDisplayName(result.name)
      : safeDisplayName(options.tenantContext?.tenantName);
  const baseCurrency = profile.kind === "target"
    ? typeof result?.baseCurrency === "string" ? result.baseCurrency : null
    : undefined;
  const observedAt = options.observedAt ?? new Date();

  const common: NormalizedXeroReadEvidenceBase = {
    result_class: "succeeded",
    fact_origin: "MCP_READ",
    source_system: "xero",
    capability_id: profile.capabilityId,
    tool_call_or_audit_ref: options.auditCallId,
    capability_revision: `xero-mcp@${XERO_RELEASE_VERSION}`,
    observed_at: observedAt.toISOString(),
    query_bounds: readQueryBounds(profile, options.input),
    completeness: readCompleteness(profile, options.safeResult),
    output_hash: `sha256:${hashObject(options.safeResult)}`,
    fact_paths: factPaths(options.safeResult, profile),
    ...(baseCurrency !== undefined ? { base_currency: baseCurrency } : {}),
    ...(options.requestContext.targetSessionId
      ? { target_session_ref_safe: safeLedgerTargetReference(options.requestContext.targetSessionId) }
      : {}),
  };
  if (profile.kind === "connection") {
    return {
      ...common,
      destination_role: "connector_control_plane",
      bound_target_ref_safe: null,
      organisation_display_name: null,
      binding_revision: null,
      connection_ref_safe: connectionRef(options.requestContext, options.tenantContext?.tenantId),
      connection_state: connectionState(result),
    };
  }
  return {
    ...common,
    destination_role: "ledger_sor",
    bound_target_ref_safe: targetRef(options.tenantContext?.tenantId),
    organisation_display_name: organisationDisplayName,
    binding_revision: bindingRevision(options.requestContext, options.tenantContext?.tenantId),
  };
}

export function normalizedXeroReadPayload(
  result: unknown,
  evidence: NormalizedXeroReadEvidence,
): Record<string, unknown> {
  return { result, ...evidence };
}
