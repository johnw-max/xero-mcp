import { AppError } from "../errors.js";
import type {
  AgentConnectionBinding,
  AuditCompletion,
  AuditIntent,
  AuditLog,
  AuditRecord,
  AuthorizedProviderConnection,
  BeginAuthoriseInput,
  BeginAuthoriseResult,
  BeginBrokerXeroCallbackInput,
  BeginReviewAuthoriseInput,
  BrokerSelectionContext,
  CompleteBrokerOrganisationSelectionInput,
  CompleteBrokerOrganisationSelectionResult,
  CompleteOrganisationSwitchInput,
  CompleteOrganisationSwitchResult,
  CompleteBrokerXeroExchangeInput,
  ConsumeOAuthAuthorizationCodeInput,
  ConsumeOAuthBrokerFlowInput,
  CreateBrokerAuthorizationFlowInput,
  CreateBrokerAuthorizationFlowResult,
  CreateMcpRefreshTokenFamilyInput,
  CreatePostingInput,
  DraftCreatedUpdate,
  DraftReadbackMismatchUpdate,
  ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ExchangeOAuthAuthorizationCodeForTokenSetResult,
  LedgerTargetSession,
  McpAccessToken,
  McpRefreshToken,
  McpRefreshTokenContextPreview,
  McpRefreshTokenFamily,
  OAuthAuthorizationCode,
  OAuthAuthorizationCodeExchangePreview,
  OAuthBrokerAuthorizationFlow,
  OAuthBrokerFlow,
  OAuthInstallation,
  OrganisationSwitchContext,
  OrganisationSwitchSession,
  PostingRequest,
  PostingState,
  PeekMcpRefreshTokenContextInput,
  PeekOAuthAuthorizationCodeForExchangeInput,
  ProviderAuthorization,
  ProviderConnection,
  RejectReviewInput,
  RevokeOAuthTokenForClientInput,
  RevokeOAuthTokenForClientResult,
  ResolveAgentConnectionBindingInput,
  ResolveLedgerTargetSessionInput,
  ResolvedAgentConnectionBinding,
  ResolvedLedgerTargetSession,
  ResolvedMcpAccessToken,
  ResolveMcpAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenResult,
  RotateMcpRefreshTokenInput,
  RotateMcpRefreshTokenResult,
  TerminateBrokerAuthorizationFlowInput,
  TerminateBrokerAuthorizationFlowResult,
  GetBrokerSelectionInput,
  GovernanceAuditEvent,
  GovernanceAuditEventInput,
} from "../domain/models.js";
import { MCP_OAUTH_REFRESH_RETRY_GRACE_MS } from "../domain/models.js";
import type {
  BeginXeroMutationWriteInput,
  BeginXeroMutationWriteResult,
  BoundXeroMutationRequestInput,
  CompleteXeroMutationReadbackInput,
  ConfirmXeroMutationPreparationInput,
  ConfirmXeroMutationPreparationResult,
  CreateXeroMutationPreparationInput,
  FailXeroMutationValidationInput,
  MarkXeroMutationWriteUnknownInput,
  RecordXeroMutationWriteEvidenceInput,
  RejectXeroMutationProviderInput,
  XeroMutationPreparation,
  XeroMutationRequest,
} from "../domain/xeroMutation.js";
import { XERO_MUTATION_EXPECTED_READBACK_STATUS } from "../domain/xeroMutation.js";
import type {
  AdoptExpiredExecutingAccountingCaseForRecoveryInput,
  AdoptExpiredExecutingAccountingCaseForRecoveryResult,
  AccountingCaseBinding,
  AccountingCaseOperationRecord,
  AccountingCaseOperationState,
  AccountingCaseVersionRecord,
  GetAccessibleAccountingCaseInput,
  RecordAccountingCasePreflightInput,
  RecordAccountingCasePreflightResult,
  ResealAndClaimAccountingCaseExecutionInput,
  ResealAndClaimAccountingCaseExecutionResult,
  ClaimAccountingCaseExecutionInput,
  ClaimAccountingCaseExecutionResult,
  CompleteExpiredTargetAccountingCaseRecoveryInput,
  CreateOrAdvanceAccountingCaseInput,
  CreateOrAdvanceAccountingCaseResult,
  AwaitAccountingCaseContinuationInput,
  FinalizeAccountingCaseInput,
  GetBoundAccountingCaseInput,
  GetAccountingCaseRecoveryResidualGrantInput,
  GetAccountingCaseRecoveryResidualGrantResult,
  PauseAccountingCaseExecutionInput,
  ProjectAccountingCaseOperationFromMutationInput,
  ReleaseAccountingCaseRecoveryInput,
  AccountingCaseRecoveryResidualGrant,
  UpdateAccountingCaseOperationInput,
} from "../domain/accountingCasePersistence.js";
import {
  hasAccountingCaseDependentContinuation,
  accountingCaseContinuationTemplateHash,
  accountingCaseRecoveryResidualContinuationTemplate,
  matchesAccountingCaseContinuationAuthorization,
  matchesAccountingCaseRecoveryResidualAuthorization,
} from "../domain/accountingCaseContinuation.js";
import {
  createLedgerAuthoritySnapshot,
  exactFirmGovernanceAuthorityFromSnapshot,
  ledgerFirmGovernanceReadinessEvidence,
  legacyLedgerAuthoritySnapshotV1Hash,
  type LedgerAuthoritySnapshot,
  type LedgerAuthorityRepositoryReadiness,
  type PublishLedgerAuthoritySnapshotInput,
  type PublishLedgerAuthoritySnapshotResult,
} from "../domain/ledgerAuthority.js";
import {
  ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS,
  accountingCaseMutationRoute,
  accountingCasePlanHash,
  accountingCasePreflightReceiptHash,
  accountingCasePreflightResealReceiptHash,
  accountingCaseTerminalSummary,
  sameAccountingCaseAccessIdentity,
} from "../domain/accountingCasePersistence.js";
import { hashObject, stableStringify } from "../security/hash.js";
import { governanceAuditEventHash } from "../governance/governanceAudit.js";
import type {
  AccountingRepository,
  EphemeralCleanupBatchResult,
  EphemeralCleanupCounts,
  FindActiveXeroPostingDuplicateInput,
  FindVerifiedAccountingCaseContactIdentityInput,
  ListVerifiedAccountingCaseContactIdentitiesInput,
  RepositoryReadinessEvidence,
  XeroNativeIdempotencyRecoveryClaim,
} from "./repository.js";
import {
  XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS,
  XERO_NATIVE_RECOVERY_ADAPTER_BY_ACTION,
} from "./repository.js";
import {
  isXeroPostingDuplicate,
  xeroSupplierPostingIdentity,
} from "./xeroPostingDuplicate.js";
import {
  evaluateActiveAccountingCaseRecoveryProjections,
  unknownActiveAccountingCaseRecoveryProjectionEvidence,
} from "./accountingCaseRecoveryProjectionReadiness.js";
import { validateXeroAccountingCaseReadbackEconomics } from "../policy/xeroAccountingCaseReadbackProjection.js";
import { accountingCaseBusinessReservationsOverlap } from "../domain/accountingCase.js";
import { xeroExistingDocumentNoWriteEvidenceMatches } from "../policy/xeroAccountingCaseExistingDocumentEvidence.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isScopeSubset(candidate: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return candidate.every((scope) => allowedSet.has(scope));
}

function hasSameScopes(left: string[], right: string[]): boolean {
  return isScopeSubset(left, right) && isScopeSubset(right, left);
}

function sameAccountingCaseBinding(left: AccountingCaseBinding, right: AccountingCaseBinding): boolean {
  return left.actorId === right.actorId &&
    left.workspaceId === right.workspaceId &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.agentId === right.agentId &&
    left.installationId === right.installationId &&
    left.bindingId === right.bindingId &&
    left.bindingRevision === right.bindingRevision &&
    left.connectionId === right.connectionId &&
    left.tenantId === right.tenantId &&
    left.targetSessionId === right.targetSessionId &&
    left.targetSessionHash === right.targetSessionHash &&
    left.targetSessionExpiresAt.getTime() === right.targetSessionExpiresAt.getTime();
}

function accountingCaseMutationProjectionErrorReceipt(
  request: XeroMutationRequest,
): Record<string, unknown> | undefined {
  if (request.state === "PROVIDER_REJECTED") return request.providerRejectionReceipt;
  if (request.state === "FAILED_VALIDATION") {
    return request.validationReceipt ?? {
      receiptType: "XERO_MUTATION_STATE_PROJECTION",
      mutationRequestId: request.mutationRequestId,
      mutationState: request.state,
    };
  }
  if (request.state === "WRITE_UNCERTAIN" || request.state === "READBACK_MISMATCH") {
    return {
      receiptType: "XERO_MUTATION_STATE_PROJECTION",
      mutationRequestId: request.mutationRequestId,
      mutationState: request.state,
    };
  }
  return undefined;
}

function accountingCaseStateForMutation(
  state: XeroMutationRequest["state"],
): ProjectAccountingCaseOperationFromMutationInput["desiredState"] | undefined {
  if (state === "FAILED_VALIDATION") return "BLOCKED_VALIDATION";
  if (state === "WRITE_IN_FLIGHT" || state === "WRITE_UNCERTAIN" || state === "READBACK_VERIFIED" ||
      state === "READBACK_MISMATCH" || state === "PROVIDER_REJECTED") return state;
  return undefined;
}

function accountingCaseNoWriteEvidenceMatches(
  operation: AccountingCaseOperationRecord["operation"],
  xeroObjectId: string,
  readback: Record<string, unknown>,
): boolean {
  if (operation.actionId !== "contact.create_basic") {
    return xeroExistingDocumentNoWriteEvidenceMatches(operation, xeroObjectId, readback);
  }
  const expectedName = operation.canonicalPayload.name;
  const actualName = readback.name ?? readback.Name;
  const actualId = readback.contactId ?? readback.contactID ?? readback.ContactID ?? readback.id;
  const status = readback.status ?? readback.Status;
  return typeof expectedName === "string" &&
    typeof actualName === "string" && actualName === expectedName &&
    typeof actualId === "string" && actualId === xeroObjectId &&
    (status === undefined || status === "ACTIVE");
}

function preflightReceiptOperationMatches(
  receipt: Record<string, unknown>,
  operation: AccountingCaseOperationRecord,
  preflight: RecordAccountingCasePreflightInput["operations"][number],
): boolean {
  if (!Array.isArray(receipt.operations)) return false;
  const candidates = receipt.operations.filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    value.operationId === operation.operation.operationId);
  if (candidates.length !== 1) return false;
  const evidence = candidates[0]!;
  if (
    evidence.actionId !== operation.operation.actionId ||
    evidence.operationCanonicalPayloadHash !== operation.operation.canonicalPayloadHash ||
    evidence.state !== preflight.state
  ) return false;
  if (preflight.state === "PREPARED") {
    return evidence.operationCanonicalPayloadHash === preflight.operationCanonicalPayloadHash &&
      evidence.preparationId === preflight.preparationId &&
      evidence.preparationCanonicalPayloadHash === preflight.preparationCanonicalPayloadHash &&
      evidence.sourceSha256 === preflight.sourceSha256;
  }
  return evidence.xeroObjectId === preflight.xeroObjectId &&
    evidence.readbackHash === hashObject(preflight.readbackSnapshot);
}

function assertAccountingCasePreflightIntegrity(record: AccountingCaseVersionRecord): void {
  const hasAny = Boolean(
    record.preflightRequestId || record.preflightReceipt || record.preflightReceiptHash || record.preflightedAt,
  );
  const requiresEvidence = ["PREFLIGHTED", "READY_TO_RESUME", "EXECUTING", "RECOVERY_REQUIRED", "AWAITING_CONTINUATION", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state);
  if (hasAny || requiresEvidence) {
    if (
      !record.preflightRequestId ||
      !record.preflightReceipt ||
      !record.preflightReceiptHash ||
      !record.preflightedAt ||
      record.preflightReceiptHash !== accountingCasePreflightReceiptHash({
        binding: record.binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        compiledPlanHash: record.compiledPlanHash,
        requestId: record.preflightRequestId,
        preflightReceipt: record.preflightReceipt,
      })
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight integrity check failed.", {
        httpStatus: 503,
      });
    }
    if (
      record.originalPreflightReceiptHash !== record.preflightReceiptHash ||
      !record.effectivePreflightSealHash ||
      !record.effectivePreflightSealedAt ||
      !Number.isInteger(record.preflightResealRevision) ||
      (record.preflightResealRevision ?? -1) < 0
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal is incomplete.", {
        httpStatus: 503,
      });
    }
    const reseals = record.preflightReseals ?? [];
    if (reseals.length !== record.preflightResealRevision) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight reseal chain is incomplete.", {
        httpStatus: 503,
      });
    }
    let previousEffectiveSealHash = record.preflightReceiptHash;
    for (const [index, reseal] of reseals.entries()) {
      const revision = index + 1;
      if (
        reseal.revision !== revision ||
        reseal.previousEffectiveSealHash !== previousEffectiveSealHash ||
        reseal.receipt.revision !== revision ||
        reseal.receipt.previousEffectiveSealHash !== previousEffectiveSealHash ||
        reseal.receipt.originalPreflightReceiptHash !== record.preflightReceiptHash ||
        reseal.effectiveSealHash !== accountingCasePreflightResealReceiptHash({
          binding: record.binding,
          caseId: record.compiled.caseId,
          version: record.compiled.version,
          compiledPlanHash: record.compiledPlanHash,
          originalPreflightReceiptHash: record.preflightReceiptHash,
          previousEffectiveSealHash,
          revision,
          requestId: reseal.requestId,
          resealReceipt: reseal.receipt,
        })
      ) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight reseal chain integrity check failed.", {
          httpStatus: 503,
        });
      }
      previousEffectiveSealHash = reseal.effectiveSealHash;
    }
    if (record.effectivePreflightSealHash !== previousEffectiveSealHash) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal hash is stale.", {
        httpStatus: 503,
      });
    }
    const expectedEffectiveSealedAt = reseals.at(-1)?.resealedAt ?? record.preflightedAt;
    if (record.effectivePreflightSealedAt.getTime() !== expectedEffectiveSealedAt.getTime()) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal time is stale.", {
        httpStatus: 503,
      });
    }
    if (!Array.isArray(record.preflightReceipt.operations) ||
        record.preflightReceipt.operations.length !== record.operations.length ||
        record.operations.some((operation) => {
          const originalPreparationId = operation.originalPreparationId ?? operation.preparationId;
          const expected = originalPreparationId
            ? {
                operationId: operation.operation.operationId,
                state: "PREPARED" as const,
                preparationId: originalPreparationId,
                operationCanonicalPayloadHash: operation.operation.canonicalPayloadHash,
                preparationCanonicalPayloadHash: operation.preparationCanonicalPayloadHash!,
                sourceSha256: operation.sourceSha256!,
              }
            : operation.state === "NO_WRITE_REQUIRED" && operation.xeroObjectId && operation.readbackSnapshot
              ? {
                  operationId: operation.operation.operationId,
                  state: "NO_WRITE_REQUIRED" as const,
                  xeroObjectId: operation.xeroObjectId,
                  readbackSnapshot: operation.readbackSnapshot,
                }
              : undefined;
          return !expected || !preflightReceiptOperationMatches(record.preflightReceipt!, operation, expected);
        })) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight receipt operation linkage failed.", {
        httpStatus: 503,
      });
    }
  }
  if (
    record.state === "PREFLIGHTED" &&
    record.operations.some((operation) =>
      (operation.state === "PREPARED" &&
        (!operation.preparationId || !operation.preparationCanonicalPayloadHash || !operation.sourceSha256)) ||
      (operation.state !== "PREPARED" && operation.state !== "NO_WRITE_REQUIRED"))
  ) {
    throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight operation set is incomplete.", {
      httpStatus: 503,
    });
  }
  if (["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
    const expected = accountingCaseTerminalSummary(
      record,
      record.state as "RECOVERY_REQUIRED" | "PARTIALLY_COMMITTED" | "TERMINAL",
    );
    if (!record.terminalSummary || !sameJson(record.terminalSummary, expected)) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case terminal summary projection is invalid.", {
        httpStatus: 503,
      });
    }
  }
  if (
    record.state === "AWAITING_CONTINUATION" &&
    (
      record.terminalSummary !== undefined ||
      !hasAccountingCaseDependentContinuation(record.compiled) ||
      record.operations.length === 0 ||
      record.operations.some((operation) =>
        operation.state !== "READBACK_VERIFIED" && operation.state !== "NO_WRITE_REQUIRED")
    )
  ) {
    throw new AppError("PERSISTENCE_FAILURE", "Accounting Case continuation state is invalid.", { httpStatus: 503 });
  }
}

interface InMemoryAccountingCaseAggregate {
  binding: AccountingCaseBinding;
  currentVersion: number;
  versions: Map<number, AccountingCaseVersionRecord>;
}

export interface InMemoryAccountingRepositoryOptions {
  /** Repository-owned time, equivalent to PostgreSQL statement_timestamp(). */
  now?: () => Date;
}

const OAUTH_AUTHORIZATION_CODE_MAX_TTL_MS = 5 * 60 * 1_000;

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isHashedValue(value: string | undefined): value is string {
  return isNonEmpty(value) && value.length >= 32;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameMutationBinding(
  row: XeroMutationPreparation | XeroMutationRequest,
  input: BoundXeroMutationRequestInput | ConfirmXeroMutationPreparationInput,
): boolean {
  return row.actorId === input.actorId &&
    row.workspaceId === input.workspaceId &&
    row.tenantId === input.tenantId &&
    row.installationId === input.installationId &&
    row.bindingId === input.bindingId &&
    row.connectionId === input.connectionId &&
    row.bindingRevision === input.bindingRevision &&
    row.targetSessionId === input.targetSessionId &&
    row.objectType === input.objectType &&
    row.operation === input.operation &&
    row.targetXeroObjectId === input.targetXeroObjectId &&
    row.canonicalPayloadHash === input.canonicalPayloadHash &&
    row.sourceRef === input.sourceRef &&
    row.sourceUnitKey === input.sourceUnitKey &&
    row.sourceSha256 === input.sourceSha256 &&
    row.sourceEvidenceType === input.sourceEvidenceType;
}

function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sameResealPreparationIdentity(
  left: XeroMutationPreparation,
  right: XeroMutationPreparation,
): boolean {
  return left.actorId === right.actorId &&
    left.workspaceId === right.workspaceId &&
    left.tenantId === right.tenantId &&
    left.installationId === right.installationId &&
    left.bindingId === right.bindingId &&
    left.bindingRevision === right.bindingRevision &&
    left.connectionId === right.connectionId &&
    left.targetSessionId === right.targetSessionId &&
    left.objectType === right.objectType &&
    left.operation === right.operation &&
    left.targetXeroObjectId === right.targetXeroObjectId &&
    left.canonicalPayloadHash === right.canonicalPayloadHash &&
    sameJson(left.canonicalPayload, right.canonicalPayload) &&
    left.sourceRef === right.sourceRef &&
    left.sourceUnitKey === right.sourceUnitKey &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceEvidenceType === right.sourceEvidenceType;
}

function sameOptionalJson(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameJson(left, right);
}

const ACTIVE_XERO_MUTATION_SOURCE_STATES = new Set<XeroMutationRequest["state"]>([
  "CONFIRMED",
  "WRITE_IN_FLIGHT",
  "WRITE_UNCERTAIN",
  "READBACK_VERIFIED",
  "READBACK_MISMATCH",
]);

const ACCOUNTING_CASE_BUSINESS_RESERVATION_STATES = new Set<AccountingCaseOperationState>([
  "PREPARED",
  "WRITE_IN_FLIGHT",
  "READBACK_VERIFIED",
  "WRITE_UNCERTAIN",
  "READBACK_MISMATCH",
]);

const XERO_MUTATION_CREATE_OPERATIONS = new Set<XeroMutationRequest["operation"]>([
  "CREATE_DRAFT",
  "CREATE",
  "UPLOAD",
]);

const XERO_MUTATION_PROVENANCE_PAYLOAD_KEYS = new Set([
  "source_ref",
  "source_sha256",
  "source_evidence_type",
  "user_confirmation",
  "request_id",
  "sourceRef",
  "sourceSha256",
  "sourceEvidenceType",
  "userConfirmation",
  "requestId",
  "externalReference",
]);

function xeroMutationBusinessPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !XERO_MUTATION_PROVENANCE_PAYLOAD_KEYS.has(key)));
}

function normalizedNestedBusinessValue(
  payload: Record<string, unknown>,
  container: string,
  field: string,
): string | undefined {
  const nested = payload[container];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  const value = (nested as Record<string, unknown>)[field];
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return normalized || undefined;
}

function isOptionalNonEmpty(value: string | undefined): boolean {
  return value === undefined || isNonEmpty(value);
}

function hasUniqueNonEmptyStrings(values: string[]): boolean {
  return values.length > 0 && values.every(isNonEmpty) && new Set(values).size === values.length;
}

function validateInitialBrokerFlow(input: CreateBrokerAuthorizationFlowInput): void {
  const { installation, flow } = input;
  if (
    !isNonEmpty(installation.installationId) ||
    !isNonEmpty(installation.workspaceId) ||
    !["USER", "TEAM"].includes(installation.subjectType) ||
    !isNonEmpty(installation.subjectId) ||
    !isNonEmpty(installation.agentId) ||
    !isNonEmpty(installation.clientId) ||
    installation.status !== "PENDING" ||
    installation.revokedAt ||
    !isValidDate(installation.createdAt) ||
    !isValidDate(installation.updatedAt) ||
    installation.updatedAt < installation.createdAt ||
    flow.status !== "AUTHORIZING_XERO" ||
    typeof flow.personalPoc !== "boolean" ||
    flow.authorizationId ||
    flow.selectionCsrfHash ||
    flow.consumedAt ||
    !isNonEmpty(flow.outerStateCiphertext) ||
    !isHashedValue(flow.flowHash) ||
    !isHashedValue(flow.browserSessionHash) ||
    !isHashedValue(flow.xeroStateHash) ||
    !isHashedValue(flow.outerStateHash) ||
    !isNonEmpty(flow.clientId) ||
    !isNonEmpty(flow.redirectUri) ||
    !isHashedValue(flow.pkceCodeChallenge) ||
    flow.pkceCodeChallengeMethod !== "S256" ||
    !isNonEmpty(flow.resource) ||
    !isNonEmpty(flow.audience) ||
    !hasUniqueNonEmptyStrings(flow.requestedScopes) ||
    !isValidDate(flow.createdAt) ||
    !isValidDate(flow.updatedAt) ||
    !isValidDate(flow.expiresAt) ||
    flow.expiresAt <= flow.createdAt ||
    flow.updatedAt.getTime() !== flow.createdAt.getTime() ||
    flow.installationId !== installation.installationId ||
    flow.workspaceId !== installation.workspaceId ||
    flow.subjectType !== installation.subjectType ||
    flow.subjectId !== installation.subjectId ||
    flow.agentId !== installation.agentId ||
    flow.clientId !== installation.clientId
  ) {
    throw new AppError("VALIDATION_FAILED", "OAuth Broker flow and pending installation are invalid.");
  }
}

function emptyEphemeralCleanupCounts(): EphemeralCleanupCounts {
  return {
    mcpRefreshRetryResponses: 0,
    organisationSwitchSessions: 0,
    ledgerTargetSessions: 0,
    oauthBrokerFlows: 0,
    oauthStates: 0,
    connectTickets: 0,
    operatorSessions: 0,
    reviewCsrfTokens: 0,
  };
}

function assertCleanupArguments(cutoff: Date, batchSize: number): void {
  if (!Number.isFinite(cutoff.getTime())) {
    throw new AppError("VALIDATION_FAILED", "Ephemeral cleanup cutoff must be a valid date.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new AppError("VALIDATION_FAILED", "Ephemeral cleanup batch size must be between 1 and 10000.");
  }
}

export class InMemoryAccountingRepository implements AccountingRepository {
  readonly #repositoryNow: () => Date;
  readonly #ledgerAuthoritySnapshots = new Map<string, LedgerAuthoritySnapshot>();
  readonly #legacyLedgerAuthoritySnapshots = new Map<string, {
    material: Omit<PublishLedgerAuthoritySnapshotInput, "publishedAt">;
    snapshotHash: string;
  }>();
  readonly #providerAuthorizations = new Map<string, ProviderAuthorization>();
  readonly #authorizedConnections = new Map<string, AuthorizedProviderConnection>();
  readonly #oauthInstallations = new Map<string, OAuthInstallation>();
  readonly #agentConnectionBindings = new Map<string, AgentConnectionBinding>();
  readonly #activeBindingIds = new Map<string, string>();
  readonly #activeBindingRevisions = new Map<string, number>();
  readonly #organisationSwitchSessions = new Map<string, OrganisationSwitchSession>();
  readonly #ledgerTargetSessions = new Map<string, LedgerTargetSession>();
  readonly #oauthBrokerFlows = new Map<string, OAuthBrokerFlow>();
  readonly #oauthBrokerAuthorizationFlows = new Map<string, OAuthBrokerAuthorizationFlow>();
  readonly #oauthAuthorizationCodes = new Map<string, OAuthAuthorizationCode>();
  readonly #mcpAccessTokens = new Map<string, McpAccessToken>();
  readonly #mcpRefreshTokenFamilies = new Map<string, McpRefreshTokenFamily>();
  readonly #mcpRefreshTokens = new Map<string, McpRefreshToken>();
  readonly #oauthStates = new Map<
    string,
    { actorId: string; browserSessionHash: string; expiresAt: Date; consumedAt?: Date }
  >();
  readonly #connections = new Map<string, ProviderConnection>();
  readonly #connectTickets = new Map<string, { actorId: string; expiresAt: Date; consumedAt?: Date }>();
  readonly #operatorSessions = new Map<string, { actorId: string; expiresAt: Date }>();
  readonly #reviewCsrf = new Map<
    string,
    {
      sessionHash: string;
      actorId: string;
      postingRequestId: string;
      expiresAt: Date;
      consumedAt?: Date;
    }
  >();
  readonly #postings = new Map<string, PostingRequest>();
  readonly #createKeys = new Map<string, string>();
  readonly #xeroMutationPreparations = new Map<string, XeroMutationPreparation>();
  readonly #xeroMutationRequests = new Map<string, XeroMutationRequest>();
  readonly #xeroMutationRequestKeys = new Map<string, string>();
  readonly #accountingCases = new Map<string, InMemoryAccountingCaseAggregate>();
  readonly #accountingCaseRecoveryResidualGrants = new Map<string, AccountingCaseRecoveryResidualGrant>();
  readonly audits: AuditLog[] = [];
  readonly governanceAuditEvents: GovernanceAuditEvent[] = [];

  constructor(options: InMemoryAccountingRepositoryOptions = {}) {
    this.#repositoryNow = options.now ?? (() => new Date());
  }

  #statementTimestamp(): Date {
    const value = this.#repositoryNow();
    if (!isValidDate(value)) {
      throw new AppError("PERSISTENCE_FAILURE", "The repository clock returned an invalid timestamp.", {
        httpStatus: 503,
      });
    }
    return new Date(value.getTime());
  }

  async readiness(): Promise<boolean> {
    try {
      return this.#activeRecoveryProjectionEvidence().status === "COMPATIBLE";
    } catch {
      return false;
    }
  }

  async readinessEvidence(requiredMigration: string): Promise<RepositoryReadinessEvidence> {
    let activeAccountingCaseRecoveryProjection;
    try {
      activeAccountingCaseRecoveryProjection = this.#activeRecoveryProjectionEvidence();
    } catch {
      activeAccountingCaseRecoveryProjection = unknownActiveAccountingCaseRecoveryProjectionEvidence();
    }
    const snapshot = this.#ledgerAuthoritySnapshots.get("xero");
    const firmGovernance = ledgerFirmGovernanceReadinessEvidence(snapshot, this.#statementTimestamp());
    return {
      ready: activeAccountingCaseRecoveryProjection.status === "COMPATIBLE",
      storageMode: "IN_MEMORY",
      requiredMigration,
      requiredMigrationStatus: "NOT_APPLICABLE",
      migrationHead: null,
      activeAccountingCaseRecoveryProjection,
      authoritySnapshotRevision: snapshot?.revision ?? null,
      authoritySnapshotHash: snapshot?.snapshotHash ?? null,
      authorityWriteKillSwitchEnabled: snapshot?.writeKillSwitchEnabled ?? null,
      firmGovernance,
    };
  }

  #activeRecoveryProjectionEvidence() {
    const currentVersions = [...this.#accountingCases.values()].map((aggregate) => {
      const current = aggregate.versions.get(aggregate.currentVersion);
      if (!current) throw new Error("IN_MEMORY_ACCOUNTING_CASE_HEAD_INCOMPLETE");
      return current;
    });
    return evaluateActiveAccountingCaseRecoveryProjections(currentVersions);
  }

  async publishLedgerAuthoritySnapshot(
    input: PublishLedgerAuthoritySnapshotInput,
  ): Promise<PublishLedgerAuthoritySnapshotResult> {
    const candidate = createLedgerAuthoritySnapshot(input);
    const legacy = this.#legacyLedgerAuthoritySnapshots.get(candidate.providerId);
    if (legacy && legacy.snapshotHash !== legacyLedgerAuthoritySnapshotV1Hash(legacy.material)) {
      throw new AppError("PERSISTENCE_FAILURE", "Legacy ledger authority snapshot hash verification failed.", {
        httpStatus: 503,
      });
    }
    if (legacy && candidate.revision <= legacy.material.revision) {
      throw new AppError("CONFLICT", "Legacy authority v1 requires a strictly higher v2 revision.", {
        httpStatus: 409,
      });
    }
    const current = this.#ledgerAuthoritySnapshots.get(candidate.providerId);
    if (current) {
      if (candidate.revision < current.revision) {
        throw new AppError("CONFLICT", "Ledger authority snapshot revision cannot decrease.", { httpStatus: 409 });
      }
      if (candidate.revision === current.revision) {
        if (candidate.snapshotHash !== current.snapshotHash) {
          throw new AppError(
            "CONFLICT",
            "Ledger authority snapshot revision cannot identify different content.",
            { httpStatus: 409 },
          );
        }
        return { snapshot: clone(current), mode: "IDEMPOTENT_REPLAY" };
      }
    }
    this.#ledgerAuthoritySnapshots.set(candidate.providerId, clone(candidate));
    if (legacy) this.#legacyLedgerAuthoritySnapshots.delete(candidate.providerId);
    return { snapshot: clone(candidate), mode: current || legacy ? "ADVANCED" : "CREATED" };
  }

  async getLedgerAuthoritySnapshot(providerId: string): Promise<LedgerAuthoritySnapshot | undefined> {
    if (this.#legacyLedgerAuthoritySnapshots.has(providerId)) {
      throw new AppError("STALE_PREFLIGHT", "Legacy ledger authority snapshot v1 is unsupported for authorization.", {
        httpStatus: 409,
        retryable: false,
      });
    }
    const snapshot = this.#ledgerAuthoritySnapshots.get(providerId);
    return snapshot ? clone(snapshot) : undefined;
  }

  /** Test-only seed for exercising the no-migration v1 to v2 advance path. */
  seedLegacyLedgerAuthoritySnapshotForTest(
    material: Omit<PublishLedgerAuthoritySnapshotInput, "publishedAt">,
    snapshotHash = legacyLedgerAuthoritySnapshotV1Hash(material),
  ): void {
    if (process.env.NODE_ENV !== "test") throw new Error("Legacy authority seeding is test-only.");
    this.#legacyLedgerAuthoritySnapshots.set(material.providerId, {
      material: clone(material),
      snapshotHash,
    });
  }

  async ledgerAuthorityReadiness(providerId: string): Promise<LedgerAuthorityRepositoryReadiness> {
    const snapshot = this.#ledgerAuthoritySnapshots.get(providerId);
    const repositoryObservedAt = this.#statementTimestamp();
    return {
      ...(snapshot ? { snapshot: clone(snapshot) } : {}),
      firmGovernance: ledgerFirmGovernanceReadinessEvidence(snapshot, repositoryObservedAt),
    };
  }

  async saveProviderAuthorization(authorization: ProviderAuthorization): Promise<ProviderAuthorization> {
    if (this.#providerAuthorizations.has(authorization.authorizationId)) {
      throw new AppError("CONFLICT", "Provider authorization identifier already exists.", { httpStatus: 409 });
    }
    this.#providerAuthorizations.set(authorization.authorizationId, clone(authorization));
    return clone(authorization);
  }

  async getProviderAuthorization(
    authorizationId: string,
    workspaceId: string,
    authorizedBySubject: string,
  ): Promise<ProviderAuthorization | undefined> {
    const authorization = this.#providerAuthorizations.get(authorizationId);
    if (
      !authorization ||
      authorization.workspaceId !== workspaceId ||
      authorization.authorizedBySubject !== authorizedBySubject
    ) {
      return undefined;
    }
    return clone(authorization);
  }

  async updateProviderAuthorizationToken(
    authorizationId: string,
    workspaceId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
    grantedScopes: string[],
  ): Promise<ProviderAuthorization | undefined> {
    const authorization = this.#providerAuthorizations.get(authorizationId);
    if (
      !authorization ||
      authorization.workspaceId !== workspaceId ||
      authorization.refreshVersion !== expectedRefreshVersion ||
      authorization.status === "REVOKED"
    ) {
      return undefined;
    }
    const updated: ProviderAuthorization = {
      ...authorization,
      tokenCiphertext,
      tokenExpiresAt,
      grantedScopes: [...grantedScopes],
      refreshVersion: authorization.refreshVersion + 1,
      status: "ACTIVE",
      updatedAt: new Date(),
    };
    delete updated.revokedAt;
    this.#providerAuthorizations.set(authorizationId, updated);
    return clone(updated);
  }

  async markProviderAuthorizationStatus(
    authorizationId: string,
    workspaceId: string,
    status: ProviderAuthorization["status"],
    changedAt: Date,
  ): Promise<boolean> {
    const authorization = this.#providerAuthorizations.get(authorizationId);
    if (!authorization || authorization.workspaceId !== workspaceId || authorization.status === "REVOKED") {
      return false;
    }
    const updated: ProviderAuthorization = { ...authorization, status, updatedAt: changedAt };
    if (status === "REVOKED") updated.revokedAt = changedAt;
    this.#providerAuthorizations.set(authorizationId, updated);
    return true;
  }

  async upsertAuthorizedProviderConnection(
    workspaceId: string,
    connection: AuthorizedProviderConnection,
  ): Promise<AuthorizedProviderConnection> {
    const authorization = this.#providerAuthorizations.get(connection.authorizationId);
    if (!authorization || authorization.workspaceId !== workspaceId || authorization.status === "REVOKED") {
      throw new AppError("FORBIDDEN", "Provider authorization does not belong to this active workspace.", {
        httpStatus: 403,
      });
    }
    const identityConflict = [...this.#authorizedConnections.values()].find(
      (candidate) =>
        candidate.authorizationId === connection.authorizationId &&
        candidate.tenantId === connection.tenantId &&
        candidate.connectionId !== connection.connectionId,
    );
    if (identityConflict) {
      if (identityConflict.status === "REVOKED" && connection.status !== "REVOKED") {
        throw new AppError("CONFLICT", "A revoked provider connection cannot be reactivated.", {
          httpStatus: 409,
        });
      }
      const updated: AuthorizedProviderConnection = {
        ...connection,
        connectionId: identityConflict.connectionId,
        createdAt: identityConflict.createdAt,
      };
      this.#authorizedConnections.set(updated.connectionId, clone(updated));
      return clone(updated);
    }
    const existing = this.#authorizedConnections.get(connection.connectionId);
    if (existing && existing.authorizationId !== connection.authorizationId) {
      throw new AppError("CONFLICT", "Provider connection identifier belongs to another authorization.", {
        httpStatus: 409,
      });
    }
    if (existing?.status === "REVOKED" && connection.status !== "REVOKED") {
      throw new AppError("CONFLICT", "A revoked provider connection cannot be reactivated.", {
        httpStatus: 409,
      });
    }
    const saved = existing ? { ...connection, createdAt: existing.createdAt } : connection;
    this.#authorizedConnections.set(saved.connectionId, clone(saved));
    return clone(saved);
  }

  async listActiveConnectionsByAuthorization(
    authorizationId: string,
    workspaceId: string,
  ): Promise<AuthorizedProviderConnection[]> {
    const authorization = this.#providerAuthorizations.get(authorizationId);
    if (!authorization || authorization.workspaceId !== workspaceId || authorization.status !== "ACTIVE") return [];
    return [...this.#authorizedConnections.values()]
      .filter((connection) => connection.authorizationId === authorizationId && connection.status === "ACTIVE")
      .map(clone);
  }

  async saveOAuthInstallation(installation: OAuthInstallation): Promise<OAuthInstallation> {
    const existing = this.#oauthInstallations.get(installation.installationId);
    if (existing && (
      existing.status === "REVOKED" ||
      existing.workspaceId !== installation.workspaceId ||
      existing.subjectType !== installation.subjectType ||
      existing.subjectId !== installation.subjectId ||
      existing.agentId !== installation.agentId ||
      existing.clientId !== installation.clientId
    )) {
      throw new AppError("CONFLICT", "OAuth installation identity cannot be changed or reactivated.", {
        httpStatus: 409,
      });
    }
    const saved = existing ? { ...installation, createdAt: existing.createdAt } : installation;
    this.#oauthInstallations.set(saved.installationId, clone(saved));
    return clone(saved);
  }

  async saveAgentConnectionBinding(binding: AgentConnectionBinding): Promise<AgentConnectionBinding> {
    const installation = this.#oauthInstallations.get(binding.installationId);
    const connection = this.#authorizedConnections.get(binding.connectionId);
    const authorization = connection
      ? this.#providerAuthorizations.get(connection.authorizationId)
      : undefined;
    if (
      !installation ||
      installation.status !== "ACTIVE" ||
      installation.workspaceId !== binding.workspaceId ||
      installation.subjectType !== binding.subjectType ||
      installation.subjectId !== binding.subjectId ||
      installation.agentId !== binding.agentId ||
      !connection ||
      connection.status !== "ACTIVE" ||
      !authorization ||
      authorization.status !== "ACTIVE" ||
      authorization.workspaceId !== binding.workspaceId
    ) {
      throw new AppError("FORBIDDEN", "Binding identity, installation, and provider connection do not align.", {
        httpStatus: 403,
      });
    }
    const existing = this.#agentConnectionBindings.get(binding.bindingId);
    if (existing && (
      existing.status === "REVOKED" ||
      existing.installationId !== binding.installationId ||
      existing.workspaceId !== binding.workspaceId ||
      existing.subjectType !== binding.subjectType ||
      existing.subjectId !== binding.subjectId ||
      existing.agentId !== binding.agentId ||
      existing.connectionId !== binding.connectionId
    )) {
      throw new AppError("CONFLICT", "Agent connection binding identity cannot be changed or reactivated.", {
        httpStatus: 409,
      });
    }
    const saved = existing ? { ...binding, createdAt: existing.createdAt } : binding;
    this.#agentConnectionBindings.set(saved.bindingId, clone(saved));
    if (!this.#activeBindingIds.has(saved.installationId)) {
      this.#activeBindingIds.set(saved.installationId, saved.bindingId);
      this.#activeBindingRevisions.set(saved.installationId, 1);
    }
    return clone(saved);
  }

  async resolveAgentConnectionBinding(
    input: ResolveAgentConnectionBindingInput,
  ): Promise<ResolvedAgentConnectionBinding | undefined> {
    if (this.#currentBindingId(input.installationId) !== input.bindingId) return undefined;
    return this.#resolveActiveBinding(input);
  }

  async saveOrganisationSwitchSession(session: OrganisationSwitchSession): Promise<void> {
    if (
      !isHashedValue(session.sessionHash) ||
      !isValidDate(session.createdAt) ||
      !isValidDate(session.expiresAt) ||
      session.expiresAt <= session.createdAt ||
      session.expiresAt.getTime() - session.createdAt.getTime() > 15 * 60_000 ||
      session.consumedAt ||
      this.#organisationSwitchSessions.has(session.sessionHash)
    ) {
      throw new AppError("VALIDATION_FAILED", "Organisation switch session is invalid.");
    }
    const source = this.#resolveActiveBinding({
      installationId: session.installationId,
      bindingId: session.sourceBindingId,
      workspaceId: session.workspaceId,
      subjectType: session.subjectType,
      subjectId: session.subjectId,
      agentId: session.agentId,
      connectionId: session.sourceConnectionId,
    });
    if (
      !source ||
      source.authorizationId !== session.authorizationId ||
      (!session.sourceTargetSessionHash && this.#currentBindingId(session.installationId) !== session.sourceBindingId)
    ) {
      throw new AppError("FORBIDDEN", "Organisation switch source binding is no longer current.", {
        httpStatus: 403,
      });
    }
    if (session.sourceTargetSessionHash) {
      const sourceTarget = this.#ledgerTargetSessions.get(session.sourceTargetSessionHash);
      if (
        !sourceTarget ||
        sourceTarget.installationId !== session.installationId ||
        sourceTarget.bindingId !== session.sourceBindingId ||
        sourceTarget.connectionId !== session.sourceConnectionId ||
        sourceTarget.revokedAt ||
        sourceTarget.expiresAt <= session.createdAt
      ) {
        throw new AppError("FORBIDDEN", "Organisation switch target is no longer active.", {
          httpStatus: 403,
        });
      }
    }
    this.#organisationSwitchSessions.set(session.sessionHash, clone(session));
  }

  async getOrganisationSwitchContext(
    sessionHash: string,
    now: Date,
  ): Promise<OrganisationSwitchContext | undefined> {
    if (!isValidDate(now)) return undefined;
    const session = this.#organisationSwitchSessions.get(sessionHash);
    if (!session || session.consumedAt || session.expiresAt <= now) return undefined;
    if (!session.sourceTargetSessionHash && this.#currentBindingId(session.installationId) !== session.sourceBindingId) {
      return undefined;
    }
    const sourceBinding = this.#resolveActiveBindingByTuple(
      session.installationId,
      session.sourceBindingId,
      session.sourceConnectionId,
    );
    if (!sourceBinding || sourceBinding.authorizationId !== session.authorizationId) return undefined;
    const sourceTarget = session.sourceTargetSessionHash
      ? this.#ledgerTargetSessions.get(session.sourceTargetSessionHash)
      : undefined;
    if (session.sourceTargetSessionHash && (
      !sourceTarget ||
      sourceTarget.installationId !== session.installationId ||
      sourceTarget.bindingId !== session.sourceBindingId ||
      sourceTarget.connectionId !== session.sourceConnectionId ||
      sourceTarget.revokedAt ||
      sourceTarget.expiresAt <= now
    )) return undefined;
    const currentBinding = sourceTarget
      ? { ...sourceBinding, bindingRevision: sourceTarget.bindingRevision }
      : sourceBinding;
    const connections = await this.listActiveConnectionsByAuthorization(
      session.authorizationId,
      session.workspaceId,
    );
    if (connections.length === 0) return undefined;
    return {
      session: clone(session),
      currentBinding,
      connections,
    };
  }

  async completeOrganisationSwitch(
    input: CompleteOrganisationSwitchInput,
  ): Promise<CompleteOrganisationSwitchResult | undefined> {
    if (!isValidDate(input.now) || !isNonEmpty(input.newBindingId)) return undefined;
    const context = await this.getOrganisationSwitchContext(input.sessionHash, input.now);
    if (!context) return undefined;
    const sourceTarget = context.session.sourceTargetSessionHash
      ? this.#ledgerTargetSessions.get(context.session.sourceTargetSessionHash)
      : undefined;
    if (context.session.sourceTargetSessionHash && (
      !sourceTarget ||
      sourceTarget.installationId !== context.session.installationId ||
      sourceTarget.revokedAt ||
      sourceTarget.expiresAt <= input.now
    )) return undefined;
    const targetConnection = context.connections.find(
      (connection) => connection.connectionId === input.selectedConnectionId,
    );
    if (!targetConnection) return undefined;

    let targetBinding = [...this.#agentConnectionBindings.values()].find((binding) =>
      binding.installationId === context.session.installationId &&
      binding.connectionId === targetConnection.connectionId &&
      binding.status === "ACTIVE"
    );
    if (!targetBinding) {
      if (this.#agentConnectionBindings.has(input.newBindingId)) return undefined;
      targetBinding = {
        bindingId: input.newBindingId,
        installationId: context.session.installationId,
        workspaceId: context.session.workspaceId,
        subjectType: context.session.subjectType,
        subjectId: context.session.subjectId,
        agentId: context.session.agentId,
        connectionId: targetConnection.connectionId,
        policyId: context.currentBinding.policyId,
        status: "ACTIVE",
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.#agentConnectionBindings.set(targetBinding.bindingId, clone(targetBinding));
    }
    const nextBindingRevision = this.#currentBindingRevision(context.session.installationId) + 1;
    this.#activeBindingIds.set(context.session.installationId, targetBinding.bindingId);
    this.#activeBindingRevisions.set(context.session.installationId, nextBindingRevision);
    const consumed: OrganisationSwitchSession = {
      ...context.session,
      consumedAt: input.now,
    };
    let sourceTargetRevoked = false;
    if (context.session.sourceTargetSessionHash) {
      this.#ledgerTargetSessions.set(context.session.sourceTargetSessionHash, {
        ...sourceTarget!,
        revokedAt: new Date(input.now),
      });
      sourceTargetRevoked = true;
    }
    this.#organisationSwitchSessions.set(consumed.sessionHash, consumed);
    const currentBinding = this.#resolveActiveBindingByTuple(
      targetBinding.installationId,
      targetBinding.bindingId,
      targetBinding.connectionId,
    );
    if (!currentBinding) throw new Error("Completed organisation switch did not resolve its target binding.");
    return {
      session: clone(consumed),
      previousBinding: clone(context.currentBinding),
      currentBinding,
      changed: currentBinding.connectionId !== context.currentBinding.connectionId,
      sourceTargetRevoked,
    };
  }

  async saveLedgerTargetSession(session: LedgerTargetSession): Promise<void> {
    if (
      !/^[0-9a-f]{64}$/u.test(session.sessionHash) ||
      !isNonEmpty(session.sessionId) ||
      !isValidDate(session.createdAt) ||
      !isValidDate(session.expiresAt) ||
      session.expiresAt <= session.createdAt ||
      session.expiresAt.getTime() - session.createdAt.getTime() > 4 * 60 * 60_000 ||
      !Number.isSafeInteger(session.bindingRevision) ||
      session.bindingRevision < 1 ||
      session.lastUsedAt ||
      session.revokedAt ||
      this.#ledgerTargetSessions.has(session.sessionHash) ||
      [...this.#ledgerTargetSessions.values()].some((candidate) => candidate.sessionId === session.sessionId)
    ) {
      throw new AppError("VALIDATION_FAILED", "Ledger target session is invalid.");
    }
    const binding = this.#resolveActiveBindingByTuple(
      session.installationId,
      session.bindingId,
      session.connectionId,
    );
    if (!binding || binding.bindingRevision !== session.bindingRevision) {
      throw new AppError("FORBIDDEN", "Ledger target session does not match the current installation binding.", {
        httpStatus: 403,
      });
    }
    this.#ledgerTargetSessions.set(session.sessionHash, clone(session));
  }

  async resolveLedgerTargetSession(
    input: ResolveLedgerTargetSessionInput,
  ): Promise<ResolvedLedgerTargetSession | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const session = this.#ledgerTargetSessions.get(input.sessionHash);
    if (
      !session ||
      session.installationId !== input.installationId ||
      session.revokedAt ||
      session.expiresAt <= input.now
    ) {
      return undefined;
    }
    const binding = this.#resolveActiveBindingByTuple(
      session.installationId,
      session.bindingId,
      session.connectionId,
    );
    if (
      !binding ||
      binding.workspaceId !== input.workspaceId ||
      binding.subjectType !== input.subjectType ||
      binding.subjectId !== input.subjectId ||
      binding.agentId !== input.agentId
    ) {
      return undefined;
    }
    const updated = { ...session, lastUsedAt: input.now };
    this.#ledgerTargetSessions.set(session.sessionHash, updated);
    return {
      session: clone(updated),
      binding: { ...clone(binding), bindingRevision: session.bindingRevision },
    };
  }

  async revokeLedgerTargetSession(
    sessionHash: string,
    installationId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    if (!isHashedValue(sessionHash) || !isNonEmpty(installationId) || !isValidDate(revokedAt)) return false;
    const session = this.#ledgerTargetSessions.get(sessionHash);
    if (!session || session.installationId !== installationId || session.revokedAt || session.expiresAt <= revokedAt) {
      return false;
    }
    this.#ledgerTargetSessions.set(sessionHash, { ...session, revokedAt: new Date(revokedAt) });
    return true;
  }

  async revokeOAuthInstallation(installationId: string, workspaceId: string, revokedAt: Date): Promise<boolean> {
    const installation = this.#oauthInstallations.get(installationId);
    if (!installation || installation.workspaceId !== workspaceId) return false;
    if (installation.status !== "REVOKED") {
      this.#oauthInstallations.set(installationId, {
        ...installation,
        status: "REVOKED",
        revokedAt,
        updatedAt: revokedAt,
      });
    }
    for (const [bindingId, binding] of this.#agentConnectionBindings) {
      if (binding.installationId === installationId && binding.status !== "REVOKED") {
        this.#agentConnectionBindings.set(bindingId, {
          ...binding,
          status: "REVOKED",
          revokedAt,
          updatedAt: revokedAt,
        });
      }
    }
    for (const [tokenHash, token] of this.#mcpAccessTokens) {
      if (token.installationId === installationId && !token.revokedAt) {
        this.#mcpAccessTokens.set(tokenHash, { ...token, revokedAt });
      }
    }
    for (const [familyId, family] of this.#mcpRefreshTokenFamilies) {
      if (family.installationId === installationId && family.status !== "REVOKED") {
        this.#revokeRefreshFamily(familyId, revokedAt);
      }
    }
    return true;
  }

  async saveOAuthBrokerFlow(flow: OAuthBrokerFlow): Promise<void> {
    if (flow.pkceCodeChallengeMethod !== "S256" || flow.expiresAt <= flow.createdAt) {
      throw new AppError("VALIDATION_FAILED", "OAuth broker flow lifetime or PKCE method is invalid.");
    }
    if (this.#oauthBrokerFlows.has(flow.flowHash) || this.#oauthBrokerAuthorizationFlows.has(flow.flowHash)) {
      throw new AppError("CONFLICT", "OAuth broker flow identifier already exists.", { httpStatus: 409 });
    }
    this.#oauthBrokerFlows.set(flow.flowHash, clone(flow));
  }

  async consumeOAuthBrokerFlow(input: ConsumeOAuthBrokerFlowInput): Promise<OAuthBrokerFlow | undefined> {
    const flow = this.#oauthBrokerFlows.get(input.flowHash);
    if (
      !flow ||
      flow.browserSessionHash !== input.browserSessionHash ||
      flow.clientId !== input.clientId ||
      flow.redirectUri !== input.redirectUri ||
      flow.consumedAt ||
      flow.expiresAt <= input.now
    ) {
      return undefined;
    }
    const consumed = { ...flow, consumedAt: input.now };
    this.#oauthBrokerFlows.set(input.flowHash, consumed);
    return clone(consumed);
  }

  async createBrokerAuthorizationFlow(
    input: CreateBrokerAuthorizationFlowInput,
  ): Promise<CreateBrokerAuthorizationFlowResult> {
    validateInitialBrokerFlow(input);
    const { installation, flow } = input;
    if (
      this.#oauthInstallations.has(installation.installationId) ||
      this.#oauthBrokerFlows.has(flow.flowHash) ||
      this.#oauthBrokerAuthorizationFlows.has(flow.flowHash) ||
      [...this.#oauthBrokerAuthorizationFlows.values()].some((candidate) =>
        candidate.installationId === flow.installationId ||
        candidate.xeroStateHash === flow.xeroStateHash ||
        candidate.outerStateHash === flow.outerStateHash
      )
    ) {
      throw new AppError("CONFLICT", "OAuth Broker flow or installation identifier already exists.", {
        httpStatus: 409,
      });
    }
    this.#oauthInstallations.set(installation.installationId, clone(installation));
    this.#oauthBrokerAuthorizationFlows.set(flow.flowHash, clone(flow));
    return { installation: clone(installation), flow: clone(flow) };
  }

  async beginBrokerXeroCallback(
    input: BeginBrokerXeroCallbackInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined> {
    const flow = this.#oauthBrokerAuthorizationFlows.get(input.flowHash);
    if (
      !flow ||
      flow.status !== "AUTHORIZING_XERO" ||
      flow.browserSessionHash !== input.browserSessionHash ||
      flow.xeroStateHash !== input.xeroStateHash ||
      !isValidDate(input.now) ||
      flow.consumedAt ||
      flow.expiresAt <= input.now
    ) return undefined;
    const exchanging: OAuthBrokerAuthorizationFlow = {
      ...flow,
      status: "EXCHANGING_XERO",
      updatedAt: input.now,
    };
    this.#oauthBrokerAuthorizationFlows.set(flow.flowHash, exchanging);
    return clone(exchanging);
  }

  async completeBrokerXeroExchange(
    input: CompleteBrokerXeroExchangeInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined> {
    if (!isValidDate(input.now)) {
      throw new AppError("VALIDATION_FAILED", "Xero authorization exchange time is invalid.");
    }
    const flow = this.#oauthBrokerAuthorizationFlows.get(input.flowHash);
    if (
      !flow ||
      flow.status !== "EXCHANGING_XERO" ||
      flow.browserSessionHash !== input.browserSessionHash ||
      flow.consumedAt ||
      flow.expiresAt <= input.now
    ) return undefined;

    const { authorization, connections } = input;
    const connectionIds = new Set(connections.map((connection) => connection.connectionId));
    const tenantIds = new Set(connections.map((connection) => connection.tenantId));
    const providerConnectionIds = new Set(connections.map((connection) => connection.providerConnectionId));
    if (
      !isHashedValue(input.selectionCsrfHash) ||
      !isNonEmpty(authorization.authorizationId) ||
      !isNonEmpty(authorization.workspaceId) ||
      !isNonEmpty(authorization.authorizedBySubject) ||
      authorization.provider !== "xero" ||
      !isOptionalNonEmpty(authorization.providerSubject) ||
      !hasUniqueNonEmptyStrings(authorization.grantedScopes) ||
      !isNonEmpty(authorization.tokenCiphertext) ||
      !isValidDate(authorization.tokenExpiresAt) ||
      authorization.tokenExpiresAt <= input.now ||
      !Number.isInteger(authorization.refreshVersion) ||
      authorization.refreshVersion < 0 ||
      authorization.status !== "ACTIVE" ||
      authorization.revokedAt ||
      !isValidDate(authorization.createdAt) ||
      !isValidDate(authorization.updatedAt) ||
      authorization.updatedAt < authorization.createdAt ||
      authorization.workspaceId !== flow.workspaceId ||
      authorization.authorizedBySubject !== flow.subjectId ||
      connections.length < 1 ||
      connectionIds.size !== connections.length ||
      tenantIds.size !== connections.length ||
      providerConnectionIds.size !== connections.length ||
      connections.some((connection) =>
        connection.provider !== "xero" ||
        connection.authorizationId !== authorization.authorizationId ||
        connection.status !== "ACTIVE" ||
        !isNonEmpty(connection.connectionId) ||
        !isNonEmpty(connection.tenantId) ||
        !isNonEmpty(connection.tenantName) ||
        !isNonEmpty(connection.providerConnectionId) ||
        !isOptionalNonEmpty(connection.tenantShortCode) ||
        (connection.lastVerifiedAt !== undefined && !isValidDate(connection.lastVerifiedAt)) ||
        !isValidDate(connection.createdAt) ||
        !isValidDate(connection.updatedAt) ||
        connection.updatedAt < connection.createdAt
      )
    ) {
      throw new AppError("VALIDATION_FAILED", "Xero authorization exchange output is invalid.");
    }
    if (
      this.#providerAuthorizations.has(authorization.authorizationId) ||
      [...this.#authorizedConnections.values()].some((existing) =>
        connectionIds.has(existing.connectionId) ||
        (existing.authorizationId === authorization.authorizationId && tenantIds.has(existing.tenantId))
      ) ||
      [...this.#oauthBrokerAuthorizationFlows.values()].some((candidate) =>
        candidate.flowHash !== flow.flowHash &&
        (candidate.authorizationId === authorization.authorizationId ||
          candidate.selectionCsrfHash === input.selectionCsrfHash)
      )
    ) {
      throw new AppError("CONFLICT", "Xero authorization exchange identifiers already exist.", {
        httpStatus: 409,
      });
    }

    const awaiting: OAuthBrokerAuthorizationFlow = {
      ...flow,
      authorizationId: authorization.authorizationId,
      selectionCsrfHash: input.selectionCsrfHash,
      status: "AWAITING_SELECTION",
      updatedAt: input.now,
    };
    this.#providerAuthorizations.set(authorization.authorizationId, clone(authorization));
    for (const connection of connections) {
      this.#authorizedConnections.set(connection.connectionId, clone(connection));
    }
    this.#oauthBrokerAuthorizationFlows.set(flow.flowHash, awaiting);
    return clone(awaiting);
  }

  async getBrokerSelection(input: GetBrokerSelectionInput): Promise<BrokerSelectionContext | undefined> {
    const flow = this.#oauthBrokerAuthorizationFlows.get(input.flowHash);
    if (
      !flow ||
      flow.status !== "AWAITING_SELECTION" ||
      flow.browserSessionHash !== input.browserSessionHash ||
      !isValidDate(input.now) ||
      !flow.authorizationId ||
      !flow.selectionCsrfHash ||
      flow.consumedAt ||
      flow.expiresAt <= input.now
    ) return undefined;
    const authorization = this.#providerAuthorizations.get(flow.authorizationId);
    if (!authorization || authorization.status !== "ACTIVE" || authorization.workspaceId !== flow.workspaceId) {
      return undefined;
    }
    const connections = [...this.#authorizedConnections.values()]
      .filter((connection) =>
        connection.authorizationId === authorization.authorizationId && connection.status === "ACTIVE"
      )
      .sort((left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.connectionId.localeCompare(right.connectionId)
      )
      .map(clone);
    if (connections.length === 0) return undefined;
    return { flow: clone(flow), connections };
  }

  async completeBrokerOrganisationSelection(
    input: CompleteBrokerOrganisationSelectionInput,
  ): Promise<CompleteBrokerOrganisationSelectionResult | undefined> {
    const flow = this.#oauthBrokerAuthorizationFlows.get(input.flowHash);
    if (
      !flow ||
      flow.status !== "AWAITING_SELECTION" ||
      flow.browserSessionHash !== input.browserSessionHash ||
      flow.selectionCsrfHash !== input.selectionCsrfHash ||
      !flow.authorizationId ||
      !flow.outerStateCiphertext ||
      flow.consumedAt ||
      flow.expiresAt <= input.now ||
      !isNonEmpty(input.bindingId) ||
      !isNonEmpty(input.policyId) ||
      !isHashedValue(input.authorizationCodeHash) ||
      !isValidDate(input.now) ||
      !isValidDate(input.authorizationCodeExpiresAt) ||
      input.authorizationCodeExpiresAt <= input.now ||
      input.authorizationCodeExpiresAt.getTime() - input.now.getTime() > OAUTH_AUTHORIZATION_CODE_MAX_TTL_MS
    ) return undefined;

    const installation = this.#oauthInstallations.get(flow.installationId);
    const authorization = this.#providerAuthorizations.get(flow.authorizationId);
    const connection = this.#authorizedConnections.get(input.selectedConnectionId);
    if (
      !installation ||
      installation.status !== "PENDING" ||
      installation.workspaceId !== flow.workspaceId ||
      installation.subjectType !== flow.subjectType ||
      installation.subjectId !== flow.subjectId ||
      installation.agentId !== flow.agentId ||
      installation.clientId !== flow.clientId ||
      !authorization ||
      authorization.status !== "ACTIVE" ||
      authorization.workspaceId !== flow.workspaceId ||
      !connection ||
      connection.status !== "ACTIVE" ||
      connection.authorizationId !== flow.authorizationId ||
      this.#agentConnectionBindings.has(input.bindingId) ||
      [...this.#agentConnectionBindings.values()].some((binding) => binding.installationId === flow.installationId) ||
      this.#oauthAuthorizationCodes.has(input.authorizationCodeHash) ||
      [...this.#oauthAuthorizationCodes.values()].some((code) => code.flowHash === flow.flowHash)
    ) return undefined;

    if (flow.personalPoc) {
      const otherActiveInstallations = [...this.#oauthInstallations.values()].filter((candidate) =>
        candidate.installationId !== flow.installationId &&
        candidate.status === "ACTIVE" &&
        candidate.workspaceId === flow.workspaceId &&
        candidate.subjectType === flow.subjectType &&
        candidate.subjectId === flow.subjectId &&
        candidate.agentId === flow.agentId &&
        candidate.clientId === flow.clientId
      );
      const replacedInstallations: OAuthInstallation[] = [];
      for (const candidate of otherActiveInstallations) {
        const families = [...this.#mcpRefreshTokenFamilies.values()].filter((family) =>
          family.installationId === candidate.installationId
        );
        if (families.length === 0) {
          const hasExchangeableCode = [...this.#oauthAuthorizationCodes.values()].some((code) =>
            code.installationId === candidate.installationId &&
            !code.consumedAt &&
            code.expiresAt > input.now
          );
          // A just-selected grant may still be exchanging its first code. Keep
          // that race fail-closed, but do not let an expired, never-exchanged
          // Host callback strand this Personal POC client forever.
          if (hasExchangeableCode) return undefined;
        }
        replacedInstallations.push(candidate);
      }
      for (const replaced of replacedInstallations) {
        await this.revokeOAuthInstallation(replaced.installationId, replaced.workspaceId, input.now);
      }
    }

    const activatedInstallation: OAuthInstallation = {
      ...installation,
      status: "ACTIVE",
      updatedAt: input.now,
    };
    const binding: AgentConnectionBinding = {
      bindingId: input.bindingId,
      installationId: flow.installationId,
      workspaceId: flow.workspaceId,
      subjectType: flow.subjectType,
      subjectId: flow.subjectId,
      agentId: flow.agentId,
      connectionId: connection.connectionId,
      policyId: input.policyId,
      status: "ACTIVE",
      createdAt: input.now,
      updatedAt: input.now,
    };
    const authorizationCode: OAuthAuthorizationCode = {
      codeHash: input.authorizationCodeHash,
      flowHash: flow.flowHash,
      installationId: flow.installationId,
      bindingId: binding.bindingId,
      connectionId: connection.connectionId,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      pkceCodeChallenge: flow.pkceCodeChallenge,
      pkceCodeChallengeMethod: "S256",
      resource: flow.resource,
      audience: flow.audience,
      grantedScopes: [...flow.requestedScopes],
      expiresAt: input.authorizationCodeExpiresAt,
      createdAt: input.now,
    };
    const outerStateCiphertext = flow.outerStateCiphertext;
    const completed: OAuthBrokerAuthorizationFlow = {
      ...flow,
      status: "COMPLETED",
      consumedAt: input.now,
      updatedAt: input.now,
    };
    delete completed.outerStateCiphertext;
    delete completed.selectionCsrfHash;

    this.#oauthInstallations.set(flow.installationId, activatedInstallation);
    this.#agentConnectionBindings.set(binding.bindingId, binding);
    this.#activeBindingIds.set(binding.installationId, binding.bindingId);
    this.#activeBindingRevisions.set(binding.installationId, 1);
    this.#oauthAuthorizationCodes.set(authorizationCode.codeHash, authorizationCode);
    this.#oauthBrokerAuthorizationFlows.set(flow.flowHash, completed);
    return {
      flow: clone(completed),
      installation: clone(activatedInstallation),
      binding: clone(binding),
      authorizationCode: clone(authorizationCode),
      outerStateCiphertext,
    };
  }

  async terminateBrokerAuthorizationFlow(
    input: TerminateBrokerAuthorizationFlowInput,
  ): Promise<TerminateBrokerAuthorizationFlowResult | undefined> {
    const flow = this.#oauthBrokerAuthorizationFlows.get(input.flowHash);
    if (
      !flow ||
      !["DENIED", "FAILED"].includes(input.terminalStatus) ||
      !["AUTHORIZING_XERO", "EXCHANGING_XERO", "AWAITING_SELECTION"].includes(flow.status) ||
      flow.browserSessionHash !== input.browserSessionHash ||
      !flow.outerStateCiphertext ||
      flow.consumedAt ||
      !isValidDate(input.now) ||
      flow.expiresAt <= input.now
    ) return undefined;
    const outerStateCiphertext = flow.outerStateCiphertext;
    const terminal: OAuthBrokerAuthorizationFlow = {
      ...flow,
      status: input.terminalStatus,
      consumedAt: input.now,
      updatedAt: input.now,
    };
    delete terminal.outerStateCiphertext;
    delete terminal.selectionCsrfHash;
    this.#revokePendingBrokerGrant(flow, input.now);
    this.#oauthBrokerAuthorizationFlows.set(flow.flowHash, terminal);
    return { flow: clone(terminal), outerStateCiphertext };
  }

  async saveOAuthAuthorizationCode(code: OAuthAuthorizationCode): Promise<void> {
    if (code.pkceCodeChallengeMethod !== "S256" || code.expiresAt <= code.createdAt) {
      throw new AppError("VALIDATION_FAILED", "OAuth authorization code lifetime or PKCE method is invalid.");
    }
    if (this.#oauthAuthorizationCodes.has(code.codeHash)) {
      throw new AppError("CONFLICT", "OAuth authorization code identifier already exists.", { httpStatus: 409 });
    }
    if ([...this.#oauthAuthorizationCodes.values()].some((candidate) => candidate.flowHash === code.flowHash)) {
      throw new AppError("CONFLICT", "OAuth broker flow already issued an authorization code.", {
        httpStatus: 409,
      });
    }
    this.#requireActiveBindingTuple(code.installationId, code.bindingId, code.connectionId);
    const installation = this.#oauthInstallations.get(code.installationId);
    const flow = this.#oauthBrokerFlows.get(code.flowHash);
    if (
      !installation ||
      installation.clientId !== code.clientId ||
      !flow ||
      !flow.consumedAt ||
      flow.expiresAt <= code.createdAt ||
      flow.consumedAt > code.createdAt ||
      flow.clientId !== code.clientId ||
      flow.redirectUri !== code.redirectUri ||
      flow.pkceCodeChallenge !== code.pkceCodeChallenge ||
      flow.pkceCodeChallengeMethod !== code.pkceCodeChallengeMethod ||
      flow.workspaceId !== installation.workspaceId ||
      flow.subjectType !== installation.subjectType ||
      flow.subjectId !== installation.subjectId ||
      flow.agentId !== installation.agentId ||
      !isScopeSubset(code.grantedScopes, flow.requestedScopes)
    ) {
      throw new AppError("FORBIDDEN", "OAuth authorization code belongs to another OAuth client.", {
        httpStatus: 403,
      });
    }
    this.#oauthAuthorizationCodes.set(code.codeHash, clone(code));
  }

  async peekOAuthAuthorizationCodeForExchange(
    input: PeekOAuthAuthorizationCodeForExchangeInput,
  ): Promise<OAuthAuthorizationCodeExchangePreview | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const code = this.#oauthAuthorizationCodes.get(input.codeHash);
    if (
      !code ||
      code.clientId !== input.clientId ||
      code.redirectUri !== input.redirectUri ||
      code.pkceCodeChallenge !== input.pkceCodeChallenge ||
      code.pkceCodeChallengeMethod !== "S256" ||
      code.resource !== input.expectedResource ||
      code.consumedAt ||
      code.expiresAt <= input.now ||
      !this.#resolveActiveBindingByTuple(code.installationId, code.bindingId, code.connectionId)
    ) return undefined;
    return {
      codeHash: code.codeHash,
      installationId: code.installationId,
      bindingId: code.bindingId,
      connectionId: code.connectionId,
      clientId: code.clientId,
      resource: code.resource,
      audience: code.audience,
      grantedScopes: [...code.grantedScopes],
      expiresAt: new Date(code.expiresAt),
    };
  }

  async consumeOAuthAuthorizationCode(
    input: ConsumeOAuthAuthorizationCodeInput,
  ): Promise<OAuthAuthorizationCode | undefined> {
    const code = this.#oauthAuthorizationCodes.get(input.codeHash);
    if (
      !code ||
      code.clientId !== input.clientId ||
      code.redirectUri !== input.redirectUri ||
      code.pkceCodeChallenge !== input.pkceCodeChallenge ||
      code.pkceCodeChallengeMethod !== "S256" ||
      code.consumedAt ||
      code.expiresAt <= input.now ||
      !this.#resolveActiveBindingByTuple(code.installationId, code.bindingId, code.connectionId)
    ) {
      return undefined;
    }
    const consumed = { ...code, consumedAt: input.now };
    this.#oauthAuthorizationCodes.set(input.codeHash, consumed);
    return clone(consumed);
  }

  async exchangeOAuthAuthorizationCodeForTokenSet(
    input: ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ): Promise<ExchangeOAuthAuthorizationCodeForTokenSetResult> {
    const code = this.#oauthAuthorizationCodes.get(input.grant.codeHash);
    const family = input.refreshTokenFamily.family;
    const refreshToken = input.refreshTokenFamily.initialToken;
    const accessToken = input.accessToken;
    if (
      !code ||
      code.clientId !== input.grant.clientId ||
      code.redirectUri !== input.grant.redirectUri ||
      code.pkceCodeChallenge !== input.grant.pkceCodeChallenge ||
      code.pkceCodeChallengeMethod !== "S256" ||
      code.resource !== input.grant.expectedResource ||
      code.consumedAt ||
      code.expiresAt <= input.grant.now ||
      !this.#resolveActiveBindingByTuple(code.installationId, code.bindingId, code.connectionId) ||
      family.status !== "ACTIVE" ||
      family.revokedAt ||
      family.replayDetectedAt ||
      family.installationId !== code.installationId ||
      family.bindingId !== code.bindingId ||
      family.connectionId !== code.connectionId ||
      family.clientId !== code.clientId ||
      family.resource !== code.resource ||
      family.audience !== code.audience ||
      !hasSameScopes(family.grantedScopes, code.grantedScopes) ||
      refreshToken.familyId !== family.familyId ||
      refreshToken.parentTokenHash ||
      refreshToken.consumedAt ||
      refreshToken.revokedAt ||
      refreshToken.replacedByTokenHash ||
      refreshToken.issuedAt.getTime() !== input.grant.now.getTime() ||
      refreshToken.expiresAt <= refreshToken.issuedAt ||
      accessToken.installationId !== code.installationId ||
      accessToken.bindingId !== code.bindingId ||
      accessToken.connectionId !== code.connectionId ||
      accessToken.refreshFamilyId !== family.familyId ||
      accessToken.clientId !== code.clientId ||
      accessToken.resource !== code.resource ||
      accessToken.audience !== code.audience ||
      !hasSameScopes(accessToken.grantedScopes, code.grantedScopes) ||
      accessToken.issuedAt.getTime() !== input.grant.now.getTime() ||
      accessToken.expiresAt <= accessToken.issuedAt ||
      accessToken.revokedAt
    ) {
      return { status: "INVALID" };
    }
    if (
      this.#mcpRefreshTokenFamilies.has(family.familyId) ||
      this.#mcpRefreshTokens.has(refreshToken.tokenHash) ||
      [...this.#mcpRefreshTokens.values()].some((token) => token.tokenId === refreshToken.tokenId) ||
      this.#mcpAccessTokens.has(accessToken.tokenHash) ||
      [...this.#mcpAccessTokens.values()].some((token) => token.tokenId === accessToken.tokenId)
    ) {
      throw new AppError("CONFLICT", "OAuth token-set identifier already exists.", { httpStatus: 409 });
    }

    const consumedCode: OAuthAuthorizationCode = { ...code, consumedAt: input.grant.now };
    this.#oauthAuthorizationCodes.set(code.codeHash, consumedCode);
    this.#mcpRefreshTokenFamilies.set(family.familyId, clone(family));
    this.#mcpRefreshTokens.set(refreshToken.tokenHash, clone(refreshToken));
    this.#mcpAccessTokens.set(accessToken.tokenHash, clone(accessToken));
    return {
      status: "ISSUED",
      authorizationCode: clone(consumedCode),
      accessToken: clone(accessToken),
      refreshToken: clone(refreshToken),
    };
  }

  async saveMcpAccessToken(token: McpAccessToken): Promise<void> {
    if (token.expiresAt <= token.issuedAt) {
      throw new AppError("VALIDATION_FAILED", "MCP access token expiry must be after issuance.");
    }
    if (this.#mcpAccessTokens.has(token.tokenHash) || [...this.#mcpAccessTokens.values()].some(
      (candidate) => candidate.tokenId === token.tokenId,
    )) {
      throw new AppError("CONFLICT", "MCP access token identifier already exists.", { httpStatus: 409 });
    }
    this.#requireActiveBindingTuple(token.installationId, token.bindingId, token.connectionId);
    if (this.#oauthInstallations.get(token.installationId)?.clientId !== token.clientId) {
      throw new AppError("FORBIDDEN", "MCP access token belongs to another OAuth client.", {
        httpStatus: 403,
      });
    }
    if (token.refreshFamilyId) {
      const family = this.#mcpRefreshTokenFamilies.get(token.refreshFamilyId);
      if (
        !family ||
        family.status !== "ACTIVE" ||
        family.installationId !== token.installationId ||
        family.bindingId !== token.bindingId ||
        family.connectionId !== token.connectionId ||
        family.clientId !== token.clientId ||
        family.resource !== token.resource ||
        family.audience !== token.audience ||
        !isScopeSubset(token.grantedScopes, family.grantedScopes)
      ) {
        throw new AppError("FORBIDDEN", "Access token does not match its refresh token family.", {
          httpStatus: 403,
        });
      }
    }
    this.#mcpAccessTokens.set(token.tokenHash, clone(token));
  }

  async resolveMcpAccessToken(input: ResolveMcpAccessTokenInput): Promise<ResolvedMcpAccessToken | undefined> {
    const token = this.#mcpAccessTokens.get(input.tokenHash);
    if (
      !token ||
      token.resource !== input.expectedResource ||
      token.audience !== input.expectedAudience ||
      token.revokedAt ||
      token.expiresAt <= input.now
    ) {
      return undefined;
    }
    const sourceBinding = this.#resolveActiveBindingByTuple(
      token.installationId,
      token.bindingId,
      token.connectionId,
    );
    if (!sourceBinding) return undefined;
    const activeBindingId = this.#currentBindingId(token.installationId);
    const activeBinding = this.#agentConnectionBindings.get(activeBindingId);
    const binding = activeBinding
      ? this.#resolveActiveBindingByTuple(
          token.installationId,
          activeBinding.bindingId,
          activeBinding.connectionId,
        )
      : undefined;
    if (!binding) return undefined;
    return {
      tokenId: token.tokenId,
      clientId: token.clientId,
      resource: token.resource,
      audience: token.audience,
      grantedScopes: [...token.grantedScopes],
      issuedAt: new Date(token.issuedAt),
      expiresAt: new Date(token.expiresAt),
      ...binding,
    };
  }

  async revokeMcpAccessToken(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const token = this.#mcpAccessTokens.get(tokenHash);
    if (!token) return false;
    if (!token.revokedAt) this.#mcpAccessTokens.set(tokenHash, { ...token, revokedAt });
    return true;
  }

  async createMcpRefreshTokenFamily(input: CreateMcpRefreshTokenFamilyInput): Promise<void> {
    const { family, initialToken } = input;
    if (
      initialToken.familyId !== family.familyId ||
      initialToken.parentTokenHash ||
      family.status !== "ACTIVE" ||
      family.revokedAt ||
      family.replayDetectedAt ||
      initialToken.consumedAt ||
      initialToken.revokedAt ||
      initialToken.replacedByTokenHash ||
      initialToken.retryAccessTokenHash ||
      initialToken.retryResponseCiphertext ||
      initialToken.retryExpiresAt ||
      initialToken.expiresAt <= initialToken.issuedAt
    ) {
      throw new AppError("VALIDATION_FAILED", "MCP refresh token family input is invalid.");
    }
    if (
      this.#mcpRefreshTokenFamilies.has(family.familyId) ||
      this.#mcpRefreshTokens.has(initialToken.tokenHash) ||
      [...this.#mcpRefreshTokens.values()].some((token) => token.tokenId === initialToken.tokenId)
    ) {
      throw new AppError("CONFLICT", "MCP refresh token family cannot be created from this input.", {
        httpStatus: 409,
      });
    }
    this.#requireActiveBindingTuple(family.installationId, family.bindingId, family.connectionId);
    if (this.#oauthInstallations.get(family.installationId)?.clientId !== family.clientId) {
      throw new AppError("FORBIDDEN", "MCP refresh token family belongs to another OAuth client.", {
        httpStatus: 403,
      });
    }
    if ([...this.#mcpRefreshTokenFamilies.values()].some((candidate) =>
      candidate.installationId === family.installationId && candidate.status === "ACTIVE"
    )) {
      throw new AppError("CONFLICT", "OAuth installation already has an active MCP refresh-token family.", {
        httpStatus: 409,
      });
    }
    this.#mcpRefreshTokenFamilies.set(family.familyId, clone(family));
    this.#mcpRefreshTokens.set(initialToken.tokenHash, clone(initialToken));
  }

  async peekMcpRefreshTokenContext(
    input: PeekMcpRefreshTokenContextInput,
  ): Promise<McpRefreshTokenContextPreview | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const token = this.#mcpRefreshTokens.get(input.tokenHash);
    if (!token || token.revokedAt) return undefined;
    const family = this.#mcpRefreshTokenFamilies.get(token.familyId);
    if (
      !family ||
      family.status !== "ACTIVE" ||
      family.clientId !== input.clientId ||
      family.resource !== input.expectedResource ||
      family.audience !== input.expectedAudience ||
      !this.#resolveActiveBindingByTuple(family.installationId, family.bindingId, family.connectionId)
    ) return undefined;
    return {
      familyId: family.familyId,
      installationId: family.installationId,
      bindingId: family.bindingId,
      connectionId: family.connectionId,
      clientId: family.clientId,
      resource: family.resource,
      audience: family.audience,
      grantedScopes: [...family.grantedScopes],
      consumed: Boolean(token.consumedAt),
      expiresAt: new Date(token.expiresAt),
    };
  }

  async rotateMcpRefreshToken(input: RotateMcpRefreshTokenInput): Promise<RotateMcpRefreshTokenResult> {
    const current = this.#mcpRefreshTokens.get(input.currentTokenHash);
    if (!current) return { status: "INVALID" };
    const family = this.#mcpRefreshTokenFamilies.get(current.familyId);
    if (
      !family ||
      family.status !== "ACTIVE" ||
      family.clientId !== input.expectedClientId ||
      family.resource !== input.expectedResource ||
      family.audience !== input.expectedAudience ||
      !this.#resolveActiveBindingByTuple(family.installationId, family.bindingId, family.connectionId)
    ) {
      return { status: "INVALID" };
    }
    if (current.consumedAt) {
      this.#revokeRefreshGrant(family.familyId, input.issuedAt, input.issuedAt);
      return { status: "REPLAY_DETECTED", familyId: family.familyId };
    }
    if (current.expiresAt <= input.issuedAt) {
      this.#revokeRefreshGrant(family.familyId, input.issuedAt);
      return { status: "INVALID" };
    }
    if (
      current.revokedAt ||
      input.expiresAt <= input.issuedAt ||
      !isScopeSubset(input.requestedScopes ?? family.grantedScopes, family.grantedScopes)
    ) {
      return { status: "INVALID" };
    }
    const grantedScopes = [...(input.requestedScopes ?? family.grantedScopes)];
    if (
      this.#mcpRefreshTokens.has(input.newTokenHash) ||
      [...this.#mcpRefreshTokens.values()].some((token) => token.tokenId === input.newTokenId)
    ) {
      throw new AppError("CONFLICT", "Rotated MCP refresh token identifier already exists.", { httpStatus: 409 });
    }
    const rotated: McpRefreshToken = {
      tokenHash: input.newTokenHash,
      tokenId: input.newTokenId,
      familyId: family.familyId,
      parentTokenHash: current.tokenHash,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    this.#mcpRefreshTokens.set(rotated.tokenHash, rotated);
    this.#mcpRefreshTokens.set(current.tokenHash, {
      ...current,
      consumedAt: input.issuedAt,
      replacedByTokenHash: rotated.tokenHash,
    });
    this.#mcpRefreshTokenFamilies.set(family.familyId, { ...family, updatedAt: input.issuedAt });
    return {
      status: "ROTATED",
      familyId: family.familyId,
      refreshToken: clone(rotated),
      installationId: family.installationId,
      bindingId: family.bindingId,
      connectionId: family.connectionId,
      grantedScopes,
    };
  }

  async rotateMcpRefreshTokenAndIssueAccessToken(
    input: RotateMcpRefreshTokenAndIssueAccessTokenInput,
  ): Promise<RotateMcpRefreshTokenAndIssueAccessTokenResult> {
    const { rotation, accessToken } = input;
    const current = this.#mcpRefreshTokens.get(rotation.currentTokenHash);
    if (!current) return { status: "INVALID" };
    const family = this.#mcpRefreshTokenFamilies.get(current.familyId);
    if (
      !family ||
      family.status !== "ACTIVE" ||
      family.clientId !== rotation.expectedClientId ||
      family.resource !== rotation.expectedResource ||
      family.audience !== rotation.expectedAudience ||
      !this.#resolveActiveBindingByTuple(family.installationId, family.bindingId, family.connectionId)
    ) {
      return { status: "INVALID" };
    }
    const expectedScopes = [...(rotation.requestedScopes ?? family.grantedScopes)];
    const parent = current.parentTokenHash
      ? this.#mcpRefreshTokens.get(current.parentTokenHash)
      : undefined;
    if (
      parent?.consumedAt &&
      parent.replacedByTokenHash === current.tokenHash &&
      parent.consumedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
        rotation.issuedAt.getTime()
    ) {
      const successorAccess = parent.retryAccessTokenHash
        ? this.#mcpAccessTokens.get(parent.retryAccessTokenHash)
        : undefined;
      if (
        parent.retryResponseCiphertext &&
        parent.retryExpiresAt &&
        parent.retryExpiresAt > rotation.issuedAt &&
        !current.consumedAt &&
        !current.replacedByTokenHash &&
        !current.revokedAt &&
        current.expiresAt > rotation.issuedAt &&
        successorAccess &&
        !successorAccess.revokedAt &&
        successorAccess.expiresAt > rotation.issuedAt &&
        successorAccess.refreshFamilyId === family.familyId &&
        hasSameScopes(successorAccess.grantedScopes, expectedScopes)
      ) {
        return {
          status: "COALESCED",
          sourceTokenHash: parent.tokenHash,
          accessTokenHash: successorAccess.tokenHash,
          refreshTokenHash: current.tokenHash,
          responseCiphertext: parent.retryResponseCiphertext,
          grantedScopes: [...successorAccess.grantedScopes],
        };
      }
      return { status: "INVALID" };
    }
    if (current.consumedAt) {
      const successor = current.replacedByTokenHash
        ? this.#mcpRefreshTokens.get(current.replacedByTokenHash)
        : undefined;
      const successorAccess = current.retryAccessTokenHash
        ? this.#mcpAccessTokens.get(current.retryAccessTokenHash)
        : undefined;
      if (
        current.retryResponseCiphertext &&
        current.retryExpiresAt &&
        current.retryExpiresAt > rotation.issuedAt &&
        current.consumedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
          rotation.issuedAt.getTime() &&
        successor &&
        !successor.consumedAt &&
        !successor.replacedByTokenHash &&
        !successor.revokedAt &&
        successor.expiresAt > rotation.issuedAt &&
        successorAccess &&
        !successorAccess.revokedAt &&
        successorAccess.expiresAt > rotation.issuedAt &&
        successorAccess.refreshFamilyId === family.familyId &&
        hasSameScopes(successorAccess.grantedScopes, expectedScopes)
      ) {
        return {
          status: "COALESCED",
          sourceTokenHash: current.tokenHash,
          accessTokenHash: successorAccess.tokenHash,
          refreshTokenHash: successor.tokenHash,
          responseCiphertext: current.retryResponseCiphertext,
          grantedScopes: [...successorAccess.grantedScopes],
        };
      }
      if (
        current.consumedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
        rotation.issuedAt.getTime()
      ) {
        // Fail this non-coalescible retry without destroying the valid
        // successor grant. This covers mixed-scope fan-out and a briefly
        // mixed-version deployment whose older node could not cache a retry
        // response. A later replay still revokes the family.
        return { status: "INVALID" };
      }
      this.#revokeRefreshGrant(family.familyId, rotation.issuedAt, rotation.issuedAt);
      return { status: "REPLAY_DETECTED", familyId: family.familyId };
    }
    if (current.expiresAt <= rotation.issuedAt) {
      this.#revokeRefreshGrant(family.familyId, rotation.issuedAt);
      return { status: "INVALID" };
    }
    const grantedScopes = expectedScopes;
    if (
      current.revokedAt ||
      rotation.expiresAt <= rotation.issuedAt ||
      !isNonEmpty(input.retryResponseCiphertext) ||
      !isValidDate(input.retryExpiresAt) ||
      input.retryExpiresAt <= rotation.issuedAt ||
      input.retryExpiresAt.getTime() >
        rotation.issuedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS ||
      accessToken.installationId !== family.installationId ||
      accessToken.bindingId !== family.bindingId ||
      accessToken.connectionId !== family.connectionId ||
      accessToken.refreshFamilyId !== family.familyId ||
      accessToken.clientId !== family.clientId ||
      accessToken.resource !== family.resource ||
      accessToken.audience !== family.audience ||
      !isScopeSubset(grantedScopes, family.grantedScopes) ||
      !hasSameScopes(accessToken.grantedScopes, grantedScopes) ||
      accessToken.issuedAt.getTime() !== rotation.issuedAt.getTime() ||
      accessToken.expiresAt <= accessToken.issuedAt ||
      accessToken.revokedAt
    ) {
      return { status: "INVALID" };
    }
    if (
      this.#mcpRefreshTokens.has(rotation.newTokenHash) ||
      [...this.#mcpRefreshTokens.values()].some((token) => token.tokenId === rotation.newTokenId) ||
      this.#mcpAccessTokens.has(accessToken.tokenHash) ||
      [...this.#mcpAccessTokens.values()].some((token) => token.tokenId === accessToken.tokenId)
    ) {
      throw new AppError("CONFLICT", "Rotated OAuth token-set identifier already exists.", { httpStatus: 409 });
    }
    const rotated: McpRefreshToken = {
      tokenHash: rotation.newTokenHash,
      tokenId: rotation.newTokenId,
      familyId: family.familyId,
      parentTokenHash: current.tokenHash,
      issuedAt: rotation.issuedAt,
      expiresAt: rotation.expiresAt,
    };
    this.#mcpRefreshTokens.set(rotated.tokenHash, rotated);
    this.#mcpRefreshTokens.set(current.tokenHash, {
      ...current,
      consumedAt: rotation.issuedAt,
      replacedByTokenHash: rotated.tokenHash,
      retryAccessTokenHash: accessToken.tokenHash,
      retryResponseCiphertext: input.retryResponseCiphertext,
      retryExpiresAt: input.retryExpiresAt,
    });
    this.#mcpAccessTokens.set(accessToken.tokenHash, clone(accessToken));
    this.#mcpRefreshTokenFamilies.set(family.familyId, { ...family, updatedAt: rotation.issuedAt });
    return {
      status: "ROTATED",
      familyId: family.familyId,
      refreshToken: clone(rotated),
      accessToken: clone(accessToken),
      installationId: family.installationId,
      bindingId: family.bindingId,
      connectionId: family.connectionId,
      grantedScopes,
    };
  }

  async revokeMcpRefreshTokenFamilyByTokenHash(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const token = this.#mcpRefreshTokens.get(tokenHash);
    if (!token || !this.#mcpRefreshTokenFamilies.has(token.familyId)) return false;
    this.#revokeRefreshFamily(token.familyId, revokedAt);
    return true;
  }

  async revokeOAuthTokenForClient(
    input: RevokeOAuthTokenForClientInput,
  ): Promise<RevokeOAuthTokenForClientResult> {
    if (!isValidDate(input.revokedAt)) return { status: "ACCEPTED" };
    const accessToken = this.#mcpAccessTokens.get(input.tokenHash);
    if (accessToken?.clientId === input.clientId && !accessToken.revokedAt) {
      this.#mcpAccessTokens.set(input.tokenHash, { ...accessToken, revokedAt: input.revokedAt });
    }
    const refreshToken = this.#mcpRefreshTokens.get(input.tokenHash);
    const family = refreshToken ? this.#mcpRefreshTokenFamilies.get(refreshToken.familyId) : undefined;
    if (family?.clientId === input.clientId) this.#revokeRefreshGrant(family.familyId, input.revokedAt);
    return { status: "ACCEPTED" };
  }

  async saveOAuthState(
    stateHash: string,
    browserSessionHash: string,
    actorId: string,
    expiresAt: Date,
  ): Promise<void> {
    this.#oauthStates.set(stateHash, { actorId, browserSessionHash, expiresAt });
  }

  async consumeOAuthState(
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<{ actorId: string } | undefined> {
    const state = this.#oauthStates.get(stateHash);
    if (!state || state.browserSessionHash !== browserSessionHash || state.consumedAt || state.expiresAt <= now) {
      return undefined;
    }
    state.consumedAt = now;
    return { actorId: state.actorId };
  }

  async saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date): Promise<void> {
    this.#connectTickets.set(ticketHash, { actorId, expiresAt });
  }

  async consumeConnectTicket(ticketHash: string, now: Date): Promise<{ actorId: string } | undefined> {
    const ticket = this.#connectTickets.get(ticketHash);
    if (!ticket || ticket.consumedAt || ticket.expiresAt <= now) return undefined;
    ticket.consumedAt = now;
    return { actorId: ticket.actorId };
  }

  async saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date): Promise<void> {
    this.#operatorSessions.set(sessionHash, { actorId, expiresAt });
  }

  async getOperatorSession(sessionHash: string, now: Date): Promise<{ actorId: string } | undefined> {
    const session = this.#operatorSessions.get(sessionHash);
    return session && session.expiresAt > now ? { actorId: session.actorId } : undefined;
  }

  async revokeOperatorSessions(actorId: string): Promise<number> {
    let revoked = 0;
    for (const [sessionHash, session] of this.#operatorSessions.entries()) {
      if (session.actorId === actorId) {
        this.#operatorSessions.delete(sessionHash);
        revoked += 1;
      }
    }
    return revoked;
  }

  async saveReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    expiresAt: Date,
  ): Promise<void> {
    this.#reviewCsrf.set(csrfHash, { sessionHash, actorId, postingRequestId, expiresAt });
  }

  async consumeReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    now: Date,
  ): Promise<boolean> {
    const token = this.#reviewCsrf.get(csrfHash);
    if (
      !token ||
      token.sessionHash !== sessionHash ||
      token.actorId !== actorId ||
      token.postingRequestId !== postingRequestId ||
      token.expiresAt <= now ||
      token.consumedAt
    ) {
      return false;
    }
    token.consumedAt = now;
    return true;
  }

  async cleanupExpiredEphemeral(
    cutoff: Date,
    batchSize: number,
    brokerFlowCutoff = cutoff,
  ): Promise<EphemeralCleanupBatchResult> {
    assertCleanupArguments(cutoff, batchSize);
    if (!isValidDate(brokerFlowCutoff)) {
      throw new AppError("VALIDATION_FAILED", "OAuth Broker cleanup cutoff must be a valid date.");
    }
    const deleted = emptyEphemeralCleanupCounts();
    const retryTargets = [...this.#mcpRefreshTokens.entries()]
      .filter(([, token]) =>
        Boolean(token.retryResponseCiphertext) &&
        Boolean(token.retryExpiresAt && token.retryExpiresAt <= brokerFlowCutoff)
      )
      .sort(([leftHash, left], [rightHash, right]) =>
        (left.retryExpiresAt?.getTime() ?? 0) - (right.retryExpiresAt?.getTime() ?? 0) ||
        leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [tokenHash, token] of retryTargets) {
      const scrubbed = { ...token };
      delete scrubbed.retryAccessTokenHash;
      delete scrubbed.retryResponseCiphertext;
      delete scrubbed.retryExpiresAt;
      this.#mcpRefreshTokens.set(tokenHash, scrubbed);
    }
    deleted.mcpRefreshRetryResponses = retryTargets.length;

    const switchTargets = [...this.#organisationSwitchSessions.entries()]
      .filter(([, session]) => session.expiresAt <= brokerFlowCutoff || Boolean(session.consumedAt))
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash)
      )
      .slice(0, batchSize);
    for (const [sessionHash] of switchTargets) this.#organisationSwitchSessions.delete(sessionHash);
    deleted.organisationSwitchSessions = switchTargets.length;

    const durableTargetSessionHashes = new Set([
      ...[...this.#accountingCases.values()].map((aggregate) => aggregate.binding.targetSessionHash),
      ...[...this.#accountingCaseRecoveryResidualGrants.values()]
        .map((grant) => grant.successorBinding.targetSessionHash),
    ]);
    const targetSessionTargets = [...this.#ledgerTargetSessions.entries()]
      .filter(([sessionHash, session]) =>
        (session.expiresAt <= brokerFlowCutoff || Boolean(session.revokedAt)) &&
        !durableTargetSessionHashes.has(sessionHash)
      )
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash)
      )
      .slice(0, batchSize);
    for (const [sessionHash] of targetSessionTargets) this.#ledgerTargetSessions.delete(sessionHash);
    deleted.ledgerTargetSessions = targetSessionTargets.length;

    const expiredBrokerFlows = [...this.#oauthBrokerAuthorizationFlows.entries()]
      .filter(([, flow]) =>
        ["AUTHORIZING_XERO", "EXCHANGING_XERO", "AWAITING_SELECTION"].includes(flow.status) &&
        !flow.consumedAt &&
        Boolean(flow.outerStateCiphertext) &&
        flow.expiresAt <= brokerFlowCutoff
      )
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [flowHash, flow] of expiredBrokerFlows) {
      const failed: OAuthBrokerAuthorizationFlow = {
        ...flow,
        status: "FAILED",
        consumedAt: brokerFlowCutoff,
        updatedAt: brokerFlowCutoff,
      };
      delete failed.outerStateCiphertext;
      delete failed.selectionCsrfHash;
      this.#revokePendingBrokerGrant(flow, brokerFlowCutoff);
      this.#oauthBrokerAuthorizationFlows.set(flowHash, failed);
    }
    deleted.oauthBrokerFlows = expiredBrokerFlows.length;

    const expiredSessionHashes = new Set(
      [...this.#operatorSessions.entries()]
        .filter(([, session]) => session.expiresAt <= cutoff)
        .map(([sessionHash]) => sessionHash),
    );

    const csrfTargets = [...this.#reviewCsrf.entries()]
      .filter(([, token]) => token.expiresAt <= cutoff || expiredSessionHashes.has(token.sessionHash))
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [csrfHash] of csrfTargets) this.#reviewCsrf.delete(csrfHash);
    deleted.reviewCsrfTokens = csrfTargets.length;

    const sessionsWithChildren = new Set([...this.#reviewCsrf.values()].map((token) => token.sessionHash));
    const sessionTargets = [...this.#operatorSessions.entries()]
      .filter(([sessionHash, session]) => session.expiresAt <= cutoff && !sessionsWithChildren.has(sessionHash))
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [sessionHash] of sessionTargets) this.#operatorSessions.delete(sessionHash);
    deleted.operatorSessions = sessionTargets.length;

    const oauthTargets = [...this.#oauthStates.entries()]
      .filter(([, state]) => state.expiresAt <= cutoff)
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [stateHash] of oauthTargets) this.#oauthStates.delete(stateHash);
    deleted.oauthStates = oauthTargets.length;

    const ticketTargets = [...this.#connectTickets.entries()]
      .filter(([, ticket]) => ticket.expiresAt <= cutoff)
      .sort(([leftHash, left], [rightHash, right]) =>
        left.expiresAt.getTime() - right.expiresAt.getTime() || leftHash.localeCompare(rightHash),
      )
      .slice(0, batchSize);
    for (const [ticketHash] of ticketTargets) this.#connectTickets.delete(ticketHash);
    deleted.connectTickets = ticketTargets.length;

    return { lockAcquired: true, deleted };
  }

  async getConnectionByActorTenant(actorId: string, tenantId: string): Promise<ProviderConnection | undefined> {
    const found = [...this.#connections.values()].find(
      (connection) => connection.actorId === actorId && connection.tenantId === tenantId,
    );
    return found ? clone(found) : undefined;
  }

  async listActiveConnections(actorId: string): Promise<ProviderConnection[]> {
    return [...this.#connections.values()]
      .filter((connection) => connection.actorId === actorId && connection.status === "ACTIVE")
      .map(clone);
  }

  async upsertConnection(connection: ProviderConnection): Promise<ProviderConnection> {
    const existing = [...this.#connections.values()].find(
      (candidate) => candidate.actorId === connection.actorId && candidate.tenantId === connection.tenantId,
    );
    const saved = existing
      ? { ...connection, connectionId: existing.connectionId, createdAt: existing.createdAt }
      : connection;
    this.#connections.set(saved.connectionId, clone(saved));
    return clone(saved);
  }

  async updateConnectionToken(
    connectionId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
  ): Promise<ProviderConnection | undefined> {
    const connection = this.#connections.get(connectionId);
    if (
      !connection ||
      connection.refreshVersion !== expectedRefreshVersion ||
      connection.status === "REVOKED"
    ) return undefined;
    const updated: ProviderConnection = {
      ...connection,
      tokenCiphertext,
      tokenExpiresAt,
      refreshVersion: connection.refreshVersion + 1,
      status: "ACTIVE",
      updatedAt: new Date(),
    };
    this.#connections.set(connectionId, updated);
    return clone(updated);
  }

  async markConnectionStatus(connectionId: string, status: ProviderConnection["status"]): Promise<void> {
    const connection = this.#connections.get(connectionId);
    const authorizedConnection = this.#authorizedConnections.get(connectionId);
    const changedAt = new Date();
    if (connection && connection.status !== "REVOKED") {
      this.#connections.set(connectionId, { ...connection, status, updatedAt: changedAt });
    }
    if (authorizedConnection && authorizedConnection.status !== "REVOKED") {
      this.#authorizedConnections.set(connectionId, { ...authorizedConnection, status, updatedAt: changedAt });
    }
  }

  async markConnectionStatusIfVersion(
    connectionId: string,
    expectedRefreshVersion: number,
    status: ProviderConnection["status"],
  ): Promise<boolean> {
    const connection = this.#connections.get(connectionId);
    if (connection) {
      if (connection.refreshVersion !== expectedRefreshVersion || connection.status !== "ACTIVE") return false;
      this.#connections.set(connectionId, { ...connection, status, updatedAt: new Date() });
      return true;
    }
    const authorizedConnection = this.#authorizedConnections.get(connectionId);
    if (!authorizedConnection || expectedRefreshVersion !== 0 || authorizedConnection.status !== "ACTIVE") {
      return false;
    }
    this.#authorizedConnections.set(connectionId, {
      ...authorizedConnection,
      status,
      updatedAt: new Date(),
    });
    return true;
  }

  async createOrGetPosting(input: CreatePostingInput): Promise<{ posting: PostingRequest; created: boolean }> {
    const identity = xeroSupplierPostingIdentity(input.providerPayload);
    const documentType = input.documentType ?? identity.documentType;
    if (identity.documentType !== documentType) {
      throw new AppError("VALIDATION_FAILED", "Xero document type does not match the canonical provider payload.");
    }
    const key = `${input.actorId}:${input.tenantId}:${documentType}:${input.requestId}:CREATE_DRAFT`;
    const existingId = this.#createKeys.get(key);
    if (existingId) {
      const existing = this.#postings.get(existingId);
      if (!existing) throw new Error("In-memory idempotency index is corrupt");
      return { posting: clone(existing), created: false };
    }

    const duplicate = this.#findActivePostingDuplicate({
      tenantId: input.tenantId,
      sourceSha256: input.sourceSha256,
      ...identity,
    });
    if (duplicate) return { posting: clone(duplicate), created: false };

    const now = new Date();
    const posting: PostingRequest = {
      ...input,
      documentType,
      state: "VALIDATED",
      createdAt: now,
      updatedAt: now,
    };
    this.#postings.set(posting.postingRequestId, posting);
    this.#createKeys.set(key, posting.postingRequestId);
    return { posting: clone(posting), created: true };
  }

  async findActivePostingDuplicate(
    input: FindActiveXeroPostingDuplicateInput,
  ): Promise<PostingRequest | undefined> {
    const duplicate = this.#findActivePostingDuplicate(input);
    return duplicate ? clone(duplicate) : undefined;
  }

  #findActivePostingDuplicate(
    input: FindActiveXeroPostingDuplicateInput,
  ): PostingRequest | undefined {
    return [...this.#postings.values()].find((posting) => isXeroPostingDuplicate(posting, input));
  }

  async getPosting(postingRequestId: string): Promise<PostingRequest | undefined> {
    const posting = this.#postings.get(postingRequestId);
    return posting ? clone(posting) : undefined;
  }

  async markDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest> {
    const posting = this.#requirePosting(postingRequestId);
    if (posting.state !== "VALIDATED") {
      throw new AppError("CONFLICT", `Posting request is in ${posting.state}, not VALIDATED.`, { httpStatus: 409 });
    }
    const updated: PostingRequest = {
      ...posting,
      ...update,
      draftWriteReceipt: update.writeReceipt,
      draftReadbackSnapshot: update.readbackSnapshot,
      state: posting.documentType === "ACCREC" ? "DRAFT_READBACK_VERIFIED" : "APPROVAL_PENDING",
      updatedAt: new Date(),
    };
    this.#postings.set(postingRequestId, updated);
    return clone(updated);
  }

  async recoverDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest> {
    const posting = this.#requirePosting(postingRequestId);
    if (
      posting.state !== "WRITE_RESULT_UNKNOWN" ||
      posting.authoriseRequestId ||
      (posting.xeroInvoiceId && posting.xeroInvoiceId !== update.xeroInvoiceId)
    ) {
      throw new AppError("CONFLICT", "Posting request is not an unambiguous draft-write recovery.", {
        httpStatus: 409,
      });
    }
    const updated: PostingRequest = {
      ...posting,
      ...update,
      draftWriteReceipt: update.writeReceipt,
      draftReadbackSnapshot: update.readbackSnapshot,
      state: posting.documentType === "ACCREC" ? "DRAFT_READBACK_VERIFIED" : "APPROVAL_PENDING",
      updatedAt: new Date(),
    };
    this.#postings.set(postingRequestId, updated);
    return clone(updated);
  }

  async markDraftReadbackMismatch(
    postingRequestId: string,
    update: DraftReadbackMismatchUpdate,
  ): Promise<void> {
    const posting = this.#requirePosting(postingRequestId);
    if (
      (posting.state !== "VALIDATED" && posting.state !== "WRITE_RESULT_UNKNOWN") ||
      posting.authoriseRequestId ||
      (posting.xeroInvoiceId && posting.xeroInvoiceId !== update.xeroInvoiceId)
    ) {
      throw new AppError("CONFLICT", "Draft readback mismatch cannot overwrite the current posting state.", {
        httpStatus: 409,
      });
    }
    this.#postings.set(postingRequestId, {
      ...posting,
      xeroInvoiceId: update.xeroInvoiceId,
      writeReceipt: update.writeReceipt,
      readbackSnapshot: update.readbackSnapshot,
      draftWriteReceipt: update.writeReceipt,
      draftReadbackSnapshot: update.readbackSnapshot,
      state: "READBACK_MISMATCH",
      updatedAt: new Date(),
    });
  }

  async markDraftWriteUnknown(
    postingRequestId: string,
    xeroInvoiceId?: string,
    writeReceipt?: Record<string, unknown>,
  ): Promise<void> {
    const posting = this.#requirePosting(postingRequestId);
    if (posting.authoriseRequestId) {
      throw new AppError("CONFLICT", "Draft write uncertainty cannot overwrite an authorisation attempt.", {
        httpStatus: 409,
      });
    }
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") return;
    if (posting.state !== "VALIDATED" && posting.state !== "WRITE_RESULT_UNKNOWN") {
      throw new AppError("CONFLICT", `Draft write uncertainty cannot be recorded from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    if (xeroInvoiceId && posting.xeroInvoiceId && xeroInvoiceId !== posting.xeroInvoiceId) {
      throw new AppError("CONFLICT", "Draft write recovery cannot replace the known Xero InvoiceID.", {
        httpStatus: 409,
      });
    }
    if (
      writeReceipt && posting.writeReceipt &&
      stableStringify(writeReceipt) !== stableStringify(posting.writeReceipt)
    ) {
      throw new AppError("CONFLICT", "Draft write recovery cannot replace the known Provider receipt.", {
        httpStatus: 409,
      });
    }
    const updated: PostingRequest = {
      ...posting,
      state: "WRITE_RESULT_UNKNOWN",
      updatedAt: new Date(),
    };
    if (xeroInvoiceId) updated.xeroInvoiceId = xeroInvoiceId;
    if (writeReceipt) {
      updated.writeReceipt = clone(writeReceipt);
      updated.draftWriteReceipt = clone(writeReceipt);
    }
    this.#postings.set(postingRequestId, updated);
  }

  async markPostingState(postingRequestId: string, state: PostingState): Promise<void> {
    if (state !== "BLOCKED_VALIDATION" && state !== "READBACK_MISMATCH") {
      throw new AppError("CONFLICT", `${state} is not a draft failure state.`, { httpStatus: 409 });
    }
    const posting = this.#requirePosting(postingRequestId);
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") return;
    if (
      posting.state !== "VALIDATED" &&
      (posting.state !== "WRITE_RESULT_UNKNOWN" || posting.authoriseRequestId)
    ) {
      throw new AppError("CONFLICT", `Draft failure cannot be recorded from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    this.#postings.set(postingRequestId, { ...posting, state, updatedAt: new Date() });
  }

  async approvePosting(
    postingRequestId: string,
    approvedBy: string,
    approvalRefHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<PostingRequest> {
    const posting = this.#requirePosting(postingRequestId);
    if (posting.state === "APPROVED") {
      if (posting.approvedBy !== approvedBy || posting.approvalConsumedAt || !posting.approvalRefHash) {
        throw new AppError("CONFLICT", "Existing approval cannot be renewed by this reviewer.", { httpStatus: 409 });
      }
      const renewed: PostingRequest = {
        ...posting,
        approvalExpiresAt: posting.approvalExpiresAt && posting.approvalExpiresAt > expiresAt
          ? posting.approvalExpiresAt
          : expiresAt,
        updatedAt: now,
      };
      this.#postings.set(postingRequestId, renewed);
      return clone(renewed);
    }
    if (posting.state !== "APPROVAL_PENDING") {
      throw new AppError("CONFLICT", `Posting request cannot be approved from ${posting.state}.`, { httpStatus: 409 });
    }
    const updated: PostingRequest = {
      ...posting,
      state: "APPROVED",
      approvalRefHash,
      approvedBy,
      approvedAt: now,
      approvalExpiresAt: expiresAt,
      updatedAt: now,
    };
    this.#postings.set(postingRequestId, updated);
    return clone(updated);
  }

  async rejectPosting(postingRequestId: string, rejectedBy: string, now: Date): Promise<PostingRequest> {
    const posting = this.#requirePosting(postingRequestId);
    if (posting.state !== "APPROVAL_PENDING") {
      throw new AppError("CONFLICT", `Posting request cannot be rejected from ${posting.state}.`, { httpStatus: 409 });
    }
    const updated: PostingRequest = {
      ...posting,
      state: "REJECTED",
      approvedBy: rejectedBy,
      updatedAt: now,
    };
    this.#postings.set(postingRequestId, updated);
    return clone(updated);
  }

  async beginAuthorise(input: BeginAuthoriseInput): Promise<BeginAuthoriseResult> {
    const posting = this.#requirePosting(input.postingRequestId);
    this.#assertAuthoriseIdentity(posting, input);
    if (![
      "APPROVED",
      "AUTHORISING",
      "WRITE_RESULT_UNKNOWN",
      "AUTHORISED_READBACK_VERIFIED",
    ].includes(posting.state)) {
      throw new AppError("APPROVAL_REQUIRED", `Posting request is in ${posting.state}, not APPROVED.`, {
        httpStatus: 409,
      });
    }
    this.#assertApprovalBinding(posting, input);

    if (posting.state === "AUTHORISED_READBACK_VERIFIED") {
      if (posting.authoriseRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "The bill was already authorised by another request.", { httpStatus: 409 });
      }
      return { posting: clone(posting), mode: "ALREADY_COMPLETE" };
    }

    if (posting.state === "AUTHORISING" || posting.state === "WRITE_RESULT_UNKNOWN") {
      if (posting.authoriseRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "An authorisation attempt is already in progress.", { httpStatus: 409 });
      }
      return { posting: clone(posting), mode: "RESUME_READBACK_ONLY" };
    }

    if (
      !posting.approvalRefHash ||
      posting.approvalRefHash !== input.approvalRefHash ||
      posting.providerPayloadHash !== input.approvedPayloadHash ||
      !posting.approvalExpiresAt ||
      posting.approvalExpiresAt <= input.now ||
      posting.approvalConsumedAt
    ) {
      throw new AppError("APPROVAL_INVALID", "Approval is invalid, expired, consumed, or bound to another payload.", {
        httpStatus: 409,
      });
    }

    const updated: PostingRequest = {
      ...posting,
      state: "AUTHORISING",
      authoriseRequestId: input.requestId,
      authoriseIdempotencyKey: input.idempotencyKey,
      approvalConsumedAt: input.now,
      updatedAt: input.now,
    };
    this.#postings.set(input.postingRequestId, updated);
    return { posting: clone(updated), mode: "CALL_PROVIDER" };
  }

  async beginReviewAuthorise(input: BeginReviewAuthoriseInput): Promise<BeginAuthoriseResult> {
    const posting = this.#requirePosting(input.postingRequestId);
    this.#assertAuthoriseIdentity(posting, input);
    if (![
      "APPROVAL_PENDING",
      "APPROVED",
      "AUTHORISING",
      "WRITE_RESULT_UNKNOWN",
      "AUTHORISED_READBACK_VERIFIED",
    ].includes(posting.state)) {
      throw new AppError("APPROVAL_REQUIRED", `Posting request cannot be approved from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    if (posting.providerPayloadHash !== input.approvedPayloadHash) {
      throw new AppError("APPROVAL_INVALID", "Review approval is bound to another payload.", { httpStatus: 409 });
    }

    let mode: BeginAuthoriseResult["mode"];
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") {
      this.#assertReviewResumeBinding(posting, input);
      mode = "ALREADY_COMPLETE";
    } else if (posting.state === "AUTHORISING" || posting.state === "WRITE_RESULT_UNKNOWN") {
      this.#assertReviewResumeBinding(posting, input);
      mode = "RESUME_READBACK_ONLY";
    } else {
      if (posting.state === "APPROVED" && (
        posting.approvedBy !== input.actorId ||
        posting.approvalConsumedAt ||
        !posting.approvalRefHash ||
        !posting.approvalExpiresAt ||
        posting.approvalExpiresAt <= input.now
      )) {
        throw new AppError("APPROVAL_INVALID", "Existing approval cannot be resumed by this reviewer.", {
          httpStatus: 409,
        });
      }
      mode = "CALL_PROVIDER";
    }

    const csrf = this.#reviewCsrf.get(input.csrfHash);
    if (
      !csrf ||
      csrf.sessionHash !== input.sessionHash ||
      csrf.actorId !== input.actorId ||
      csrf.postingRequestId !== input.postingRequestId ||
      csrf.expiresAt <= input.now ||
      csrf.consumedAt
    ) {
      throw new AppError("FORBIDDEN", "Review CSRF token is invalid, expired, or already used.", { httpStatus: 403 });
    }
    csrf.consumedAt = input.now;

    if (mode !== "CALL_PROVIDER") return { posting: clone(posting), mode };
    const updated: PostingRequest = {
      ...posting,
      state: "AUTHORISING",
      authoriseRequestId: input.requestId,
      authoriseIdempotencyKey: input.idempotencyKey,
      approvalRefHash: posting.state === "APPROVED"
        ? posting.approvalRefHash as string
        : input.approvalRefHash,
      approvedBy: input.actorId,
      approvedAt: posting.approvedAt ?? input.now,
      approvalExpiresAt: input.approvalExpiresAt,
      approvalConsumedAt: input.now,
      updatedAt: input.now,
    };
    this.#postings.set(input.postingRequestId, updated);
    return { posting: clone(updated), mode };
  }

  async rejectPostingFromReview(input: RejectReviewInput): Promise<PostingRequest> {
    const posting = this.#requirePosting(input.postingRequestId);
    if (posting.actorId !== input.actorId) {
      throw new AppError("FORBIDDEN", "Posting request belongs to another actor.", { httpStatus: 403 });
    }
    if (posting.state !== "APPROVAL_PENDING") {
      throw new AppError("CONFLICT", `Posting request cannot be rejected from ${posting.state}.`, { httpStatus: 409 });
    }
    const csrf = this.#reviewCsrf.get(input.csrfHash);
    if (
      !csrf ||
      csrf.sessionHash !== input.sessionHash ||
      csrf.actorId !== input.actorId ||
      csrf.postingRequestId !== input.postingRequestId ||
      csrf.expiresAt <= input.now ||
      csrf.consumedAt
    ) {
      throw new AppError("FORBIDDEN", "Review CSRF token is invalid, expired, or already used.", { httpStatus: 403 });
    }
    csrf.consumedAt = input.now;
    const rejected: PostingRequest = {
      ...posting,
      state: "REJECTED",
      approvedBy: input.actorId,
      updatedAt: input.now,
    };
    this.#postings.set(input.postingRequestId, rejected);
    return clone(rejected);
  }

  async completeAuthorise(
    postingRequestId: string,
    writeReceipt: Record<string, unknown>,
    readbackSnapshot: Record<string, unknown>,
  ): Promise<PostingRequest> {
    const posting = this.#requirePosting(postingRequestId);
    const readbackInvoiceId = readbackSnapshot.invoiceId;
    if (typeof readbackInvoiceId !== "string" || posting.xeroInvoiceId !== readbackInvoiceId) {
      throw new AppError("READBACK_MISMATCH", "Authorisation readback does not match the posting Xero InvoiceID.", {
        httpStatus: 409,
      });
    }
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") {
      return clone(posting);
    }
    if (posting.state !== "AUTHORISING" && posting.state !== "WRITE_RESULT_UNKNOWN") {
      throw new AppError("CONFLICT", `Posting request cannot be completed from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    const updated: PostingRequest = {
      ...posting,
      state: "AUTHORISED_READBACK_VERIFIED",
      writeReceipt,
      readbackSnapshot,
      ...((posting.draftWriteReceipt ?? posting.writeReceipt)
        ? { draftWriteReceipt: posting.draftWriteReceipt ?? posting.writeReceipt }
        : {}),
      ...((posting.draftReadbackSnapshot ?? posting.readbackSnapshot)
        ? { draftReadbackSnapshot: posting.draftReadbackSnapshot ?? posting.readbackSnapshot }
        : {}),
      authoriseWriteReceipt: writeReceipt,
      authoriseReadbackSnapshot: readbackSnapshot,
      updatedAt: new Date(),
    };
    this.#postings.set(postingRequestId, updated);
    return clone(updated);
  }

  async markAuthoriseFailure(
    postingRequestId: string,
    state: "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION",
  ): Promise<void> {
    const posting = this.#requirePosting(postingRequestId);
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") return;
    if (posting.state !== "AUTHORISING" && posting.state !== "WRITE_RESULT_UNKNOWN") {
      throw new AppError("CONFLICT", `Authorisation failure cannot be recorded from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    this.#postings.set(postingRequestId, { ...posting, state, updatedAt: new Date() });
  }

  async createXeroMutationPreparation(
    input: CreateXeroMutationPreparationInput,
  ): Promise<XeroMutationPreparation> {
    if (this.#xeroMutationPreparations.has(input.preparationId)) {
      throw new AppError("CONFLICT", "Mutation preparation identifier already exists.", { httpStatus: 409 });
    }
    if (input.expiresAt <= input.now) {
      throw new AppError("VALIDATION_FAILED", "Mutation confirmation must expire after it is prepared.");
    }
    const preparation: XeroMutationPreparation = {
      ...input,
      state: "PREPARED",
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationPreparations.set(preparation.preparationId, clone(preparation));
    return clone(preparation);
  }

  async getXeroMutationPreparation(preparationId: string): Promise<XeroMutationPreparation | undefined> {
    const preparation = this.#xeroMutationPreparations.get(preparationId);
    return preparation ? clone(preparation) : undefined;
  }

  async confirmXeroMutationPreparation(
    input: ConfirmXeroMutationPreparationInput,
  ): Promise<ConfirmXeroMutationPreparationResult | undefined> {
    if ((input.expectedAuthoritySnapshotRevision === undefined) !==
        (input.expectedAuthoritySnapshotHash === undefined)) {
      throw new AppError("VALIDATION_FAILED", "Authority snapshot claim binding is incomplete.", { httpStatus: 422 });
    }
    if (input.expectedFirmGovernanceClaim && input.expectedAuthoritySnapshotRevision === undefined) {
      throw new AppError("VALIDATION_FAILED", "Firm-governance claim lacks its authority snapshot binding.", {
        httpStatus: 422,
      });
    }
    const receiptGovernanceClaim = input.authorizationReceipt.firmGovernanceClaim;
    if ((receiptGovernanceClaim === undefined) !== (input.expectedFirmGovernanceClaim === undefined) ||
        (input.expectedFirmGovernanceClaim !== undefined &&
          (stableStringify(receiptGovernanceClaim) !== stableStringify(input.expectedFirmGovernanceClaim) ||
            input.authorizationReceipt.actionId !== input.expectedFirmGovernanceClaim.actionId ||
            input.authorizationReceipt.delegationId !== input.expectedFirmGovernanceClaim.delegationId ||
            input.authorizationReceipt.delegationRevision !== input.expectedFirmGovernanceClaim.delegationRevision))) {
      throw new AppError("VALIDATION_FAILED", "Authorization receipt governance claim is inconsistent.", {
        httpStatus: 422,
      });
    }
    if (input.expectedAuthoritySnapshotRevision !== undefined &&
        (input.authorizationReceipt.authoritySnapshotRevision !== input.expectedAuthoritySnapshotRevision ||
          input.authorizationReceipt.authoritySnapshotHash !== input.expectedAuthoritySnapshotHash)) {
      throw new AppError("VALIDATION_FAILED", "Authorization receipt authority snapshot is inconsistent.", {
        httpStatus: 422,
      });
    }
    const preparation = this.#xeroMutationPreparations.get(input.preparationId);
    if (
      !preparation ||
      !sameMutationBinding(preparation, input) ||
      preparation.confirmationSummaryHash !== input.confirmationSummaryHash ||
      preparation.confirmationPhraseHash !== input.confirmationPhraseHash ||
      !sameJson(preparation.canonicalPayload, input.canonicalPayload)
    ) return undefined;

    const existingByPreparation = [...this.#xeroMutationRequests.values()].find(
      (request) => request.preparationId === input.preparationId,
    );
    if (preparation.state === "CONSUMED") {
      if (
        existingByPreparation &&
        existingByPreparation.mutationRequestId === input.mutationRequestId &&
        existingByPreparation.requestId === input.requestId &&
        sameMutationBinding(existingByPreparation, input) &&
        existingByPreparation.confirmationSummaryHash === input.confirmationSummaryHash &&
        sameJson(existingByPreparation.canonicalPayload, input.canonicalPayload)
      ) return { request: clone(existingByPreparation), created: false };
      return undefined;
    }
    if (preparation.state !== "PREPARED") return undefined;
    const repositoryNow = this.#statementTimestamp();
    if (input.expectedAuthoritySnapshotRevision !== undefined) {
      const authority = this.#ledgerAuthoritySnapshots.get("xero");
      if (
        !authority || authority.revision !== input.expectedAuthoritySnapshotRevision ||
        authority.snapshotHash !== input.expectedAuthoritySnapshotHash
      ) {
        throw new AppError("APPROVAL_INVALID", "Ledger authority changed before the provider-write claim.", {
          httpStatus: 409,
        });
      }
      if (input.expectedFirmGovernanceClaim) {
        const storedAuthority = exactFirmGovernanceAuthorityFromSnapshot(
          authority,
          input.expectedFirmGovernanceClaim,
        );
        if (!storedAuthority) {
          throw new AppError("APPROVAL_INVALID", "Firm-governance authority changed before the provider-write claim.", {
            httpStatus: 409,
          });
        }
        if (storedAuthority.effectiveExpiresAt <= repositoryNow) {
          throw new AppError("APPROVAL_INVALID", "Firm-governance authority expired before the provider-write claim.", {
            httpStatus: 409,
          });
        }
      }
    }
    const targetSession = preparation.targetSessionId
      ? [...this.#ledgerTargetSessions.values()].find((session) =>
          session.sessionId === preparation.targetSessionId &&
          session.installationId === preparation.installationId &&
          session.bindingId === preparation.bindingId &&
          session.connectionId === preparation.connectionId &&
          session.bindingRevision === preparation.bindingRevision)
      : undefined;
    const accountingCaseAggregate = preparation.sourceRef?.startsWith("case:")
      ? this.#accountingCases.get(preparation.sourceRef.slice("case:".length))
      : undefined;
    const caseTargetExpiresAt = accountingCaseAggregate?.binding.targetSessionExpiresAt;
    const targetLeaseExpiresAt = targetSession?.expiresAt ?? caseTargetExpiresAt;
    const targetRevoked = targetSession?.revokedAt !== undefined;
    if (preparation.expiresAt <= repositoryNow ||
        (preparation.targetSessionId && (targetSession !== undefined || accountingCaseAggregate !== undefined) &&
          (targetRevoked || !targetLeaseExpiresAt || targetLeaseExpiresAt <= repositoryNow))) {
      this.#xeroMutationPreparations.set(input.preparationId, {
        ...preparation,
        state: "EXPIRED",
        updatedAt: new Date(Math.max(preparation.updatedAt.getTime(), repositoryNow.getTime())),
      });
      return undefined;
    }

    const requestKey = this.#xeroMutationRequestKey(input);
    const existingRequestId = this.#xeroMutationRequestKeys.get(requestKey);
    if (existingRequestId) return undefined;
    const sourceDuplicate = [...this.#xeroMutationRequests.values()].find((request) => {
      if (
        request.tenantId !== input.tenantId ||
        request.objectType !== input.objectType ||
        request.operation !== input.operation ||
        request.sourceUnitKey !== input.sourceUnitKey ||
        !ACTIVE_XERO_MUTATION_SOURCE_STATES.has(request.state)
      ) return false;
      const sameContentIdentity = request.sourceSha256 === input.sourceSha256;
      const sameOpaqueSourceUnit = Boolean(input.sourceRef) && request.sourceRef === input.sourceRef;
      return sameContentIdentity || sameOpaqueSourceUnit;
    });
    if (sourceDuplicate) {
      throw new AppError("CONFLICT", "This source already has an active Xero mutation.", { httpStatus: 409 });
    }
    if (XERO_MUTATION_CREATE_OPERATIONS.has(input.operation)) {
      const businessPayload = xeroMutationBusinessPayload(input.canonicalPayload);
      const businessDuplicate = [...this.#xeroMutationRequests.values()].find((request) =>
        request.tenantId === input.tenantId &&
        request.objectType === input.objectType &&
        request.operation === input.operation &&
        ACTIVE_XERO_MUTATION_SOURCE_STATES.has(request.state) &&
        sameJson(xeroMutationBusinessPayload(request.canonicalPayload), businessPayload));
      if (businessDuplicate) {
        throw new AppError("CONFLICT", "This provider business payload already has an active Xero mutation.", {
          httpStatus: 409,
          details: { duplicateMutationRequestId: businessDuplicate.mutationRequestId },
        });
      }
      if (input.objectType === "CONTACT" && input.operation === "CREATE") {
        const companyNumber = normalizedNestedBusinessValue(input.canonicalPayload, "target", "companyNumber");
        const accountNumber = normalizedNestedBusinessValue(input.canonicalPayload, "target", "accountNumber");
        const strongIdentityDuplicate = [...this.#xeroMutationRequests.values()].find((request) =>
          request.tenantId === input.tenantId && request.objectType === "CONTACT" &&
          request.operation === "CREATE" && ACTIVE_XERO_MUTATION_SOURCE_STATES.has(request.state) &&
          ((companyNumber && normalizedNestedBusinessValue(request.canonicalPayload, "target", "companyNumber") === companyNumber) ||
           (accountNumber && normalizedNestedBusinessValue(request.canonicalPayload, "target", "accountNumber") === accountNumber)));
        if (strongIdentityDuplicate) {
          throw new AppError("CONFLICT", "This strong contact business identity already has an active Xero mutation.", {
            httpStatus: 409,
            details: { duplicateMutationRequestId: strongIdentityDuplicate.mutationRequestId },
          });
        }
      }
    }

    const request: XeroMutationRequest = {
      mutationRequestId: input.mutationRequestId,
      preparationId: input.preparationId,
      requestId: input.requestId,
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      installationId: input.installationId,
      bindingId: input.bindingId,
      connectionId: input.connectionId,
      ...(input.bindingRevision !== undefined ? { bindingRevision: input.bindingRevision } : {}),
      ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
      objectType: input.objectType,
      operation: input.operation,
      ...(input.targetXeroObjectId ? { targetXeroObjectId: input.targetXeroObjectId } : {}),
      canonicalPayload: clone(input.canonicalPayload),
      canonicalPayloadHash: input.canonicalPayloadHash,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256: input.sourceSha256,
      sourceEvidenceType: input.sourceEvidenceType,
      confirmationSummaryHash: input.confirmationSummaryHash,
      authorizationReceipt: clone(input.authorizationReceipt),
      ...(input.successfulValidationReceipt
        ? { validationReceipt: clone(input.successfulValidationReceipt) }
        : {}),
      state: input.claimForWrite ? "WRITE_IN_FLIGHT" : "CONFIRMED",
      confirmedAt: input.now,
      ...(input.claimForWrite ? { writeStartedAt: input.now } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(request));
    this.#xeroMutationRequestKeys.set(requestKey, request.mutationRequestId);
    this.#xeroMutationPreparations.set(preparation.preparationId, {
      ...preparation,
      state: "CONSUMED",
      consumedAt: input.now,
      updatedAt: input.now,
    });
    return { request: clone(request), created: true };
  }

  async getXeroMutationRequest(mutationRequestId: string): Promise<XeroMutationRequest | undefined> {
    const request = this.#xeroMutationRequests.get(mutationRequestId);
    return request ? clone(request) : undefined;
  }

  async beginXeroMutationWrite(input: BeginXeroMutationWriteInput): Promise<BeginXeroMutationWriteResult> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (request.state === "READBACK_VERIFIED") {
      return { request: clone(request), mode: "ALREADY_VERIFIED" };
    }
    if (["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
      return { request: clone(request), mode: "RECOVER_ONLY" };
    }
    if (request.state !== "CONFIRMED") {
      throw new AppError("CONFLICT", `Mutation cannot start from ${request.state}.`, { httpStatus: 409 });
    }
    const targetXeroObjectId = request.operation === "UPDATE" ? request.targetXeroObjectId : undefined;
    if (request.operation === "UPDATE" && !targetXeroObjectId) {
      throw new AppError("CONFLICT", "UPDATE mutation has no immutable Xero target identifier.", { httpStatus: 409 });
    }
    if (targetXeroObjectId) this.#assertXeroMutationObjectIdAvailable(request, targetXeroObjectId);
    const updated: XeroMutationRequest = {
      ...request,
      ...(targetXeroObjectId ? { xeroObjectId: targetXeroObjectId } : {}),
      state: "WRITE_IN_FLIGHT",
      writeStartedAt: input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return { request: clone(updated), mode: "CALL_PROVIDER" };
  }

  async recordXeroMutationWriteEvidence(
    input: RecordXeroMutationWriteEvidenceInput,
  ): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    const nativeRecoveryReplay = request.state === "WRITE_UNCERTAIN" &&
      request.nativeRecoveryClaim !== undefined &&
      request.xeroObjectId === undefined;
    if (request.state !== "WRITE_IN_FLIGHT" && !nativeRecoveryReplay) {
      throw new AppError("CONFLICT", `Mutation write evidence cannot be recorded from ${request.state}.`, {
        httpStatus: 409,
      });
    }
    this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
    this.#assertXeroMutationObjectIdAvailable(request, input.xeroObjectId);
    const updated: XeroMutationRequest = {
      ...request,
      xeroObjectId: input.xeroObjectId,
      writeReceipt: clone(input.writeReceipt),
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  async markXeroMutationWriteUnknown(
    input: MarkXeroMutationWriteUnknownInput & {
      nativeRecoveryClaim?: XeroNativeIdempotencyRecoveryClaim;
    },
  ): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    const nativeRecoveryClaim = input.nativeRecoveryClaim;
    if (request.state !== "WRITE_IN_FLIGHT" && request.state !== "WRITE_UNCERTAIN") {
      throw new AppError("CONFLICT", `Mutation uncertainty cannot be recorded from ${request.state}.`, {
        httpStatus: 409,
      });
    }
    if (nativeRecoveryClaim && (
      request.state !== "WRITE_UNCERTAIN" ||
      request.xeroObjectId !== undefined ||
      request.nativeRecoveryClaim !== undefined
    )) {
      throw new AppError("CONFLICT", "Native idempotency recovery was already claimed or is not uncertain.", {
        httpStatus: 409,
      });
    }
    if (nativeRecoveryClaim && (
      nativeRecoveryClaim.mutationRequestId !== request.mutationRequestId ||
      nativeRecoveryClaim.canonicalPayloadHash !== request.canonicalPayloadHash ||
      nativeRecoveryClaim.tenantId !== request.tenantId ||
      nativeRecoveryClaim.actorId !== request.actorId ||
      nativeRecoveryClaim.workspaceId !== request.workspaceId ||
      nativeRecoveryClaim.installationId !== request.installationId ||
      nativeRecoveryClaim.bindingId !== request.bindingId ||
      nativeRecoveryClaim.bindingRevision !== request.bindingRevision ||
      nativeRecoveryClaim.connectionId !== request.connectionId ||
      nativeRecoveryClaim.targetSessionId !== request.targetSessionId ||
      nativeRecoveryClaim.agentId !== request.authorizationReceipt.agentId
    )) {
      throw new AppError("FORBIDDEN", "Native idempotency recovery claim does not match its durable authority.", {
        httpStatus: 403,
      });
    }
    if (nativeRecoveryClaim) {
      const expectedAdapter = XERO_NATIVE_RECOVERY_ADAPTER_BY_ACTION[
        nativeRecoveryClaim.actionId as keyof typeof XERO_NATIVE_RECOVERY_ADAPTER_BY_ACTION
      ];
      const authority = request.authorizationReceipt;
      const expectedExpiry = request.writeStartedAt
        ? new Date(request.writeStartedAt.getTime() + XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS).toISOString()
        : undefined;
      const claimedAt = new Date(nativeRecoveryClaim.claimedAt);
      const expiresAt = new Date(nativeRecoveryClaim.expiresAt);
      if (
        nativeRecoveryClaim.receiptType !== "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM" ||
        nativeRecoveryClaim.claimId.trim().length === 0 ||
        !Number.isSafeInteger(nativeRecoveryClaim.bindingRevision) ||
        nativeRecoveryClaim.bindingRevision < 1 ||
        !Number.isSafeInteger(nativeRecoveryClaim.authoritySnapshotRevision) ||
        nativeRecoveryClaim.authoritySnapshotRevision < 1 ||
        !/^[a-f0-9]{64}$/u.test(nativeRecoveryClaim.canonicalPayloadHash) ||
        !/^[a-f0-9]{64}$/u.test(nativeRecoveryClaim.authoritySnapshotHash) ||
        !Number.isFinite(claimedAt.getTime()) ||
        !Number.isFinite(expiresAt.getTime()) ||
        request.operation !== "CREATE_DRAFT" ||
        !expectedAdapter ||
        nativeRecoveryClaim.adapterOperation !== expectedAdapter ||
        nativeRecoveryClaim.actionId !== authority.actionId ||
        nativeRecoveryClaim.authoritySnapshotRevision !== authority.authoritySnapshotRevision ||
        nativeRecoveryClaim.authoritySnapshotHash !== authority.authoritySnapshotHash ||
        nativeRecoveryClaim.claimedAt !== input.now.toISOString() ||
        nativeRecoveryClaim.expiresAt !== expectedExpiry ||
        !request.writeStartedAt ||
        input.now < request.writeStartedAt ||
        input.now >= expiresAt
      ) {
        throw new AppError("CONFLICT", "Native idempotency recovery claim window or authority is invalid.", {
          httpStatus: 409,
        });
      }
    }
    this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
    if (input.xeroObjectId) this.#assertXeroMutationObjectIdAvailable(request, input.xeroObjectId);
    const updated: XeroMutationRequest = {
      ...request,
      ...(input.xeroObjectId ? { xeroObjectId: input.xeroObjectId } : {}),
      ...(input.writeReceipt ? { writeReceipt: clone(input.writeReceipt) } : {}),
      ...(nativeRecoveryClaim ? {
        nativeRecoveryClaim: clone(nativeRecoveryClaim) as unknown as Record<string, unknown>,
      } : {}),
      state: "WRITE_UNCERTAIN",
      writeUnknownAt: request.writeUnknownAt ?? input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  async markXeroMutationReadbackVerified(
    input: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (
      input.readbackPayloadHash !== request.canonicalPayloadHash ||
      input.readbackStatus !== XERO_MUTATION_EXPECTED_READBACK_STATUS[request.objectType]
    ) {
      throw new AppError("READBACK_MISMATCH", "Verified readback hash does not match the confirmed payload.", {
        httpStatus: 409,
      });
    }
    if (!request.xeroObjectId || !request.writeReceipt) {
      throw new AppError("CONFLICT", "Mutation write evidence must be persisted before readback completion.", {
        httpStatus: 409,
      });
    }
    if (request.state === "READBACK_VERIFIED") {
      this.#assertExactCompletedMutation(request, input);
      return clone(request);
    }
    if (!["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
      throw new AppError("CONFLICT", `Mutation readback cannot complete from ${request.state}.`, { httpStatus: 409 });
    }
    this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
    this.#assertXeroMutationObjectIdAvailable(request, input.xeroObjectId);
    const updated: XeroMutationRequest = {
      ...request,
      xeroObjectId: input.xeroObjectId,
      writeReceipt: clone(input.writeReceipt),
      readbackSnapshot: clone(input.readbackSnapshot),
      readbackSnapshotHash: input.readbackSnapshotHash,
      readbackCanonicalPayload: clone(input.readbackCanonicalPayload),
      readbackPayloadHash: input.readbackPayloadHash,
      readbackStatus: input.readbackStatus,
      state: "READBACK_VERIFIED",
      verifiedAt: input.now,
      updatedAt: input.now,
    };
    delete updated.readbackMismatchReceipt;
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  async markXeroMutationReadbackMismatch(
    input: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (
      input.readbackPayloadHash === request.canonicalPayloadHash &&
      input.readbackStatus === XERO_MUTATION_EXPECTED_READBACK_STATUS[request.objectType]
    ) {
      throw new AppError("CONFLICT", "Matching readback cannot be recorded as a mismatch.", { httpStatus: 409 });
    }
    if (!request.xeroObjectId || !request.writeReceipt) {
      throw new AppError("CONFLICT", "Mutation write evidence must be persisted before readback completion.", {
        httpStatus: 409,
      });
    }
    if (!["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
      throw new AppError("CONFLICT", `Mutation mismatch cannot be recorded from ${request.state}.`, { httpStatus: 409 });
    }
    this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
    this.#assertXeroMutationObjectIdAvailable(request, input.xeroObjectId);
    if (request.state === "READBACK_MISMATCH") {
      this.#assertExactMismatchEvidence(request, input);
      return clone(request);
    }
    const updated: XeroMutationRequest = {
      ...request,
      xeroObjectId: input.xeroObjectId,
      writeReceipt: clone(input.writeReceipt),
      readbackSnapshot: clone(input.readbackSnapshot),
      readbackSnapshotHash: input.readbackSnapshotHash,
      readbackCanonicalPayload: clone(input.readbackCanonicalPayload),
      readbackPayloadHash: input.readbackPayloadHash,
      readbackStatus: input.readbackStatus,
      readbackMismatchReceipt: {
        receiptType: "XERO_READBACK_MISMATCH",
        mismatchType: "PAYLOAD_OR_STATUS",
        reasonCodes: [
          ...(input.readbackPayloadHash !== request.canonicalPayloadHash
            ? ["CANONICAL_PAYLOAD_HASH_MISMATCH"]
            : []),
          ...(input.readbackStatus !== XERO_MUTATION_EXPECTED_READBACK_STATUS[request.objectType]
            ? ["READBACK_STATUS_MISMATCH"]
            : []),
        ],
      },
      state: "READBACK_MISMATCH",
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  async failXeroMutationValidation(input: FailXeroMutationValidationInput): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (request.state === "FAILED_VALIDATION") {
      if (!sameOptionalJson(request.validationReceipt, input.validationReceipt)) {
        throw new AppError("CONFLICT", "Validation failure evidence cannot be replaced.", { httpStatus: 409 });
      }
      return clone(request);
    }
    if (request.state !== "CONFIRMED") {
      throw new AppError("CONFLICT", `Mutation validation cannot fail from ${request.state}.`, { httpStatus: 409 });
    }
    const updated: XeroMutationRequest = {
      ...request,
      ...(input.validationReceipt ? { validationReceipt: clone(input.validationReceipt) } : {}),
      state: "FAILED_VALIDATION",
      validationFailedAt: input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  async rejectXeroMutationProvider(input: RejectXeroMutationProviderInput): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (request.state === "PROVIDER_REJECTED") {
      if (!sameOptionalJson(request.providerRejectionReceipt, input.providerRejectionReceipt)) {
        throw new AppError("CONFLICT", "Provider rejection evidence cannot be replaced.", { httpStatus: 409 });
      }
      return clone(request);
    }
    if (request.state !== "WRITE_IN_FLIGHT") {
      throw new AppError("CONFLICT", `Provider rejection cannot be recorded from ${request.state}.`, {
        httpStatus: 409,
      });
    }
    const updated: XeroMutationRequest = {
      ...request,
      providerRejectionReceipt: clone(input.providerRejectionReceipt),
      state: "PROVIDER_REJECTED",
      providerRejectedAt: input.now,
      updatedAt: input.now,
    };
    this.#xeroMutationRequests.set(request.mutationRequestId, clone(updated));
    return clone(updated);
  }

  #abandonExpiredPreparedContactReservations(
    input: CreateOrAdvanceAccountingCaseInput,
  ): () => void {
    const repositoryNow = this.#statementTimestamp();
    const aggregateSnapshots = new Map<string, InMemoryAccountingCaseAggregate>();
    const preparationSnapshots = new Map<string, XeroMutationPreparation>();
    const snapshotAggregate = (caseId: string, aggregate: InMemoryAccountingCaseAggregate) => {
      if (!aggregateSnapshots.has(caseId)) aggregateSnapshots.set(caseId, clone(aggregate));
    };
    const snapshotPreparation = (preparation: XeroMutationPreparation) => {
      if (!preparationSnapshots.has(preparation.preparationId)) {
        preparationSnapshots.set(preparation.preparationId, clone(preparation));
      }
    };

    const successorContactOperations = input.compiled.operations
      .filter((operation) => operation.actionId === "contact.create_basic")
      .sort((left, right) =>
        left.businessReservation.coordinateHash.localeCompare(right.businessReservation.coordinateHash));
    for (const successorOperation of successorContactOperations) {
      for (const [caseId, aggregate] of this.#accountingCases) {
        if (aggregate.binding.tenantId !== input.binding.tenantId) continue;
        for (const [version, candidateVersion] of aggregate.versions) {
          const candidate = candidateVersion.operations.find((operation) =>
            operation.operation.actionId === "contact.create_basic" &&
            operation.state === "PREPARED" &&
            accountingCaseBusinessReservationsOverlap(
              operation.operation.businessReservation,
              successorOperation.businessReservation,
            ) && !(
              candidateVersion.compiled.caseId === input.compiled.caseId &&
              candidateVersion.compiled.version === input.compiled.version &&
              operation.operation.operationId === successorOperation.operationId
            ));
          if (!candidate?.preparationId) continue;
          const triggerPreparation = this.#xeroMutationPreparations.get(candidate.preparationId);
          if (!triggerPreparation || !["PREPARED", "EXPIRED"].includes(triggerPreparation.state)) continue;
          const targetSession = this.#ledgerTargetSessions.get(aggregate.binding.targetSessionHash);
          const targetLeaseUnavailable = targetSession
            ? targetSession.revokedAt !== undefined || targetSession.expiresAt <= repositoryNow ||
              targetSession.sessionId !== aggregate.binding.targetSessionId ||
              targetSession.installationId !== aggregate.binding.installationId ||
              targetSession.bindingId !== aggregate.binding.bindingId ||
              targetSession.connectionId !== aggregate.binding.connectionId ||
              targetSession.bindingRevision !== aggregate.binding.bindingRevision ||
              targetSession.expiresAt.getTime() !== aggregate.binding.targetSessionExpiresAt.getTime()
            : true;
          const reservationExpired = triggerPreparation.expiresAt <= repositoryNow ||
            targetLeaseUnavailable;
          if (!reservationExpired ||
              !["PREFLIGHTED", "READY_TO_RESUME", "EXECUTING"].includes(candidateVersion.state) ||
              !candidateVersion.preflightRequestId) continue;
          const preflightRequestId = candidateVersion.preflightRequestId;

          const preparedOperations = candidateVersion.operations.filter((operation) => operation.state === "PREPARED");
          const unsafeState = candidateVersion.operations.some((operation) =>
            operation.state !== "PREPARED" && operation.state !== "NO_WRITE_REQUIRED");
          const preparations = preparedOperations.map((operation) => operation.preparationId
            ? this.#xeroMutationPreparations.get(operation.preparationId)
            : undefined);
          const hasDurableRequest = preparedOperations.some((operation) =>
            operation.preparationId && [...this.#xeroMutationRequests.values()].some(
              (request) => request.preparationId === operation.preparationId,
            ));
          const hasWriteEvidence = preparedOperations.some((operation) =>
            operation.mutationRequestId !== undefined || operation.xeroObjectId !== undefined ||
            operation.writeReceipt !== undefined || operation.readbackSnapshot !== undefined ||
            operation.errorReceipt !== undefined);
          if (unsafeState || hasDurableRequest || hasWriteEvidence ||
              preparations.some((preparation) =>
                !preparation || !["PREPARED", "EXPIRED"].includes(preparation.state))) continue;

          snapshotAggregate(caseId, aggregate);
          for (const preparation of preparations) {
            if (!preparation) continue;
            snapshotPreparation(preparation);
            this.#xeroMutationPreparations.set(preparation.preparationId, {
              ...preparation,
              state: "EXPIRED",
              updatedAt: new Date(Math.max(preparation.updatedAt.getTime(), repositoryNow.getTime())),
            });
          }

          const executing: AccountingCaseVersionRecord = ["PREFLIGHTED", "READY_TO_RESUME"].includes(candidateVersion.state)
            ? {
                ...candidateVersion,
                state: "EXECUTING",
                executionRequestId: preflightRequestId,
                executionStartedAt: new Date(Math.max(candidateVersion.createdAt.getTime(), repositoryNow.getTime())),
                updatedAt: new Date(Math.max(candidateVersion.updatedAt.getTime(), repositoryNow.getTime())),
              }
            : candidateVersion;
          const closedOperations = executing.operations.map((operation) => {
            if (operation.state !== "PREPARED" || !operation.preparationId) return operation;
            const preparation = preparations.find((value) => value?.preparationId === operation.preparationId);
            if (!preparation) throw new AppError("PERSISTENCE_FAILURE", "Prepared operation lost its mutation preparation.");
            return {
              ...operation,
              state: "BLOCKED_VALIDATION" as const,
              errorReceipt: {
                receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
                receiptVersion: 1,
                disposition: "ABANDONED",
                reasonCode: "EXPIRED_PREPARATION_OR_TARGET_LEASE",
                caseId: executing.compiled.caseId,
                caseVersion: executing.compiled.version,
                operationId: operation.operation.operationId,
                preparationId: operation.preparationId,
                abandonmentTriggerPreparationId: candidate.preparationId,
                successorCaseId: input.compiled.caseId,
                successorCaseVersion: input.compiled.version,
                successorOperationId: successorOperation.operationId,
                preparationExpiresAt: preparation.expiresAt.toISOString(),
                targetSessionExpiresAt: aggregate.binding.targetSessionExpiresAt.toISOString(),
                ...(targetSession?.revokedAt
                  ? { targetSessionRevokedAt: targetSession.revokedAt.toISOString() }
                  : {}),
                abandonedAt: repositoryNow.toISOString(),
                mutationRequestAbsent: true,
                writeClaimAbsent: true,
                providerPermitAbsentByDurableClaimInvariant: true,
                providerCallAbsentByPermitInvariant: true,
                writeReceiptAbsent: true,
                readbackReceiptAbsent: true,
              },
              updatedAt: new Date(Math.max(operation.updatedAt.getTime(), repositoryNow.getTime())),
            };
          });
          const terminalState = closedOperations.some((operation) => operation.state === "NO_WRITE_REQUIRED")
            ? "PARTIALLY_COMMITTED" as const
            : "TERMINAL" as const;
          const closed: AccountingCaseVersionRecord = {
            ...executing,
            state: terminalState,
            operations: closedOperations,
            updatedAt: new Date(Math.max(executing.updatedAt.getTime(), repositoryNow.getTime())),
          };
          closed.terminalSummary = accountingCaseTerminalSummary(closed, terminalState);
          aggregate.versions.set(version, clone(closed));
        }
      }
    }

    return () => {
      for (const [caseId, snapshot] of aggregateSnapshots) this.#accountingCases.set(caseId, clone(snapshot));
      for (const [preparationId, snapshot] of preparationSnapshots) {
        this.#xeroMutationPreparations.set(preparationId, clone(snapshot));
      }
    };
  }

  #assertNoPendingContactReservationConflict(
    input: CreateOrAdvanceAccountingCaseInput,
    repositoryNow = this.#statementTimestamp(),
  ): void {
    for (const operation of input.compiled.operations) {
      if (operation.actionId !== "contact.create_basic") continue;
      for (const aggregate of this.#accountingCases.values()) {
        if (aggregate.binding.tenantId !== input.binding.tenantId) continue;
        for (const candidateVersion of aggregate.versions.values()) {
          for (const candidate of candidateVersion.operations) {
            if (
              candidate.operation.actionId !== "contact.create_basic" ||
              !accountingCaseBusinessReservationsOverlap(
                candidate.operation.businessReservation,
                operation.businessReservation,
              )
            ) continue;
            const pendingLeaseIsActive = candidate.state === "PENDING" &&
              candidateVersion.compiled.version === aggregate.currentVersion &&
              aggregate.binding.targetSessionExpiresAt > repositoryNow;
            const permanentClaimIsActive = ACCOUNTING_CASE_BUSINESS_RESERVATION_STATES.has(candidate.state);
            const recoveryGrant = this.#activeRecoveryResidualGrant(
              candidateVersion,
              candidate,
              repositoryNow,
            );
            const recoveryClaimIsActive = recoveryGrant !== undefined;
            if (!pendingLeaseIsActive && !permanentClaimIsActive && !recoveryClaimIsActive) continue;
            if (recoveryGrant?.successorCaseId === input.compiled.caseId) continue;
            const transfersCurrentPendingClaim =
              candidate.state === "PENDING" &&
              candidateVersion.compiled.caseId === input.compiled.caseId &&
              candidateVersion.compiled.version + 1 === input.compiled.version;
            if (transfersCurrentPendingClaim) continue;
            throw new AppError(
              "CONFLICT",
              "This tenant already has an active provider bare-number claim for another contact plan.",
              {
                httpStatus: 409,
                details: {
                  reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"],
                  duplicateCaseId: candidateVersion.compiled.caseId,
                  duplicateCaseVersion: candidateVersion.compiled.version,
                  duplicateOperationId: candidate.operation.operationId,
                  providerMutationPossible: false,
                },
              },
            );
          }
        }
      }
    }
  }

  #assertNoPendingNativeDocumentReservationConflict(
    input: CreateOrAdvanceAccountingCaseInput,
    repositoryNow = this.#statementTimestamp(),
  ): void {
    for (const operation of input.compiled.operations) {
      if (operation.actionId === "contact.create_basic") continue;
      for (const aggregate of this.#accountingCases.values()) {
        if (aggregate.binding.tenantId !== input.binding.tenantId) continue;
        for (const candidateVersion of aggregate.versions.values()) {
          for (const candidate of candidateVersion.operations) {
            if (
              candidate.operation.actionId !== operation.actionId ||
              !accountingCaseBusinessReservationsOverlap(
                candidate.operation.businessReservation,
                operation.businessReservation,
              )
            ) continue;
            const pendingLeaseIsActive = candidate.state === "PENDING" &&
              candidateVersion.compiled.version === aggregate.currentVersion &&
              aggregate.binding.targetSessionExpiresAt > repositoryNow;
            const permanentClaimIsActive = ACCOUNTING_CASE_BUSINESS_RESERVATION_STATES.has(candidate.state);
            const recoveryGrant = this.#activeRecoveryResidualGrant(
              candidateVersion,
              candidate,
              repositoryNow,
            );
            if (!pendingLeaseIsActive && !permanentClaimIsActive && !recoveryGrant) continue;
            if (recoveryGrant?.successorCaseId === input.compiled.caseId) continue;
            const transfersCurrentPendingClaim =
              candidate.state === "PENDING" &&
              candidateVersion.compiled.caseId === input.compiled.caseId &&
              candidateVersion.compiled.version + 1 === input.compiled.version;
            if (transfersCurrentPendingClaim) continue;
            throw new AppError(
              "CONFLICT",
              "This tenant already has an active Accounting Case claim for the provider business coordinate.",
              {
                httpStatus: 409,
                details: {
                  reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
                  duplicateCaseId: candidateVersion.compiled.caseId,
                  duplicateCaseVersion: candidateVersion.compiled.version,
                  duplicateOperationId: candidate.operation.operationId,
                  providerMutationPossible: false,
                },
              },
            );
          }
        }
      }
    }
  }

  #activeRecoveryResidualGrant(
    source: AccountingCaseVersionRecord,
    operation: AccountingCaseOperationRecord,
    repositoryNow: Date,
  ): AccountingCaseRecoveryResidualGrant | undefined {
    if (operation.state !== "NOT_EXECUTED_AFTER_TARGET_EXPIRY") return undefined;
    const grant = [...this.#accountingCaseRecoveryResidualGrants.values()].find((candidate) =>
      candidate.sourceCaseId === source.compiled.caseId &&
      candidate.sourceVersion === source.compiled.version &&
      candidate.residualOperationIds.includes(operation.operation.operationId) &&
      (candidate.state === "ISSUED" || candidate.state === "CONSUMED"));
    return grant && this.#isLiveAccountingCaseTarget(grant.successorBinding, repositoryNow)
      ? grant
      : undefined;
  }

  async createOrAdvanceAccountingCase(
    input: CreateOrAdvanceAccountingCaseInput,
  ): Promise<CreateOrAdvanceAccountingCaseResult> {
    if (
      input.compiled.caseId.length === 0 ||
      input.compiled.providerId !== "xero" ||
      input.compiled.target.tenantId !== input.binding.tenantId ||
      input.compiled.operations.some((operation) =>
        operation.businessIdentityHash !== hashObject(operation.businessIdentity) ||
        operation.businessReservation.coordinateHash !== hashObject({
          schemaVersion: operation.businessReservation.schemaVersion,
          providerId: operation.businessReservation.providerId,
          kind: operation.businessReservation.kind,
          canonicalFields: operation.businessReservation.canonicalFields,
        })) ||
      input.compiledPlanHash !== accountingCasePlanHash(input.binding, input.compiled)
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case identity or plan hash is invalid.", {
        httpStatus: 422,
      });
    }
    if (input.continuationAuthorization && input.recoveryResidualAuthorization) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case continuation modes are mutually exclusive.", {
        httpStatus: 422,
      });
    }
    const reservedRecoveryGrant = this.#accountingCaseRecoveryResidualGrants.get(input.compiled.caseId);
    const recoveryAuthorization = input.recoveryResidualAuthorization;
    if (reservedRecoveryGrant && !recoveryAuthorization) {
      throw new AppError("CONFLICT", "This recovery successor Case requires its server-issued continuation token.", {
        httpStatus: 409,
      });
    }
    let recoveryGrant: AccountingCaseRecoveryResidualGrant | undefined;
    if (recoveryAuthorization) {
      const repositoryNow = this.#statementTimestamp();
      recoveryGrant = this.#accountingCaseRecoveryResidualGrants.get(recoveryAuthorization.successorCaseId);
      if (
        !recoveryGrant ||
        recoveryGrant.grantId !== recoveryAuthorization.grantId ||
        recoveryGrant.sourceCaseId !== recoveryAuthorization.sourceCaseId ||
        recoveryGrant.sourceVersion !== recoveryAuthorization.sourceVersion ||
        recoveryGrant.successorCaseId !== recoveryAuthorization.successorCaseId ||
        recoveryGrant.templateHash !== recoveryAuthorization.templateHash ||
        recoveryGrant.successorCaseId !== input.compiled.caseId ||
        !sameAccountingCaseBinding(recoveryGrant.successorBinding, input.binding) ||
        !this.#isLiveAccountingCaseTarget(input.binding, repositoryNow) ||
        !matchesAccountingCaseRecoveryResidualAuthorization({
          candidate: input.compiled,
          successorCaseId: recoveryGrant.successorCaseId,
          templateHash: recoveryGrant.templateHash,
        })
      ) {
        throw new AppError("CONFLICT", "Accounting Case recovery successor authorization is invalid.", {
          httpStatus: 409,
        });
      }
    }
    const rollbackAbandonment = this.#abandonExpiredPreparedContactReservations(input);
    try {
      const existing = this.#accountingCases.get(input.compiled.caseId);
      if (existing) {
      if (!sameAccountingCaseBinding(existing.binding, input.binding)) {
        throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      }
      const current = existing.versions.get(existing.currentVersion);
      if (!current) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case head is incomplete.", { httpStatus: 503 });
      if (
        input.compiled.version === existing.currentVersion &&
        input.compiledPlanHash === current.compiledPlanHash
      ) {
        if (recoveryGrant && (
          recoveryGrant.state !== "CONSUMED" ||
          recoveryGrant.consumedPlanHash !== input.compiledPlanHash
        )) {
          throw new AppError("CONFLICT", "Accounting Case recovery successor grant was not consumed by this plan.", {
            httpStatus: 409,
          });
        }
        const continuationSource = existing.versions.get(input.compiled.version - 1);
        if (
          (continuationSource?.state === "AWAITING_CONTINUATION" || input.continuationAuthorization) &&
          (
            continuationSource?.state !== "AWAITING_CONTINUATION" ||
            !matchesAccountingCaseContinuationAuthorization({
              source: continuationSource.compiled,
              candidate: input.compiled,
              ...(input.continuationAuthorization
                ? { authorization: input.continuationAuthorization }
                : {}),
            })
          )
        ) {
          throw new AppError("CONFLICT", "Accounting Case continuation authorization does not match the server-bound residual intent.", {
            httpStatus: 409,
          });
        }
        return { mode: "IDEMPOTENT_REPLAY", record: clone(current) };
      }
      if (input.compiled.version !== existing.currentVersion + 1) {
        throw new AppError("CONFLICT", "Accounting Case version compare-and-swap failed.", {
          httpStatus: 409,
          details: { currentVersion: existing.currentVersion },
        });
      }
      if (["PREFLIGHTED", "READY_TO_RESUME", "EXECUTING", "RECOVERY_REQUIRED"].includes(current.state)) {
        throw new AppError("CONFLICT", "Accounting Case cannot advance while execution or recovery is active.", {
          httpStatus: 409,
        });
      }
      if (current.state === "AWAITING_CONTINUATION") {
        if (!matchesAccountingCaseContinuationAuthorization({
          source: current.compiled,
          candidate: input.compiled,
          ...(input.continuationAuthorization ? { authorization: input.continuationAuthorization } : {}),
        })) {
          throw new AppError("CONFLICT", "Accounting Case continuation authorization does not match the server-bound residual intent.", {
            httpStatus: 409,
          });
        }
      } else if (input.continuationAuthorization) {
        throw new AppError("CONFLICT", "Accounting Case is not awaiting continuation.", { httpStatus: 409 });
      }
      this.#assertNoPendingContactReservationConflict(input);
      this.#assertNoPendingNativeDocumentReservationConflict(input);
      const advanced: AccountingCaseVersionRecord = {
        binding: clone(input.binding),
        compiled: clone(input.compiled),
        compiledPlanHash: input.compiledPlanHash,
        state: input.compiled.status,
        operations: input.compiled.operations.map((operation, ordinal) => ({
          operation: clone(operation),
          ordinal,
          state: "PENDING",
          updatedAt: input.now,
        })),
        createdAt: input.now,
        updatedAt: input.now,
      };
      existing.currentVersion = input.compiled.version;
      existing.versions.set(input.compiled.version, clone(advanced));
        return { mode: "ADVANCED", record: clone(advanced) };
      }
      if (input.compiled.version !== 1) {
        throw new AppError("CONFLICT", "A new Accounting Case must start at version 1.", { httpStatus: 409 });
      }
      if (recoveryGrant?.state === "CONSUMED") {
        throw new AppError("CONFLICT", "Accounting Case recovery successor grant is already consumed.", {
          httpStatus: 409,
        });
      }
      this.#assertNoPendingContactReservationConflict(input);
      this.#assertNoPendingNativeDocumentReservationConflict(input);
      const created: AccountingCaseVersionRecord = {
      binding: clone(input.binding),
      compiled: clone(input.compiled),
      compiledPlanHash: input.compiledPlanHash,
      state: input.compiled.status,
      operations: input.compiled.operations.map((operation, ordinal) => ({
        operation: clone(operation),
        ordinal,
        state: "PENDING",
        updatedAt: input.now,
      })),
      createdAt: input.now,
      updatedAt: input.now,
    };
      this.#accountingCases.set(input.compiled.caseId, {
        binding: clone(input.binding),
        currentVersion: 1,
        versions: new Map([[1, clone(created)]]),
      });
      if (recoveryGrant) {
        this.#accountingCaseRecoveryResidualGrants.set(recoveryGrant.successorCaseId, {
          ...clone(recoveryGrant),
          state: "CONSUMED",
          consumedPlanHash: input.compiledPlanHash,
          consumedAt: new Date(input.now),
          updatedAt: new Date(input.now),
        });
      }
      return { mode: "CREATED", record: clone(created) };
    } catch (error) {
      rollbackAbandonment();
      throw error;
    }
  }

  async findVerifiedAccountingCaseContactIdentity(
    input: FindVerifiedAccountingCaseContactIdentityInput,
  ): Promise<{ contactId: string } | undefined> {
    const contactIds = new Set<string>();
    for (const aggregate of this.#accountingCases.values()) {
      if (aggregate.binding.tenantId !== input.tenantId) continue;
      for (const version of aggregate.versions.values()) {
        for (const record of version.operations) {
          if (
            record.operation.actionId === "contact.create_basic" &&
            record.operation.businessIdentityHash === input.businessIdentityHash &&
            record.state === "READBACK_VERIFIED" &&
            record.xeroObjectId
          ) contactIds.add(record.xeroObjectId);
        }
      }
    }
    if (contactIds.size > 1) {
      throw new AppError("PERSISTENCE_FAILURE", "A durable contact identity maps to multiple provider contacts.", {
        httpStatus: 503,
      });
    }
    const contactId = [...contactIds][0];
    return contactId ? { contactId } : undefined;
  }

  async listVerifiedAccountingCaseContactIdentityHashes(
    input: ListVerifiedAccountingCaseContactIdentitiesInput,
  ): Promise<string[]> {
    const hashes = new Set<string>();
    for (const aggregate of this.#accountingCases.values()) {
      if (aggregate.binding.tenantId !== input.tenantId) continue;
      for (const version of aggregate.versions.values()) {
        for (const record of version.operations) {
          if (
            record.operation.actionId === "contact.create_basic" &&
            (record.operation.businessIdentity.kind === "LEGAL_REGISTRY_CONTACT" ||
              record.operation.businessIdentity.kind === "PROVIDER_TENANT_CONTACT_ACCOUNT") &&
            record.state === "READBACK_VERIFIED" &&
            record.xeroObjectId === input.contactId
          ) hashes.add(record.operation.businessIdentityHash);
        }
      }
    }
    return [...hashes].sort();
  }

  async getBoundAccountingCase(input: GetBoundAccountingCaseInput): Promise<AccountingCaseVersionRecord | undefined> {
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) return undefined;
    const record = aggregate.versions.get(input.version ?? aggregate.currentVersion);
    if (!record) return undefined;
    assertAccountingCasePreflightIntegrity(record);
    return clone(record);
  }

  async getAccessibleAccountingCase(
    input: GetAccessibleAccountingCaseInput,
  ): Promise<AccountingCaseVersionRecord | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseAccessIdentity(aggregate.binding, input.currentAccessBinding)) return undefined;
    if (!this.#isLiveAccountingCaseTarget(input.currentAccessBinding, input.now)) return undefined;
    const record = aggregate.versions.get(input.version ?? aggregate.currentVersion);
    if (!record) return undefined;
    if (input.mode === "RECOVERY_GET_ONLY" &&
        !["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) return undefined;
    assertAccountingCasePreflightIntegrity(record);
    const grant = [...this.#accountingCaseRecoveryResidualGrants.values()].find((candidate) =>
      candidate.sourceCaseId === input.caseId &&
      candidate.sourceVersion === record.compiled.version &&
      sameAccountingCaseBinding(candidate.successorBinding, input.currentAccessBinding));
    return grant
      ? { ...clone(record), recoveryResidualGrant: clone(grant) }
      : (() => {
          const projected = clone(record);
          delete projected.recoveryResidualGrant;
          return projected;
        })();
  }

  async recordAccountingCasePreflight(
    input: RecordAccountingCasePreflightInput,
  ): Promise<RecordAccountingCasePreflightResult> {
    if (
      !isValidDate(input.now) ||
      !isNonEmpty(input.requestId) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedPlanHash) ||
      !/^[0-9a-f]{64}$/u.test(input.preflightReceiptHash) ||
      Object.keys(input.preflightReceipt).length === 0
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight receipt is invalid.", { httpStatus: 422 });
    }
    const expectedReceiptHash = accountingCasePreflightReceiptHash({
      binding: input.binding,
      caseId: input.caseId,
      version: input.version,
      compiledPlanHash: input.expectedPlanHash,
      requestId: input.requestId,
      preflightReceipt: input.preflightReceipt,
    });
    if (input.preflightReceiptHash !== expectedReceiptHash) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight receipt hash is invalid.", { httpStatus: 422 });
    }
    const repositoryNow = this.#statementTimestamp();
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    if (aggregate.currentVersion !== input.version) {
      throw new AppError("CONFLICT", "Only the current Accounting Case version can be preflighted.", { httpStatus: 409 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.compiledPlanHash !== input.expectedPlanHash) {
      throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
    }
    if (input.binding.targetSessionExpiresAt <= repositoryNow) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Accounting Case target session has expired.", { httpStatus: 409 });
    }
    if (input.operations.length !== record.operations.length) {
      throw new AppError("CONFLICT", "Accounting Case preflight operation set is incomplete.", { httpStatus: 409 });
    }
    const byId = new Map(input.operations.map((operation) => [operation.operationId, operation]));
    if (byId.size !== input.operations.length || record.operations.some((operation) => !byId.has(operation.operation.operationId))) {
      throw new AppError("CONFLICT", "Accounting Case preflight operation set does not match the durable plan.", {
        httpStatus: 409,
      });
    }
    if (!Array.isArray(input.preflightReceipt.operations) ||
        input.preflightReceipt.operations.length !== record.operations.length ||
        record.operations.some((operation) =>
          !preflightReceiptOperationMatches(
            input.preflightReceipt,
            operation,
            byId.get(operation.operation.operationId)!,
          ))) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight receipt operation evidence is invalid.", {
        httpStatus: 422,
      });
    }
    if (record.preflightRequestId || record.preflightReceipt || record.preflightReceiptHash || record.preflightedAt) {
      assertAccountingCasePreflightIntegrity(record);
      const operationEvidenceMatches = record.operations.every((operation) => {
        const proposed = byId.get(operation.operation.operationId)!;
        return proposed.state === operation.state && (
          proposed.state === "PREPARED"
            ? proposed.preparationId === operation.preparationId &&
              proposed.preparationCanonicalPayloadHash === operation.preparationCanonicalPayloadHash &&
              proposed.sourceSha256 === operation.sourceSha256 &&
              proposed.operationCanonicalPayloadHash === operation.operation.canonicalPayloadHash
            : proposed.xeroObjectId === operation.xeroObjectId &&
              operation.readbackSnapshot !== undefined &&
              sameJson(proposed.readbackSnapshot, operation.readbackSnapshot)
        );
      });
      if (
        record.preflightRequestId === input.requestId &&
        record.preflightReceiptHash === input.preflightReceiptHash &&
        sameJson(record.preflightReceipt!, input.preflightReceipt) &&
        operationEvidenceMatches
      ) {
        return { mode: "IDEMPOTENT_REPLAY", record: clone(record) };
      }
      throw new AppError("CONFLICT", "Accounting Case already has a different preflight receipt.", {
        httpStatus: 409,
      });
    }
    if (!["PLANNED_NEEDS_PREFLIGHT", "PLANNED_WITH_EXCEPTIONS"].includes(record.state)) {
      throw new AppError("CONFLICT", `Accounting Case cannot be preflighted from ${record.state}.`, {
        httpStatus: 409,
      });
    }
    const preparationIds = new Set<string>();
    const noWriteObjects = new Set<string>();
    const proposedBusinessReservations = new Map<string, string>();
    for (const current of record.operations) {
      const preflight = byId.get(current.operation.operationId)!;
      if (preflight.state !== "PREPARED") continue;
      const key = `${record.binding.tenantId}:${current.operation.actionId}:${current.operation.businessIdentityHash}`;
      const duplicateInPlan = proposedBusinessReservations.get(key);
      if (duplicateInPlan) {
        throw new AppError("CONFLICT", "Accounting Case preflight contains a duplicate business write.", {
          httpStatus: 409,
          details: {
            duplicateOperationId: duplicateInPlan,
            operationId: current.operation.operationId,
          },
        });
      }
      proposedBusinessReservations.set(key, current.operation.operationId);
      for (const candidateAggregate of this.#accountingCases.values()) {
        if (candidateAggregate.binding.tenantId !== record.binding.tenantId) continue;
        for (const candidateVersion of candidateAggregate.versions.values()) {
          const duplicate = candidateVersion.operations.find((candidate) => {
            const recoveryGrant = this.#activeRecoveryResidualGrant(
              candidateVersion,
              candidate,
              repositoryNow,
            );
            const active = ACCOUNTING_CASE_BUSINESS_RESERVATION_STATES.has(candidate.state) ||
              (recoveryGrant !== undefined && recoveryGrant.successorCaseId !== record.compiled.caseId);
            return active &&
              candidate.operation.actionId === current.operation.actionId &&
              (
                accountingCaseBusinessReservationsOverlap(
                  candidate.operation.businessReservation,
                  current.operation.businessReservation,
                ) ||
                candidate.operation.canonicalPayloadHash === current.operation.canonicalPayloadHash
              );
          });
          if (duplicate) {
            throw new AppError("CONFLICT", "This accounting business write is already reserved by another Case version.", {
              httpStatus: 409,
              details: {
                duplicateCaseId: candidateVersion.compiled.caseId,
                duplicateCaseVersion: candidateVersion.compiled.version,
                duplicateOperationId: duplicate.operation.operationId,
              },
            });
          }
        }
      }
    }
    const operations = record.operations.map((current) => {
      if (current.state !== "PENDING") {
        throw new AppError("CONFLICT", "Accounting Case preflight requires every operation to remain pending.", {
          httpStatus: 409,
        });
      }
      const preflight = byId.get(current.operation.operationId)!;
      if (preflight.state === "PREPARED") {
        const preparation = this.#xeroMutationPreparations.get(preflight.preparationId);
        const route = accountingCaseMutationRoute(current.operation);
        if (
          !isNonEmpty(preflight.preparationId) || preparationIds.has(preflight.preparationId) ||
          !/^[0-9a-f]{64}$/u.test(preflight.operationCanonicalPayloadHash) ||
          !/^[0-9a-f]{64}$/u.test(preflight.preparationCanonicalPayloadHash) ||
          !/^[0-9a-f]{64}$/u.test(preflight.sourceSha256) ||
          preflight.operationCanonicalPayloadHash !== current.operation.canonicalPayloadHash ||
          !preparation || preparation.state !== "PREPARED" || preparation.expiresAt <= repositoryNow ||
          preparation.actorId !== record.binding.actorId ||
          preparation.workspaceId !== record.binding.workspaceId ||
          preparation.tenantId !== record.binding.tenantId ||
          preparation.installationId !== record.binding.installationId ||
          preparation.bindingId !== record.binding.bindingId ||
          preparation.bindingRevision !== record.binding.bindingRevision ||
          preparation.connectionId !== record.binding.connectionId ||
          preparation.targetSessionId !== record.binding.targetSessionId ||
          preparation.objectType !== route.objectType || preparation.operation !== route.operation ||
          preparation.sourceRef !== `case:${record.compiled.caseId}` ||
          preparation.sourceUnitKey !== current.operation.operationId ||
          preparation.sourceSha256 !== preflight.sourceSha256 ||
          preparation.canonicalPayloadHash !== preflight.preparationCanonicalPayloadHash ||
          preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload)
        ) {
          throw new AppError("VALIDATION_FAILED", "Accounting Case preflight preparation identity is invalid.", {
            httpStatus: 422,
          });
        }
        preparationIds.add(preflight.preparationId);
        return {
          ...current,
          state: "PREPARED" as const,
          preparationId: preflight.preparationId,
          originalPreparationId: preflight.preparationId,
          preparationCanonicalPayloadHash: preflight.preparationCanonicalPayloadHash,
          sourceSha256: preflight.sourceSha256,
          updatedAt: repositoryNow,
        };
      }
      if (
        !isNonEmpty(preflight.xeroObjectId) ||
        Object.keys(preflight.readbackSnapshot).length === 0 ||
        !accountingCaseNoWriteEvidenceMatches(current.operation, preflight.xeroObjectId, preflight.readbackSnapshot)
      ) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case no-write preflight evidence is invalid.", {
          httpStatus: 422,
        });
      }
      const objectKey = `${current.operation.actionId}:${preflight.xeroObjectId}`;
      if (noWriteObjects.has(objectKey)) {
        throw new AppError("CONFLICT", "Accounting Case preflight reuses one Xero object for multiple operations.", {
          httpStatus: 409,
        });
      }
      noWriteObjects.add(objectKey);
      return {
        ...current,
        state: "NO_WRITE_REQUIRED" as const,
        xeroObjectId: preflight.xeroObjectId,
        readbackSnapshot: clone(preflight.readbackSnapshot),
        updatedAt: repositoryNow,
      };
    });
    const updated: AccountingCaseVersionRecord = {
      ...record,
      state: "PREFLIGHTED",
      preflightRequestId: input.requestId,
      preflightReceipt: clone(input.preflightReceipt),
      preflightReceiptHash: input.preflightReceiptHash,
      preflightedAt: repositoryNow,
      originalPreflightReceiptHash: input.preflightReceiptHash,
      effectivePreflightSealHash: input.preflightReceiptHash,
      effectivePreflightSealedAt: repositoryNow,
      preflightResealRevision: 0,
      preflightReseals: [],
      operations,
      updatedAt: repositoryNow,
    };
    aggregate.versions.set(input.version, clone(updated));
    return { mode: "PREFLIGHTED", record: clone(updated) };
  }

  async claimAccountingCaseExecution(
    input: ClaimAccountingCaseExecutionInput,
  ): Promise<ClaimAccountingCaseExecutionResult> {
    const aggregate = this.#accountingCases.get(input.caseId);
    const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
    const bindingMatches = aggregate && (recoveryAccess
      ? sameAccountingCaseAccessIdentity(aggregate.binding, input.binding)
      : sameAccountingCaseBinding(aggregate.binding, input.binding));
    if (!aggregate || !bindingMatches) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    if (aggregate.currentVersion !== input.version) {
      throw new AppError("CONFLICT", "Only the current Accounting Case version can execute.", { httpStatus: 409 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.compiledPlanHash !== input.expectedPlanHash) {
      throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
    }
    if (recoveryAccess) {
      if (!this.#isLiveAccountingCaseTarget(input.binding, input.now) ||
          !["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
        throw new AppError("NOT_FOUND", "Accounting Case was not found for recovery access.", { httpStatus: 404 });
      }
      if (record.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case recovery does not own the original execution claim.", {
          httpStatus: 409,
        });
      }
      if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
        return { mode: "ALREADY_TERMINAL", record: clone(record) };
      }
      return { mode: "RECOVERY_GET_ONLY", record: clone(record) };
    }
    if (record.executionRequestId) {
      if (record.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case is already claimed by another execution request.", {
          httpStatus: 409,
        });
      }
      if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
        return { mode: "ALREADY_TERMINAL", record: clone(record) };
      }
      if (input.binding.targetSessionExpiresAt <= input.now) {
        throw new AppError("TARGET_SESSION_EXPIRED", "Accounting Case target session has expired.", {
          httpStatus: 409,
        });
      }
      if (["EXECUTING", "RECOVERY_REQUIRED"].includes(record.state)) {
        return { mode: "RESUME", record: clone(record) };
      }
      throw new AppError("CONFLICT", `Accounting Case cannot resume from ${record.state}.`, { httpStatus: 409 });
    }
    if (input.binding.targetSessionExpiresAt <= input.now) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Accounting Case target session has expired.", {
        httpStatus: 409,
      });
    }
    if (record.state !== "PREFLIGHTED" && record.state !== "READY_TO_RESUME") {
      throw new AppError("VALIDATION_FAILED", `Accounting Case cannot execute from ${record.state}.`, {
        httpStatus: 422,
      });
    }
    if (record.state === "PREFLIGHTED" && record.preflightRequestId !== input.requestId) {
      throw new AppError("VALIDATION_FAILED", "The first execution request must own the durable preflight.", {
        httpStatus: 422,
      });
    }
    if (input.minimumPreparationExpiresAt) {
      if (!isValidDate(input.minimumPreparationExpiresAt) ||
          input.minimumPreparationExpiresAt.getTime() <
            input.now.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case preparation runway is invalid.", {
          httpStatus: 422,
        });
      }
      for (const operation of record.operations.filter((candidate) => candidate.state === "PREPARED")) {
        const preparation = operation.preparationId
          ? this.#xeroMutationPreparations.get(operation.preparationId)
          : undefined;
        if (!preparation || preparation.state !== "PREPARED" ||
            preparation.expiresAt < input.minimumPreparationExpiresAt) {
          throw new AppError("STALE_PREFLIGHT", "Accounting Case preparation must be resealed before execution.", {
            httpStatus: 409,
            retryable: true,
            details: { operationId: operation.operation.operationId },
          });
        }
      }
    }
    const claimed = clone(record);
    claimed.state = "EXECUTING";
    claimed.executionRequestId = input.requestId;
    claimed.executionStartedAt = input.now;
    delete claimed.terminalSummary;
    claimed.updatedAt = input.now;
    aggregate.versions.set(input.version, clone(claimed));
    return { mode: "CLAIMED", record: clone(claimed) };
  }

  async adoptExpiredExecutingAccountingCaseForRecovery(
    input: AdoptExpiredExecutingAccountingCaseForRecoveryInput,
  ): Promise<AdoptExpiredExecutingAccountingCaseForRecoveryResult> {
    if (
      !isValidDate(input.now) ||
      !isNonEmpty(input.requestId) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedPlanHash)
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case recovery adoption is invalid.", {
        httpStatus: 422,
      });
    }
    const repositoryNow = this.#statementTimestamp();
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseAccessIdentity(aggregate.binding, input.currentAccessBinding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    if (!this.#isLiveAccountingCaseTarget(input.currentAccessBinding, repositoryNow)) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Current recovery target session is not live.", {
        httpStatus: 409,
      });
    }
    const originalTarget = this.#ledgerTargetSessions.get(aggregate.binding.targetSessionHash);
    if (
      aggregate.binding.targetSessionExpiresAt > repositoryNow ||
      aggregate.binding.targetSessionHash === input.currentAccessBinding.targetSessionHash ||
      (originalTarget !== undefined && (
        originalTarget.sessionId !== aggregate.binding.targetSessionId ||
        originalTarget.installationId !== aggregate.binding.installationId ||
        originalTarget.bindingId !== aggregate.binding.bindingId ||
        originalTarget.bindingRevision !== aggregate.binding.bindingRevision ||
        originalTarget.connectionId !== aggregate.binding.connectionId ||
        originalTarget.expiresAt.getTime() !== aggregate.binding.targetSessionExpiresAt.getTime() ||
        originalTarget.expiresAt > repositoryNow
      ))
    ) {
      throw new AppError("CONFLICT", "The original Accounting Case target lease is not durably expired.", {
        httpStatus: 409,
      });
    }
    if (aggregate.currentVersion !== input.version) {
      throw new AppError("CONFLICT", "Only the current Accounting Case version can be adopted.", {
        httpStatus: 409,
      });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.compiledPlanHash !== input.expectedPlanHash) {
      throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
    }
    if (record.state !== "EXECUTING" || record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case recovery adoption does not own the executing Case.", {
        httpStatus: 409,
      });
    }

    let adoptedCount = 0;
    const operations = record.operations.map((operation) => {
      if (operation.state !== "PREPARED" || !operation.preparationId) return clone(operation);
      const requests = [...this.#xeroMutationRequests.values()].filter(
        (request) => request.preparationId === operation.preparationId,
      );
      if (requests.length === 0) return clone(operation);
      if (requests.length !== 1) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preparation has ambiguous mutation requests.", {
          httpStatus: 503,
        });
      }
      const request = requests[0]!;
      const preparation = this.#xeroMutationPreparations.get(operation.preparationId);
      const projectedState = accountingCaseStateForMutation(request.state);
      const route = accountingCaseMutationRoute(operation.operation);
      if (
        !preparation ||
        !projectedState ||
        !["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(projectedState) ||
        preparation.preparationId !== operation.preparationId ||
        operation.preparationCanonicalPayloadHash !== request.canonicalPayloadHash ||
        operation.preparationCanonicalPayloadHash !== preparation.canonicalPayloadHash ||
        operation.sourceSha256 !== request.sourceSha256 ||
        operation.sourceSha256 !== preparation.sourceSha256 ||
        request.canonicalPayloadHash !== hashObject(request.canonicalPayload) ||
        preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload) ||
        !sameJson(request.canonicalPayload, preparation.canonicalPayload) ||
        request.actorId !== record.binding.actorId ||
        request.workspaceId !== record.binding.workspaceId ||
        request.tenantId !== record.binding.tenantId ||
        request.installationId !== record.binding.installationId ||
        request.bindingId !== record.binding.bindingId ||
        request.bindingRevision !== record.binding.bindingRevision ||
        request.connectionId !== record.binding.connectionId ||
        request.targetSessionId !== record.binding.targetSessionId ||
        request.objectType !== route.objectType || request.operation !== route.operation ||
        request.sourceRef !== `case:${record.compiled.caseId}` ||
        request.sourceUnitKey !== operation.operation.operationId ||
        request.sourceEvidenceType !== preparation.sourceEvidenceType
      ) {
        throw new AppError(
          "CONFLICT",
          "Durable mutation evidence does not match the expired-target Accounting Case operation.",
          { httpStatus: 409 },
        );
      }
      const errorReceipt = accountingCaseMutationProjectionErrorReceipt(request);
      if (["WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(projectedState) && !errorReceipt) {
        throw new AppError("PERSISTENCE_FAILURE", "Durable recovery mutation evidence is incomplete.", {
          httpStatus: 503,
        });
      }
      adoptedCount += 1;
      return {
        ...clone(operation),
        state: projectedState,
        mutationRequestId: request.mutationRequestId,
        ...(request.xeroObjectId ? { xeroObjectId: request.xeroObjectId } : {}),
        ...(request.writeReceipt ? { writeReceipt: clone(request.writeReceipt) } : {}),
        ...(request.readbackSnapshot ? { readbackSnapshot: clone(request.readbackSnapshot) } : {}),
        ...(errorReceipt ? { errorReceipt: clone(errorReceipt) } : {}),
        updatedAt: repositoryNow,
      } satisfies AccountingCaseOperationRecord;
    });
    if (adoptedCount === 0) {
      throw new AppError(
        "CONFLICT",
        "No PREPARED Accounting Case operation has a durable potentially-written mutation request.",
        {
          httpStatus: 409,
          details: { reasonCodes: ["NO_POTENTIALLY_WRITTEN_MUTATION_REQUEST"] },
        },
      );
    }
    const recoveringBase: AccountingCaseVersionRecord = {
      ...clone(record),
      state: "RECOVERY_REQUIRED",
      operations,
      updatedAt: repositoryNow,
    };
    const recovering: AccountingCaseVersionRecord = {
      ...recoveringBase,
      terminalSummary: accountingCaseTerminalSummary(recoveringBase, "RECOVERY_REQUIRED"),
    };
    assertAccountingCasePreflightIntegrity(recovering);
    aggregate.versions.set(input.version, clone(recovering));
    return { mode: "ADOPTED", record: clone(recovering) };
  }

  async resealAndClaimAccountingCaseExecution(
    input: ResealAndClaimAccountingCaseExecutionInput,
  ): Promise<ResealAndClaimAccountingCaseExecutionResult> {
    if (
      !isValidDate(input.now) ||
      !isValidDate(input.minimumPreparationExpiresAt) ||
      input.minimumPreparationExpiresAt.getTime() <
        input.now.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS ||
      !isNonEmpty(input.requestId) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedPlanHash) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedOriginalPreflightReceiptHash) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedEffectiveSealHash) ||
      !/^[0-9a-f]{64}$/u.test(input.resealReceiptHash) ||
      !Number.isInteger(input.expectedResealRevision) || input.expectedResealRevision < 0 ||
      input.operations.length === 0
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight reseal is invalid.", { httpStatus: 422 });
    }
    const nextRevision = input.expectedResealRevision + 1;
    if (
      input.resealReceipt.receiptType !== "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL" ||
      input.resealReceipt.receiptVersion !== 1 ||
      input.resealReceipt.caseId !== input.caseId ||
      input.resealReceipt.caseVersion !== input.version ||
      input.resealReceipt.requestId !== input.requestId ||
      input.resealReceipt.compiledPlanHash !== input.expectedPlanHash ||
      input.resealReceipt.originalPreflightReceiptHash !== input.expectedOriginalPreflightReceiptHash ||
      input.resealReceipt.previousEffectiveSealHash !== input.expectedEffectiveSealHash ||
      input.resealReceipt.revision !== nextRevision ||
      input.resealReceipt.minimumPreparationExpiresAt !== input.minimumPreparationExpiresAt.toISOString() ||
      input.resealReceipt.checkedAt !== input.now.toISOString() ||
      stableStringify(input.resealReceipt.operations) !== stableStringify(input.operations) ||
      input.resealReceiptHash !== accountingCasePreflightResealReceiptHash({
        binding: input.binding,
        caseId: input.caseId,
        version: input.version,
        compiledPlanHash: input.expectedPlanHash,
        originalPreflightReceiptHash: input.expectedOriginalPreflightReceiptHash,
        previousEffectiveSealHash: input.expectedEffectiveSealHash,
        revision: nextRevision,
        requestId: input.requestId,
        resealReceipt: input.resealReceipt,
      })
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight reseal receipt is invalid.", {
        httpStatus: 422,
      });
    }

    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    if (aggregate.currentVersion !== input.version) {
      throw new AppError("CONFLICT", "Only the current Accounting Case version can be resealed.", {
        httpStatus: 409,
      });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    assertAccountingCasePreflightIntegrity(record);
    if (record.compiledPlanHash !== input.expectedPlanHash) {
      throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
    }
    if (record.executionRequestId) {
      if (record.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case is already claimed by another execution request.", {
          httpStatus: 409,
        });
      }
      if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
        return { mode: "ALREADY_TERMINAL", record: clone(record) };
      }
      if (["EXECUTING", "RECOVERY_REQUIRED"].includes(record.state)) {
        return { mode: "RESUME", record: clone(record) };
      }
      throw new AppError("CONFLICT", `Accounting Case cannot resume from ${record.state}.`, { httpStatus: 409 });
    }
    if (!this.#isLiveAccountingCaseTarget(input.binding, input.now)) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Accounting Case target session has expired.", {
        httpStatus: 409,
      });
    }
    if (record.state !== "PREFLIGHTED" && record.state !== "READY_TO_RESUME") {
      throw new AppError("CONFLICT", `Accounting Case cannot be resealed from ${record.state}.`, { httpStatus: 409 });
    }
    if (record.state === "PREFLIGHTED" && record.preflightRequestId !== input.requestId) {
      throw new AppError("VALIDATION_FAILED", "The first execution request must own the durable preflight.", {
        httpStatus: 422,
      });
    }
    if (
      record.originalPreflightReceiptHash !== input.expectedOriginalPreflightReceiptHash ||
      record.effectivePreflightSealHash !== input.expectedEffectiveSealHash ||
      record.preflightResealRevision !== input.expectedResealRevision
    ) {
      throw new AppError("CONFLICT", "Accounting Case effective preflight seal is stale.", { httpStatus: 409 });
    }

    const remaining = record.operations.filter((operation) => operation.state === "PREPARED");
    const byId = new Map(input.operations.map((operation) => [operation.operationId, operation]));
    if (
      byId.size !== input.operations.length ||
      remaining.length !== input.operations.length ||
      remaining.some((operation) => !byId.has(operation.operation.operationId))
    ) {
      throw new AppError("CONFLICT", "Accounting Case reseal must replace exactly the remaining prepared operations.", {
        httpStatus: 409,
      });
    }

    const replacementIds = new Set<string>();
    let hasStalePreparation = false;
    const replacements = new Map<string, XeroMutationPreparation>();
    for (const operation of remaining) {
      const reseal = byId.get(operation.operation.operationId)!;
      const oldPreparation = operation.preparationId
        ? this.#xeroMutationPreparations.get(operation.preparationId)
        : undefined;
      const newPreparation = this.#xeroMutationPreparations.get(reseal.newPreparationId);
      const route = accountingCaseMutationRoute(operation.operation);
      const oldHasRequest = operation.preparationId && [...this.#xeroMutationRequests.values()]
        .some((request) => request.preparationId === operation.preparationId);
      const replacementAlreadySealed = [...this.#accountingCases.values()].some((candidateAggregate) =>
        [...candidateAggregate.versions.values()].some((candidateVersion) =>
          candidateVersion.operations.some((candidate) =>
            candidate.preparationId === reseal.newPreparationId ||
            candidate.originalPreparationId === reseal.newPreparationId)));
      if (
        !operation.preparationId ||
        operation.mutationRequestId || oldHasRequest ||
        reseal.oldPreparationId !== operation.preparationId ||
        reseal.oldPreparationId === reseal.newPreparationId ||
        replacementIds.has(reseal.newPreparationId) || replacementAlreadySealed ||
        reseal.operationCanonicalPayloadHash !== operation.operation.canonicalPayloadHash ||
        reseal.preparationCanonicalPayloadHash !== operation.preparationCanonicalPayloadHash ||
        reseal.sourceSha256 !== operation.sourceSha256 ||
        !oldPreparation || !["PREPARED", "EXPIRED"].includes(oldPreparation.state) ||
        (oldPreparation.state === "EXPIRED" && oldPreparation.expiresAt > input.now) ||
        !newPreparation || newPreparation.state !== "PREPARED" ||
        newPreparation.expiresAt < input.minimumPreparationExpiresAt ||
        reseal.newPreparationExpiresAt !== newPreparation.expiresAt.toISOString() ||
        oldPreparation.objectType !== route.objectType || oldPreparation.operation !== route.operation ||
        !sameResealPreparationIdentity(oldPreparation, newPreparation) ||
        newPreparation.canonicalPayloadHash !== reseal.preparationCanonicalPayloadHash ||
        newPreparation.canonicalPayloadHash !== hashObject(newPreparation.canonicalPayload) ||
        newPreparation.sourceSha256 !== reseal.sourceSha256 ||
        newPreparation.sourceRef !== `case:${record.compiled.caseId}` ||
        newPreparation.sourceUnitKey !== operation.operation.operationId
      ) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case reseal preparation identity is invalid.", {
          httpStatus: 422,
          details: { operationId: operation.operation.operationId },
        });
      }
      if (oldPreparation.state === "EXPIRED" ||
          oldPreparation.expiresAt < input.minimumPreparationExpiresAt) hasStalePreparation = true;
      replacementIds.add(reseal.newPreparationId);
      replacements.set(operation.operation.operationId, newPreparation);
    }
    if (!hasStalePreparation) {
      throw new AppError("CONFLICT", "Accounting Case preparations still have sufficient execution runway.", {
        httpStatus: 409,
      });
    }

    const updated = clone(record);
    updated.operations = updated.operations.map((operation) => {
      const replacement = replacements.get(operation.operation.operationId);
      if (!replacement) return operation;
      return {
        ...operation,
        preparationId: replacement.preparationId,
        preparationCanonicalPayloadHash: replacement.canonicalPayloadHash,
        sourceSha256: replacement.sourceSha256,
        updatedAt: input.now,
      };
    });
    updated.preflightReseals = [
      ...(updated.preflightReseals ?? []),
      {
        revision: nextRevision,
        requestId: input.requestId,
        previousEffectiveSealHash: input.expectedEffectiveSealHash,
        effectiveSealHash: input.resealReceiptHash,
        receipt: clone(input.resealReceipt),
        resealedAt: input.now,
      },
    ];
    updated.preflightResealRevision = nextRevision;
    updated.effectivePreflightSealHash = input.resealReceiptHash;
    updated.effectivePreflightSealedAt = input.now;
    updated.state = "EXECUTING";
    updated.executionRequestId = input.requestId;
    updated.executionStartedAt = input.now;
    delete updated.terminalSummary;
    updated.updatedAt = input.now;
    assertAccountingCasePreflightIntegrity(updated);
    aggregate.versions.set(input.version, clone(updated));
    return { mode: "RESEALED_AND_CLAIMED", record: clone(updated) };
  }

  async updateAccountingCaseOperation(
    input: UpdateAccountingCaseOperationInput,
  ): Promise<AccountingCaseVersionRecord> {
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (!["EXECUTING", "RECOVERY_REQUIRED"].includes(record.state)) {
      throw new AppError("CONFLICT", "Accounting Case operation cannot change outside execution/recovery.", {
        httpStatus: 409,
      });
    }
    if (record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case operation update does not own the execution claim.", {
        httpStatus: 409,
      });
    }
    const operationIndex = record.operations.findIndex((candidate) => candidate.operation.operationId === input.operationId);
    if (operationIndex < 0) throw new AppError("NOT_FOUND", "Accounting Case operation was not found.", { httpStatus: 404 });
    const current = record.operations[operationIndex]!;
    if (!input.expectedStates.includes(current.state)) {
      throw new AppError("CONFLICT", `Accounting Case operation cannot transition from ${current.state}.`, {
        httpStatus: 409,
      });
    }
    if (input.mutationRequestId || input.writeReceipt ||
        (input.xeroObjectId && input.state !== "NO_WRITE_REQUIRED") ||
        current.mutationRequestId ||
        ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED", "PROVIDER_REJECTED"]
          .includes(input.state)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Mutation-linked Accounting Case evidence must be projected from the durable mutation request.",
        { httpStatus: 422 },
      );
    }
    const allowedTransitions: Record<typeof current.state, readonly typeof input.state[]> = {
      PENDING: ["NO_WRITE_REQUIRED", "BLOCKED_VALIDATION", "NOT_EXECUTED_AFTER_PRIOR_FAILURE"],
      PREPARED: ["NO_WRITE_REQUIRED", "BLOCKED_VALIDATION", "NOT_EXECUTED_AFTER_PRIOR_FAILURE"],
      WRITE_IN_FLIGHT: [],
      NO_WRITE_REQUIRED: [],
      READBACK_VERIFIED: [],
      WRITE_UNCERTAIN: [],
      READBACK_MISMATCH: [],
      PROVIDER_REJECTED: [],
      BLOCKED_VALIDATION: [],
      NOT_EXECUTED_AFTER_PRIOR_FAILURE: [],
      NOT_EXECUTED_AFTER_TARGET_EXPIRY: [],
    };
    if (!allowedTransitions[current.state].includes(input.state)) {
      throw new AppError("CONFLICT", `Accounting Case operation transition ${current.state} -> ${input.state} is invalid.`, {
        httpStatus: 409,
      });
    }
    if (input.state === "NOT_EXECUTED_AFTER_PRIOR_FAILURE" &&
        !record.operations.some((candidate) =>
          candidate.ordinal < current.ordinal &&
          (candidate.state === "PROVIDER_REJECTED" || candidate.state === "BLOCKED_VALIDATION"))) {
      throw new AppError("CONFLICT", "A residual operation requires an earlier definite failure.", {
        httpStatus: 409,
      });
    }
    if (input.state === "NO_WRITE_REQUIRED" &&
        (!input.xeroObjectId || !input.readbackSnapshot ||
          !accountingCaseNoWriteEvidenceMatches(current.operation, input.xeroObjectId, input.readbackSnapshot))) {
      throw new AppError("VALIDATION_FAILED", "No-write evidence does not exactly match the sealed Xero operation.", {
        httpStatus: 422,
      });
    }
    if ((input.state === "BLOCKED_VALIDATION" || input.state === "NOT_EXECUTED_AFTER_PRIOR_FAILURE") &&
        (!input.errorReceipt || Object.keys(input.errorReceipt).length === 0)) {
      throw new AppError("VALIDATION_FAILED", "A terminal non-write operation requires an error receipt.", {
        httpStatus: 422,
      });
    }
    const updatedOperation = {
      ...current,
      state: input.state,
      ...(input.preparationId ? { preparationId: input.preparationId } : {}),
      ...(input.xeroObjectId ? { xeroObjectId: input.xeroObjectId } : {}),
      ...(input.readbackSnapshot ? { readbackSnapshot: clone(input.readbackSnapshot) } : {}),
      ...(input.errorReceipt ? { errorReceipt: clone(input.errorReceipt) } : {}),
      updatedAt: input.now,
    };
    const operations = [...record.operations];
    operations[operationIndex] = updatedOperation;
    const updatedBase: AccountingCaseVersionRecord = { ...record, operations, updatedAt: input.now };
    const updated: AccountingCaseVersionRecord = record.state === "RECOVERY_REQUIRED"
      ? { ...updatedBase, terminalSummary: accountingCaseTerminalSummary(updatedBase, "RECOVERY_REQUIRED") }
      : updatedBase;
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async projectAccountingCaseOperationFromMutation(
    input: ProjectAccountingCaseOperationFromMutationInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || input.expectedStates.length === 0 || !isNonEmpty(input.mutationRequestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case mutation projection is invalid.", { httpStatus: 422 });
    }
    const aggregate = this.#accountingCases.get(input.caseId);
    const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
    const bindingMatches = aggregate && (recoveryAccess
      ? sameAccountingCaseAccessIdentity(aggregate.binding, input.binding)
      : sameAccountingCaseBinding(aggregate.binding, input.binding));
    if (!aggregate || !bindingMatches) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.executionRequestId !== input.requestId ||
        (recoveryAccess ? record.state !== "RECOVERY_REQUIRED" : !["EXECUTING", "RECOVERY_REQUIRED"].includes(record.state))) {
      throw new AppError("CONFLICT", "Accounting Case mutation projection does not own an executable Case.", {
        httpStatus: 409,
      });
    }
    if (recoveryAccess && !this.#isLiveAccountingCaseTarget(input.binding, input.now)) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Current recovery access is not live.", { httpStatus: 409 });
    }
    const operationIndex = record.operations.findIndex((candidate) => candidate.operation.operationId === input.operationId);
    if (operationIndex < 0) throw new AppError("NOT_FOUND", "Accounting Case operation was not found.", { httpStatus: 404 });
    const current = record.operations[operationIndex]!;
    if (!input.expectedStates.includes(current.state)) {
      throw new AppError("CONFLICT", `Accounting Case operation cannot transition from ${current.state}.`, {
        httpStatus: 409,
      });
    }
    let request = this.#xeroMutationRequests.get(input.mutationRequestId);
    const preparation = request && this.#xeroMutationPreparations.get(request.preparationId);
    const route = accountingCaseMutationRoute(current.operation);
    let projectedState = request && accountingCaseStateForMutation(request.state);
    if (
      !request || !preparation || !projectedState || projectedState !== input.desiredState ||
      request.preparationId !== current.preparationId ||
      preparation.preparationId !== current.preparationId ||
      current.preparationCanonicalPayloadHash !== request.canonicalPayloadHash ||
      current.preparationCanonicalPayloadHash !== preparation.canonicalPayloadHash ||
      current.sourceSha256 !== request.sourceSha256 || current.sourceSha256 !== preparation.sourceSha256 ||
      request.canonicalPayloadHash !== hashObject(request.canonicalPayload) ||
      preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload) ||
      !sameJson(request.canonicalPayload, preparation.canonicalPayload) ||
      request.actorId !== record.binding.actorId || request.workspaceId !== record.binding.workspaceId ||
      request.tenantId !== record.binding.tenantId || request.installationId !== record.binding.installationId ||
      request.bindingId !== record.binding.bindingId || request.bindingRevision !== record.binding.bindingRevision ||
      request.connectionId !== record.binding.connectionId || request.targetSessionId !== record.binding.targetSessionId ||
      request.objectType !== route.objectType || request.operation !== route.operation ||
      request.sourceRef !== `case:${record.compiled.caseId}` ||
      request.sourceUnitKey !== current.operation.operationId ||
      request.sourceEvidenceType !== preparation.sourceEvidenceType
    ) {
      throw new AppError("CONFLICT", "Xero mutation does not match the immutable Accounting Case operation evidence.", {
        httpStatus: 409,
      });
    }
    if (recoveryAccess && !["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(current.state)) {
      throw new AppError("CONFLICT", "Recovery access cannot start a fresh provider mutation.", { httpStatus: 409 });
    }
    const allowed: Record<AccountingCaseOperationState, readonly AccountingCaseOperationState[]> = {
      PENDING: [],
      PREPARED: ["WRITE_IN_FLIGHT", "READBACK_VERIFIED", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "PROVIDER_REJECTED", "BLOCKED_VALIDATION"],
      WRITE_IN_FLIGHT: ["READBACK_VERIFIED", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "PROVIDER_REJECTED"],
      NO_WRITE_REQUIRED: [],
      READBACK_VERIFIED: [],
      WRITE_UNCERTAIN: ["READBACK_VERIFIED", "READBACK_MISMATCH"],
      READBACK_MISMATCH: ["READBACK_VERIFIED"],
      PROVIDER_REJECTED: [],
      BLOCKED_VALIDATION: [],
      NOT_EXECUTED_AFTER_PRIOR_FAILURE: [],
      NOT_EXECUTED_AFTER_TARGET_EXPIRY: [],
    };
    if (current.state !== projectedState && !allowed[current.state].includes(projectedState)) {
      throw new AppError("CONFLICT", `Accounting Case mutation projection ${current.state} -> ${projectedState} is invalid.`, {
        httpStatus: 409,
      });
    }
    if (projectedState === "READBACK_VERIFIED") {
      const economics = validateXeroAccountingCaseReadbackEconomics(current.operation, request);
      if (!economics.ok) {
        const mismatchedRequest = clone(request);
        mismatchedRequest.state = "READBACK_MISMATCH";
        delete mismatchedRequest.verifiedAt;
        mismatchedRequest.readbackMismatchReceipt = {
          receiptType: "ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH",
          mismatchType: "ACCOUNTING_CASE_ECONOMICS",
          reasonCodes: [...economics.reasons],
        };
        mismatchedRequest.updatedAt = input.now;
        request = mismatchedRequest;
        this.#xeroMutationRequests.set(request.mutationRequestId, clone(request));
        projectedState = "READBACK_MISMATCH";
      }
    }
    const errorReceipt = accountingCaseMutationProjectionErrorReceipt(request);
    const failureStates: AccountingCaseOperationState[] = [
      "WRITE_UNCERTAIN", "READBACK_MISMATCH", "PROVIDER_REJECTED", "BLOCKED_VALIDATION",
    ];
    if (failureStates.includes(projectedState) && (!errorReceipt || Object.keys(errorReceipt).length === 0)) {
      throw new AppError("PERSISTENCE_FAILURE", "Durable Xero mutation failure evidence is incomplete.", {
        httpStatus: 503,
      });
    }
    const updatedOperation: AccountingCaseOperationRecord = {
      ...current,
      state: projectedState,
      preparationId: request.preparationId,
      preparationCanonicalPayloadHash: request.canonicalPayloadHash,
      sourceSha256: request.sourceSha256,
      mutationRequestId: request.mutationRequestId,
      ...(request.xeroObjectId ? { xeroObjectId: request.xeroObjectId } : {}),
      ...(request.writeReceipt ? { writeReceipt: clone(request.writeReceipt) } : {}),
      ...(request.readbackSnapshot ? { readbackSnapshot: clone(request.readbackSnapshot) } : {}),
      ...(errorReceipt ? { errorReceipt: clone(errorReceipt) } : {}),
      updatedAt: input.now,
    };
    if (projectedState === "READBACK_VERIFIED") delete updatedOperation.errorReceipt;
    const operations = [...record.operations];
    operations[operationIndex] = updatedOperation;
    const updatedBase: AccountingCaseVersionRecord = { ...record, operations, updatedAt: input.now };
    const requiresRecovery = ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(projectedState);
    const updated: AccountingCaseVersionRecord = record.state === "RECOVERY_REQUIRED" || requiresRecovery
      ? {
          ...updatedBase,
          state: "RECOVERY_REQUIRED",
          terminalSummary: accountingCaseTerminalSummary(updatedBase, "RECOVERY_REQUIRED"),
        }
      : updatedBase;
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async pauseAccountingCaseExecution(
    input: PauseAccountingCaseExecutionInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.errorReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case pause receipt is invalid.", { httpStatus: 422 });
    }
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record || record.state !== "EXECUTING" || record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case execution cannot be paused by this request.", { httpStatus: 409 });
    }
    if (!record.operations.some((operation) => operation.state === "PREPARED") ||
        record.operations.some((operation) =>
          ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state))) {
      throw new AppError("CONFLICT", "Accounting Case cannot pause while provider evidence needs recovery.", {
        httpStatus: 409,
      });
    }
    const updated = clone(record);
    updated.state = "READY_TO_RESUME";
    delete updated.executionRequestId;
    delete updated.executionStartedAt;
    updated.lastExecutionErrorReceipt = {
        receiptType: "ACCOUNTING_CASE_EXECUTION_PAUSED",
        previousExecutionRequestId: input.requestId,
        error: clone(input.errorReceipt),
    };
    delete updated.terminalSummary;
    updated.updatedAt = input.now;
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async releaseAccountingCaseRecovery(
    input: ReleaseAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.reasonReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case recovery release receipt is invalid.", { httpStatus: 422 });
    }
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseAccessIdentity(aggregate.binding, input.currentAccessBinding) ||
        !this.#isLiveAccountingCaseTarget(input.currentAccessBinding, input.now)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found for current recovery access.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record || record.state !== "RECOVERY_REQUIRED" || record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case recovery cannot be released by this request.", { httpStatus: 409 });
    }
    if (!record.operations.some((operation) => operation.state === "PREPARED") ||
        record.operations.some((operation) =>
          ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state))) {
      throw new AppError("CONFLICT", "Accounting Case recovery is not fully resolved to prepared residual work.", {
        httpStatus: 409,
      });
    }
    const updated = clone(record);
    updated.state = "READY_TO_RESUME";
    delete updated.executionRequestId;
    delete updated.executionStartedAt;
    updated.lastExecutionErrorReceipt = {
        receiptType: "ACCOUNTING_CASE_RECOVERY_RELEASED",
        previousExecutionRequestId: input.requestId,
        reason: clone(input.reasonReceipt),
    };
    delete updated.terminalSummary;
    updated.updatedAt = input.now;
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async completeExpiredTargetAccountingCaseRecovery(
    input: CompleteExpiredTargetAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.reasonReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Expired-target recovery completion receipt is invalid.", {
        httpStatus: 422,
      });
    }
    const repositoryNow = this.#statementTimestamp();
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseAccessIdentity(aggregate.binding, input.currentAccessBinding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found for recovery completion.", { httpStatus: 404 });
    }
    if (!this.#isLiveAccountingCaseTarget(input.currentAccessBinding, repositoryNow)) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Recovery successor target is not live.", { httpStatus: 409 });
    }
    if (
      aggregate.binding.targetSessionHash === input.currentAccessBinding.targetSessionHash ||
      aggregate.binding.targetSessionExpiresAt > repositoryNow
    ) {
      throw new AppError("CONFLICT", "Expired-target recovery completion requires an expired original target.", {
        httpStatus: 409,
      });
    }
    if (aggregate.currentVersion !== input.version) {
      throw new AppError("CONFLICT", "Only the current Accounting Case version can complete recovery.", {
        httpStatus: 409,
      });
    }
    const record = aggregate.versions.get(input.version);
    if (!record || record.state !== "RECOVERY_REQUIRED" || record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case recovery completion does not own the execution claim.", {
        httpStatus: 409,
      });
    }
    const residual = record.operations
      .filter((operation) => operation.state === "PREPARED")
      .sort((left, right) => left.ordinal - right.ordinal);
    if (
      residual.length === 0 ||
      record.operations.some((operation) =>
        !["PREPARED", "READBACK_VERIFIED", "NO_WRITE_REQUIRED"].includes(operation.state)) ||
      !record.operations.some((operation) => operation.state === "READBACK_VERIFIED")
    ) {
      throw new AppError("CONFLICT", "Expired-target recovery is not fully GET-resolved to residual no-write intent.", {
        httpStatus: 409,
      });
    }
    const residualOperationIds = residual.map((operation) => operation.operation.operationId);
    for (const operation of residual) {
      const preparation = operation.preparationId
        ? this.#xeroMutationPreparations.get(operation.preparationId)
        : undefined;
      const requests = operation.preparationId
        ? [...this.#xeroMutationRequests.values()].filter((request) => request.preparationId === operation.preparationId)
        : [];
      if (
        !preparation ||
        !["PREPARED", "EXPIRED"].includes(preparation.state) ||
        requests.length !== 0 ||
        preparation.actorId !== aggregate.binding.actorId ||
        preparation.workspaceId !== aggregate.binding.workspaceId ||
        preparation.tenantId !== aggregate.binding.tenantId ||
        preparation.installationId !== aggregate.binding.installationId ||
        preparation.bindingId !== aggregate.binding.bindingId ||
        preparation.bindingRevision !== aggregate.binding.bindingRevision ||
        preparation.connectionId !== aggregate.binding.connectionId ||
        preparation.targetSessionId !== aggregate.binding.targetSessionId ||
        preparation.sourceRef !== `case:${input.caseId}` ||
        preparation.sourceUnitKey !== operation.operation.operationId ||
        preparation.canonicalPayloadHash !== operation.preparationCanonicalPayloadHash ||
        preparation.sourceSha256 !== operation.sourceSha256
      ) {
        throw new AppError("CONFLICT", "Residual operation is not an exact zero-request expired-target preparation.", {
          httpStatus: 409,
        });
      }
    }

    let grant: AccountingCaseRecoveryResidualGrant | undefined;
    if (input.continuation) {
      let expectedTemplate;
      try {
        expectedTemplate = accountingCaseRecoveryResidualContinuationTemplate({
          source: record.compiled,
          successorCaseId: input.continuation.successorCaseId,
          residualOperationIds,
        });
      } catch (error) {
        throw new AppError("VALIDATION_FAILED", "Recovery residual continuation is not representable.", {
          httpStatus: 422,
          cause: error,
        });
      }
      if (
        !/^acrg_[0-9a-f]{64}$/u.test(input.continuation.grantId) ||
        !/^recovery-[0-9a-f]{64}$/u.test(input.continuation.successorCaseId) ||
        input.continuation.templateHash !== accountingCaseContinuationTemplateHash(input.continuation.template) ||
        input.continuation.templateHash !== accountingCaseContinuationTemplateHash(expectedTemplate) ||
        stableStringify(input.continuation.template) !== stableStringify(expectedTemplate)
      ) {
        throw new AppError("VALIDATION_FAILED", "Recovery residual continuation evidence is invalid.", {
          httpStatus: 422,
        });
      }
      const existing = this.#accountingCaseRecoveryResidualGrants.get(input.continuation.successorCaseId);
      if (existing) {
        throw new AppError("CONFLICT", "Recovery residual continuation successor is already reserved.", {
          httpStatus: 409,
        });
      }
      if ([...this.#accountingCaseRecoveryResidualGrants.values()].some((candidate) =>
        candidate.sourceCaseId === input.caseId && candidate.sourceVersion === input.version)) {
        throw new AppError("CONFLICT", "Accounting Case recovery residual continuation already exists.", {
          httpStatus: 409,
        });
      }
      grant = {
        grantId: input.continuation.grantId,
        sourceCaseId: input.caseId,
        sourceVersion: input.version,
        sourcePlanHash: record.compiledPlanHash,
        successorCaseId: input.continuation.successorCaseId,
        residualOperationIds,
        template: clone(input.continuation.template),
        templateHash: input.continuation.templateHash,
        successorBinding: clone(input.currentAccessBinding),
        state: "ISSUED",
        createdAt: repositoryNow,
        updatedAt: repositoryNow,
      };
    }

    const operations = record.operations.map((operation) => {
      if (operation.state !== "PREPARED" || !operation.preparationId) return clone(operation);
      return {
        ...clone(operation),
        state: "NOT_EXECUTED_AFTER_TARGET_EXPIRY" as const,
        errorReceipt: {
          receiptType: "ACCOUNTING_CASE_EXPIRED_TARGET_RESIDUAL_NO_WRITE",
          reasonCodes: [grant
            ? "EXPIRED_TARGET_RECOVERY_CONTINUED_TO_SUCCESSOR"
            : "EXPIRED_TARGET_RECOVERY_REQUIRES_MANUAL_REPREPARATION"],
          recoveryAction: grant
            ? "PREPARE_RECOVERY_SUCCESSOR_CASE"
            : "PREPARE_NEW_ACCOUNTING_CASE",
          providerMutationPossible: false,
          mutationRequestAbsent: true,
          providerCallAbsentByPermitInvariant: true,
          ...(grant ? { grantId: grant.grantId, successorCaseId: grant.successorCaseId } : {}),
          reason: clone(input.reasonReceipt),
        },
        updatedAt: repositoryNow,
      } satisfies AccountingCaseOperationRecord;
    });
    const terminalBase: AccountingCaseVersionRecord = {
      ...clone(record),
      state: "TERMINAL",
      operations,
      ...(grant ? { recoveryResidualGrant: clone(grant) } : {}),
      updatedAt: repositoryNow,
    };
    const terminal: AccountingCaseVersionRecord = {
      ...terminalBase,
      terminalSummary: accountingCaseTerminalSummary(terminalBase, "TERMINAL"),
    };
    assertAccountingCasePreflightIntegrity(terminal);
    for (const operation of residual) {
      const preparation = this.#xeroMutationPreparations.get(operation.preparationId!)!;
      this.#xeroMutationPreparations.set(preparation.preparationId, {
        ...clone(preparation),
        state: "EXPIRED",
        updatedAt: repositoryNow,
      });
    }
    if (grant) this.#accountingCaseRecoveryResidualGrants.set(grant.successorCaseId, clone(grant));
    const storedTerminal = clone(terminal);
    delete storedTerminal.recoveryResidualGrant;
    aggregate.versions.set(input.version, storedTerminal);
    return clone(terminal);
  }

  async getAccountingCaseRecoveryResidualGrant(
    input: GetAccountingCaseRecoveryResidualGrantInput,
  ): Promise<GetAccountingCaseRecoveryResidualGrantResult | undefined> {
    const repositoryNow = this.#statementTimestamp();
    const grant = this.#accountingCaseRecoveryResidualGrants.get(input.successorCaseId);
    if (
      !grant ||
      !sameAccountingCaseBinding(grant.successorBinding, input.currentAccessBinding) ||
      !this.#isLiveAccountingCaseTarget(input.currentAccessBinding, repositoryNow)
    ) return undefined;
    const aggregate = this.#accountingCases.get(grant.sourceCaseId);
    const source = aggregate?.versions.get(grant.sourceVersion);
    if (
      !aggregate || !source || source.state !== "TERMINAL" ||
      !sameAccountingCaseAccessIdentity(aggregate.binding, input.currentAccessBinding) ||
      source.compiledPlanHash !== grant.sourcePlanHash
    ) return undefined;
    return {
      grant: clone(grant),
      source: { ...clone(source), recoveryResidualGrant: clone(grant) },
    };
  }

  async awaitAccountingCaseContinuation(
    input: AwaitAccountingCaseContinuationInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || !isNonEmpty(input.requestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case continuation evidence is invalid.", { httpStatus: 422 });
    }
    const aggregate = this.#accountingCases.get(input.caseId);
    if (!aggregate || !sameAccountingCaseBinding(aggregate.binding, input.binding)) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.state === "AWAITING_CONTINUATION" && record.executionRequestId === input.requestId) {
      return clone(record);
    }
    if (record.state !== "EXECUTING" || record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case continuation request does not own the execution claim.", {
        httpStatus: 409,
      });
    }
    if (
      !hasAccountingCaseDependentContinuation(record.compiled) ||
      record.operations.length === 0 ||
      record.operations.some((operation) =>
        operation.state !== "READBACK_VERIFIED" && operation.state !== "NO_WRITE_REQUIRED")
    ) {
      throw new AppError("CONFLICT", "Accounting Case cannot await continuation without verified writes and dependent residual work.", {
        httpStatus: 409,
      });
    }
    const updated: AccountingCaseVersionRecord = {
      ...record,
      state: "AWAITING_CONTINUATION",
      updatedAt: input.now,
    };
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async finalizeAccountingCase(input: FinalizeAccountingCaseInput): Promise<AccountingCaseVersionRecord> {
    const aggregate = this.#accountingCases.get(input.caseId);
    const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
    const bindingMatches = aggregate && (recoveryAccess
      ? sameAccountingCaseAccessIdentity(aggregate.binding, input.binding)
      : sameAccountingCaseBinding(aggregate.binding, input.binding));
    if (!aggregate || !bindingMatches ||
        (recoveryAccess && !this.#isLiveAccountingCaseTarget(input.binding, input.now))) {
      throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    }
    const record = aggregate.versions.get(input.version);
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case version was not found.", { httpStatus: 404 });
    if (record.executionRequestId !== input.requestId) {
      throw new AppError("CONFLICT", "Accounting Case finalization request does not own the execution claim.", {
        httpStatus: 409,
      });
    }
    const terminalSummary = accountingCaseTerminalSummary(record, input.state);
    if (record.state === input.state && record.terminalSummary && sameJson(record.terminalSummary, terminalSummary)) {
      return clone(record);
    }
    if (recoveryAccess && record.state !== "RECOVERY_REQUIRED") {
      throw new AppError("CONFLICT", "Current-access finalization is recovery-only.", { httpStatus: 409 });
    }
    if (!["EXECUTING", "RECOVERY_REQUIRED"].includes(record.state)) {
      throw new AppError("CONFLICT", `Accounting Case cannot finalize from ${record.state}.`, { httpStatus: 409 });
    }
    const uncertainStates = new Set(["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]);
    const unfinishedStates = new Set(["PENDING", "PREPARED", "WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]);
    const completedStates = new Set(["READBACK_VERIFIED", "NO_WRITE_REQUIRED"]);
    const failedStates = new Set(["PROVIDER_REJECTED", "BLOCKED_VALIDATION"]);
    const hasUncertain = record.operations.some((operation) => uncertainStates.has(operation.state));
    const hasUnfinished = record.operations.some((operation) => unfinishedStates.has(operation.state));
    const hasCompleted = record.operations.some((operation) => completedStates.has(operation.state));
    const hasFailed = record.operations.some((operation) => failedStates.has(operation.state));
    if (input.state === "RECOVERY_REQUIRED" && !hasUncertain) {
      throw new AppError("CONFLICT", "Accounting Case recovery requires an uncertain or mismatched write.", {
        httpStatus: 409,
      });
    }
    if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(input.state) && hasUnfinished) {
      throw new AppError("CONFLICT", "Accounting Case cannot be terminal while write operations are unfinished.", {
        httpStatus: 409,
      });
    }
    if (input.state === "PARTIALLY_COMMITTED" && (!hasCompleted || !hasFailed)) {
      throw new AppError("CONFLICT", "A partially committed Accounting Case requires both completed and definitely failed operations.", {
        httpStatus: 409,
      });
    }
    if (input.state === "TERMINAL" && hasCompleted && hasFailed) {
      throw new AppError("CONFLICT", "A mixed completed/failed Accounting Case must be finalized as partially committed.", {
        httpStatus: 409,
      });
    }
    const updated: AccountingCaseVersionRecord = {
      ...record,
      state: input.state,
      terminalSummary: clone(terminalSummary),
      updatedAt: input.now,
    };
    aggregate.versions.set(input.version, clone(updated));
    return clone(updated);
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    if (this.audits.some((audit) => audit.callId === record.callId)) {
      throw new AppError("CONFLICT", "Audit call identifier already exists.", { httpStatus: 409 });
    }
    this.audits.push(clone(record));
  }

  async beginAudit(intent: AuditIntent): Promise<void> {
    if (this.audits.some((audit) => audit.callId === intent.callId)) {
      throw new AppError("CONFLICT", "Audit call identifier already exists.", { httpStatus: 409 });
    }
    this.audits.push(clone(intent));
  }

  async completeAudit(callId: string, completion: AuditCompletion): Promise<void> {
    const index = this.audits.findIndex((audit) => audit.callId === callId);
    if (index < 0) {
      throw new AppError("NOT_FOUND", "Audit intent was not found.", { httpStatus: 404 });
    }
    const intent = this.audits[index];
    if (!intent || intent.resultStatus !== "IN_PROGRESS") {
      throw new AppError("CONFLICT", "Audit intent is already complete.", { httpStatus: 409 });
    }
    this.audits[index] = clone({ ...intent, ...completion });
  }

  async appendGovernanceAuditEvent(input: GovernanceAuditEventInput): Promise<GovernanceAuditEvent> {
    if (this.governanceAuditEvents.some((event) => event.eventId === input.eventId)) {
      throw new AppError("CONFLICT", "Governance audit event identifier already exists.", { httpStatus: 409 });
    }
    const previousEventHash = [...this.governanceAuditEvents]
      .reverse()
      .find((event) => event.streamId === input.streamId)?.eventHash;
    const recordedAt = new Date();
    const event: GovernanceAuditEvent = {
      ...clone(input),
      ...(previousEventHash ? { previousEventHash } : {}),
      eventHash: governanceAuditEventHash(input, previousEventHash, recordedAt),
      recordedAt,
    };
    this.governanceAuditEvents.push(event);
    return clone(event);
  }

  #resolveActiveBinding(
    input: ResolveAgentConnectionBindingInput,
  ): ResolvedAgentConnectionBinding | undefined {
    const binding = this.#agentConnectionBindings.get(input.bindingId);
    const installation = this.#oauthInstallations.get(input.installationId);
    const connection = this.#authorizedConnections.get(input.connectionId);
    const authorization = connection
      ? this.#providerAuthorizations.get(connection.authorizationId)
      : undefined;
    if (
      !binding ||
      binding.status !== "ACTIVE" ||
      binding.installationId !== input.installationId ||
      binding.workspaceId !== input.workspaceId ||
      binding.subjectType !== input.subjectType ||
      binding.subjectId !== input.subjectId ||
      binding.agentId !== input.agentId ||
      binding.connectionId !== input.connectionId ||
      !installation ||
      installation.status !== "ACTIVE" ||
      installation.workspaceId !== input.workspaceId ||
      installation.subjectType !== input.subjectType ||
      installation.subjectId !== input.subjectId ||
      installation.agentId !== input.agentId ||
      !connection ||
      connection.status !== "ACTIVE" ||
      !authorization ||
      authorization.status !== "ACTIVE" ||
      authorization.workspaceId !== input.workspaceId
    ) {
      return undefined;
    }
    const resolved: ResolvedAgentConnectionBinding = {
      installationId: installation.installationId,
      bindingId: binding.bindingId,
      bindingRevision: this.#currentBindingRevision(installation.installationId),
      workspaceId: binding.workspaceId,
      subjectType: binding.subjectType,
      subjectId: binding.subjectId,
      agentId: binding.agentId,
      connectionId: connection.connectionId,
      authorizationId: authorization.authorizationId,
      tenantId: connection.tenantId,
      tenantName: connection.tenantName,
      policyId: binding.policyId,
    };
    if (connection.providerConnectionId) resolved.providerConnectionId = connection.providerConnectionId;
    return resolved;
  }

  #resolveActiveBindingByTuple(
    installationId: string,
    bindingId: string,
    connectionId: string,
  ): ResolvedAgentConnectionBinding | undefined {
    const binding = this.#agentConnectionBindings.get(bindingId);
    if (!binding) return undefined;
    return this.#resolveActiveBinding({
      installationId,
      bindingId,
      workspaceId: binding.workspaceId,
      subjectType: binding.subjectType,
      subjectId: binding.subjectId,
      agentId: binding.agentId,
      connectionId,
    });
  }

  #currentBindingId(installationId: string): string {
    const explicit = this.#activeBindingIds.get(installationId);
    if (explicit) return explicit;
    return [...this.#agentConnectionBindings.values()].find(
      (binding) => binding.installationId === installationId && binding.status === "ACTIVE",
    )?.bindingId ?? "";
  }

  #currentBindingRevision(installationId: string): number {
    const explicit = this.#activeBindingRevisions.get(installationId);
    if (explicit !== undefined) return explicit;
    // Compatibility for in-memory fixtures created before active-binding epochs were tracked.
    return this.#currentBindingId(installationId) ? 1 : 0;
  }

  #requireActiveBindingTuple(
    installationId: string,
    bindingId: string,
    connectionId: string,
  ): ResolvedAgentConnectionBinding {
    const resolved = this.#resolveActiveBindingByTuple(installationId, bindingId, connectionId);
    if (!resolved) {
      throw new AppError("FORBIDDEN", "OAuth token grant does not match an active installation and binding.", {
        httpStatus: 403,
      });
    }
    return resolved;
  }

  #revokeRefreshFamily(familyId: string, revokedAt: Date, replayDetectedAt?: Date): void {
    const family = this.#mcpRefreshTokenFamilies.get(familyId);
    if (!family) return;
    const revoked: McpRefreshTokenFamily = {
      ...family,
      status: "REVOKED",
      revokedAt: family.revokedAt ?? revokedAt,
      updatedAt: revokedAt,
    };
    const effectiveReplay = family.replayDetectedAt ?? replayDetectedAt;
    if (effectiveReplay) revoked.replayDetectedAt = effectiveReplay;
    this.#mcpRefreshTokenFamilies.set(familyId, revoked);
    for (const [tokenHash, token] of this.#mcpRefreshTokens) {
      if (token.familyId === familyId && !token.revokedAt) {
        this.#mcpRefreshTokens.set(tokenHash, { ...token, revokedAt });
      }
    }
    for (const [tokenHash, token] of this.#mcpAccessTokens) {
      if (token.refreshFamilyId === familyId && !token.revokedAt) {
        this.#mcpAccessTokens.set(tokenHash, { ...token, revokedAt });
      }
    }
  }

  /** Exact-family validation selects the installation-wide MCP grant boundary to disconnect. */
  #revokeRefreshGrant(familyId: string, revokedAt: Date, replayDetectedAt?: Date): void {
    const family = this.#mcpRefreshTokenFamilies.get(familyId);
    if (!family) return;
    for (const candidate of this.#mcpRefreshTokenFamilies.values()) {
      if (candidate.installationId === family.installationId) {
        this.#revokeRefreshFamily(
          candidate.familyId,
          revokedAt,
          candidate.familyId === familyId ? replayDetectedAt : undefined,
        );
      }
    }

    const installation = this.#oauthInstallations.get(family.installationId);
    if (installation && installation.status !== "REVOKED") {
      this.#oauthInstallations.set(family.installationId, {
        ...installation,
        status: "REVOKED",
        revokedAt,
        updatedAt: revokedAt,
      });
    }
    for (const [bindingId, binding] of this.#agentConnectionBindings) {
      if (binding.installationId === family.installationId && binding.status !== "REVOKED") {
        this.#agentConnectionBindings.set(bindingId, {
          ...binding,
          status: "REVOKED",
          revokedAt,
          updatedAt: revokedAt,
        });
      }
    }
  }

  #revokePendingBrokerGrant(flow: OAuthBrokerAuthorizationFlow, revokedAt: Date): void {
    if (flow.status !== "AWAITING_SELECTION" || !flow.authorizationId) return;
    const installation = this.#oauthInstallations.get(flow.installationId);
    const authorization = this.#providerAuthorizations.get(flow.authorizationId);
    if (
      !installation ||
      installation.status !== "PENDING" ||
      installation.workspaceId !== flow.workspaceId ||
      installation.subjectType !== flow.subjectType ||
      installation.subjectId !== flow.subjectId ||
      installation.agentId !== flow.agentId ||
      installation.clientId !== flow.clientId ||
      !authorization ||
      authorization.workspaceId !== flow.workspaceId ||
      authorization.authorizedBySubject !== flow.subjectId
    ) return;

    this.#oauthInstallations.set(installation.installationId, {
      ...installation,
      status: "REVOKED",
      revokedAt,
      updatedAt: revokedAt,
    });
    this.#providerAuthorizations.set(authorization.authorizationId, {
      ...authorization,
      status: "REVOKED",
      revokedAt: authorization.revokedAt ?? revokedAt,
      updatedAt: revokedAt,
    });
    for (const [connectionId, connection] of this.#authorizedConnections) {
      if (connection.authorizationId === authorization.authorizationId && connection.status !== "REVOKED") {
        this.#authorizedConnections.set(connectionId, {
          ...connection,
          status: "REVOKED",
          updatedAt: revokedAt,
        });
      }
    }
  }

  #requirePosting(postingRequestId: string): PostingRequest {
    const posting = this.#postings.get(postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
    return posting;
  }

  #isLiveAccountingCaseTarget(binding: AccountingCaseBinding, now: Date): boolean {
    if (!isValidDate(now) || binding.targetSessionExpiresAt <= now) return false;
    const session = this.#ledgerTargetSessions.get(binding.targetSessionHash);
    const activeBinding = this.#resolveActiveBindingByTuple(
      binding.installationId,
      binding.bindingId,
      binding.connectionId,
    );
    return Boolean(
      session && !session.revokedAt && session.expiresAt > now &&
      session.sessionId === binding.targetSessionId &&
      session.installationId === binding.installationId &&
      session.bindingId === binding.bindingId &&
      session.bindingRevision === binding.bindingRevision &&
      session.connectionId === binding.connectionId &&
      session.expiresAt.getTime() === binding.targetSessionExpiresAt.getTime() &&
      activeBinding && activeBinding.bindingRevision === binding.bindingRevision &&
      activeBinding.workspaceId === binding.workspaceId &&
      activeBinding.subjectType === binding.subjectType &&
      activeBinding.subjectId === binding.subjectId && activeBinding.agentId === binding.agentId &&
      activeBinding.tenantId === binding.tenantId,
    );
  }

  #xeroMutationRequestKey(input: Pick<
    ConfirmXeroMutationPreparationInput,
    "actorId" | "tenantId" | "objectType" | "operation" | "requestId"
  >): string {
    return [input.actorId, input.tenantId, input.objectType, input.operation, input.requestId].join("\u001f");
  }

  #requireBoundXeroMutationRequest(input: BoundXeroMutationRequestInput): XeroMutationRequest {
    const request = this.#xeroMutationRequests.get(input.mutationRequestId);
    if (!request) {
      throw new AppError("NOT_FOUND", "Mutation request is unavailable for this binding.", { httpStatus: 404 });
    }
    if (!sameMutationBinding(request, input)) {
      throw new AppError("FORBIDDEN", "Mutation request does not match the active OAuth binding.", {
        httpStatus: 403,
      });
    }
    return request;
  }

  #assertCompatibleMutationEvidence(
    request: XeroMutationRequest,
    xeroObjectId?: string,
    writeReceipt?: Record<string, unknown>,
  ): void {
    if (
      request.operation === "UPDATE" &&
      xeroObjectId &&
      request.targetXeroObjectId !== xeroObjectId
    ) {
      throw new AppError("CONFLICT", "UPDATE result does not match its immutable Xero target.", {
        httpStatus: 409,
      });
    }
    if (xeroObjectId && request.xeroObjectId && request.xeroObjectId !== xeroObjectId) {
      throw new AppError("CONFLICT", "Mutation cannot replace its exact Xero object identifier.", {
        httpStatus: 409,
      });
    }
    if (writeReceipt && request.writeReceipt && !sameJson(request.writeReceipt, writeReceipt)) {
      throw new AppError("CONFLICT", "Mutation cannot replace previously recorded write evidence.", {
        httpStatus: 409,
      });
    }
  }

  #assertExactCompletedMutation(
    request: XeroMutationRequest,
    input: CompleteXeroMutationReadbackInput,
  ): void {
    if (
      request.xeroObjectId !== input.xeroObjectId ||
      request.readbackStatus !== input.readbackStatus ||
      request.readbackSnapshotHash !== input.readbackSnapshotHash ||
      request.readbackPayloadHash !== input.readbackPayloadHash ||
      !request.writeReceipt ||
      !request.readbackSnapshot ||
      !request.readbackCanonicalPayload ||
      !sameJson(request.writeReceipt, input.writeReceipt) ||
      !sameJson(request.readbackSnapshot, input.readbackSnapshot) ||
      !sameJson(request.readbackCanonicalPayload, input.readbackCanonicalPayload)
    ) {
      throw new AppError("CONFLICT", "Completed mutation evidence cannot be replaced.", { httpStatus: 409 });
    }
  }

  #assertExactMismatchEvidence(
    request: XeroMutationRequest,
    input: CompleteXeroMutationReadbackInput,
  ): void {
    if (
      request.xeroObjectId !== input.xeroObjectId ||
      request.readbackStatus !== input.readbackStatus ||
      request.readbackSnapshotHash !== input.readbackSnapshotHash ||
      request.readbackPayloadHash !== input.readbackPayloadHash ||
      !request.writeReceipt ||
      !request.readbackSnapshot ||
      !request.readbackCanonicalPayload ||
      !sameJson(request.writeReceipt, input.writeReceipt) ||
      !sameJson(request.readbackSnapshot, input.readbackSnapshot) ||
      !sameJson(request.readbackCanonicalPayload, input.readbackCanonicalPayload)
    ) {
      throw new AppError("CONFLICT", "Mismatch evidence cannot be replaced without a verified recovery.", {
        httpStatus: 409,
      });
    }
  }

  #assertXeroMutationObjectIdAvailable(request: XeroMutationRequest, xeroObjectId: string): void {
    const conflict = [...this.#xeroMutationRequests.values()].find((candidate) => {
      if (
        candidate.mutationRequestId === request.mutationRequestId ||
        candidate.tenantId !== request.tenantId ||
        candidate.objectType !== request.objectType ||
        candidate.xeroObjectId !== xeroObjectId
      ) return false;
      if (request.operation !== "UPDATE") return true;
      return ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(candidate.state);
    });
    if (conflict) {
      throw new AppError("CONFLICT", "The exact Xero object is already bound to another mutation.", {
        httpStatus: 409,
      });
    }
  }

  #assertAuthoriseIdentity(posting: PostingRequest, input: BeginAuthoriseInput): void {
    if (
      posting.actorId !== input.actorId ||
      posting.tenantId !== input.tenantId ||
      posting.xeroInvoiceId !== input.invoiceId
    ) {
      throw new AppError("FORBIDDEN", "Posting request does not match the selected actor, tenant, and invoice.", {
        httpStatus: 403,
      });
    }
  }

  #assertApprovalBinding(posting: PostingRequest, input: BeginAuthoriseInput): void {
    if (
      posting.approvalRefHash !== input.approvalRefHash ||
      posting.providerPayloadHash !== input.approvedPayloadHash
    ) {
      throw new AppError("APPROVAL_INVALID", "Approval is not bound to this payload and request.", {
        httpStatus: 409,
      });
    }
  }

  #assertReviewResumeBinding(posting: PostingRequest, input: BeginReviewAuthoriseInput): void {
    if (
      !posting.approvalRefHash ||
      posting.authoriseRequestId !== input.requestId ||
      posting.authoriseIdempotencyKey !== input.idempotencyKey
    ) {
      throw new AppError("CONFLICT", "Review recovery does not match the original authorisation attempt.", {
        httpStatus: 409,
      });
    }
  }
}
