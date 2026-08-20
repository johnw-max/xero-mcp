import type { GovernanceAuditEventInput } from "../domain/models.js";
import { hashObject, stableStringify } from "../security/hash.js";

const SAFE_ID = /^[A-Za-z0-9:@+._/-]{1,240}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FORBIDDEN_EVIDENCE_KEY = /(^|_)(access_token|refresh_token|oauth_token|token|secret|password|prompt|chain_of_thought)(_|$)/iu;

function assertSafeValue(value: unknown, path: string, depth = 0): void {
  if (depth > 8) throw new Error(`Governance evidence exceeds the nesting limit at ${path}.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeValue(child, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_EVIDENCE_KEY.test(key)) {
        throw new Error(`Governance evidence contains a forbidden secret or reasoning field at ${path}.${key}.`);
      }
      assertSafeValue(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`Governance evidence contains a non-JSON value at ${path}.`);
}

export function assertGovernanceAuditEventInput(input: GovernanceAuditEventInput): void {
  for (const [name, value] of [
    ["eventId", input.eventId],
    ["streamId", input.streamId],
    ["eventType", input.eventType],
    ["action", input.action],
    ["actorId", input.actorId],
    ["correlationId", input.correlationId],
  ] as const) {
    if (!SAFE_ID.test(value)) throw new Error(`Governance ${name} is invalid.`);
  }
  if (input.schemaVersion !== "zcloak.governance-event.v1") {
    throw new Error("Governance schema version is unsupported.");
  }
  if (!Number.isFinite(input.occurredAt.getTime())) throw new Error("Governance occurrence time is invalid.");
  for (const hash of [input.inputHash, input.outputHash]) {
    if (hash !== undefined && !SHA256.test(hash)) throw new Error("Governance evidence hash is invalid.");
  }
  assertSafeValue(input.evidence, "evidence");
  if (Buffer.byteLength(stableStringify(input.evidence), "utf8") > 16_384) {
    throw new Error("Governance evidence exceeds 16 KiB.");
  }
}

export function governanceAuditEventHash(
  input: GovernanceAuditEventInput,
  previousEventHash: string | undefined,
  recordedAt: Date,
): string {
  assertGovernanceAuditEventInput(input);
  if (previousEventHash !== undefined && !SHA256.test(previousEventHash)) {
    throw new Error("Previous governance event hash is invalid.");
  }
  return hashObject({
    ...input,
    occurredAt: input.occurredAt.toISOString(),
    recordedAt: recordedAt.toISOString(),
    previousEventHash: previousEventHash ?? null,
  });
}
