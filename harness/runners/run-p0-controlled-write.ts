/**
 * LEGACY INTERNAL MUTATION-KERNEL REGRESSION ONLY.
 *
 * This runner exposes object-level tools behind the test-only switch so old
 * idempotency/recovery fixtures remain executable. It is not a 0.4
 * Agent-facing release gate; current evidence comes from the 28-tool
 * Accounting Case contract and Case service suites.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "../../src/config.js";
import { InMemoryAccountingRepository } from "../../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../../src/db/repository.js";
import type {
  DraftCreatedUpdate,
  PostingRequest,
  ResolvedMcpAccessToken,
} from "../../src/domain/models.js";
import {
  createDraftSupplierBillSchema,
  prepareSupplierBillDraftSchema,
  type CreateDraftSupplierBillInput,
  type PrepareSupplierBillDraftInput,
} from "../../src/domain/schemas.js";
import {
  executePreparedXeroMutationSchema,
  type ExecutePreparedXeroMutationInput,
} from "../../src/domain/xeroControlledMutationSchemas.js";
import { AppError } from "../../src/errors.js";
import type { Logger } from "../../src/logging.js";
import { createAccountingMcpServer } from "../../src/mcp/createServer.js";
import { hashObject } from "../../src/security/hash.js";
import { createOAuthRequestContext, type RequestContext } from "../../src/security/requestContext.js";
import { AccountingService } from "../../src/services/accountingService.js";
import { ConnectionTicketService } from "../../src/services/connectionTicketService.js";
import { XeroMutationService } from "../../src/services/xeroMutationService.js";
import {
  oracleRunSchema,
  type OracleCaseResult,
  type OracleResult,
  type OracleRunResult,
} from "../lib/oracleResultRuntimeSchema.js";
import {
  SyntheticXeroWriteProvider,
  type SyntheticDraftProviderRecord,
} from "../lib/syntheticXeroWriteProvider.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const scenarioPath = resolve(repoRoot, "harness/scenarios/deterministic-contract.p0.json");
const ledgerFixturePath = resolve(repoRoot, "harness/fixtures/xero/synthetic-ledger.json");
const materialFixturePath = resolve(repoRoot, "harness/fixtures/xero/material-clean.json");
const PREPARE_TOOL = "xero_prepare_supplier_bill_draft";
const CREATE_TOOL = "xero_create_draft_supplier_bill";
const CONFIRMATION_SECRET = "p0-controlled-write-confirmation-secret-v1";

const TARGET_CASE_IDS = [
  "DC-IDEMPOTENCY-012",
  "DC-CONCURRENT-012B",
  "DC-DUPLICATE-013",
  "DC-RECOVERY-014",
  "DC-READBACK-014B",
  "DC-REPOSITORY-014C",
] as const;

type JsonObject = Record<string, unknown>;
type EvidenceKind =
  | "TOOL_CALL"
  | "TOOL_OUTPUT"
  | "PROVIDER_CALL"
  | "PROVIDER_RECORD"
  | "REPOSITORY_STATE"
  | "STATE_PROBE";

interface ScenarioStep {
  id: string;
  action: string;
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
  structuredContent: unknown;
  thrown: { name: string; message: string } | undefined;
  result: unknown;
  errorCode: string | undefined;
  evidenceRefs: string[];
  providerCalls: Array<Record<string, unknown>>;
  providerRecords: SyntheticDraftProviderRecord[];
}

interface RepositoryFaultState {
  failMarkDraftCreatedOnce: boolean;
  completionFailureCount: number;
  events: Array<Record<string, unknown>>;
}

interface McpEndpoint {
  client: Client;
  close: () => Promise<void>;
}

interface RuntimeInstance {
  instanceId: string;
  repository: AccountingRepository;
  service: AccountingService;
  endpoints: McpEndpoint[];
}

interface CaseExecutionResult {
  caseResult: OracleCaseResult;
  providerWriteAttempts: number;
  providerAuthoriseAttempts: number;
  providerRecords: SyntheticDraftProviderRecord[];
  gateEvents: Array<Record<string, unknown>>;
}

export interface ExecuteP0ControlledWriteOptions {
  runId?: string;
  outputDirectory?: string;
  writeArtifacts?: boolean;
}

export interface ExecuteP0ControlledWriteResult {
  report: OracleRunResult;
  evidence: EvidenceRecord[];
  providerWriteAttempts: number;
  providerAuthoriseAttempts: number;
  providerRecords: Array<SyntheticDraftProviderRecord & { case_id: string }>;
  gateEvents: Array<Record<string, unknown>>;
  artifactPaths?: {
    oracleResults: string;
    evidence: string;
    providerRecords: string;
    gateEvents: string;
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
      payload,
    });
    return `evidence.jsonl#${evidenceId}`;
  }
}

class ControlledWriteGate {
  readonly events: Array<Record<string, unknown>> = [];
  #open = false;
  #sequence = 0;

  get isOpen(): boolean {
    return this.#open;
  }

  snapshot(caseId: string, action: "START" | "OPEN" | "CLOSE" | "END"): Record<string, unknown> {
    const event = {
      sequence: ++this.#sequence,
      caseId,
      action,
      state: this.#open ? "OPEN" : "CLOSED",
      dataClass: "SYNTHETIC_ONLY",
      allowedOperation: this.#open ? "CREATE_ACCPAY_DRAFT_ONLY" : "NONE",
      authoriseForbidden: true,
      paymentForbidden: true,
    };
    this.events.push(event);
    return event;
  }

  open(caseId: string): Record<string, unknown> {
    if (this.#open) throw new Error(`Controlled write gate is already open for ${caseId}.`);
    this.#open = true;
    return this.snapshot(caseId, "OPEN");
  }

  close(caseId: string): Record<string, unknown> {
    this.#open = false;
    return this.snapshot(caseId, "CLOSE");
  }
}

class CaseHarness {
  readonly caseId: string;
  readonly evidence: EvidenceCollector;
  readonly gate = new ControlledWriteGate();
  readonly provider: SyntheticXeroWriteProvider;
  readonly backingRepository = new InMemoryAccountingRepository();
  readonly repositoryFault: RepositoryFaultState = {
    failMarkDraftCreatedOnce: false,
    completionFailureCount: 0,
    events: [],
  };
  readonly context: RequestContext;
  readonly #runtimes: RuntimeInstance[] = [];

  constructor(options: {
    caseId: string;
    evidence: EvidenceCollector;
    ledgerFixture: unknown;
  }) {
    this.caseId = options.caseId;
    this.evidence = options.evidence;
    this.provider = new SyntheticXeroWriteProvider(options.ledgerFixture, () => this.gate.isOpen);
    this.context = createOAuthRequestContext({
      issuer: "https://issuer.p0-write-harness.invalid",
      resolvedToken: writeResolvedToken(this.provider.tenantId),
    });
    this.captureGate("write-gate-start", this.gate.snapshot(this.caseId, "START"));
  }

  captureGate(label: string, event: Record<string, unknown>): string {
    return this.evidence.add(this.caseId, "STATE_PROBE", label, event);
  }

  openGate(): string {
    return this.captureGate("write-gate-open", this.gate.open(this.caseId));
  }

  closeGate(): string {
    return this.captureGate("write-gate-close", this.gate.close(this.caseId));
  }

  endGate(): string {
    if (this.gate.isOpen) this.closeGate();
    return this.captureGate("write-gate-end", this.gate.snapshot(this.caseId, "END"));
  }

  async startRuntime(suffix: string): Promise<RuntimeInstance> {
    const instanceId = `${this.caseId.toLowerCase()}.${suffix}`;
    const repository = createRepositoryFacade(
      this.backingRepository,
      this.repositoryFault,
      instanceId,
      this.provider.tenantId,
    );
    const tickets = new ConnectionTicketService(repository, "https://xero-mcp.p0-write-harness.invalid");
    const mutationFoundation = new XeroMutationService(repository, {
      confirmationSecret: CONFIRMATION_SECRET,
      writeEnabled: this.gate.isOpen,
      providerCapabilityEvaluator: {
        evaluate: async (_context, actionId) => ({
          allowed: this.gate.isOpen,
          denyReasons: this.gate.isOpen ? [] : ["WRITE_GATE_CLOSED"],
          receiptHash: hashObject({ actionId, writeGateOpen: this.gate.isOpen, instanceId }),
        }),
      },
    });
    const service = new AccountingService({
      repository,
      provider: this.provider,
      config: applicationConfig(this.provider.tenantId, this.gate),
      logger: noOpLogger(),
      connectionTickets: tickets,
      mutationFoundation,
    });
    const runtime: RuntimeInstance = { instanceId, repository, service, endpoints: [] };
    this.#runtimes.push(runtime);
    this.evidence.add(this.caseId, "REPOSITORY_STATE", `runtime-start:${instanceId}`, {
      runtimeInstanceId: instanceId,
      repositoryFacadeReinstantiated: this.#runtimes.length > 1,
      sharedBackingRepository: "in-memory-p0-durable-double",
      sharedProviderRecordLedger: true,
    });
    return runtime;
  }

  async openEndpoint(runtime: RuntimeInstance, suffix: string): Promise<McpEndpoint> {
    const server = createAccountingMcpServer(
      runtime.service,
      this.context,
      undefined,
      undefined,
      undefined,
      { unsafeExposeLegacyObjectMutationToolsForTests: true },
    );
    const client = new Client({ name: `xero-p0-write-${suffix}`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const endpoint: McpEndpoint = {
      client,
      close: async () => {
        await Promise.allSettled([client.close(), server.close()]);
      },
    };
    runtime.endpoints.push(endpoint);
    return endpoint;
  }

  async closeRuntime(runtime: RuntimeInstance): Promise<void> {
    await Promise.all(runtime.endpoints.map((endpoint) => endpoint.close()));
    runtime.endpoints.length = 0;
    this.evidence.add(this.caseId, "STATE_PROBE", `runtime-stop:${runtime.instanceId}`, {
      runtimeInstanceId: runtime.instanceId,
      providerWriteAttempts: this.provider.writeAttempts,
      providerRecords: this.provider.records.length,
      gateState: this.gate.isOpen ? "OPEN" : "CLOSED",
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#runtimes.map((runtime) => this.closeRuntime(runtime)));
  }
}

function noOpLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function applicationConfig(
  tenantId: string,
  gate: ControlledWriteGate,
): Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId"> {
  return {
    publicBaseUrl: "https://xero-mcp.p0-write-harness.invalid",
    get xeroWriteEnabled() {
      return gate.isOpen;
    },
    xeroAllowedTenantId: tenantId,
  };
}

function writeResolvedToken(tenantId: string): ResolvedMcpAccessToken {
  const audience = "https://xero-mcp.p0-write-harness.invalid/mcp";
  return {
    tokenId: "token_p0_write_001",
    clientId: "p0-write-harness",
    resource: audience,
    audience,
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: new Date("2026-08-06T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "installation_p0_write_001",
    bindingId: "binding_p0_write_001",
    connectionId: "connection_xero_harness_001",
    bindingRevision: 1,
    authorizationId: "authorization_p0_write_001",
    workspaceId: "workspace_p0_write",
    subjectType: "USER",
    subjectId: "accountant_p0_write",
    agentId: "agent_p0_write",
    policyId: "policy_p0_write",
    tenantId,
  };
}

function createRepositoryFacade(
  backing: InMemoryAccountingRepository,
  fault: RepositoryFaultState,
  instanceId: string,
  tenantId: string,
): AccountingRepository {
  return new Proxy(backing, {
    get(target, property) {
      if (property === "resolveAgentConnectionBinding") {
        return async (input: {
          installationId: string;
          bindingId: string;
          workspaceId: string;
          subjectType: "USER" | "SERVICE_ACCOUNT";
          subjectId: string;
          agentId: string;
          connectionId: string;
        }) => {
          const token = writeResolvedToken(tenantId);
          if (
            input.installationId !== token.installationId ||
            input.bindingId !== token.bindingId ||
            input.workspaceId !== token.workspaceId ||
            input.subjectType !== token.subjectType ||
            input.subjectId !== token.subjectId ||
            input.agentId !== token.agentId ||
            input.connectionId !== token.connectionId
          ) return undefined;
          return {
            installationId: token.installationId,
            bindingId: token.bindingId,
            workspaceId: token.workspaceId,
            subjectType: token.subjectType,
            subjectId: token.subjectId,
            agentId: token.agentId,
            connectionId: token.connectionId,
            bindingRevision: token.bindingRevision,
            authorizationId: token.authorizationId,
            tenantId,
            tenantName: "Harbour Light Advisory Limited - SYNTHETIC",
            policyId: token.policyId,
          };
        };
      }
      if (property === "markDraftCreated") {
        return async (postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest> => {
          if (fault.failMarkDraftCreatedOnce) {
            fault.failMarkDraftCreatedOnce = false;
            fault.completionFailureCount += 1;
            fault.events.push({
              instanceId,
              operation: "markDraftCreated",
              postingRequestId,
              invoiceId: update.xeroInvoiceId,
              injectedCode: "WRITE_RESULT_UNKNOWN",
            });
            throw new AppError(
              "WRITE_RESULT_UNKNOWN",
              "Synthetic repository lost the completion update after Provider commit.",
              {
                httpStatus: 503,
                retryable: false,
                details: { invoiceId: update.xeroInvoiceId, repositoryInstanceId: instanceId },
              },
            );
          }
          return target.markDraftCreated(postingRequestId, update);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AccountingRepository;
}

function valueObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resultValue(structuredContent: unknown): unknown {
  return valueObject(structuredContent)?.result;
}

function structuredErrorCode(structuredContent: unknown): string | undefined {
  const code = valueObject(valueObject(structuredContent)?.error)?.code;
  return typeof code === "string" ? code : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  writeReceipt?: OracleCaseResult["write_receipt"];
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
    evidence_refs: unique([...options.evidenceRefs, ...options.oracleResults.flatMap((item) => item.evidence_refs)]),
    ...(options.writeReceipt ? { write_receipt: options.writeReceipt } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  };
}

async function executeTool(options: {
  harness: CaseHarness;
  endpoint: McpEndpoint;
  stepId: string;
  tool: string;
  input: JsonObject;
}): Promise<ToolExecution> {
  const { harness } = options;
  const callRef = harness.evidence.add(harness.caseId, "TOOL_CALL", `${options.stepId}:${options.tool}`, {
    tool: options.tool,
    input: options.input,
    inputSha256: hashObject(options.input),
    gateState: harness.gate.isOpen ? "OPEN" : "CLOSED",
  });
  const providerStart = harness.provider.calls.length;
  const recordStart = harness.provider.records.length;
  const auditStart = harness.backingRepository.audits.length;
  let structuredContent: unknown;
  let isError = false;
  let thrown: ToolExecution["thrown"];
  try {
    const response = await options.endpoint.client.callTool({
      name: options.tool,
      arguments: options.input,
    });
    structuredContent = response.structuredContent;
    isError = response.isError === true;
  } catch (error) {
    isError = true;
    thrown = error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "UnknownError", message: String(error) };
  }
  const outputRef = harness.evidence.add(harness.caseId, "TOOL_OUTPUT", `${options.stepId}:${options.tool}`, {
    tool: options.tool,
    isError,
    structuredContent: structuredContent ?? null,
    thrown: thrown ?? null,
  });
  const providerCalls = harness.provider.calls.slice(providerStart) as unknown as Array<Record<string, unknown>>;
  const providerRef = harness.evidence.add(harness.caseId, "PROVIDER_CALL", `${options.stepId}:provider-calls`, {
    calls: providerCalls,
    createCallCount: harness.provider.writeAttempts,
    readbackCallCount: harness.provider.readbackCalls,
    authoriseCallCount: harness.provider.authoriseAttempts,
  });
  const providerRecords = harness.provider.records.slice(recordStart);
  const recordRef = harness.evidence.add(harness.caseId, "PROVIDER_RECORD", `${options.stepId}:provider-records`, {
    records: providerRecords,
    totalRecordCount: harness.provider.records.length,
  });
  const auditRef = harness.evidence.add(harness.caseId, "REPOSITORY_STATE", `${options.stepId}:audit-records`, {
    audits: harness.backingRepository.audits.slice(auditStart),
  });
  return {
    stepId: options.stepId,
    tool: options.tool,
    input: options.input,
    isError,
    structuredContent,
    thrown,
    result: resultValue(structuredContent),
    errorCode: structuredErrorCode(structuredContent),
    evidenceRefs: [callRef, outputRef, providerRef, recordRef, auditRef],
    providerCalls,
    providerRecords,
  };
}

function scenarioStep(scenario: ScenarioCase, stepId: string): ScenarioStep {
  const step = scenario.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Scenario ${scenario.id} is missing required step ${stepId}.`);
  return step;
}

function directManifestInput(scenario: ScenarioCase, stepId: string): CreateDraftSupplierBillInput {
  const input = scenarioStep(scenario, stepId).input;
  if (!input) throw new Error(`Scenario ${scenario.id}/${stepId} has no input.`);
  return createDraftSupplierBillSchema.parse(input);
}

function materialInput(options: {
  material: JsonObject;
  requestId: string;
  sourceSha256?: string;
  sourceRef?: string;
  reference?: string;
}): CreateDraftSupplierBillInput {
  const extraction = valueObject(options.material.expected_extraction);
  if (!extraction) throw new Error("The clean material fixture has no expected_extraction object.");
  return createDraftSupplierBillSchema.parse({
    request_id: options.requestId,
    source_ref: options.sourceRef ?? extraction.source_ref,
    source_sha256: options.sourceSha256 ?? "a".repeat(64),
    source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
    user_confirmation: "CONFIRMED_FOR_DRAFT",
    contact_id: "20000000-0000-4000-8000-000000000001",
    invoice_date: extraction.invoice_date,
    due_date: extraction.due_date,
    currency: extraction.currency,
    reference: options.reference ?? extraction.reference,
    line_amount_type: extraction.line_amount_type,
    lines: extraction.lines,
  });
}

function prepareInput(
  input: CreateDraftSupplierBillInput,
  material: JsonObject,
): PrepareSupplierBillDraftInput {
  const extraction = valueObject(material.expected_extraction);
  if (!extraction) throw new Error("The clean material fixture has no expected_extraction object.");
  return prepareSupplierBillDraftSchema.parse({
    source_ref: input.source_ref,
    source_sha256: input.source_sha256,
    supplier_name: extraction.supplier_name,
    supplier_contact_number: extraction.supplier_contact_number,
    invoice_date: input.invoice_date,
    due_date: input.due_date,
    currency: input.currency,
    reference: input.reference,
    line_amount_type: input.line_amount_type,
    lines: input.lines,
  });
}

function asJsonObject(input: object): JsonObject {
  return input as unknown as JsonObject;
}

function resultObject(execution: ToolExecution): JsonObject | undefined {
  return valueObject(execution.result);
}

function postingId(execution: ToolExecution): string | undefined {
  const value = resultObject(execution)?.postingRequestId;
  return typeof value === "string" ? value : undefined;
}

function invoiceId(execution: ToolExecution): string | undefined {
  const value = resultObject(execution)?.invoiceId;
  return typeof value === "string" ? value : undefined;
}

function isReplay(execution: ToolExecution): boolean | undefined {
  const value = resultObject(execution)?.idempotentReplay;
  return typeof value === "boolean" ? value : undefined;
}

function mutationRequestId(execution: ToolExecution): string | undefined {
  const value = resultObject(execution)?.mutationRequestId;
  return typeof value === "string" ? value : undefined;
}

function preparedExecuteInput(
  preparation: ToolExecution,
  requestId: string,
): ExecutePreparedXeroMutationInput {
  const result = resultObject(preparation);
  return executePreparedXeroMutationSchema.parse({
    preparation_id: result?.preparation_id,
    request_id: requestId,
  });
}

function mutationRequestIdForPreparation(preparation: ToolExecution): string | undefined {
  const preparationId = resultObject(preparation)?.preparation_id;
  return typeof preparationId === "string"
    ? `xmr_${hashObject({ preparationId }).slice(0, 32)}`
    : undefined;
}

async function prepareForExecution(options: {
  harness: CaseHarness;
  endpoint: McpEndpoint;
  stepId: string;
  input: CreateDraftSupplierBillInput;
  material: JsonObject;
}): Promise<{ preparation: ToolExecution; command: ExecutePreparedXeroMutationInput }> {
  const preparation = await executeTool({
    harness: options.harness,
    endpoint: options.endpoint,
    stepId: `${options.stepId}:prepare`,
    tool: PREPARE_TOOL,
    input: asJsonObject(prepareInput(options.input, options.material)),
  });
  if (preparation.isError) {
    throw new Error(`Preparation failed for ${options.harness.caseId}/${options.stepId}.`);
  }
  return {
    preparation,
    command: preparedExecuteInput(preparation, options.input.request_id),
  };
}

async function postingForInput(
  harness: CaseHarness,
  input: CreateDraftSupplierBillInput,
): Promise<PostingRequest | undefined> {
  return harness.backingRepository.findActivePostingDuplicate({
    tenantId: harness.provider.tenantId,
    sourceSha256: input.source_sha256,
    contactId: input.contact_id.trim().toLowerCase(),
    normalizedReference: input.reference.trim().toLowerCase(),
  });
}

function capturePosting(
  harness: CaseHarness,
  label: string,
  posting: PostingRequest | undefined,
): string {
  return harness.evidence.add(harness.caseId, "REPOSITORY_STATE", label, {
    posting: posting ?? null,
    activeDuplicateStatesObserved: posting ? [posting.state] : [],
  });
}

function writeReceipt(options: {
  requestId: string;
  created: ToolExecution;
  replayObserved: boolean;
  provider: SyntheticXeroWriteProvider;
}): OracleCaseResult["write_receipt"] | undefined {
  const record = options.provider.records[0];
  const createdResult = resultObject(options.created);
  const postingRequestId = createdResult?.postingRequestId;
  const payloadHash = createdResult?.approvedPayloadHash;
  if (!record || invoiceId(options.created) !== record.providerRecordId) return undefined;
  return {
    request_id: options.requestId,
    provider_record_id: record.providerRecordId,
    provider_status: "DRAFT",
    provider_write_count: 1,
    exact_readback_id: record.bill.invoiceId,
    idempotent_replay: options.replayObserved,
    ...(typeof postingRequestId === "string" ? { posting_request_id: postingRequestId } : {}),
    ...(typeof payloadHash === "string" ? { payload_hash: payloadHash } : {}),
  };
}

async function runIdempotencyCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const firstInput = directManifestInput(options.scenario, "create_once");
  const replayInput = directManifestInput(options.scenario, "replay_same_payload");
  const changedInput = directManifestInput(options.scenario, "same_request_changed_payload");
  const refs: string[] = [];
  try {
    const runtime = await harness.startRuntime("runtime-1");
    const endpoint = await harness.openEndpoint(runtime, "idempotency");
    const preparedFirst = await prepareForExecution({
      harness,
      endpoint,
      stepId: "create_once",
      input: firstInput,
      material: options.material,
    });
    refs.push(...preparedFirst.preparation.evidenceRefs);
    const closedProbe = await executeTool({
      harness,
      endpoint,
      stepId: "write_gate_closed_probe",
      tool: CREATE_TOOL,
      input: asJsonObject({ ...preparedFirst.command, request_id: "p0.gate-closed.001" }),
    });
    refs.push(...closedProbe.evidenceRefs, harness.openGate());
    const first = await executeTool({
      harness,
      endpoint,
      stepId: "create_once",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedFirst.command),
    });
    const replay = await executeTool({
      harness,
      endpoint,
      stepId: "replay_same_payload",
      tool: CREATE_TOOL,
      input: asJsonObject({ ...preparedFirst.command, request_id: replayInput.request_id }),
    });
    const preparedChanged = await prepareForExecution({
      harness,
      endpoint,
      stepId: "same_request_changed_payload",
      input: changedInput,
      material: options.material,
    });
    const changed = await executeTool({
      harness,
      endpoint,
      stepId: "same_request_changed_payload",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedChanged.command),
    });
    refs.push(
      ...first.evidenceRefs,
      ...replay.evidenceRefs,
      ...preparedChanged.preparation.evidenceRefs,
      ...changed.evidenceRefs,
    );

    const tools = (await endpoint.client.listTools()).tools.map((tool) => tool.name);
    const toolsRef = harness.evidence.add(harness.caseId, "STATE_PROBE", "forbidden-tool-surface", { tools });
    const authoriseProbe = await executeTool({
      harness,
      endpoint,
      stepId: "forbidden_authorise_probe",
      tool: "xero_authorise_supplier_bill",
      input: {},
    });
    const paymentProbe = await executeTool({
      harness,
      endpoint,
      stepId: "forbidden_payment_probe",
      tool: "xero_create_payment",
      input: {},
    });
    refs.push(toolsRef, ...authoriseProbe.evidenceRefs, ...paymentProbe.evidenceRefs);

    const posting = postingId(first) ? await harness.backingRepository.getPosting(postingId(first) as string) : undefined;
    const postingRef = capturePosting(harness, "idempotency-final-posting", posting);
    const mutation = mutationRequestId(first)
      ? await harness.backingRepository.getXeroMutationRequest(mutationRequestId(first) as string)
      : undefined;
    const mutationRef = harness.evidence.add(harness.caseId, "REPOSITORY_STATE", "idempotency-mutation-state", {
      mutation: mutation ?? null,
    });
    refs.push(postingRef, mutationRef, harness.closeGate());
    const endInput = createDraftSupplierBillSchema.parse({
      ...firstInput,
      request_id: "p0.gate-end-closed.001",
      source_ref: "synthetic://work/materials/P0-GATE-END-CLOSED.json",
      source_sha256: "f".repeat(64),
      reference: "P0-GATE-END-CLOSED",
    });
    const preparedEnd = await prepareForExecution({
      harness,
      endpoint,
      stepId: "write_gate_end_closed_probe",
      input: endInput,
      material: options.material,
    });
    const endClosedProbe = await executeTool({
      harness,
      endpoint,
      stepId: "write_gate_end_closed_probe",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedEnd.command),
    });
    refs.push(...preparedEnd.preparation.evidenceRefs, ...endClosedProbe.evidenceRefs, harness.endGate());
    const sameIds = postingId(first) !== undefined && postingId(first) === postingId(replay) && invoiceId(first) === invoiceId(replay);
    const forbiddenAbsent = !tools.includes("xero_authorise_supplier_bill") && !tools.includes("xero_create_payment");
    const oracleResults = [
      oracle("write_gate_starts_closed", closedProbe.errorCode === "FORBIDDEN" && !first.isError && harness.provider.writeAttempts === 1, {
        closedProbeCode: closedProbe.errorCode ?? null,
        preparedCommandReusableAfterOpen: !first.isError,
        finalCreateCallCount: harness.provider.writeAttempts,
      }, [...closedProbe.evidenceRefs, ...first.evidenceRefs], "The immutable prepared command must be rejected while the emergency gate is closed without being consumed, then remain usable after the gate opens."),
      oracle("same_request_same_ids", sameIds, {
        firstPostingRequestId: postingId(first) ?? null,
        replayPostingRequestId: postingId(replay) ?? null,
        firstInvoiceId: invoiceId(first) ?? null,
        replayInvoiceId: invoiceId(replay) ?? null,
      }, [...first.evidenceRefs, ...replay.evidenceRefs], "Same-request replay must return the same posting and Provider record."),
      oracle("replay_true", isReplay(first) === false && isReplay(replay) === true, {
        first: isReplay(first) ?? null,
        replay: isReplay(replay) ?? null,
      }, [...first.evidenceRefs, ...replay.evidenceRefs], "Only the second identical request may be reported as an idempotent replay."),
      oracle("payload_conflict", ["APPROVAL_INVALID", "CONFLICT"].includes(changed.errorCode ?? ""), changed.errorCode ?? null, changed.evidenceRefs, "A separately prepared changed payload under one request_id must be rejected by immutable preparation and idempotency controls."),
      oracle("one_provider_write", harness.provider.writeAttempts === 1, harness.provider.writeAttempts, refs, "Exactly one Provider create call is allowed."),
      oracle("one_provider_record", harness.provider.records.length === 1, harness.provider.records.length, refs, "Exactly one synthetic Xero DRAFT record is allowed."),
      oracle("one_repository_posting", posting?.postingRequestId === postingId(first) && posting?.state === "APPROVAL_PENDING", {
        postingRequestId: posting?.postingRequestId ?? null,
        state: posting?.state ?? null,
      }, [postingRef], "The repository must retain one approval-pending posting."),
      oracle("mutation_readback_verified", mutation?.state === "READBACK_VERIFIED" && mutation?.xeroObjectId === invoiceId(first), {
        mutationRequestId: mutation?.mutationRequestId ?? null,
        state: mutation?.state ?? null,
        xeroObjectId: mutation?.xeroObjectId ?? null,
      }, [mutationRef, ...first.evidenceRefs], "The confirmed mutation must finish only after the exact Xero DRAFT readback is verified."),
      oracle("authorise_payment_forbidden", forbiddenAbsent && authoriseProbe.isError && paymentProbe.isError && harness.provider.authoriseAttempts === 0, {
        forbiddenAbsent,
        authoriseInvocationRejected: authoriseProbe.isError,
        paymentInvocationRejected: paymentProbe.isError,
        providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      }, [toolsRef, ...authoriseProbe.evidenceRefs, ...paymentProbe.evidenceRefs], "AUTHORISE and payment tools must be absent and rejected before the Provider."),
      oracle("write_gate_ends_closed", endClosedProbe.errorCode === "FORBIDDEN" && !harness.gate.isOpen, {
        endProbeCode: endClosedProbe.errorCode ?? null,
        gateState: harness.gate.isOpen ? "OPEN" : "CLOSED",
      }, endClosedProbe.evidenceRefs, "The write gate must close and reject a final schema-valid DRAFT probe."),
    ];
    return {
      caseResult: finalizeCase({
        scenario: options.scenario,
        oracleResults,
        evidenceRefs: refs,
        writeReceipt: writeReceipt({ requestId: firstInput.request_id, created: first, replayObserved: true, provider: harness.provider }),
      }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

async function runConcurrentCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const manifestInput = scenarioStep(options.scenario, "dispatch_two_identical_creates").input;
  const requestId = typeof manifestInput?.request_id === "string" ? manifestInput.request_id : "p0.concurrent-same-request.001";
  const input = materialInput({ material: options.material, requestId });
  const refs: string[] = [];
  try {
    const runtime = await harness.startRuntime("runtime-1");
    const [endpointA, endpointB] = await Promise.all([
      harness.openEndpoint(runtime, "concurrent-a"),
      harness.openEndpoint(runtime, "concurrent-b"),
    ]);
    const prepared = await prepareForExecution({
      harness,
      endpoint: endpointA,
      stepId: "dispatch_two_identical_creates",
      input,
      material: options.material,
    });
    refs.push(...prepared.preparation.evidenceRefs, harness.openGate());
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier;
    });
    let ready = 0;
    const dispatch = async (endpoint: McpEndpoint, label: string): Promise<ToolExecution> => {
      ready += 1;
      await barrier;
      return executeTool({
        harness,
        endpoint,
        stepId: label,
        tool: CREATE_TOOL,
        input: asJsonObject(prepared.command),
      });
    };
    const taskA = dispatch(endpointA, "dispatch_two_identical_creates:a");
    const taskB = dispatch(endpointB, "dispatch_two_identical_creates:b");
    await Promise.resolve();
    const barrierRef = harness.evidence.add(harness.caseId, "STATE_PROBE", "simultaneous-release-barrier", {
      waitingCallCount: ready,
      expectedWaitingCallCount: 2,
      released: true,
    });
    releaseBarrier();
    const [first, second] = await Promise.all([taskA, taskB]);
    refs.push(barrierRef, ...first.evidenceRefs, ...second.evidenceRefs, harness.closeGate(), harness.endGate());
    const firstPosting = postingId(first);
    const secondPosting = postingId(second);
    const posting = firstPosting ? await harness.backingRepository.getPosting(firstPosting) : undefined;
    const postingRef = capturePosting(harness, "concurrent-final-posting", posting);
    refs.push(postingRef);
    const sameIds = firstPosting !== undefined && firstPosting === secondPosting && invoiceId(first) === invoiceId(second);
    const replayFlags = [isReplay(first), isReplay(second)].sort();
    const oracleResults = [
      oracle("concurrent_one_preparation", !prepared.preparation.isError, {
        preparationId: resultObject(prepared.preparation)?.preparation_id ?? null,
      }, prepared.preparation.evidenceRefs, "Both concurrent calls must consume the same server-persisted one-time preparation."),
      oracle("barrier_ready_two", ready === 2, { waitingCallCount: ready }, [barrierRef], "Both MCP calls must wait behind one explicit release barrier."),
      oracle("two_mcp_calls_completed", !first.isError && !second.isError, {
        firstIsError: first.isError,
        secondIsError: second.isError,
      }, [...first.evidenceRefs, ...second.evidenceRefs], "Both barrier-released MCP calls must complete."),
      oracle("concurrent_results_same_id", sameIds, {
        postingRequestIds: [firstPosting ?? null, secondPosting ?? null],
        invoiceIds: [invoiceId(first) ?? null, invoiceId(second) ?? null],
      }, [...first.evidenceRefs, ...second.evidenceRefs], "Concurrent identical requests must resolve to one posting and one invoice."),
      oracle("concurrent_one_new_one_replay", replayFlags[0] === false && replayFlags[1] === true, replayFlags.map((value) => value ?? null), [...first.evidenceRefs, ...second.evidenceRefs], "Exactly one concurrent call must create and the other must replay."),
      oracle("concurrent_one_provider_write", harness.provider.writeAttempts === 1, harness.provider.writeAttempts, refs, "Concurrent execution must issue exactly one Provider create."),
      oracle("concurrent_one_provider_record", harness.provider.records.length === 1, harness.provider.records.length, refs, "Concurrent execution must leave exactly one Provider record."),
      oracle("concurrent_one_repository_posting", posting?.postingRequestId === firstPosting && posting?.state === "APPROVAL_PENDING", {
        postingRequestId: posting?.postingRequestId ?? null,
        state: posting?.state ?? null,
      }, [postingRef], "Concurrent execution must leave one approval-pending repository posting."),
      oracle("concurrent_gate_closed", !harness.gate.isOpen, { gateState: "CLOSED" }, refs, "The controlled gate must end closed."),
    ];
    const created = isReplay(first) === false ? first : second;
    return {
      caseResult: finalizeCase({
        scenario: options.scenario,
        oracleResults,
        evidenceRefs: refs,
        writeReceipt: writeReceipt({ requestId, created, replayObserved: true, provider: harness.provider }),
      }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

async function runDuplicateCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const firstInput = directManifestInput(options.scenario, "first_business_document_request");
  const sameSourceInput = directManifestInput(options.scenario, "second_business_document_request");
  const sameContactReferenceInput = createDraftSupplierBillSchema.parse({
    ...firstInput,
    request_id: "p0.business-duplicate.C",
    source_ref: "synthetic://work/materials/HBS-2026-0810-copy-c.json",
    source_sha256: "b".repeat(64),
    reference: "  hbs-2026-0810  ",
  });
  const rejectedReplayInput = createDraftSupplierBillSchema.parse({
    ...firstInput,
    request_id: "p0.business-duplicate.D",
    source_ref: "synthetic://work/materials/HBS-2026-0810-copy-d.json",
    source_sha256: "c".repeat(64),
    reference: "HBS-2026-0810",
  });
  const refs: string[] = [];
  try {
    const runtime = await harness.startRuntime("runtime-1");
    const endpoint = await harness.openEndpoint(runtime, "duplicate");
    refs.push(harness.openGate());
    const preparedFirst = await prepareForExecution({
      harness,
      endpoint,
      stepId: "first_business_document_request",
      input: firstInput,
      material: options.material,
    });
    const first = await executeTool({
      harness,
      endpoint,
      stepId: "first_business_document_request",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedFirst.command),
    });
    const preparedSameSource = await prepareForExecution({
      harness,
      endpoint,
      stepId: "second_business_document_request",
      input: sameSourceInput,
      material: options.material,
    });
    const sameSource = await executeTool({
      harness,
      endpoint,
      stepId: "second_business_document_request",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedSameSource.command),
    });
    const preparedSameContactReference = await prepareForExecution({
      harness,
      endpoint,
      stepId: "different_source_same_contact_reference",
      input: sameContactReferenceInput,
      material: options.material,
    });
    const sameContactReference = await executeTool({
      harness,
      endpoint,
      stepId: "different_source_same_contact_reference",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedSameContactReference.command),
    });
    refs.push(
      ...preparedFirst.preparation.evidenceRefs,
      ...first.evidenceRefs,
      ...preparedSameSource.preparation.evidenceRefs,
      ...sameSource.evidenceRefs,
      ...preparedSameContactReference.preparation.evidenceRefs,
      ...sameContactReference.evidenceRefs,
    );
    const firstPostingId = postingId(first);
    if (!firstPostingId) throw new Error("Duplicate case did not produce the first postingRequestId.");
    const rejected = await harness.backingRepository.rejectPosting(firstPostingId, harness.context.actorId, new Date("2026-08-06T00:00:00.000Z"));
    const rejectedRef = capturePosting(harness, "rejected-posting-still-active", rejected);
    const preparedAfterRejection = await prepareForExecution({
      harness,
      endpoint,
      stepId: "new_request_after_rejection",
      input: rejectedReplayInput,
      material: options.material,
    });
    const afterRejection = await executeTool({
      harness,
      endpoint,
      stepId: "new_request_after_rejection",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedAfterRejection.command),
    });
    refs.push(
      rejectedRef,
      ...preparedAfterRejection.preparation.evidenceRefs,
      ...afterRejection.evidenceRefs,
      harness.closeGate(),
      harness.endGate(),
    );
    const oracleResults = [
      oracle("first_business_document_created", !first.isError && invoiceId(first) === harness.provider.records[0]?.providerRecordId, {
        invoiceId: invoiceId(first) ?? null,
        providerRecordId: harness.provider.records[0]?.providerRecordId ?? null,
      }, first.evidenceRefs, "The first synthetic business document must create one DRAFT."),
      oracle("same_source_new_request_conflict", sameSource.errorCode === "CONFLICT", sameSource.errorCode ?? null, sameSource.evidenceRefs, "A different request_id with the same source hash must conflict."),
      oracle("same_contact_normalized_reference_conflict", sameContactReference.errorCode === "CONFLICT", {
        errorCode: sameContactReference.errorCode ?? null,
        suppliedReference: sameContactReferenceInput.reference,
        normalizedReference: sameContactReferenceInput.reference.trim().toLowerCase(),
      }, sameContactReference.evidenceRefs, "A different source with the same contact and normalized reference must conflict."),
      oracle("rejected_state_remains_active", rejected.state === "REJECTED", { state: rejected.state }, [rejectedRef], "REJECTED must remain an active duplicate-control state."),
      oracle("rejected_still_blocks_new_request", afterRejection.errorCode === "CONFLICT", afterRejection.errorCode ?? null, afterRejection.evidenceRefs, "A new request after rejection must remain blocked."),
      oracle("business_duplicate_provider_count", harness.provider.writeAttempts === 1 && harness.provider.records.length === 1, {
        providerCreateCalls: harness.provider.writeAttempts,
        providerRecords: harness.provider.records.length,
      }, refs, "All duplicate paths together must leave exactly one Provider call and record."),
      oracle("duplicate_gate_closed", !harness.gate.isOpen, { gateState: "CLOSED" }, refs, "The controlled gate must end closed."),
    ];
    return {
      caseResult: finalizeCase({
        scenario: options.scenario,
        oracleResults,
        evidenceRefs: refs,
        writeReceipt: writeReceipt({ requestId: firstInput.request_id, created: first, replayObserved: false, provider: harness.provider }),
        notes: "XR-001 was not observed: same-source, normalized supplier-reference, and REJECTED-state duplicates were all blocked.",
      }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

async function runRecoveryCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const input = directManifestInput(options.scenario, "recover_same_request");
  const refs: string[] = [];
  try {
    const runtime1 = await harness.startRuntime("runtime-1");
    const endpoint1 = await harness.openEndpoint(runtime1, "recovery-before-restart");
    const prepared = await prepareForExecution({
      harness,
      endpoint: endpoint1,
      stepId: "inject_timeout_after_commit",
      input,
      material: options.material,
    });
    refs.push(...prepared.preparation.evidenceRefs, harness.openGate());
    harness.provider.armNextDraftFault("DRAFT_TIMEOUT_AFTER_COMMIT");
    const faultRef = harness.evidence.add(harness.caseId, "STATE_PROBE", "fault:draft_timeout_after_commit", {
      faultProfile: "draft_timeout_after_commit",
      providerCommitExpectedBeforeError: true,
      automaticWriteRetryAllowed: false,
    });
    const initial = await executeTool({
      harness,
      endpoint: endpoint1,
      stepId: "inject_timeout_after_commit",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const unknownPosting = await postingForInput(harness, input);
    const unknownRef = capturePosting(harness, "timeout-after-commit-state", unknownPosting);
    refs.push(faultRef, ...initial.evidenceRefs, unknownRef);
    const recordsBeforeRestart = harness.provider.records.length;
    const writesBeforeRestart = harness.provider.writeAttempts;
    await harness.closeRuntime(runtime1);
    const runtime2 = await harness.startRuntime("runtime-2");
    const endpoint2 = await harness.openEndpoint(runtime2, "recovery-after-restart");
    const providerCallsBeforeRecovery = harness.provider.calls.length;
    const recovered = await executeTool({
      harness,
      endpoint: endpoint2,
      stepId: "recover_same_request",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const genericMutationId = mutationRequestIdForPreparation(prepared.preparation);
    const genericMutation = genericMutationId
      ? await harness.backingRepository.getXeroMutationRequest(genericMutationId)
      : undefined;
    const genericMutationRef = harness.evidence.add(
      harness.caseId,
      "REPOSITORY_STATE",
      "timeout-recovery-mutation-state",
      { mutation: genericMutation ?? null },
    );
    const recoveryProviderMethods = harness.provider.calls.slice(providerCallsBeforeRecovery).map((call) => call.method);
    const finalPosting = postingId(recovered)
      ? await harness.backingRepository.getPosting(postingId(recovered) as string)
      : await postingForInput(harness, input);
    const finalRef = capturePosting(harness, "timeout-recovery-final-state", finalPosting);
    refs.push(...recovered.evidenceRefs, genericMutationRef, finalRef, harness.closeGate(), harness.endGate());
    const record = harness.provider.records[0];
    const oracleResults = [
      oracle("timeout_after_commit_unknown", initial.errorCode === "WRITE_RESULT_UNKNOWN" && unknownPosting?.state === "WRITE_RESULT_UNKNOWN", {
        errorCode: initial.errorCode ?? null,
        postingState: unknownPosting?.state ?? null,
        knownInvoiceId: unknownPosting?.xeroInvoiceId ?? null,
      }, [...initial.evidenceRefs, unknownRef], "Timeout after Provider commit must persist WRITE_RESULT_UNKNOWN with the exact InvoiceID."),
      oracle("restart_reinstantiates_service_repository", runtime1.instanceId !== runtime2.instanceId, {
        before: runtime1.instanceId,
        after: runtime2.instanceId,
        sharedBackingRepository: true,
      }, refs, "Recovery must run after service and repository-facade re-instantiation over the same durable state."),
      oracle("recovery_same_id", !recovered.isError && invoiceId(recovered) === record?.providerRecordId && postingId(recovered) === unknownPosting?.postingRequestId, {
        recoveredInvoiceId: invoiceId(recovered) ?? null,
        providerRecordId: record?.providerRecordId ?? null,
        recoveredPostingRequestId: postingId(recovered) ?? null,
        originalPostingRequestId: unknownPosting?.postingRequestId ?? null,
      }, [...recovered.evidenceRefs, finalRef], "Readback recovery must preserve both Provider and repository identifiers."),
      oracle("recovery_readback_only", !recoveryProviderMethods.includes("createDraftSupplierBill") && recoveryProviderMethods.includes("getSupplierBill") && harness.provider.readbackCalls === 1, {
        recoveryProviderMethods,
        readbackCalls: harness.provider.readbackCalls,
      }, recovered.evidenceRefs, "Post-restart recovery must use exact readback and never a second create."),
      oracle("no_write_retry", writesBeforeRestart === 1 && harness.provider.writeAttempts === 1, {
        writesBeforeRestart,
        writesAfterRecovery: harness.provider.writeAttempts,
      }, refs, "Timeout recovery must not retry the Provider write."),
      oracle("one_record_after_recovery", recordsBeforeRestart === 1 && harness.provider.records.length === 1, {
        recordsBeforeRestart,
        recordsAfterRecovery: harness.provider.records.length,
      }, refs, "Timeout recovery must end with exactly one Provider record."),
      oracle("recovery_final_verified_draft", finalPosting?.state === "APPROVAL_PENDING" && isReplay(recovered) === true, {
        postingState: finalPosting?.state ?? null,
        idempotentReplay: isReplay(recovered) ?? null,
      }, [finalRef, ...recovered.evidenceRefs], "Successful readback recovery must return to approval-pending DRAFT state as an idempotent replay."),
      oracle("recovery_gate_closed", !harness.gate.isOpen, { gateState: "CLOSED" }, refs, "The controlled gate must end closed."),
    ];
    return {
      caseResult: finalizeCase({
        scenario: options.scenario,
        oracleResults,
        evidenceRefs: refs,
        writeReceipt: writeReceipt({ requestId: input.request_id, created: recovered, replayObserved: true, provider: harness.provider }),
      }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

async function runReadbackMismatchCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const stepInput = scenarioStep(options.scenario, "inject_readback_mismatch").input;
  const requestId = typeof stepInput?.request_id === "string" ? stepInput.request_id : "p0.readback-mismatch.001";
  const input = materialInput({ material: options.material, requestId });
  const newRequest = createDraftSupplierBillSchema.parse({ ...input, request_id: "p0.readback-mismatch.002" });
  const refs: string[] = [];
  try {
    const runtime = await harness.startRuntime("runtime-1");
    const endpoint = await harness.openEndpoint(runtime, "readback-mismatch");
    const prepared = await prepareForExecution({
      harness,
      endpoint,
      stepId: "inject_readback_mismatch",
      input,
      material: options.material,
    });
    refs.push(...prepared.preparation.evidenceRefs, harness.openGate());
    harness.provider.armNextDraftFault("DRAFT_READBACK_MISMATCH");
    const faultRef = harness.evidence.add(harness.caseId, "STATE_PROBE", "fault:draft_readback_mismatch", {
      faultProfile: "draft_readback_mismatch",
      committedRecordCurrency: input.currency,
      immediateResponseCurrency: input.currency === "HKD" ? "USD" : "HKD",
    });
    const mismatch = await executeTool({
      harness,
      endpoint,
      stepId: "inject_readback_mismatch",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const mismatchPosting = await postingForInput(harness, input);
    const mismatchRef = capturePosting(harness, "readback-mismatch-active-state", mismatchPosting);
    const sameRequestReplay = await executeTool({
      harness,
      endpoint,
      stepId: "same_request_after_mismatch",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const preparedNewRequest = await prepareForExecution({
      harness,
      endpoint,
      stepId: "new_request_after_mismatch",
      input: newRequest,
      material: options.material,
    });
    const newRequestReplay = await executeTool({
      harness,
      endpoint,
      stepId: "new_request_after_mismatch",
      tool: CREATE_TOOL,
      input: asJsonObject(preparedNewRequest.command),
    });
    refs.push(
      faultRef,
      ...mismatch.evidenceRefs,
      mismatchRef,
      ...sameRequestReplay.evidenceRefs,
      ...preparedNewRequest.preparation.evidenceRefs,
      ...newRequestReplay.evidenceRefs,
      harness.closeGate(),
      harness.endGate(),
    );
    const committedRecord = harness.provider.records[0];
    const mismatchReceipt = mismatchPosting?.draftWriteReceipt;
    const mismatchSnapshot = mismatchPosting?.draftReadbackSnapshot;
    const oracleResults = [
      oracle("readback_mismatch_error", mismatch.errorCode === "READBACK_MISMATCH", mismatch.errorCode ?? null, mismatch.evidenceRefs, "A mutated immediate readback must surface READBACK_MISMATCH."),
      oracle("mismatch_remains_active", mismatchPosting?.state === "READBACK_MISMATCH" &&
        mismatchPosting.xeroInvoiceId === committedRecord?.providerRecordId &&
        mismatchReceipt?.invoiceId === committedRecord?.providerRecordId &&
        mismatchSnapshot?.invoiceId === committedRecord?.providerRecordId, {
        postingState: mismatchPosting?.state ?? null,
        xeroInvoiceId: mismatchPosting?.xeroInvoiceId ?? null,
        receiptInvoiceId: mismatchReceipt?.invoiceId ?? null,
        snapshotInvoiceId: mismatchSnapshot?.invoiceId ?? null,
        providerRecordId: committedRecord?.providerRecordId ?? null,
      }, [mismatchRef], "The active mismatch must retain the exact unverified Provider ID, receipt, and snapshot for investigation without claiming verification."),
      oracle("same_request_mismatch_no_retry", sameRequestReplay.errorCode === "CONFLICT", sameRequestReplay.errorCode ?? null, sameRequestReplay.evidenceRefs, "Replaying the same mismatched request must conflict without writing again."),
      oracle("new_request_mismatch_still_blocks", newRequestReplay.errorCode === "CONFLICT", newRequestReplay.errorCode ?? null, newRequestReplay.evidenceRefs, "A new request for the same document must remain blocked after mismatch."),
      oracle("mismatch_one_write", harness.provider.writeAttempts === 1, harness.provider.writeAttempts, refs, "Readback mismatch must never trigger a second Provider create."),
      oracle("mismatch_one_record", harness.provider.records.length === 1, harness.provider.records.length, refs, "The committed Provider record ledger must contain exactly one record."),
      oracle("mismatch_not_verified", mismatchPosting !== undefined && !["APPROVAL_PENDING", "APPROVED", "AUTHORISED_READBACK_VERIFIED"].includes(mismatchPosting.state), mismatchPosting?.state ?? null, [mismatchRef], "A mismatch must never be represented as a verified DRAFT or authorised record."),
      oracle("mismatch_gate_closed", !harness.gate.isOpen, { gateState: "CLOSED" }, refs, "The controlled gate must end closed."),
    ];
    return {
      caseResult: finalizeCase({ scenario: options.scenario, oracleResults, evidenceRefs: refs }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

async function runRepositoryCompletionCase(options: {
  scenario: ScenarioCase;
  ledgerFixture: unknown;
  material: JsonObject;
  evidence: EvidenceCollector;
}): Promise<CaseExecutionResult> {
  const harness = new CaseHarness({ caseId: options.scenario.id, evidence: options.evidence, ledgerFixture: options.ledgerFixture });
  const stepInput = scenarioStep(options.scenario, "inject_repository_completion_loss").input;
  const requestId = typeof stepInput?.request_id === "string" ? stepInput.request_id : "p0.repository-completion.001";
  const input = materialInput({ material: options.material, requestId });
  const refs: string[] = [];
  try {
    const runtime1 = await harness.startRuntime("runtime-1");
    const endpoint1 = await harness.openEndpoint(runtime1, "repository-before-restart");
    const prepared = await prepareForExecution({
      harness,
      endpoint: endpoint1,
      stepId: "inject_repository_completion_loss",
      input,
      material: options.material,
    });
    refs.push(...prepared.preparation.evidenceRefs, harness.openGate());
    harness.repositoryFault.failMarkDraftCreatedOnce = true;
    const faultRef = harness.evidence.add(harness.caseId, "STATE_PROBE", "fault:repository_completion_failure_after_commit", {
      faultProfile: "repository_completion_failure_after_commit",
      failOperation: "markDraftCreated",
      failCount: 1,
    });
    const initial = await executeTool({
      harness,
      endpoint: endpoint1,
      stepId: "inject_repository_completion_loss",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const unknownPosting = await postingForInput(harness, input);
    const unknownRef = capturePosting(harness, "repository-completion-loss-state", unknownPosting);
    const faultEventsRef = harness.evidence.add(harness.caseId, "REPOSITORY_STATE", "repository-fault-events", {
      events: harness.repositoryFault.events,
      completionFailureCount: harness.repositoryFault.completionFailureCount,
    });
    refs.push(faultRef, ...initial.evidenceRefs, unknownRef, faultEventsRef);
    const writesBeforeRestart = harness.provider.writeAttempts;
    const recordsBeforeRestart = harness.provider.records.length;
    await harness.closeRuntime(runtime1);
    const runtime2 = await harness.startRuntime("runtime-2");
    const endpoint2 = await harness.openEndpoint(runtime2, "repository-after-restart");
    const providerCallsBeforeRecovery = harness.provider.calls.length;
    const recovered = await executeTool({
      harness,
      endpoint: endpoint2,
      stepId: "recover_completion_loss",
      tool: CREATE_TOOL,
      input: asJsonObject(prepared.command),
    });
    const genericMutationId = mutationRequestIdForPreparation(prepared.preparation);
    const genericMutation = genericMutationId
      ? await harness.backingRepository.getXeroMutationRequest(genericMutationId)
      : undefined;
    const genericMutationRef = harness.evidence.add(
      harness.caseId,
      "REPOSITORY_STATE",
      "repository-completion-mutation-state",
      { mutation: genericMutation ?? null },
    );
    const recoveryProviderMethods = harness.provider.calls.slice(providerCallsBeforeRecovery).map((call) => call.method);
    const finalPosting = postingId(recovered)
      ? await harness.backingRepository.getPosting(postingId(recovered) as string)
      : await postingForInput(harness, input);
    const finalRef = capturePosting(harness, "repository-completion-recovery-final-state", finalPosting);
    refs.push(...recovered.evidenceRefs, genericMutationRef, finalRef, harness.closeGate(), harness.endGate());
    const record = harness.provider.records[0];
    const oracleResults = [
      oracle("completion_loss_unknown", initial.errorCode === "WRITE_RESULT_UNKNOWN" && unknownPosting?.state === "WRITE_RESULT_UNKNOWN", {
        errorCode: initial.errorCode ?? null,
        postingState: unknownPosting?.state ?? null,
        knownInvoiceId: unknownPosting?.xeroInvoiceId ?? null,
      }, [...initial.evidenceRefs, unknownRef], "A lost completion update must be represented as WRITE_RESULT_UNKNOWN."),
      oracle("completion_failure_injected_once", harness.repositoryFault.completionFailureCount === 1, {
        completionFailureCount: harness.repositoryFault.completionFailureCount,
        events: harness.repositoryFault.events,
      }, [faultEventsRef], "The repository completion fault must fire exactly once after Provider commit."),
      oracle("repository_reinstantiated", runtime1.instanceId !== runtime2.instanceId, {
        before: runtime1.instanceId,
        after: runtime2.instanceId,
        sharedBackingRepository: true,
      }, refs, "The recovery call must use a new service and repository facade over persisted in-memory state."),
      oracle("completion_recovery_same_id", !recovered.isError && invoiceId(recovered) === record?.providerRecordId && postingId(recovered) === unknownPosting?.postingRequestId, {
        recoveredInvoiceId: invoiceId(recovered) ?? null,
        providerRecordId: record?.providerRecordId ?? null,
        recoveredPostingRequestId: postingId(recovered) ?? null,
        originalPostingRequestId: unknownPosting?.postingRequestId ?? null,
      }, [...recovered.evidenceRefs, finalRef], "Completion-loss recovery must preserve the committed Provider and repository IDs."),
      oracle("completion_recovery_readback_only", !recoveryProviderMethods.includes("createDraftSupplierBill") && recoveryProviderMethods.includes("getSupplierBill") && harness.provider.readbackCalls === 1, {
        recoveryProviderMethods,
        readbackCalls: harness.provider.readbackCalls,
      }, recovered.evidenceRefs, "Completion-loss recovery must perform exact readback without a second create."),
      oracle("completion_loss_no_retry", writesBeforeRestart === 1 && harness.provider.writeAttempts === 1, {
        writesBeforeRestart,
        writesAfterRecovery: harness.provider.writeAttempts,
      }, refs, "Completion loss must never trigger a Provider write retry."),
      oracle("completion_loss_one_record", recordsBeforeRestart === 1 && harness.provider.records.length === 1, {
        recordsBeforeRestart,
        recordsAfterRecovery: harness.provider.records.length,
      }, refs, "Completion-loss recovery must end with one Provider record."),
      oracle("completion_recovery_final_state", finalPosting?.state === "APPROVAL_PENDING" && isReplay(recovered) === true, {
        postingState: finalPosting?.state ?? null,
        idempotentReplay: isReplay(recovered) ?? null,
      }, [finalRef, ...recovered.evidenceRefs], "Recovered completion must be an approval-pending idempotent DRAFT result."),
      oracle("completion_gate_closed", !harness.gate.isOpen, { gateState: "CLOSED" }, refs, "The controlled gate must end closed."),
    ];
    return {
      caseResult: finalizeCase({
        scenario: options.scenario,
        oracleResults,
        evidenceRefs: refs,
        writeReceipt: writeReceipt({ requestId, created: recovered, replayObserved: true, provider: harness.provider }),
      }),
      providerWriteAttempts: harness.provider.writeAttempts,
      providerAuthoriseAttempts: harness.provider.authoriseAttempts,
      providerRecords: harness.provider.records,
      gateEvents: harness.gate.events,
    };
  } finally {
    if (harness.gate.isOpen) harness.closeGate();
    await harness.closeAll();
  }
}

function failedCase(
  scenario: ScenarioCase,
  evidence: EvidenceCollector,
  error: unknown,
): CaseExecutionResult {
  const observed = error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
  const ref = evidence.add(scenario.id, "STATE_PROBE", "runner-case-failure", observed);
  return {
    caseResult: finalizeCase({
      scenario,
      oracleResults: [oracle("runner_completed", false, observed, [ref], "The case runner failed before all hard evidence was captured.")],
      evidenceRefs: [ref],
      notes: "No PASS was synthesized after an incomplete controlled-write execution.",
    }),
    providerWriteAttempts: 0,
    providerAuthoriseAttempts: 0,
    providerRecords: [],
    gateEvents: [],
  };
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

function summaryMarkdown(
  report: OracleRunResult,
  providerWriteAttempts: number,
  providerRecords: number,
  providerAuthoriseAttempts: number,
): string {
  const rows = report.case_results.map((result) =>
    `| ${result.case_id} | ${result.baseline_expectation} | ${result.actual_status} | ${result.hard_gate_passed ? "yes" : "no"} | ${result.expected_red_observed ? "yes" : "no"} |`);
  return [
    "# Xero MCP local P0 controlled-write result",
    "",
    `- Run: ${report.run_id}`,
    `- Cases: ${report.summary.total}; PASS ${report.summary.pass}; FAIL ${report.summary.fail}`,
    `- Synthetic Provider create calls: ${providerWriteAttempts}`,
    `- Synthetic Provider records: ${providerRecords}`,
    `- Provider AUTHORISE calls: ${providerAuthoriseAttempts}`,
    `- Suite write gate: ${report.environment.write_gate_start} -> case-scoped OPEN -> ${report.environment.write_gate_end}`,
    "- Data class: SYNTHETIC_ONLY; no Agent2, browser, Xero network, AUTHORISE, or payment call is present.",
    "",
    "| Case | Baseline | Actual | Hard gates | Expected red observed |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "PASS is derived from production MCP and AccountingService results, InMemory repository state, synthetic Provider call/record ledgers, and explicit fault/gate receipts.",
    "",
  ].join("\n");
}

function parseRunId(argv: string[]): string {
  const index = argv.indexOf("--run-id");
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  const runId = explicit ?? `p0-controlled-write-${new Date().toISOString().replaceAll(":", "-")}`;
  if (!/^[A-Za-z0-9._-]{8,160}$/u.test(runId)) {
    throw new Error("run ID must use 8-160 letters, numbers, dots, underscores, or hyphens");
  }
  return runId;
}

function parseOutputDirectory(argv: string[]): string | undefined {
  const index = argv.indexOf("--output-dir");
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function executeP0ControlledWriteSuite(
  options: ExecuteP0ControlledWriteOptions = {},
): Promise<ExecuteP0ControlledWriteResult> {
  const runId = options.runId ?? `p0-controlled-write-${new Date().toISOString().replaceAll(":", "-")}`;
  const startedAt = new Date().toISOString();
  const [scenarioRaw, ledgerFixtureRaw, materialRaw] = await Promise.all([
    readFile(scenarioPath, "utf8"),
    readFile(ledgerFixturePath, "utf8"),
    readFile(materialFixturePath, "utf8"),
  ]);
  const manifest = JSON.parse(scenarioRaw) as ScenarioManifest;
  const ledgerFixture = JSON.parse(ledgerFixtureRaw) as unknown;
  const material = JSON.parse(materialRaw) as JsonObject;
  const scenarios = TARGET_CASE_IDS.map((caseId) => {
    const scenario = manifest.cases.find((candidate) => candidate.id === caseId);
    if (!scenario) throw new Error(`Required controlled-write case ${caseId} is missing from ${scenarioPath}.`);
    return scenario;
  });
  const evidence = new EvidenceCollector(runId);
  const executions: CaseExecutionResult[] = [];
  for (const scenario of scenarios) {
    try {
      if (scenario.id === "DC-IDEMPOTENCY-012") {
        executions.push(await runIdempotencyCase({ scenario, ledgerFixture, material, evidence }));
      } else if (scenario.id === "DC-CONCURRENT-012B") {
        executions.push(await runConcurrentCase({ scenario, ledgerFixture, material, evidence }));
      } else if (scenario.id === "DC-DUPLICATE-013") {
        executions.push(await runDuplicateCase({ scenario, ledgerFixture, material, evidence }));
      } else if (scenario.id === "DC-RECOVERY-014") {
        executions.push(await runRecoveryCase({ scenario, ledgerFixture, material, evidence }));
      } else if (scenario.id === "DC-READBACK-014B") {
        executions.push(await runReadbackMismatchCase({ scenario, ledgerFixture, material, evidence }));
      } else if (scenario.id === "DC-REPOSITORY-014C") {
        executions.push(await runRepositoryCompletionCase({ scenario, ledgerFixture, material, evidence }));
      } else {
        executions.push(failedCase(scenario, evidence, new Error(`No executable runner for ${scenario.id}.`)));
      }
    } catch (error) {
      executions.push(failedCase(scenario, evidence, error));
    }
  }

  const caseResults = executions.map((execution) => execution.caseResult);
  const providerWriteAttempts = executions.reduce((sum, execution) => sum + execution.providerWriteAttempts, 0);
  const providerAuthoriseAttempts = executions.reduce((sum, execution) => sum + execution.providerAuthoriseAttempts, 0);
  const providerRecords = executions.flatMap((execution, index) =>
    execution.providerRecords.map((record) => ({ ...record, case_id: scenarios[index]?.id ?? "UNKNOWN" })));
  const gateEvents = executions.flatMap((execution) => execution.gateEvents);
  const report = oracleRunSchema.parse({
    schema_version: "1.0",
    run_id: runId,
    suite_id: manifest.suite_id,
    layer: manifest.layer,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: {
      target: "IN_MEMORY",
      data_class: "SYNTHETIC_ONLY",
      write_gate_start: "CLOSED",
      write_gate_end: "CLOSED",
      secrets_redacted: true,
      oauth_binding_fingerprint: hashObject({
        workspaceId: "workspace_p0_write",
        subjectType: "USER",
        subjectId: "accountant_p0_write",
        connectionId: "connection_xero_harness_001",
        scopes: ["xero.read", "xero.draft.write"],
      }),
    },
    case_results: caseResults,
    summary: statusSummary(caseResults),
    claim_guardrail_violations: [],
  });

  let artifactPaths: ExecuteP0ControlledWriteResult["artifactPaths"];
  if (options.writeArtifacts !== false) {
    const outputDirectory = options.outputDirectory ?? resolve(repoRoot, "artifacts/harness-runs", runId, "p0-controlled-write");
    const oracleResultsPath = resolve(outputDirectory, "oracle-results.jsonl");
    const evidencePath = resolve(outputDirectory, "evidence.jsonl");
    const providerRecordsPath = resolve(outputDirectory, "provider-records.jsonl");
    const gateEventsPath = resolve(outputDirectory, "write-gate-events.jsonl");
    const summaryPath = resolve(outputDirectory, "summary.md");
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(oracleResultsPath, `${JSON.stringify(report)}\n`, "utf8"),
      writeFile(evidencePath, `${evidence.records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
      writeFile(providerRecordsPath, `${providerRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
      writeFile(gateEventsPath, `${gateEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"),
      writeFile(summaryPath, summaryMarkdown(report, providerWriteAttempts, providerRecords.length, providerAuthoriseAttempts), "utf8"),
    ]);
    artifactPaths = {
      oracleResults: oracleResultsPath,
      evidence: evidencePath,
      providerRecords: providerRecordsPath,
      gateEvents: gateEventsPath,
      summary: summaryPath,
    };
  }
  return {
    report,
    evidence: evidence.records,
    providerWriteAttempts,
    providerAuthoriseAttempts,
    providerRecords,
    gateEvents,
    ...(artifactPaths ? { artifactPaths } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outputDirectory = parseOutputDirectory(argv);
  const result = await executeP0ControlledWriteSuite({
    runId: parseRunId(argv),
    ...(outputDirectory ? { outputDirectory: resolve(outputDirectory) } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    runId: result.report.run_id,
    summary: result.report.summary,
    providerWriteAttempts: result.providerWriteAttempts,
    providerRecords: result.providerRecords.length,
    providerAuthoriseAttempts: result.providerAuthoriseAttempts,
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
