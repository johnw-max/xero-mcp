import { AppError, type AppErrorCode } from "../errors.js";

export type XeroCapabilityFailureLayer =
  | "CONNECTION"
  | "TARGET_BINDING"
  | "MCP_SCOPE"
  | "PROVIDER_OAUTH_SCOPE"
  | "WRITE_POLICY"
  | "STANDING_DELEGATION"
  | "ACTION_POLICY";

interface CapabilityErrorProjection {
  code: AppErrorCode;
  failureLayer: XeroCapabilityFailureLayer;
  recoveryAction: string;
}

const CAPABILITY_REASON_CODES = new Set([
  "TARGET_SESSION_REQUIRED",
  "TARGET_SESSION_EXPIRED",
  "TARGET_BINDING_INVALID",
  "TENANT_BINDING_MISMATCH",
  "WRITE_TENANT_NOT_ALLOWED",
  "CONNECTION_NOT_READY",
  "MISSING_MCP_SCOPE",
  "TRANSPORT_SCOPE_MISSING",
  "MISSING_XERO_OAUTH_SCOPE",
  "WRITE_GATE_CLOSED",
  "WRITE_KILL_SWITCH_DISABLED",
  "STANDING_DELEGATION_MISSING",
  "STANDING_DELEGATION_EXPIRED",
  "STANDING_DELEGATION_REVOKED",
  "STANDING_DELEGATION_AMBIGUOUS",
  "STANDING_DELEGATION_ACTION_MISMATCH",
  "STANDING_DELEGATION_TARGET_MISMATCH",
]);

function boundedCodes(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((value) => value.length <= 64 && /^[A-Z][A-Z0-9_]*$/u.test(value))
    .slice(0, 32);
}

function projection(reasons: readonly string[]): CapabilityErrorProjection {
  if (reasons.includes("TARGET_SESSION_REQUIRED")) {
    return { code: "TARGET_SESSION_REQUIRED", failureLayer: "TARGET_BINDING", recoveryAction: "PIN_LEDGER_TARGET" };
  }
  if (reasons.includes("TARGET_SESSION_EXPIRED")) {
    return { code: "TARGET_SESSION_EXPIRED", failureLayer: "TARGET_BINDING", recoveryAction: "PIN_LEDGER_TARGET" };
  }
  if (reasons.some((reason) => [
    "TARGET_BINDING_INVALID",
    "TENANT_BINDING_MISMATCH",
    "WRITE_TENANT_NOT_ALLOWED",
  ].includes(reason))) {
    return { code: "TARGET_SESSION_INVALID", failureLayer: "TARGET_BINDING", recoveryAction: "PIN_LEDGER_TARGET" };
  }
  if (reasons.includes("CONNECTION_NOT_READY")) {
    return { code: "NOT_CONNECTED", failureLayer: "CONNECTION", recoveryAction: "RECONNECT_XERO" };
  }
  if (reasons.includes("MISSING_MCP_SCOPE") || reasons.includes("TRANSPORT_SCOPE_MISSING")) {
    return { code: "SCOPE_MISSING", failureLayer: "MCP_SCOPE", recoveryAction: "REAUTHORISE_MCP_SCOPE" };
  }
  if (reasons.includes("MISSING_XERO_OAUTH_SCOPE")) {
    return { code: "SCOPE_MISSING", failureLayer: "PROVIDER_OAUTH_SCOPE", recoveryAction: "REAUTHORISE_XERO_SCOPES" };
  }
  if (reasons.includes("WRITE_GATE_CLOSED") || reasons.includes("WRITE_KILL_SWITCH_DISABLED")) {
    return { code: "WRITE_GATE_DISABLED", failureLayer: "WRITE_POLICY", recoveryAction: "ENABLE_RELEASE_WRITE_GATE" };
  }
  if (reasons.some((reason) => reason.startsWith("STANDING_DELEGATION_"))) {
    return {
      code: "STANDING_DELEGATION_REQUIRED",
      failureLayer: "STANDING_DELEGATION",
      recoveryAction: "REFRESH_STANDING_DELEGATION",
    };
  }
  return { code: "ACTION_UNSUPPORTED", failureLayer: "ACTION_POLICY", recoveryAction: "USE_SUPPORTED_ACTION" };
}

/** Converts internal deny reasons into a stable, machine-actionable MCP error. */
export function xeroCapabilityDenied(
  message: string,
  reasons: readonly string[],
  options: {
    providerAccessDenyReasons?: readonly string[];
    validationReasonCodes?: readonly string[];
  } = {},
): AppError {
  const safeReasons = boundedCodes(reasons).filter((reason) => CAPABILITY_REASON_CODES.has(reason));
  const mapped = projection(safeReasons);
  return new AppError(mapped.code, message, {
    httpStatus: mapped.code === "NOT_CONNECTED" ? 409 : 403,
    retryable: false,
    details: {
      failureLayer: mapped.failureLayer,
      denyReasons: safeReasons,
      ...(options.providerAccessDenyReasons?.length
        ? { providerAccessDenyReasons: boundedCodes(options.providerAccessDenyReasons) }
        : {}),
      ...(options.validationReasonCodes?.length
        ? { validationReasonCodes: boundedCodes(options.validationReasonCodes) }
        : {}),
      providerMutationPossible: false,
      recoveryAction: mapped.recoveryAction,
    },
  });
}
