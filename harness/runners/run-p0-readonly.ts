import { createServer as createNodeServer, type Server as NodeServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../../src/config.js";
import { InMemoryAccountingRepository } from "../../src/db/inMemoryRepository.js";
import type { AuditLog, ResolvedMcpAccessToken } from "../../src/domain/models.js";
import { createHttpApp } from "../../src/http/app.js";
import type { Logger } from "../../src/logging.js";
import { createAccountingMcpServer } from "../../src/mcp/createServer.js";
import type {
  CreditNoteListResult,
  InvoiceListResult,
  PaymentListResult,
} from "../../src/providers/types.js";
import { createOAuthRequestContext } from "../../src/security/requestContext.js";
import { hashObject } from "../../src/security/hash.js";
import { AccountingService } from "../../src/services/accountingService.js";
import { ConnectionTicketService } from "../../src/services/connectionTicketService.js";
import { XERO_RELEASE_VERSION } from "../../src/xeroRelease.js";
import {
  oracleRunSchema,
  type OracleCaseResult,
  type OracleResult,
  type OracleRunResult,
} from "../lib/oracleResultRuntimeSchema.js";
import {
  SYNTHETIC_CONNECTION_ID,
  SyntheticXeroAccountingProvider,
  type ProviderCallEvidence,
} from "../lib/syntheticXeroAccountingProvider.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const scenarioPath = resolve(repoRoot, "harness/scenarios/deterministic-contract.p0.json");
const fixturePath = resolve(repoRoot, "harness/fixtures/xero/synthetic-ledger.json");

const TARGET_CASE_IDS = [
  "DC-CONNECTION-001",
  "DC-LEDGER-002",
  "DC-HISTORY-003",
  "DC-MATCH-004",
  "DC-PAYMENT-005",
  "DC-CREDIT-006",
  "DC-VERSION-008",
] as const;

const PINNED_TOOL_SURFACE = [
  "xero_connection_status",
  "xero_start_organisation_switch",
  "xero_get_organisation",
  "xero_list_accounts",
  "xero_list_tax_rates",
  "xero_list_contacts",
  "xero_get_contact",
  "xero_search_contacts",
  "xero_prepare_contact_create",
  "xero_create_contact",
  "xero_prepare_contact_update",
  "xero_update_contact",
  "xero_list_invoices",
  "xero_list_credit_notes",
  "xero_prepare_credit_note_draft",
  "xero_create_credit_note_draft",
  "xero_list_payments",
  "xero_list_quotes",
  "xero_get_quote",
  "xero_list_purchase_orders",
  "xero_get_purchase_order",
  "xero_list_manual_journals",
  "xero_get_manual_journal",
  "xero_prepare_manual_journal_draft",
  "xero_create_manual_journal_draft",
  "xero_list_items",
  "xero_get_item",
  "xero_prepare_item_create",
  "xero_create_item",
  "xero_prepare_item_update",
  "xero_update_item",
  "xero_list_bank_transactions",
  "xero_get_bank_transaction",
  "xero_get_invoice",
  "xero_get_supplier_bill",
  "xero_prepare_supplier_bill_draft",
  "xero_create_draft_supplier_bill",
  "xero_prepare_sales_invoice_draft",
  "xero_create_draft_sales_invoice",
  "xero_prepare_quote_draft",
  "xero_create_quote_draft",
  "xero_prepare_purchase_order_draft",
  "xero_create_purchase_order_draft",
  "xero_get_trial_balance",
] as const;

type JsonObject = Record<string, unknown>;
type EvidenceKind = "TOOL_CALL" | "TOOL_OUTPUT" | "PROVIDER_CALL" | "REPOSITORY_STATE" | "NETWORK_RECEIPT" | "STATE_PROBE";

interface ScenarioStep {
  id: string;
  action: "MCP_CALL" | "STATE_PROBE" | "FAULT_INJECTION";
  tool?: string;
  input?: JsonObject;
  fault_profile?: string;
}

interface ScenarioCase {
  id: string;
  title: string;
  personas: string[];
  steps: ScenarioStep[];
  baseline_expectation: "PASS" | "EXPECTED_RED";
  expected_red_ref?: string;
}

interface ScenarioManifest {
  schema_version: string;
  suite_id: string;
  layer: "DETERMINISTIC_CONTRACT";
  cases: ScenarioCase[];
}

interface EvidenceRecord {
  schema_version: "1.0";
  run_id: string;
  evidence_id: string;
  case_id: string;
  kind: EvidenceKind;
  label: string;
  captured_at: string;
  payload: unknown;
}

interface ToolExecution {
  stepId: string;
  tool: string;
  input: JsonObject;
  isError: boolean;
  callToolResult?: CallToolResult;
  modelText?: string;
  structuredContent: unknown;
  result: unknown;
  evidenceRefs: string[];
  providerCalls: ProviderCallEvidence[];
  audits: AuditLog[];
}

interface HttpVersionReceipt {
  health: { status: number; body: unknown };
  readiness: { status: number; body: unknown };
}

export interface ExecuteP0ReadOnlyOptions {
  runId?: string;
  outputDirectory?: string;
  writeArtifacts?: boolean;
}

export interface ExecuteP0ReadOnlyResult {
  report: OracleRunResult;
  evidence: EvidenceRecord[];
  providerWriteAttempts: number;
  artifactPaths?: {
    oracleResults: string;
    evidence: string;
    summary: string;
  };
}

class EvidenceCollector {
  readonly records: EvidenceRecord[] = [];
  readonly #runId: string;

  constructor(runId: string) {
    this.#runId = runId;
  }

  add(caseId: string, kind: EvidenceKind, label: string, payload: unknown): string {
    const evidenceId = `ev_${String(this.records.length + 1).padStart(5, "0")}`;
    this.records.push({
      schema_version: "1.0",
      run_id: this.#runId,
      evidence_id: evidenceId,
      case_id: caseId,
      kind,
      label,
      captured_at: new Date().toISOString(),
      payload: evidencePayload(payload),
    });
    return `evidence.jsonl#${evidenceId}`;
  }
}

function evidencePayload(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= 64 * 1_024) return value;
  const candidate = value as {
    callToolResult?: CallToolResult;
    structuredContent?: { result?: { rows?: unknown[]; pagination?: unknown } };
  };
  let parsedTextResult: { rows?: unknown[]; pagination?: unknown } | undefined;
  const textBlock = candidate.callToolResult?.content.find((block) => block.type === "text");
  if (textBlock?.type === "text") {
    try {
      parsedTextResult = (JSON.parse(textBlock.text) as { result?: typeof parsedTextResult }).result;
    } catch {
      parsedTextResult = undefined;
    }
  }
  const result = candidate?.structuredContent?.result ?? parsedTextResult;
  return {
    response_sha256: hashObject(value),
    response_bytes: Buffer.byteLength(serialized, "utf8"),
    call_tool_result_bytes: candidate.callToolResult
      ? Buffer.byteLength(JSON.stringify(candidate.callToolResult), "utf8")
      : undefined,
    row_count: Array.isArray(result?.rows) ? result.rows.length : undefined,
    pagination: result?.pagination,
    first_rows: Array.isArray(result?.rows) ? result.rows.slice(0, 3) : undefined,
    last_rows: Array.isArray(result?.rows) ? result.rows.slice(-3) : undefined,
    evidence_note: "Large deterministic output summarized with a stable hash and boundary metadata.",
  };
}

function noOpLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function readOnlyResolvedToken(tenantId: string): ResolvedMcpAccessToken {
  const audience = "https://xero-mcp.p0-harness.invalid/mcp";
  return {
    tokenId: "token_p0_readonly_001",
    clientId: "agent2-p0-harness",
    resource: audience,
    audience,
    grantedScopes: ["xero.read"],
    issuedAt: new Date("2026-08-06T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "installation_p0_readonly_001",
    bindingId: "binding_p0_readonly_001",
    connectionId: SYNTHETIC_CONNECTION_ID,
    authorizationId: "authorization_p0_readonly_001",
    workspaceId: "workspace_p0_readonly",
    subjectType: "USER",
    subjectId: "accountant_p0_readonly",
    agentId: "agent_p0_readonly",
    policyId: "policy_p0_readonly",
    tenantId,
  };
}

function applicationConfig(tenantId: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1",
    databaseUrl: "postgres://synthetic.invalid/p0",
    mcpBearerToken: "p0-readonly-local-bearer-token-0001",
    allowedOrigins: ["https://agent2.p0-harness.invalid"],
    allowedHosts: ["127.0.0.1", "localhost"],
    requestBodyLimitBytes: 1_048_576,
    xero: {
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      redirectUri: "http://127.0.0.1/oauth/xero/callback",
      scopes: ["accounting.settings.read"],
    },
    xeroWriteEnabled: false,
    xeroAllowedTenantId: tenantId,
    tokenEncryptionKey: Buffer.alloc(32, 7),
    demoActorId: "p0-readonly-demo-actor",
    logLevel: "error",
  };
}

function valueObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function firstModelText(callToolResult: CallToolResult | undefined): string | undefined {
  if (!callToolResult) return undefined;
  const block = callToolResult.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function callToolPayload(callToolResult: CallToolResult | undefined): unknown {
  if (!callToolResult) return undefined;
  if (callToolResult.structuredContent !== undefined) return callToolResult.structuredContent;
  const text = firstModelText(callToolResult);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toolResult(callToolResult: CallToolResult | undefined): unknown {
  return valueObject(callToolPayload(callToolResult))?.result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringSet(left: string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function oracle(
  oracleId: string,
  passed: boolean,
  observed: unknown,
  evidenceRefs: string[],
  message: string,
): OracleResult {
  return {
    oracle_id: oracleId,
    strength: "HARD",
    status: passed ? "PASS" : "FAIL",
    observed: observed === undefined ? null : observed,
    evidence_refs: unique(evidenceRefs),
    message,
  };
}

function finalizeCase(options: {
  scenario: ScenarioCase;
  oracleResults: OracleResult[];
  evidenceRefs: string[];
  notes?: string;
}): OracleCaseResult {
  const hardGatePassed = options.oracleResults.every((result) => result.status === "PASS");
  const actualStatus = hardGatePassed ? "PASS" : "FAIL";
  const expectedRedObserved = options.scenario.baseline_expectation === "EXPECTED_RED" && actualStatus === "FAIL";
  return {
    case_id: options.scenario.id,
    persona_id: options.scenario.personas[0] ?? "protocol_security_agent",
    repeat_index: 1,
    baseline_expectation: options.scenario.baseline_expectation,
    actual_status: actualStatus,
    hard_gate_passed: hardGatePassed,
    expected_red_observed: expectedRedObserved,
    oracle_results: options.oracleResults,
    evidence_refs: unique([...options.evidenceRefs, ...options.oracleResults.flatMap((result) => result.evidence_refs)]),
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

function recursiveContainsTenantSelector(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(recursiveContainsTenantSelector);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["tenant_id", "tenantId", "organisation_id", "organisationId"].includes(key) || recursiveContainsTenantSelector(child));
}

function numericTotal(rows: unknown[], key: string): number {
  return rows.reduce<number>((total, row) => {
    const raw = valueObject(row)?.[key];
    const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
    return total + (Number.isFinite(parsed) ? parsed : Number.NaN);
  }, 0);
}

function trialBalanceBody(value: unknown): JsonObject | undefined {
  const direct = valueObject(value);
  if (!direct) return undefined;
  const nested = valueObject(direct.report);
  return nested ?? direct;
}

const PINNED_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES = 96 * 1_024;
const PINNED_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES = 128 * 1_024;
const PINNED_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES = 5_000;
const PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES = 1 * 1_024 * 1_024;
const PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES = 20_000;
const PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_NESTING_DEPTH = 256;

/** Independently reserializes the actual MCP result; no byte/completeness claim is trusted. */
export function meaningfulTrialBalanceBound(callToolResult: unknown): { passed: boolean; observed: JsonObject } {
  const callResult = valueObject(callToolResult);
  if (!callResult) return { passed: false, observed: { callToolResultPresent: false } };
  const content = Array.isArray(callResult.content) ? callResult.content : [];
  const textBlocks = content.filter((candidate) => valueObject(candidate)?.type === "text");
  const modelText = textBlocks.length === 1 ? valueObject(textBlocks[0])?.text : undefined;
  const contentOnly = content.length === 1 && typeof modelText === "string" &&
    !Object.hasOwn(callResult, "structuredContent");
  const actualModelTextUtf8Bytes = typeof modelText === "string"
    ? Buffer.byteLength(modelText, "utf8")
    : Number.NaN;
  let actualCallToolResultUtf8Bytes = Number.NaN;
  try {
    actualCallToolResultUtf8Bytes = Buffer.byteLength(JSON.stringify(callResult), "utf8");
  } catch {
    actualCallToolResultUtf8Bytes = Number.NaN;
  }
  let payload: JsonObject | undefined;
  if (typeof modelText === "string") {
    try {
      payload = valueObject(JSON.parse(modelText));
    } catch {
      payload = undefined;
    }
  }
  const body = valueObject(payload?.result);
  const pagination = valueObject(body?.pagination);
  if (!pagination) {
    return {
      passed: false,
      observed: {
        callToolResultPresent: true,
        contentOnly,
        paginationPresent: false,
        actualModelTextUtf8Bytes: Number.isFinite(actualModelTextUtf8Bytes) ? actualModelTextUtf8Bytes : null,
        actualCallToolResultUtf8Bytes: Number.isFinite(actualCallToolResultUtf8Bytes)
          ? actualCallToolResultUtf8Bytes
          : null,
      },
    };
  }

  const sourceMeasurement = valueObject(pagination.sourceMeasurement);
  const sourceUtf8Bytes = valueObject(sourceMeasurement?.utf8Bytes);
  const sourceVisitedJsonNodes = valueObject(sourceMeasurement?.visitedJsonNodes);
  const providerCompleteness = valueObject(pagination.providerCompleteness);
  const declaredModelBytes = pagination.modelTextUtf8Bytes;
  const declaredCallBytes = pagination.callToolResultUtf8Bytes;
  const returnedNodes = pagination.returnedVisitedJsonNodes;
  const reasons = Array.isArray(pagination.truncationReasons)
    ? pagination.truncationReasons.map(String)
    : [];
  const contractPinned = pagination.contractVersion === "2.0" &&
    pagination.maxModelTextUtf8Bytes === PINNED_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES &&
    pagination.maxCallToolResultUtf8Bytes === PINNED_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES &&
    pagination.maxReturnedVisitedJsonNodes === PINNED_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES;
  const independentlyMeasuredBudgets = contentOnly &&
    Number.isFinite(actualModelTextUtf8Bytes) &&
    Number.isFinite(actualCallToolResultUtf8Bytes) &&
    actualModelTextUtf8Bytes <= PINNED_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES &&
    actualCallToolResultUtf8Bytes <= PINNED_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES &&
    declaredModelBytes === actualModelTextUtf8Bytes &&
    declaredCallBytes === actualCallToolResultUtf8Bytes;
  const validVisitedNodeBound = typeof returnedNodes === "number" &&
    Number.isInteger(returnedNodes) &&
    returnedNodes >= 0 &&
    returnedNodes <= PINNED_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES &&
    typeof pagination.visitedJsonNodeDefinition === "string" &&
    pagination.visitedJsonNodeDefinition.includes("not a Xero report-row count");
  const sourceLimitsPinned = sourceMeasurement?.maxInspectedUtf8Bytes ===
      PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES &&
    sourceMeasurement?.maxInspectedJsonNodes === PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES &&
    sourceMeasurement?.maxInspectedNestingDepth === PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_NESTING_DEPTH &&
    typeof sourceMeasurement?.inspectedJsonNodes === "number" &&
    sourceMeasurement.inspectedJsonNodes >= 0 &&
    sourceMeasurement.inspectedJsonNodes <= PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES &&
    typeof sourceUtf8Bytes?.value === "number" && sourceUtf8Bytes.value >= 0 &&
    sourceUtf8Bytes.value <= PINNED_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES &&
    typeof sourceVisitedJsonNodes?.value === "number" && sourceVisitedJsonNodes.value >= 0 &&
    sourceVisitedJsonNodes.value <= sourceMeasurement.inspectedJsonNodes;
  const exactSource = sourceMeasurement?.status === "EXACT" &&
    sourceUtf8Bytes?.relation === "EXACT" &&
    sourceVisitedJsonNodes?.relation === "EXACT" &&
    Array.isArray(sourceMeasurement.stopReasons) && sourceMeasurement.stopReasons.length === 0;
  const boundedLowerSource = sourceMeasurement?.status === "LOWER_BOUND" &&
    sourceMeasurement.serialization === "NOT_FULLY_INSPECTED" &&
    sourceUtf8Bytes?.relation === "AT_LEAST" &&
    sourceVisitedJsonNodes?.relation === "AT_LEAST" &&
    Array.isArray(sourceMeasurement.stopReasons) && sourceMeasurement.stopReasons.length > 0 &&
    pagination.mcpTruncated === true && reasons.includes("SOURCE_INSPECTION_LIMIT");
  const honestSourceMeasurement = sourceLimitsPinned && (exactSource || boundedLowerSource);
  const validTruncation = typeof pagination.mcpTruncated === "boolean" &&
    (pagination.mcpTruncated ? reasons.length > 0 : reasons.length === 0);
  const honestProviderCompleteness = providerCompleteness?.status === "NOT_VERIFIED" &&
    providerCompleteness.scope === "SINGLE_XERO_PROVIDER_RESPONSE" &&
    providerCompleteness.auditCompleteness === "NOT_ESTABLISHED" &&
    typeof providerCompleteness.statement === "string" &&
    providerCompleteness.statement.includes("do not prove");
  const passed = contractPinned && independentlyMeasuredBudgets && validVisitedNodeBound &&
    honestSourceMeasurement && validTruncation && honestProviderCompleteness;
  return {
    passed,
    observed: {
      callToolResultPresent: true,
      paginationPresent: true,
      contentOnly,
      structuredContentPresent: Object.hasOwn(callResult, "structuredContent"),
      actualModelTextUtf8Bytes: Number.isFinite(actualModelTextUtf8Bytes) ? actualModelTextUtf8Bytes : null,
      declaredModelTextUtf8Bytes: declaredModelBytes ?? null,
      actualCallToolResultUtf8Bytes: Number.isFinite(actualCallToolResultUtf8Bytes)
        ? actualCallToolResultUtf8Bytes
        : null,
      declaredCallToolResultUtf8Bytes: declaredCallBytes ?? null,
      returnedVisitedJsonNodes: returnedNodes ?? null,
      mcpTruncated: pagination.mcpTruncated ?? null,
      truncationReasons: reasons,
      sourceMeasurement: sourceMeasurement ?? null,
      providerCompleteness: providerCompleteness ?? null,
      contractPinned,
      independentlyMeasuredBudgets,
      validVisitedNodeBound,
      honestSourceMeasurement,
      validTruncation,
      honestProviderCompleteness,
    },
  };
}

async function listen(app: ReturnType<typeof createHttpApp>): Promise<NodeServer> {
  return new Promise((resolveListen, reject) => {
    const server = createNodeServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

async function closeServer(server: NodeServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function captureHttpVersionReceipt(options: {
  config: AppConfig;
  repository: InMemoryAccountingRepository;
  service: AccountingService;
  connectionTickets: ConnectionTicketService;
}): Promise<HttpVersionReceipt> {
  const app = createHttpApp({
    config: options.config,
    repository: options.repository,
    accountingService: options.service,
    oauthService: {} as never,
    reviewService: {} as never,
    connectionTickets: options.connectionTickets,
    logger: noOpLogger(),
  });
  const server = await listen(app);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local HTTP harness did not bind an address.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [healthResponse, readinessResponse] = await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
    ]);
    return {
      health: { status: healthResponse.status, body: await healthResponse.json() },
      readiness: { status: readinessResponse.status, body: await readinessResponse.json() },
    };
  } finally {
    await closeServer(server);
  }
}

async function executeTool(options: {
  scenario: ScenarioCase;
  step: ScenarioStep;
  client: Client;
  provider: SyntheticXeroAccountingProvider;
  repository: InMemoryAccountingRepository;
  evidence: EvidenceCollector;
  overrideTool?: string;
  overrideInput?: JsonObject;
}): Promise<ToolExecution> {
  const tool = options.overrideTool ?? options.step.tool;
  const input = options.overrideInput ?? options.step.input ?? {};
  if (!tool) throw new Error(`Scenario ${options.scenario.id}/${options.step.id} has no executable tool.`);
  const callRef = options.evidence.add(options.scenario.id, "TOOL_CALL", `${options.step.id}:${tool}`, {
    tool,
    input,
    input_sha256: hashObject(input),
  });
  const providerStart = options.provider.calls.length;
  const auditStart = options.repository.audits.length;
  let callToolResult: CallToolResult | undefined;
  let structuredContent: unknown;
  let modelText: string | undefined;
  let isError = false;
  let thrown: unknown;
  try {
    callToolResult = await options.client.callTool({ name: tool, arguments: input });
    structuredContent = callToolResult.structuredContent;
    modelText = firstModelText(callToolResult);
    isError = callToolResult.isError === true;
  } catch (error) {
    isError = true;
    thrown = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  }
  const outputRef = options.evidence.add(options.scenario.id, "TOOL_OUTPUT", `${options.step.id}:${tool}`, {
    tool,
    isError,
    ...(thrown ? { thrown } : {}),
    callToolResult,
    modelTextUtf8Bytes: modelText === undefined ? undefined : Buffer.byteLength(modelText, "utf8"),
    structuredContent,
  });
  const providerCalls = options.provider.calls.slice(providerStart);
  const providerRef = options.evidence.add(options.scenario.id, "PROVIDER_CALL", `${options.step.id}:provider-calls`, {
    calls: providerCalls,
    providerWriteAttempts: options.provider.writeAttempts,
  });
  const audits = options.repository.audits.slice(auditStart);
  const auditRef = options.evidence.add(options.scenario.id, "REPOSITORY_STATE", `${options.step.id}:audit-records`, {
    audits,
  });
  return {
    stepId: options.step.id,
    tool,
    input,
    isError,
    ...(callToolResult ? { callToolResult } : {}),
    ...(modelText ? { modelText } : {}),
    structuredContent,
    result: toolResult(callToolResult),
    evidenceRefs: [callRef, outputRef, providerRef, auditRef],
    providerCalls,
    audits,
  };
}

function successfulManifestSteps(scenario: ScenarioCase, executions: Map<string, ToolExecution>): OracleResult {
  const expectedIds = scenario.steps.filter((step) => step.action === "MCP_CALL" || step.action === "FAULT_INJECTION")
    .map((step) => step.id);
  const observed = expectedIds.map((stepId) => ({
    stepId,
    executed: executions.has(stepId),
    isError: executions.get(stepId)?.isError ?? null,
  }));
  const passed = observed.every((item) => item.executed && item.isError === false);
  return oracle(
    "tool_execution_success",
    passed,
    observed,
    expectedIds.flatMap((stepId) => executions.get(stepId)?.evidenceRefs ?? []),
    passed ? "Every manifest MCP step returned successful model-visible MCP evidence." : "At least one manifest MCP step was missing or errored.",
  );
}

function evaluateConnection(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
  listTools: string[];
  listToolsRef: string;
  provider: SyntheticXeroAccountingProvider;
  tenantId: string;
  writeProbe: ToolExecution;
}): OracleCaseResult {
  const status = valueObject(options.executions.get("connection_status")?.result);
  const organisation = valueObject(options.executions.get("get_organisation")?.result);
  const refs = [...options.executions.values()].flatMap((execution) => execution.evidenceRefs);
  const providerCalls = [...options.executions.values()].flatMap((execution) => execution.providerCalls);
  const inputHasTenantSelector = [...options.executions.values()].some((execution) => recursiveContainsTenantSelector(execution.input));
  const bindingObserved = providerCalls.map((call) => ({
    method: call.method,
    tenantId: call.boundTenantId,
    connectionId: call.principal.connectionId,
    legacyDemo: call.principal.legacyDemo,
  }));
  const bindingPassed = bindingObserved.length > 0 && bindingObserved.every((call) =>
    call.tenantId === options.tenantId && call.connectionId === SYNTHETIC_CONNECTION_ID && call.legacyDemo === false);
  const scopes = Array.isArray(status?.scopes) ? status.scopes.map(String) : [];
  const writeBlocked = options.writeProbe.isError &&
    (JSON.stringify(options.writeProbe.structuredContent) ?? "").includes("xero.draft.write") &&
    options.writeProbe.providerCalls.every((call) => call.method !== "createDraftSupplierBill") &&
    options.provider.writeAttempts === 0;
  const oracleResults = [
    oracle("exact_43_tools", sameStringSet(options.listTools, PINNED_TOOL_SURFACE), options.listTools, [options.listToolsRef], "tools/list must equal the independent pinned 43-tool surface."),
    oracle("connected_true", status?.connected === true, status?.connected ?? null, options.executions.get("connection_status")?.evidenceRefs ?? [], "Connection status must be true from parsed model-visible MCP output."),
    oracle("write_scope_absent", scopes.includes("xero.draft.write") === false && sameStringSet(scopes, ["xero.read"]), scopes, options.executions.get("connection_status")?.evidenceRefs ?? [], "The bound installation must expose only xero.read."),
    oracle("exact_org_id", organisation?.organisationId === options.tenantId, organisation?.organisationId ?? null, options.executions.get("get_organisation")?.evidenceRefs ?? [], "Organisation output must match the server-bound synthetic tenant."),
    oracle("provider_binding_exact", bindingPassed, bindingObserved, refs, "Every Provider call must use the OAuth connection binding and one exact tenant."),
    oracle("no_tenant_parameter", !inputHasTenantSelector, { inputHasTenantSelector }, refs, "No MCP tool input may select a tenant or organisation."),
    oracle("read_scope_blocks_schema_valid_write", writeBlocked, {
      isError: options.writeProbe.isError,
      providerWriteAttempts: options.provider.writeAttempts,
      providerMethods: options.writeProbe.providerCalls.map((call) => call.method),
    }, options.writeProbe.evidenceRefs, "A schema-valid confirmed DRAFT must fail at the read-only scope before any Provider write."),
  ];
  return finalizeCase({
    scenario: options.scenario,
    oracleResults,
    evidenceRefs: [...refs, ...options.writeProbe.evidenceRefs, options.listToolsRef],
  });
}

function evaluateLedger(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
  fixture: JsonObject;
}): OracleCaseResult {
  const accounts = options.executions.get("list_expense_accounts")?.result;
  const taxRates = options.executions.get("list_tax_rates")?.result;
  const normal = trialBalanceBody(options.executions.get("trial_balance_normal")?.result);
  const pressureExecution = options.executions.get("trial_balance_pressure");
  const normalRows = Array.isArray(normal?.rows) ? normal.rows : [];
  const fixtureTb = valueObject(options.fixture.trialBalance);
  const expectedDebit = Number.parseFloat(String(fixtureTb?.totalDebit ?? "NaN"));
  const expectedCredit = Number.parseFloat(String(fixtureTb?.totalCredit ?? "NaN"));
  const actualDebit = numericTotal(normalRows, "debit");
  const actualCredit = numericTotal(normalRows, "credit");
  const bounds = meaningfulTrialBalanceBound(pressureExecution?.callToolResult);
  const pressureCall = pressureExecution?.providerCalls
    .find((call) => call.method === "getTrialBalance");
  const rawPressureCount = pressureCall?.outputEvidence?.rawRowCount;
  const accountsArray = Array.isArray(accounts) ? accounts : [];
  const taxArray = Array.isArray(taxRates) ? taxRates : [];
  const refs = [...options.executions.values()].flatMap((execution) => execution.evidenceRefs);
  const oracleResults = [
    successfulManifestSteps(options.scenario, options.executions),
    oracle("expense_filter_exact", accountsArray.length > 0 && accountsArray.every((account) => valueObject(account)?.class === "EXPENSE"), accountsArray.map((account) => valueObject(account)?.class ?? null), options.executions.get("list_expense_accounts")?.evidenceRefs ?? [], "Production service filtering must return only EXPENSE accounts."),
    oracle("none_tax_present", taxArray.some((tax) => valueObject(tax)?.taxType === "NONE"), taxArray.map((tax) => valueObject(tax)?.taxType ?? null), options.executions.get("list_tax_rates")?.evidenceRefs ?? [], "The exact NONE tax type must remain present."),
    oracle("tb_balances", normalRows.length > 0 && actualDebit === expectedDebit && actualCredit === expectedCredit && actualDebit === actualCredit, {
      rowCount: normalRows.length,
      actualDebit: actualDebit.toFixed(2),
      actualCredit: actualCredit.toFixed(2),
      expectedDebit: Number.isFinite(expectedDebit) ? expectedDebit.toFixed(2) : null,
      expectedCredit: Number.isFinite(expectedCredit) ? expectedCredit.toFixed(2) : null,
    }, options.executions.get("trial_balance_normal")?.evidenceRefs ?? [], "Returned Trial Balance rows must independently sum to equal debit and credit totals."),
    oracle("pressure_fixture_5000_rows", rawPressureCount === 5_000, { rawPressureCount: rawPressureCount ?? null }, options.executions.get("trial_balance_pressure")?.evidenceRefs ?? [], "The Provider must supply the full 5,000-row pressure fixture before production bounding."),
    oracle("tb_explicit_bound", bounds.passed, bounds.observed, pressureExecution?.evidenceRefs ?? [], "The independently reserialized content-only MCP result must satisfy the model-text, complete CallToolResult, visited-node, source-inspection, truncation, and completeness contracts."),
    oracle("tb_not_claimed_complete_without_bound", bounds.passed, bounds.observed, pressureExecution?.evidenceRefs ?? [], "A pressure report cannot pass when byte metadata is self-reported, structured output is duplicated, source inspection is unbounded, or Provider/audit completeness is overstated."),
  ];
  return finalizeCase({
    scenario: options.scenario,
    oracleResults,
    evidenceRefs: refs,
    notes: bounds.passed
      ? "XR-005 was not observed: production Trial Balance bounding emitted explicit evidence."
      : "XR-005 observed and intentionally remains FAIL; no completeness claim is allowed.",
  });
}

function evaluateHistory(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
  tenantId: string;
}): OracleCaseResult {
  const page1 = options.executions.get("ap_page_1")?.result as InvoiceListResult | undefined;
  const page2 = options.executions.get("ap_page_2")?.result as InvoiceListResult | undefined;
  const payments1 = options.executions.get("payment_page_1")?.result as PaymentListResult | undefined;
  const payments2 = options.executions.get("payment_page_2")?.result as PaymentListResult | undefined;
  const exact = valueObject(options.executions.get("exact_bill")?.result);
  const invoiceIds = unique([...(page1?.invoices ?? []), ...(page2?.invoices ?? [])].map((invoice) => invoice.invoiceId));
  const paymentTypes = unique([...(payments1?.payments ?? []), ...(payments2?.payments ?? [])].map((payment) => payment.type));
  const requiredTypes = ["ACCPAYPAYMENT", "APCREDITPAYMENT", "APPREPAYMENTPAYMENT", "APOVERPAYMENTPAYMENT"];
  const refs = [...options.executions.values()].flatMap((execution) => execution.evidenceRefs);
  const oracleResults = [
    successfulManifestSteps(options.scenario, options.executions),
    oracle("ap_page_1_has_next", page1?.pagination.hasNextPage === true, page1?.pagination ?? null, options.executions.get("ap_page_1")?.evidenceRefs ?? [], "AP page 1 must explicitly prove another page exists."),
    oracle("ap_page_2_complete", page2?.pagination.hasNextPage === false, page2?.pagination ?? null, options.executions.get("ap_page_2")?.evidenceRefs ?? [], "AP page 2 must explicitly end the fixture history."),
    oracle("ap_two_page_aggregate", invoiceIds.length === 3 && [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
      "40000000-0000-4000-8000-000000000003",
    ].every((id) => invoiceIds.includes(id)), invoiceIds, refs, "Both pages must aggregate to the three unique synthetic AP bills."),
    oracle("payment_history_complete", payments2?.pagination.hasNextPage === false, payments2?.pagination ?? null, options.executions.get("payment_page_2")?.evidenceRefs ?? [], "The second payment page must explicitly complete the history."),
    oracle("all_ap_payment_types_seen", requiredTypes.every((type) => paymentTypes.includes(type as never)), paymentTypes, refs, "Cash payment, AP credit, AP prepayment, and AP overpayment types must all be evidenced."),
    oracle("exact_bill_same_id", exact?.invoiceId === "40000000-0000-4000-8000-000000000001" && exact?.tenantId === options.tenantId, {
      invoiceId: exact?.invoiceId ?? null,
      tenantId: exact?.tenantId ?? null,
      linesTruncated: exact?.linesTruncated ?? null,
    }, options.executions.get("exact_bill")?.evidenceRefs ?? [], "Exact-ID supplier bill readback must preserve both record ID and bound tenant ID."),
  ];
  return finalizeCase({ scenario: options.scenario, oracleResults, evidenceRefs: refs });
}

function evaluateMatch(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
  provider: SyntheticXeroAccountingProvider;
}): OracleCaseResult {
  const noMatch = valueObject(options.executions.get("no_contact_match")?.result);
  const ambiguous = valueObject(options.executions.get("ambiguous_contact_match")?.result);
  const noMatchBlockers = Array.isArray(noMatch?.blockers) ? noMatch.blockers : [];
  const ambiguousBlockers = Array.isArray(ambiguous?.blockers) ? ambiguous.blockers : [];
  const blockerCodes = (blockers: unknown[]) => blockers.map((blocker) => valueObject(blocker)?.code ?? null);
  const refs = [...options.executions.values()].flatMap((execution) => execution.evidenceRefs);
  const providerMethods = [...options.executions.values()].flatMap((execution) => execution.providerCalls.map((call) => call.method));
  const oracleResults = [
    successfulManifestSteps(options.scenario, options.executions),
    oracle("no_match_blocks", blockerCodes(noMatchBlockers).includes("NO_EXACT_MATCH"), blockerCodes(noMatchBlockers), options.executions.get("no_contact_match")?.evidenceRefs ?? [], "No exact supplier match must produce a structured blocker."),
    oracle("no_match_no_proposal", noMatch?.proposal === null, noMatch?.proposal ?? null, options.executions.get("no_contact_match")?.evidenceRefs ?? [], "No exact supplier match must not produce a posting proposal."),
    oracle("ambiguous_blocks", blockerCodes(ambiguousBlockers).includes("AMBIGUOUS_MATCH"), blockerCodes(ambiguousBlockers), options.executions.get("ambiguous_contact_match")?.evidenceRefs ?? [], "Duplicate exact suppliers must produce an ambiguity blocker."),
    oracle("ambiguous_no_proposal", ambiguous?.proposal === null, ambiguous?.proposal ?? null, options.executions.get("ambiguous_contact_match")?.evidenceRefs ?? [], "Ambiguity must fail closed without a posting proposal."),
    oracle("prepare_never_writes", options.provider.writeAttempts === 0 && !providerMethods.includes("createDraftSupplierBill"), {
      providerWriteAttempts: options.provider.writeAttempts,
      providerMethods,
    }, refs, "Prepare-only calls must never reach the Provider write method."),
  ];
  return finalizeCase({ scenario: options.scenario, oracleResults, evidenceRefs: refs });
}

function evaluateUnknownPayment(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
}): OracleCaseResult {
  const paymentResult = options.executions.get("read_unknown_currency_payment")?.result as PaymentListResult | undefined;
  const payment = paymentResult?.payments[0];
  const refs = options.executions.get("read_unknown_currency_payment")?.evidenceRefs ?? [];
  const oracleResults = [
    successfulManifestSteps(options.scenario, options.executions),
    oracle("currency_known_false", payment?.currencyKnown === false && payment?.currencySource === "UNAVAILABLE", {
      currencyKnown: payment?.currencyKnown ?? null,
      currencySource: payment?.currencySource ?? null,
    }, refs, "Unavailable Provider currency must remain explicitly unknown."),
    oracle("invoice_association_absent", payment !== undefined && !hasOwn(payment, "invoiceId") && !hasOwn(payment, "creditNoteId"), {
      invoiceIdPresent: hasOwn(payment, "invoiceId"),
      creditNoteIdPresent: hasOwn(payment, "creditNoteId"),
      overpaymentId: payment?.overpaymentId ?? null,
    }, refs, "An overpayment must not be fabricated into an invoice or credit-note association."),
    oracle("no_synthetic_currency_field", payment !== undefined && !hasOwn(payment, "currency"), {
      currencyPresent: hasOwn(payment, "currency"),
    }, refs, "Unknown currency must not be synthesized into the output."),
  ];
  return finalizeCase({ scenario: options.scenario, oracleResults, evidenceRefs: refs });
}

function evaluateCredit(options: {
  scenario: ScenarioCase;
  executions: Map<string, ToolExecution>;
}): OracleCaseResult {
  const result = options.executions.get("read_truncated_credit")?.result as CreditNoteListResult | undefined;
  const credit = result?.creditNotes[0];
  const refs = options.executions.get("read_truncated_credit")?.evidenceRefs ?? [];
  const oracleResults = [
    successfulManifestSteps(options.scenario, options.executions),
    oracle("association_truncated_true", credit?.associatedInvoiceIdsTruncated === true, credit?.associatedInvoiceIdsTruncated ?? null, refs, "Credit-note association truncation must be explicit."),
    oracle("association_count_preserved", credit?.associatedInvoiceIdCount === 4, credit?.associatedInvoiceIdCount ?? null, refs, "The original association count must remain four."),
    oracle("bounded_id_count_is_two", credit?.associatedInvoiceIds.length === 2, credit?.associatedInvoiceIds ?? null, refs, "Only the bounded two exact invoice IDs may be returned."),
  ];
  return finalizeCase({ scenario: options.scenario, oracleResults, evidenceRefs: refs });
}

function evaluateVersion(options: {
  scenario: ScenarioCase;
  packageVersion: unknown;
  serverVersion: { name?: string; version?: string } | undefined;
  http: HttpVersionReceipt;
  evidenceRefs: string[];
}): OracleCaseResult {
  const healthBody = valueObject(options.http.health.body);
  const readinessBody = valueObject(options.http.readiness.body);
  const versions = {
    package: options.packageVersion,
    mcp_server_info: options.serverVersion?.version ?? null,
    health: healthBody?.version ?? null,
    readiness: readinessBody?.version ?? null,
    shared_release_constant: XERO_RELEASE_VERSION,
  };
  const values = Object.values(versions);
  const versionsEqual = typeof options.packageVersion === "string" && values.every((value) => value === options.packageVersion);
  const receiptsComplete = options.http.health.status === 200 && options.http.readiness.status === 200 &&
    healthBody?.status === "ok" && readinessBody?.status === "ready" &&
    options.serverVersion?.name === "zcloak-xero-accounting-mcp-demo";
  const oracleResults = [
    oracle("all_versions_equal", versionsEqual, versions, options.evidenceRefs, "Package, MCP initialize, health, readiness, and shared release constant must be identical."),
    oracle("version_evidence_complete", receiptsComplete, {
      mcpServerName: options.serverVersion?.name ?? null,
      healthStatus: options.http.health.status,
      readinessStatus: options.http.readiness.status,
      healthBodyStatus: healthBody?.status ?? null,
      readinessBodyStatus: readinessBody?.status ?? null,
    }, options.evidenceRefs, "All four runtime version surfaces must have executable receipts."),
  ];
  return finalizeCase({
    scenario: options.scenario,
    oracleResults,
    evidenceRefs: options.evidenceRefs,
    notes: versionsEqual && receiptsComplete
      ? "XR-008 was not observed: the version drift baseline is fixed."
      : "XR-008 observed and intentionally remains FAIL.",
  });
}

function statusSummary(caseResults: OracleCaseResult[]): OracleRunResult["summary"] {
  const count = (status: OracleCaseResult["actual_status"]) =>
    caseResults.filter((result) => result.actual_status === status).length;
  return {
    total: caseResults.length,
    pass: count("PASS"),
    fail: count("FAIL"),
    blocked_model_provider: count("BLOCKED_MODEL_PROVIDER"),
    blocked_env: count("BLOCKED_ENV"),
    blocked_test_data: count("BLOCKED_TEST_DATA"),
    unsupported: count("UNSUPPORTED"),
    flaky: count("FLAKY"),
    not_run: count("NOT_RUN"),
  };
}

function summaryMarkdown(report: OracleRunResult, providerWriteAttempts: number): string {
  const rows = report.case_results.map((result) =>
    `| ${result.case_id} | ${result.baseline_expectation} | ${result.actual_status} | ${result.hard_gate_passed ? "yes" : "no"} | ${result.expected_red_observed ? "yes" : "no"} |`);
  return [
    "# Xero MCP local P0 read-only result",
    "",
    `- Run: ${report.run_id}`,
    `- Started: ${report.started_at}`,
    `- Finished: ${report.finished_at}`,
    `- Cases: ${report.summary.total}; PASS ${report.summary.pass}; FAIL ${report.summary.fail}`,
    `- Provider write attempts: ${providerWriteAttempts}`,
    `- Write gate: ${report.environment.write_gate_start} -> ${report.environment.write_gate_end}`,
    "",
    "| Case | Baseline | Actual | Hard gates | Expected red observed |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "PASS is derived only from parsed model-visible MCP output, independently reserialized transport evidence, Provider call receipts, repository audit state, and local HTTP receipts.",
    "",
  ].join("\n");
}

function parseRunId(argv: string[]): string {
  const index = argv.indexOf("--run-id");
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  const runId = explicit ?? `p0-readonly-${new Date().toISOString().replaceAll(":", "-")}`;
  if (!/^[A-Za-z0-9._-]{8,160}$/u.test(runId)) {
    throw new Error("run ID must use 8-160 letters, numbers, dots, underscores, or hyphens");
  }
  return runId;
}

function parseOutputDirectory(argv: string[]): string | undefined {
  const index = argv.indexOf("--output-dir");
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function executeP0ReadOnlySuite(
  options: ExecuteP0ReadOnlyOptions = {},
): Promise<ExecuteP0ReadOnlyResult> {
  const runId = options.runId ?? `p0-readonly-${new Date().toISOString().replaceAll(":", "-")}`;
  const startedAt = new Date().toISOString();
  const [scenarioRaw, fixtureRaw, packageRaw] = await Promise.all([
    readFile(scenarioPath, "utf8"),
    readFile(fixturePath, "utf8"),
    readFile(resolve(repoRoot, "package.json"), "utf8"),
  ]);
  const scenario = JSON.parse(scenarioRaw) as ScenarioManifest;
  const fixture = JSON.parse(fixtureRaw) as JsonObject;
  const packageVersion = (JSON.parse(packageRaw) as { version?: unknown }).version;
  const targetCases = TARGET_CASE_IDS.map((caseId) => {
    const selected = scenario.cases.find((candidate) => candidate.id === caseId);
    if (!selected) throw new Error(`Required P0 read-only case ${caseId} is missing from ${scenarioPath}.`);
    return selected;
  });
  const provider = new SyntheticXeroAccountingProvider(fixture);
  const repository = new InMemoryAccountingRepository();
  const connectionTickets = new ConnectionTicketService(repository, "https://xero-mcp.p0-harness.invalid");
  const config = applicationConfig(provider.tenantId);
  const service = new AccountingService({
    repository,
    provider,
    config,
    logger: noOpLogger(),
    connectionTickets,
  });
  const resolvedToken = readOnlyResolvedToken(provider.tenantId);
  const context = createOAuthRequestContext({
    issuer: "https://issuer.p0-harness.invalid",
    resolvedToken,
  });
  const server = createAccountingMcpServer(service, context);
  const client = new Client({ name: "xero-p0-readonly-harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const evidence = new EvidenceCollector(runId);

  try {
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const serverVersion = client.getServerVersion();
    const initializeRef = evidence.add("DC-VERSION-008", "STATE_PROBE", "mcp-initialize", {
      serverInfo: serverVersion,
      capabilities: client.getServerCapabilities(),
    });
    const listed = await client.listTools();
    const listTools = listed.tools.map((tool) => tool.name);
    const listToolsRef = evidence.add("DC-CONNECTION-001", "TOOL_OUTPUT", "tools-list", {
      tools: listed.tools.map((tool) => ({ name: tool.name, annotations: tool.annotations })),
    });

    const executions = new Map<string, Map<string, ToolExecution>>();
    for (const caseScenario of targetCases) {
      const caseExecutions = new Map<string, ToolExecution>();
      executions.set(caseScenario.id, caseExecutions);
      for (const step of caseScenario.steps) {
        if (step.action === "MCP_CALL") {
          caseExecutions.set(step.id, await executeTool({
            scenario: caseScenario,
            step,
            client,
            provider,
            repository,
            evidence,
          }));
        } else if (step.action === "FAULT_INJECTION") {
          if (step.fault_profile !== "trial_balance_oversize_5000_rows") {
            throw new Error(`Unsupported deterministic fault profile: ${String(step.fault_profile)}`);
          }
          provider.setTrialBalancePressure(true);
          caseExecutions.set(step.id, await executeTool({
            scenario: caseScenario,
            step,
            client,
            provider,
            repository,
            evidence,
            overrideTool: "xero_get_trial_balance",
            overrideInput: { date: "2026-08-06" },
          }));
        }
      }
    }

    const connectionScenario = targetCases.find((item) => item.id === "DC-CONNECTION-001") as ScenarioCase;
    const writeProbe = await executeTool({
      scenario: connectionScenario,
      step: { id: "read_only_write_probe", action: "MCP_CALL", tool: "xero_create_draft_supplier_bill" },
      client,
      provider,
      repository,
      evidence,
      overrideInput: {
        preparation_id: `xmp_${"a".repeat(32)}`,
        request_id: "p0-readonly-write-probe-001",
        confirmation_phrase: "Scope probe only; must never reach Xero",
      },
    });

    const httpReceipt = await captureHttpVersionReceipt({ config, repository, service, connectionTickets });
    const packageRef = evidence.add("DC-VERSION-008", "STATE_PROBE", "package-version", {
      version: packageVersion,
      source: "package.json",
    });
    const healthRef = evidence.add("DC-VERSION-008", "NETWORK_RECEIPT", "local-healthz", httpReceipt.health);
    const readinessRef = evidence.add("DC-VERSION-008", "NETWORK_RECEIPT", "local-readyz", httpReceipt.readiness);

    const byId = new Map(targetCases.map((item) => [item.id, item]));
    const caseResults = [
      evaluateConnection({
        scenario: byId.get("DC-CONNECTION-001") as ScenarioCase,
        executions: executions.get("DC-CONNECTION-001") as Map<string, ToolExecution>,
        listTools,
        listToolsRef,
        provider,
        tenantId: provider.tenantId,
        writeProbe,
      }),
      evaluateLedger({
        scenario: byId.get("DC-LEDGER-002") as ScenarioCase,
        executions: executions.get("DC-LEDGER-002") as Map<string, ToolExecution>,
        fixture,
      }),
      evaluateHistory({
        scenario: byId.get("DC-HISTORY-003") as ScenarioCase,
        executions: executions.get("DC-HISTORY-003") as Map<string, ToolExecution>,
        tenantId: provider.tenantId,
      }),
      evaluateMatch({
        scenario: byId.get("DC-MATCH-004") as ScenarioCase,
        executions: executions.get("DC-MATCH-004") as Map<string, ToolExecution>,
        provider,
      }),
      evaluateUnknownPayment({
        scenario: byId.get("DC-PAYMENT-005") as ScenarioCase,
        executions: executions.get("DC-PAYMENT-005") as Map<string, ToolExecution>,
      }),
      evaluateCredit({
        scenario: byId.get("DC-CREDIT-006") as ScenarioCase,
        executions: executions.get("DC-CREDIT-006") as Map<string, ToolExecution>,
      }),
      evaluateVersion({
        scenario: byId.get("DC-VERSION-008") as ScenarioCase,
        packageVersion,
        serverVersion,
        http: httpReceipt,
        evidenceRefs: [packageRef, initializeRef, healthRef, readinessRef],
      }),
    ];
    const finishedAt = new Date().toISOString();
    const reportCandidate = {
      schema_version: "1.0" as const,
      run_id: runId,
      suite_id: scenario.suite_id,
      layer: scenario.layer,
      started_at: startedAt,
      finished_at: finishedAt,
      environment: {
        target: "IN_MEMORY" as const,
        data_class: "SYNTHETIC_ONLY" as const,
        write_gate_start: "CLOSED" as const,
        write_gate_end: "CLOSED" as const,
        secrets_redacted: true as const,
        ...(serverVersion?.version ? { mcp_server_version: serverVersion.version } : {}),
        oauth_binding_fingerprint: hashObject({
          workspaceId: resolvedToken.workspaceId,
          subjectType: resolvedToken.subjectType,
          subjectId: resolvedToken.subjectId,
          agentId: resolvedToken.agentId,
          connectionId: resolvedToken.connectionId,
          tenantId: resolvedToken.tenantId,
          scopes: resolvedToken.grantedScopes,
        }),
      },
      case_results: caseResults,
      summary: statusSummary(caseResults),
      claim_guardrail_violations: [],
    };
    const report = oracleRunSchema.parse(reportCandidate);
    let artifactPaths: ExecuteP0ReadOnlyResult["artifactPaths"];
    if (options.writeArtifacts !== false) {
      const outputDirectory = options.outputDirectory ?? resolve(repoRoot, "artifacts/harness-runs", runId, "p0-readonly");
      const oracleResultsPath = resolve(outputDirectory, "oracle-results.jsonl");
      const evidencePath = resolve(outputDirectory, "evidence.jsonl");
      const summaryPath = resolve(outputDirectory, "summary.md");
      await mkdir(outputDirectory, { recursive: true });
      await Promise.all([
        writeFile(oracleResultsPath, `${JSON.stringify(report)}\n`, "utf8"),
        writeFile(evidencePath, `${evidence.records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
        writeFile(summaryPath, summaryMarkdown(report, provider.writeAttempts), "utf8"),
      ]);
      artifactPaths = { oracleResults: oracleResultsPath, evidence: evidencePath, summary: summaryPath };
    }
    return {
      report,
      evidence: evidence.records,
      providerWriteAttempts: provider.writeAttempts,
      ...(artifactPaths ? { artifactPaths } : {}),
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const result = await executeP0ReadOnlySuite({
    runId: parseRunId(argv),
    ...(parseOutputDirectory(argv) ? { outputDirectory: resolve(parseOutputDirectory(argv) as string) } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    runId: result.report.run_id,
    summary: result.report.summary,
    providerWriteAttempts: result.providerWriteAttempts,
    artifactPaths: result.artifactPaths,
  }, null, 2)}\n`);
  if (result.report.summary.fail > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "HARNESS_ERROR",
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
