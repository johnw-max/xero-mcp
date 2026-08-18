import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERDICTS = Object.freeze([
  "PASS",
  "PASS_OFFLINE_CONTRACT",
  "FAIL",
  "BLOCKED_MODEL_PROVIDER",
  "BLOCKED_ENV",
  "BLOCKED_TEST_DATA",
  "UNSUPPORTED",
  "FLAKY",
  "NOT_RUN",
]);

const VERDICT_SET = new Set(VERDICTS);
const EVIDENCE_CLASSES = new Set([
  "LIVE_AGENT2_ACCEPTANCE",
  "OFFLINE_FAULT_INJECTION_CONTRACT",
]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_WRITE_TOOL_PATTERNS = [
  "re:(^|__|_)(create|update|delete|void|authori[sz]e|approve|pay|post|reconcile)(_|$)",
];
const SECRET_KEY_PATTERN = /^(?:(?:x[_-]?)?api[_-]?key|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|cookie|set[_-]?cookie)$/i;
const ALLOWED_ROLES = new Set(["developer", "system", "user", "assistant"]);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function asInteger(value, fallback, minimum, maximum) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}, received ${String(value)}`);
  }
  return value;
}

function asFiniteNumber(value, fallback, minimum, maximum) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Expected a number from ${minimum} to ${maximum}, received ${String(value)}`);
  }
  return value;
}

function findForbiddenSecretKey(value, prefix = "manifest") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenSecretKey(value[index], `${prefix}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      return `${prefix}.${key}`;
    }
    const found = findForbiddenSecretKey(child, `${prefix}.${key}`);
    if (found) {
      return found;
    }
  }
  return null;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertPatternList(value, label) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  for (const item of value) {
    if (item.startsWith("re:")) {
      try {
        new RegExp(item.slice(3), "i");
      } catch (error) {
        throw new Error(`${label} contains an invalid regular expression ${JSON.stringify(item)}: ${error.message}`);
      }
    }
  }
}

function validateExpectations(expect, label) {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
    throw new Error(`${label} must be an object`);
  }
  const supportedKeys = new Set([
    "requiredTools",
    "forbiddenTools",
    "requiredAssistantText",
    "forbiddenAssistantText",
    "requiredToolOutput",
    "forbiddenToolOutput",
    "requiredToolCalls",
    "requiredToolCallJson",
    "exactToolCallCounts",
    "minToolCalls",
    "maxToolCalls",
    "allCallsHaveOutput",
  ]);
  const unknown = Object.keys(expect).filter((key) => !supportedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported keys: ${unknown.join(", ")}`);
  }
  if (Object.keys(expect).length === 0) {
    throw new Error(`${label} must contain at least one hard assertion`);
  }
  for (const key of [
    "requiredTools",
    "forbiddenTools",
    "requiredAssistantText",
    "forbiddenAssistantText",
    "requiredToolOutput",
    "forbiddenToolOutput",
  ]) {
    assertPatternList(expect[key], `${label}.${key}`);
  }
  if (expect.requiredToolCalls !== undefined) {
    if (!Array.isArray(expect.requiredToolCalls) || expect.requiredToolCalls.length === 0) {
      throw new Error(`${label}.requiredToolCalls must be a non-empty array`);
    }
    for (const [index, requiredCall] of expect.requiredToolCalls.entries()) {
      const callLabel = `${label}.requiredToolCalls[${index}]`;
      if (!requiredCall || typeof requiredCall !== "object" || Array.isArray(requiredCall)) {
        throw new Error(`${callLabel} must be an object`);
      }
      const unknownCallKeys = Object.keys(requiredCall).filter(
        (key) => !new Set(["tool", "arguments", "output"]).has(key),
      );
      if (unknownCallKeys.length > 0) {
        throw new Error(`${callLabel} has unsupported keys: ${unknownCallKeys.join(", ")}`);
      }
      assertNonEmptyString(requiredCall.tool, `${callLabel}.tool`);
      assertPatternList([requiredCall.tool], `${callLabel}.tool`);
      assertPatternList(requiredCall.arguments ?? [], `${callLabel}.arguments`);
      assertPatternList(requiredCall.output ?? [], `${callLabel}.output`);
    }
  }
  if (expect.requiredToolCallJson !== undefined) {
    if (!Array.isArray(expect.requiredToolCallJson) || expect.requiredToolCallJson.length === 0) {
      throw new Error(`${label}.requiredToolCallJson must be a non-empty array`);
    }
    for (const [index, requiredCall] of expect.requiredToolCallJson.entries()) {
      const callLabel = `${label}.requiredToolCallJson[${index}]`;
      if (!requiredCall || typeof requiredCall !== "object" || Array.isArray(requiredCall)) {
        throw new Error(`${callLabel} must be an object`);
      }
      const unknownCallKeys = Object.keys(requiredCall).filter(
        (key) => !new Set(["tool", "assertions"]).has(key),
      );
      if (unknownCallKeys.length > 0) throw new Error(`${callLabel} has unsupported keys: ${unknownCallKeys.join(", ")}`);
      assertNonEmptyString(requiredCall.tool, `${callLabel}.tool`);
      assertPatternList([requiredCall.tool], `${callLabel}.tool`);
      if (!Array.isArray(requiredCall.assertions) || requiredCall.assertions.length === 0) {
        throw new Error(`${callLabel}.assertions must be a non-empty array`);
      }
      for (const [assertionIndex, assertion] of requiredCall.assertions.entries()) {
        const assertionLabel = `${callLabel}.assertions[${assertionIndex}]`;
        if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
          throw new Error(`${assertionLabel} must be an object`);
        }
        const operators = ["equals", "length", "multiset", "everyEquals", "everyPresent"]
          .filter((key) => assertion[key] !== undefined);
        const unknownAssertionKeys = Object.keys(assertion).filter((key) => !["path", ...operators].includes(key));
        assertNonEmptyString(assertion.path, `${assertionLabel}.path`);
        if (!/^\$(?:\.[A-Za-z0-9_]+(?:\[\*\])?)*$/u.test(assertion.path)) {
          throw new Error(`${assertionLabel}.path must be a bounded JSON path such as $.operations[*].state`);
        }
        if (operators.length !== 1 || unknownAssertionKeys.length > 0) {
          throw new Error(`${assertionLabel} must contain exactly one supported operator`);
        }
        if (assertion.length !== undefined) asInteger(assertion.length, 0, 0, 10_000);
        if (assertion.multiset !== undefined && !Array.isArray(assertion.multiset)) {
          throw new Error(`${assertionLabel}.multiset must be an array`);
        }
        if (assertion.everyPresent !== undefined && assertion.everyPresent !== true) {
          throw new Error(`${assertionLabel}.everyPresent must be true`);
        }
      }
    }
  }
  if (expect.exactToolCallCounts !== undefined) {
    if (!Array.isArray(expect.exactToolCallCounts) || expect.exactToolCallCounts.length === 0) {
      throw new Error(`${label}.exactToolCallCounts must be a non-empty array`);
    }
    for (const [index, requiredCount] of expect.exactToolCallCounts.entries()) {
      const countLabel = `${label}.exactToolCallCounts[${index}]`;
      if (!requiredCount || typeof requiredCount !== "object" || Array.isArray(requiredCount)) {
        throw new Error(`${countLabel} must be an object`);
      }
      const unknownCountKeys = Object.keys(requiredCount).filter(
        (key) => !new Set(["tool", "count"]).has(key),
      );
      if (unknownCountKeys.length > 0) {
        throw new Error(`${countLabel} has unsupported keys: ${unknownCountKeys.join(", ")}`);
      }
      assertNonEmptyString(requiredCount.tool, `${countLabel}.tool`);
      assertPatternList([requiredCount.tool], `${countLabel}.tool`);
      asInteger(requiredCount.count, 0, 0, 10_000);
    }
  }
  if (expect.minToolCalls !== undefined) {
    asInteger(expect.minToolCalls, 0, 0, 10_000);
  }
  if (expect.maxToolCalls !== undefined) {
    asInteger(expect.maxToolCalls, 0, 0, 10_000);
  }
  if (
    expect.minToolCalls !== undefined &&
    expect.maxToolCalls !== undefined &&
    expect.minToolCalls > expect.maxToolCalls
  ) {
    throw new Error(`${label}.minToolCalls cannot exceed maxToolCalls`);
  }
  if (expect.allCallsHaveOutput !== undefined && typeof expect.allCallsHaveOutput !== "boolean") {
    throw new Error(`${label}.allCallsHaveOutput must be boolean`);
  }
}

function validateMockTrace(mock, label) {
  if (mock === undefined) return;
  if (!mock || typeof mock !== "object" || Array.isArray(mock)) {
    throw new Error(`${label} must be an object`);
  }
  const supportedKeys = new Set(["sequence", "byAgent", "response"]);
  const unknown = Object.keys(mock).filter((key) => !supportedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported keys: ${unknown.join(", ")}`);
  if (mock.response === undefined) return;
  const response = mock.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(`${label}.response must be an object`);
  }
  const unknownResponseKeys = Object.keys(response).filter(
    (key) => !new Set(["assistantText", "toolCalls"]).has(key),
  );
  if (unknownResponseKeys.length > 0) {
    throw new Error(`${label}.response has unsupported keys: ${unknownResponseKeys.join(", ")}`);
  }
  assertNonEmptyString(response.assistantText, `${label}.response.assistantText`);
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length === 0) {
    throw new Error(`${label}.response.toolCalls must be a non-empty array`);
  }
  for (const [index, call] of response.toolCalls.entries()) {
    const callLabel = `${label}.response.toolCalls[${index}]`;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new Error(`${callLabel} must be an object`);
    }
    const unknownCallKeys = Object.keys(call).filter(
      (key) => !new Set(["name", "arguments", "output"]).has(key),
    );
    if (unknownCallKeys.length > 0) {
      throw new Error(`${callLabel} has unsupported keys: ${unknownCallKeys.join(", ")}`);
    }
    assertNonEmptyString(call.name, `${callLabel}.name`);
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new Error(`${callLabel}.arguments must be an object`);
    }
    if (!call.output || typeof call.output !== "object" || Array.isArray(call.output)) {
      throw new Error(`${callLabel}.output must be an object`);
    }
  }
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Manifest root must be an object");
  }
  const forbiddenSecretKey = findForbiddenSecretKey(manifest);
  if (forbiddenSecretKey) {
    throw new Error(
      `Secrets are forbidden in manifests (${forbiddenSecretKey}); the API key must only come from AGENT2_REMOTE_AGENTS_API_KEY`,
    );
  }
  if (manifest.version !== 1) {
    throw new Error("Manifest version must be 1");
  }
  assertNonEmptyString(manifest.name, "manifest.name");
  if (manifest.evidenceClass !== undefined && !EVIDENCE_CLASSES.has(manifest.evidenceClass)) {
    throw new Error(`manifest.evidenceClass must be one of ${[...EVIDENCE_CLASSES].join(", ")}`);
  }
  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    throw new Error("manifest.agents must contain at least one agent");
  }
  const agentAliases = new Set();
  for (const [index, agent] of manifest.agents.entries()) {
    const label = `manifest.agents[${index}]`;
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new Error(`${label} must be an object`);
    }
    assertNonEmptyString(agent.alias, `${label}.alias`);
    if (agentAliases.has(agent.alias)) {
      throw new Error(`Duplicate agent alias: ${agent.alias}`);
    }
    agentAliases.add(agent.alias);
    if ((agent.id === undefined) === (agent.idEnv === undefined)) {
      throw new Error(`${label} must define exactly one of id or idEnv`);
    }
    if (agent.id !== undefined) {
      assertNonEmptyString(agent.id, `${label}.id`);
    }
    if (agent.idEnv !== undefined) {
      assertNonEmptyString(agent.idEnv, `${label}.idEnv`);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(agent.idEnv)) {
        throw new Error(`${label}.idEnv must be an uppercase environment variable name`);
      }
    }
    assertNonEmptyString(agent.persona, `${label}.persona`);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("manifest.cases must contain at least one case");
  }
  const caseIds = new Set();
  for (const [index, testCase] of manifest.cases.entries()) {
    const label = `manifest.cases[${index}]`;
    if (!testCase || typeof testCase !== "object" || Array.isArray(testCase)) {
      throw new Error(`${label} must be an object`);
    }
    assertNonEmptyString(testCase.id, `${label}.id`);
    if (caseIds.has(testCase.id)) {
      throw new Error(`Duplicate case id: ${testCase.id}`);
    }
    caseIds.add(testCase.id);
    assertNonEmptyString(testCase.title, `${label}.title`);
    if (!new Set(["read", "write"]).has(testCase.operation)) {
      throw new Error(`${label}.operation must be read or write`);
    }
  if (testCase.repeats !== undefined) {
      asInteger(testCase.repeats, 1, 1, 10);
    }
    if (testCase.estimatedXeroCalls !== undefined) {
      asInteger(testCase.estimatedXeroCalls, 0, 0, 60);
    }
    assertNonEmptyString(testCase.fixture, `${label}.fixture`);
    if (path.isAbsolute(testCase.fixture)) {
      throw new Error(`${label}.fixture must be relative to the manifest`);
    }
    if (!Array.isArray(testCase.transcript) || testCase.transcript.length === 0) {
      throw new Error(`${label}.transcript must contain at least one full-transcript message`);
    }
    let fixturePlaceholderCount = 0;
    for (const [messageIndex, message] of testCase.transcript.entries()) {
      const messageLabel = `${label}.transcript[${messageIndex}]`;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error(`${messageLabel} must be an object`);
      }
      if (!ALLOWED_ROLES.has(message.role)) {
        throw new Error(`${messageLabel}.role is unsupported`);
      }
      if (typeof message.content !== "string") {
        throw new Error(
          `${messageLabel}.content must be fixture-expanded text; input_file and other content objects are intentionally unsupported`,
        );
      }
      fixturePlaceholderCount += message.content.split("{{fixture}}").length - 1;
    }
    if (fixturePlaceholderCount === 0) {
      throw new Error(`${label}.transcript must include {{fixture}} so source material is sent as text`);
    }
    if (testCase.agents !== undefined) {
      if (
        !Array.isArray(testCase.agents) ||
        testCase.agents.length === 0 ||
        testCase.agents.some((alias) => typeof alias !== "string" || !agentAliases.has(alias))
      ) {
        throw new Error(`${label}.agents must list known agent aliases`);
      }
    }
    validateExpectations(testCase.expect, `${label}.expect`);
    validateMockTrace(testCase.mock, `${label}.mock`);
    if (manifest.evidenceClass === "LIVE_AGENT2_ACCEPTANCE" && testCase.mock !== undefined) {
      throw new Error(`${label}.mock is forbidden for LIVE_AGENT2_ACCEPTANCE evidence`);
    }
    if (manifest.evidenceClass === "OFFLINE_FAULT_INJECTION_CONTRACT" && testCase.mock === undefined) {
      throw new Error(`${label}.mock is required for OFFLINE_FAULT_INJECTION_CONTRACT evidence`);
    }
  }

  const settings = manifest.settings ?? {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("manifest.settings must be an object");
  }
  asInteger(settings.concurrency, 2, 1, 16);
  asInteger(settings.repeats, 1, 1, 10);
  asInteger(settings.timeoutMs, 120_000, 100, 900_000);
  asInteger(settings.readMaxAttempts, 3, 1, 6);
  asInteger(settings.readRetryBaseMs, 500, 0, 60_000);
  asInteger(settings.maxRetryAfterMs, 60_000, 0, 900_000);
  asFiniteNumber(settings.retryJitterRatio, 0.15, 0, 1);
  asInteger(settings.maxOutputTokens, 4096, 1, 100_000);
  asFiniteNumber(settings.temperature, 0, 0, 2);
  if (settings.xeroCallsPerMinuteBudget !== undefined) {
    const budget = asInteger(settings.xeroCallsPerMinuteBudget, 45, 1, 60);
    for (const [index, testCase] of manifest.cases.entries()) {
      if (testCase.estimatedXeroCalls === undefined) {
        throw new Error(
          `manifest.cases[${index}].estimatedXeroCalls is required when settings.xeroCallsPerMinuteBudget is set`,
        );
      }
      if (testCase.estimatedXeroCalls > budget) {
        throw new Error(
          `manifest.cases[${index}].estimatedXeroCalls cannot exceed the per-minute Xero call budget`,
        );
      }
      if (testCase.expect.maxToolCalls === undefined) {
        throw new Error(
          `manifest.cases[${index}].expect.maxToolCalls is required when settings.xeroCallsPerMinuteBudget is set`,
        );
      }
      if (testCase.estimatedXeroCalls < testCase.expect.maxToolCalls) {
        throw new Error(
          `manifest.cases[${index}].estimatedXeroCalls cannot be lower than expect.maxToolCalls`,
        );
      }
    }
  }
  assertPatternList(settings.writeToolPatterns, "manifest.settings.writeToolPatterns");
  return manifest;
}

export async function loadManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  const text = await readFile(absolutePath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${absolutePath}: ${error.message}`);
  }
  validateManifest(manifest);
  return {
    manifest,
    manifestPath: absolutePath,
    manifestDir: path.dirname(absolutePath),
    manifestSha256: createHash("sha256").update(text).digest("hex"),
  };
}

async function loadRepositoryPackageVersion() {
  try {
    const packageJson = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim() !== ""
      ? packageJson.version
      : null;
  } catch {
    return null;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const trimmed = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed) * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - nowMs);
}

function compilePattern(pattern, { text = false } = {}) {
  if (pattern.startsWith("re:")) {
    return new RegExp(pattern.slice(3), "i");
  }
  if (!text && pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`, "i");
  }
  if (text) {
    return {
      test: (value) => String(value).toLocaleLowerCase().includes(pattern.toLocaleLowerCase()),
    };
  }
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

function anyMatches(values, pattern, options) {
  const matcher = compilePattern(pattern, options);
  return values.some((value) => matcher.test(String(value)));
}

function addPatternAssertions({ assertions, patterns, values, prefix, required, text = false }) {
  for (const pattern of patterns ?? []) {
    const matched = anyMatches(values, pattern, { text });
    assertions.push({
      name: `${prefix}:${pattern}`,
      pass: required ? matched : !matched,
      expected: required ? "matched" : "not matched",
      actual: matched ? "matched" : "not matched",
    });
  }
}

export function evaluateExpectations({ testCase, functionCalls, functionOutputs, assistantText, writeToolPatterns }) {
  const assertions = [];
  const expect = testCase.expect;
  const toolNames = functionCalls.map((call) => call.name ?? "");
  const outputTexts = functionOutputs.map((output) => stringifyOutput(output.output));
  const callIds = functionCalls.map((call) => call.call_id);
  const outputCallIds = functionOutputs.map((output) => output.call_id);
  const outputsByCallId = new Map();
  for (const output of functionOutputs) {
    const linked = outputsByCallId.get(output.call_id) ?? [];
    linked.push(output);
    outputsByCallId.set(output.call_id, linked);
  }
  const malformedCallIndexes = functionCalls
    .map((call, index) => ({ call, index }))
    .filter(
      ({ call }) =>
        typeof call.call_id !== "string" ||
        call.call_id === "" ||
        typeof call.name !== "string" ||
        call.name === "" ||
        typeof call.arguments !== "string",
    )
    .map(({ index }) => index);
  const malformedOutputIndexes = functionOutputs
    .map((output, index) => ({ output, index }))
    .filter(
      ({ output }) =>
        typeof output.call_id !== "string" ||
        output.call_id === "" ||
        typeof output.output !== "string" ||
        output.output === "",
    )
    .map(({ index }) => index);
  const invalidArgumentsIndexes = functionCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => {
      if (typeof call.arguments !== "string") return true;
      try {
        const parsed = JSON.parse(call.arguments);
        return !parsed || typeof parsed !== "object" || Array.isArray(parsed);
      } catch {
        return true;
      }
    })
    .map(({ index }) => index);
  const incompleteCallIndexes = functionCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.status !== "completed")
    .map(({ index }) => index);
  const incompleteOutputIndexes = functionOutputs
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => output.status !== "completed")
    .map(({ index }) => index);
  const duplicateCallIds = callIds.filter((callId, index) => callIds.indexOf(callId) !== index);
  const duplicateOutputCallIds = outputCallIds.filter(
    (callId, index) => outputCallIds.indexOf(callId) !== index,
  );
  const orphanOutputCallIds = outputCallIds.filter((callId) => !callIds.includes(callId));
  assertions.push(
    {
      name: "open_responses_function_call_shape",
      pass: malformedCallIndexes.length === 0,
      expected: "all function_call items have string call_id, name, and arguments",
      actual: malformedCallIndexes,
    },
    {
      name: "open_responses_function_call_output_shape",
      pass: malformedOutputIndexes.length === 0,
      expected: "all function_call_output items have a string call_id and non-empty string output",
      actual: malformedOutputIndexes,
    },
    {
      name: "open_responses_function_call_arguments_json_object",
      pass: invalidArgumentsIndexes.length === 0,
      expected: "every function_call arguments field is a JSON object string",
      actual: invalidArgumentsIndexes,
    },
    {
      name: "open_responses_function_call_status_completed",
      pass: incompleteCallIndexes.length === 0,
      expected: "every function_call item has status=completed",
      actual: incompleteCallIndexes,
    },
    {
      name: "open_responses_function_call_output_status_completed",
      pass: incompleteOutputIndexes.length === 0,
      expected: "every function_call_output item has status=completed",
      actual: incompleteOutputIndexes,
    },
    {
      name: "open_responses_unique_call_ids",
      pass: duplicateCallIds.length === 0,
      expected: "unique function_call call_id values",
      actual: duplicateCallIds,
    },
    {
      name: "open_responses_unique_output_call_ids",
      pass: duplicateOutputCallIds.length === 0,
      expected: "at most one function_call_output for each call_id",
      actual: duplicateOutputCallIds,
    },
    {
      name: "open_responses_no_orphan_outputs",
      pass: orphanOutputCallIds.length === 0,
      expected: "every function_call_output is linked to a captured function_call",
      actual: orphanOutputCallIds,
    },
  );

  addPatternAssertions({
    assertions,
    patterns: expect.requiredTools,
    values: toolNames,
    prefix: "required_tool",
    required: true,
  });
  addPatternAssertions({
    assertions,
    patterns: expect.forbiddenTools,
    values: toolNames,
    prefix: "forbidden_tool",
    required: false,
  });
  if (testCase.operation === "read") {
    addPatternAssertions({
      assertions,
      patterns: writeToolPatterns,
      values: toolNames,
      prefix: "implicit_read_only_write_guard",
      required: false,
    });
  }
  addPatternAssertions({
    assertions,
    patterns: expect.requiredAssistantText,
    values: [assistantText],
    prefix: "required_assistant_text",
    required: true,
    text: true,
  });
  for (const [index, requiredCall] of (expect.requiredToolCalls ?? []).entries()) {
    const matchingCalls = functionCalls.filter(
      (call) =>
        anyMatches([call.name ?? ""], requiredCall.tool) &&
        (requiredCall.arguments ?? []).every((pattern) =>
          anyMatches([call.arguments ?? ""], pattern, { text: true }),
        ),
    );
    const matched = matchingCalls.some((call) => {
      const linkedOutputs = outputsByCallId.get(call.call_id) ?? [];
      return (requiredCall.output ?? []).every((pattern) =>
        anyMatches(linkedOutputs.map((output) => stringifyOutput(output.output)), pattern, { text: true }),
      );
    });
    assertions.push({
      name: `required_tool_call:${index}:${requiredCall.tool}`,
      pass: matched,
      expected: {
        tool: requiredCall.tool,
        arguments: requiredCall.arguments ?? [],
        output: requiredCall.output ?? [],
      },
      actual: matchingCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        linked_outputs: (outputsByCallId.get(call.call_id) ?? []).map((output) => output.output),
      })),
    });
  }
  for (const [index, requiredCall] of (expect.requiredToolCallJson ?? []).entries()) {
    const matchingCalls = functionCalls.filter((call) => anyMatches([call.name ?? ""], requiredCall.tool));
    const candidates = matchingCalls.flatMap((call) =>
      (outputsByCallId.get(call.call_id) ?? []).flatMap((output) => structuredOutputCandidates(output.output)));
    const results = candidates.map((candidate) => requiredCall.assertions.map((assertion) =>
      evaluateStructuredAssertion(candidate, assertion)));
    const matched = results.some((candidateResults) => candidateResults.every((result) => result.pass));
    assertions.push({
      name: `required_tool_call_json:${index}:${requiredCall.tool}`,
      pass: matched,
      expected: requiredCall.assertions,
      actual: results,
    });
  }
  for (const [index, requiredCount] of (expect.exactToolCallCounts ?? []).entries()) {
    const matchingCalls = functionCalls.filter((call) =>
      anyMatches([call.name ?? ""], requiredCount.tool));
    assertions.push({
      name: `exact_tool_call_count:${index}:${requiredCount.tool}`,
      pass: matchingCalls.length === requiredCount.count,
      expected: requiredCount.count,
      actual: matchingCalls.length,
    });
  }
  addPatternAssertions({
    assertions,
    patterns: expect.forbiddenAssistantText,
    values: [assistantText],
    prefix: "forbidden_assistant_text",
    required: false,
    text: true,
  });
  addPatternAssertions({
    assertions,
    patterns: expect.requiredToolOutput,
    values: outputTexts,
    prefix: "required_tool_output",
    required: true,
    text: true,
  });
  addPatternAssertions({
    assertions,
    patterns: expect.forbiddenToolOutput,
    values: outputTexts,
    prefix: "forbidden_tool_output",
    required: false,
    text: true,
  });
  if (expect.minToolCalls !== undefined) {
    assertions.push({
      name: "minimum_tool_calls",
      pass: functionCalls.length >= expect.minToolCalls,
      expected: `>= ${expect.minToolCalls}`,
      actual: functionCalls.length,
    });
  }
  if (expect.maxToolCalls !== undefined) {
    assertions.push({
      name: "maximum_tool_calls",
      pass: functionCalls.length <= expect.maxToolCalls,
      expected: `<= ${expect.maxToolCalls}`,
      actual: functionCalls.length,
    });
  }
  if (expect.allCallsHaveOutput === true) {
    const missingCallIds = functionCalls
      .filter((call) => (outputsByCallId.get(call.call_id) ?? []).length !== 1)
      .map((call) => call.call_id);
    assertions.push({
      name: "all_calls_have_output",
      pass: missingCallIds.length === 0,
      expected: "exactly one function_call_output per function_call",
      actual: missingCallIds,
    });
  }
  return assertions;
}

function stringifyOutput(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function structuredOutputCandidates(value) {
  const candidates = [];
  const seen = new Set();
  const visit = (candidate, depth = 0) => {
    if (depth > 4 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      try {
        visit(JSON.parse(candidate), depth + 1);
      } catch {
        // Non-JSON tool text is intentionally not a structured oracle.
      }
      return;
    }
    if (typeof candidate !== "object") return;
    let identity;
    try {
      identity = JSON.stringify(candidate);
    } catch {
      return;
    }
    if (seen.has(identity)) return;
    seen.add(identity);
    candidates.push(candidate);
    if (!Array.isArray(candidate)) {
      visit(candidate.structuredContent, depth + 1);
      visit(candidate.result, depth + 1);
      if (Array.isArray(candidate.content)) {
        for (const item of candidate.content) {
          if (item && typeof item === "object" && item.type === "text") visit(item.text, depth + 1);
        }
      }
    }
  };
  visit(value);
  return candidates;
}

function jsonPathValues(root, pathValue) {
  const tokens = pathValue === "$" ? [] : pathValue.slice(2).split(".");
  let values = [root];
  for (const token of tokens) {
    const wildcard = token.endsWith("[*]");
    const key = wildcard ? token.slice(0, -3) : token;
    values = values.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return [];
      const selected = value[key];
      return wildcard ? (Array.isArray(selected) ? selected : []) : [selected];
    });
  }
  return values;
}

function stableComparable(value) {
  return JSON.stringify(value, Object.keys(value && typeof value === "object" && !Array.isArray(value) ? value : {}).sort());
}

function evaluateStructuredAssertion(root, assertion) {
  const values = jsonPathValues(root, assertion.path);
  let pass = false;
  let expected;
  if (assertion.equals !== undefined) {
    expected = assertion.equals;
    pass = values.length === 1 && stableComparable(values[0]) === stableComparable(assertion.equals);
  } else if (assertion.length !== undefined) {
    expected = { length: assertion.length };
    pass = values.length === 1 && Array.isArray(values[0]) && values[0].length === assertion.length;
  } else if (assertion.multiset !== undefined) {
    expected = { multiset: assertion.multiset };
    const actual = values.map(stableComparable).sort();
    const wanted = assertion.multiset.map(stableComparable).sort();
    pass = JSON.stringify(actual) === JSON.stringify(wanted);
  } else if (assertion.everyEquals !== undefined) {
    expected = { everyEquals: assertion.everyEquals };
    pass = values.length > 0 && values.every((value) => stableComparable(value) === stableComparable(assertion.everyEquals));
  } else if (assertion.everyPresent === true) {
    expected = { everyPresent: true };
    pass = values.length > 0 && values.every((value) => value !== null && value !== undefined && value !== "");
  }
  return { path: assertion.path, pass, expected, actual: values };
}

function redactString(value, secrets) {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/("(?:access_token|refresh_token|client_secret|api_key)"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2");
}

function sanitizeForArtifacts(value, secrets) {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForArtifacts(item, secrets));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitizeForArtifacts(child, secrets);
    }
  }
  return result;
}

function renderTranscript(testCase, agent, fixtureText, repeatIndex, repeatCount) {
  const replacements = new Map([
    ["{{fixture}}", fixtureText],
    ["{{case_id}}", testCase.id],
    ["{{agent_alias}}", agent.alias],
    ["{{persona}}", agent.persona],
    ["{{repeat_index}}", String(repeatIndex)],
    ["{{repeat_count}}", String(repeatCount)],
  ]);
  const render = (text) => {
    let result = text;
    for (const [needle, replacement] of replacements) {
      result = result.split(needle).join(replacement);
    }
    return result;
  };
  const toolCallCeiling = testCase.expect.maxToolCalls;
  const toolCallCeilingInstruction = toolCallCeiling === undefined
    ? ""
    : `\nTest tool-call ceiling: at most ${toolCallCeiling} total MCP tool call(s) in this sample. Do not call another tool after reaching the ceiling; state the remaining evidence gap instead.`;
  return [
    {
      type: "message",
      role: "developer",
      content: `Test persona: ${agent.persona}\nIndependent behavioral sample: ${repeatIndex}/${repeatCount}.\nStay within the user's requested accounting operation and expose uncertainty.${toolCallCeilingInstruction}`,
    },
    ...testCase.transcript.map((message) => ({
      type: "message",
      role: message.role,
      content: render(message.content),
    })),
  ];
}

function resolveAgent(agent, mode, env) {
  if (agent.id) {
    return { ...agent, resolvedId: agent.id, resolutionError: null };
  }
  const value = env[agent.idEnv];
  if (typeof value === "string" && value.trim() !== "") {
    return { ...agent, resolvedId: value.trim(), resolutionError: null };
  }
  if (mode === "mock" || mode === "dry-run") {
    return { ...agent, resolvedId: `mock:${agent.alias}`, resolutionError: null };
  }
  return {
    ...agent,
    resolvedId: null,
    resolutionError: `Missing agent ID environment variable ${agent.idEnv}`,
  };
}

function normalizedSettings(settings = {}) {
  return {
    concurrency: asInteger(settings.concurrency, 2, 1, 16),
    repeats: asInteger(settings.repeats, 1, 1, 10),
    timeoutMs: asInteger(settings.timeoutMs, 120_000, 100, 900_000),
    readMaxAttempts: asInteger(settings.readMaxAttempts, 3, 1, 6),
    readRetryBaseMs: asInteger(settings.readRetryBaseMs, 500, 0, 60_000),
    maxRetryAfterMs: asInteger(settings.maxRetryAfterMs, 60_000, 0, 900_000),
    retryJitterRatio: asFiniteNumber(settings.retryJitterRatio, 0.15, 0, 1),
    maxOutputTokens: asInteger(settings.maxOutputTokens, 4096, 1, 100_000),
    temperature: asFiniteNumber(settings.temperature, 0, 0, 2),
    xeroCallsPerMinuteBudget:
      settings.xeroCallsPerMinuteBudget === undefined
        ? null
        : asInteger(settings.xeroCallsPerMinuteBudget, 45, 1, 60),
    writeToolPatterns: settings.writeToolPatterns ?? DEFAULT_WRITE_TOOL_PATTERNS,
  };
}

function makeRequestBody(task, input, settings) {
  return {
    model: task.agent.resolvedId,
    input,
    stream: false,
    store: false,
    max_output_tokens: settings.maxOutputTokens,
    temperature: settings.temperature,
  };
}

function getHeader(response, name) {
  if (response?.headers?.get) {
    return response.headers.get(name);
  }
  const entries = response?.headers && typeof response.headers === "object" ? response.headers : {};
  const target = name.toLocaleLowerCase();
  const entry = Object.entries(entries).find(([key]) => key.toLocaleLowerCase() === target);
  return entry?.[1] ?? null;
}

async function responseText(response) {
  if (typeof response?.text === "function") {
    return response.text();
  }
  if (response?.body === undefined) {
    return "";
  }
  return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
}

function extractResponseEvidence(responseBody) {
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const functionCalls = output
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      id: item.id ?? null,
      call_id: item.call_id ?? null,
      name: item.name ?? null,
      arguments: item.arguments ?? "",
      status: item.status ?? null,
    }));
  const functionOutputs = output
    .filter((item) => item?.type === "function_call_output")
    .map((item) => ({
      id: item.id ?? null,
      call_id: item.call_id ?? null,
      output: item.output ?? "",
      status: item.status ?? null,
    }));
  const assistantText = output
    .filter((item) => item?.type === "message" && item.role === "assistant")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  return { output, functionCalls, functionOutputs, assistantText };
}

function classifyHttpFailure(status) {
  if ([401, 403, 404].includes(status)) {
    return "BLOCKED_ENV";
  }
  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    return "BLOCKED_MODEL_PROVIDER";
  }
  return "FAIL";
}

function retryDelay({ attempt, retryAfterMs, settings, random }) {
  if (retryAfterMs !== null) {
    if (retryAfterMs > settings.maxRetryAfterMs) {
      return null;
    }
    return retryAfterMs;
  }
  const base = Math.min(settings.maxRetryAfterMs, settings.readRetryBaseMs * 2 ** (attempt - 1));
  const jitter = base * settings.retryJitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function makeBaseResult({ task, runId, nowIso }) {
  return {
    run_id: runId,
    result_id: task.resultId,
    task_index: task.index,
    case_id: task.testCase.id,
    case_title: task.testCase.title,
    operation: task.testCase.operation,
    evidence_class: task.evidenceClass ?? "LEGACY_UNCLASSIFIED",
    repeatIndex: task.repeatIndex,
    repeatCount: task.repeatCount,
    agent: {
      alias: task.agent.alias,
      id: task.agent.resolvedId,
      persona: task.agent.persona,
    },
    verdict: "NOT_RUN",
    reason: null,
    attempts: 0,
    retry_events: [],
    started_at: nowIso,
    completed_at: nowIso,
    duration_ms: 0,
    request: {
      store: false,
      previous_response_id: null,
      fixture: task.testCase.fixture,
      fixture_sha256: null,
      transcript_message_count: null,
      estimated_xero_calls: task.testCase.estimatedXeroCalls ?? null,
    },
    rate_budget_reservations: [],
    response: null,
    assertions: [],
    error: null,
  };
}

async function executeTask({
  task,
  runId,
  manifestDir,
  settings,
  mode,
  allowWrite,
  transport,
  sleep,
  now,
  random,
  secrets,
  reserveXeroCalls,
}) {
  const startedMs = now();
  const result = makeBaseResult({ task, runId, nowIso: new Date(startedMs).toISOString() });
  const finish = (verdict, reason) => {
    if (!VERDICT_SET.has(verdict)) {
      throw new Error(`Internal error: unsupported verdict ${verdict}`);
    }
    const completedMs = now();
    result.verdict = verdict;
    result.reason = reason;
    result.completed_at = new Date(completedMs).toISOString();
    result.duration_ms = Math.max(0, completedMs - startedMs);
    return sanitizeForArtifacts(result, secrets);
  };

  if (task.agent.resolutionError) {
    result.error = { type: "agent_resolution", message: task.agent.resolutionError };
    return finish("BLOCKED_ENV", task.agent.resolutionError);
  }
  const fixturePath = path.resolve(manifestDir, task.testCase.fixture);
  let fixtureText;
  try {
    fixtureText = await readFile(fixturePath, "utf8");
  } catch (error) {
    result.error = { type: "fixture", message: error.message };
    return finish("BLOCKED_TEST_DATA", `Could not read fixture ${task.testCase.fixture}`);
  }
  const input = renderTranscript(
    task.testCase,
    task.agent,
    fixtureText,
    task.repeatIndex,
    task.repeatCount,
  );
  const requestBody = makeRequestBody(task, input, settings);
  result.request.fixture_sha256 = createHash("sha256").update(fixtureText).digest("hex");
  result.request.transcript_message_count = input.length;
  if (mode === "dry-run") {
    return finish("NOT_RUN", "Dry-run validated the task and fixture; no remote request was sent");
  }
  if (mode === "live" && task.testCase.operation === "write" && !allowWrite) {
    return finish("NOT_RUN", "Live write case requires the explicit --allow-write flag");
  }

  const maxAttempts = task.testCase.operation === "write" ? 1 : settings.readMaxAttempts;
  let response = null;
  let parsedBody = null;
  let responseBodyText = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result.attempts = attempt;
    if (reserveXeroCalls) {
      const reservation = await reserveXeroCalls(task.testCase.estimatedXeroCalls ?? 0);
      result.rate_budget_reservations.push({ attempt, ...reservation });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Remote Agents request timed out")), settings.timeoutMs);
    try {
      response = await transport({
        task,
        attempt,
        requestBody,
        signal: controller.signal,
      });
      responseBodyText = await responseText(response);
    } catch (error) {
      clearTimeout(timeout);
      const errorType = error?.name === "AbortError" ? "timeout" : "network";
      if (task.testCase.operation === "read" && attempt < maxAttempts) {
        const delayMs = retryDelay({ attempt, retryAfterMs: null, settings, random });
        result.retry_events.push({ attempt, reason: errorType, delay_ms: delayMs });
        await sleep(delayMs);
        continue;
      }
      result.error = { type: errorType, message: error?.message ?? String(error) };
      return finish(
        "BLOCKED_ENV",
        task.testCase.operation === "write"
          ? "Write request failed and was not retried; read back before any further write"
          : "Remote Agents request failed after the bounded read retry budget",
      );
    } finally {
      clearTimeout(timeout);
    }

    const status = Number(response?.status ?? 0);
    if (status >= 200 && status < 300) {
      try {
        parsedBody = responseBodyText === "" ? {} : JSON.parse(responseBodyText);
      } catch (error) {
        result.error = { type: "response_json", message: error.message };
        result.response = { http_status: status, raw_body: responseBodyText };
        return finish("UNSUPPORTED", "Remote Agents returned a non-JSON success response");
      }
      break;
    }

    const retryAfterMs = parseRetryAfter(getHeader(response, "retry-after"), now());
    if (
      task.testCase.operation === "read" &&
      RETRYABLE_HTTP_STATUSES.has(status) &&
      attempt < maxAttempts
    ) {
      const delayMs = retryDelay({ attempt, retryAfterMs, settings, random });
      if (delayMs !== null) {
        result.retry_events.push({
          attempt,
          reason: `http_${status}`,
          retry_after_ms: retryAfterMs,
          delay_ms: delayMs,
        });
        await sleep(delayMs);
        continue;
      }
    }
    result.response = { http_status: status, raw_body: responseBodyText };
    return finish(
      classifyHttpFailure(status),
      task.testCase.operation === "write"
        ? `HTTP ${status}; write request was not retried and requires read-back recovery`
        : `HTTP ${status}; bounded read retry was unavailable or exhausted`,
    );
  }

  if (!parsedBody || !Array.isArray(parsedBody.output)) {
    result.response = {
      http_status: Number(response?.status ?? 0),
      response_id: parsedBody?.id ?? null,
      response_status: parsedBody?.status ?? null,
      raw_body: parsedBody,
    };
    return finish("UNSUPPORTED", "Success response did not contain an Open Responses output array");
  }
  if (parsedBody.object !== "response" || parsedBody.status !== "completed") {
    result.response = {
      http_status: Number(response?.status ?? 0),
      response_id: parsedBody.id ?? null,
      response_object: parsedBody.object ?? null,
      response_status: parsedBody.status ?? null,
      error: parsedBody.error ?? null,
    };
    if (parsedBody.error || ["failed", "cancelled", "incomplete"].includes(parsedBody.status)) {
      return finish("BLOCKED_MODEL_PROVIDER", "Remote Agent response did not complete successfully");
    }
    return finish("UNSUPPORTED", "Success response was not a completed Open Responses response object");
  }
  if (parsedBody.error || ["failed", "cancelled", "incomplete"].includes(parsedBody.status)) {
    result.response = {
      http_status: Number(response?.status ?? 0),
      response_id: parsedBody.id ?? null,
      response_status: parsedBody.status ?? null,
      error: parsedBody.error ?? null,
    };
    return finish("BLOCKED_MODEL_PROVIDER", "Remote Agent response did not complete successfully");
  }

  const evidence = extractResponseEvidence(parsedBody);
  const assertions = evaluateExpectations({
    testCase: task.testCase,
    functionCalls: evidence.functionCalls,
    functionOutputs: evidence.functionOutputs,
    assistantText: evidence.assistantText,
    writeToolPatterns: settings.writeToolPatterns,
  });
  result.assertions = assertions;
  result.response = {
    http_status: Number(response?.status ?? 0),
    response_id: parsedBody.id ?? null,
    response_status: parsedBody.status ?? null,
    assistant_text: evidence.assistantText,
    function_calls: evidence.functionCalls,
    function_call_outputs: evidence.functionOutputs,
    usage: parsedBody.usage ?? null,
  };
  const failedAssertions = assertions.filter((assertion) => !assertion.pass);
  if (failedAssertions.length > 0) {
    return finish("FAIL", `${failedAssertions.length} hard assertion(s) failed`);
  }
  if (result.retry_events.length > 0) {
    return finish("FLAKY", "Hard assertions passed after one or more bounded read retries");
  }
  if (mode === "mock" && task.evidenceClass === "OFFLINE_FAULT_INJECTION_CONTRACT") {
    return finish(
      "PASS_OFFLINE_CONTRACT",
      "Offline fault-injection contract assertions passed; this is not live Agent2 or Provider evidence",
    );
  }
  return finish("PASS", "All hard assertions passed on the first attempt");
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async use(operation) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class RollingCallBudget {
  constructor({ limit, windowMs, now, sleep }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.reservations = [];
  }

  async reserve(cost) {
    let waitedMs = 0;
    if (cost === 0) {
      return {
        cost,
        limit: this.limit,
        window_ms: this.windowMs,
        reserved_at_ms: this.now(),
        used_after: this.reservations.reduce((sum, reservation) => sum + reservation.cost, 0),
        waited_ms: waitedMs,
      };
    }
    while (true) {
      const nowMs = this.now();
      this.reservations = this.reservations.filter(
        (reservation) => reservation.at + this.windowMs > nowMs,
      );
      const used = this.reservations.reduce((sum, reservation) => sum + reservation.cost, 0);
      if (used + cost <= this.limit) {
        this.reservations.push({ at: nowMs, cost });
        return {
          cost,
          limit: this.limit,
          window_ms: this.windowMs,
          reserved_at_ms: nowMs,
          used_after: used + cost,
          waited_ms: waitedMs,
        };
      }
      const oldest = this.reservations[0];
      if (!oldest) throw new Error("Xero call budget could not locate its oldest reservation");
      const delayMs = Math.max(1, oldest.at + this.windowMs - nowMs);
      waitedMs += delayMs;
      await this.sleep(delayMs);
    }
  }
}

function expandTasks(manifest, mode, env) {
  const defaultRepeats = asInteger(manifest.settings?.repeats, 1, 1, 10);
  const agents = manifest.agents.map((agent) => resolveAgent(agent, mode, env));
  const agentByAlias = new Map(agents.map((agent) => [agent.alias, agent]));
  const tasks = [];
  for (const testCase of manifest.cases) {
    const aliases = testCase.agents ?? agents.map((agent) => agent.alias);
    const repeatCount = asInteger(testCase.repeats, defaultRepeats, 1, 10);
    for (const alias of aliases) {
      const agent = agentByAlias.get(alias);
      for (let repeatIndex = 1; repeatIndex <= repeatCount; repeatIndex += 1) {
        tasks.push({
          index: tasks.length,
          resultId:
            repeatCount === 1
              ? `${testCase.id}::${alias}`
              : `${testCase.id}::${alias}::repeat-${repeatIndex}-of-${repeatCount}`,
          testCase,
          evidenceClass: manifest.evidenceClass,
          agent,
          repeatIndex,
          repeatCount,
        });
      }
    }
  }
  return tasks;
}

function makeToolReceipts(result) {
  if (!result.response) {
    return [];
  }
  const calls = result.response.function_calls ?? [];
  const outputs = result.response.function_call_outputs ?? [];
  const callsById = new Map(calls.map((call) => [call.call_id, call]));
  const outputsById = new Map(outputs.map((output) => [output.call_id, output]));
  const ids = [...new Set([...callsById.keys(), ...outputsById.keys()])];
  return ids.map((callId, index) => {
    const call = callsById.get(callId) ?? null;
    const output = outputsById.get(callId) ?? null;
    let parsedArguments = null;
    if (typeof call?.arguments === "string" && call.arguments !== "") {
      try {
        parsedArguments = JSON.parse(call.arguments);
      } catch {
        parsedArguments = null;
      }
    }
    return {
      run_id: result.run_id,
      result_id: result.result_id,
      sequence: index,
      case_id: result.case_id,
      operation: result.operation,
      repeatIndex: result.repeatIndex,
      repeatCount: result.repeatCount,
      agent_alias: result.agent.alias,
      agent_id: result.agent.id,
      response_id: result.response.response_id ?? null,
      call_id: callId,
      function_call: call,
      parsed_arguments: parsedArguments,
      function_call_output: output,
      output_status: output ? "captured" : "missing",
    };
  });
}

function serializeJsonLines(values) {
  return values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildSummary({ runId, mode, manifest, candidateVersion, settings, startedAt, completedAt, results, receipts }) {
  const counts = new Map(VERDICTS.map((verdict) => [verdict, 0]));
  for (const result of results) {
    counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  }
  const reservedXeroCalls = results.reduce(
    (sum, result) =>
      sum + result.rate_budget_reservations.reduce((inner, reservation) => inner + reservation.cost, 0),
    0,
  );
  const plannedFirstAttemptXeroCalls = results.reduce(
    (sum, result) => sum + (result.request.estimated_xero_calls ?? 0),
    0,
  );
  const lines = [
    "# Agent2 Remote Agents behavior harness summary",
    "",
    `- Run: \`${runId}\``,
    `- Mode: \`${mode}\``,
    `- Manifest: ${manifest.name}`,
    `- Evidence class: \`${manifest.evidenceClass ?? "LEGACY_UNCLASSIFIED"}\``,
    `- Local candidate package version: ${candidateVersion ?? "UNAVAILABLE"}`,
    `- Started: ${startedAt}`,
    `- Completed: ${completedAt}`,
    `- Global concurrency: ${settings.concurrency}`,
    `- Reserved Xero call budget: ${settings.xeroCallsPerMinuteBudget ?? "disabled"} per rolling minute`,
    `- Planned worst-case Xero calls for one attempt per task: ${plannedFirstAttemptXeroCalls}`,
    `- Total worst-case Xero calls reserved across actual Remote Agent attempts: ${reservedXeroCalls}`,
    `- Behavioral samples per case: ${settings.repeats} by default; case overrides are recorded per result`,
    "- Write concurrency: 1; write requests are never automatically retried",
    "- Conversation state: every request contains the complete transcript with `store:false`",
    "",
    "## Verdict counts",
    "",
    "| Verdict | Count |",
    "|---|---:|",
    ...VERDICTS.map((verdict) => `| ${verdict} | ${counts.get(verdict)} |`),
    "",
    "## Results",
    "",
    "| Case | Agent / persona | Sample | Operation | Attempts | Verdict | Reason |",
    "|---|---|---:|---|---:|---|---|",
    ...results.map(
      (result) =>
        `| ${markdownCell(result.case_id)} | ${markdownCell(result.agent.alias)} / ${markdownCell(result.agent.persona)} | ${result.repeatIndex}/${result.repeatCount} | ${result.operation} | ${result.attempts} | ${result.verdict} | ${markdownCell(result.reason)} |`,
    ),
    "",
    "## Evidence",
    "",
    `- [Per-invocation results](./agent-results.jsonl): ${results.length} record(s)` ,
    `- [Function call receipts](./tool-receipts.jsonl): ${receipts.length} record(s)`,
    "",
    "Captured Agent2 function-call counts do not prove Provider request counts. Provider zero/one/create-once requires server audit, Provider trace, and Xero object-count evidence at live Gate W.",
    "",
    "A `PASS` requires live/legacy hard assertions to pass; HTTP 200 alone is never counted as a pass. `PASS_OFFLINE_CONTRACT` proves only an offline fault-injection oracle and is never live Agent2, MCP, OAuth, tenant, or Provider evidence. A `FLAKY` result passed only after bounded read retry. Blocked, unsupported, skipped, and flaky results are not silently converted to passes.",
    "",
  ];
  return lines.join("\n");
}

function defaultRunId(nowMs = Date.now()) {
  return `${new Date(nowMs).toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function validateRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("runId must contain only letters, numbers, dots, underscores, and hyphens");
  }
}

function makeMockResponse(spec) {
  const status = Number(spec?.status ?? 200);
  const headers = new Map(
    Object.entries(spec?.headers ?? {}).map(([key, value]) => [key.toLocaleLowerCase(), String(value)]),
  );
  const body = spec?.body ?? {};
  return {
    status,
    headers: { get: (name) => headers.get(name.toLocaleLowerCase()) ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function makeTraceMockResponse(task, response) {
  const output = response.toolCalls.flatMap((call, index) => {
    const callId = `call_${task.index}_${index}`;
    return [
      {
        type: "function_call",
        id: `fc_${task.index}_${index}`,
        call_id: callId,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        status: "completed",
      },
      {
        type: "function_call_output",
        id: `fco_${task.index}_${index}`,
        call_id: callId,
        output: JSON.stringify(call.output),
        status: "completed",
      },
    ];
  });
  output.push({
    type: "message",
    id: `msg_${task.index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: response.assistantText }],
  });
  return makeMockResponse({
    status: 200,
    body: {
      id: `resp_${task.index}`,
      object: "response",
      status: "completed",
      output,
    },
  });
}

export function createManifestMockTransport({ onRequest } = {}) {
  const attempts = new Map();
  return async ({ task, attempt, requestBody }) => {
    await onRequest?.({ task, attempt, requestBody });
    const key = task.resultId;
    if (task.testCase.mock?.response) {
      return makeTraceMockResponse(task, task.testCase.mock.response);
    }
    const sequence = task.testCase.mock?.byAgent?.[task.agent.alias] ?? task.testCase.mock?.sequence;
    if (!Array.isArray(sequence) || sequence.length === 0) {
      throw new Error(`Mock mode requires ${task.testCase.id}.mock.sequence or mock.byAgent.${task.agent.alias}`);
    }
    const index = attempts.get(key) ?? 0;
    attempts.set(key, index + 1);
    return makeMockResponse(sequence[Math.min(index, sequence.length - 1)]);
  };
}

function createLiveTransportFromEnv(env, fetchImpl) {
  const endpointValue = env.AGENT2_REMOTE_AGENTS_URL;
  const apiKey = env.AGENT2_REMOTE_AGENTS_API_KEY;
  assertNonEmptyString(endpointValue, "AGENT2_REMOTE_AGENTS_URL");
  assertNonEmptyString(apiKey, "AGENT2_REMOTE_AGENTS_API_KEY");
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "https:") {
    throw new Error("AGENT2_REMOTE_AGENTS_URL must use HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("AGENT2_REMOTE_AGENTS_URL must not contain credentials, query parameters, or fragments");
  }
  const transport = async ({ requestBody, signal }) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "zcloak-xero-remote-agent-harness/1",
      },
      body: JSON.stringify(requestBody),
      signal,
      redirect: "error",
      cache: "no-store",
    });
  return {
    transport,
    secrets: [apiKey],
    endpointLabel: endpoint.toString(),
  };
}

export async function runHarness({
  manifestPath,
  mode = "dry-run",
  outputDir,
  runId,
  allowWrite = false,
  env = process.env,
  transport: suppliedTransport,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = () => Date.now(),
  random = Math.random,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!new Set(["dry-run", "mock", "live"]).has(mode)) {
    throw new Error("mode must be dry-run, mock, or live");
  }
  assertNonEmptyString(manifestPath, "manifestPath");
  const loaded = await loadManifest(manifestPath);
  if (loaded.manifest.evidenceClass === "OFFLINE_FAULT_INJECTION_CONTRACT" && mode === "live") {
    throw new Error("OFFLINE_FAULT_INJECTION_CONTRACT manifests cannot run in live mode");
  }
  if (loaded.manifest.evidenceClass === "LIVE_AGENT2_ACCEPTANCE" && mode === "mock") {
    throw new Error("LIVE_AGENT2_ACCEPTANCE manifests cannot run in mock mode");
  }
  const candidateVersion = await loadRepositoryPackageVersion();
  const settings = normalizedSettings(loaded.manifest.settings);
  const effectiveRunId = runId ?? defaultRunId(now());
  validateRunId(effectiveRunId);
  const effectiveOutputDir = path.resolve(
    outputDir ?? path.join(REPOSITORY_ROOT, "artifacts", "harness-runs", effectiveRunId),
  );
  await mkdir(effectiveOutputDir, { recursive: true });

  let transport = suppliedTransport;
  let secrets = [];
  let endpointLabel = null;
  if (mode === "mock" && !transport) {
    transport = createManifestMockTransport();
  } else if (mode === "live" && !transport) {
    const live = createLiveTransportFromEnv(env, fetchImpl);
    transport = live.transport;
    secrets = live.secrets;
    endpointLabel = live.endpointLabel;
  }
  if (mode !== "dry-run" && typeof transport !== "function") {
    throw new Error(`${mode} mode requires a request transport`);
  }

  const tasks = expandTasks(loaded.manifest, mode, env);
  const startedAt = new Date(now()).toISOString();
  const globalSemaphore = new Semaphore(settings.concurrency);
  const writeSemaphore = new Semaphore(1);
  const xeroCallBudget =
    mode === "live" && settings.xeroCallsPerMinuteBudget !== null
      ? new RollingCallBudget({
          limit: settings.xeroCallsPerMinuteBudget,
          windowMs: 60_000,
          now,
          sleep,
        })
      : null;
  const pending = tasks.map((task) => {
    const operation = () =>
      globalSemaphore.use(async () => {
        return executeTask({
            task,
            runId: effectiveRunId,
            manifestDir: loaded.manifestDir,
            settings,
            mode,
            allowWrite,
            transport,
            sleep,
            now,
            random,
            secrets,
            reserveXeroCalls: xeroCallBudget
              ? (cost) => xeroCallBudget.reserve(cost)
              : null,
          });
      });
    return task.testCase.operation === "write" ? writeSemaphore.use(operation) : operation();
  });
  const results = (await Promise.all(pending)).sort((left, right) => left.task_index - right.task_index);
  const receipts = results.flatMap(makeToolReceipts);
  const completedAt = new Date(now()).toISOString();
  const summary = buildSummary({
    runId: effectiveRunId,
    mode,
    manifest: loaded.manifest,
    candidateVersion,
    settings,
    startedAt,
    completedAt,
    results,
    receipts,
  });
  const safeResults = sanitizeForArtifacts(results, secrets);
  const safeReceipts = sanitizeForArtifacts(receipts, secrets);
  const safeRunManifest = sanitizeForArtifacts(
    {
      run_id: effectiveRunId,
      mode,
      manifest_name: loaded.manifest.name,
      evidence_class: loaded.manifest.evidenceClass ?? "LEGACY_UNCLASSIFIED",
      repository_package_version: candidateVersion,
      manifest_path: path.relative(process.cwd(), loaded.manifestPath),
      manifest_sha256: loaded.manifestSha256,
      endpoint: endpointLabel,
      settings,
      started_at: startedAt,
      completed_at: completedAt,
    },
    secrets,
  );
  await Promise.all([
    writeFile(path.join(effectiveOutputDir, "agent-results.jsonl"), serializeJsonLines(safeResults), "utf8"),
    writeFile(path.join(effectiveOutputDir, "tool-receipts.jsonl"), serializeJsonLines(safeReceipts), "utf8"),
    writeFile(path.join(effectiveOutputDir, "summary.md"), redactString(summary, secrets), "utf8"),
    writeFile(
      path.join(effectiveOutputDir, "run-manifest.json"),
      `${JSON.stringify(safeRunManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return {
    runId: effectiveRunId,
    outputDir: effectiveOutputDir,
    results: safeResults,
    receipts: safeReceipts,
    summary,
  };
}
