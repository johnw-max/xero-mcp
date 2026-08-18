import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createManifestMockTransport,
  evaluateExpectations,
  loadManifest,
  parseRetryAfter,
  RollingCallBudget,
  runHarness,
  validateManifest,
} from "./lib/runner-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const readOnlyManifest = path.join(here, "manifests", "mock-readonly.json");
const writeNoRetryManifest = path.join(here, "manifests", "mock-write-no-retry.json");
const rateBudgetManifest = path.join(here, "manifests", "test-rate-budget.json");
const productionReadOnlyManifest = path.join(
  here,
  "manifests",
  "agent2-production-current-readonly-2026-08-06.json",
);
const negativeLiveManifest = path.join(
  here,
  "manifests",
  "agent2-xero-v040rc-negative-acceptance.template.json",
);
const negativeOfflineManifest = path.join(
  here,
  "manifests",
  "mock-v040rc-negative-contract.json",
);

async function withTempDirectory(prefix, operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function responseFrom({ status = 200, headers = {}, body = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLocaleLowerCase(), String(value)]),
  );
  return {
    status,
    headers: { get: (name) => normalizedHeaders.get(name.toLocaleLowerCase()) ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function successfulRateBudgetBody(extraOutput = {}) {
  return {
    id: "resp_rate_budget",
    object: "response",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: "fc_rate_budget",
        call_id: "call_rate_budget",
        name: "accounting__xero_prepare_supplier_bill_draft",
        arguments: "{\"supplier_name\":\"Brown Office Supplies\"}",
        status: "completed",
      },
      {
        type: "function_call_output",
        id: "fco_rate_budget",
        call_id: "call_rate_budget",
        output: JSON.stringify({ ok: true, ...extraOutput }),
        status: "completed",
      },
      {
        type: "message",
        id: "msg_rate_budget",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `Offline success ${extraOutput.echo ?? ""}` }],
      },
    ],
  };
}

test("dry-run validates and writes NOT_RUN evidence without invoking any transport", async () => {
  await withTempDirectory("xero-agent2-dry-", async (outputDir) => {
    let calls = 0;
    const result = await runHarness({
      manifestPath: readOnlyManifest,
      mode: "dry-run",
      outputDir,
      runId: "test-dry-run",
      transport: async () => {
        calls += 1;
        throw new Error("dry-run must not call transport");
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.results.length, 6);
    assert.deepEqual(new Set(result.results.map((item) => item.verdict)), new Set(["NOT_RUN"]));
    assert.deepEqual(
      result.results.map((item) => [item.case_id, item.repeatIndex, item.repeatCount]),
      [
        ["supplier-history-after-429", 1, 1],
        ["supplier-history-after-429", 1, 1],
        ["supplier-contact-first-attempt", 1, 2],
        ["supplier-contact-first-attempt", 2, 2],
        ["supplier-contact-first-attempt", 1, 2],
        ["supplier-contact-first-attempt", 2, 2],
      ],
    );
    assert.equal(result.receipts.length, 0);
    const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
    assert.match(summary, /Mode: `dry-run`/);
    assert.match(summary, /\| NOT_RUN \| 6 \|/);
  });
});

test("production dry-run enumerates exactly 33 independent Agent/case samples without transport", async () => {
  await withTempDirectory("xero-agent2-production-plan-", async (outputDir) => {
    let calls = 0;
    const result = await runHarness({
      manifestPath: productionReadOnlyManifest,
      mode: "dry-run",
      outputDir,
      runId: "test-production-plan",
      transport: async () => {
        calls += 1;
        throw new Error("production dry-run must not call transport");
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.results.length, 33);
    assert.deepEqual(
      Object.fromEntries(
        [...new Set(result.results.map((item) => item.case_id))].map((caseId) => [
          caseId,
          result.results.filter((item) => item.case_id === caseId).length,
        ]),
      ),
      {
        "current-organisation-supplier-exact-history": 6,
        "current-trial-balance-evidence-limits": 6,
        "current-clean-prepare-only": 6,
        "current-material-prompt-injection": 6,
        "current-unsupported-high-risk-refusal": 9,
      },
    );
    assert.ok(result.results.every((item) => item.verdict === "NOT_RUN"));
    assert.ok(result.results.every((item) => item.rate_budget_reservations.length === 0));
    const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
    assert.match(summary, /Planned worst-case Xero calls for one attempt per task: 111/);
    assert.match(summary, /actual Remote Agent attempts: 0/);
  });
});

test("current negative live plan enumerates twelve NOT_RUN cases without transport", async () => {
  await withTempDirectory("xero-agent2-negative-live-plan-", async (outputDir) => {
    let calls = 0;
    const result = await runHarness({
      manifestPath: negativeLiveManifest,
      mode: "dry-run",
      outputDir,
      runId: "test-negative-live-plan",
      transport: async () => {
        calls += 1;
        throw new Error("negative live dry-run must not call transport");
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.results.length, 12);
    assert.ok(result.results.every((item) => item.verdict === "NOT_RUN"));
    assert.ok(result.results.every((item) => item.attempts === 0));
    assert.ok(result.results.every((item) => item.evidence_class === "LIVE_AGENT2_ACCEPTANCE"));
    const runManifest = JSON.parse(await readFile(path.join(outputDir, "run-manifest.json"), "utf8"));
    assert.equal(runManifest.evidence_class, "LIVE_AGENT2_ACCEPTANCE");
  });
});

test("offline negative contract passes twelve linked traces without becoming live evidence", async () => {
  await withTempDirectory("xero-agent2-negative-offline-", async (outputDir) => {
    const result = await runHarness({
      manifestPath: negativeOfflineManifest,
      mode: "mock",
      outputDir,
      runId: "test-negative-offline-contract",
    });

    assert.equal(result.results.length, 12);
    assert.ok(result.results.every((item) => item.verdict === "PASS_OFFLINE_CONTRACT"));
    assert.ok(result.results.every((item) => item.attempts === 1));
    assert.ok(result.results.every((item) => item.evidence_class === "OFFLINE_FAULT_INJECTION_CONTRACT"));
    assert.equal(result.receipts.length, 14);
    assert.ok(result.receipts.every((receipt) => receipt.output_status === "captured"));
    assert.ok(result.receipts.every((receipt) => receipt.function_call?.call_id === receipt.function_call_output?.call_id));

    const calls = result.results.flatMap((item) => item.response.function_calls);
    assert.equal(calls.filter((call) => call.name.endsWith("xero_prepare_accounting_case")).length, 4);
    assert.equal(calls.filter((call) => call.name.endsWith("xero_execute_accounting_case")).length, 7);
    assert.equal(calls.filter((call) => call.name.endsWith("xero_get_accounting_case_status")).length, 3);
    for (const caseId of ["offline-negative-write-uncertain", "offline-negative-readback-recovery-once"]) {
      const item = result.results.find((candidate) => candidate.case_id === caseId);
      assert.equal(item.response.function_calls.filter((call) => call.name.endsWith("xero_execute_accounting_case")).length, 1);
    }

    const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
    assert.match(summary, /PASS_OFFLINE_CONTRACT/);
    assert.match(summary, /never live Agent2, MCP, OAuth, tenant, or Provider evidence/);
    assert.match(summary, /do not prove Provider request counts/);
  });
});

test("table-driven denial oracles reject altered safe layer, reason, or mutation possibility", async () => {
  const { manifest } = await loadManifest(negativeOfflineManifest);
  const denialCases = manifest.cases.filter((item) => [
    "offline-negative-mcp-scope",
    "offline-negative-connection",
    "offline-negative-provider-access",
    "offline-negative-wrong-tenant",
    "offline-negative-kill-switch",
  ].includes(item.id));

  const oraclePasses = (testCase, output) => {
    const call = testCase.mock.response.toolCalls[0];
    const assertions = evaluateExpectations({
      testCase,
      functionCalls: [{ call_id: "denial-call", name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" }],
      functionOutputs: [{ call_id: "denial-call", output: JSON.stringify(output), status: "completed" }],
      assistantText: testCase.mock.response.assistantText,
      writeToolPatterns: [],
    });
    return assertions.find((item) => item.name.startsWith("required_tool_call_json:"))?.pass;
  };

  assert.equal(denialCases.length, 5);
  for (const testCase of denialCases) {
    const original = testCase.mock.response.toolCalls[0].output;
    assert.equal(oraclePasses(testCase, original), true, `${testCase.id} baseline`);
    assert.equal(oraclePasses(testCase, { error: { ...original.error, failure_layer: "WRONG_LAYER" } }), false, `${testCase.id} layer`);
    assert.equal(oraclePasses(testCase, { error: { ...original.error, reason_codes: ["WRONG_REASON"] } }), false, `${testCase.id} reason`);
    assert.equal(oraclePasses(testCase, { error: { ...original.error, provider_mutation_possible: true } }), false, `${testCase.id} mutation flag`);
  }
});

test("evidence classes cannot be promoted by choosing the wrong runner mode", async () => {
  await withTempDirectory("xero-agent2-evidence-class-", async (outputDir) => {
    await assert.rejects(
      runHarness({ manifestPath: negativeOfflineManifest, mode: "live", outputDir }),
      /cannot run in live mode/,
    );
    await assert.rejects(
      runHarness({ manifestPath: negativeLiveManifest, mode: "mock", outputDir }),
      /cannot run in mock mode/,
    );
  });
});

test("mock run keeps complete stateless transcripts, enforces concurrency, retries reads, and captures tool receipts", async () => {
  await withTempDirectory("xero-agent2-mock-", async (outputDir) => {
    const requests = [];
    let active = 0;
    let peakActive = 0;
    const baseTransport = createManifestMockTransport({
      onRequest: ({ task, attempt, requestBody }) => {
        requests.push({ task: task.resultId, attempt, requestBody });
      },
    });
    const transport = async (request) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await baseTransport(request);
      } finally {
        active -= 1;
      }
    };
    const result = await runHarness({
      manifestPath: readOnlyManifest,
      mode: "mock",
      outputDir,
      runId: "test-mock-run",
      transport,
      sleep: async () => {},
      random: () => 0.5,
      env: {
        AGENT2_REMOTE_AGENTS_API_KEY: "must-never-appear-in-an-artifact",
      },
    });

    assert.equal(requests.length, 8);
    assert.equal(new Set(requests.map((request) => request.task)).size, 6);
    assert.ok(requests.some((request) => request.task.endsWith("repeat-1-of-2")));
    assert.ok(requests.some((request) => request.task.endsWith("repeat-2-of-2")));
    assert.ok(
      requests.some((request) =>
        request.requestBody.input[0].content.includes("Independent behavioral sample: 1/2"),
      ),
    );
    assert.ok(
      requests.some((request) =>
        request.requestBody.input[0].content.includes("Independent behavioral sample: 2/2"),
      ),
    );
    assert.equal(peakActive, 2);
    assert.ok(peakActive <= 2);
    for (const request of requests) {
      assert.equal(request.requestBody.store, false);
      assert.equal(request.requestBody.stream, false);
      assert.equal(Object.hasOwn(request.requestBody, "previous_response_id"), false);
      assert.ok(Array.isArray(request.requestBody.input));
      assert.equal(request.requestBody.input.length, 3);
      assert.match(request.requestBody.input[0].content, /at most 1 total MCP tool call/);
      assert.ok(request.requestBody.input.every((item) => typeof item.content === "string"));
      assert.ok(request.requestBody.input.every((item) => item.content.includes("[File:") === false));
      assert.match(request.requestBody.input.map((item) => item.content).join("\n"), /SYNTHETIC TEST MATERIAL/);
    }

    assert.equal(result.results.filter((item) => item.verdict === "FLAKY").length, 2);
    assert.equal(result.results.filter((item) => item.verdict === "PASS").length, 4);
    assert.equal(result.receipts.length, 6);
    assert.equal(new Set(result.results.map((item) => item.result_id)).size, 6);
    assert.ok(result.results.every((item) => Number.isInteger(item.repeatIndex)));
    assert.ok(result.results.every((item) => Number.isInteger(item.repeatCount)));
    assert.ok(
      result.receipts.every(
        (receipt) => Number.isInteger(receipt.repeatIndex) && Number.isInteger(receipt.repeatCount),
      ),
    );
    assert.ok(result.receipts.every((receipt) => receipt.function_call));
    assert.ok(result.receipts.every((receipt) => receipt.function_call_output));
    assert.ok(result.receipts.every((receipt) => receipt.output_status === "captured"));

    const resultArtifact = await readFile(path.join(outputDir, "agent-results.jsonl"), "utf8");
    const receiptArtifact = await readFile(path.join(outputDir, "tool-receipts.jsonl"), "utf8");
    const summaryArtifact = await readFile(path.join(outputDir, "summary.md"), "utf8");
    const combinedArtifacts = `${resultArtifact}\n${receiptArtifact}\n${summaryArtifact}`;
    assert.doesNotMatch(combinedArtifacts, /must-never-appear-in-an-artifact/);
    assert.match(receiptArtifact, /function_call_output/);
    assert.match(summaryArtifact, /HTTP 200 alone is never counted as a pass/);
  });
});

test("Open Responses evidence rejects malformed arguments, duplicate outputs, and mislinked required output", () => {
  const functionCalls = [
    {
      call_id: "call_a",
      name: "accounting__xero_list_payments",
      arguments: "not-json",
      status: "completed",
    },
    {
      call_id: "call_b",
      name: "accounting__xero_list_payments",
      arguments: "{\"type\":\"APCREDITPAYMENT\"}",
      status: "completed",
    },
  ];
  const functionOutputs = [
    { call_id: "call_a", output: "{\"payments\":[],\"marker\":\"expected-b\"}", status: "completed" },
    { call_id: "call_a", output: "{\"payments\":[]}", status: "completed" },
    { call_id: "call_b", output: "{\"payments\":[],\"marker\":\"wrong-b\"}", status: "completed" },
  ];
  const assertions = evaluateExpectations({
    testCase: {
      operation: "read",
      expect: {
        requiredToolCalls: [
          {
            tool: "*xero_list_payments",
            arguments: ["APCREDITPAYMENT"],
            output: ["expected-b"],
          },
        ],
        allCallsHaveOutput: true,
      },
    },
    functionCalls,
    functionOutputs,
    assistantText: "",
    writeToolPatterns: [],
  });
  const byName = new Map(assertions.map((assertion) => [assertion.name, assertion]));

  assert.equal(byName.get("open_responses_function_call_arguments_json_object")?.pass, false);
  assert.equal(byName.get("open_responses_unique_output_call_ids")?.pass, false);
  assert.equal(byName.get("all_calls_have_output")?.pass, false);
  assert.equal(byName.get("required_tool_call:0:*xero_list_payments")?.pass, false);
});

test("structured tool-output oracles reject a contact-only Accounting Case false green", () => {
  const functionCalls = [{
    call_id: "case_execute",
    name: "accounting__xero_execute_accounting_case",
    arguments: JSON.stringify({ case_id: "golden-14", case_version: 1, request_id: "run-1" }),
    status: "completed",
  }];
  const expectedActions = [
    "customer_invoice.create_draft",
    "supplier_bill.create_draft",
    "supplier_bill.create_draft",
    "credit_note.create_draft",
    "credit_note.create_draft",
  ];
  const expectation = {
    requiredToolCallJson: [{
      tool: "*xero_execute_accounting_case",
      assertions: [
        { path: "$.operations", length: 5 },
        { path: "$.operations[*].action_id", multiset: expectedActions },
        { path: "$.operations[*].state", everyEquals: "READBACK_VERIFIED" },
        { path: "$.operations[*].xero_object_id", everyPresent: true },
        { path: "$.completion_claim.ledger_write_claim", equals: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
      ],
    }],
  };
  const evaluated = (body) => evaluateExpectations({
    testCase: { operation: "write", expect: expectation },
    functionCalls,
    functionOutputs: [{
      call_id: "case_execute",
      output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body) }] }),
      status: "completed",
    }],
    assistantText: "",
    writeToolPatterns: [],
  }).find((assertion) => assertion.name.startsWith("required_tool_call_json:"));

  const documents = expectedActions.map((action_id, index) => ({
    action_id,
    state: "READBACK_VERIFIED",
    xero_object_id: `xero-document-${index + 1}`,
  }));
  assert.equal(evaluated({
    operations: documents,
    completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
  })?.pass, true);
  assert.equal(evaluated({
    operations: [{ action_id: "contact.create_basic", state: "READBACK_VERIFIED", xero_object_id: "contact-1" }],
    completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
  })?.pass, false);
});

test("exact tool-call counts reject a second Accounting Case execute", () => {
  const expectation = {
    exactToolCallCounts: [{ tool: "*xero_execute_accounting_case", count: 1 }],
  };
  const executeCall = (call_id) => ({
    call_id,
    name: "accounting__xero_execute_accounting_case",
    arguments: JSON.stringify({ case_id: "golden-14", case_version: 1, request_id: "run-1" }),
    status: "completed",
  });
  const evaluated = (functionCalls) => evaluateExpectations({
    testCase: { operation: "write", expect: expectation },
    functionCalls,
    functionOutputs: [],
    assistantText: "",
    writeToolPatterns: [],
  }).find((assertion) => assertion.name.startsWith("exact_tool_call_count:"));

  assert.equal(evaluated([executeCall("execute-1")])?.pass, true);
  assert.equal(evaluated([executeCall("execute-1"), executeCall("execute-2")])?.pass, false);
});

test("every live read retry makes a fresh rolling Xero-call reservation", async () => {
  await withTempDirectory("xero-agent2-rate-retry-", async (outputDir) => {
    let attempts = 0;
    let nowMs = 0;
    const sleeps = [];
    const result = await runHarness({
      manifestPath: rateBudgetManifest,
      mode: "live",
      outputDir,
      runId: "test-rate-retry",
      transport: async () => {
        attempts += 1;
        if (attempts === 1) {
          return responseFrom({ status: 429, headers: { "Retry-After": "0" }, body: { error: "retry" } });
        }
        return responseFrom({ body: successfulRateBudgetBody() });
      },
      now: () => nowMs,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        nowMs += delayMs;
      },
      random: () => 0.5,
    });

    assert.equal(attempts, 2);
    assert.equal(result.results[0].verdict, "FLAKY");
    assert.deepEqual(result.results[0].rate_budget_reservations.map((item) => item.cost), [3, 3]);
    assert.deepEqual(result.results[0].rate_budget_reservations.map((item) => item.attempt), [1, 2]);
    assert.equal(result.results[0].rate_budget_reservations[1].waited_ms, 60_000);
    assert.ok(sleeps.includes(60_000));
    const summary = await readFile(path.join(outputDir, "summary.md"), "utf8");
    assert.match(summary, /Total worst-case Xero calls reserved across actual Remote Agent attempts: 6/);
  });
});

test("live transport API key echoes are redacted from every artifact", async () => {
  await withTempDirectory("xero-agent2-live-redaction-", async (outputDir) => {
    const fakeApiKey = "agent2-test-secret-never-store";
    let authorization = null;
    const result = await runHarness({
      manifestPath: rateBudgetManifest,
      mode: "live",
      outputDir,
      runId: "test-live-redaction",
      env: {
        AGENT2_REMOTE_AGENTS_URL: "https://agent2.example.test/api/agents/v1/responses",
        AGENT2_REMOTE_AGENTS_API_KEY: fakeApiKey,
      },
      fetchImpl: async (_url, options) => {
        authorization = options.headers.authorization;
        return responseFrom({ body: successfulRateBudgetBody({ echo: fakeApiKey }) });
      },
    });

    assert.equal(authorization, `Bearer ${fakeApiKey}`);
    assert.equal(result.results[0].verdict, "PASS");
    const artifacts = await Promise.all(
      ["agent-results.jsonl", "tool-receipts.jsonl", "summary.md", "run-manifest.json"].map((name) =>
        readFile(path.join(outputDir, name), "utf8"),
      ),
    );
    const combined = artifacts.join("\n");
    assert.doesNotMatch(combined, new RegExp(fakeApiKey));
    assert.match(combined, /\[REDACTED\]/);
  });
});

test("write-intent failure is attempted once even when a later mock response would succeed", async () => {
  await withTempDirectory("xero-agent2-write-", async (outputDir) => {
    let requests = 0;
    const baseTransport = createManifestMockTransport({
      onRequest: () => {
        requests += 1;
      },
    });
    const result = await runHarness({
      manifestPath: writeNoRetryManifest,
      mode: "mock",
      outputDir,
      runId: "test-write-no-retry",
      transport: baseTransport,
      sleep: async () => {
        throw new Error("write request must not enter retry sleep");
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].attempts, 1);
    assert.equal(result.results[0].repeatIndex, 1);
    assert.equal(result.results[0].repeatCount, 1);
    assert.equal(result.results[0].verdict, "BLOCKED_MODEL_PROVIDER");
    assert.match(result.results[0].reason, /was not retried/);
    assert.equal(result.receipts.length, 0);
  });
});

test("Retry-After supports seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("1.25", 0), 1250);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
  assert.equal(parseRetryAfter("not-a-date", 0), null);
});

test("manifest validation rejects embedded API credentials", () => {
  assert.throws(
    () =>
      validateManifest({
        version: 1,
        name: "bad",
        apiKey: "do-not-store-this",
        agents: [],
        cases: [],
      }),
    /API key must only come from AGENT2_REMOTE_AGENTS_API_KEY/,
  );
});

test("manifest validation caps default and case sampling at ten repeats", () => {
  const validBase = {
    version: 1,
    name: "repeat-validation",
    agents: [{ alias: "a", id: "agent-a", persona: "Read-only accountant" }],
    cases: [
      {
        id: "c",
        title: "case",
        operation: "read",
        fixture: "fixture.txt",
        transcript: [{ role: "user", content: "{{fixture}}" }],
        expect: { maxToolCalls: 0 },
      },
    ],
  };
  assert.throws(() => validateManifest({ ...validBase, settings: { repeats: 11 } }), /1 to 10/);
  assert.throws(
    () =>
      validateManifest({
        ...validBase,
        cases: [{ ...validBase.cases[0], repeats: 0 }],
      }),
    /1 to 10/,
  );
});

test("rolling Xero call budget reserves a bounded minute window", async () => {
  let nowMs = 0;
  const sleeps = [];
  const budget = new RollingCallBudget({
    limit: 3,
    windowMs: 60_000,
    now: () => nowMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
  });

  await budget.reserve(2);
  await budget.reserve(1);
  await budget.reserve(2);

  assert.deepEqual(sleeps, [60_000]);
  assert.equal(nowMs, 60_000);
});

test("rate-limited manifests require a declared call estimate for every case", () => {
  const manifest = {
    version: 1,
    name: "rate-budget-validation",
    settings: { xeroCallsPerMinuteBudget: 40 },
    agents: [{ alias: "a", id: "agent-a", persona: "Read-only accountant" }],
    cases: [
      {
        id: "c",
        title: "case",
        operation: "read",
        fixture: "fixture.txt",
        transcript: [{ role: "user", content: "{{fixture}}" }],
        expect: { maxToolCalls: 0 },
      },
    ],
  };
  assert.throws(() => validateManifest(manifest), /estimatedXeroCalls is required/);
  manifest.cases[0].estimatedXeroCalls = 41;
  assert.throws(() => validateManifest(manifest), /cannot exceed the per-minute Xero call budget/);
  manifest.cases[0].estimatedXeroCalls = 1;
  delete manifest.cases[0].expect.maxToolCalls;
  manifest.cases[0].expect.requiredAssistantText = ["bounded"];
  assert.throws(() => validateManifest(manifest), /expect.maxToolCalls is required/);
  manifest.cases[0].expect.maxToolCalls = 2;
  assert.throws(() => validateManifest(manifest), /cannot be lower than expect.maxToolCalls/);
  manifest.cases[0].estimatedXeroCalls = 3;
  assert.doesNotThrow(() => validateManifest(manifest));
});
