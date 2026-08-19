import { toSafeError, type AppError, type AppErrorCode } from "../errors.js";

export interface XeroMcpFailureEnvelope {
  [key: string]: unknown;
  error: {
    code: AppErrorCode;
    message: string;
    retryable: boolean;
    failure_layer: string;
    provider_mutation_possible: boolean;
    recovery_action: string;
    reason_codes?: string[];
    invalid_fields?: string[];
    /**
     * Which prepared fields disagreed with the Case operation. The server has
     * always computed these; not returning them left the caller with an opaque
     * persistence failure and nothing to correct, and the observed response was
     * to route around the control instead — offering to book under a different
     * supplier, or to invent a registration number. Field names describe the
     * caller's own proposal, so naming them discloses nothing.
     */
    mismatch_fields?: string[];
    holding_case_id?: string;
    holding_case_version?: number;
    hold_releases_at?: string;
    operation_id?: string;
    case_id?: string;
    case_version?: number;
    completed_operation_ids?: string[];
    failed_operation_id?: string;
    next_action?: string;
    auditCallId?: string;
    auditCompletionStatus?: "UNKNOWN";
  };
}

const DEFAULT_FAILURE_PROJECTION: Readonly<Record<AppErrorCode, {
  layer: string;
  recovery: string;
}>> = Object.freeze({
  AUTH_REQUIRED: { layer: "MCP_AUTHENTICATION", recovery: "REAUTHENTICATE_MCP" },
  OAUTH_TOKEN_EXPIRED: { layer: "PROVIDER_OAUTH_TOKEN", recovery: "RECONNECT_XERO" },
  OAUTH_REFRESH_FAILED: { layer: "PROVIDER_OAUTH_REFRESH", recovery: "RECONNECT_XERO" },
  SCOPE_MISSING: { layer: "MCP_SCOPE", recovery: "REAUTHORISE_MCP_SCOPE" },
  SUBJECT_FORBIDDEN: { layer: "PROVIDER_USER_ROLE", recovery: "VERIFY_XERO_USER_ROLE_AND_TENANT" },
  TARGET_SESSION_REQUIRED: { layer: "TARGET_BINDING", recovery: "PIN_LEDGER_TARGET" },
  TARGET_SESSION_INVALID: { layer: "TARGET_BINDING", recovery: "PIN_LEDGER_TARGET" },
  TARGET_SESSION_EXPIRED: { layer: "TARGET_BINDING", recovery: "PIN_LEDGER_TARGET" },
  WRITE_GATE_DISABLED: { layer: "WRITE_POLICY", recovery: "ENABLE_RELEASE_WRITE_GATE" },
  STANDING_DELEGATION_REQUIRED: { layer: "STANDING_DELEGATION", recovery: "REFRESH_STANDING_DELEGATION" },
  ACTION_UNSUPPORTED: { layer: "ACTION_POLICY", recovery: "USE_SUPPORTED_ACTION" },
  RATE_LIMITED: { layer: "PROVIDER_RATE_LIMIT", recovery: "RETRY_WITH_BACKOFF" },
  NETWORK_UNAVAILABLE: { layer: "NETWORK", recovery: "RETRY_AFTER_CONNECTIVITY_RECOVERS" },
  PROVIDER_UNAVAILABLE: { layer: "PROVIDER_SERVICE", recovery: "RETRY_AFTER_PROVIDER_RECOVERS" },
  PERSISTENCE_FAILURE: { layer: "MCP_PERSISTENCE", recovery: "CHECK_CASE_STATUS_BEFORE_RETRY" },
  FORBIDDEN: { layer: "AUTHORIZATION", recovery: "INSPECT_AUTHORIZATION_BINDING" },
  NOT_FOUND: { layer: "RESOURCE", recovery: "VERIFY_RESOURCE_REFERENCE" },
  NOT_CONNECTED: { layer: "CONNECTION", recovery: "RECONNECT_XERO" },
  AMBIGUOUS_CONNECTION: { layer: "CONNECTION", recovery: "PIN_EXACT_XERO_ORGANISATION" },
  VALIDATION_FAILED: { layer: "DETERMINISTIC_VALIDATION", recovery: "CORRECT_CASE_FACTS" },
  CONFLICT: { layer: "CONCURRENCY_OR_IDEMPOTENCY", recovery: "GET_CURRENT_CASE_STATUS" },
  APPROVAL_REQUIRED: { layer: "LEGACY_AUTHORITY", recovery: "USE_STANDING_DELEGATION_CASE_FLOW" },
  APPROVAL_INVALID: { layer: "STALE_AUTHORITY", recovery: "PREPARE_NEW_CASE_VERSION" },
  STALE_PREFLIGHT: { layer: "ACCOUNTING_CASE_PREFLIGHT", recovery: "RESEAL_REMAINING_PREPARED_OPERATIONS" },
  READBACK_MISMATCH: { layer: "PROVIDER_READBACK", recovery: "FREEZE_AND_RECONCILE_READBACK" },
  WRITE_RESULT_UNKNOWN: { layer: "PROVIDER_WRITE_OUTCOME", recovery: "READBACK_RECOVERY_ONLY" },
  PROVIDER_ERROR: { layer: "PROVIDER_RESPONSE", recovery: "INSPECT_PROVIDER_RESPONSE" },
  CONFIGURATION_ERROR: { layer: "MCP_CONFIGURATION", recovery: "FIX_MCP_CONFIGURATION" },
});

const SAFE_FAILURE_LAYERS = new Set([
  ...Object.values(DEFAULT_FAILURE_PROJECTION).map(({ layer }) => layer),
  "MCP_SCOPE",
  "PROVIDER_OAUTH_SCOPE",
  "PROVIDER_ACCESS",
]);

const SAFE_RECOVERY_ACTIONS = new Set([
  ...Object.values(DEFAULT_FAILURE_PROJECTION).map(({ recovery }) => recovery),
  "REAUTHORISE_MCP_SCOPE",
  "REAUTHORISE_XERO_SCOPES",
  "VERIFY_XERO_ACCESS_AND_TENANT",
]);

const SAFE_REASON_CODES = new Set([
  "MISSING_MCP_SCOPE",
  "TRANSPORT_SCOPE_MISSING",
  "MISSING_XERO_OAUTH_SCOPE",
  "PROVIDER_ACCESS_DENIED",
  "CONNECTION_NOT_READY",
  "TARGET_SESSION_REQUIRED",
  "TARGET_SESSION_EXPIRED",
  "TARGET_BINDING_INVALID",
  "TENANT_BINDING_MISMATCH",
  "WRITE_TENANT_NOT_ALLOWED",
  "WRITE_GATE_CLOSED",
  "WRITE_KILL_SWITCH_DISABLED",
  "XERO_UNAVAILABLE",
  "XERO_UPSTREAM_ERROR",
]);

const SAFE_REASON_PREFIXES = [
  "ACCOUNT_",
  "ACCOUNTING_",
  "CONTACT_",
  "CONTROL_",
  "CREDITS_",
  "DEBITS_",
  "EXACT_XERO_",
  "EVIDENCE_",
  "FX_",
  "FOREIGN_",
  "GOODS_",
  "LINE_",
  "NETWORK_",
  "NO_TAX_",
  "ORGANISATION_",
  "PLANNED_",
  "PAYMENT_",
  "PROVIDER_",
  "REQUEST_",
  "SOURCE_",
  "STANDING_DELEGATION_",
  "MULTIPLE_",
  "TARGET_",
  "TAX_",
  "TEST_DOCUMENT_",
  "UNSUPPORTED_",
  "XERO_HTTP_",
] as const;

function safeReasonCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) return undefined;
  return SAFE_REASON_CODES.has(value) || SAFE_REASON_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const safe = safeReasonCode(item);
    return safe ? [safe] : [];
  }).slice(0, 32);
}

function reasonCodes(error: AppError): string[] {
  const details = error.details;
  return [...new Set([
    ...stringArray(details?.denyReasons),
    ...stringArray(details?.reasonCodes),
    ...stringArray(details?.validationReasonCodes),
    ...stringArray(details?.providerAccessDenyReasons),
  ])].sort().slice(0, 32);
}

function safeOperationId(error: AppError): string | undefined {
  const value = error.details?.operationId ?? error.details?.mutationRequestId ?? error.details?.caseId;
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,256}$/u.test(value) ? value : undefined;
}

/**
 * Field paths describe the caller's own request structure, so they are safe to
 * echo back; anything that does not look like a plain path is dropped rather
 * than trusted, keeping provider bodies and document values out of the reply.
 */
function safeRequestFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]{1,6}\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(item) &&
      item.length <= 128
      ? [item]
      : []).slice(0, 16);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:._/-]{1,256}$/u.test(value) ? value : undefined;
}

function safeIdentifierArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const safe = safeIdentifier(item);
    return safe ? [safe] : [];
  }).slice(0, 100);
}

/**
 * Projects every internal failure into the same Agent-safe taxonomy. Provider
 * bodies, tokens, raw target references and stack traces are never exposed.
 */
export function xeroMcpFailureEnvelope(error: unknown): XeroMcpFailureEnvelope {
  const safe = toSafeError(error);
  const fallback = DEFAULT_FAILURE_PROJECTION[safe.code];
  const explicitLayer = typeof safe.details?.failureLayer === "string" &&
    safe.details.failureLayer.length <= 64 && SAFE_FAILURE_LAYERS.has(safe.details.failureLayer)
    ? safe.details.failureLayer
    : undefined;
  const explicitRecovery = typeof safe.details?.recoveryAction === "string" &&
    safe.details.recoveryAction.length <= 64 && SAFE_RECOVERY_ACTIONS.has(safe.details.recoveryAction)
    ? safe.details.recoveryAction
    : undefined;
  const auditCallId = typeof safe.details?.auditCallId === "string" &&
    /^call_[A-Za-z0-9:_-]{1,123}$/u.test(safe.details.auditCallId)
    ? safe.details.auditCallId
    : undefined;
  const auditCompletionStatus = safe.details?.auditCompletionStatus === "UNKNOWN"
    ? "UNKNOWN" as const
    : undefined;
  const codes = reasonCodes(safe);
  const invalidFields = safeRequestFields(safe.details?.invalidFields);
  const mismatchFields = safeRequestFields(safe.details?.mismatchFields);
  const holdingCaseId = safeIdentifier(safe.details?.holdingCaseId);
  const holdingCaseVersion = typeof safe.details?.holdingCaseVersion === "number" &&
    Number.isSafeInteger(safe.details.holdingCaseVersion) && safe.details.holdingCaseVersion > 0
    ? safe.details.holdingCaseVersion
    : undefined;
  const holdReleasesAt = typeof safe.details?.holdReleasesAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(safe.details.holdReleasesAt)
    ? safe.details.holdReleasesAt
    : undefined;
  const operationId = safeOperationId(safe);
  const caseId = safeIdentifier(safe.details?.caseId);
  const caseVersion = typeof safe.details?.caseVersion === "number" &&
    Number.isSafeInteger(safe.details.caseVersion) && safe.details.caseVersion > 0
    ? safe.details.caseVersion
    : undefined;
  const completedOperationIds = safeIdentifierArray(safe.details?.completedOperationIds);
  const failedOperationId = safeIdentifier(safe.details?.failedOperationId);
  const nextAction = safeIdentifier(safe.details?.nextAction);
  const providerMutationPossible = safe.code === "WRITE_RESULT_UNKNOWN" || safe.code === "READBACK_MISMATCH"
    ? true
    : typeof safe.details?.providerMutationPossible === "boolean"
    ? safe.details.providerMutationPossible
    : false;

  return {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      failure_layer: explicitLayer ?? fallback.layer,
      provider_mutation_possible: providerMutationPossible,
      recovery_action: explicitRecovery ?? fallback.recovery,
      ...(codes.length > 0 ? { reason_codes: codes } : {}),
      ...(invalidFields.length > 0 ? { invalid_fields: invalidFields } : {}),
      ...(mismatchFields.length > 0 ? { mismatch_fields: mismatchFields } : {}),
      ...(holdingCaseId ? { holding_case_id: holdingCaseId } : {}),
      ...(holdingCaseVersion ? { holding_case_version: holdingCaseVersion } : {}),
      ...(holdReleasesAt ? { hold_releases_at: holdReleasesAt } : {}),
      ...(operationId ? { operation_id: operationId } : {}),
      ...(caseId ? { case_id: caseId } : {}),
      ...(caseVersion ? { case_version: caseVersion } : {}),
      ...(completedOperationIds.length > 0 ? { completed_operation_ids: completedOperationIds } : {}),
      ...(failedOperationId ? { failed_operation_id: failedOperationId } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
      ...(auditCallId ? { auditCallId } : {}),
      ...(auditCompletionStatus ? { auditCompletionStatus } : {}),
    },
  };
}
