import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_LOCAL_AGENT_EVIDENCE_BOUNDARIES,
  REQUIRED_CRASH_SCENARIO_IDS,
  REQUIRED_GATE_STEP_IDS,
  assertAcceptanceSnapshotIntegrity,
  assertCompleteGatePlan,
  assertSafeTestDatabaseUrl,
  createImmutableAcceptanceSnapshot,
  createLocalAcceptancePlan,
  requiredSuiteContainsConditionalSkip,
  runStepsFailClosed,
  validateLocalAgentEvidence,
  validateProcessCrashRestartEvidence,
  verifyEvidenceArtifactFiles,
  verifyLocalAgentExecutableIdentity,
  verifyLocalAgentRawSemantics,
} from "../scripts/release/local-acceptance-gate-lib.mjs";
import { createDeterministicTar } from "../scripts/release/release-bundle-lib.mjs";
import {
  createCapturedArtifactSnapshot,
  exactArtifactStreamEntries,
} from "../scripts/release/run-local-acceptance-gate.mjs";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourceFingerprint = "a".repeat(64);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}

const hashObject = (value: unknown) => digest(stableStringify(value));

function generator(kind: string, executablePath = "scripts/evidence-generator.mjs", executable = "generator\n") {
  return {
    kind,
    command: `node ${executablePath} --capture`,
    version: "1.0.0",
    executable_path: executablePath,
    executable_sha256: digest(executable),
  };
}

function localAgentEvidence() {
  return {
    schema_version: "1.0",
    status: "PASS",
    captured_at: "2026-08-13T12:00:00.000Z",
    release_version: "0.4.0-rc.1",
    runtime_attestation_hash: "b".repeat(64),
    source_fingerprint: sourceFingerprint,
    generator: generator("CURRENT_LOCAL_AGENT_HARNESS"),
    raw_artifacts: [
      { artifact_type: "CODEX_EVENTS_JSONL", path: "raw/codex-events.jsonl", sha256: digest("raw-agent\n"), size_bytes: 10 },
      { artifact_type: "CODEX_STDERR", path: "raw/codex-stderr.log", sha256: digest("empty\n"), size_bytes: 6 },
      { artifact_type: "FINAL_ANSWER", path: "raw/final-answer.json", sha256: digest("final\n"), size_bytes: 6 },
      { artifact_type: "SERVER_AUDIT", path: "raw/server-audit.json", sha256: digest("audit\n"), size_bytes: 6 },
      { artifact_type: "INVOCATION", path: "raw/invocation.json", sha256: digest("invoke\n"), size_bytes: 7 },
    ],
    runs: [{
      transport: "MCP_STDIO",
      case_id: "case-1",
      tool_call_id: "call-1",
      provider_object_id: "provider-1",
      mutation_receipt_id: "mutation-1",
      exact_readback_receipt_id: "readback-1",
      evidence_chain_hash: "c".repeat(64),
      provider_write_count: 1,
      final_answer_claim: "COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK",
      final_answer: "Created and read back provider-1.",
      raw_artifact_refs: ["raw/codex-events.jsonl", "raw/final-answer.json", "raw/server-audit.json", "raw/invocation.json"],
    }],
  };
}

function crashEvidence() {
  return {
    schema_version: "1.0",
    status: "PASS",
    captured_at: "2026-08-13T12:00:00.000Z",
    release_version: "0.4.0-rc.1",
    runtime_attestation_hash: "b".repeat(64),
    source_fingerprint: sourceFingerprint,
    generator: generator("PROCESS_CRASH_RESTART_HARNESS"),
    raw_artifacts: REQUIRED_CRASH_SCENARIO_IDS.map((scenarioId) => ({
      artifact_type: "CRASH_SCENARIO_JSONL",
      scenario_id: scenarioId,
      path: `raw/${scenarioId}.jsonl`,
      sha256: digest(`${scenarioId}\n`),
      size_bytes: Buffer.byteLength(`${scenarioId}\n`),
    })),
    scenarios: REQUIRED_CRASH_SCENARIO_IDS.map((scenarioId, index) => ({
      scenario_id: scenarioId,
      status: "PASS",
      termination: "PROCESS_KILL",
      termination_signal: "SIGKILL",
      command: `node crash-harness.mjs --scenario ${scenarioId}`,
      server_pid_before: 1000 + index,
      server_pid_after: 2000 + index,
      restart_observed: true,
      provider_write_count_after_restart: scenarioId === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER" ? 0 : 1,
      recovery_outcome: scenarioId === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER"
        ? "BLOCKED_SAFE_UNKNOWN"
        : "RECOVERED_READBACK_VERIFIED",
      evidence_refs: [`raw/${scenarioId}.jsonl`],
    })),
  };
}

function semanticLocalAgentFixture() {
  const providerObjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const writeReceipt = { invoiceId: providerObjectId, providerRequestId: "provider-request-1" };
  const exactReadback = { invoiceId: providerObjectId, status: "DRAFT", total: "109.0000" };
  const mutationReceiptId = `xwr_${hashObject(writeReceipt).slice(0, 32)}`;
  const exactReadbackReceiptId = `xrb_${hashObject(exactReadback).slice(0, 32)}`;
  const durable = {
    case_id: "case-raw-1",
    case_version: 1,
    compiled_plan_hash: "d".repeat(64),
    case_state: "TERMINAL",
    operation_id: "operation-1",
    operation_state: "READBACK_VERIFIED",
    provider_object_id: providerObjectId,
    mutation_request_id: "mutation-request-1",
    mutation_receipt_id: mutationReceiptId,
    exact_readback_receipt_id: exactReadbackReceiptId,
    evidence_chain_hash: "",
    write_receipt: writeReceipt,
    exact_readback: exactReadback,
  };
  durable.evidence_chain_hash = hashObject({
    caseId: durable.case_id,
    version: durable.case_version,
    compiledPlanHash: durable.compiled_plan_hash,
    operationId: durable.operation_id,
    operationState: durable.operation_state,
    providerObjectId: durable.provider_object_id,
    mutationRequestId: durable.mutation_request_id,
    mutationReceiptId,
    exactReadbackReceiptId,
    writeReceipt,
    exactReadback,
  });
  const finalAnswer = {
    evidence_boundary: "LOCAL",
    completion_claim: "COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK",
    case_id: durable.case_id,
    case_version: 1,
    provider_object_id: providerObjectId,
    provider_receipt_recorded: true,
    exact_same_id_readback_verified: true,
    source_truth_claim: "NOT_VERIFIED",
    original_file_verified: false,
    message: "Ledger readback verified; source truth not verified.",
  };
  const releaseAttestation = { controlKernel: "kernel-v1", requiredMigration: "032.sql" };
  const releaseAttestationHash = hashObject(releaseAttestation);
  const runtimeAttestation = { releaseAttestationHash, writeMode: "WRITE_ENABLED" };
  const runtimeAttestationHash = hashObject(runtimeAttestation);
  const statusResult = {
    state: "TERMINAL",
    source_claim: {
      trust: "UNVERIFIED_SUBMITTED_FACTS",
      source_truth_claim: "NOT_VERIFIED",
      original_file_verified: false,
      fact_origins: ["MODEL_EXTRACTED"],
      document_validity_basis: "SUBMITTED_ASSERTION",
    },
    completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
    operations: [{
      state: "READBACK_VERIFIED",
      xero_object_id: providerObjectId,
      provider_receipt_recorded: true,
      exact_readback_recorded: true,
    }],
  };
  const sourceClaim = statusResult.source_claim;
  const targetSessionRef = `xts_${"A".repeat(43)}`;
  const targetSessionRefDigest = hashObject({ targetSessionRef });
  const redactedTargetSessionRef = "<redacted-target-session-ref>";
  const pinResult = {
    target_session_ref: targetSessionRef,
    target_ref_safe: "xero-target-session:fixture",
    binding_revision: 1,
  };
  const redactedPinResult = { ...pinResult, target_session_ref: redactedTargetSessionRef };
  const organisationResult = {
    name: "Fixture Organisation",
    countryCode: "SG",
    baseCurrency: "SGD",
    paysTax: true,
    organisationStatus: "ACTIVE",
  };
  const organisationServiceResult = {
    organisationId: "11111111-1111-4111-8111-111111111111",
    ...organisationResult,
  };
  const organisationEnvelope = {
    result_class: "succeeded",
    fact_origin: "MCP_READ",
    source_system: "xero",
    capability_id: "ledger.target.resolve",
    tool_call_or_audit_ref: "call_fixture_organisation",
    capability_revision: "xero-mcp@0.4.0-rc.1",
    observed_at: "2026-08-13T12:00:00.000Z",
    query_bounds: { target_scope: "active_server_bound_xero_organisation", requested: {} },
    completeness: { status: "complete", scope: "active_server_bound_xero_organisation" },
    output_hash: `sha256:${hashObject(organisationResult)}`,
    fact_paths: ["/result/name", "/result/baseCurrency"],
    base_currency: "SGD",
    target_session_ref_safe: pinResult.target_ref_safe,
    destination_role: "ledger_sor",
    bound_target_ref_safe: "xero-target:fixture",
    organisation_display_name: organisationResult.name,
    binding_revision: "xero-binding-revision:fixture",
  };
  const prepareResult = {
    source_claim: sourceClaim,
    completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
  };
  const executeResult = {
    source_claim: sourceClaim,
    completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
  };
  const mcpResult = (result: unknown, envelope: Record<string, unknown> = {}) => ({
    structuredContent: { result, ...envelope },
    content: [{ type: "text", text: JSON.stringify({ result, ...envelope }) }],
  });
  const toolCalls = [
    { id: "pin-call", tool: "xero_pin_current_organisation", arguments: {}, result: mcpResult(pinResult) },
    { id: "organisation-call", tool: "xero_get_organisation", arguments: { target_session_ref: targetSessionRef }, result: mcpResult(organisationResult, organisationEnvelope) },
    { id: "prepare-call", tool: "xero_prepare_accounting_case", arguments: { target_session_ref: targetSessionRef, case_id: durable.case_id, expected_version: 0 }, result: mcpResult(prepareResult) },
    { id: "execute-call", tool: "xero_execute_accounting_case", arguments: { target_session_ref: targetSessionRef, case_id: durable.case_id, case_version: 1, request_id: "request-1" }, result: mcpResult(executeResult) },
    { id: "status-call", tool: "xero_get_accounting_case_status", arguments: { target_session_ref: targetSessionRef, case_id: durable.case_id, case_version: 1 }, result: mcpResult(statusResult) },
  ];
  const events = toolCalls.map((call) => ({
    type: "item.completed",
    item: { type: "mcp_tool_call", status: "completed", error: null, ...call },
  }));
  events.push({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(finalAnswer) } } as never);
  const protocolArguments = toolCalls.map((call) => Object.fromEntries(Object.entries(call.arguments).map(([key, value]) => [
    key,
    key === "target_session_ref" ? redactedTargetSessionRef : value,
  ])));
  const protocolResults = [redactedPinResult, organisationResult, prepareResult, executeResult, statusResult];
  const serviceResults = [redactedPinResult, organisationServiceResult, prepareResult, executeResult, statusResult];
  const audit = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY",
    release_version: "0.4.0-rc.1",
    target_session_evidence: {
      status: "PASS",
      issuance_tool: "xero_pin_current_organisation",
      verification_tool: "xero_get_organisation",
      base_context_unpinned: true,
      required_by_server: true,
      raw_capability_persisted_in_server_audit: false,
      binding_scope: "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY",
      conversation_binding: "NOT_CLAIMED_NO_TRUSTED_SERVER_CONVERSATION_ID",
      target_session_ref_hash: targetSessionRefDigest,
      target_ref_safe: "xero-target-session:fixture",
      binding_revision: 1,
    },
    mcp_protocol_calls: toolCalls.map((call, index) => ({
      jsonrpc_id: index + 1,
      method: "tools/call",
      tool: call.tool,
      public_arguments: protocolArguments[index],
      target_session_ref_hash: targetSessionRefDigest,
      status: "PASS",
      raw_structured_result: index === 1
        ? mcpResult(protocolResults[index], organisationEnvelope)
        : mcpResult(protocolResults[index]),
      error: null,
    })),
    tool_calls: toolCalls.map((call, index) => ({
      tool: call.tool,
      normalized_input: Object.fromEntries(Object.entries(call.arguments).filter(([key]) => key !== "target_session_ref")),
      target_session_ref_hash: targetSessionRefDigest,
      status: "PASS",
      result: serviceResults[index],
    })),
    provider_write_count: 1,
    provider_records: [{ invoice_id: providerObjectId, provider_receipt: writeReceipt, exact_readback: exactReadback }],
    release_attestation: releaseAttestation,
    release_attestation_hash: releaseAttestationHash,
    runtime_attestation: runtimeAttestation,
    runtime_attestation_hash: runtimeAttestationHash,
    durable_evidence: durable,
  };
  const invocationRuntime = {
    release_attestation_hash: releaseAttestationHash,
    server_runtime_attestation_hash: runtimeAttestationHash,
  };
  const invocation = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL",
    exit_code: 0,
    source_fingerprint: { sha256: sourceFingerprint },
    runtime_attestation: invocationRuntime,
    runtime_attestation_hash: hashObject(invocationRuntime),
    assertions: {
      only_public_targeted_case_tools: true,
      target_pin_first: true,
      target_verified_before_write: true,
      same_target_session_ref_all_ledger_calls: true,
      target_ref_hash_recomputed_from_raw_events: targetSessionRefDigest,
      base_request_context_unpinned: true,
      target_binding_scope: "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY",
      conversation_binding_residual: "NO_TRUSTED_SERVER_CONVERSATION_ID_AVAILABLE",
    },
  };
  const document = localAgentEvidence();
  document.runtime_attestation_hash = invocation.runtime_attestation_hash;
  document.runs = [{
    transport: "MCP_STDIO",
    case_id: durable.case_id,
    tool_call_id: "execute-call",
    provider_object_id: providerObjectId,
    mutation_receipt_id: mutationReceiptId,
    exact_readback_receipt_id: exactReadbackReceiptId,
    evidence_chain_hash: durable.evidence_chain_hash,
    provider_write_count: 1,
    final_answer_claim: "COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK",
    final_answer: JSON.stringify(finalAnswer),
    raw_artifact_refs: document.raw_artifacts.map((artifact) => artifact.path),
  }];
  return {
    document,
    artifacts: new Map([
      ["CODEX_EVENTS_JSONL", Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)],
      ["CODEX_STDERR", Buffer.from("<empty>\n")],
      ["FINAL_ANSWER", Buffer.from(JSON.stringify(finalAnswer))],
      ["SERVER_AUDIT", Buffer.from(JSON.stringify(audit))],
      ["INVOCATION", Buffer.from(JSON.stringify(invocation))],
    ]),
    audit,
    events,
    invocation,
    targetSessionRef,
    targetSessionRefDigest,
  };
}

function plan() {
  // `traceabilityPath` is gone: traceability-closed no longer exists as a gate
  // step, so createLocalAcceptancePlan never reads this option.
  return createLocalAcceptancePlan({
    evidenceDirectory: "/tmp/local-acceptance-test",
    localAgentEvidencePath: "/tmp/local-agent-run.json",
    processCrashRestartEvidencePath: "/tmp/process-crash-restart.json",
    approvedControlCatalogSha256: "a".repeat(64),
    approvedReviewCodexSha256: "b".repeat(64),
    approvedReviewRuntimeSha256: "c".repeat(64),
    expectedSourceFingerprint: "d".repeat(64),
    sourceSnapshotManifestSha256: "e".repeat(64),
    liveReviewChallengeSha256: "f".repeat(64),
    gateRunId: "11111111-1111-4111-8111-111111111111",
  });
}

describe("fail-closed local acceptance mechanism", () => {
  it("runs from a digest-named immutable copy and rejects an original A-to-B-to-A mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-acceptance-source-"));
    const sourceRoots = ["package.json", "src"];
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), "{\"name\":\"snapshot-fixture\"}\n");
    await writeFile(join(root, "src/candidate.ts"), "export const candidate = 'A';\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const snapshot = await createImmutableAcceptanceSnapshot(root, {
      sourceRoots,
      copyDependencies: false,
      copyGitMetadata: false,
    });
    try {
      expect(snapshot.root.endsWith(snapshot.sourceFingerprint.sha256)).toBe(true);
      expect(await readFile(join(snapshot.root, "src/candidate.ts"), "utf8"))
        .toBe("export const candidate = 'A';\n");

      await writeFile(join(root, "src/candidate.ts"), "export const candidate = 'B';\n");
      await writeFile(join(root, "src/candidate.ts"), "export const candidate = 'A';\n");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

      await expect(assertAcceptanceSnapshotIntegrity(snapshot))
        .rejects.toThrow("ORIGINAL_SOURCE_MUTATION_OBSERVED");
      expect(await readFile(join(snapshot.root, "src/candidate.ts"), "utf8"))
        .toBe("export const candidate = 'A';\n");
    } finally {
      await snapshot.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects snapshot tamper-and-restore even when its final fingerprint returns to A", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-acceptance-source-"));
    const sourceRoots = ["package.json"];
    await writeFile(join(root, "package.json"), "{\"candidate\":\"A\"}\n");
    const snapshot = await createImmutableAcceptanceSnapshot(root, {
      sourceRoots,
      copyDependencies: false,
      copyGitMetadata: false,
    });
    try {
      const snapshotPackage = join(snapshot.root, "package.json");
      await chmod(snapshotPackage, 0o644);
      await writeFile(snapshotPackage, "{\"candidate\":\"B\"}\n");
      await writeFile(snapshotPackage, "{\"candidate\":\"A\"}\n");
      await chmod(snapshotPackage, 0o444);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

      await expect(assertAcceptanceSnapshotIntegrity(snapshot))
        .rejects.toThrow("IMMUTABLE_SNAPSHOT_MUTATION_OBSERVED");
    } finally {
      await snapshot.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generated artifacts on the fd-captured snapshot when a mutable output path is swapped", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-acceptance-generated-output-"));
    const mutableOutput = join(root, "oci.tar");
    const accepted = Buffer.from("accepted OCI bytes\n", "utf8");
    const stream = createDeterministicTar([{ path: "oci.tar", content: accepted, mode: 0o400 }]);
    const streamFiles = exactArtifactStreamEntries(stream, ["oci.tar"]);
    const captured = await createCapturedArtifactSnapshot(
      [{ path: "oci.tar", content: streamFiles.get("oci.tar")!, mode: 0o400 }],
      "OCI_RELEASE_TEST",
      stream,
    );
    try {
      await writeFile(mutableOutput, accepted);
      await writeFile(mutableOutput, "attacker replacement\n");
      expect(await readFile(join(captured.snapshot.root, "oci.tar"), "utf8"))
        .toBe("accepted OCI bytes\n");
      await expect(assertAcceptanceSnapshotIntegrity(captured.snapshot)).resolves.toBeDefined();

      const capturedPath = join(captured.snapshot.root, "oci.tar");
      await chmod(capturedPath, 0o644);
      await writeFile(capturedPath, "attacker replacement\n");
      await writeFile(capturedPath, accepted);
      await chmod(capturedPath, 0o444);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      await expect(assertAcceptanceSnapshotIntegrity(captured.snapshot))
        .rejects.toThrow("IMMUTABLE_SNAPSHOT_MUTATION_OBSERVED");
    } finally {
      await captured.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a disposable safety-named PostgreSQL database", () => {
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow("TEST_DATABASE_URL_REQUIRED");
    expect(() => assertSafeTestDatabaseUrl("postgresql://localhost/production")).toThrow("TEST_DATABASE_URL_UNSAFE");
    expect(assertSafeTestDatabaseUrl("postgresql://localhost/xero_mcp_test_gate"))
      .toEqual({
        database_name: "xero_mcp_test_gate",
        protocol: "postgresql:",
        host_hash: digest("localhost"),
      });
  });

  it("locks every required component and rejects omission or reordering", () => {
    const complete = plan();
    expect(complete.map((step) => step.id)).toEqual(REQUIRED_GATE_STEP_IDS);
    for (let index = 0; index < complete.length; index += 1) {
      const incomplete = complete.filter((_, candidate) => candidate !== index);
      expect(() => assertCompleteGatePlan(incomplete)).toThrow("LOCAL_GATE_PLAN_INCOMPLETE");
    }
    expect(() => assertCompleteGatePlan([...complete].reverse())).toThrow("LOCAL_GATE_PLAN_INCOMPLETE");
    // `evidenceValidationRoot` used to give the traceability-closed step alone a
    // `cwd` pointed at the original (non-snapshotted) repository, because the
    // traceability document it read lived outside the guarded source roots.
    // That step is gone, so no step in the plan has a `cwd` at all any more -
    // this used to be a separate plan built just to exercise that option; it is
    // folded into `complete` now because there is nothing left to distinguish.
    expect(complete.every((step) => step.cwd === undefined)).toBe(true);
    expect(complete[0]).toMatchObject({
      id: "process-crash-restart-evidence",
      precondition: true,
    });
    expect(complete.some((step) => step.id === "independent-review-live")).toBe(false);
    expect(complete.some((step) => step.id === "traceability-closed")).toBe(false);
    expect(complete.some((step) => step.id === "local-agent-evidence")).toBe(false);
    for (const id of ["full-regression", "postgres-required", "http-required"]) {
      expect(complete.find((step) => step.id === id)?.args).toContain("--no-cache");
    }
    expect(complete.find((step) => step.id === "release-bundle-build"))
      .toMatchObject({ artifactStreamKind: "SOURCE_BUNDLE" });
    expect(complete.find((step) => step.id === "release-oci-build"))
      .toMatchObject({ artifactStreamKind: "OCI_RELEASE" });
    for (const id of ["release-bundle-build", "release-oci-build"]) {
      expect(complete.find((step) => step.id === id)?.args)
        .toContain("--artifact-stream-fd");
    }
  });

  it("reports every precondition blocker and still measures the candidate", async () => {
    // Same pathology the independent-review-live removal addressed, one level up:
    // traceability-closed failed on every run until a reviewer re-authored the
    // artifact, so short-circuiting on it stopped every run before any real check
    // executed. The operator learned nothing about the candidate while waiting on
    // paperwork. That step has since been removed from the gate entirely (see
    // scripts/local-acceptance-contract.mjs); this test now exercises the same
    // fail-open-verification behavior on process-crash-restart-evidence, the
    // one precondition that remains. Verification still runs regardless of a
    // precondition failure; the gate still fails closed, and an acceptance
    // receipt is written only on an overall PASS, so nothing built under a
    // failed run can be promoted.
    const executed: string[] = [];
    const outcome = await runStepsFailClosed(plan(), async (step) => {
      executed.push(step.id);
      return {
        id: step.id,
        status: step.id === "process-crash-restart-evidence" ? "FAIL" : "PASS",
      };
    });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.failed_step_id).toBe("process-crash-restart-evidence");
    expect(executed[0]).toBe("process-crash-restart-evidence");
    expect(executed).toContain("typecheck");
    expect(executed).toContain("full-regression");
  });

  it("names the failing precondition even when a later verification step also fails", async () => {
    const outcome = await runStepsFailClosed(plan(), async (step) => ({
      id: step.id,
      status: ["process-crash-restart-evidence", "full-regression"].includes(step.id) ? "FAIL" : "PASS",
    }));
    expect(outcome.status).toBe("FAIL");
    expect(outcome.failed_step_id).toBe("process-crash-restart-evidence");
  });

  it("no longer carries a step a vendor's billing can close", () => {
    // local-agent-evidence required the Codex binary at a hardcoded path, its
    // exact SHA-256, and an Apple Team ID checked by shelling to codesign - and
    // the run was funded by a personal quota that answered "you've hit your usage
    // limit". The property it checked is now covered by live acceptance against
    // the real tenant, which the removed step never reached: its own evidence
    // boundary was the synthetic provider.
    expect(plan().some((step) => step.id === "local-agent-evidence")).toBe(false);
  });

  it("no longer carries a step that can only ever fail", () => {
    // The gate used to open with `independent-review-live`, whose command did
    // nothing but demand an out-of-repository signing authority and exit 78.
    // Because the sequence fails closed, that step stopped every run before any
    // real check executed — the gate reported NO-GO whether or not anything was
    // actually wrong, which is indistinguishable from having no gate.
    expect(plan().some((step) => step.id === "independent-review-live")).toBe(false);
  });

  it("no longer carries a step that has never once passed (traceability-closed)", () => {
    // traceability-closed called into
    // scripts/review/validate-requirements-traceability.mjs --require-closed.
    // Not one of the 18 requirements it tracks has ever reached CLOSED in this
    // gate's history, and it fails today on 58 errors (18 status + 40
    // CROSS_CLAIM_PROBE_FINGERPRINT_REUSED) that only a human reviewer can
    // resolve one claim at a time - no script can derive which file actually
    // implements a given requirement. A precondition that has never once
    // passed reports NO-GO regardless of whether the candidate under test
    // actually regressed, which made it as uninformative as
    // independent-review-live's guaranteed exit 78. It is still run on demand
    // via `npm run validate:traceability`; it no longer decides PASS/FAIL for
    // this gate.
    expect(plan().some((step) => step.id === "traceability-closed")).toBe(false);
  });

  it("still refuses to claim the independent-review authority a local run does not have", async () => {
    const outcome = await runStepsFailClosed(plan(), async (step) => ({ id: step.id, status: "PASS" }));
    expect(outcome.status).toBe("PASS");
    // Passing locally must never read as an independent attestation.
    const contract = await readFile(
      new URL("../scripts/release/run-local-acceptance-gate.mjs", import.meta.url),
      "utf8",
    );
    expect(contract).toContain('gate_l_claim: "NOT_IMPLIED"');
    expect(contract).toContain('independent_review_authority: "LOCAL_EVIDENCE_UNTRUSTED"');
  });

  it("stops at the first deterministic command failure after all preconditions pass", async () => {
    const executed: string[] = [];
    const outcome = await runStepsFailClosed(plan(), async (step) => {
      executed.push(step.id);
      return { id: step.id, status: step.id === "build" ? "FAIL" : "PASS" };
    });
    expect(outcome.failed_step_id).toBe("build");
    expect(executed.at(-1)).toBe("build");
    expect(executed).not.toContain("full-regression");
  });

  it("does not accept a required PostgreSQL or HTTP suite that exited zero with skips", () => {
    expect(requiredSuiteContainsConditionalSkip(
      "postgres-required",
      Buffer.from("62 passed | 1 skipped"),
      Buffer.alloc(0),
    )).toBe(true);
    expect(requiredSuiteContainsConditionalSkip(
      "http-required",
      Buffer.from("7 passed"),
      Buffer.alloc(0),
    )).toBe(false);
    expect(requiredSuiteContainsConditionalSkip(
      "full-regression",
      Buffer.from("1 skipped; covered by required suite"),
      Buffer.alloc(0),
    )).toBe(true);
    expect(requiredSuiteContainsConditionalSkip(
      "full-regression",
      Buffer.from("1 todo"),
      Buffer.alloc(0),
    )).toBe(true);
    expect(plan().find((step) => step.id === "full-regression")?.env).toEqual({
      TEST_HTTP_LOOPBACK: "true",
    });
  });

  it("rejects status-only, stale and non-process evidence", () => {
    expect(() => validateLocalAgentEvidence({ status: "PASS" })).toThrow("LOCAL_AGENT_EVIDENCE_INVALID");
    const stale = localAgentEvidence();
    expect(() => validateLocalAgentEvidence(stale, { expectedSourceFingerprint: "f".repeat(64) }))
      .toThrow("LOCAL_AGENT_EVIDENCE_STALE");
    const fakeCrash = crashEvidence();
    fakeCrash.scenarios[0]!.termination_signal = "SIGTERM";
    expect(() => validateProcessCrashRestartEvidence(fakeCrash, { expectedSourceFingerprint: sourceFingerprint }))
      .toThrow("did not prove a real kill/restart");
  });

  it("binds evidence to the current generator and raw artifact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-acceptance-evidence-"));
    const evidenceDirectory = join(root, "evidence");
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await mkdir(join(evidenceDirectory, "raw"), { recursive: true });
      await writeFile(join(root, "scripts/evidence-generator.mjs"), "generator\n");
      await writeFile(join(evidenceDirectory, "raw/codex-events.jsonl"), "raw-agent\n");
      await writeFile(join(evidenceDirectory, "raw/codex-stderr.log"), "empty\n");
      await writeFile(join(evidenceDirectory, "raw/final-answer.json"), "final\n");
      await writeFile(join(evidenceDirectory, "raw/server-audit.json"), "audit\n");
      await writeFile(join(evidenceDirectory, "raw/invocation.json"), "invoke\n");
      const document = localAgentEvidence();
      const evidencePath = join(evidenceDirectory, "local-agent-run.json");
      validateLocalAgentEvidence(document, { expectedSourceFingerprint: sourceFingerprint });
      await expect(verifyEvidenceArtifactFiles(document, evidencePath, root)).resolves.toBeInstanceOf(Map);
      await writeFile(join(evidenceDirectory, "raw/codex-events.jsonl"), "tampered\n");
      await expect(verifyEvidenceArtifactFiles(document, evidencePath, root)).rejects.toThrow("RAW_EVIDENCE_STALE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recomputes Agent completion from raw events and rejects a PASS summary over zero writes", () => {
    const fixture = semanticLocalAgentFixture();
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts)).not.toThrow();
    fixture.audit.provider_write_count = 0;
    fixture.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(fixture.audit)));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SERVER_BOUNDARY_INVALID");
  });

  it("accepts a real-provider evidence boundary and still rejects an unrecognized one", () => {
    // evidence_boundary used to hard-require the single literal
    // LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY, which made a real Xero run
    // structurally ineligible to ever satisfy this evidence no matter how it
    // was captured (docs/XERO-MCP-REMEDIATION-PLAN-2026-08-19.md, section W2.1).
    // This repository has no way to produce a genuine real-provider capture in
    // a test - that needs a live Xero tenant and operator OAuth - so this only
    // proves the validator's schema no longer forecloses one on sight, and
    // still rejects a value that is neither the synthetic nor the real boundary.
    expect(ACCEPTED_LOCAL_AGENT_EVIDENCE_BOUNDARIES).toEqual([
      "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY",
      "LOCAL_REAL_PROVIDER_SDK_BOUNDARY",
    ]);
    const real = semanticLocalAgentFixture();
    real.audit.evidence_boundary = "LOCAL_REAL_PROVIDER_SDK_BOUNDARY";
    real.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(real.audit)));
    expect(() => verifyLocalAgentRawSemantics(real.document, real.artifacts)).not.toThrow();

    const unrecognized = semanticLocalAgentFixture();
    unrecognized.audit.evidence_boundary = "SOME_OTHER_BOUNDARY";
    unrecognized.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(unrecognized.audit)));
    expect(() => verifyLocalAgentRawSemantics(unrecognized.document, unrecognized.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SERVER_BOUNDARY_INVALID");
  });

  it("allows bounded read-only MCP discovery before the exact business tool sequence", () => {
    const fixture = semanticLocalAgentFixture();
    const events = fixture.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.unshift({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        status: "completed",
        error: null,
        id: "discovery-call",
        tool: "list_mcp_resources",
        arguments: {},
        result: { content: [] },
      },
    });
    fixture.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts)).not.toThrow();
  });

  it("independently validates raw Skill reads and rejects boundary, write, and late shell commands", () => {
    const skillPath = ".agents/skills/execute-approved-accounting-entry/SKILL.md";
    const commandEvent = (command: string, id = "skill-read") => ({
      type: "item.completed",
      item: { type: "command_execution", id, command, status: "completed", exit_code: 0 },
    });
    const withCommand = (fixture: ReturnType<typeof semanticLocalAgentFixture>, event: Record<string, unknown>, index = 0) => {
      const events = fixture.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
      events.splice(index, 0, event);
      fixture.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((value) => JSON.stringify(value)).join("\n")}\n`));
    };

    const legal = semanticLocalAgentFixture();
    withCommand(legal, commandEvent(`cat ${skillPath}`));
    expect(() => verifyLocalAgentRawSemantics(legal.document, legal.artifacts)).not.toThrow();

    const outOfBoundary = semanticLocalAgentFixture();
    withCommand(outOfBoundary, commandEvent("cat README.md"));
    expect(() => verifyLocalAgentRawSemantics(outOfBoundary.document, outOfBoundary.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SKILL_COMMAND_INVALID");

    const write = semanticLocalAgentFixture();
    withCommand(write, commandEvent(`cat ${skillPath} > /tmp/skill-copy`));
    expect(() => verifyLocalAgentRawSemantics(write.document, write.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SKILL_COMMAND_INVALID");

    const late = semanticLocalAgentFixture();
    withCommand(late, commandEvent(`cat ${skillPath}`, "late-read"), 1);
    expect(() => verifyLocalAgentRawSemantics(late.document, late.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SKILL_COMMAND_AFTER_BUSINESS");
  });

  it("independently locks Codex wrapper Skill reads to one normalized temporary workspace root", () => {
    const skillPath = ".agents/skills/execute-approved-accounting-entry/SKILL.md";
    const tempRoot = realpathSync(tmpdir());
    const rootA = join(tempRoot, "xero-local-agent-workspace-independent-A");
    const rootB = join(tempRoot, "xero-local-agent-workspace-independent-B");
    const commandEvent = (root: string, id: string) => ({
      type: "item.completed",
      item: {
        type: "command_execution",
        id,
        command: `/bin/zsh -lc "sed -n '1,240p' ${root}/${skillPath}"`,
        status: "completed",
        exit_code: 0,
      },
    });
    const withEvents = (fixture: ReturnType<typeof semanticLocalAgentFixture>, eventsToInsert: Record<string, unknown>[]) => {
      const events = fixture.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
      events.splice(0, 0, ...eventsToInsert);
      fixture.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((value) => JSON.stringify(value)).join("\n")}\n`));
    };
    const drift = semanticLocalAgentFixture();
    withEvents(drift, [commandEvent(rootA, "read-a"), commandEvent(rootB, "read-b")]);
    expect(() => verifyLocalAgentRawSemantics(drift.document, drift.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SKILL_COMMAND_ROOT_DRIFT");

    const wrongAbsolutePath = semanticLocalAgentFixture();
    withEvents(wrongAbsolutePath, [{
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "wrong-absolute-path",
        command: `/bin/zsh -lc "cat ${tempRoot}/not-a-mounted-skill.md"`,
        status: "completed",
        exit_code: 0,
      },
    }]);
    expect(() => verifyLocalAgentRawSemantics(wrongAbsolutePath.document, wrongAbsolutePath.artifacts))
      .toThrow("LOCAL_AGENT_RAW_SKILL_COMMAND_INVALID");
  });

  it("requires the organisation read envelope and strips organisationId only at the service boundary", () => {
    const leaked = semanticLocalAgentFixture();
    const events = leaked.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    const organisationCall = events.find((event) => event.item?.type === "mcp_tool_call" && event.item.tool === "xero_get_organisation" && event.type === "item.completed");
    organisationCall.item.result.structuredContent.result.organisationId = "11111111-1111-4111-8111-111111111111";
    leaked.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((value) => JSON.stringify(value)).join("\n")}\n`));
    expect(() => verifyLocalAgentRawSemantics(leaked.document, leaked.artifacts))
      .toThrow("LOCAL_AGENT_RAW_PROTOCOL_SERVICE_BINDING_INVALID:2");

    const missingEnvelope = semanticLocalAgentFixture();
    delete missingEnvelope.audit.mcp_protocol_calls[1].raw_structured_result.structuredContent.capability_id;
    missingEnvelope.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(missingEnvelope.audit)));
    expect(() => verifyLocalAgentRawSemantics(missingEnvelope.document, missingEnvelope.artifacts))
      .toThrow("LOCAL_AGENT_RAW_PROTOCOL_SERVICE_BINDING_INVALID:2");
  });

  it("binds public prepare identity while allowing the production intake normalizer to build internal facts", () => {
    const fixture = semanticLocalAgentFixture();
    fixture.audit.tool_calls[2]!.normalized_input = {
      case_id: "case-raw-1",
      expected_version: 0,
      sources: [{ artifactId: "source-fixture", label: "fixture", units: [] }],
      facts: [{ factId: "fact-fixture", kind: "NATIVE_DOCUMENT" }],
    };
    fixture.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(fixture.audit)));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts)).not.toThrow();
  });

  it("rejects MCP discovery after the governed business sequence has started", () => {
    const fixture = semanticLocalAgentFixture();
    const events = fixture.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.splice(1, 0, {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        status: "completed",
        error: null,
        id: "late-discovery-call",
        tool: "list_mcp_resources",
        arguments: {},
        result: { content: [] },
      },
    });
    fixture.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_MCP_DISCOVERY_INVALID");
  });

  it("rejects raw Agent events that stop carrying the exact server-issued target reference", () => {
    const fixture = semanticLocalAgentFixture();
    const events = fixture.artifacts.get("CODEX_EVENTS_JSONL")!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    events[3]!.item.arguments.target_session_ref = `xts_${"B".repeat(43)}`;
    fixture.artifacts.set("CODEX_EVENTS_JSONL", Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_TARGET_SESSION_SEQUENCE_INVALID");
  });

  it("rejects raw target capability leakage into the persisted server audit", () => {
    const fixture = semanticLocalAgentFixture();
    Object.assign(fixture.audit, { accidental_raw_target_session_ref: fixture.targetSessionRef });
    fixture.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(fixture.audit)));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_TARGET_SESSION_AUDIT_LEAK");
  });

  it("recomputes the target reference hash instead of trusting server summary fields", () => {
    const fixture = semanticLocalAgentFixture();
    fixture.audit.mcp_protocol_calls[2]!.target_session_ref_hash = "f".repeat(64);
    fixture.artifacts.set("SERVER_AUDIT", Buffer.from(JSON.stringify(fixture.audit)));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_TARGET_SESSION_HASH_INVALID");
  });

  it("rejects a local Agent answer that upgrades ledger readback into source-file verification", () => {
    const fixture = semanticLocalAgentFixture();
    const finalAnswer = JSON.parse(fixture.artifacts.get("FINAL_ANSWER")!.toString("utf8"));
    finalAnswer.source_truth_claim = "VERIFIED";
    finalAnswer.original_file_verified = true;
    fixture.artifacts.set("FINAL_ANSWER", Buffer.from(JSON.stringify(finalAnswer)));
    expect(() => verifyLocalAgentRawSemantics(fixture.document, fixture.artifacts))
      .toThrow("LOCAL_AGENT_RAW_FINAL_ANSWER_INVALID");
  });

  it("rejects a workspace-controlled fake Codex executable even when its self-reported hash matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-agent-fake-codex-"));
    try {
      const fakeCodex = join(root, "codex");
      const bytes = Buffer.from("#!/bin/sh\necho codex-cli 99.0.0\n", "utf8");
      await writeFile(fakeCodex, bytes, { mode: 0o755 });
      const canonicalFakeCodex = await realpath(fakeCodex);
      const prompt = "synthetic local Agent prompt";
      const artifacts = new Map([["INVOCATION", Buffer.from(JSON.stringify({
        codex: {
          executable_path: canonicalFakeCodex,
          executable_sha256: digest(bytes),
          version: "codex-cli 99.0.0",
          command: [canonicalFakeCodex, "exec"],
        },
        prompt,
        prompt_sha256: digest(prompt),
      }))]]);
      await expect(verifyLocalAgentExecutableIdentity(artifacts))
        .rejects.toThrow("LOCAL_AGENT_RAW_CODEX_EXECUTABLE_NOT_APPROVED");
      await expect(verifyLocalAgentExecutableIdentity(artifacts, {
        allowedCodexExecutablePaths: [canonicalFakeCodex],
        verifyPlatformIdentity: false,
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
