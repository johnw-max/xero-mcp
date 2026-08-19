import type { BindingSubjectType } from "./models.js";
import type { AccountingCaseOperation, AccountingCaseSourceSystem, CompiledAccountingCase } from "./accountingCase.js";
import type { AccountingCaseBusinessContinuationTemplate } from "./accountingCaseContinuation.js";
import type { XeroMutationObjectType, XeroMutationOperation } from "./xeroMutation.js";
import { hashObject } from "../security/hash.js";

export const ACCOUNTING_CASE_PLAN_SCHEMA_VERSION = "xero-accounting-case-plan:v1";
export const ACCOUNTING_CASE_PREFLIGHT_RECEIPT_SCHEMA_VERSION = "xero-accounting-case-preflight-receipt:v1";
export const ACCOUNTING_CASE_PREFLIGHT_RESEAL_RECEIPT_SCHEMA_VERSION =
  "xero-accounting-case-preflight-reseal-receipt:v1";

/**
 * A preparation with less runway than this is replaced before a Case claim.
 * This does not extend the mutation preparation TTL; a reseal creates a new
 * normal, short-lived preparation under freshly checked live authority.
 */
export const ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS = 30_000;

export interface AccountingCaseBinding {
  actorId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  installationId: string;
  bindingId: string;
  bindingRevision: number;
  connectionId: string;
  tenantId: string;
  targetSessionId: string;
  targetSessionHash: string;
  targetSessionExpiresAt: Date;
}

function bindingPlanProjection(binding: AccountingCaseBinding): Record<string, unknown> {
  return {
    actorId: binding.actorId,
    workspaceId: binding.workspaceId,
    subjectType: binding.subjectType,
    subjectId: binding.subjectId,
    agentId: binding.agentId,
    installationId: binding.installationId,
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    connectionId: binding.connectionId,
    tenantId: binding.tenantId,
    targetSessionId: binding.targetSessionId,
    targetSessionHash: binding.targetSessionHash,
    targetSessionExpiresAt: binding.targetSessionExpiresAt.toISOString(),
  };
}

/** One canonical integrity identity shared by service, in-memory and PostgreSQL. */
export function accountingCasePlanHash(
  binding: AccountingCaseBinding,
  compiled: CompiledAccountingCase,
): string {
  return hashObject({
    schemaVersion: ACCOUNTING_CASE_PLAN_SCHEMA_VERSION,
    binding: bindingPlanProjection(binding),
    compiled,
  });
}

/** Canonical integrity identity for the durable whole-Case preflight receipt. */
export function accountingCasePreflightReceiptHash(input: {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  compiledPlanHash: string;
  requestId: string;
  preflightReceipt: Record<string, unknown>;
}): string {
  return hashObject({
    schemaVersion: ACCOUNTING_CASE_PREFLIGHT_RECEIPT_SCHEMA_VERSION,
    binding: bindingPlanProjection(input.binding),
    caseId: input.caseId,
    version: input.version,
    compiledPlanHash: input.compiledPlanHash,
    requestId: input.requestId,
    preflightReceipt: input.preflightReceipt,
  });
}

/** Canonical link in the append-only same-version preflight reseal chain. */
export function accountingCasePreflightResealReceiptHash(input: {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  compiledPlanHash: string;
  originalPreflightReceiptHash: string;
  previousEffectiveSealHash: string;
  revision: number;
  requestId: string;
  resealReceipt: AccountingCasePreflightResealReceipt;
}): string {
  return hashObject({
    schemaVersion: ACCOUNTING_CASE_PREFLIGHT_RESEAL_RECEIPT_SCHEMA_VERSION,
    binding: bindingPlanProjection(input.binding),
    caseId: input.caseId,
    version: input.version,
    compiledPlanHash: input.compiledPlanHash,
    originalPreflightReceiptHash: input.originalPreflightReceiptHash,
    previousEffectiveSealHash: input.previousEffectiveSealHash,
    revision: input.revision,
    requestId: input.requestId,
    resealReceipt: input.resealReceipt,
  });
}

export type AccountingCaseVersionState =
  | "BLOCKED_COVERAGE"
  | "BLOCKED_VALIDATION"
  | "PLANNED_NEEDS_PREFLIGHT"
  | "PLANNED_WITH_EXCEPTIONS"
  | "PREFLIGHTED"
  | "READY_TO_RESUME"
  | "EXECUTING"
  | "RECOVERY_REQUIRED"
  | "AWAITING_CONTINUATION"
  | "PARTIALLY_COMMITTED"
  | "TERMINAL";

export type AccountingCaseOperationState =
  | "PENDING"
  | "PREPARED"
  | "WRITE_IN_FLIGHT"
  | "NO_WRITE_REQUIRED"
  | "READBACK_VERIFIED"
  | "WRITE_UNCERTAIN"
  | "READBACK_MISMATCH"
  | "PROVIDER_REJECTED"
  | "BLOCKED_VALIDATION"
  | "NOT_EXECUTED_AFTER_PRIOR_FAILURE"
  | "NOT_EXECUTED_AFTER_TARGET_EXPIRY";

export interface AccountingCaseRecoveryResidualGrant {
  grantId: string;
  sourceCaseId: string;
  sourceVersion: number;
  sourcePlanHash: string;
  successorCaseId: string;
  residualOperationIds: string[];
  template: AccountingCaseBusinessContinuationTemplate;
  templateHash: string;
  successorBinding: AccountingCaseBinding;
  state: "ISSUED" | "CONSUMED";
  consumedPlanHash?: string;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountingCaseOperationRecord {
  operation: AccountingCaseOperation;
  ordinal: number;
  state: AccountingCaseOperationState;
  preparationId?: string;
  /** First preparation sealed by the immutable original preflight receipt. */
  originalPreparationId?: string;
  /** Immutable hash of the provider-specific proposal persisted by the mutation kernel. */
  preparationCanonicalPayloadHash?: string;
  /** Immutable, per-operation source fingerprint persisted by the mutation kernel. */
  sourceSha256?: string;
  mutationRequestId?: string;
  xeroObjectId?: string;
  writeReceipt?: Record<string, unknown>;
  readbackSnapshot?: Record<string, unknown>;
  errorReceipt?: Record<string, unknown>;
  updatedAt: Date;
}

export type AccountingCaseOperationPreflight =
  | {
      operationId: string;
      state: "PREPARED";
      preparationId: string;
      operationCanonicalPayloadHash: string;
      preparationCanonicalPayloadHash: string;
      sourceSha256: string;
    }
  | {
      operationId: string;
      state: "NO_WRITE_REQUIRED";
      xeroObjectId: string;
      readbackSnapshot: Record<string, unknown>;
    };

export interface AccountingCaseVersionRecord {
  binding: AccountingCaseBinding;
  compiled: CompiledAccountingCase;
  compiledPlanHash: string;
  /** Immutable for the life of this case_id, fixed by whichever version first cited it (or omitted it). */
  sourceCase?: AccountingCaseSourceCaseReference;
  /** Fixed evidence observed the exact instant this version was prepared; never recomputed on later reads. */
  sourceCaseClaim: AccountingCaseSourceCaseClaim;
  state: AccountingCaseVersionState;
  preflightRequestId?: string;
  preflightReceipt?: Record<string, unknown>;
  preflightReceiptHash?: string;
  preflightedAt?: Date;
  /** Immutable alias of the original preflight receipt hash. */
  originalPreflightReceiptHash?: string;
  /** Original receipt hash at revision 0, otherwise the last reseal receipt hash. */
  effectivePreflightSealHash?: string;
  effectivePreflightSealedAt?: Date;
  preflightResealRevision?: number;
  preflightReseals?: AccountingCasePreflightResealRecord[];
  executionRequestId?: string;
  executionStartedAt?: Date;
  lastExecutionErrorReceipt?: Record<string, unknown>;
  terminalSummary?: Record<string, unknown>;
  recoveryResidualGrant?: AccountingCaseRecoveryResidualGrant;
  operations: AccountingCaseOperationRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrAdvanceAccountingCaseInput {
  binding: AccountingCaseBinding;
  compiled: CompiledAccountingCase;
  compiledPlanHash: string;
  /** Must equal the case_id's already-established source case (if any); the repository re-checks this. */
  sourceCase?: AccountingCaseSourceCaseReference;
  sourceCaseClaim: AccountingCaseSourceCaseClaim;
  continuationAuthorization?: {
    sourceVersion: number;
    templateHash: string;
  };
  recoveryResidualAuthorization?: {
    grantId: string;
    sourceCaseId: string;
    sourceVersion: number;
    successorCaseId: string;
    templateHash: string;
  };
  now: Date;
}

export interface CreateOrAdvanceAccountingCaseResult {
  mode: "CREATED" | "ADVANCED" | "IDEMPOTENT_REPLAY";
  record: AccountingCaseVersionRecord;
}

export interface GetBoundAccountingCaseInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version?: number;
}

/**
 * Looks up a Case using current live access authority while returning the
 * original immutable target binding as evidence. Identity, tenant and
 * connection must remain exact; only the short-lived target session may be
 * renewed.
 */
export interface GetAccessibleAccountingCaseInput {
  currentAccessBinding: AccountingCaseBinding;
  caseId: string;
  version?: number;
  mode: "STATUS" | "RECOVERY_GET_ONLY";
  now: Date;
}

/**
 * Current-version operation states that make a Case worth a human's
 * attention: an uncertain or unread-back write, or residual work abandoned
 * when its target session expired mid-execution. Kept separate from
 * accountingCaseTerminalSummary's broader "uncertain"/"residual" groupings
 * below, which serve the terminal-projection receipt, not discovery.
 */
export const ACCOUNTING_CASE_ATTENTION_OPERATION_STATES: readonly AccountingCaseOperationState[] = [
  "WRITE_UNCERTAIN",
  "WRITE_IN_FLIGHT",
  "READBACK_MISMATCH",
  "NOT_EXECUTED_AFTER_TARGET_EXPIRY",
];

export interface AccountingCaseAttentionOperationSummary {
  operationId: string;
  state: AccountingCaseOperationState;
  xeroObjectId?: string;
}

export interface AccountingCaseAttentionSummary {
  caseId: string;
  caseVersion: number;
  state: AccountingCaseVersionState;
  /** Only the operations in ACCOUNTING_CASE_ATTENTION_OPERATION_STATES, not every operation on the case. */
  operations: AccountingCaseAttentionOperationSummary[];
}

/**
 * Discovery-only enumeration for a caller that has lost track of a Case:
 * every case_id, past or present, still needing a human or a follow-up
 * execute() call. Scoped by the same durable access identity as
 * getAccessibleAccountingCase (target-session evidence intentionally
 * excluded, exactly like GetAccessibleAccountingCaseInput above) so a caller
 * only ever sees its own workspace/agent/tenant binding's work.
 */
export interface ListAttentionAccountingCasesInput {
  currentAccessBinding: AccountingCaseBinding;
  /** Positive integer; the repository returns at most this many cases. */
  limit: number;
}

export interface ListAttentionAccountingCasesResult {
  /** Newest (by version updated_at) first. */
  cases: AccountingCaseAttentionSummary[];
  /** True when more matching cases exist beyond this page. */
  hasMore: boolean;
}

export interface ClaimAccountingCaseExecutionInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  expectedPlanHash: string;
  accessMode?: "EXACT_TARGET" | "RECOVERY_GET_ONLY";
  /** Exact-target claims reject sealed preparations with less runway. */
  minimumPreparationExpiresAt?: Date;
  now: Date;
}

export interface AccountingCaseOperationReseal {
  operationId: string;
  oldPreparationId: string;
  newPreparationId: string;
  operationCanonicalPayloadHash: string;
  preparationCanonicalPayloadHash: string;
  sourceSha256: string;
  newPreparationExpiresAt: string;
}

export interface AccountingCasePreflightResealReceipt {
  receiptType: "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL";
  receiptVersion: 1;
  caseId: string;
  caseVersion: number;
  requestId: string;
  compiledPlanHash: string;
  originalPreflightReceiptHash: string;
  previousEffectiveSealHash: string;
  revision: number;
  authorityReceipt: object;
  operations: AccountingCaseOperationReseal[];
  minimumPreparationExpiresAt: string;
  checkedAt: string;
}

export interface AccountingCasePreflightResealRecord {
  revision: number;
  requestId: string;
  previousEffectiveSealHash: string;
  effectiveSealHash: string;
  receipt: AccountingCasePreflightResealReceipt;
  resealedAt: Date;
}

export interface ResealAndClaimAccountingCaseExecutionInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  expectedPlanHash: string;
  expectedOriginalPreflightReceiptHash: string;
  expectedEffectiveSealHash: string;
  expectedResealRevision: number;
  resealReceipt: AccountingCasePreflightResealReceipt;
  resealReceiptHash: string;
  operations: AccountingCaseOperationReseal[];
  /** Every replacement preparation must remain valid beyond this instant. */
  minimumPreparationExpiresAt: Date;
  now: Date;
}

export interface ResealAndClaimAccountingCaseExecutionResult {
  mode: "RESEALED_AND_CLAIMED" | "RESUME" | "ALREADY_TERMINAL";
  record: AccountingCaseVersionRecord;
}

export interface RecordAccountingCasePreflightInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  expectedPlanHash: string;
  preflightReceipt: Record<string, unknown>;
  preflightReceiptHash: string;
  operations: AccountingCaseOperationPreflight[];
  now: Date;
}

export interface RecordAccountingCasePreflightResult {
  mode: "PREFLIGHTED" | "IDEMPOTENT_REPLAY";
  record: AccountingCaseVersionRecord;
}

export interface ClaimAccountingCaseExecutionResult {
  mode: "CLAIMED" | "RESUME" | "RECOVERY_GET_ONLY" | "ALREADY_TERMINAL";
  record: AccountingCaseVersionRecord;
}

/**
 * Atomically closes the crash window where the mutation kernel owns a
 * potentially-written provider request but the enclosing Case operation is
 * still PREPARED. The original target must be durably expired and current
 * access must be a different, live target for the same stable access tuple.
 */
export interface AdoptExpiredExecutingAccountingCaseForRecoveryInput {
  currentAccessBinding: AccountingCaseBinding;
  caseId: string;
  version: number;
  /** Must equal the original durable execution claim exactly. */
  requestId: string;
  expectedPlanHash: string;
  now: Date;
}

export interface AdoptExpiredExecutingAccountingCaseForRecoveryResult {
  mode: "ADOPTED";
  record: AccountingCaseVersionRecord;
}

export interface UpdateAccountingCaseOperationInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  operationId: string;
  /** Must own the durable Case execution claim. */
  requestId: string;
  expectedStates: AccountingCaseOperationState[];
  state: AccountingCaseOperationState;
  preparationId?: string;
  mutationRequestId?: string;
  xeroObjectId?: string;
  writeReceipt?: Record<string, unknown>;
  readbackSnapshot?: Record<string, unknown>;
  errorReceipt?: Record<string, unknown>;
  now: Date;
}

/**
 * Mutation-linked evidence is never accepted from the caller. The repository
 * locks the durable Xero mutation and projects its exact state/evidence into
 * the enclosing Case operation.
 */
export interface ProjectAccountingCaseOperationFromMutationInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  operationId: string;
  requestId: string;
  expectedStates: AccountingCaseOperationState[];
  mutationRequestId: string;
  desiredState:
    | "WRITE_IN_FLIGHT"
    | "READBACK_VERIFIED"
    | "WRITE_UNCERTAIN"
    | "READBACK_MISMATCH"
    | "PROVIDER_REJECTED"
    | "BLOCKED_VALIDATION";
  accessMode?: "EXACT_TARGET" | "RECOVERY_GET_ONLY";
  now: Date;
}

export interface PauseAccountingCaseExecutionInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  errorReceipt: Record<string, unknown>;
  now: Date;
}

export interface ReleaseAccountingCaseRecoveryInput {
  currentAccessBinding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  reasonReceipt: Record<string, unknown>;
  now: Date;
}

export interface CompleteExpiredTargetAccountingCaseRecoveryInput {
  currentAccessBinding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  continuation?: {
    grantId: string;
    successorCaseId: string;
    template: AccountingCaseBusinessContinuationTemplate;
    templateHash: string;
  };
  reasonReceipt: Record<string, unknown>;
  now: Date;
}

export interface GetAccountingCaseRecoveryResidualGrantInput {
  currentAccessBinding: AccountingCaseBinding;
  successorCaseId: string;
  now: Date;
}

export interface GetAccountingCaseRecoveryResidualGrantResult {
  grant: AccountingCaseRecoveryResidualGrant;
  source: AccountingCaseVersionRecord;
}

export interface AwaitAccountingCaseContinuationInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  now: Date;
}

export interface FinalizeAccountingCaseInput {
  binding: AccountingCaseBinding;
  caseId: string;
  version: number;
  requestId: string;
  accessMode?: "EXACT_TARGET" | "RECOVERY_GET_ONLY";
  state: "RECOVERY_REQUIRED" | "PARTIALLY_COMMITTED" | "TERMINAL";
  terminalSummary: Record<string, unknown>;
  now: Date;
}

export interface AccountingCaseMutationRoute {
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
}

export function accountingCaseMutationRoute(
  operation: Pick<AccountingCaseOperation, "actionId">,
): AccountingCaseMutationRoute {
  switch (operation.actionId) {
    case "contact.create_basic":
      return { objectType: "CONTACT", operation: "CREATE" };
    case "customer_invoice.create_draft":
      return { objectType: "SALES_INVOICE", operation: "CREATE_DRAFT" };
    case "supplier_bill.create_draft":
      return { objectType: "SUPPLIER_BILL", operation: "CREATE_DRAFT" };
    case "credit_note.create_draft":
      return { objectType: "CREDIT_NOTE", operation: "CREATE_DRAFT" };
  }
}

/**
 * Trust-on-first-use identity of the upstream (cross-MCP) material a Case's
 * submitted batch cites. Only the sha256 digest of the raw upstream case
 * reference is ever carried past the MCP boundary; the clear-text reference
 * itself must never be persisted, returned, or logged.
 */
export interface AccountingCaseSourceCaseReference {
  system: AccountingCaseSourceSystem;
  /** sha256 digest of the raw upstream case reference; never the reference itself. */
  caseRefHash: string;
}

export const ACCOUNTING_CASE_SOURCE_CASE_CLAIMS = [
  "SOURCE_CASE_ABSENT",
  "SOURCE_CASE_BOUND_FIRST_USE",
  "SOURCE_CASE_BOUND_CONFIRMED",
] as const;

/**
 * Evidence recorded once, at the exact version a Case was prepared, proving
 * only that this submission's upstream source case is consistently paired
 * with one Xero tenant. It never asserts the upstream material is correct.
 */
export type AccountingCaseSourceCaseClaim = typeof ACCOUNTING_CASE_SOURCE_CASE_CLAIMS[number];

/** True when both reference the same upstream case, or both cite none. */
export function sameAccountingCaseSourceCaseReference(
  left: AccountingCaseSourceCaseReference | undefined,
  right: AccountingCaseSourceCaseReference | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.system === right.system && left.caseRefHash === right.caseRefHash;
}

export type AccountingCaseSourceCaseBindingOutcome =
  | "BOUND_FIRST_USE"
  | "BOUND_CONFIRMED"
  | "TENANT_CONFLICT";

export interface BindAccountingCaseSourceCaseInput {
  workspaceId: string;
  sourceCase: AccountingCaseSourceCaseReference;
  tenantId: string;
  now: Date;
}

export interface BindAccountingCaseSourceCaseResult {
  outcome: AccountingCaseSourceCaseBindingOutcome;
}

/** Same durable authority subject; target-session evidence is intentionally excluded. */
export function sameAccountingCaseAccessIdentity(
  original: AccountingCaseBinding,
  current: AccountingCaseBinding,
): boolean {
  return original.actorId === current.actorId &&
    original.workspaceId === current.workspaceId &&
    original.subjectType === current.subjectType &&
    original.subjectId === current.subjectId &&
    original.agentId === current.agentId &&
    original.installationId === current.installationId &&
    original.bindingId === current.bindingId &&
    original.bindingRevision === current.bindingRevision &&
    original.connectionId === current.connectionId &&
    original.tenantId === current.tenantId;
}

export function accountingCaseTerminalSummary(
  record: Pick<AccountingCaseVersionRecord, "compiled" | "operations">,
  state: "RECOVERY_REQUIRED" | "PARTIALLY_COMMITTED" | "TERMINAL",
): Record<string, unknown> {
  const completed = new Set<AccountingCaseOperationState>(["READBACK_VERIFIED", "NO_WRITE_REQUIRED"]);
  const definiteFailed = new Set<AccountingCaseOperationState>(["PROVIDER_REJECTED", "BLOCKED_VALIDATION"]);
  const uncertain = new Set<AccountingCaseOperationState>(["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]);
  const residual = new Set<AccountingCaseOperationState>([
    "PENDING", "PREPARED", "NOT_EXECUTED_AFTER_PRIOR_FAILURE", "NOT_EXECUTED_AFTER_TARGET_EXPIRY",
  ]);
  const operationStates = record.operations.map((operation) => ({
    operationId: operation.operation.operationId,
    state: operation.state,
    mutationRequestId: operation.mutationRequestId ?? null,
    xeroObjectId: operation.xeroObjectId ?? null,
  }));
  const ids = (states: ReadonlySet<AccountingCaseOperationState>) => record.operations
    .filter((operation) => states.has(operation.state))
    .map((operation) => operation.operation.operationId);
  return {
    receiptType: "ACCOUNTING_CASE_TERMINAL_STATE_PROJECTION",
    receiptVersion: 1,
    caseId: record.compiled.caseId,
    caseVersion: record.compiled.version,
    state,
    operationStates,
    completedOperationIds: ids(completed),
    definiteFailureOperationIds: ids(definiteFailed),
    uncertainOperationIds: ids(uncertain),
    residualOperationIds: ids(residual),
  };
}
