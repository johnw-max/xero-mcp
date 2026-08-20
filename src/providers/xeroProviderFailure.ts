import { AppError } from "../errors.js";

type ProviderErrorShape = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; statusCode?: unknown };
};

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

export interface XeroProviderFailureClassification {
  code: "OAUTH_TOKEN_EXPIRED" | "FORBIDDEN" | "RATE_LIMITED" |
    "NETWORK_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR";
  failureLayer: string;
  reasonCode: string;
  recoveryAction: string;
  retryable: boolean;
  httpStatus: number;
  providerStatus?: number;
}

export function classifyXeroProviderFailure(error: unknown): XeroProviderFailureClassification {
  const candidate = error && typeof error === "object" ? error as ProviderErrorShape : {};
  const rawStatus = candidate.response?.statusCode ?? candidate.response?.status ??
    candidate.statusCode ?? candidate.status;
  const providerStatus = typeof rawStatus === "number" && Number.isFinite(rawStatus)
    ? rawStatus
    : undefined;
  const transportCode = typeof candidate.code === "string" ? candidate.code.toUpperCase() : undefined;

  if (transportCode && NETWORK_CODES.has(transportCode)) {
    return {
      code: "NETWORK_UNAVAILABLE",
      failureLayer: "NETWORK",
      reasonCode: `NETWORK_${transportCode}`,
      recoveryAction: "RETRY_AFTER_CONNECTIVITY_RECOVERS",
      retryable: true,
      httpStatus: 503,
    };
  }
  if (providerStatus === 401) {
    return {
      code: "OAUTH_TOKEN_EXPIRED",
      failureLayer: "PROVIDER_OAUTH_TOKEN",
      reasonCode: "XERO_HTTP_401",
      recoveryAction: "RECONNECT_XERO",
      retryable: false,
      httpStatus: 409,
      providerStatus,
    };
  }
  if (providerStatus === 403) {
    return {
      code: "FORBIDDEN",
      failureLayer: "PROVIDER_ACCESS",
      reasonCode: "PROVIDER_ACCESS_DENIED",
      recoveryAction: "VERIFY_XERO_ACCESS_AND_TENANT",
      retryable: false,
      httpStatus: 403,
      providerStatus,
    };
  }
  if (providerStatus === 429) {
    return {
      code: "RATE_LIMITED",
      failureLayer: "PROVIDER_RATE_LIMIT",
      reasonCode: "XERO_HTTP_429",
      recoveryAction: "RETRY_WITH_BACKOFF",
      retryable: true,
      httpStatus: 429,
      providerStatus,
    };
  }
  if (providerStatus === 408 || providerStatus === 425 || (providerStatus !== undefined && providerStatus >= 500)) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      failureLayer: "PROVIDER_SERVICE",
      reasonCode: providerStatus === undefined ? "XERO_UNAVAILABLE" : `XERO_HTTP_${providerStatus}`,
      recoveryAction: "RETRY_AFTER_PROVIDER_RECOVERS",
      retryable: true,
      httpStatus: 503,
      ...(providerStatus !== undefined ? { providerStatus } : {}),
    };
  }
  return {
    code: "PROVIDER_ERROR",
    failureLayer: "PROVIDER_RESPONSE",
    reasonCode: providerStatus === undefined ? "XERO_UPSTREAM_ERROR" : `XERO_HTTP_${providerStatus}`,
    recoveryAction: "INSPECT_PROVIDER_RESPONSE",
    retryable: providerStatus === undefined,
    httpStatus: 502,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
  };
}

/** Converts a raw Xero read/preflight error without exposing the provider body. */
export function xeroProviderReadFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const classified = classifyXeroProviderFailure(error);
  return new AppError(classified.code, "The Xero provider request could not be completed.", {
    httpStatus: classified.httpStatus,
    retryable: classified.retryable,
    cause: error,
    details: {
      failureLayer: classified.failureLayer,
      reasonCodes: [classified.reasonCode],
      recoveryAction: classified.recoveryAction,
      providerMutationPossible: false,
      ...(classified.providerStatus !== undefined ? { providerStatus: classified.providerStatus } : {}),
    },
  });
}

/** Safe diagnostics to attach while preserving WRITE_RESULT_UNKNOWN semantics. */
export function xeroUncertainWriteFailureDetails(error: unknown): Record<string, unknown> {
  const classified = classifyXeroProviderFailure(error);
  return {
    failureLayer: classified.failureLayer,
    reasonCodes: [classified.reasonCode],
    recoveryAction: "READBACK_RECOVERY_ONLY",
    providerMutationPossible: true,
    ...(classified.providerStatus !== undefined ? { providerStatus: classified.providerStatus } : {}),
  };
}
