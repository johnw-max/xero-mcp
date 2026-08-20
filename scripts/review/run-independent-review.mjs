#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIndependentReviewCodexCommand,
  buildIndependentReviewFalsificationProbeCommand,
  buildIndependentReviewInspectionCommands,
  buildIndependentReviewPrompt,
  APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS,
  createIndependentReviewFalsificationProbeReceipt,
  createIndependentReviewInputReceipt,
  createIndependentReviewInputChunkReceipt,
  fingerprintIndependentReviewInputs,
  expectedStructuredReviewChecks,
  independentReviewSubjectSha256,
  independentReviewCommandMatchesExpected,
  reviewSha256,
  stableReviewStringify,
} from "./independent-review-evidence-lib.mjs";
import { fingerprintAcceptanceSource } from "../release/local-acceptance-gate-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const defaultTraceabilityPath = resolve(
  repoRoot,
  "artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json",
);
const outputSchemaPath = resolve(repoRoot, "schemas/independent-review-verdict.schema.json");
const generatorVersion = "3.0.0";

function parseArguments(argv) {
  let documentPath = defaultTraceabilityPath;
  let evidencePath;
  const requirementIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--file") {
      if (!value) throw new Error("--file requires a path");
      documentPath = resolve(value);
      index += 1;
    } else if (argument === "--evidence") {
      if (!value) throw new Error("--evidence requires a path");
      evidencePath = resolve(value);
      index += 1;
    } else if (argument === "--requirement") {
      if (!value || !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}$/u.test(value)) {
        throw new Error("--requirement requires a stable requirement ID");
      }
      requirementIds.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (requirementIds.length !== 1) {
    throw new Error("Exactly one --requirement is required per independent bounded reviewer execution");
  }
  if (!evidencePath) {
    throw new Error("--evidence is required; review evidence paths must be deterministic and declared before source fingerprinting");
  }
  return {
    documentPath,
    evidencePath,
    requirementIds: requirementIds.sort((left, right) => left.localeCompare(right, "en")),
  };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveCodexExecutable() {
  for (const candidate of APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS) {
    if (await executable(candidate)) return resolve(candidate);
  }
  throw new Error("INDEPENDENT_REVIEW_CODEX_EXECUTABLE_NOT_FOUND");
}

async function codexVersion(codexPath) {
  const child = spawn(codexPath, ["--version"], {
    cwd: repoRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: null, error: error.message }));
    child.once("close", (code) => resolvePromise({ code, error: null }));
  });
  if (outcome.code !== 0) {
    throw new Error(`INDEPENDENT_REVIEW_CODEX_VERSION_FAILED:${outcome.code ?? outcome.error ?? "unknown"}:${Buffer.concat(stderr).toString("utf8")}`);
  }
  const version = Buffer.concat(stdout).toString("utf8").trim();
  if (!version) throw new Error("INDEPENDENT_REVIEW_CODEX_VERSION_EMPTY");
  return version;
}

function parseJsonLines(content) {
  const events = [];
  for (const [index, line] of content.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_CODEX_EVENTS_INVALID_AT_${index + 1}`);
    }
  }
  if (events.length === 0) throw new Error("INDEPENDENT_REVIEW_CODEX_EVENTS_EMPTY");
  return events;
}

function reviewerThreadId(events) {
  const started = events.filter((event) => event?.type === "thread.started");
  if (started.length !== 1 || typeof started[0]?.thread_id !== "string" || !started[0].thread_id.trim()) {
    throw new Error("INDEPENDENT_REVIEW_CODEX_THREAD_ID_MISSING");
  }
  return started[0].thread_id;
}

function assertFinalVerdict(finalVerdict, context) {
  if (!finalVerdict || typeof finalVerdict !== "object" || Array.isArray(finalVerdict) ||
      finalVerdict.schema_version !== "1.0" ||
      finalVerdict.implementation_execution_id !== context.implementationExecutionId ||
      finalVerdict.source_fingerprint !== context.sourceFingerprint ||
      finalVerdict.review_subject_sha256 !== context.reviewSubjectSha256 ||
      finalVerdict.review_inputs_sha256 !== context.reviewInputsSha256 ||
      !["CLOSED", "REOPEN"].includes(finalVerdict.overall_decision) ||
      !Array.isArray(finalVerdict.requirements) ||
      finalVerdict.requirements.length !== context.requestedRequirements.length) {
    throw new Error("INDEPENDENT_REVIEW_FINAL_VERDICT_IDENTITY_INVALID");
  }
  for (const [index, assignment] of context.requestedRequirements.entries()) {
    const record = finalVerdict.requirements[index];
    if (record?.requirement_id !== assignment.requirement_id ||
        record?.reviewer_role !== assignment.reviewer_role ||
        !["CLOSED", "REOPEN"].includes(record?.decision)) {
      throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT_REQUIREMENT_INVALID:${assignment.requirement_id}`);
    }
    buildIndependentReviewFalsificationProbeCommand({
      traceabilityPath: context.traceabilityPath,
      inspectionNonce: context.inspectionNonce,
      requirementId: assignment.requirement_id,
      probe: record.falsification_probe,
    });
    if (typeof record.rationale !== "string" ||
        !record.rationale.toLocaleLowerCase("en").includes(record.falsification_probe.literal.toLocaleLowerCase("en")) ||
        !record.rationale.toLocaleLowerCase("en").includes(record.falsification_probe.replacement.toLocaleLowerCase("en"))) {
      throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT_PROBE_RATIONALE_UNBOUND:${assignment.requirement_id}`);
    }
    const checks = expectedStructuredReviewChecks({
      document: context.document,
      requirementId: assignment.requirement_id,
      reviewInputs: context.reviewInputs,
    });
    if (stableReviewStringify(record.evidence_checked) !== stableReviewStringify(checks.evidenceChecked) ||
        stableReviewStringify(record.adversarial_checks) !== stableReviewStringify(checks.adversarialChecks)) {
      throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT_CHECK_RECEIPTS_INVALID:${assignment.requirement_id}`);
    }
  }
  const derived = finalVerdict.requirements.every((record) => record.decision === "CLOSED") ? "CLOSED" : "REOPEN";
  if (derived !== finalVerdict.overall_decision) {
    throw new Error("INDEPENDENT_REVIEW_FINAL_VERDICT_OVERALL_NOT_DERIVED");
  }
}

async function assertRawSemanticReviewEvidence({
  events,
  finalVerdict,
  document,
  documentPath,
  traceabilityPath,
  requirementIds,
  inspectionNonce,
  inspectionCommands,
  inspectionReceipt,
  sourceFingerprint,
  prompt,
}) {
  if (events.some((event) => event?.item?.type === "command_execution" &&
      (event.item?.status === "failed" || (Number.isInteger(event.item?.exit_code) && event.item.exit_code !== 0)))) {
    throw new Error("INDEPENDENT_REVIEW_RAW_COMMAND_FAILED");
  }
  const completed = events.filter((event) => event?.item?.type === "command_execution" &&
    event.item?.status === "completed" && event.item?.exit_code === 0 && typeof event.item?.command === "string");
  if (completed.length !== requirementIds.length + inspectionCommands.length) {
    throw new Error("INDEPENDENT_REVIEW_RAW_COMMAND_SET_INVALID");
  }
  const inspection = inspectionCommands.map((command, chunkIndex) => {
    const matches = completed.filter((event) =>
      independentReviewCommandMatchesExpected(event.item.command, command));
    if (matches.length !== 1) throw new Error(`INDEPENDENT_REVIEW_RAW_INSPECTION_MISSING:${chunkIndex}`);
    let actual;
    try {
      actual = JSON.parse(matches[0].item.aggregated_output?.trim() ?? "");
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_RAW_INSPECTION_INVALID:${chunkIndex}`);
    }
    const expected = createIndependentReviewInputChunkReceipt(inspectionReceipt, chunkIndex);
    if (stableReviewStringify(actual) !== stableReviewStringify(expected)) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_INSPECTION_CONTENT_DIVERGED:${chunkIndex}`);
    }
    return matches[0];
  });
  const inspectionIndices = inspection.map((event) => events.indexOf(event));
  if (inspectionIndices.some((index, position) => position > 0 && index <= inspectionIndices[position - 1])) {
    throw new Error("INDEPENDENT_REVIEW_RAW_INSPECTION_ORDER_INVALID");
  }
  const finalMessageIndex = events.findLastIndex((event) => event?.item?.type === "agent_message");
  const inspectionIndex = events.indexOf(inspection.at(-1));
  const nonces = new Set();
  for (const requirementId of requirementIds) {
    const record = finalVerdict.requirements.find((item) => item.requirement_id === requirementId);
    const probe = record?.falsification_probe;
    if (!probe || nonces.has(probe.probe_nonce) || prompt.includes(probe.probe_nonce)) {
      throw new Error(`INDEPENDENT_REVIEW_FALSIFICATION_PROBE_NOT_FRESH:${requirementId}`);
    }
    nonces.add(probe.probe_nonce);
    const command = buildIndependentReviewFalsificationProbeCommand({
      traceabilityPath,
      inspectionNonce,
      requirementId,
      probe,
    });
    const matches = completed.filter((event) =>
      independentReviewCommandMatchesExpected(event.item.command, command));
    if (matches.length !== 1 || events.indexOf(matches[0]) <= inspectionIndex ||
        events.indexOf(matches[0]) >= finalMessageIndex) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_FALSIFICATION_PROBE_MISSING:${requirementId}`);
    }
    const expectedReceipt = await createIndependentReviewFalsificationProbeReceipt({
      document,
      requirementId,
      repoRoot,
      documentPath,
      sourceFingerprint,
      inspectionNonce,
      probe,
    });
    let actualReceipt;
    try {
      actualReceipt = JSON.parse(matches[0].item.aggregated_output?.trim() ?? "");
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_RAW_FALSIFICATION_PROBE_INVALID:${requirementId}`);
    }
    if (stableReviewStringify(actualReceipt) !== stableReviewStringify(expectedReceipt) ||
        (record.decision === "CLOSED" && expectedReceipt.expectation_met !== true)) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_FALSIFICATION_PROBE_DIVERGED:${requirementId}`);
    }
  }
  const completion = events.filter((event) => event?.type === "turn.completed");
  if (completion.length !== 1 || !Number.isInteger(completion[0]?.usage?.input_tokens) ||
      !Number.isInteger(completion[0]?.usage?.output_tokens) || completion[0].usage.input_tokens <= 1 ||
      completion[0].usage.output_tokens <= 1) {
    throw new Error("INDEPENDENT_REVIEW_RAW_USAGE_TRIVIAL");
  }
}

async function runReviewer({ codexPath, command, prompt }) {
  const startedAt = new Date().toISOString();
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error("INDEPENDENT_REVIEW_CODEX_PROCESS_ID_MISSING");
  const reviewerProcessId = child.pid;
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${prompt}\n`);
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal, error: null }));
  });
  clearTimeout(timeout);
  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    reviewerProcessId,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    ...outcome,
  };
  if (result.exitCode !== 0) {
    throw new Error(`INDEPENDENT_REVIEW_CODEX_FAILED:${result.exitCode ?? result.signal ?? result.error ?? "unknown"}`);
  }
  return result;
}

async function rawArtifact(path, evidenceDirectory, artifactType) {
  const content = await readFile(path);
  return {
    artifact_type: artifactType,
    path: relative(evidenceDirectory, path),
    sha256: reviewSha256(content),
    size_bytes: content.length,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const traceabilityRelative = relative(repoRoot, options.documentPath);
  if (!traceabilityRelative || traceabilityRelative === ".." || traceabilityRelative.startsWith(`..${sep}`) ||
      isAbsolute(traceabilityRelative)) {
    throw new Error("INDEPENDENT_REVIEW_TRACEABILITY_MUST_BE_INSIDE_REPOSITORY");
  }
  const reviewArtifactRelative = relative(dirname(options.documentPath), options.evidencePath);
  if (!reviewArtifactRelative || reviewArtifactRelative === ".." ||
      reviewArtifactRelative.startsWith(`..${sep}`) || isAbsolute(reviewArtifactRelative)) {
    throw new Error("INDEPENDENT_REVIEW_EVIDENCE_MUST_BE_INSIDE_TRACEABILITY_BOUNDARY");
  }
  const document = JSON.parse(await readFile(options.documentPath, "utf8"));
  const requestedRequirements = options.requirementIds.map((requirementId) => {
    const requirement = document.requirements?.find((item) => item?.requirement_id === requirementId);
    if (!requirement) throw new Error(`INDEPENDENT_REVIEW_REQUIREMENT_NOT_FOUND:${requirementId}`);
    if (requirement.status !== "FIXED_PENDING_REVIEW") {
      throw new Error(`INDEPENDENT_REVIEW_REQUIREMENT_NOT_READY:${requirementId}:${requirement.status}`);
    }
    return {
      requirement_id: requirementId,
      implementation_owner: requirement.implementation_owner,
      reviewer_role: requirement.reviewer,
    };
  });
  const evidenceDirectory = dirname(options.evidencePath);
  const rawDirectory = resolve(
    evidenceDirectory,
    `${basename(options.evidencePath, ".json")}.raw`,
  );
  await mkdir(rawDirectory, { recursive: true });
  const eventsPath = resolve(rawDirectory, "codex-events.jsonl");
  const stderrPath = resolve(rawDirectory, "codex-stderr.log");
  const finalVerdictPath = resolve(rawDirectory, "final-verdict.json");
  const invocationPath = resolve(rawDirectory, "invocation.json");

  for (const outputPath of [options.evidencePath, eventsPath, stderrPath, finalVerdictPath, invocationPath]) {
    try {
      await access(outputPath);
      throw new Error(`INDEPENDENT_REVIEW_OUTPUT_ALREADY_EXISTS:${outputPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("INDEPENDENT_REVIEW_OUTPUT_ALREADY_EXISTS:")) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const sourceBefore = await fingerprintAcceptanceSource(repoRoot);
  const reviewSubjectSha256 = independentReviewSubjectSha256(document, options.requirementIds);
  const reviewInputsBefore = await fingerprintIndependentReviewInputs({
    document,
    requirementIds: options.requirementIds,
    repoRoot,
    documentPath: options.documentPath,
  });
  const implementationExecutionId = `controller-process:${process.pid}:run:${randomUUID()}`;
  const inspectionNonce = randomBytes(16).toString("hex");
  const inspectionReceipt = await createIndependentReviewInputReceipt({
    document,
    requirementIds: options.requirementIds,
    repoRoot,
    documentPath: options.documentPath,
    sourceFingerprint: sourceBefore.sha256,
    nonce: inspectionNonce,
  });
  const inspectionCommands = buildIndependentReviewInspectionCommands({
    traceabilityPath: traceabilityRelative,
    nonce: inspectionNonce,
    requirementIds: options.requirementIds,
    chunkCount: inspectionReceipt.content_chunk_count,
  });
  const prompt = buildIndependentReviewPrompt({
    implementationExecutionId,
    sourceFingerprint: sourceBefore.sha256,
    reviewSubjectSha256,
    reviewInputsSha256: reviewInputsBefore.sha256,
    inspectionCommands,
    traceabilityPath: traceabilityRelative,
    requestedRequirements,
  });
  const codexPath = await resolveCodexExecutable();
  const codexExecutableSha256 = reviewSha256(await readFile(codexPath));
  const version = await codexVersion(codexPath);
  const command = buildIndependentReviewCodexCommand({
    codexPath,
    repoRoot,
    outputSchemaPath,
    finalVerdictPath,
  });
  const run = await runReviewer({ codexPath, command, prompt });
  await Promise.all([
    atomicWrite(eventsPath, run.stdout),
    atomicWrite(stderrPath, run.stderr.length > 0 ? run.stderr : Buffer.from("<empty>\n", "utf8")),
  ]);
  const events = parseJsonLines(run.stdout);
  const threadId = reviewerThreadId(events);
  const reviewerExecutionId = `codex-thread:${threadId}:pid:${run.reviewerProcessId}`;
  if (reviewerExecutionId === implementationExecutionId || run.reviewerProcessId === process.pid) {
    throw new Error("INDEPENDENT_REVIEW_EXECUTION_IDENTITY_COLLISION");
  }
  const finalVerdict = JSON.parse(await readFile(finalVerdictPath, "utf8"));
  assertFinalVerdict(finalVerdict, {
    implementationExecutionId,
    sourceFingerprint: sourceBefore.sha256,
    reviewSubjectSha256,
    reviewInputsSha256: reviewInputsBefore.sha256,
    requestedRequirements,
    document,
    reviewInputs: reviewInputsBefore,
    traceabilityPath: traceabilityRelative,
    inspectionNonce,
  });
  await assertRawSemanticReviewEvidence({
    events,
    finalVerdict,
    document,
    documentPath: options.documentPath,
    traceabilityPath: traceabilityRelative,
    requirementIds: options.requirementIds,
    inspectionNonce,
    inspectionCommands,
    inspectionReceipt,
    sourceFingerprint: sourceBefore.sha256,
    prompt,
  });
  const sourceAfter = await fingerprintAcceptanceSource(repoRoot);
  if (stableReviewStringify(sourceAfter) !== stableReviewStringify(sourceBefore)) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_CHANGED_DURING_RUN");
  }
  const reviewInputsAfter = await fingerprintIndependentReviewInputs({
    document,
    requirementIds: options.requirementIds,
    repoRoot,
    documentPath: options.documentPath,
  });
  if (stableReviewStringify(reviewInputsAfter) !== stableReviewStringify(reviewInputsBefore)) {
    throw new Error("INDEPENDENT_REVIEW_INPUTS_CHANGED_DURING_RUN");
  }
  const invocation = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_REVIEW",
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    exit_code: run.exitCode,
    controller_process_id: process.pid,
    reviewer_process_id: run.reviewerProcessId,
    implementation_execution_id: implementationExecutionId,
    traceability_path: traceabilityRelative,
    requested_requirements: requestedRequirements,
    source_fingerprint_before: sourceBefore,
    source_fingerprint_after: sourceAfter,
    review_subject_sha256: reviewSubjectSha256,
    review_inputs_before: reviewInputsBefore,
    review_inputs_after: reviewInputsAfter,
    inspection_nonce: inspectionNonce,
    inspection_commands: inspectionCommands,
    prompt,
    prompt_sha256: reviewSha256(prompt),
    output_schema: {
      path: relative(repoRoot, outputSchemaPath),
      sha256: reviewSha256(await readFile(outputSchemaPath)),
    },
    codex: {
      executable_path: codexPath,
      executable_sha256: codexExecutableSha256,
      version,
      command,
    },
  };
  await atomicWrite(invocationPath, stableJson(invocation));

  const rawArtifacts = await Promise.all([
    rawArtifact(eventsPath, evidenceDirectory, "CODEX_EVENTS_JSONL"),
    rawArtifact(stderrPath, evidenceDirectory, "CODEX_STDERR"),
    rawArtifact(finalVerdictPath, evidenceDirectory, "FINAL_VERDICT"),
    rawArtifact(invocationPath, evidenceDirectory, "INVOCATION"),
  ]);
  const capturedAt = new Date().toISOString();
  const generatorRelative = relative(repoRoot, scriptPath);
  const summary = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_REVIEW",
    captured_at: capturedAt,
    source_fingerprint: sourceBefore.sha256,
    review_subject_sha256: reviewSubjectSha256,
    review_inputs_sha256: reviewInputsBefore.sha256,
    implementation_execution_id: implementationExecutionId,
    reviewer_execution_id: reviewerExecutionId,
    decision: finalVerdict.overall_decision,
    generator: {
      kind: "INDEPENDENT_READ_ONLY_CODEX_REVIEW",
      command: `node ${generatorRelative}`,
      version: generatorVersion,
      executable_path: generatorRelative,
      executable_sha256: reviewSha256(await readFile(scriptPath)),
    },
    raw_artifacts: rawArtifacts,
    reviewed_requirement_ids: options.requirementIds,
  };
  await atomicWrite(options.evidencePath, stableJson(summary));
  const reviewArtifactSha256 = reviewSha256(await readFile(options.evidencePath));
  process.stdout.write(stableJson({
    status: finalVerdict.overall_decision === "CLOSED" ? "REVIEW_CLOSED_NOT_ATTACHED" : "REVIEW_REOPENED",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_REVIEW",
    evidence: options.evidencePath,
    review_artifact_sha256: reviewArtifactSha256,
    source_fingerprint: sourceBefore.sha256,
    review_subject_sha256: reviewSubjectSha256,
    review_inputs_sha256: reviewInputsBefore.sha256,
    implementation_execution_id: implementationExecutionId,
    reviewer_execution_id: reviewerExecutionId,
    reviewed_at: capturedAt,
    decision: finalVerdict.overall_decision,
    reviewed_requirement_ids: options.requirementIds,
    note: "This generator never mutates traceability status or closure fields.",
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
