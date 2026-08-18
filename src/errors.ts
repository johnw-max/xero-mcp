export type AppErrorCode =
  | "AUTH_REQUIRED"
  | "OAUTH_TOKEN_EXPIRED"
  | "OAUTH_REFRESH_FAILED"
  | "SCOPE_MISSING"
  | "SUBJECT_FORBIDDEN"
  | "TARGET_SESSION_REQUIRED"
  | "TARGET_SESSION_INVALID"
  | "TARGET_SESSION_EXPIRED"
  | "WRITE_GATE_DISABLED"
  | "STANDING_DELEGATION_REQUIRED"
  | "ACTION_UNSUPPORTED"
  | "RATE_LIMITED"
  | "NETWORK_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "PERSISTENCE_FAILURE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_CONNECTED"
  | "AMBIGUOUS_CONNECTION"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "STALE_PREFLIGHT"
  | "READBACK_MISMATCH"
  | "WRITE_RESULT_UNKNOWN"
  | "PROVIDER_ERROR"
  | "CONFIGURATION_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * A schema failure is deterministic: the same input fails the same way forever.
 * Reporting it as an upstream provider fault names the wrong layer and, worse,
 * marks it retryable — which invites a caller to retry an input that can never
 * succeed, and hides the real cause behind a transient-looking error. Classify
 * it as the deterministic validation failure it is.
 */
function isSchemaValidationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

export function toSafeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isSchemaValidationError(error)) {
    return new AppError("VALIDATION_FAILED", "The accounting request failed deterministic validation.", {
      httpStatus: 422,
      retryable: false,
      details: { reasonCodes: ["REQUEST_SCHEMA_INVALID"], providerMutationPossible: false },
      cause: error,
    });
  }

  return new AppError("PROVIDER_ERROR", "The upstream accounting request failed.", {
    httpStatus: 502,
    retryable: true,
    cause: error,
  });
}
