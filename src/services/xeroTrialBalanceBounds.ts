import { hashObject } from "../security/hash.js";

export const XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES = 96 * 1_024;
export const XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES = 128 * 1_024;
/** Reserved for the normalized provenance envelope added at the MCP boundary. */
export const XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES = 8 * 1_024;
export const XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES = 5_000;
export const XERO_TRIAL_BALANCE_MAX_RETURNED_NESTING_DEPTH = 64;
export const XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES = 20_000;
export const XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES = 1 * 1_024 * 1_024;
export const XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_NESTING_DEPTH = 256;

const MIN_STRING_UTF8_BYTES_UNDER_PRESSURE = 256;
const TRUNCATED_VALUE_SUFFIX = "...[MCP truncated]";

const CIRCULAR_VALUE = "[MCP omitted circular provider value]";
const DEPTH_LIMIT_VALUE = "[MCP omitted value beyond nesting limit]";
const UNSUPPORTED_VALUE = "[MCP converted non-JSON provider value]";

const RESERVED_METADATA_KEY = "pagination";

export type XeroTrialBalanceTruncationReason =
  | "MAX_MODEL_TEXT_UTF8_BYTES"
  | "MAX_CALL_TOOL_RESULT_UTF8_BYTES"
  | "MAX_RETURNED_VISITED_JSON_NODES"
  | "MAX_RETURNED_NESTING_DEPTH"
  | "SOURCE_INSPECTION_LIMIT"
  | "NON_JSON_PROVIDER_VALUE"
  | "RESERVED_METADATA_FIELD";

export type XeroTrialBalanceSourceInspectionStopReason =
  | "MAX_INSPECTED_JSON_NODES"
  | "MAX_INSPECTED_UTF8_BYTES"
  | "MAX_INSPECTED_NESTING_DEPTH"
  | "NON_JSON_PROVIDER_STRUCTURE";

export interface XeroTrialBalanceMeasuredQuantity {
  relation: "EXACT" | "AT_LEAST";
  value: number;
}

export interface XeroTrialBalanceSourceMeasurement {
  status: "EXACT" | "LOWER_BOUND";
  serialization: "EXACT_JSON" | "SAFE_JSON_PROJECTION" | "NOT_FULLY_INSPECTED";
  utf8Bytes: XeroTrialBalanceMeasuredQuantity;
  visitedJsonNodes: XeroTrialBalanceMeasuredQuantity;
  inspectedJsonNodes: number;
  maxInspectedUtf8Bytes: number;
  maxInspectedJsonNodes: number;
  maxInspectedNestingDepth: number;
  stopReasons: XeroTrialBalanceSourceInspectionStopReason[];
}

export interface XeroTrialBalancePagination {
  contractVersion: "2.0";
  scope: "MCP_BOUNDED_TRIAL_BALANCE_VIEW";
  maxModelTextUtf8Bytes: number;
  maxCallToolResultUtf8Bytes: number;
  maxReturnedVisitedJsonNodes: number;
  maxReturnedNestingDepth: number;
  modelTextUtf8Bytes: number;
  callToolResultUtf8Bytes: number;
  returnedVisitedJsonNodes: number;
  mcpTruncated: boolean;
  truncationReasons: XeroTrialBalanceTruncationReason[];
  visitedJsonNodeDefinition: string;
  sourceMeasurement: XeroTrialBalanceSourceMeasurement;
  providerCompleteness: {
    status: "NOT_VERIFIED";
    scope: "SINGLE_XERO_PROVIDER_RESPONSE";
    auditCompleteness: "NOT_ESTABLISHED";
    statement: string;
  };
}

export type XeroTrialBalanceAgentResult = Record<string, unknown> & {
  pagination: XeroTrialBalancePagination;
};

export interface XeroTrialBalanceContentOnlyCallToolResult {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
}

interface SourceMeasurementState {
  readonly active: WeakSet<object>;
  readonly stopReasons: Set<XeroTrialBalanceSourceInspectionStopReason>;
  exactJson: boolean;
  inspectedJsonNodes: number;
  visitedJsonNodes: number;
  utf8Bytes: number;
  stopped: boolean;
}

interface CloneState {
  readonly nodeLimit: number;
  readonly stringUtf8Limit: number;
  readonly reasons: Set<XeroTrialBalanceTruncationReason>;
  readonly active: WeakSet<object>;
  inspectedJsonNodes: number;
  returnedVisitedJsonNodes: number;
}

interface Candidate {
  result: XeroTrialBalanceAgentResult;
  modelTextUtf8Bytes: number;
  callToolResultUtf8Bytes: number;
}

type MeasurementFrame =
  | { kind: "VALUE"; value: unknown; container: "ROOT" | "ARRAY" | "OBJECT"; depth: number }
  | { kind: "ARRAY"; value: unknown[]; index: number; depth: number }
  | { kind: "OBJECT"; value: object; keys: Iterator<string>; emittedEntries: number; depth: number }
  | { kind: "LEAVE"; value: object };

const OMIT = Symbol("omit");

function jsonCodePointBytes(value: string, index: number): { bytes: number; advance: number } {
  const code = value.charCodeAt(index);
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
    return { bytes: 2, advance: 1 };
  }
  if (code <= 0x1f) return { bytes: 6, advance: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff
      ? { bytes: 4, advance: 2 }
      : { bytes: 6, advance: 1 };
  }
  if (code >= 0xdc00 && code <= 0xdfff) return { bytes: 6, advance: 1 };
  return { bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3, advance: 1 };
}

function boundedJsonStringByteLength(value: string, maxBytes: number): { bytes: number; complete: boolean } {
  if (maxBytes < 2) return { bytes: maxBytes, complete: false };
  let bytes = 2;
  for (let index = 0; index < value.length;) {
    const measured = jsonCodePointBytes(value, index);
    if (bytes + measured.bytes > maxBytes) return { bytes: maxBytes, complete: false };
    bytes += measured.bytes;
    index += measured.advance;
  }
  return { bytes, complete: true };
}

function stopSourceInspection(
  state: SourceMeasurementState,
  reason: XeroTrialBalanceSourceInspectionStopReason,
): false {
  state.stopReasons.add(reason);
  state.stopped = true;
  return false;
}

function addSourceBytes(state: SourceMeasurementState, bytes: number): boolean {
  if (state.utf8Bytes + bytes > XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES) {
    state.utf8Bytes = XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES;
    return stopSourceInspection(state, "MAX_INSPECTED_UTF8_BYTES");
  }
  state.utf8Bytes += bytes;
  return true;
}

function addSourceJsonString(state: SourceMeasurementState, value: string): boolean {
  const remaining = XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES - state.utf8Bytes;
  const measured = boundedJsonStringByteLength(value, remaining);
  if (!measured.complete) {
    state.utf8Bytes = XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES;
    return stopSourceInspection(state, "MAX_INSPECTED_UTF8_BYTES");
  }
  state.utf8Bytes += measured.bytes;
  return true;
}

function inspectSourceNode(state: SourceMeasurementState): boolean {
  if (state.inspectedJsonNodes >= XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES) {
    return stopSourceInspection(state, "MAX_INSPECTED_JSON_NODES");
  }
  state.inspectedJsonNodes += 1;
  return true;
}

function measurePrimitive(
  state: SourceMeasurementState,
  value: unknown,
  container: "ROOT" | "ARRAY" | "OBJECT",
): boolean {
  if (value === null) return addSourceBytes(state, 4);
  switch (typeof value) {
    case "string":
      return addSourceJsonString(state, value);
    case "boolean":
      return addSourceBytes(state, value ? 4 : 5);
    case "number": {
      const encoded = JSON.stringify(value);
      return encoded === undefined || addSourceBytes(state, Buffer.byteLength(encoded, "utf8"));
    }
    case "undefined":
    case "function":
    case "symbol":
      return container !== "ARRAY" || addSourceBytes(state, 4);
    case "bigint":
      state.exactJson = false;
      return addSourceJsonString(state, UNSUPPORTED_VALUE);
    default:
      return false;
  }
}

function* enumerableStringKeys(value: object): Generator<string> {
  for (const key in value) yield key;
}

/**
 * Inspects a bounded prefix of the Provider response. Array traversal is lazy,
 * and no source byte/node/depth counter can exceed its configured inspection
 * budget. If inspection stops, every source quantity is explicitly AT_LEAST.
 */
function measureSource(source: unknown): XeroTrialBalanceSourceMeasurement {
  const state: SourceMeasurementState = {
    active: new WeakSet<object>(),
    stopReasons: new Set<XeroTrialBalanceSourceInspectionStopReason>(),
    exactJson: true,
    inspectedJsonNodes: 0,
    visitedJsonNodes: 0,
    utf8Bytes: 0,
    stopped: false,
  };
  const stack: MeasurementFrame[] = [{ kind: "VALUE", value: source, container: "ROOT", depth: 0 }];

  while (stack.length > 0 && !state.stopped) {
    const frame = stack.pop();
    if (!frame) break;
    if (frame.kind === "LEAVE") {
      state.active.delete(frame.value);
      continue;
    }
    if (frame.kind === "ARRAY") {
      if (frame.index >= frame.value.length) continue;
      stack.push({ ...frame, index: frame.index + 1 });
      if (!inspectSourceNode(state)) break;
      state.visitedJsonNodes += 1;
      if (frame.index > 0 && !addSourceBytes(state, 1)) break;
      let child: unknown;
      try {
        child = frame.value[frame.index];
      } catch {
        child = UNSUPPORTED_VALUE;
        state.exactJson = false;
      }
      stack.push({ kind: "VALUE", value: child, container: "ARRAY", depth: frame.depth + 1 });
      continue;
    }
    if (frame.kind === "OBJECT") {
      let emitted = false;
      while (!emitted && !state.stopped) {
        let next: IteratorResult<string>;
        try {
          next = frame.keys.next();
        } catch {
          state.exactJson = false;
          stopSourceInspection(state, "NON_JSON_PROVIDER_STRUCTURE");
          break;
        }
        if (next.done) break;
        if (!inspectSourceNode(state)) break;
        let isOwn: boolean;
        try {
          isOwn = Object.hasOwn(frame.value, next.value);
        } catch {
          state.exactJson = false;
          stopSourceInspection(state, "NON_JSON_PROVIDER_STRUCTURE");
          break;
        }
        if (!isOwn) continue;
        let child: unknown;
        try {
          child = (frame.value as Record<string, unknown>)[next.value];
        } catch {
          child = UNSUPPORTED_VALUE;
          state.exactJson = false;
        }
        if (["undefined", "function", "symbol"].includes(typeof child)) continue;
        state.visitedJsonNodes += 1;
        if (frame.emittedEntries > 0 && !addSourceBytes(state, 1)) break;
        if (!addSourceJsonString(state, next.value) || !addSourceBytes(state, 1)) break;
        stack.push({ ...frame, emittedEntries: frame.emittedEntries + 1 });
        stack.push({ kind: "VALUE", value: child, container: "OBJECT", depth: frame.depth + 1 });
        emitted = true;
      }
      continue;
    }

    if (measurePrimitive(state, frame.value, frame.container)) continue;
    if (state.stopped || frame.value === null || frame.value === undefined || typeof frame.value !== "object") continue;

    if (frame.value instanceof Date) {
      if (Number.isFinite(frame.value.getTime())) addSourceJsonString(state, frame.value.toISOString());
      else addSourceBytes(state, 4);
      continue;
    }
    if (state.active.has(frame.value)) {
      state.exactJson = false;
      addSourceJsonString(state, CIRCULAR_VALUE);
      continue;
    }
    if (frame.depth >= XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_NESTING_DEPTH) {
      stopSourceInspection(state, "MAX_INSPECTED_NESTING_DEPTH");
      break;
    }

    state.active.add(frame.value);
    stack.push({ kind: "LEAVE", value: frame.value });
    if (Array.isArray(frame.value)) {
      if (!addSourceBytes(state, 2)) break;
      stack.push({ kind: "ARRAY", value: frame.value, index: 0, depth: frame.depth });
    } else {
      if (!addSourceBytes(state, 2)) break;
      let keys: Iterator<string>;
      try {
        keys = enumerableStringKeys(frame.value);
      } catch {
        state.exactJson = false;
        stopSourceInspection(state, "NON_JSON_PROVIDER_STRUCTURE");
        break;
      }
      stack.push({ kind: "OBJECT", value: frame.value, keys, emittedEntries: 0, depth: frame.depth });
    }
  }

  const complete = state.stopReasons.size === 0;
  return {
    status: complete ? "EXACT" : "LOWER_BOUND",
    serialization: complete
      ? (state.exactJson ? "EXACT_JSON" : "SAFE_JSON_PROJECTION")
      : "NOT_FULLY_INSPECTED",
    utf8Bytes: { relation: complete ? "EXACT" : "AT_LEAST", value: state.utf8Bytes },
    visitedJsonNodes: { relation: complete ? "EXACT" : "AT_LEAST", value: state.visitedJsonNodes },
    inspectedJsonNodes: state.inspectedJsonNodes,
    maxInspectedUtf8Bytes: XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES,
    maxInspectedJsonNodes: XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES,
    maxInspectedNestingDepth: XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_NESTING_DEPTH,
    stopReasons: [...state.stopReasons],
  };
}

function truncateUtf8(value: string, maxUtf8Bytes: number): { value: string; truncated: boolean } {
  const suffixBytes = Buffer.byteLength(TRUNCATED_VALUE_SUFFIX, "utf8");
  const prefixBudget = Math.max(0, maxUtf8Bytes - suffixBytes);
  const chunks: string[] = [];
  let prefixBytes = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.codePointAt(index);
    if (code === undefined) break;
    const chunk = String.fromCodePoint(code);
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (prefixBytes + chunkBytes > prefixBudget) break;
    chunks.push(chunk);
    prefixBytes += chunkBytes;
    index += chunk.length;
  }
  if (index === value.length) return { value, truncated: false };
  if (maxUtf8Bytes <= suffixBytes) {
    return { value: TRUNCATED_VALUE_SUFFIX.slice(0, Math.max(0, maxUtf8Bytes)), truncated: true };
  }
  return { value: `${chunks.join("")}${TRUNCATED_VALUE_SUFFIX}`, truncated: true };
}

function uniqueBoundedKey(sourceKey: string, target: Record<string, unknown>, state: CloneState): string {
  const keyLimit = state.stringUtf8Limit;
  const bounded = truncateUtf8(sourceKey, keyLimit);
  let key = bounded.value;
  if (bounded.truncated) state.reasons.add("MAX_MODEL_TEXT_UTF8_BYTES");
  if (!Object.hasOwn(target, key)) return key;

  let sequence = 2;
  while (true) {
    const suffix = `#${sequence}`;
    const candidatePrefix = truncateUtf8(key, Math.max(1, keyLimit - Buffer.byteLength(suffix, "utf8"))).value;
    const candidate = `${candidatePrefix}${suffix}`;
    if (!Object.hasOwn(target, candidate)) return candidate;
    sequence += 1;
  }
}

function defineEnumerable(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneValue(
  value: unknown,
  state: CloneState,
  depth: number,
  container: "ROOT" | "ARRAY" | "OBJECT",
): unknown | typeof OMIT {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bounded = truncateUtf8(value, state.stringUtf8Limit);
    if (bounded.truncated) state.reasons.add("MAX_MODEL_TEXT_UTF8_BYTES");
    return bounded.value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (["undefined", "function", "symbol"].includes(typeof value)) return container === "ARRAY" ? null : OMIT;
  if (typeof value === "bigint") {
    state.reasons.add("NON_JSON_PROVIDER_VALUE");
    return UNSUPPORTED_VALUE;
  }
  if (typeof value !== "object") return OMIT;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (state.active.has(value)) {
    state.reasons.add("NON_JSON_PROVIDER_VALUE");
    return CIRCULAR_VALUE;
  }
  if (depth >= XERO_TRIAL_BALANCE_MAX_RETURNED_NESTING_DEPTH) {
    state.reasons.add("MAX_RETURNED_NESTING_DEPTH");
    return DEPTH_LIMIT_VALUE;
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (state.inspectedJsonNodes >= XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES) {
          state.reasons.add("SOURCE_INSPECTION_LIMIT");
          break;
        }
        state.inspectedJsonNodes += 1;
        if (state.returnedVisitedJsonNodes >= state.nodeLimit) {
          state.reasons.add("MAX_RETURNED_VISITED_JSON_NODES");
          break;
        }
        state.returnedVisitedJsonNodes += 1;
        let entry: unknown;
        try {
          entry = value[index];
        } catch {
          entry = UNSUPPORTED_VALUE;
          state.reasons.add("NON_JSON_PROVIDER_VALUE");
        }
        const cloned = cloneValue(entry, state, depth + 1, "ARRAY");
        result.push(cloned === OMIT ? null : cloned);
      }
      return result;
    }

    const result = Object.create(null) as Record<string, unknown>;
    try {
      for (const sourceKey in value) {
        if (state.inspectedJsonNodes >= XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES) {
          state.reasons.add("SOURCE_INSPECTION_LIMIT");
          break;
        }
        state.inspectedJsonNodes += 1;
        if (!Object.hasOwn(value, sourceKey)) continue;
        if (depth === 0 && sourceKey === RESERVED_METADATA_KEY) {
          state.reasons.add("RESERVED_METADATA_FIELD");
          continue;
        }
        let entry: unknown;
        try {
          entry = (value as Record<string, unknown>)[sourceKey];
        } catch {
          entry = UNSUPPORTED_VALUE;
          state.reasons.add("NON_JSON_PROVIDER_VALUE");
        }
        if (["undefined", "function", "symbol"].includes(typeof entry)) continue;
        if (state.returnedVisitedJsonNodes >= state.nodeLimit) {
          state.reasons.add("MAX_RETURNED_VISITED_JSON_NODES");
          break;
        }
        state.returnedVisitedJsonNodes += 1;
        const key = uniqueBoundedKey(sourceKey, result, state);
        const cloned = cloneValue(entry, state, depth + 1, "OBJECT");
        if (cloned !== OMIT) defineEnumerable(result, key, cloned);
      }
    } catch {
      state.reasons.add("NON_JSON_PROVIDER_VALUE");
    }
    return result;
  } finally {
    state.active.delete(value);
  }
}

const REASON_ORDER: readonly XeroTrialBalanceTruncationReason[] = [
  "MAX_MODEL_TEXT_UTF8_BYTES",
  "MAX_CALL_TOOL_RESULT_UTF8_BYTES",
  "MAX_RETURNED_VISITED_JSON_NODES",
  "MAX_RETURNED_NESTING_DEPTH",
  "SOURCE_INSPECTION_LIMIT",
  "NON_JSON_PROVIDER_VALUE",
  "RESERVED_METADATA_FIELD",
];

function orderedReasons(reasons: ReadonlySet<XeroTrialBalanceTruncationReason>): XeroTrialBalanceTruncationReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function transportSnapshot(result: XeroTrialBalanceAgentResult, evidence?: object): {
  modelText: string;
  modelTextUtf8Bytes: number;
  callToolResultUtf8Bytes: number;
} {
  const modelText = JSON.stringify(evidence ? { result, ...evidence } : { result });
  const callToolResult = { content: [{ type: "text", text: modelText }] };
  return {
    modelText,
    modelTextUtf8Bytes: Buffer.byteLength(modelText, "utf8"),
    callToolResultUtf8Bytes: Buffer.byteLength(JSON.stringify(callToolResult), "utf8"),
  };
}

function stabilizeTransportByteCounts(
  result: XeroTrialBalanceAgentResult,
  evidence?: object,
): ReturnType<typeof transportSnapshot> {
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const snapshot = transportSnapshot(result, evidence);
    if (
      result.pagination.modelTextUtf8Bytes === snapshot.modelTextUtf8Bytes &&
      result.pagination.callToolResultUtf8Bytes === snapshot.callToolResultUtf8Bytes
    ) {
      return snapshot;
    }
    result.pagination.modelTextUtf8Bytes = snapshot.modelTextUtf8Bytes;
    result.pagination.callToolResultUtf8Bytes = snapshot.callToolResultUtf8Bytes;
  }
  throw new Error("Trial Balance transport byte counters did not stabilize.");
}

function buildCandidate(
  source: Record<string, unknown>,
  sourceMeasurement: XeroTrialBalanceSourceMeasurement,
  nodeLimit: number,
  stringUtf8Limit: number,
  forcedReasons: ReadonlySet<XeroTrialBalanceTruncationReason>,
): Candidate {
  const reasons = new Set<XeroTrialBalanceTruncationReason>(forcedReasons);
  if (sourceMeasurement.serialization === "SAFE_JSON_PROJECTION") reasons.add("NON_JSON_PROVIDER_VALUE");
  if (sourceMeasurement.status === "LOWER_BOUND") reasons.add("SOURCE_INSPECTION_LIMIT");

  const state: CloneState = {
    nodeLimit,
    stringUtf8Limit,
    reasons,
    active: new WeakSet<object>(),
    inspectedJsonNodes: 0,
    returnedVisitedJsonNodes: 0,
  };
  const cloned = cloneValue(source, state, 0, "ROOT");
  const report = cloned && typeof cloned === "object" && !Array.isArray(cloned)
    ? cloned as Record<string, unknown>
    : Object.assign(Object.create(null) as Record<string, unknown>, { report: cloned === OMIT ? null : cloned });
  const truncationReasons = orderedReasons(reasons);
  const pagination: XeroTrialBalancePagination = {
    contractVersion: "2.0",
    scope: "MCP_BOUNDED_TRIAL_BALANCE_VIEW",
    maxModelTextUtf8Bytes: XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES,
    maxCallToolResultUtf8Bytes: XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES,
    maxReturnedVisitedJsonNodes: XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
    maxReturnedNestingDepth: XERO_TRIAL_BALANCE_MAX_RETURNED_NESTING_DEPTH,
    modelTextUtf8Bytes: 0,
    callToolResultUtf8Bytes: 0,
    returnedVisitedJsonNodes: state.returnedVisitedJsonNodes,
    mcpTruncated: truncationReasons.length > 0,
    truncationReasons,
    visitedJsonNodeDefinition: "Each returned Provider-report object property or array element counts as one visited JSON node. It is not a Xero report-row count; MCP metadata is excluded.",
    sourceMeasurement,
    providerCompleteness: {
      status: "NOT_VERIFIED",
      scope: "SINGLE_XERO_PROVIDER_RESPONSE",
      auditCompleteness: "NOT_ESTABLISHED",
      statement: "This is a bounded view of one Xero Trial Balance response. MCP bounds do not prove provider pagination, full-ledger, audit, or tax completeness.",
    },
  };
  const result = Object.create(null) as XeroTrialBalanceAgentResult;
  for (const key of Object.keys(report)) defineEnumerable(result, key, report[key]);
  defineEnumerable(result, RESERVED_METADATA_KEY, pagination);
  const snapshot = stabilizeTransportByteCounts(result);
  return {
    result,
    modelTextUtf8Bytes: snapshot.modelTextUtf8Bytes,
    callToolResultUtf8Bytes: snapshot.callToolResultUtf8Bytes,
  };
}

function candidateFits(candidate: Candidate): boolean {
  return candidate.modelTextUtf8Bytes <=
      XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES - XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES &&
    candidate.callToolResultUtf8Bytes <=
      XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES - XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES;
}

/** Returns a deterministic, JSON-safe, non-mutating Agent view of a Xero Trial Balance. */
export function boundXeroTrialBalanceForAgent(source: Record<string, unknown>): XeroTrialBalanceAgentResult {
  const sourceMeasurement = measureSource(source);
  let candidate = buildCandidate(
    source,
    sourceMeasurement,
    XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
    XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES,
    new Set<XeroTrialBalanceTruncationReason>(),
  );
  if (candidateFits(candidate)) return candidate.result;

  const transportReasons = new Set<XeroTrialBalanceTruncationReason>();
  if (
    candidate.modelTextUtf8Bytes >
    XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES - XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES
  ) {
    transportReasons.add("MAX_MODEL_TEXT_UTF8_BYTES");
  }
  if (
    candidate.callToolResultUtf8Bytes >
    XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES - XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES
  ) {
    transportReasons.add("MAX_CALL_TOOL_RESULT_UTF8_BYTES");
  }

  const stringLimits = [65_536, 32_768, 16_384, 8_192, 4_096, 2_048, 1_024, 512, MIN_STRING_UTF8_BYTES_UNDER_PRESSURE];
  for (const stringLimit of stringLimits) {
    candidate = buildCandidate(
      source,
      sourceMeasurement,
      XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
      stringLimit,
      transportReasons,
    );
    if (candidateFits(candidate)) return candidate.result;
  }

  let low = 0;
  let high = XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES;
  let best = buildCandidate(source, sourceMeasurement, 0, MIN_STRING_UTF8_BYTES_UNDER_PRESSURE, transportReasons);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const attempt = buildCandidate(
      source,
      sourceMeasurement,
      middle,
      MIN_STRING_UTF8_BYTES_UNDER_PRESSURE,
      transportReasons,
    );
    if (candidateFits(attempt)) {
      best = attempt;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!candidateFits(best)) throw new Error("Trial Balance metadata exceeds the MCP CallToolResult byte limit.");
  return best.result;
}

/** Serializes the one canonical, content-only Trial Balance MCP model output. */
export function createXeroTrialBalanceCallToolResult(
  result: XeroTrialBalanceAgentResult,
  evidence?: object,
): XeroTrialBalanceContentOnlyCallToolResult {
  const normalizedEvidence = evidence
    ? { ...evidence, output_hash: `sha256:${"0".repeat(64)}` }
    : undefined;
  if (normalizedEvidence) {
    stabilizeTransportByteCounts(result, normalizedEvidence);
    normalizedEvidence.output_hash = `sha256:${hashObject(result)}`;
  }
  const snapshot = transportSnapshot(result, normalizedEvidence);
  const bareSnapshot = transportSnapshot(result);
  if (
    snapshot.modelTextUtf8Bytes !== result.pagination.modelTextUtf8Bytes ||
    snapshot.callToolResultUtf8Bytes !== result.pagination.callToolResultUtf8Bytes
  ) {
    throw new Error("Trial Balance transport byte metadata does not match the serialized result.");
  }
  if (
    snapshot.modelTextUtf8Bytes > XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES ||
    snapshot.callToolResultUtf8Bytes > XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES
  ) {
    throw new Error("Trial Balance MCP result exceeds its transport byte contract.");
  }
  if (
    normalizedEvidence &&
    (
      snapshot.modelTextUtf8Bytes - bareSnapshot.modelTextUtf8Bytes >
        XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES ||
      snapshot.callToolResultUtf8Bytes - bareSnapshot.callToolResultUtf8Bytes >
        XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES
    )
  ) {
    throw new Error("Trial Balance read evidence exceeds its reserved transport budget.");
  }
  return { content: [{ type: "text", text: snapshot.modelText }] };
}
