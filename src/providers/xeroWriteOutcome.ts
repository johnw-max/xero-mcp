type SdkErrorShape = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; statusCode?: unknown; body?: unknown };
  body?: unknown;
};

export type XeroWriteOutcomeClassification = "DEFINITELY_REJECTED" | "UNKNOWN";

const UNKNOWN_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
]);

function errorShape(error: unknown): { status?: number; code?: string; body?: unknown } {
  if (!error || typeof error !== "object") return {};
  const candidate = error as SdkErrorShape;
  const rawStatus = candidate.response?.statusCode ?? candidate.response?.status ??
    candidate.statusCode ?? candidate.status;
  const status = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : undefined;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    body: candidate.response?.body ?? candidate.body,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * xero-node@19 serializes ApiError.generateError() before rejecting. Preserve
 * the fail-closed default for arbitrary strings, but recover the structured
 * response shape when that exact SDK error envelope is present.
 */
function deserializeSdkError(error: unknown): unknown {
  if (typeof error !== "string") return error;
  try {
    return JSON.parse(error) as unknown;
  } catch {
    return error;
  }
}

function nonEmptyValidationErrors(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  const direct = candidate.validationErrors ?? candidate.ValidationErrors;
  if (Array.isArray(direct) && direct.length > 0) return true;
  const elements = candidate.elements ?? candidate.Elements;
  return Array.isArray(elements) && elements.some((element) => nonEmptyValidationErrors(element));
}

function structuredXeroRejection(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  if (nonEmptyValidationErrors(candidate)) return true;
  const errorNumber = candidate.errorNumber ?? candidate.ErrorNumber;
  const type = candidate.type ?? candidate.Type;
  const message = candidate.message ?? candidate.Message;
  return (typeof errorNumber === "number" || typeof errorNumber === "string") &&
    typeof type === "string" && type.trim().length > 0 &&
    typeof message === "string" && message.trim().length > 0;
}

/**
 * Fail-closed write classification. A generic HTTP status is not proof that
 * Xero performed no write: proxies, retries and timeouts can surface 3xx/4xx
 * after the upstream accepted the request. Only a structured Xero validation
 * rejection is released as DEFINITELY_REJECTED; every other outcome remains
 * UNKNOWN and retains the source reservation for exact recovery.
 */
export function classifyXeroWriteException(error: unknown): XeroWriteOutcomeClassification {
  const candidate = errorShape(deserializeSdkError(error));
  if (candidate.code && UNKNOWN_NETWORK_CODES.has(candidate.code)) return "UNKNOWN";
  if (
    candidate.status === undefined ||
    candidate.status === 0 ||
    candidate.status < 400 ||
    candidate.status >= 500 ||
    [408, 409, 425, 429].includes(candidate.status)
  ) return "UNKNOWN";
  return structuredXeroRejection(candidate.body) ? "DEFINITELY_REJECTED" : "UNKNOWN";
}
