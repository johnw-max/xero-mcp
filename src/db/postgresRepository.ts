import pg, { type PoolClient } from "pg";
import { AppError } from "../errors.js";
import type {
  AgentConnectionBinding,
  AuditCompletion,
  AuditIntent,
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
import { expectedXeroMutationReadbackStatus, xeroMutationTargetsExistingObject } from "../domain/xeroMutation.js";
import type {
  AdoptExpiredExecutingAccountingCaseForRecoveryInput,
  AdoptExpiredExecutingAccountingCaseForRecoveryResult,
  AccountingCaseBinding,
  AccountingCaseOperationRecord,
  AccountingCaseOperationState,
  AccountingCasePreflightResealReceipt,
  AccountingCaseSourceCaseClaim,
  AccountingCaseSourceCaseReference,
  AccountingCaseVersionRecord,
  ClaimAccountingCaseExecutionInput,
  ClaimAccountingCaseExecutionResult,
  CompleteExpiredTargetAccountingCaseRecoveryInput,
  BindAccountingCaseSourceCaseInput,
  BindAccountingCaseSourceCaseResult,
  CreateOrAdvanceAccountingCaseInput,
  CreateOrAdvanceAccountingCaseResult,
  AwaitAccountingCaseContinuationInput,
  FinalizeAccountingCaseInput,
  GetAccessibleAccountingCaseInput,
  GetBoundAccountingCaseInput,
  GetAccountingCaseRecoveryResidualGrantInput,
  GetAccountingCaseRecoveryResidualGrantResult,
  ListAttentionAccountingCasesInput,
  ListAttentionAccountingCasesResult,
  PauseAccountingCaseExecutionInput,
  ProjectAccountingCaseOperationFromMutationInput,
  RecordAccountingCasePreflightInput,
  RecordAccountingCasePreflightResult,
  ResealAndClaimAccountingCaseExecutionInput,
  ResealAndClaimAccountingCaseExecutionResult,
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
  ACCOUNTING_CASE_ATTENTION_OPERATION_STATES,
  ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS,
  ACCOUNTING_CASE_SOURCE_CASE_CLAIMS,
  accountingCaseMutationRoute,
  accountingCasePlanHash,
  accountingCasePreflightReceiptHash,
  accountingCasePreflightResealReceiptHash,
  accountingCaseTerminalSummary,
  sameAccountingCaseSourceCaseReference,
} from "../domain/accountingCasePersistence.js";
import {
  createLedgerAuthoritySnapshot,
  exactFirmGovernanceAuthorityFromSnapshot,
  legacyLedgerAuthoritySnapshotV1Hash,
  ledgerFirmGovernanceReadinessEvidence,
  type LedgerAuthoritySnapshot,
  type LedgerAuthorityRepositoryReadiness,
  type PublishLedgerAuthoritySnapshotInput,
  type PublishLedgerAuthoritySnapshotResult,
} from "../domain/ledgerAuthority.js";
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
import { REQUIRED_MIGRATIONS } from "./requiredMigrations.js";
import { ACTIVE_XERO_DUPLICATE_STATES, xeroSupplierPostingIdentity } from "./xeroPostingDuplicate.js";
import {
  hasExactXeroDuplicateIndexes,
  type XeroDuplicateIndexCatalogRow,
} from "./xeroDuplicateIndexReadiness.js";
import {
  activeAccountingCaseRecoveryProjectionEvidenceFromPostgres,
  unknownActiveAccountingCaseRecoveryProjectionEvidence,
  type PostgresActiveRecoveryProjectionRow,
} from "./accountingCaseRecoveryProjectionReadiness.js";
import { XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION } from "../policy/xeroAccountingCaseProviderContract.js";
import { XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION } from "../policy/xeroDeclaredLedgerPolicy.js";
import { validateXeroAccountingCaseReadbackEconomics } from "../policy/xeroAccountingCaseReadbackProjection.js";
import type { AccountingCaseBusinessReservation } from "../domain/accountingCase.js";
import { xeroExistingDocumentNoWriteEvidenceMatches } from "../policy/xeroAccountingCaseExistingDocumentEvidence.js";

const { Pool } = pg;
type Row = Record<string, unknown>;

const EPHEMERAL_CLEANUP_ADVISORY_LOCK_KEY = "2026080401";

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

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AppError("CONFIGURATION_ERROR", `The database returned an invalid ${field}.`, {
      httpStatus: 500,
    });
  }
  return parsed;
}

function isScopeSubset(candidate: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return candidate.every((scope) => allowedSet.has(scope));
}

function hasSameScopes(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((scope) => rightSet.has(scope));
}

const OAUTH_AUTHORIZATION_CODE_MAX_TTL_MS = 5 * 60 * 1_000;
const PERSONAL_POC_SELECTION_ADVISORY_LOCK_KEY = "2026080502";
const MCP_REFRESH_FAMILY_ADVISORY_SALT = "2026080504";

function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sameOptionalJson(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameJson(left, right);
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isPostgresConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ["23503", "23505", "23514"].includes(String(error.code));
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isHashedValue(value: string | undefined): value is string {
  return isNonEmpty(value) && value.length >= 32;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function mapLedgerAuthoritySnapshot(row: Row): LedgerAuthoritySnapshot {
  if (!Array.isArray(row.standing_delegations)) {
    throw new AppError("PERSISTENCE_FAILURE", "Ledger authority snapshot payload is invalid.", { httpStatus: 503 });
  }
  const standingDelegations = row.standing_delegations.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger authority delegation payload is invalid.", { httpStatus: 503 });
    }
    const item = value as Record<string, unknown>;
    const rawRequirements = item.firmGovernanceRequirements;
    if (rawRequirements !== undefined && !Array.isArray(rawRequirements)) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger firm-governance requirements payload is invalid.", {
        httpStatus: 503,
      });
    }
    const firmGovernanceRequirements = (rawRequirements as unknown[] | undefined)?.map((rawRequirement) => {
      if (typeof rawRequirement !== "object" || rawRequirement === null || Array.isArray(rawRequirement)) {
        throw new AppError("PERSISTENCE_FAILURE", "Ledger firm-governance requirement payload is invalid.", {
          httpStatus: 503,
        });
      }
      const requirement = rawRequirement as Record<string, unknown>;
      return {
        actionId: String(requirement.actionId),
        route: String(requirement.route),
        referenceKind: String(requirement.referenceKind),
        authoritativeProviderField: String(requirement.authoritativeProviderField),
      };
    });
    const rawAuthorities = item.firmGovernanceAuthorities;
    if (rawAuthorities !== undefined && !Array.isArray(rawAuthorities)) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger firm-governance authority payload is invalid.", {
        httpStatus: 503,
      });
    }
    const firmGovernanceAuthorities = (rawAuthorities as unknown[] | undefined)?.map((rawAuthority) => {
      if (typeof rawAuthority !== "object" || rawAuthority === null || Array.isArray(rawAuthority)) {
        throw new AppError("PERSISTENCE_FAILURE", "Ledger firm-governance authority payload is invalid.", {
          httpStatus: 503,
        });
      }
      const authority = rawAuthority as Record<string, unknown>;
      if (!Array.isArray(authority.recurringSeriesAuthorities) ||
          typeof authority.firmGovernanceStatement !== "object" ||
          authority.firmGovernanceStatement === null || Array.isArray(authority.firmGovernanceStatement)) {
        throw new AppError("PERSISTENCE_FAILURE", "Ledger firm-governance authority payload is invalid.", {
          httpStatus: 503,
        });
      }
      return {
        schemaVersion: String(authority.schemaVersion) as "ledger-firm-governance-authority:v1",
        providerId: String(authority.providerId),
        tenantId: String(authority.tenantId),
        authorityId: String(authority.authorityId),
        revision: positiveSafeInteger(authority.revision, "firm-governance authority revision"),
        providerAtomicUniqueness: authority.providerAtomicUniqueness as false,
        route: String(authority.route),
        referenceKind: String(authority.referenceKind),
        authoritativeProviderField: String(authority.authoritativeProviderField),
        writerId: String(authority.writerId),
        writerKind: String(authority.writerKind) as "XERO_MCP_INSTALLATION",
        workspaceId: String(authority.workspaceId),
        agentId: String(authority.agentId),
        installationId: String(authority.installationId),
        coordinationDomainId: String(authority.coordinationDomainId),
        receiptClaimsSha256: String(authority.receiptClaimsSha256),
        statusClaimsSha256: String(authority.statusClaimsSha256),
        trustBundleFileSha256: String(authority.trustBundleFileSha256),
        receiptsFileSha256: String(authority.receiptsFileSha256),
        statusFileSha256: String(authority.statusFileSha256),
        effectiveExpiresAt: date(authority.effectiveExpiresAt),
        firmGovernanceStatement: authority.firmGovernanceStatement as {
          allNonEnumeratedWritersProhibited: true;
          humanXeroUiWritesProhibited: true;
          externalAppWritesProhibited: true;
          importWritesProhibited: true;
        },
        recurringSeriesAuthorities: authority.recurringSeriesAuthorities.map((rawSeries) => {
          if (typeof rawSeries !== "object" || rawSeries === null || Array.isArray(rawSeries)) {
            throw new AppError("PERSISTENCE_FAILURE", "Ledger recurring authority payload is invalid.", {
              httpStatus: 503,
            });
          }
          const series = rawSeries as Record<string, unknown>;
          return {
            authorityId: String(series.authorityId),
            revision: positiveSafeInteger(series.revision, "recurring authority revision"),
            route: String(series.route),
            contactId: String(series.contactId),
            normalizedReference: String(series.normalizedReference),
            authoritativeProviderField: String(series.authoritativeProviderField),
            normalizationVersion: String(series.normalizationVersion),
            occurrenceKey: String(series.occurrenceKey) as "DOCUMENT_DATE",
          };
        }),
      };
    });
    return {
      delegationId: String(item.delegationId),
      revision: positiveSafeInteger(item.revision, "ledger authority delegation revision"),
      status: String(item.status) as "ACTIVE" | "REVOKED",
      providerId: String(item.providerId),
      workspaceId: String(item.workspaceId),
      agentId: String(item.agentId),
      ...(item.installationId !== undefined ? { installationId: String(item.installationId) } : {}),
      ...(item.writerId !== undefined ? { writerId: String(item.writerId) } : {}),
      ...(item.coordinationDomainId !== undefined
        ? { coordinationDomainId: String(item.coordinationDomainId) }
        : {}),
      tenantIds: stringArray(item.tenantIds),
      actionIds: stringArray(item.actionIds),
      ...(item.expiresAt !== undefined ? { expiresAt: date(item.expiresAt) } : {}),
      ...(item.firmGovernanceRequired === true ? { firmGovernanceRequired: true as const } : {}),
      ...(firmGovernanceRequirements ? { firmGovernanceRequirements } : {}),
      ...(firmGovernanceAuthorities ? { firmGovernanceAuthorities } : {}),
    };
  });
  let snapshot: LedgerAuthoritySnapshot;
  try {
    snapshot = createLedgerAuthoritySnapshot({
      providerId: String(row.provider_id),
      revision: positiveSafeInteger(row.revision, "ledger authority revision"),
      writeKillSwitchEnabled: row.write_kill_switch_enabled === true,
      standingDelegations,
      publishedAt: date(row.published_at),
    });
  } catch (error) {
    throw new AppError("PERSISTENCE_FAILURE", "Ledger authority snapshot integrity is invalid.", {
      httpStatus: 503,
      cause: error,
    });
  }
  if (snapshot.snapshotHash !== row.snapshot_hash) {
    let legacyHash: string | undefined;
    try {
      legacyHash = legacyLedgerAuthoritySnapshotV1Hash(snapshot);
    } catch {
      // Post-v1 fields or malformed material must never be accepted as legacy.
    }
    if (legacyHash === row.snapshot_hash) {
      throw new LegacyLedgerAuthoritySnapshotError(snapshot.revision);
    }
    throw new AppError("PERSISTENCE_FAILURE", "Ledger authority snapshot hash verification failed.", {
      httpStatus: 503,
    });
  }
  return snapshot;
}

class LegacyLedgerAuthoritySnapshotError extends AppError {
  constructor(readonly revision: number) {
    super("STALE_PREFLIGHT", "Legacy ledger authority snapshot v1 is unsupported for authorization.", {
      httpStatus: 409,
      retryable: false,
      details: { requiredSchemaVersion: "ledger-authority-snapshot:v2" },
    });
  }
}

function isOptionalNonEmpty(value: string | undefined): boolean {
  return value === undefined || isNonEmpty(value);
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError("CONFIGURATION_ERROR", `The database returned an invalid ${field}.`, {
      httpStatus: 500,
    });
  }
  return parsed;
}

function jsonClone<T>(value: unknown, field: string): T {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new AppError("CONFIGURATION_ERROR", `The database returned invalid ${field}.`, {
        httpStatus: 500,
        cause: error,
      });
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("CONFIGURATION_ERROR", `The database returned invalid ${field}.`, {
      httpStatus: 500,
    });
  }
  return structuredClone(parsed) as T;
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

function accountingCaseBindingValues(binding: AccountingCaseBinding): unknown[] {
  return [
    binding.actorId,
    binding.workspaceId,
    binding.subjectType,
    binding.subjectId,
    binding.agentId,
    binding.installationId,
    binding.bindingId,
    binding.bindingRevision,
    binding.connectionId,
    binding.tenantId,
    binding.targetSessionId,
    binding.targetSessionHash,
    binding.targetSessionExpiresAt,
  ];
}

function accountingCaseAccessIdentityValues(binding: AccountingCaseBinding): unknown[] {
  return [
    binding.actorId,
    binding.workspaceId,
    binding.subjectType,
    binding.subjectId,
    binding.agentId,
    binding.installationId,
    binding.bindingId,
    binding.bindingRevision,
    binding.connectionId,
    binding.tenantId,
  ];
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
  return typeof expectedName === "string" && typeof actualName === "string" && actualName === expectedName &&
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
  if (evidence.actionId !== operation.operation.actionId ||
      evidence.operationCanonicalPayloadHash !== operation.operation.canonicalPayloadHash ||
      evidence.state !== preflight.state) return false;
  if (preflight.state === "PREPARED") {
    return evidence.operationCanonicalPayloadHash === preflight.operationCanonicalPayloadHash &&
      evidence.preparationId === preflight.preparationId &&
      evidence.preparationCanonicalPayloadHash === preflight.preparationCanonicalPayloadHash &&
      evidence.sourceSha256 === preflight.sourceSha256;
  }
  return evidence.xeroObjectId === preflight.xeroObjectId &&
    evidence.readbackHash === hashObject(preflight.readbackSnapshot);
}

function assertAccountingCaseInput(input: CreateOrAdvanceAccountingCaseInput): void {
  const { binding, compiled } = input;
  const validBinding = isNonEmpty(binding.actorId) &&
    isNonEmpty(binding.workspaceId) &&
    ["USER", "TEAM"].includes(binding.subjectType) &&
    isNonEmpty(binding.subjectId) &&
    isNonEmpty(binding.agentId) &&
    isNonEmpty(binding.installationId) &&
    isNonEmpty(binding.bindingId) &&
    Number.isSafeInteger(binding.bindingRevision) && binding.bindingRevision > 0 &&
    isNonEmpty(binding.connectionId) &&
    isNonEmpty(binding.tenantId) &&
    isNonEmpty(binding.targetSessionId) &&
    /^[0-9a-f]{64}$/u.test(binding.targetSessionHash) &&
    isValidDate(binding.targetSessionExpiresAt) &&
    binding.actorId === `${binding.workspaceId}:${binding.subjectType.toLowerCase()}:${binding.subjectId}`;
  const validCompiled = isValidDate(input.now) &&
    binding.targetSessionExpiresAt > input.now &&
    isNonEmpty(compiled.caseId) &&
    compiled.providerId === "xero" &&
    Number.isSafeInteger(compiled.version) && compiled.version > 0 &&
    compiled.target.tenantId === binding.tenantId &&
    /^[0-9a-f]{64}$/u.test(compiled.sourceRevisionHash) &&
    /^[0-9a-f]{64}$/u.test(input.compiledPlanHash) &&
    input.compiledPlanHash === accountingCasePlanHash(binding, compiled) &&
    compiled.operations.every((operation) =>
      operation.caseId === compiled.caseId &&
      operation.caseVersion === compiled.version &&
      operation.target.tenantId === binding.tenantId &&
      operation.sourceRevisionHash === compiled.sourceRevisionHash &&
      /^[0-9a-f]{64}$/u.test(operation.businessIdentityHash) &&
      operation.businessIdentityHash === hashObject(operation.businessIdentity) &&
      operation.businessReservation.coordinateHash === hashObject({
        schemaVersion: operation.businessReservation.schemaVersion,
        providerId: operation.businessReservation.providerId,
        kind: operation.businessReservation.kind,
        canonicalFields: operation.businessReservation.canonicalFields,
      }) &&
      operation.canonicalPayloadHash === hashObject(operation.canonicalPayload));
  const operationIds = compiled.operations.map((operation) => operation.operationId);
  if (!validBinding || !validCompiled || new Set(operationIds).size !== operationIds.length) {
    throw new AppError("VALIDATION_FAILED", "Accounting Case binding, version, or compiled plan is invalid.", {
      httpStatus: 422,
    });
  }
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

function mapProviderAuthorization(row: Row): ProviderAuthorization {
  const providerAuthorization: ProviderAuthorization = {
    authorizationId: String(row.authorization_id),
    workspaceId: String(row.workspace_id),
    authorizedBySubject: String(row.authorized_by_subject),
    provider: "xero",
    grantedScopes: stringArray(row.granted_scopes),
    tokenCiphertext: String(row.token_ciphertext),
    tokenExpiresAt: date(row.token_expires_at),
    refreshVersion: Number(row.refresh_version),
    status: row.authorization_status as ProviderAuthorization["status"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.provider_subject) providerAuthorization.providerSubject = String(row.provider_subject);
  if (row.revoked_at) providerAuthorization.revokedAt = date(row.revoked_at);
  return providerAuthorization;
}

function mapAuthorizedConnection(row: Row): AuthorizedProviderConnection {
  const connection: AuthorizedProviderConnection = {
    connectionId: String(row.connection_id),
    authorizationId: String(row.authorization_id),
    provider: "xero",
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    status: row.connection_status as AuthorizedProviderConnection["status"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.provider_connection_id) connection.providerConnectionId = String(row.provider_connection_id);
  if (row.tenant_short_code) connection.tenantShortCode = String(row.tenant_short_code);
  if (row.last_verified_at) connection.lastVerifiedAt = date(row.last_verified_at);
  return connection;
}

function mapOAuthInstallation(row: Row): OAuthInstallation {
  const installation: OAuthInstallation = {
    installationId: String(row.installation_id),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as OAuthInstallation["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    clientId: String(row.oauth_client_id),
    status: row.installation_status as OAuthInstallation["status"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.revoked_at) installation.revokedAt = date(row.revoked_at);
  return installation;
}

function mapAgentConnectionBinding(row: Row): AgentConnectionBinding {
  const binding: AgentConnectionBinding = {
    bindingId: String(row.binding_id),
    installationId: String(row.oauth_installation_id),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as AgentConnectionBinding["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    connectionId: String(row.connection_id),
    policyId: String(row.policy_id),
    status: row.binding_status as AgentConnectionBinding["status"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.revoked_at) binding.revokedAt = date(row.revoked_at);
  return binding;
}

function mapOrganisationSwitchSession(row: Row): OrganisationSwitchSession {
  const session: OrganisationSwitchSession = {
    sessionHash: String(row.session_hash),
    installationId: String(row.oauth_installation_id),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as OrganisationSwitchSession["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    authorizationId: String(row.authorization_id),
    sourceBindingId: String(row.source_binding_id),
    sourceConnectionId: String(row.source_connection_id),
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
  };
  if (row.source_target_session_hash) session.sourceTargetSessionHash = String(row.source_target_session_hash);
  if (row.consumed_at) session.consumedAt = date(row.consumed_at);
  return session;
}

function mapLedgerTargetSession(row: Row): LedgerTargetSession {
  const session: LedgerTargetSession = {
    sessionId: String(row.session_id),
    sessionHash: String(row.session_hash),
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    connectionId: String(row.connection_id),
    bindingRevision: positiveSafeInteger(row.binding_revision, "ledger target binding revision"),
    createdAt: date(row.created_at),
    expiresAt: date(row.expires_at),
  };
  if (row.last_used_at) session.lastUsedAt = date(row.last_used_at);
  if (row.revoked_at) session.revokedAt = date(row.revoked_at);
  return session;
}

function mapGovernanceAuditEvent(row: Row): GovernanceAuditEvent {
  const evidence = typeof row.evidence === "string"
    ? JSON.parse(row.evidence) as Record<string, unknown>
    : structuredClone((row.evidence ?? {}) as Record<string, unknown>);
  const event: GovernanceAuditEvent = {
    eventId: String(row.event_id),
    streamId: String(row.stream_id),
    schemaVersion: row.schema_version as GovernanceAuditEvent["schemaVersion"],
    eventType: String(row.event_type),
    source: row.event_source as GovernanceAuditEvent["source"],
    action: String(row.action),
    actorId: String(row.actor_id),
    correlationId: String(row.correlation_id),
    disposition: row.disposition as GovernanceAuditEvent["disposition"],
    outcome: row.outcome as GovernanceAuditEvent["outcome"],
    evidence,
    eventHash: String(row.event_hash),
    occurredAt: date(row.occurred_at),
    recordedAt: date(row.recorded_at),
  };
  const optionalStrings = {
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    installationId: row.oauth_installation_id,
    bindingId: row.binding_id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    mandateId: row.mandate_id,
    policyId: row.policy_id,
    causationId: row.causation_id,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    previousEventHash: row.previous_event_hash,
  } as const;
  for (const [key, value] of Object.entries(optionalStrings)) {
    if (value !== null && value !== undefined) {
      (event as unknown as Record<string, unknown>)[key] = String(value);
    }
  }
  return event;
}

function mapOAuthBrokerFlow(row: Row): OAuthBrokerFlow {
  const flow: OAuthBrokerFlow = {
    flowHash: String(row.flow_hash),
    browserSessionHash: String(row.browser_session_hash),
    clientId: String(row.oauth_client_id),
    redirectUri: String(row.redirect_uri),
    pkceCodeChallenge: String(row.pkce_code_challenge),
    pkceCodeChallengeMethod: "S256",
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as OAuthBrokerFlow["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    requestedScopes: stringArray(row.requested_scopes),
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
  };
  if (row.consumed_at) flow.consumedAt = date(row.consumed_at);
  return flow;
}

function mapOAuthBrokerAuthorizationFlow(row: Row): OAuthBrokerAuthorizationFlow {
  const flow: OAuthBrokerAuthorizationFlow = {
    flowHash: String(row.flow_hash),
    browserSessionHash: String(row.browser_session_hash),
    xeroStateHash: String(row.xero_state_hash),
    outerStateHash: String(row.outer_state_hash),
    clientId: String(row.oauth_client_id),
    redirectUri: String(row.redirect_uri),
    pkceCodeChallenge: String(row.pkce_code_challenge),
    pkceCodeChallengeMethod: "S256",
    resource: String(row.resource),
    audience: String(row.audience),
    requestedScopes: stringArray(row.requested_scopes),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as OAuthBrokerAuthorizationFlow["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    installationId: String(row.oauth_installation_id),
    personalPoc: row.personal_poc === true,
    status: row.flow_status as OAuthBrokerAuthorizationFlow["status"],
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.outer_state_ciphertext) flow.outerStateCiphertext = String(row.outer_state_ciphertext);
  if (row.authorization_id) flow.authorizationId = String(row.authorization_id);
  if (row.selection_csrf_hash) flow.selectionCsrfHash = String(row.selection_csrf_hash);
  if (row.consumed_at) flow.consumedAt = date(row.consumed_at);
  return flow;
}

function mapOAuthAuthorizationCode(row: Row): OAuthAuthorizationCode {
  const code: OAuthAuthorizationCode = {
    codeHash: String(row.code_hash),
    flowHash: String(row.flow_hash),
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    connectionId: String(row.connection_id),
    clientId: String(row.oauth_client_id),
    redirectUri: String(row.redirect_uri),
    pkceCodeChallenge: String(row.pkce_code_challenge),
    pkceCodeChallengeMethod: "S256",
    resource: String(row.resource),
    audience: String(row.audience),
    grantedScopes: stringArray(row.granted_scopes),
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
  };
  if (row.consumed_at) code.consumedAt = date(row.consumed_at);
  return code;
}

function mapMcpRefreshToken(row: Row): McpRefreshToken {
  const token: McpRefreshToken = {
    tokenHash: String(row.token_hash),
    tokenId: String(row.token_id),
    familyId: String(row.family_id),
    issuedAt: date(row.issued_at),
    expiresAt: date(row.expires_at),
  };
  if (row.parent_token_hash) token.parentTokenHash = String(row.parent_token_hash);
  if (row.consumed_at) token.consumedAt = date(row.consumed_at);
  if (row.revoked_at) token.revokedAt = date(row.revoked_at);
  if (row.replaced_by_token_hash) token.replacedByTokenHash = String(row.replaced_by_token_hash);
  if (row.retry_access_token_hash) token.retryAccessTokenHash = String(row.retry_access_token_hash);
  if (row.retry_response_ciphertext) token.retryResponseCiphertext = String(row.retry_response_ciphertext);
  if (row.retry_expires_at) token.retryExpiresAt = date(row.retry_expires_at);
  return token;
}

function mapResolvedAgentBinding(row: Row): ResolvedAgentConnectionBinding {
  const resolved: ResolvedAgentConnectionBinding = {
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    bindingRevision: positiveSafeInteger(row.binding_revision, "active binding revision"),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as ResolvedAgentConnectionBinding["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    connectionId: String(row.connection_id),
    authorizationId: String(row.authorization_id),
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    policyId: String(row.policy_id),
  };
  if (row.provider_connection_id) resolved.providerConnectionId = String(row.provider_connection_id);
  return resolved;
}

function mapConnection(row: Row): ProviderConnection {
  const connection: ProviderConnection = {
    connectionId: String(row.connection_id),
    actorId: String(row.actor_id),
    provider: "xero",
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    grantedScopes: Array.isArray(row.granted_scopes) ? row.granted_scopes.map(String) : [],
    tokenCiphertext: String(row.token_ciphertext),
    tokenExpiresAt: date(row.token_expires_at),
    refreshVersion: Number(row.refresh_version),
    status: row.connection_status as ProviderConnection["status"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.tenant_short_code) connection.tenantShortCode = String(row.tenant_short_code);
  if (row.authorization_id) connection.authorizationId = String(row.authorization_id);
  if (row.provider_connection_id) connection.providerConnectionId = String(row.provider_connection_id);
  if (row.last_verified_at) connection.lastVerifiedAt = date(row.last_verified_at);
  return connection;
}

function mapPosting(row: Row): PostingRequest {
  const posting: PostingRequest = {
    postingRequestId: String(row.posting_request_id),
    actorId: String(row.actor_id),
    tenantId: String(row.tenant_id),
    sourceRef: String(row.source_ref),
    sourceSha256: String(row.source_sha256),
    sourceEvidenceType: row.source_evidence_type as PostingRequest["sourceEvidenceType"],
    documentType: row.document_type === "ACCREC" ? "ACCREC" : "ACCPAY",
    providerPayload: row.provider_payload as Record<string, unknown>,
    requestPayloadHash: String(row.request_payload_hash),
    providerPayloadHash: String(row.provider_payload_hash),
    state: row.state as PostingState,
    requestId: String(row.request_id),
    createIdempotencyKey: String(row.create_idempotency_key),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.xero_invoice_id) posting.xeroInvoiceId = String(row.xero_invoice_id);
  if (row.authorise_request_id) posting.authoriseRequestId = String(row.authorise_request_id);
  if (row.authorise_idempotency_key) posting.authoriseIdempotencyKey = String(row.authorise_idempotency_key);
  if (row.approval_ref_hash) posting.approvalRefHash = String(row.approval_ref_hash);
  if (row.approved_by) posting.approvedBy = String(row.approved_by);
  if (row.approved_at) posting.approvedAt = date(row.approved_at);
  if (row.approval_expires_at) posting.approvalExpiresAt = date(row.approval_expires_at);
  if (row.approval_consumed_at) posting.approvalConsumedAt = date(row.approval_consumed_at);
  if (row.write_receipt) posting.writeReceipt = row.write_receipt as Record<string, unknown>;
  if (row.readback_snapshot) posting.readbackSnapshot = row.readback_snapshot as Record<string, unknown>;
  if (row.draft_write_receipt) posting.draftWriteReceipt = row.draft_write_receipt as Record<string, unknown>;
  if (row.draft_readback_snapshot) {
    posting.draftReadbackSnapshot = row.draft_readback_snapshot as Record<string, unknown>;
  }
  if (row.authorise_write_receipt) {
    posting.authoriseWriteReceipt = row.authorise_write_receipt as Record<string, unknown>;
  }
  if (row.authorise_readback_snapshot) {
    posting.authoriseReadbackSnapshot = row.authorise_readback_snapshot as Record<string, unknown>;
  }
  return posting;
}

function mapXeroMutationPreparation(row: Row): XeroMutationPreparation {
  const preparation: XeroMutationPreparation = {
    preparationId: String(row.preparation_id),
    actorId: String(row.actor_id),
    workspaceId: String(row.workspace_id),
    tenantId: String(row.tenant_id),
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    connectionId: String(row.connection_id),
    objectType: row.object_type as XeroMutationPreparation["objectType"],
    operation: row.operation as XeroMutationPreparation["operation"],
    canonicalPayload: row.canonical_payload as Record<string, unknown>,
    canonicalPayloadHash: String(row.canonical_payload_hash),
    sourceSha256: String(row.source_sha256),
    sourceUnitKey: String(row.source_unit_key),
    sourceEvidenceType: row.source_evidence_type as XeroMutationPreparation["sourceEvidenceType"],
    confirmationSummaryHash: String(row.confirmation_summary_hash),
    confirmationPhraseHash: String(row.confirmation_phrase_hash),
    state: row.state as XeroMutationPreparation["state"],
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.binding_revision) {
    preparation.bindingRevision = positiveSafeInteger(row.binding_revision, "mutation preparation binding revision");
  }
  if (row.target_session_id) preparation.targetSessionId = String(row.target_session_id);
  if (row.target_xero_object_id) preparation.targetXeroObjectId = String(row.target_xero_object_id);
  if (row.source_ref) preparation.sourceRef = String(row.source_ref);
  if (row.consumed_at) preparation.consumedAt = date(row.consumed_at);
  return preparation;
}

function mapXeroMutationRequest(row: Row): XeroMutationRequest {
  const request: XeroMutationRequest = {
    mutationRequestId: String(row.mutation_request_id),
    preparationId: String(row.preparation_id),
    requestId: String(row.request_id),
    actorId: String(row.actor_id),
    workspaceId: String(row.workspace_id),
    tenantId: String(row.tenant_id),
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    connectionId: String(row.connection_id),
    objectType: row.object_type as XeroMutationRequest["objectType"],
    operation: row.operation as XeroMutationRequest["operation"],
    canonicalPayload: row.canonical_payload as Record<string, unknown>,
    canonicalPayloadHash: String(row.canonical_payload_hash),
    sourceSha256: String(row.source_sha256),
    sourceUnitKey: String(row.source_unit_key),
    sourceEvidenceType: row.source_evidence_type as XeroMutationRequest["sourceEvidenceType"],
    confirmationSummaryHash: String(row.confirmation_summary_hash),
    authorizationReceipt: row.authorization_receipt as Record<string, unknown>,
    state: row.state as XeroMutationRequest["state"],
    confirmedAt: date(row.confirmed_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.binding_revision) {
    request.bindingRevision = positiveSafeInteger(row.binding_revision, "mutation request binding revision");
  }
  if (row.target_session_id) request.targetSessionId = String(row.target_session_id);
  if (row.target_xero_object_id) request.targetXeroObjectId = String(row.target_xero_object_id);
  if (row.source_ref) request.sourceRef = String(row.source_ref);
  if (row.xero_object_id) request.xeroObjectId = String(row.xero_object_id);
  if (row.write_receipt) request.writeReceipt = row.write_receipt as Record<string, unknown>;
  if (row.native_recovery_claim) {
    request.nativeRecoveryClaim = row.native_recovery_claim as Record<string, unknown>;
  }
  if (row.readback_snapshot) request.readbackSnapshot = row.readback_snapshot as Record<string, unknown>;
  if (row.readback_snapshot_hash) request.readbackSnapshotHash = String(row.readback_snapshot_hash);
  if (row.readback_canonical_payload) {
    request.readbackCanonicalPayload = row.readback_canonical_payload as Record<string, unknown>;
  }
  if (row.readback_payload_hash) request.readbackPayloadHash = String(row.readback_payload_hash);
  if (row.readback_status) request.readbackStatus = String(row.readback_status);
  if (row.readback_mismatch_receipt) {
    request.readbackMismatchReceipt = row.readback_mismatch_receipt as Record<string, unknown>;
  }
  if (row.validation_receipt) request.validationReceipt = row.validation_receipt as Record<string, unknown>;
  if (row.provider_rejection_receipt) {
    request.providerRejectionReceipt = row.provider_rejection_receipt as Record<string, unknown>;
  }
  if (row.write_started_at) request.writeStartedAt = date(row.write_started_at);
  if (row.write_unknown_at) request.writeUnknownAt = date(row.write_unknown_at);
  if (row.verified_at) request.verifiedAt = date(row.verified_at);
  if (row.validation_failed_at) request.validationFailedAt = date(row.validation_failed_at);
  if (row.provider_rejected_at) request.providerRejectedAt = date(row.provider_rejected_at);
  return request;
}

function mapAccountingCaseBinding(row: Row): AccountingCaseBinding {
  return {
    actorId: String(row.actor_id),
    workspaceId: String(row.workspace_id),
    subjectType: row.subject_type as AccountingCaseBinding["subjectType"],
    subjectId: String(row.subject_id),
    agentId: String(row.agent_id),
    installationId: String(row.oauth_installation_id),
    bindingId: String(row.binding_id),
    bindingRevision: positiveSafeInteger(row.binding_revision, "Accounting Case binding revision"),
    connectionId: String(row.connection_id),
    tenantId: String(row.tenant_id),
    targetSessionId: String(row.target_session_id),
    targetSessionHash: String(row.target_session_hash),
    targetSessionExpiresAt: date(row.target_session_expires_at),
  };
}

/**
 * Case-head identity: fixed forever by whichever version first prepared the
 * case_id, exactly like its tenant. Both columns are set together (the
 * migration's shape check enforces this), so either both are present or
 * neither is.
 */
function mapAccountingCaseSourceCase(row: Row): AccountingCaseSourceCaseReference | undefined {
  if (row.source_case_system === null || row.source_case_system === undefined) return undefined;
  return {
    system: row.source_case_system as AccountingCaseSourceCaseReference["system"],
    caseRefHash: String(row.source_case_ref_hash),
  };
}

function mapAccountingCaseSourceCaseClaim(row: Row): AccountingCaseSourceCaseClaim {
  const claim = row.source_case_claim;
  if (
    typeof claim !== "string" ||
    !(ACCOUNTING_CASE_SOURCE_CASE_CLAIMS as readonly string[]).includes(claim)
  ) {
    throw new AppError("PERSISTENCE_FAILURE", "Accounting Case source-case claim is invalid.", {
      httpStatus: 503,
    });
  }
  return claim as AccountingCaseSourceCaseClaim;
}

function mapAccountingCaseRecoveryResidualGrant(row: Row): AccountingCaseRecoveryResidualGrant {
  const grant: AccountingCaseRecoveryResidualGrant = {
    grantId: String(row.grant_id),
    sourceCaseId: String(row.source_case_id),
    sourceVersion: positiveSafeInteger(row.source_case_version, "recovery residual source version"),
    sourcePlanHash: String(row.source_plan_hash),
    successorCaseId: String(row.successor_case_id),
    residualOperationIds: stringArray(row.residual_operation_ids),
    template: jsonClone<AccountingCaseRecoveryResidualGrant["template"]>(
      row.continuation_template,
      "recovery residual continuation template",
    ),
    templateHash: String(row.template_hash),
    successorBinding: mapAccountingCaseBinding(row),
    state: row.state as AccountingCaseRecoveryResidualGrant["state"],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  if (row.consumed_plan_hash) grant.consumedPlanHash = String(row.consumed_plan_hash);
  if (row.consumed_at) grant.consumedAt = date(row.consumed_at);
  return grant;
}

function mapAccountingCaseOperation(row: Row): AccountingCaseOperationRecord {
  const operation = jsonClone<AccountingCaseOperationRecord["operation"] & {
    businessReservation?: AccountingCaseBusinessReservation;
  }>(
    row.operation_json,
    "Accounting Case operation",
  );
  if (operation.canonicalPayloadHash !== hashObject(operation.canonicalPayload)) {
    throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation payload integrity check failed.", {
      httpStatus: 503,
    });
  }
  // Migration 035 deliberately keeps operation_json and compiled_case
  // immutable.  For pre-035 operations, hydrate only the new collision claim
  // from its migration-owned sidecar columns; do not rewrite the historical
  // operation or plan hash in storage.
  const durableReservation = jsonClone<AccountingCaseBusinessReservation>(
    row.business_reservation,
    "Accounting Case business reservation",
  );
  const operationWithReservation = operation.businessReservation
    ? operation
    : { ...operation, businessReservation: durableReservation };
  const reservationCoordinate = {
    schemaVersion: operationWithReservation.businessReservation.schemaVersion,
    providerId: operationWithReservation.businessReservation.providerId,
    kind: operationWithReservation.businessReservation.kind,
    canonicalFields: operationWithReservation.businessReservation.canonicalFields,
  };
  if (
    operation.businessIdentityHash !== hashObject(operation.businessIdentity) ||
    stableStringify(row.business_identity) !== stableStringify(operation.businessIdentity) ||
    String(row.business_identity_hash) !== operation.businessIdentityHash ||
    stableStringify(row.business_reservation) !== stableStringify(operationWithReservation.businessReservation) ||
    stableStringify(row.business_reservation_coordinate) !== stableStringify(reservationCoordinate) ||
    String(row.business_reservation_coordinate_hash) !== operationWithReservation.businessReservation.coordinateHash ||
    String(row.business_reservation_scope) !== operationWithReservation.businessReservation.scope ||
    (operationWithReservation.businessReservation.scope === "DATED_OCCURRENCE"
      ? date(row.business_reservation_occurrence_date).toISOString().slice(0, 10) !==
        operationWithReservation.businessReservation.occurrenceDate
      : row.business_reservation_occurrence_date !== null)
  ) {
    throw new AppError("PERSISTENCE_FAILURE", "Accounting Case business reservation integrity check failed.", {
      httpStatus: 503,
    });
  }
  const record: AccountingCaseOperationRecord = {
    operation: operationWithReservation,
    ordinal: nonNegativeSafeInteger(row.ordinal, "Accounting Case operation ordinal"),
    state: row.operation_state as AccountingCaseOperationRecord["state"],
    updatedAt: date(row.operation_updated_at),
  };
  if (row.preparation_id) record.preparationId = String(row.preparation_id);
  if (row.original_preparation_id) record.originalPreparationId = String(row.original_preparation_id);
  if (row.preparation_canonical_payload_hash) {
    record.preparationCanonicalPayloadHash = String(row.preparation_canonical_payload_hash);
  }
  if (row.operation_source_sha256) record.sourceSha256 = String(row.operation_source_sha256);
  if (row.mutation_request_id) record.mutationRequestId = String(row.mutation_request_id);
  if (row.xero_object_id) record.xeroObjectId = String(row.xero_object_id);
  if (row.write_receipt) {
    record.writeReceipt = jsonClone<Record<string, unknown>>(row.write_receipt, "Accounting Case write receipt");
  }
  if (row.readback_snapshot) {
    record.readbackSnapshot = jsonClone<Record<string, unknown>>(
      row.readback_snapshot,
      "Accounting Case readback snapshot",
    );
  }
  if (row.error_receipt) {
    record.errorReceipt = jsonClone<Record<string, unknown>>(row.error_receipt, "Accounting Case error receipt");
  }
  return record;
}

export class PostgresAccountingRepository implements AccountingRepository {
  readonly pool: InstanceType<typeof Pool>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async #activeRecoveryProjectionEvidence(queryable: Pick<PoolClient, "query">) {
    const result = await queryable.query<PostgresActiveRecoveryProjectionRow>(
      `WITH active_recovery AS MATERIALIZED (
         SELECT version_row.compiled_case
         FROM accounting_cases case_row
         JOIN accounting_case_versions version_row
           ON version_row.case_id = case_row.case_id
          AND version_row.version = case_row.current_version
         WHERE version_row.state <> 'TERMINAL'
           AND (
             version_row.state = 'RECOVERY_REQUIRED'
             OR EXISTS (
               SELECT 1
               FROM accounting_case_operations operation_row
               WHERE operation_row.case_id = version_row.case_id
                 AND operation_row.case_version = version_row.version
                 AND operation_row.state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
             )
           )
       )
       SELECT
         (SELECT COUNT(*)::text FROM active_recovery) AS active_recovery_case_count,
         ARRAY(
           SELECT DISTINCT recovery.compiled_case #>> '{policyProjection,schemaVersion}'
           FROM active_recovery recovery
           WHERE jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string'
           ORDER BY recovery.compiled_case #>> '{policyProjection,schemaVersion}'
         ) AS stored_policy_projection_versions,
         ARRAY(
           SELECT DISTINCT recovery.compiled_case #>> '{providerProjection,schemaVersion}'
           FROM active_recovery recovery
           WHERE jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string'
           ORDER BY recovery.compiled_case #>> '{providerProjection,schemaVersion}'
         ) AS stored_provider_projection_versions,
         COALESCE((
           SELECT BOOL_AND(
             COALESCE(jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string', false)
             AND COALESCE(jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string', false)
             AND COALESCE(recovery.compiled_case #>> '{policyProjection,schemaVersion}'
               ~ '^xero-(sg-accounting-policy|declared-ledger-policy)-projection:v[1-9][0-9]*$', false)
             AND COALESCE(recovery.compiled_case #>> '{providerProjection,schemaVersion}'
               ~ '^xero-accounting-case-provider-projection:v[1-9][0-9]*$', false)
           )
           FROM active_recovery recovery
         ), true) AS active_recovery_projection_valid,
         COALESCE((
           SELECT BOOL_AND(
             COALESCE(jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string', false)
             AND COALESCE(recovery.compiled_case #>> '{policyProjection,schemaVersion}' = $1, false)
             AND COALESCE(jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string', false)
             AND COALESCE(recovery.compiled_case #>> '{providerProjection,schemaVersion}' = $2, false)
           )
           FROM active_recovery recovery
         ), true) AS active_recovery_projection_compatible`,
      [
        XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
        XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("ACTIVE_RECOVERY_PROJECTION_QUERY_EMPTY");
    return activeAccountingCaseRecoveryProjectionEvidenceFromPostgres(row);
  }

  async #readiness(queryable: Pick<PoolClient, "query">): Promise<boolean> {
    try {
      const result = await queryable.query<{ ready: boolean }>(
        `SELECT
          to_regclass('public.provider_connections') IS NOT NULL
          AND to_regclass('public.posting_requests') IS NOT NULL
          AND to_regclass('public.tool_audit_logs') IS NOT NULL
          AND to_regclass('public.provider_authorizations') IS NOT NULL
          AND to_regclass('public.oauth_installations') IS NOT NULL
          AND to_regclass('public.agent_connection_bindings') IS NOT NULL
          AND to_regclass('public.oauth_broker_flows') IS NOT NULL
          AND to_regclass('public.oauth_authorization_codes') IS NOT NULL
          AND to_regclass('public.mcp_access_tokens') IS NOT NULL
          AND to_regclass('public.mcp_refresh_token_families') IS NOT NULL
          AND to_regclass('public.mcp_refresh_tokens') IS NOT NULL
          AND to_regclass('public.xero_mutation_preparations') IS NOT NULL
          AND to_regclass('public.xero_mutation_requests') IS NOT NULL
          AND to_regclass('public.oauth_installation_active_bindings') IS NOT NULL
          AND to_regclass('public.organisation_switch_sessions') IS NOT NULL
          AND to_regclass('public.ledger_target_sessions') IS NOT NULL
          AND to_regclass('public.governance_audit_events') IS NOT NULL
          AND to_regclass('public.accounting_cases') IS NOT NULL
          AND to_regclass('public.accounting_case_versions') IS NOT NULL
          AND to_regclass('public.accounting_case_operations') IS NOT NULL
          AND to_regclass('public.accounting_case_preflight_reseals') IS NOT NULL
          AND to_regclass('public.accounting_case_preflight_reseal_operations') IS NOT NULL
          AND to_regclass('public.ledger_authority_snapshots') IS NOT NULL
          AND NOT EXISTS (
            SELECT required.table_name, required.column_name
            FROM (VALUES
              ('organisation_switch_sessions', 'source_target_session_hash'),
              ('xero_mutation_preparations', 'binding_revision'),
              ('xero_mutation_preparations', 'target_session_id'),
              ('xero_mutation_requests', 'binding_revision'),
              ('xero_mutation_requests', 'target_session_id')
            ) AS required(table_name, column_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.columns columns
              WHERE columns.table_schema = 'public'
                AND columns.table_name = required.table_name
                AND columns.column_name = required.column_name
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'agent_connection_bindings_oauth_installation_id_key'
              AND conrelid = 'public.agent_connection_bindings'::regclass
          )
          AND EXISTS (
            SELECT 1
            FROM pg_index indexes
            JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
            WHERE index_class.relname = 'agent_connection_bindings_installation_status_idx'
              AND index_class.relnamespace = 'public'::regnamespace
              AND indexes.indrelid = 'public.agent_connection_bindings'::regclass
              AND indexes.indisvalid
              AND indexes.indisready
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'oauth_installation_active_binding_tuple_fk'
              AND conrelid = 'public.oauth_installation_active_bindings'::regclass
              AND convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'ledger_target_session_binding_fk'
              AND conrelid = to_regclass('public.ledger_target_sessions')
              AND convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'organisation_switch_source_target_fk'
              AND conrelid = to_regclass('public.organisation_switch_sessions')
              AND convalidated
          )
          AND NOT EXISTS (
            SELECT required.index_name
            FROM (VALUES
              ('ledger_target_sessions_expiry_idx'),
              ('ledger_target_sessions_installation_idx')
            ) AS required(index_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class index_class
              JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
              WHERE index_class.relname = required.index_name
                AND index_meta.indrelid = to_regclass('public.ledger_target_sessions')
                AND index_meta.indisvalid
                AND index_meta.indisready
            )
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'governance_audit_events_append_only'
              AND tgrelid = 'public.governance_audit_events'::regclass
              AND NOT tgisinternal
              AND tgenabled IN ('O', 'A')
          )
          AND EXISTS (
            SELECT 1
            FROM pg_index indexes
            JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
            WHERE index_class.relname = 'mcp_refresh_token_families_active_installation_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND indexes.indrelid = 'public.mcp_refresh_token_families'::regclass
              AND indexes.indisunique
              AND indexes.indisvalid
              AND indexes.indisready
              AND indexes.indpred IS NOT NULL
              AND pg_get_indexdef(indexes.indexrelid) LIKE '%oauth_installation_id%'
              AND pg_get_indexdef(indexes.indexrelid) LIKE '%family_status%ACTIVE%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_index indexes
            JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
            WHERE index_class.relname = 'review_csrf_session_idx'
              AND index_class.relnamespace = 'public'::regnamespace
              AND indexes.indrelid = 'public.review_csrf_tokens'::regclass
              AND indexes.indisvalid
              AND indexes.indisready
          )
          AND EXISTS (
            SELECT 1
            FROM pg_index indexes
            JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
            WHERE index_class.relname = 'tool_audit_logs_in_progress_idx'
              AND index_class.relnamespace = 'public'::regnamespace
              AND indexes.indrelid = 'public.tool_audit_logs'::regclass
              AND indexes.indisvalid
              AND indexes.indisready
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'provider_connections'
              AND column_name = 'tenant_short_code'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'posting_requests'
              AND column_name = 'source_evidence_type'
              AND is_nullable = 'NO'
              AND column_default IS NULL
          )
          AND NOT EXISTS (
            SELECT required.column_name
            FROM (VALUES
              ('authorization_id'),
              ('provider_connection_id'),
              ('last_verified_at')
            ) AS required(column_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.columns existing
              WHERE existing.table_schema = 'public'
                AND existing.table_name = 'provider_connections'
                AND existing.column_name = required.column_name
            )
          )
          AND NOT EXISTS (
            SELECT required.column_name
            FROM (VALUES
              ('draft_write_receipt'),
              ('draft_readback_snapshot'),
              ('authorise_write_receipt'),
              ('authorise_readback_snapshot')
            ) AS required(column_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.columns existing
              WHERE existing.table_schema = 'public'
                AND existing.table_name = 'posting_requests'
                AND existing.column_name = required.column_name
                AND existing.data_type = 'jsonb'
            )
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'tool_audit_logs_completion_shape_check'
              AND conrelid = 'public.tool_audit_logs'::regclass
              AND convalidated
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'tool_audit_logs_result_status_check'
              AND conrelid = 'public.tool_audit_logs'::regclass
              AND convalidated
              AND pg_get_constraintdef(oid) LIKE '%result_status = ANY%'
              AND pg_get_constraintdef(oid) LIKE '%IN_PROGRESS%'
              AND pg_get_constraintdef(oid) LIKE '%SUCCEEDED%'
              AND pg_get_constraintdef(oid) LIKE '%REJECTED%'
              AND pg_get_constraintdef(oid) LIKE '%FAILED%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'posting_requests_source_evidence_type_check'
              AND conrelid = 'public.posting_requests'::regclass
              AND convalidated
              AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%LEGACY_UNVERIFIED%'
              AND pg_get_constraintdef(oid) LIKE '%AGENT_ASSERTED_UNVERIFIED%'
              AND pg_get_constraintdef(oid) LIKE '%SERVER_FINGERPRINTED_EXTRACTION%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'posting_requests_document_type_check'
              AND conrelid = 'public.posting_requests'::regclass
              AND convalidated
              AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%ACCPAY%'
              AND pg_get_constraintdef(oid) LIKE '%ACCREC%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'posting_requests_state_check'
              AND conrelid = 'public.posting_requests'::regclass
              AND convalidated
              AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%DRAFT_READBACK_VERIFIED%'
          )
          AND NOT EXISTS (
            SELECT required.column_name
            FROM (VALUES
              ('xero_mutation_preparations', 'source_unit_key', 'text', 'NO'),
              ('xero_mutation_requests', 'source_unit_key', 'text', 'NO'),
              ('xero_mutation_requests', 'readback_snapshot_hash', 'text', 'YES'),
              ('xero_mutation_requests', 'readback_canonical_payload', 'jsonb', 'YES'),
              ('xero_mutation_requests', 'readback_status', 'text', 'YES'),
              ('xero_mutation_requests', 'readback_mismatch_receipt', 'jsonb', 'YES'),
              ('xero_mutation_requests', 'provider_rejection_receipt', 'jsonb', 'YES'),
              ('xero_mutation_requests', 'provider_rejected_at', 'timestamp with time zone', 'YES'),
              ('xero_mutation_requests', 'authorization_receipt', 'jsonb', 'NO')
              ,('accounting_case_versions', 'last_execution_error_receipt', 'jsonb', 'YES')
              ,('accounting_case_versions', 'original_preflight_receipt_hash', 'text', 'YES')
              ,('accounting_case_versions', 'effective_preflight_seal_hash', 'text', 'YES')
              ,('accounting_case_versions', 'effective_preflight_sealed_at', 'timestamp with time zone', 'YES')
              ,('accounting_case_versions', 'preflight_reseal_revision', 'bigint', 'NO')
              ,('accounting_case_operations', 'preparation_canonical_payload_hash', 'text', 'YES')
              ,('accounting_case_operations', 'operation_source_sha256', 'text', 'YES')
              ,('accounting_case_operations', 'original_preparation_id', 'text', 'YES')
              ,('accounting_case_operations', 'tenant_id', 'text', 'NO')
              ,('accounting_case_operations', 'business_identity', 'jsonb', 'NO')
              ,('accounting_case_operations', 'business_identity_hash', 'text', 'NO')
              ,('accounting_case_operations', 'business_reservation', 'jsonb', 'NO')
              ,('accounting_case_operations', 'business_reservation_coordinate', 'jsonb', 'NO')
              ,('accounting_case_operations', 'business_reservation_coordinate_hash', 'text', 'NO')
              ,('accounting_case_operations', 'business_reservation_scope', 'text', 'NO')
              ,('accounting_case_operations', 'business_reservation_occurrence_date', 'date', 'YES')
              ,('accounting_case_preflight_reseals', 'reseal_receipt', 'jsonb', 'NO')
              ,('accounting_case_preflight_reseal_operations', 'new_preparation_expires_at', 'timestamp with time zone', 'NO')
            ) AS required(table_name, column_name, data_type, is_nullable)
            WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.columns existing
              WHERE existing.table_schema = 'public'
                AND existing.table_name = required.table_name
                AND existing.column_name = required.column_name
                AND existing.data_type = required.data_type
                AND existing.is_nullable = required.is_nullable
            )
          )
          AND NOT EXISTS (
            SELECT required.constraint_name
            FROM (VALUES
              ('xero_mutation_preparations', 'xero_mutation_preparations_object_type_check'),
              ('xero_mutation_preparations', 'xero_mutation_preparation_operation_check'),
              ('xero_mutation_preparations', 'xero_mutation_preparation_lifecycle_check'),
              ('xero_mutation_preparations', 'xero_mutation_preparation_exact_binding_unique'),
              ('xero_mutation_requests', 'xero_mutation_requests_object_type_check'),
              ('xero_mutation_requests', 'xero_mutation_request_operation_check'),
              ('xero_mutation_requests', 'xero_mutation_request_update_target_check'),
              ('xero_mutation_requests', 'xero_mutation_request_preparation_binding_fk'),
              ('xero_mutation_requests', 'xero_mutation_request_readback_binding_check'),
              ('xero_mutation_requests', 'xero_mutation_request_readback_mismatch_receipt_check'),
              ('xero_mutation_requests', 'xero_mutation_request_lifecycle_check')
            ) AS required(table_name, constraint_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_constraint existing
              WHERE existing.conname = required.constraint_name
                AND existing.conrelid = format('public.%I', required.table_name)::regclass
                AND existing.convalidated
            )
          )
          AND NOT EXISTS (
            SELECT required.trigger_name
            FROM (VALUES
              ('xero_mutation_preparations', 'xero_mutation_preparation_immutable_trigger'),
              ('xero_mutation_requests', 'xero_mutation_request_preparation_trigger'),
              ('xero_mutation_requests', 'xero_mutation_request_immutable_trigger'),
              ('accounting_case_operations', 'accounting_case_prepared_liveness')
            ) AS required(table_name, trigger_name)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_trigger existing
              WHERE existing.tgname = required.trigger_name
                AND existing.tgrelid = format('public.%I', required.table_name)::regclass
                AND NOT existing.tgisinternal
                AND existing.tgenabled IN ('O', 'A')
            )
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'xero_mutation_request_immutable_guard'
              AND pg_get_functiondef(function_meta.oid) LIKE '%invalid xero mutation state transition%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%READBACK_MISMATCH%READBACK_VERIFIED%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%case_economics_demotion%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'xero_mutation_request_preparation_guard'
              AND pg_get_functiondef(function_meta.oid) LIKE '%expires_at > statement_timestamp()%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'accounting_case_prepared_liveness_guard'
              AND pg_get_functiondef(function_meta.oid) LIKE '%preparation.expires_at > statement_timestamp()%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%target_session.revoked_at IS NULL%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%target_session.expires_at > statement_timestamp()%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'accounting_case_contact_bare_number_coordinate'
              AND pg_get_functiondef(function_meta.oid) LIKE '%PROVIDER_CONTACT_BARE_NUMBER%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%COMPANY_NUMBER%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%ACCOUNT_NUMBER%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'enforce_accounting_case_business_reservation_overlap'
              AND pg_get_functiondef(function_meta.oid) LIKE '%contact.create_basic%PENDING%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%target_session_expires_at%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%statement_timestamp()%'
              AND pg_get_functiondef(function_meta.oid) NOT LIKE '%NEW.updated_at%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%WRITE_UNCERTAIN%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%READBACK_MISMATCH%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%READBACK_VERIFIED%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_proc function_meta
            JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
            WHERE namespace_meta.nspname = 'public'
              AND function_meta.proname = 'abandon_expired_accounting_case_contact_reservation'
              AND pg_get_functiondef(function_meta.oid) LIKE '%ACCOUNTING_CASE_NO_WRITE_STARTED%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%mutationRequestAbsent%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%providerCallAbsentByPermitInvariant%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%FOR UPDATE%'
              AND pg_get_functiondef(function_meta.oid) LIKE '%statement_timestamp()%'
          )
          AND NOT EXISTS (
            SELECT required.constraint_name
            FROM (VALUES
              ('accounting_cases', 'accounting_cases_binding_fk'),
              ('accounting_cases', 'accounting_cases_connection_tenant_fk'),
              ('accounting_cases', 'accounting_cases_target_fk'),
              ('accounting_case_versions', 'accounting_case_version_compiled_identity_check'),
              ('accounting_case_versions', 'accounting_case_version_lifecycle_shape_check'),
              ('accounting_case_versions', 'accounting_case_preflight_seal_metadata_check'),
              ('accounting_case_operations', 'accounting_case_operation_json_identity_check'),
              ('accounting_case_operations', 'accounting_case_operation_lifecycle_shape_check'),
              ('accounting_case_operations', 'accounting_case_operation_original_preparation_check'),
              ('accounting_case_operations', 'accounting_case_operation_original_preparation_fk'),
              ('accounting_cases', 'accounting_cases_case_tenant_unique'),
              ('accounting_case_operations', 'accounting_case_operation_business_identity_check'),
              ('accounting_case_operations', 'accounting_case_business_reservation_check'),
              ('accounting_case_operations', 'accounting_case_operations_case_tenant_fk'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_version_fk'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_runway_check'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_header_fk'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_case_fk'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_old_preparation_fk'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_new_preparation_fk'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_distinct_preparations_check')
            ) AS required(table_name, constraint_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_constraint existing
              WHERE existing.conname = required.constraint_name
                AND existing.conrelid = format('public.%I', required.table_name)::regclass
                AND existing.convalidated
            )
          )
          AND NOT EXISTS (
            SELECT required.trigger_name
            FROM (VALUES
              ('accounting_cases', 'accounting_case_head_immutable'),
              ('accounting_cases', 'accounting_case_current_version_exists'),
              ('accounting_case_versions', 'accounting_case_version_lifecycle'),
              ('accounting_case_versions', 'accounting_case_preflight_effective_seal_lifecycle'),
              ('accounting_case_versions', 'accounting_case_preflight_reseal_version_consistency'),
              ('accounting_case_operations', 'accounting_case_operation_original_preparation_lifecycle'),
              ('accounting_case_operations', 'accounting_case_operation_reseal_lifecycle'),
              ('accounting_case_operations', 'accounting_case_operation_lifecycle'),
              ('accounting_case_operations', 'accounting_case_business_reservation_overlap_trigger'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_header_insert'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_header_append_only'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_header_no_truncate'),
              ('accounting_case_preflight_reseals', 'accounting_case_preflight_reseal_header_consistency'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_insert'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_append_only'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_no_truncate'),
              ('accounting_case_preflight_reseal_operations', 'accounting_case_preflight_reseal_operation_consistency')
            ) AS required(table_name, trigger_name)
            WHERE NOT EXISTS (
              SELECT 1 FROM pg_trigger existing
              WHERE existing.tgname = required.trigger_name
                AND existing.tgrelid = format('public.%I', required.table_name)::regclass
                AND existing.tgenabled IN ('O', 'A')
            )
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'xero_mutation_preparations_object_type_check'
              AND conrelid = 'public.xero_mutation_preparations'::regclass
              AND convalidated
              AND pg_get_constraintdef(oid) LIKE '%SUPPLIER_BILL%'
              AND pg_get_constraintdef(oid) LIKE '%SALES_INVOICE%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'xero_mutation_requests_object_type_check'
              AND conrelid = 'public.xero_mutation_requests'::regclass
              AND convalidated
              AND pg_get_constraintdef(oid) LIKE '%SUPPLIER_BILL%'
              AND pg_get_constraintdef(oid) LIKE '%SALES_INVOICE%'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'xero_mutation_request_lifecycle_check'
              AND conrelid = 'public.xero_mutation_requests'::regclass
              AND convalidated
              AND pg_get_constraintdef(oid) LIKE '%SUPPLIER_BILL%'
              AND pg_get_constraintdef(oid) LIKE '%SALES_INVOICE%'
              AND pg_get_constraintdef(oid) LIKE '%DRAFT%'
              AND pg_get_constraintdef(oid) LIKE '%ACTIVE%'
              AND pg_get_constraintdef(oid) LIKE '%UNTRACKED%'
              AND pg_get_constraintdef(oid) LIKE '%UPLOADED%'
              AND pg_get_constraintdef(oid) LIKE '%PROVIDER_REJECTED%'
              AND pg_get_constraintdef(oid) LIKE '%ACCOUNTING_CASE_ECONOMICS%'
          )
          AND NOT EXISTS (
            SELECT required.index_name
            FROM (VALUES
              ('xero_mutation_preparations', 'xero_mutation_preparations_expiry_idx', false, true),
              ('xero_mutation_requests', 'xero_mutation_requests_idempotency_unique_idx', true, false),
              ('xero_mutation_requests', 'xero_mutation_requests_active_source_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_active_source_ref_unit_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_active_business_payload_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_exact_created_object_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_exact_active_update_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_active_object_unique_idx', true, true),
              ('xero_mutation_requests', 'xero_mutation_requests_state_idx', false, false),
              ('accounting_case_operations', 'accounting_case_business_reservation_lookup_idx', false, true),
              ('accounting_case_operations', 'accounting_case_contact_bare_number_reservation_lookup_idx', false, true)
            ) AS required(table_name, index_name, is_unique, has_predicate)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class index_class
              JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
              WHERE index_class.relname = required.index_name
                AND index_meta.indrelid = format('public.%I', required.table_name)::regclass
                AND index_meta.indisunique = required.is_unique
                AND index_meta.indisvalid AND index_meta.indisready
                AND (index_meta.indpred IS NOT NULL) = required.has_predicate
            )
          )
          AND EXISTS (
            SELECT 1
            FROM pg_class index_class
            JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
            WHERE index_class.relname = 'xero_mutation_requests_active_source_ref_unit_unique_idx'
              AND index_meta.indrelid = 'public.xero_mutation_requests'::regclass
              AND pg_get_indexdef(index_meta.indexrelid) LIKE '%source_ref%source_unit_key%'
              AND pg_get_indexdef(index_meta.indexrelid) LIKE '%READBACK_MISMATCH%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_class index_class
            JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
            WHERE index_class.relname = 'accounting_case_business_reservation_lookup_idx'
              AND index_meta.indrelid = 'public.accounting_case_operations'::regclass
              AND pg_get_indexdef(index_meta.indexrelid)
                LIKE '%tenant_id%action_id%business_reservation_coordinate%business_reservation_scope%business_reservation_occurrence_date%'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_class index_class
            JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
            WHERE index_class.relname = 'accounting_case_contact_bare_number_reservation_lookup_idx'
              AND index_meta.indrelid = 'public.accounting_case_operations'::regclass
              AND pg_get_indexdef(index_meta.indexrelid)
                LIKE '%tenant_id%accounting_case_contact_bare_number_coordinate%'
              AND pg_get_indexdef(index_meta.indexrelid) LIKE '%contact.create_basic%PENDING%'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM pg_class index_class
            WHERE index_class.relnamespace = 'public'::regnamespace
              AND index_class.relname IN (
                'xero_mutation_requests_active_contact_company_unique_idx',
                'xero_mutation_requests_active_contact_account_unique_idx'
              )
          )
          AND NOT EXISTS (
            SELECT required.index_name
            FROM (VALUES
              ('posting_requests_actor_tenant_request_create_unique_idx', false),
              ('posting_requests_actor_tenant_request_create_v030_unique_idx', false),
              ('posting_requests_active_source_unique_idx', true),
              ('posting_requests_active_source_v030_unique_idx', true),
              ('posting_requests_tenant_active_source_unique_idx', true),
              ('posting_requests_tenant_active_source_v030_unique_idx', true)
            ) AS required(index_name, requires_predicate)
            WHERE NOT EXISTS (
              SELECT 1
              FROM pg_class index_class
              JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
              WHERE index_class.relname = required.index_name
                AND index_meta.indrelid = 'public.posting_requests'::regclass
                AND index_meta.indisunique
                AND index_meta.indisvalid
                AND (index_meta.indpred IS NOT NULL) = required.requires_predicate
            )
          )
          AND NOT EXISTS (
            SELECT expected.version
            FROM (VALUES
              ('001_init.sql'),
              ('002_ephemeral_cleanup_index.sql'),
              ('003_provider_connection_tenant_shortcode.sql'),
              ('004_durable_audit_intent.sql'),
              ('005_oauth_identity_foundation.sql'),
              ('006_oauth_broker_flow_lifecycle.sql'),
              ('008_xero_source_evidence_type.sql'),
              ('012_xero_duplicate_guards.sql'),
              ('013_xero_rejected_duplicate_guard.sql'),
              ('014_xero_tenant_duplicate_guards.sql'),
              ('015_xero_posting_write_provenance.sql'),
              ('016_xero_document_type_duplicate_guards.sql'),
              ('017_xero_controlled_mutation_foundation.sql'),
              ('018_xero_invoice_draft_one_time_confirmation.sql'),
              ('019_xero_mcp_refresh_family_lifecycle.sql'),
              ('020_xero_runtime_readiness_compatibility.sql'),
              ('021_xero_mcp_refresh_retry_grace.sql'),
              ('022_xero_organisation_switch.sql'),
              ('023_governance_audit_events.sql'),
              ('024_allow_binding_history_per_installation.sql')
            ) AS expected(version)
            WHERE NOT EXISTS (
              SELECT 1 FROM schema_migrations applied
              WHERE applied.version = expected.version
            )
          )
          AND NOT EXISTS (
            SELECT required.version
            FROM unnest($1::text[]) AS required(version)
            WHERE NOT EXISTS (
              SELECT 1 FROM schema_migrations applied
              WHERE applied.version = required.version
            )
          ) AS ready`,
        [REQUIRED_MIGRATIONS],
      );
      if (result.rows[0]?.ready !== true) return false;

      const duplicateIndexes = await queryable.query<XeroDuplicateIndexCatalogRow>(
        `SELECT index_class.relname AS "indexName",
                access_method.amname AS "accessMethod",
                index_meta.indisunique AS "isUnique",
                index_meta.indisvalid AS "isValid",
                index_meta.indisready AS "isReady",
                ARRAY(
                  SELECT pg_get_indexdef(index_meta.indexrelid, key_position, true)
                  FROM generate_series(1, index_meta.indnatts) AS key_position
                  ORDER BY key_position
                ) AS "keyDefinitions",
                pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_index index_meta
         JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
         JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
         JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
         JOIN pg_am access_method ON access_method.oid = index_class.relam
         WHERE table_namespace.nspname = 'public'
           AND table_class.relname = 'posting_requests'
           AND index_class.relname = ANY($1::text[])
         ORDER BY index_class.relname`,
        [[
          "posting_requests_actor_tenant_request_create_unique_idx",
          "posting_requests_actor_tenant_request_create_v030_unique_idx",
          "posting_requests_active_source_unique_idx",
          "posting_requests_active_source_v030_unique_idx",
          "posting_requests_tenant_active_source_unique_idx",
          "posting_requests_tenant_active_source_v030_unique_idx",
        ]],
      );
      if (!hasExactXeroDuplicateIndexes(duplicateIndexes.rows)) return false;
      return (await this.#activeRecoveryProjectionEvidence(queryable)).status === "COMPATIBLE";
    } catch {
      return false;
    }
  }

  async readiness(): Promise<boolean> {
    return this.#readiness(this.pool);
  }

  async readinessEvidence(requiredMigration: string): Promise<RepositoryReadinessEvidence> {
    let client: PoolClient | undefined;
    let transactionStarted = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      const ready = await this.#readiness(client);
      const result = await client.query<{
        required_migration_applied: boolean;
        migration_head: string | null;
      } & PostgresActiveRecoveryProjectionRow>(
        `WITH active_recovery AS MATERIALIZED (
           SELECT version_row.compiled_case
           FROM accounting_cases case_row
           JOIN accounting_case_versions version_row
             ON version_row.case_id = case_row.case_id
            AND version_row.version = case_row.current_version
           WHERE version_row.state <> 'TERMINAL'
             AND (
               version_row.state = 'RECOVERY_REQUIRED'
               OR EXISTS (
                 SELECT 1
                 FROM accounting_case_operations operation_row
                 WHERE operation_row.case_id = version_row.case_id
                   AND operation_row.case_version = version_row.version
                   AND operation_row.state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
               )
             )
         )
         SELECT
           EXISTS (
             SELECT 1 FROM schema_migrations
             WHERE version = $1
           ) AS required_migration_applied,
           (SELECT MAX(version) FROM schema_migrations) AS migration_head,
           (SELECT COUNT(*)::text FROM active_recovery) AS active_recovery_case_count,
           ARRAY(
             SELECT DISTINCT recovery.compiled_case #>> '{policyProjection,schemaVersion}'
             FROM active_recovery recovery
             WHERE jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string'
             ORDER BY recovery.compiled_case #>> '{policyProjection,schemaVersion}'
           ) AS stored_policy_projection_versions,
           ARRAY(
             SELECT DISTINCT recovery.compiled_case #>> '{providerProjection,schemaVersion}'
             FROM active_recovery recovery
             WHERE jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string'
             ORDER BY recovery.compiled_case #>> '{providerProjection,schemaVersion}'
           ) AS stored_provider_projection_versions,
           COALESCE((
             SELECT BOOL_AND(
               COALESCE(jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string', false)
               AND COALESCE(jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string', false)
               AND COALESCE(recovery.compiled_case #>> '{policyProjection,schemaVersion}'
                 ~ '^xero-(sg-accounting-policy|declared-ledger-policy)-projection:v[1-9][0-9]*$', false)
               AND COALESCE(recovery.compiled_case #>> '{providerProjection,schemaVersion}'
                 ~ '^xero-accounting-case-provider-projection:v[1-9][0-9]*$', false)
             )
             FROM active_recovery recovery
           ), true) AS active_recovery_projection_valid,
           COALESCE((
             SELECT BOOL_AND(
               COALESCE(jsonb_typeof(recovery.compiled_case #> '{policyProjection,schemaVersion}') = 'string', false)
               AND COALESCE(recovery.compiled_case #>> '{policyProjection,schemaVersion}' = $2, false)
               AND COALESCE(jsonb_typeof(recovery.compiled_case #> '{providerProjection,schemaVersion}') = 'string', false)
               AND COALESCE(recovery.compiled_case #>> '{providerProjection,schemaVersion}' = $3, false)
             )
             FROM active_recovery recovery
           ), true) AS active_recovery_projection_compatible`,
        [
          requiredMigration,
          XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
          XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
        ],
      );
      const requiredMigrationApplied = result.rows[0]?.required_migration_applied === true;
      const row = result.rows[0];
      if (!row) throw new Error("REPOSITORY_READINESS_QUERY_EMPTY");
      const activeAccountingCaseRecoveryProjection =
        activeAccountingCaseRecoveryProjectionEvidenceFromPostgres(row);
      const authorityResult = await client.query(
        `SELECT snapshots.*, clock.repository_observed_at
         FROM (SELECT statement_timestamp() AS repository_observed_at) clock
         LEFT JOIN ledger_authority_snapshots snapshots ON snapshots.provider_id = 'xero'`,
      );
      const authorityRow = authorityResult.rows[0] as Row | undefined;
      const authoritySnapshot = authorityRow?.provider_id
        ? mapLedgerAuthoritySnapshot(authorityRow)
        : undefined;
      const firmGovernance = ledgerFirmGovernanceReadinessEvidence(
        authoritySnapshot,
        authorityRow ? date(authorityRow.repository_observed_at) : new Date(Number.NaN),
      );
      const evidence: RepositoryReadinessEvidence = {
        ready: ready && requiredMigrationApplied &&
          activeAccountingCaseRecoveryProjection.status === "COMPATIBLE",
        storageMode: "POSTGRES",
        requiredMigration,
        requiredMigrationStatus: requiredMigrationApplied ? "APPLIED" : "MISSING",
        migrationHead: row.migration_head ?? null,
        activeAccountingCaseRecoveryProjection,
        authoritySnapshotRevision: authoritySnapshot?.revision ?? null,
        authoritySnapshotHash: authoritySnapshot?.snapshotHash ?? null,
        authorityContentHash: authoritySnapshot?.contentHash ?? null,
        authorityWriteKillSwitchEnabled: authoritySnapshot?.writeKillSwitchEnabled ?? null,
        firmGovernance,
      };
      await client.query("COMMIT");
      transactionStarted = false;
      return evidence;
    } catch {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Public readiness remains fail-closed even when rollback reporting fails.
        }
      }
      return {
        ready: false,
        storageMode: "POSTGRES",
        requiredMigration,
        requiredMigrationStatus: "UNKNOWN",
        migrationHead: null,
        activeAccountingCaseRecoveryProjection:
          unknownActiveAccountingCaseRecoveryProjectionEvidence(),
        authoritySnapshotRevision: null,
        authoritySnapshotHash: null,
        authorityContentHash: null,
        authorityWriteKillSwitchEnabled: null,
        firmGovernance: ledgerFirmGovernanceReadinessEvidence(undefined, new Date(Number.NaN)),
      };
    } finally {
      client?.release();
    }
  }

  async publishLedgerAuthoritySnapshot(
    input: PublishLedgerAuthoritySnapshotInput,
  ): Promise<PublishLedgerAuthoritySnapshotResult> {
    const candidate = createLedgerAuthoritySnapshot(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Row locks cannot serialize the first publication because the provider
      // row does not exist yet. This provider-scoped transaction lock closes
      // that bootstrap race across concurrently starting old/new pods.
      await client.query(
        "SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)",
        [2_026_081_302, candidate.providerId],
      );
      const selected = await client.query(
        "SELECT * FROM ledger_authority_snapshots WHERE provider_id = $1 FOR UPDATE",
        [candidate.providerId],
      );
      let current: LedgerAuthoritySnapshot | undefined;
      let legacyRevision: number | undefined;
      if (selected.rows[0]) {
        try {
          current = mapLedgerAuthoritySnapshot(selected.rows[0] as Row);
        } catch (error) {
          if (!(error instanceof LegacyLedgerAuthoritySnapshotError)) throw error;
          legacyRevision = error.revision;
        }
      }
      if (legacyRevision !== undefined && candidate.revision <= legacyRevision) {
        throw new AppError("CONFLICT", "Legacy authority v1 requires a strictly higher v2 revision.", {
          httpStatus: 409,
        });
      }
      if (current && candidate.revision < current.revision) {
        throw new AppError("CONFLICT", "Ledger authority snapshot revision cannot decrease.", { httpStatus: 409 });
      }
      if (current && candidate.revision === current.revision) {
        if (candidate.snapshotHash !== current.snapshotHash) {
          throw new AppError(
            "CONFLICT",
            "Ledger authority snapshot revision cannot identify different content.",
            { httpStatus: 409 },
          );
        }
        await client.query("COMMIT");
        return { snapshot: current, mode: "IDEMPOTENT_REPLAY" };
      }
      const stored = await client.query(
        `INSERT INTO ledger_authority_snapshots(
           provider_id, revision, snapshot_hash, write_kill_switch_enabled,
           standing_delegations, published_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
         ON CONFLICT (provider_id) DO UPDATE SET
           revision = EXCLUDED.revision,
           snapshot_hash = EXCLUDED.snapshot_hash,
           write_kill_switch_enabled = EXCLUDED.write_kill_switch_enabled,
           standing_delegations = EXCLUDED.standing_delegations,
           published_at = EXCLUDED.published_at,
           updated_at = EXCLUDED.updated_at
         WHERE ledger_authority_snapshots.revision < EXCLUDED.revision
         RETURNING *`,
        [
          candidate.providerId,
          candidate.revision,
          candidate.snapshotHash,
          candidate.writeKillSwitchEnabled,
          JSON.stringify(candidate.standingDelegations),
          candidate.publishedAt,
        ],
      );
      if (!stored.rows[0]) {
        const concurrent = await client.query(
          "SELECT * FROM ledger_authority_snapshots WHERE provider_id = $1 FOR UPDATE",
          [candidate.providerId],
        );
        const resolved = concurrent.rows[0]
          ? mapLedgerAuthoritySnapshot(concurrent.rows[0] as Row)
          : undefined;
        if (resolved?.revision === candidate.revision && resolved.snapshotHash === candidate.snapshotHash) {
          await client.query("COMMIT");
          return { snapshot: resolved, mode: "IDEMPOTENT_REPLAY" };
        }
        throw new AppError(
          "CONFLICT",
          resolved && resolved.revision > candidate.revision
            ? "Ledger authority snapshot revision cannot decrease."
            : "Ledger authority snapshot revision cannot identify different content.",
          { httpStatus: 409 },
        );
      }
      await client.query("COMMIT");
      return {
        snapshot: mapLedgerAuthoritySnapshot(stored.rows[0] as Row),
        mode: current || legacyRevision !== undefined ? "ADVANCED" : "CREATED",
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLedgerAuthoritySnapshot(providerId: string): Promise<LedgerAuthoritySnapshot | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM ledger_authority_snapshots WHERE provider_id = $1",
      [providerId],
    );
    return result.rows[0] ? mapLedgerAuthoritySnapshot(result.rows[0] as Row) : undefined;
  }

  async ledgerAuthorityReadiness(providerId: string): Promise<LedgerAuthorityRepositoryReadiness> {
    const result = await this.pool.query(
      `SELECT snapshots.*, clock.repository_observed_at
       FROM (SELECT statement_timestamp() AS repository_observed_at) clock
       LEFT JOIN ledger_authority_snapshots snapshots ON snapshots.provider_id = $1`,
      [providerId],
    );
    const row = result.rows[0] as Row | undefined;
    const repositoryObservedAt = row ? date(row.repository_observed_at) : new Date(Number.NaN);
    const snapshot = row?.provider_id ? mapLedgerAuthoritySnapshot(row) : undefined;
    return {
      ...(snapshot ? { snapshot } : {}),
      firmGovernance: ledgerFirmGovernanceReadinessEvidence(snapshot, repositoryObservedAt),
    };
  }

  async saveProviderAuthorization(providerAuthorization: ProviderAuthorization): Promise<ProviderAuthorization> {
    const result = await this.pool.query(
      `INSERT INTO provider_authorizations(
         authorization_id, workspace_id, authorized_by_subject, provider, provider_subject,
         granted_scopes, token_ciphertext, token_expires_at, refresh_version,
         authorization_status, revoked_at, created_at, updated_at
       ) VALUES ($1,$2,$3,'xero',$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (authorization_id) DO NOTHING
       RETURNING *`,
      [
        providerAuthorization.authorizationId,
        providerAuthorization.workspaceId,
        providerAuthorization.authorizedBySubject,
        providerAuthorization.providerSubject ?? null,
        providerAuthorization.grantedScopes,
        providerAuthorization.tokenCiphertext,
        providerAuthorization.tokenExpiresAt,
        providerAuthorization.refreshVersion,
        providerAuthorization.status,
        providerAuthorization.revokedAt ?? null,
        providerAuthorization.createdAt,
        providerAuthorization.updatedAt,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError("CONFLICT", "Provider authorization identifier already exists.", { httpStatus: 409 });
    }
    return mapProviderAuthorization(result.rows[0]);
  }

  async getProviderAuthorization(
    authorizationId: string,
    workspaceId: string,
    authorizedBySubject: string,
  ): Promise<ProviderAuthorization | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM provider_authorizations
       WHERE authorization_id = $1 AND workspace_id = $2 AND authorized_by_subject = $3`,
      [authorizationId, workspaceId, authorizedBySubject],
    );
    return result.rows[0] ? mapProviderAuthorization(result.rows[0]) : undefined;
  }

  async updateProviderAuthorizationToken(
    authorizationId: string,
    workspaceId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
    grantedScopes: string[],
  ): Promise<ProviderAuthorization | undefined> {
    const result = await this.pool.query(
      `UPDATE provider_authorizations SET
         token_ciphertext = $4,
         token_expires_at = $5,
         granted_scopes = $6,
         refresh_version = refresh_version + 1,
         authorization_status = 'ACTIVE',
         revoked_at = NULL,
         updated_at = now()
       WHERE authorization_id = $1 AND workspace_id = $2
         AND refresh_version = $3 AND authorization_status <> 'REVOKED'
       RETURNING *`,
      [authorizationId, workspaceId, expectedRefreshVersion, tokenCiphertext, tokenExpiresAt, grantedScopes],
    );
    return result.rows[0] ? mapProviderAuthorization(result.rows[0]) : undefined;
  }

  async markProviderAuthorizationStatus(
    authorizationId: string,
    workspaceId: string,
    status: ProviderAuthorization["status"],
    changedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE provider_authorizations SET
         authorization_status = $3,
         revoked_at = CASE WHEN $3 = 'REVOKED' THEN $4 ELSE revoked_at END,
         updated_at = $4
       WHERE authorization_id = $1 AND workspace_id = $2
         AND authorization_status <> 'REVOKED'`,
      [authorizationId, workspaceId, status, changedAt],
    );
    return result.rowCount === 1;
  }

  async upsertAuthorizedProviderConnection(
    workspaceId: string,
    connection: AuthorizedProviderConnection,
  ): Promise<AuthorizedProviderConnection> {
    const result = await this.pool.query(
      `INSERT INTO provider_connections(
         connection_id, authorization_id, provider, tenant_id, tenant_name, tenant_short_code,
         provider_connection_id, last_verified_at, granted_scopes, refresh_version,
         connection_status, created_at, updated_at
       )
       SELECT $2, provider_auth.authorization_id, 'xero', $4, $5, $6, $7, $8, '{}', 0, $9, $10, $11
       FROM provider_authorizations provider_auth
       WHERE provider_auth.authorization_id = $3
         AND provider_auth.workspace_id = $1
         AND provider_auth.authorization_status = 'ACTIVE'
       ON CONFLICT (authorization_id, tenant_id) WHERE authorization_id IS NOT NULL
       DO UPDATE SET
         tenant_name = EXCLUDED.tenant_name,
         tenant_short_code = EXCLUDED.tenant_short_code,
         provider_connection_id = EXCLUDED.provider_connection_id,
         last_verified_at = EXCLUDED.last_verified_at,
         connection_status = EXCLUDED.connection_status,
         updated_at = EXCLUDED.updated_at
       WHERE provider_connections.connection_status <> 'REVOKED'
       RETURNING *`,
      [
        workspaceId,
        connection.connectionId,
        connection.authorizationId,
        connection.tenantId,
        connection.tenantName,
        connection.tenantShortCode ?? null,
        connection.providerConnectionId ?? null,
        connection.lastVerifiedAt ?? null,
        connection.status,
        connection.createdAt,
        connection.updatedAt,
      ],
    );
    if (!result.rows[0]) {
      const terminal = await this.pool.query(
        `SELECT 1 FROM provider_connections
         WHERE authorization_id = $1 AND tenant_id = $2 AND connection_status = 'REVOKED'`,
        [connection.authorizationId, connection.tenantId],
      );
      if (terminal.rowCount === 1) {
        throw new AppError("CONFLICT", "A revoked provider connection cannot be reactivated.", {
          httpStatus: 409,
        });
      }
      throw new AppError("FORBIDDEN", "Provider authorization does not belong to this active workspace.", {
        httpStatus: 403,
      });
    }
    return mapAuthorizedConnection(result.rows[0]);
  }

  async listActiveConnectionsByAuthorization(
    authorizationId: string,
    workspaceId: string,
  ): Promise<AuthorizedProviderConnection[]> {
    const result = await this.pool.query(
      `SELECT connection.*
       FROM provider_connections connection
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE connection.authorization_id = $1
         AND provider_auth.workspace_id = $2
         AND provider_auth.authorization_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
       ORDER BY connection.created_at, connection.connection_id`,
      [authorizationId, workspaceId],
    );
    return result.rows.map(mapAuthorizedConnection);
  }

  async saveOAuthInstallation(installation: OAuthInstallation): Promise<OAuthInstallation> {
    const result = await this.pool.query(
      `INSERT INTO oauth_installations(
         installation_id, workspace_id, subject_type, subject_id, agent_id, oauth_client_id,
         installation_status, revoked_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (installation_id) DO UPDATE SET
         installation_status = EXCLUDED.installation_status,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = EXCLUDED.updated_at
       WHERE oauth_installations.workspace_id = EXCLUDED.workspace_id
         AND oauth_installations.subject_type = EXCLUDED.subject_type
         AND oauth_installations.subject_id = EXCLUDED.subject_id
         AND oauth_installations.agent_id = EXCLUDED.agent_id
         AND oauth_installations.oauth_client_id = EXCLUDED.oauth_client_id
         AND oauth_installations.installation_status <> 'REVOKED'
       RETURNING *`,
      [
        installation.installationId,
        installation.workspaceId,
        installation.subjectType,
        installation.subjectId,
        installation.agentId,
        installation.clientId,
        installation.status,
        installation.revokedAt ?? null,
        installation.createdAt,
        installation.updatedAt,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError("CONFLICT", "OAuth installation identity cannot be changed or reactivated.", {
        httpStatus: 409,
      });
    }
    return mapOAuthInstallation(result.rows[0]);
  }

  async saveAgentConnectionBinding(binding: AgentConnectionBinding): Promise<AgentConnectionBinding> {
    const result = await this.pool.query(
      `INSERT INTO agent_connection_bindings(
         binding_id, oauth_installation_id, workspace_id, subject_type, subject_id,
         agent_id, connection_id, policy_id, binding_status, revoked_at, created_at, updated_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       FROM oauth_installations installation
       JOIN provider_connections connection ON connection.connection_id = $7
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE installation.installation_id = $2
         AND installation.workspace_id = $3
         AND installation.subject_type = $4
         AND installation.subject_id = $5
         AND installation.agent_id = $6
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.workspace_id = $3
         AND provider_auth.authorization_status = 'ACTIVE'
       ON CONFLICT (binding_id) DO UPDATE SET
         policy_id = EXCLUDED.policy_id,
         binding_status = EXCLUDED.binding_status,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = EXCLUDED.updated_at
       WHERE agent_connection_bindings.oauth_installation_id = EXCLUDED.oauth_installation_id
         AND agent_connection_bindings.workspace_id = EXCLUDED.workspace_id
         AND agent_connection_bindings.subject_type = EXCLUDED.subject_type
         AND agent_connection_bindings.subject_id = EXCLUDED.subject_id
         AND agent_connection_bindings.agent_id = EXCLUDED.agent_id
         AND agent_connection_bindings.connection_id = EXCLUDED.connection_id
         AND agent_connection_bindings.binding_status <> 'REVOKED'
       RETURNING *`,
      [
        binding.bindingId,
        binding.installationId,
        binding.workspaceId,
        binding.subjectType,
        binding.subjectId,
        binding.agentId,
        binding.connectionId,
        binding.policyId,
        binding.status,
        binding.revokedAt ?? null,
        binding.createdAt,
        binding.updatedAt,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError("FORBIDDEN", "Binding identity, installation, and provider connection do not align.", {
        httpStatus: 403,
      });
    }
    await this.pool.query(
      `INSERT INTO oauth_installation_active_bindings(
         oauth_installation_id, binding_id, connection_id, binding_revision, changed_at
       ) VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (oauth_installation_id) DO NOTHING`,
      [binding.installationId, binding.bindingId, binding.connectionId, binding.updatedAt],
    );
    return mapAgentConnectionBinding(result.rows[0]);
  }

  async resolveAgentConnectionBinding(
    input: ResolveAgentConnectionBindingInput,
  ): Promise<ResolvedAgentConnectionBinding | undefined> {
    const result = await this.pool.query(
      `SELECT binding.*, active.binding_revision, connection.authorization_id, connection.tenant_id,
              connection.tenant_name, connection.provider_connection_id
       FROM agent_connection_bindings binding
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN oauth_installation_active_bindings active
         ON active.oauth_installation_id = binding.oauth_installation_id
        AND active.binding_id = binding.binding_id
        AND active.connection_id = binding.connection_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE binding.binding_id = $1
         AND binding.oauth_installation_id = $2
         AND binding.workspace_id = $3
         AND binding.subject_type = $4
         AND binding.subject_id = $5
         AND binding.agent_id = $6
         AND binding.connection_id = $7
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND installation.workspace_id = binding.workspace_id
         AND installation.subject_type = binding.subject_type
         AND installation.subject_id = binding.subject_id
         AND installation.agent_id = binding.agent_id
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id`,
      [
        input.bindingId,
        input.installationId,
        input.workspaceId,
        input.subjectType,
        input.subjectId,
        input.agentId,
        input.connectionId,
      ],
    );
    return result.rows[0] ? mapResolvedAgentBinding(result.rows[0]) : undefined;
  }

  async saveOrganisationSwitchSession(session: OrganisationSwitchSession): Promise<void> {
    if (
      !isHashedValue(session.sessionHash) ||
      !isValidDate(session.createdAt) ||
      !isValidDate(session.expiresAt) ||
      session.expiresAt <= session.createdAt ||
      session.expiresAt.getTime() - session.createdAt.getTime() > 15 * 60_000 ||
      session.consumedAt
    ) {
      throw new AppError("VALIDATION_FAILED", "Organisation switch session is invalid.");
    }
    const result = await this.pool.query(
      `INSERT INTO organisation_switch_sessions(
         session_hash, oauth_installation_id, workspace_id, subject_type, subject_id,
         agent_id, authorization_id, source_binding_id, source_connection_id,
         source_target_session_hash, created_at, expires_at, consumed_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL
       FROM agent_connection_bindings binding
       JOIN oauth_installation_active_bindings active
         ON active.oauth_installation_id = binding.oauth_installation_id
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE active.oauth_installation_id = $2
         AND binding.binding_id = $8
         AND binding.connection_id = $9
         AND binding.workspace_id = $3
         AND binding.subject_type = $4
         AND binding.subject_id = $5
         AND binding.agent_id = $6
         AND connection.authorization_id = $7
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id
         AND (
           ($10::text IS NULL AND active.binding_id = $8 AND active.connection_id = $9)
           OR
           ($10::text IS NOT NULL AND EXISTS (
             SELECT 1 FROM ledger_target_sessions target
             WHERE target.session_hash = $10
               AND target.oauth_installation_id = $2
               AND target.binding_id = $8
               AND target.connection_id = $9
               AND target.revoked_at IS NULL
               AND target.expires_at > $11
           ))
         )
       ON CONFLICT DO NOTHING
       RETURNING session_hash`,
      [
        session.sessionHash,
        session.installationId,
        session.workspaceId,
        session.subjectType,
        session.subjectId,
        session.agentId,
        session.authorizationId,
        session.sourceBindingId,
        session.sourceConnectionId,
        session.sourceTargetSessionHash ?? null,
        session.createdAt,
        session.expiresAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AppError("FORBIDDEN", "Organisation switch source target is no longer active.", {
        httpStatus: 403,
      });
    }
  }

  async getOrganisationSwitchContext(
    sessionHash: string,
    now: Date,
  ): Promise<OrganisationSwitchContext | undefined> {
    if (!isValidDate(now)) return undefined;
    const result = await this.pool.query(
      `SELECT switch.*, binding.*,
              COALESCE(target.binding_revision, active.binding_revision) AS binding_revision,
              connection.authorization_id, connection.tenant_id,
              connection.tenant_name, connection.provider_connection_id
       FROM organisation_switch_sessions switch
       JOIN oauth_installation_active_bindings active
         ON active.oauth_installation_id = switch.oauth_installation_id
       JOIN agent_connection_bindings binding
         ON binding.binding_id = switch.source_binding_id
        AND binding.oauth_installation_id = switch.oauth_installation_id
        AND binding.connection_id = switch.source_connection_id
       LEFT JOIN ledger_target_sessions target
         ON target.session_hash = switch.source_target_session_hash
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE switch.session_hash = $1
         AND switch.consumed_at IS NULL
         AND switch.expires_at > $2
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND connection.authorization_id = switch.authorization_id
         AND provider_auth.workspace_id = switch.workspace_id
         AND (
           (switch.source_target_session_hash IS NULL
             AND active.binding_id = switch.source_binding_id
             AND active.connection_id = switch.source_connection_id)
           OR
           (switch.source_target_session_hash IS NOT NULL
             AND target.oauth_installation_id = switch.oauth_installation_id
             AND target.binding_id = switch.source_binding_id
             AND target.connection_id = switch.source_connection_id
             AND target.revoked_at IS NULL
             AND target.expires_at > $2)
         )`,
      [sessionHash, now],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    const session = mapOrganisationSwitchSession(row);
    const connections = await this.listActiveConnectionsByAuthorization(
      session.authorizationId,
      session.workspaceId,
    );
    if (connections.length === 0) return undefined;
    return {
      session,
      currentBinding: mapResolvedAgentBinding(row),
      connections,
    };
  }

  async completeOrganisationSwitch(
    input: CompleteOrganisationSwitchInput,
  ): Promise<CompleteOrganisationSwitchResult | undefined> {
    if (!isValidDate(input.now) || !isNonEmpty(input.newBindingId)) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT * FROM organisation_switch_sessions
         WHERE session_hash = $1
         FOR UPDATE`,
        [input.sessionHash],
      );
      const sessionRow = selected.rows[0] as Row | undefined;
      if (!sessionRow || sessionRow.consumed_at || date(sessionRow.expires_at) <= input.now) {
        await client.query("COMMIT");
        return undefined;
      }
      const globalActiveResult = await client.query(
        `SELECT active.binding_id AS active_binding_id,
                active.connection_id AS active_connection_id,
                active.binding_revision AS active_binding_revision
         FROM oauth_installation_active_bindings active
         JOIN agent_connection_bindings binding
           ON binding.binding_id = active.binding_id
          AND binding.oauth_installation_id = active.oauth_installation_id
          AND binding.connection_id = active.connection_id
         JOIN oauth_installations installation
           ON installation.installation_id = binding.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = binding.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE active.oauth_installation_id = $1
           AND binding.binding_status = 'ACTIVE'
           AND installation.installation_status = 'ACTIVE'
           AND connection.connection_status = 'ACTIVE'
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = binding.workspace_id
         FOR UPDATE OF active`,
        [sessionRow.oauth_installation_id],
      );
      const globalActiveRow = globalActiveResult.rows[0] as Row | undefined;
      if (!globalActiveRow) {
        await client.query("COMMIT");
        return undefined;
      }
      const sourceResult = await client.query(
        `SELECT binding.*,
                COALESCE((
                  SELECT target.binding_revision
                  FROM ledger_target_sessions target
                  WHERE target.session_hash = $8
                    AND target.oauth_installation_id = binding.oauth_installation_id
                    AND target.binding_id = binding.binding_id
                    AND target.connection_id = binding.connection_id
                    AND target.revoked_at IS NULL
                    AND target.expires_at > $9
                ), active.binding_revision) AS binding_revision,
                connection.authorization_id, connection.tenant_id,
                connection.tenant_name, connection.provider_connection_id
         FROM agent_connection_bindings binding
         JOIN oauth_installation_active_bindings active
           ON active.oauth_installation_id = binding.oauth_installation_id
         JOIN oauth_installations installation
           ON installation.installation_id = binding.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = binding.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE binding.oauth_installation_id = $1
           AND binding.binding_id = $2
           AND binding.connection_id = $3
           AND binding.workspace_id = $4
           AND binding.subject_type = $5
           AND binding.subject_id = $6
           AND binding.agent_id = $7
           AND binding.binding_status = 'ACTIVE'
           AND installation.installation_status = 'ACTIVE'
           AND connection.connection_status = 'ACTIVE'
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = binding.workspace_id
           AND connection.authorization_id = $10
           AND (
             ($8::text IS NULL AND active.binding_id = binding.binding_id
               AND active.connection_id = binding.connection_id)
             OR
             ($8::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM ledger_target_sessions target
               WHERE target.session_hash = $8
                 AND target.oauth_installation_id = binding.oauth_installation_id
                 AND target.binding_id = binding.binding_id
                 AND target.connection_id = binding.connection_id
                 AND target.revoked_at IS NULL
                 AND target.expires_at > $9
             ))
           )
         FOR UPDATE OF binding, connection, provider_auth`,
        [
          sessionRow.oauth_installation_id,
          sessionRow.source_binding_id,
          sessionRow.source_connection_id,
          sessionRow.workspace_id,
          sessionRow.subject_type,
          sessionRow.subject_id,
          sessionRow.agent_id,
          sessionRow.source_target_session_hash ?? null,
          input.now,
          sessionRow.authorization_id,
        ],
      );
      const previousRow = sourceResult.rows[0] as Row | undefined;
      if (!previousRow) {
        await client.query("COMMIT");
        return undefined;
      }
      const targetResult = await client.query(
        `SELECT connection.*
         FROM provider_connections connection
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE connection.connection_id = $1
           AND connection.authorization_id = $2
           AND connection.connection_status = 'ACTIVE'
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = $3
         FOR UPDATE OF connection, provider_auth`,
        [input.selectedConnectionId, sessionRow.authorization_id, sessionRow.workspace_id],
      );
      const targetConnection = targetResult.rows[0] as Row | undefined;
      if (!targetConnection) {
        await client.query("COMMIT");
        return undefined;
      }
      let targetBindingResult = await client.query(
        `SELECT binding.*, connection.authorization_id, connection.tenant_id,
                connection.tenant_name, connection.provider_connection_id
         FROM agent_connection_bindings binding
         JOIN provider_connections connection ON connection.connection_id = binding.connection_id
         WHERE binding.oauth_installation_id = $1
           AND binding.connection_id = $2
           AND binding.binding_status = 'ACTIVE'
         ORDER BY binding.updated_at DESC, binding.binding_id DESC
         LIMIT 1
         FOR UPDATE OF binding`,
        [sessionRow.oauth_installation_id, input.selectedConnectionId],
      );
      if (targetBindingResult.rowCount === 0) {
        targetBindingResult = await client.query(
          `INSERT INTO agent_connection_bindings(
             binding_id, oauth_installation_id, workspace_id, subject_type, subject_id,
             agent_id, connection_id, policy_id, binding_status, revoked_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',NULL,$9,$9)
           ON CONFLICT DO NOTHING
           RETURNING *,
             $10::text AS authorization_id,
             $11::text AS tenant_id,
             $12::text AS tenant_name,
             $13::text AS provider_connection_id`,
          [
            input.newBindingId,
            sessionRow.oauth_installation_id,
            sessionRow.workspace_id,
            sessionRow.subject_type,
            sessionRow.subject_id,
            sessionRow.agent_id,
            input.selectedConnectionId,
            previousRow.policy_id,
            input.now,
            targetConnection.authorization_id,
            targetConnection.tenant_id,
            targetConnection.tenant_name,
            targetConnection.provider_connection_id ?? null,
          ],
        );
      }
      const targetBindingRow = targetBindingResult.rows[0] as Row | undefined;
      if (!targetBindingRow) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const updatedActive = await client.query(
        `UPDATE oauth_installation_active_bindings SET
           binding_id = $2,
           connection_id = $3,
           binding_revision = binding_revision + 1,
           changed_at = $4
         WHERE oauth_installation_id = $1
           AND binding_id = $5
           AND connection_id = $6
         RETURNING binding_revision`,
        [
          sessionRow.oauth_installation_id,
          targetBindingRow.binding_id,
          targetBindingRow.connection_id,
          input.now,
          globalActiveRow.active_binding_id,
          globalActiveRow.active_connection_id,
        ],
      );
      if (updatedActive.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const consumed = await client.query(
        `UPDATE organisation_switch_sessions SET consumed_at = $2
         WHERE session_hash = $1 AND consumed_at IS NULL
         RETURNING *`,
        [input.sessionHash, input.now],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      let sourceTargetRevoked = false;
      if (sessionRow.source_target_session_hash) {
        const revoked = await client.query(
          `UPDATE ledger_target_sessions SET revoked_at = $3
           WHERE session_hash = $1
             AND oauth_installation_id = $2
             AND revoked_at IS NULL
             AND expires_at > $3
           RETURNING session_hash`,
          [sessionRow.source_target_session_hash, sessionRow.oauth_installation_id, input.now],
        );
        if (revoked.rowCount !== 1) {
          await client.query("ROLLBACK");
          return undefined;
        }
        sourceTargetRevoked = true;
      }
      await client.query("COMMIT");
      const currentBindingRow: Row = {
        ...targetBindingRow,
        binding_revision: updatedActive.rows[0]?.binding_revision,
      };
      return {
        session: mapOrganisationSwitchSession(consumed.rows[0] as Row),
        previousBinding: mapResolvedAgentBinding(previousRow),
        currentBinding: mapResolvedAgentBinding(currentBindingRow),
        changed: String(previousRow.connection_id) !== String(targetBindingRow.connection_id),
        sourceTargetRevoked,
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
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
      session.revokedAt
    ) {
      throw new AppError("VALIDATION_FAILED", "Ledger target session is invalid.");
    }
    const result = await this.pool.query(
      `INSERT INTO ledger_target_sessions(
         session_hash, session_id, oauth_installation_id, binding_id, connection_id,
         binding_revision, created_at, expires_at, last_used_at, revoked_at
       )
       SELECT $1,$2,binding.oauth_installation_id,binding.binding_id,binding.connection_id,
              active.binding_revision,$6,$7,NULL,NULL
       FROM oauth_installation_active_bindings active
       JOIN agent_connection_bindings binding
         ON binding.oauth_installation_id = active.oauth_installation_id
        AND binding.binding_id = active.binding_id
        AND binding.connection_id = active.connection_id
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE binding.oauth_installation_id = $3
         AND binding.binding_id = $4
         AND binding.connection_id = $5
         AND active.binding_revision = $8
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
       ON CONFLICT DO NOTHING
       RETURNING session_hash`,
      [
        session.sessionHash,
        session.sessionId,
        session.installationId,
        session.bindingId,
        session.connectionId,
        session.createdAt,
        session.expiresAt,
        session.bindingRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AppError("FORBIDDEN", "Ledger target session does not match the current installation binding.", {
        httpStatus: 403,
      });
    }
  }

  async resolveLedgerTargetSession(
    input: ResolveLedgerTargetSessionInput,
  ): Promise<ResolvedLedgerTargetSession | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const result = await this.pool.query(
      `UPDATE ledger_target_sessions target SET last_used_at = $7
       FROM agent_connection_bindings binding
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE target.session_hash = $1
         AND target.oauth_installation_id = $2
         AND target.oauth_installation_id = binding.oauth_installation_id
         AND target.binding_id = binding.binding_id
         AND target.connection_id = binding.connection_id
         AND binding.workspace_id = $3
         AND binding.subject_type = $4
         AND binding.subject_id = $5
         AND binding.agent_id = $6
         AND target.revoked_at IS NULL
         AND target.expires_at > $7
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id
       RETURNING target.*,
         binding.workspace_id, binding.subject_type, binding.subject_id, binding.agent_id,
         binding.policy_id, connection.authorization_id, connection.tenant_id,
         connection.tenant_name, connection.provider_connection_id`,
      [
        input.sessionHash,
        input.installationId,
        input.workspaceId,
        input.subjectType,
        input.subjectId,
        input.agentId,
        input.now,
      ],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      session: mapLedgerTargetSession(row),
      binding: mapResolvedAgentBinding(row),
    };
  }

  async revokeLedgerTargetSession(
    sessionHash: string,
    installationId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/u.test(sessionHash) || !isNonEmpty(installationId) || !isValidDate(revokedAt)) return false;
    const result = await this.pool.query(
      `UPDATE ledger_target_sessions SET revoked_at = $3
       WHERE session_hash = $1
         AND oauth_installation_id = $2
         AND revoked_at IS NULL
         AND expires_at > $3
       RETURNING session_hash`,
      [sessionHash, installationId, revokedAt],
    );
    return result.rowCount === 1;
  }

  async revokeOAuthInstallation(installationId: string, workspaceId: string, revokedAt: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const refreshFamilies = await client.query<{ family_id: string }>(
        `SELECT family.family_id
         FROM mcp_refresh_token_families family
         JOIN oauth_installations installation
           ON installation.installation_id = family.oauth_installation_id
         WHERE family.oauth_installation_id = $1 AND installation.workspace_id = $2
         ORDER BY family.family_id`,
        [installationId, workspaceId],
      );
      for (const row of refreshFamilies.rows) {
        await this.#lockMcpRefreshFamily(client, row.family_id);
      }
      const installation = await client.query(
        `UPDATE oauth_installations SET
           installation_status = 'REVOKED', revoked_at = COALESCE(revoked_at, $3), updated_at = $3
         WHERE installation_id = $1 AND workspace_id = $2
         RETURNING installation_id`,
        [installationId, workspaceId, revokedAt],
      );
      if (installation.rowCount !== 1) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE agent_connection_bindings SET
           binding_status = 'REVOKED', revoked_at = COALESCE(revoked_at, $2), updated_at = $2
         WHERE oauth_installation_id = $1`,
        [installationId, revokedAt],
      );
      await client.query(
        `UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, $2)
         WHERE oauth_installation_id = $1`,
        [installationId, revokedAt],
      );
      await client.query(
        `UPDATE mcp_refresh_tokens refresh_token SET revoked_at = COALESCE(refresh_token.revoked_at, $2)
         FROM mcp_refresh_token_families family
         WHERE refresh_token.family_id = family.family_id
           AND family.oauth_installation_id = $1`,
        [installationId, revokedAt],
      );
      await client.query(
        `UPDATE mcp_refresh_token_families SET
           family_status = 'REVOKED', revoked_at = COALESCE(revoked_at, $2), updated_at = $2
         WHERE oauth_installation_id = $1`,
        [installationId, revokedAt],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveOAuthBrokerFlow(flow: OAuthBrokerFlow): Promise<void> {
    if (flow.pkceCodeChallengeMethod !== "S256" || flow.expiresAt <= flow.createdAt) {
      throw new AppError("VALIDATION_FAILED", "OAuth broker flow lifetime or PKCE method is invalid.");
    }
    const result = await this.pool.query(
      `INSERT INTO oauth_broker_flows(
         flow_hash, browser_session_hash, oauth_client_id, redirect_uri,
         pkce_code_challenge, pkce_code_challenge_method,
         workspace_id, subject_type, subject_id, agent_id, requested_scopes,
         expires_at, consumed_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,'S256',$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (flow_hash) DO NOTHING`,
      [
        flow.flowHash,
        flow.browserSessionHash,
        flow.clientId,
        flow.redirectUri,
        flow.pkceCodeChallenge,
        flow.workspaceId,
        flow.subjectType,
        flow.subjectId,
        flow.agentId,
        flow.requestedScopes,
        flow.expiresAt,
        flow.consumedAt ?? null,
        flow.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AppError("CONFLICT", "OAuth broker flow identifier already exists.", { httpStatus: 409 });
    }
  }

  async consumeOAuthBrokerFlow(input: ConsumeOAuthBrokerFlowInput): Promise<OAuthBrokerFlow | undefined> {
    const result = await this.pool.query(
      `UPDATE oauth_broker_flows SET consumed_at = $5
       WHERE flow_hash = $1
         AND browser_session_hash = $2
         AND oauth_client_id = $3
         AND redirect_uri = $4
         AND consumed_at IS NULL
         AND expires_at > $5
       RETURNING *`,
      [input.flowHash, input.browserSessionHash, input.clientId, input.redirectUri, input.now],
    );
    return result.rows[0] ? mapOAuthBrokerFlow(result.rows[0]) : undefined;
  }

  async createBrokerAuthorizationFlow(
    input: CreateBrokerAuthorizationFlowInput,
  ): Promise<CreateBrokerAuthorizationFlowResult> {
    validateInitialBrokerFlow(input);
    const { installation, flow } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const insertedInstallation = await client.query(
        `INSERT INTO oauth_installations(
           installation_id, workspace_id, subject_type, subject_id, agent_id, oauth_client_id,
           installation_status, revoked_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',NULL,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          installation.installationId,
          installation.workspaceId,
          installation.subjectType,
          installation.subjectId,
          installation.agentId,
          installation.clientId,
          installation.createdAt,
          installation.updatedAt,
        ],
      );
      if (insertedInstallation.rowCount !== 1) {
        throw new AppError("CONFLICT", "OAuth Broker installation identifier already exists.", { httpStatus: 409 });
      }
      const insertedFlow = await client.query(
        `INSERT INTO oauth_broker_flows(
           flow_hash, browser_session_hash, oauth_client_id, redirect_uri,
           pkce_code_challenge, pkce_code_challenge_method,
           workspace_id, subject_type, subject_id, agent_id, requested_scopes,
           expires_at, consumed_at, created_at,
           flow_version, xero_state_hash, outer_state_hash, outer_state_ciphertext,
           resource, audience, oauth_installation_id, personal_poc, flow_status,
           authorization_id, selection_csrf_hash, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,'S256',$6,$7,$8,$9,$10,$11,NULL,$12,
           2,$13,$14,$15,$16,$17,$18,$19,'AUTHORIZING_XERO',NULL,NULL,$20
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          flow.flowHash,
          flow.browserSessionHash,
          flow.clientId,
          flow.redirectUri,
          flow.pkceCodeChallenge,
          flow.workspaceId,
          flow.subjectType,
          flow.subjectId,
          flow.agentId,
          flow.requestedScopes,
          flow.expiresAt,
          flow.createdAt,
          flow.xeroStateHash,
          flow.outerStateHash,
          flow.outerStateCiphertext,
          flow.resource,
          flow.audience,
          flow.installationId,
          flow.personalPoc,
          flow.updatedAt,
        ],
      );
      if (insertedFlow.rowCount !== 1) {
        throw new AppError("CONFLICT", "OAuth Broker flow identifier already exists.", { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return {
        installation: mapOAuthInstallation(insertedInstallation.rows[0] as Row),
        flow: mapOAuthBrokerAuthorizationFlow(insertedFlow.rows[0] as Row),
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginBrokerXeroCallback(
    input: BeginBrokerXeroCallbackInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const result = await this.pool.query(
      `UPDATE oauth_broker_flows SET
         flow_status = 'EXCHANGING_XERO', updated_at = $4
       WHERE flow_hash = $1
         AND flow_version = 2
         AND browser_session_hash = $2
         AND xero_state_hash = $3
         AND flow_status = 'AUTHORIZING_XERO'
         AND consumed_at IS NULL
         AND expires_at > $4
       RETURNING *`,
      [input.flowHash, input.browserSessionHash, input.xeroStateHash, input.now],
    );
    return result.rows[0] ? mapOAuthBrokerAuthorizationFlow(result.rows[0] as Row) : undefined;
  }

  async completeBrokerXeroExchange(
    input: CompleteBrokerXeroExchangeInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined> {
    if (!isValidDate(input.now)) {
      throw new AppError("VALIDATION_FAILED", "Xero authorization exchange time is invalid.");
    }
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selectedFlow = await client.query(
        `SELECT * FROM oauth_broker_flows
         WHERE flow_hash = $1 AND flow_version = 2
         FOR UPDATE`,
        [input.flowHash],
      );
      const row = selectedFlow.rows[0] as Row | undefined;
      if (
        !row ||
        row.flow_status !== "EXCHANGING_XERO" ||
        row.browser_session_hash !== input.browserSessionHash ||
        row.consumed_at ||
        date(row.expires_at) <= input.now ||
        row.workspace_id !== authorization.workspaceId ||
        row.subject_id !== authorization.authorizedBySubject
      ) {
        await client.query("COMMIT");
        return undefined;
      }

      const insertedAuthorization = await client.query(
        `INSERT INTO provider_authorizations(
           authorization_id, workspace_id, authorized_by_subject, provider, provider_subject,
           granted_scopes, token_ciphertext, token_expires_at, refresh_version,
           authorization_status, revoked_at, created_at, updated_at
         ) VALUES ($1,$2,$3,'xero',$4,$5,$6,$7,$8,'ACTIVE',NULL,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING authorization_id`,
        [
          authorization.authorizationId,
          authorization.workspaceId,
          authorization.authorizedBySubject,
          authorization.providerSubject ?? null,
          authorization.grantedScopes,
          authorization.tokenCiphertext,
          authorization.tokenExpiresAt,
          authorization.refreshVersion,
          authorization.createdAt,
          authorization.updatedAt,
        ],
      );
      if (insertedAuthorization.rowCount !== 1) {
        throw new AppError("CONFLICT", "Provider authorization identifier already exists.", { httpStatus: 409 });
      }

      for (const connection of connections) {
        const insertedConnection = await client.query(
          `INSERT INTO provider_connections(
             connection_id, authorization_id, provider, tenant_id, tenant_name, tenant_short_code,
             provider_connection_id, last_verified_at, granted_scopes, refresh_version,
             connection_status, created_at, updated_at
           ) VALUES ($1,$2,'xero',$3,$4,$5,$6,$7,'{}',0,'ACTIVE',$8,$9)
           ON CONFLICT DO NOTHING
           RETURNING connection_id`,
          [
            connection.connectionId,
            connection.authorizationId,
            connection.tenantId,
            connection.tenantName,
            connection.tenantShortCode ?? null,
            connection.providerConnectionId ?? null,
            connection.lastVerifiedAt ?? null,
            connection.createdAt,
            connection.updatedAt,
          ],
        );
        if (insertedConnection.rowCount !== 1) {
          throw new AppError("CONFLICT", "Provider connection identifier already exists.", { httpStatus: 409 });
        }
      }

      const updated = await client.query(
        `UPDATE oauth_broker_flows SET
           authorization_id = $2,
           selection_csrf_hash = $3,
           flow_status = 'AWAITING_SELECTION',
           updated_at = $4
         WHERE flow_hash = $1 AND flow_status = 'EXCHANGING_XERO'
         RETURNING *`,
        [input.flowHash, authorization.authorizationId, input.selectionCsrfHash, input.now],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "OAuth Broker flow changed during Xero exchange.", { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return mapOAuthBrokerAuthorizationFlow(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getBrokerSelection(input: GetBrokerSelectionInput): Promise<BrokerSelectionContext | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selectedFlow = await client.query(
        `SELECT flow.*
         FROM oauth_broker_flows flow
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = flow.authorization_id
         WHERE flow.flow_hash = $1
           AND flow.flow_version = 2
           AND flow.browser_session_hash = $2
           AND flow.flow_status = 'AWAITING_SELECTION'
           AND flow.consumed_at IS NULL
           AND flow.expires_at > $3
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = flow.workspace_id
         FOR SHARE OF flow, provider_auth`,
        [input.flowHash, input.browserSessionHash, input.now],
      );
      const row = selectedFlow.rows[0] as Row | undefined;
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const connections = await client.query(
        `SELECT * FROM provider_connections
         WHERE authorization_id = $1 AND connection_status = 'ACTIVE'
         ORDER BY created_at, connection_id`,
        [row.authorization_id],
      );
      await client.query("COMMIT");
      if (connections.rowCount === 0) return undefined;
      return {
        flow: mapOAuthBrokerAuthorizationFlow(row),
        connections: connections.rows.map((connection) => mapAuthorizedConnection(connection as Row)),
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBrokerOrganisationSelection(
    input: CompleteBrokerOrganisationSelectionInput,
  ): Promise<CompleteBrokerOrganisationSelectionResult | undefined> {
    if (
      !isNonEmpty(input.bindingId) ||
      !isNonEmpty(input.policyId) ||
      !isHashedValue(input.authorizationCodeHash) ||
      !isValidDate(input.now) ||
      !isValidDate(input.authorizationCodeExpiresAt) ||
      input.authorizationCodeExpiresAt <= input.now ||
      input.authorizationCodeExpiresAt.getTime() - input.now.getTime() > OAUTH_AUTHORIZATION_CODE_MAX_TTL_MS
    ) return undefined;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [PERSONAL_POC_SELECTION_ADVISORY_LOCK_KEY]);
      const selectedFlow = await client.query(
        `SELECT * FROM oauth_broker_flows
         WHERE flow_hash = $1 AND flow_version = 2
         FOR UPDATE`,
        [input.flowHash],
      );
      const row = selectedFlow.rows[0] as Row | undefined;
      if (
        !row ||
        row.flow_status !== "AWAITING_SELECTION" ||
        row.browser_session_hash !== input.browserSessionHash ||
        row.selection_csrf_hash !== input.selectionCsrfHash ||
        !row.authorization_id ||
        !row.outer_state_ciphertext ||
        row.consumed_at ||
        date(row.expires_at) <= input.now
      ) {
        await client.query("COMMIT");
        return undefined;
      }

      const installationResult = await client.query(
        `SELECT * FROM oauth_installations
         WHERE installation_id = $1
         FOR UPDATE`,
        [row.oauth_installation_id],
      );
      const installationRow = installationResult.rows[0] as Row | undefined;
      const connectionResult = await client.query(
        `SELECT connection.*
         FROM provider_connections connection
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE connection.connection_id = $1
           AND connection.authorization_id = $2
           AND connection.connection_status = 'ACTIVE'
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = $3
         FOR UPDATE OF connection, provider_auth`,
        [input.selectedConnectionId, row.authorization_id, row.workspace_id],
      );
      const connectionRow = connectionResult.rows[0] as Row | undefined;
      if (
        !installationRow ||
        installationRow.installation_status !== "PENDING" ||
        installationRow.workspace_id !== row.workspace_id ||
        installationRow.subject_type !== row.subject_type ||
        installationRow.subject_id !== row.subject_id ||
        installationRow.agent_id !== row.agent_id ||
        installationRow.oauth_client_id !== row.oauth_client_id ||
        !connectionRow
      ) {
        await client.query("COMMIT");
        return undefined;
      }
      if (row.personal_poc === true) {
        const otherActiveInstallations = await client.query(
          `SELECT installation_id, workspace_id, subject_type, subject_id, agent_id, oauth_client_id
           FROM oauth_installations
           WHERE installation_status = 'ACTIVE'
             AND installation_id <> $1
             AND workspace_id = $2
             AND subject_type = $3
             AND subject_id = $4
             AND agent_id = $5
             AND oauth_client_id = $6
           ORDER BY installation_id`,
          [
            row.oauth_installation_id,
            row.workspace_id,
            row.subject_type,
            row.subject_id,
            row.agent_id,
            row.oauth_client_id,
          ],
        );
        let replacedInstallation = false;
        for (const candidate of otherActiveInstallations.rows as Row[]) {
          const candidateInstallationId = String(candidate.installation_id);
          let familyIds = await client.query<{ family_id: string }>(
            `SELECT family_id
             FROM mcp_refresh_token_families
             WHERE oauth_installation_id = $1
             ORDER BY family_id`,
            [candidateInstallationId],
          );
          if (familyIds.rowCount === 0) {
            const exchangeableCodes = await client.query(
              `SELECT code_hash
               FROM oauth_authorization_codes
               WHERE oauth_installation_id = $1
                 AND consumed_at IS NULL
                 AND expires_at > $2
               ORDER BY code_hash
               FOR UPDATE`,
              [candidateInstallationId, input.now],
            );
            // Re-read after locking the code: an in-flight exchange may have
            // completed and created its family while this transaction waited.
            familyIds = await client.query<{ family_id: string }>(
              `SELECT family_id
               FROM mcp_refresh_token_families
               WHERE oauth_installation_id = $1
               ORDER BY family_id`,
              [candidateInstallationId],
            );
            if (familyIds.rowCount === 0 && (exchangeableCodes.rowCount ?? 0) > 0) {
              await client.query(replacedInstallation ? "ROLLBACK" : "COMMIT");
              return undefined;
            }
          }
          for (const family of familyIds.rows) {
            await this.#lockMcpRefreshFamily(client, family.family_id);
          }

          const lockedCandidate = await client.query(
            `SELECT installation_id, workspace_id, subject_type, subject_id, agent_id, oauth_client_id,
                    installation_status
             FROM oauth_installations
             WHERE installation_id = $1
             FOR UPDATE`,
            [candidateInstallationId],
          );
          const lockedRow = lockedCandidate.rows[0] as Row | undefined;
          if (!lockedRow || lockedRow.installation_status !== "ACTIVE") continue;
          if (
            lockedRow.workspace_id !== row.workspace_id ||
            lockedRow.subject_type !== row.subject_type ||
            lockedRow.subject_id !== row.subject_id ||
            lockedRow.agent_id !== row.agent_id ||
            lockedRow.oauth_client_id !== row.oauth_client_id
          ) {
            await client.query("ROLLBACK");
            return undefined;
          }
          await this.#revokeMcpInstallationGrant(client, candidateInstallationId, input.now);
          replacedInstallation = true;
        }
      }

      const activatedInstallation = await client.query(
        `UPDATE oauth_installations SET installation_status = 'ACTIVE', updated_at = $2
         WHERE installation_id = $1 AND installation_status = 'PENDING'
         RETURNING *`,
        [row.oauth_installation_id, input.now],
      );
      if (activatedInstallation.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const insertedBinding = await client.query(
        `INSERT INTO agent_connection_bindings(
           binding_id, oauth_installation_id, workspace_id, subject_type, subject_id, agent_id,
           connection_id, policy_id, binding_status, revoked_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',NULL,$9,$9)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.bindingId,
          row.oauth_installation_id,
          row.workspace_id,
          row.subject_type,
          row.subject_id,
          row.agent_id,
          input.selectedConnectionId,
          input.policyId,
          input.now,
        ],
      );
      if (insertedBinding.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const insertedActiveBinding = await client.query(
        `INSERT INTO oauth_installation_active_bindings(
           oauth_installation_id, binding_id, connection_id, binding_revision, changed_at
         ) VALUES ($1,$2,$3,1,$4)
         ON CONFLICT DO NOTHING`,
        [row.oauth_installation_id, input.bindingId, input.selectedConnectionId, input.now],
      );
      if (insertedActiveBinding.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const insertedCode = await client.query(
        `INSERT INTO oauth_authorization_codes(
           code_hash, flow_hash, oauth_installation_id, binding_id, connection_id,
           oauth_client_id, redirect_uri, pkce_code_challenge, pkce_code_challenge_method,
           resource, audience, granted_scopes, expires_at, consumed_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'S256',$9,$10,$11,$12,NULL,$13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.authorizationCodeHash,
          row.flow_hash,
          row.oauth_installation_id,
          input.bindingId,
          input.selectedConnectionId,
          row.oauth_client_id,
          row.redirect_uri,
          row.pkce_code_challenge,
          row.resource,
          row.audience,
          stringArray(row.requested_scopes),
          input.authorizationCodeExpiresAt,
          input.now,
        ],
      );
      if (insertedCode.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const outerStateCiphertext = String(row.outer_state_ciphertext);
      const completedFlow = await client.query(
        `UPDATE oauth_broker_flows SET
           flow_status = 'COMPLETED', consumed_at = $2, updated_at = $2,
           outer_state_ciphertext = NULL, selection_csrf_hash = NULL
         WHERE flow_hash = $1 AND flow_status = 'AWAITING_SELECTION'
         RETURNING *`,
        [input.flowHash, input.now],
      );
      if (completedFlow.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query("COMMIT");
      return {
        flow: mapOAuthBrokerAuthorizationFlow(completedFlow.rows[0] as Row),
        installation: mapOAuthInstallation(activatedInstallation.rows[0] as Row),
        binding: mapAgentConnectionBinding(insertedBinding.rows[0] as Row),
        authorizationCode: mapOAuthAuthorizationCode(insertedCode.rows[0] as Row),
        outerStateCiphertext,
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async terminateBrokerAuthorizationFlow(
    input: TerminateBrokerAuthorizationFlowInput,
  ): Promise<TerminateBrokerAuthorizationFlowResult | undefined> {
    if (!isValidDate(input.now) || !["DENIED", "FAILED"].includes(input.terminalStatus)) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT * FROM oauth_broker_flows
         WHERE flow_hash = $1
           AND flow_version = 2
           AND browser_session_hash = $2
           AND flow_status IN ('AUTHORIZING_XERO','EXCHANGING_XERO','AWAITING_SELECTION')
           AND consumed_at IS NULL
           AND outer_state_ciphertext IS NOT NULL
           AND expires_at > $3
         FOR UPDATE`,
        [input.flowHash, input.browserSessionHash, input.now],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const outerStateCiphertext = String(row.outer_state_ciphertext);
      await this.#revokePendingBrokerGrant(client, row, input.now);
      const updated = await client.query(
        `UPDATE oauth_broker_flows SET
           flow_status = $2, consumed_at = $3, updated_at = $3,
           outer_state_ciphertext = NULL, selection_csrf_hash = NULL
         WHERE flow_hash = $1
         RETURNING *`,
        [input.flowHash, input.terminalStatus, input.now],
      );
      await client.query("COMMIT");
      return {
        flow: mapOAuthBrokerAuthorizationFlow(updated.rows[0] as Row),
        outerStateCiphertext,
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveOAuthAuthorizationCode(code: OAuthAuthorizationCode): Promise<void> {
    if (code.pkceCodeChallengeMethod !== "S256" || code.expiresAt <= code.createdAt) {
      throw new AppError("VALIDATION_FAILED", "OAuth authorization code lifetime or PKCE method is invalid.");
    }
    const result = await this.pool.query(
      `INSERT INTO oauth_authorization_codes(
         code_hash, flow_hash, oauth_installation_id, binding_id, connection_id, oauth_client_id,
         redirect_uri, pkce_code_challenge, pkce_code_challenge_method,
         resource, audience, granted_scopes, expires_at, consumed_at, created_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,'S256',$9,$10,$11,$12,$13,$14
       FROM agent_connection_bindings binding
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       JOIN oauth_broker_flows flow ON flow.flow_hash = $2
       WHERE binding.binding_id = $4
         AND binding.oauth_installation_id = $3
         AND binding.connection_id = $5
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND installation.oauth_client_id = $6
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id
         AND flow.consumed_at IS NOT NULL
         AND flow.consumed_at <= $14
         AND flow.expires_at > $14
         AND flow.oauth_client_id = $6
         AND flow.redirect_uri = $7
         AND flow.pkce_code_challenge = $8
         AND flow.pkce_code_challenge_method = 'S256'
         AND flow.workspace_id = installation.workspace_id
         AND flow.subject_type = installation.subject_type
         AND flow.subject_id = installation.subject_id
         AND flow.agent_id = installation.agent_id
         AND $11::text[] <@ flow.requested_scopes`,
      [
        code.codeHash,
        code.flowHash,
        code.installationId,
        code.bindingId,
        code.connectionId,
        code.clientId,
        code.redirectUri,
        code.pkceCodeChallenge,
        code.resource,
        code.audience,
        code.grantedScopes,
        code.expiresAt,
        code.consumedAt ?? null,
        code.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AppError("FORBIDDEN", "OAuth authorization code is not bound to an active installation.", {
        httpStatus: 403,
      });
    }
  }

  async peekOAuthAuthorizationCodeForExchange(
    input: PeekOAuthAuthorizationCodeForExchangeInput,
  ): Promise<OAuthAuthorizationCodeExchangePreview | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const result = await this.pool.query(
      `SELECT code.*
       FROM oauth_authorization_codes code
       JOIN agent_connection_bindings binding
         ON binding.binding_id = code.binding_id
        AND binding.oauth_installation_id = code.oauth_installation_id
        AND binding.connection_id = code.connection_id
       JOIN oauth_installations installation
         ON installation.installation_id = code.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = code.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE code.code_hash = $1
         AND code.oauth_client_id = $2
         AND code.redirect_uri = $3
         AND code.pkce_code_challenge = $4
         AND code.pkce_code_challenge_method = 'S256'
         AND code.resource = $5
         AND code.consumed_at IS NULL
         AND code.expires_at > $6
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND installation.oauth_client_id = code.oauth_client_id
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id`,
      [
        input.codeHash,
        input.clientId,
        input.redirectUri,
        input.pkceCodeChallenge,
        input.expectedResource,
        input.now,
      ],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      codeHash: String(row.code_hash),
      installationId: String(row.oauth_installation_id),
      bindingId: String(row.binding_id),
      connectionId: String(row.connection_id),
      clientId: String(row.oauth_client_id),
      resource: String(row.resource),
      audience: String(row.audience),
      grantedScopes: stringArray(row.granted_scopes),
      expiresAt: date(row.expires_at),
    };
  }

  async consumeOAuthAuthorizationCode(
    input: ConsumeOAuthAuthorizationCodeInput,
  ): Promise<OAuthAuthorizationCode | undefined> {
    const result = await this.pool.query(
      `UPDATE oauth_authorization_codes code SET consumed_at = $5
       WHERE code.code_hash = $1
         AND code.oauth_client_id = $2
         AND code.redirect_uri = $3
         AND code.pkce_code_challenge = $4
         AND code.pkce_code_challenge_method = 'S256'
         AND code.consumed_at IS NULL
         AND code.expires_at > $5
         AND EXISTS (
           SELECT 1
           FROM agent_connection_bindings binding
           JOIN oauth_installations installation
             ON installation.installation_id = binding.oauth_installation_id
           JOIN provider_connections connection ON connection.connection_id = binding.connection_id
           JOIN provider_authorizations provider_auth
             ON provider_auth.authorization_id = connection.authorization_id
           WHERE binding.binding_id = code.binding_id
             AND binding.oauth_installation_id = code.oauth_installation_id
             AND binding.connection_id = code.connection_id
             AND binding.binding_status = 'ACTIVE'
             AND installation.installation_status = 'ACTIVE'
             AND connection.connection_status = 'ACTIVE'
             AND provider_auth.authorization_status = 'ACTIVE'
             AND provider_auth.workspace_id = binding.workspace_id
         )
       RETURNING code.*`,
      [input.codeHash, input.clientId, input.redirectUri, input.pkceCodeChallenge, input.now],
    );
    return result.rows[0] ? mapOAuthAuthorizationCode(result.rows[0]) : undefined;
  }

  async exchangeOAuthAuthorizationCodeForTokenSet(
    input: ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ): Promise<ExchangeOAuthAuthorizationCodeForTokenSetResult> {
    const { grant, accessToken } = input;
    const family = input.refreshTokenFamily.family;
    const refreshToken = input.refreshTokenFamily.initialToken;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT code.*,
                binding.binding_status, binding.workspace_id,
                installation.installation_status,
                installation.oauth_client_id AS installation_oauth_client_id,
                connection.connection_status,
                provider_auth.authorization_status,
                provider_auth.workspace_id AS authorization_workspace_id
         FROM oauth_authorization_codes code
         JOIN agent_connection_bindings binding
           ON binding.binding_id = code.binding_id
          AND binding.oauth_installation_id = code.oauth_installation_id
          AND binding.connection_id = code.connection_id
         JOIN oauth_installations installation
           ON installation.installation_id = code.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = code.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE code.code_hash = $1
           AND code.oauth_client_id = $2
           AND code.redirect_uri = $3
           AND code.pkce_code_challenge = $4
           AND code.pkce_code_challenge_method = 'S256'
           AND code.resource = $5
         FOR UPDATE OF code, binding, installation, connection, provider_auth`,
        [grant.codeHash, grant.clientId, grant.redirectUri, grant.pkceCodeChallenge, grant.expectedResource],
      );
      const row = selected.rows[0] as Row | undefined;
      const codeScopes = row ? stringArray(row.granted_scopes) : [];
      if (
        !row ||
        row.consumed_at ||
        date(row.expires_at) <= grant.now ||
        row.binding_status !== "ACTIVE" ||
        row.installation_status !== "ACTIVE" ||
        row.connection_status !== "ACTIVE" ||
        row.authorization_status !== "ACTIVE" ||
        row.installation_oauth_client_id !== row.oauth_client_id ||
        row.authorization_workspace_id !== row.workspace_id ||
        family.status !== "ACTIVE" ||
        family.revokedAt ||
        family.replayDetectedAt ||
        family.installationId !== String(row.oauth_installation_id) ||
        family.bindingId !== String(row.binding_id) ||
        family.connectionId !== String(row.connection_id) ||
        family.clientId !== String(row.oauth_client_id) ||
        family.resource !== String(row.resource) ||
        family.audience !== String(row.audience) ||
        !hasSameScopes(family.grantedScopes, codeScopes) ||
        refreshToken.familyId !== family.familyId ||
        refreshToken.parentTokenHash ||
        refreshToken.consumedAt ||
        refreshToken.revokedAt ||
        refreshToken.replacedByTokenHash ||
        refreshToken.issuedAt.getTime() !== grant.now.getTime() ||
        refreshToken.expiresAt <= refreshToken.issuedAt ||
        accessToken.installationId !== String(row.oauth_installation_id) ||
        accessToken.bindingId !== String(row.binding_id) ||
        accessToken.connectionId !== String(row.connection_id) ||
        accessToken.refreshFamilyId !== family.familyId ||
        accessToken.clientId !== String(row.oauth_client_id) ||
        accessToken.resource !== String(row.resource) ||
        accessToken.audience !== String(row.audience) ||
        !hasSameScopes(accessToken.grantedScopes, codeScopes) ||
        accessToken.issuedAt.getTime() !== grant.now.getTime() ||
        accessToken.expiresAt <= accessToken.issuedAt ||
        accessToken.revokedAt
      ) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }

      await client.query(
        `INSERT INTO mcp_refresh_token_families(
           family_id, oauth_installation_id, binding_id, connection_id, oauth_client_id,
           resource, audience, granted_scopes, family_status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10)`,
        [
          family.familyId,
          family.installationId,
          family.bindingId,
          family.connectionId,
          family.clientId,
          family.resource,
          family.audience,
          family.grantedScopes,
          family.createdAt,
          family.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO mcp_refresh_tokens(
           token_hash, token_id, family_id, issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          refreshToken.tokenHash,
          refreshToken.tokenId,
          refreshToken.familyId,
          refreshToken.issuedAt,
          refreshToken.expiresAt,
        ],
      );
      await client.query(
        `INSERT INTO mcp_access_tokens(
           token_hash, token_id, oauth_installation_id, binding_id, connection_id,
           refresh_family_id, oauth_client_id, resource, audience, granted_scopes,
           issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          accessToken.tokenHash,
          accessToken.tokenId,
          accessToken.installationId,
          accessToken.bindingId,
          accessToken.connectionId,
          accessToken.refreshFamilyId,
          accessToken.clientId,
          accessToken.resource,
          accessToken.audience,
          accessToken.grantedScopes,
          accessToken.issuedAt,
          accessToken.expiresAt,
        ],
      );
      const consumed = await client.query(
        `UPDATE oauth_authorization_codes SET consumed_at = $2
         WHERE code_hash = $1 AND consumed_at IS NULL
         RETURNING *`,
        [grant.codeHash, grant.now],
      );
      if (consumed.rowCount !== 1) {
        throw new AppError("CONFLICT", "OAuth authorization code was consumed concurrently.", { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return {
        status: "ISSUED",
        authorizationCode: mapOAuthAuthorizationCode(consumed.rows[0] as Row),
        accessToken: structuredClone(accessToken),
        refreshToken: structuredClone(refreshToken),
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveMcpAccessToken(token: McpAccessToken): Promise<void> {
    if (token.expiresAt <= token.issuedAt) {
      throw new AppError("VALIDATION_FAILED", "MCP access token expiry must be after issuance.");
    }
    const result = await this.pool.query(
      `INSERT INTO mcp_access_tokens(
         token_hash, token_id, oauth_installation_id, binding_id, connection_id,
         refresh_family_id, oauth_client_id, resource, audience, granted_scopes,
         issued_at, expires_at, revoked_at
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
       FROM agent_connection_bindings binding
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE binding.binding_id = $4
         AND binding.oauth_installation_id = $3
         AND binding.connection_id = $5
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND installation.oauth_client_id = $7
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id
         AND (
           $6::text IS NULL OR EXISTS (
             SELECT 1 FROM mcp_refresh_token_families family
             WHERE family.family_id = $6
               AND family.oauth_installation_id = $3
               AND family.binding_id = $4
               AND family.connection_id = $5
               AND family.oauth_client_id = $7
               AND family.resource = $8
               AND family.audience = $9
               AND $10::text[] <@ family.granted_scopes
               AND family.family_status = 'ACTIVE'
           )
         )`,
      [
        token.tokenHash,
        token.tokenId,
        token.installationId,
        token.bindingId,
        token.connectionId,
        token.refreshFamilyId ?? null,
        token.clientId,
        token.resource,
        token.audience,
        token.grantedScopes,
        token.issuedAt,
        token.expiresAt,
        token.revokedAt ?? null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AppError("FORBIDDEN", "MCP access token is not bound to an active installation.", {
        httpStatus: 403,
      });
    }
  }

  async resolveMcpAccessToken(input: ResolveMcpAccessTokenInput): Promise<ResolvedMcpAccessToken | undefined> {
    const result = await this.pool.query(
      `SELECT access_token.token_id, access_token.oauth_client_id, access_token.resource,
              access_token.audience, access_token.granted_scopes AS access_granted_scopes,
              access_token.issued_at, access_token.expires_at,
              binding.oauth_installation_id, binding.binding_id, binding.workspace_id,
              binding.subject_type, binding.subject_id, binding.agent_id, binding.connection_id,
              binding.policy_id, active.binding_revision, connection.authorization_id, connection.tenant_id
       FROM mcp_access_tokens access_token
       JOIN agent_connection_bindings source_binding
         ON source_binding.binding_id = access_token.binding_id
        AND source_binding.oauth_installation_id = access_token.oauth_installation_id
        AND source_binding.connection_id = access_token.connection_id
       JOIN oauth_installation_active_bindings active
         ON active.oauth_installation_id = access_token.oauth_installation_id
       JOIN agent_connection_bindings binding
         ON binding.binding_id = active.binding_id
        AND binding.oauth_installation_id = access_token.oauth_installation_id
        AND binding.connection_id = active.connection_id
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = binding.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE access_token.token_hash = $1
         AND access_token.resource = $2
         AND access_token.audience = $3
         AND access_token.revoked_at IS NULL
         AND access_token.expires_at > $4
         AND source_binding.binding_status = 'ACTIVE'
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id
         AND (
           access_token.refresh_family_id IS NULL OR EXISTS (
             SELECT 1 FROM mcp_refresh_token_families family
             WHERE family.family_id = access_token.refresh_family_id
               AND family.family_status = 'ACTIVE'
           )
         )`,
      [input.tokenHash, input.expectedResource, input.expectedAudience, input.now],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      tokenId: String(row.token_id),
      clientId: String(row.oauth_client_id),
      resource: String(row.resource),
      audience: String(row.audience),
      grantedScopes: stringArray(row.access_granted_scopes),
      issuedAt: date(row.issued_at),
      expiresAt: date(row.expires_at),
      installationId: String(row.oauth_installation_id),
      bindingId: String(row.binding_id),
      connectionId: String(row.connection_id),
      bindingRevision: positiveSafeInteger(row.binding_revision, "active binding revision"),
      authorizationId: String(row.authorization_id),
      workspaceId: String(row.workspace_id),
      subjectType: row.subject_type as ResolvedMcpAccessToken["subjectType"],
      subjectId: String(row.subject_id),
      agentId: String(row.agent_id),
      policyId: String(row.policy_id),
      tenantId: String(row.tenant_id),
    };
  }

  async revokeMcpAccessToken(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_hash = $1
       RETURNING token_hash`,
      [tokenHash, revokedAt],
    );
    return result.rowCount === 1;
  }

  async createMcpRefreshTokenFamily(input: CreateMcpRefreshTokenFamilyInput): Promise<void> {
    const { family, initialToken } = input;
    if (
      family.status !== "ACTIVE" ||
      family.revokedAt ||
      family.replayDetectedAt ||
      initialToken.familyId !== family.familyId ||
      initialToken.parentTokenHash ||
      initialToken.consumedAt ||
      initialToken.revokedAt ||
      initialToken.replacedByTokenHash ||
      initialToken.expiresAt <= initialToken.issuedAt
    ) {
      throw new AppError("VALIDATION_FAILED", "MCP refresh token family input is invalid.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const insertedFamily = await client.query(
        `INSERT INTO mcp_refresh_token_families(
           family_id, oauth_installation_id, binding_id, connection_id, oauth_client_id,
           resource, audience, granted_scopes, family_status, replay_detected_at,
           revoked_at, created_at, updated_at
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',NULL,NULL,$9,$10
         FROM agent_connection_bindings binding
         JOIN oauth_installations installation
           ON installation.installation_id = binding.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = binding.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE binding.binding_id = $3
           AND binding.oauth_installation_id = $2
           AND binding.connection_id = $4
           AND binding.binding_status = 'ACTIVE'
           AND installation.installation_status = 'ACTIVE'
           AND installation.oauth_client_id = $5
           AND connection.connection_status = 'ACTIVE'
           AND provider_auth.authorization_status = 'ACTIVE'
           AND provider_auth.workspace_id = binding.workspace_id
         RETURNING family_id`,
        [
          family.familyId,
          family.installationId,
          family.bindingId,
          family.connectionId,
          family.clientId,
          family.resource,
          family.audience,
          family.grantedScopes,
          family.createdAt,
          family.updatedAt,
        ],
      );
      if (insertedFamily.rowCount !== 1) {
        throw new AppError("FORBIDDEN", "MCP refresh token family is not bound to an active installation.", {
          httpStatus: 403,
        });
      }
      await client.query(
        `INSERT INTO mcp_refresh_tokens(
           token_hash, token_id, family_id, parent_token_hash, issued_at, expires_at,
           consumed_at, revoked_at, replaced_by_token_hash
         ) VALUES ($1,$2,$3,NULL,$4,$5,NULL,NULL,NULL)`,
        [
          initialToken.tokenHash,
          initialToken.tokenId,
          initialToken.familyId,
          initialToken.issuedAt,
          initialToken.expiresAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "OAuth installation already has an active MCP refresh-token family.", {
          httpStatus: 409,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async peekMcpRefreshTokenContext(
    input: PeekMcpRefreshTokenContextInput,
  ): Promise<McpRefreshTokenContextPreview | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const result = await this.pool.query(
      `SELECT refresh_token.family_id, refresh_token.consumed_at, refresh_token.expires_at,
              family.oauth_installation_id, family.binding_id, family.connection_id,
              family.oauth_client_id, family.resource, family.audience, family.granted_scopes
       FROM mcp_refresh_tokens refresh_token
       JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
       JOIN agent_connection_bindings binding
         ON binding.binding_id = family.binding_id
        AND binding.oauth_installation_id = family.oauth_installation_id
        AND binding.connection_id = family.connection_id
       JOIN oauth_installations installation
         ON installation.installation_id = family.oauth_installation_id
       JOIN provider_connections connection ON connection.connection_id = family.connection_id
       JOIN provider_authorizations provider_auth
         ON provider_auth.authorization_id = connection.authorization_id
       WHERE refresh_token.token_hash = $1
         AND family.oauth_client_id = $2
         AND family.resource = $3
         AND family.audience = $4
         AND refresh_token.revoked_at IS NULL
         AND family.family_status = 'ACTIVE'
         AND binding.binding_status = 'ACTIVE'
         AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE'
         AND provider_auth.authorization_status = 'ACTIVE'
         AND provider_auth.workspace_id = binding.workspace_id`,
      [
        input.tokenHash,
        input.clientId,
        input.expectedResource,
        input.expectedAudience,
      ],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      familyId: String(row.family_id),
      installationId: String(row.oauth_installation_id),
      bindingId: String(row.binding_id),
      connectionId: String(row.connection_id),
      clientId: String(row.oauth_client_id),
      resource: String(row.resource),
      audience: String(row.audience),
      grantedScopes: stringArray(row.granted_scopes),
      consumed: Boolean(row.consumed_at),
      expiresAt: date(row.expires_at),
    };
  }

  async rotateMcpRefreshToken(input: RotateMcpRefreshTokenInput): Promise<RotateMcpRefreshTokenResult> {
    if (input.expiresAt <= input.issuedAt) return { status: "INVALID" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const familyLookup = await client.query<{ family_id: string }>(
        `SELECT family.family_id
         FROM mcp_refresh_tokens refresh_token
         JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
         WHERE refresh_token.token_hash = $1
           AND family.oauth_client_id = $2
           AND family.resource = $3
           AND family.audience = $4`,
        [input.currentTokenHash, input.expectedClientId, input.expectedResource, input.expectedAudience],
      );
      const lookedUpFamilyId = familyLookup.rows[0]?.family_id;
      if (!lookedUpFamilyId) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      await this.#lockMcpRefreshFamily(client, lookedUpFamilyId);
      const selected = await client.query(
        `SELECT refresh_token.*, family.oauth_installation_id, family.binding_id,
                family.connection_id, family.oauth_client_id, family.resource, family.audience,
                family.granted_scopes, family.family_status,
                binding.binding_status, installation.installation_status,
                connection.connection_status, provider_auth.authorization_status
         FROM mcp_refresh_tokens refresh_token
         JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
         JOIN agent_connection_bindings binding
           ON binding.binding_id = family.binding_id
          AND binding.oauth_installation_id = family.oauth_installation_id
          AND binding.connection_id = family.connection_id
         JOIN oauth_installations installation
           ON installation.installation_id = family.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = family.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE refresh_token.token_hash = $1
           AND family.oauth_client_id = $2
           AND family.resource = $3
           AND family.audience = $4
           AND provider_auth.workspace_id = binding.workspace_id
         FOR UPDATE OF refresh_token, family`,
        [
          input.currentTokenHash,
          input.expectedClientId,
          input.expectedResource,
          input.expectedAudience,
        ],
      );
      const row = selected.rows[0] as Row | undefined;
      if (
        !row ||
        row.family_status !== "ACTIVE" ||
        row.binding_status !== "ACTIVE" ||
        row.installation_status !== "ACTIVE" ||
        row.connection_status !== "ACTIVE" ||
        row.authorization_status !== "ACTIVE"
      ) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const familyId = String(row.family_id);
      if (row.consumed_at) {
        await this.#revokeMcpRefreshGrant(
          client,
          familyId,
          String(row.oauth_installation_id),
          String(row.binding_id),
          String(row.connection_id),
          input.issuedAt,
          input.issuedAt,
        );
        await client.query("COMMIT");
        return { status: "REPLAY_DETECTED", familyId };
      }
      if (date(row.expires_at) <= input.issuedAt) {
        await this.#revokeMcpRefreshGrant(
          client,
          familyId,
          String(row.oauth_installation_id),
          String(row.binding_id),
          String(row.connection_id),
          input.issuedAt,
        );
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const familyScopes = stringArray(row.granted_scopes);
      const grantedScopes = [...(input.requestedScopes ?? familyScopes)];
      if (
        row.revoked_at ||
        !isScopeSubset(grantedScopes, familyScopes)
      ) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const inserted = await client.query(
        `INSERT INTO mcp_refresh_tokens(
           token_hash, token_id, family_id, parent_token_hash, issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [input.newTokenHash, input.newTokenId, familyId, input.currentTokenHash, input.issuedAt, input.expiresAt],
      );
      await client.query(
        `UPDATE mcp_refresh_tokens SET consumed_at = $2, replaced_by_token_hash = $3
         WHERE token_hash = $1`,
        [input.currentTokenHash, input.issuedAt, input.newTokenHash],
      );
      await client.query(
        "UPDATE mcp_refresh_token_families SET updated_at = $2 WHERE family_id = $1",
        [familyId, input.issuedAt],
      );
      await client.query("COMMIT");
      return {
        status: "ROTATED",
        familyId,
        refreshToken: mapMcpRefreshToken(inserted.rows[0] as Row),
        installationId: String(row.oauth_installation_id),
        bindingId: String(row.binding_id),
        connectionId: String(row.connection_id),
        grantedScopes,
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateMcpRefreshTokenAndIssueAccessToken(
    input: RotateMcpRefreshTokenAndIssueAccessTokenInput,
  ): Promise<RotateMcpRefreshTokenAndIssueAccessTokenResult> {
    const { rotation, accessToken } = input;
    if (rotation.expiresAt <= rotation.issuedAt) return { status: "INVALID" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const familyLookup = await client.query<{ family_id: string }>(
        `SELECT family.family_id
         FROM mcp_refresh_tokens refresh_token
         JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
         WHERE refresh_token.token_hash = $1
           AND family.oauth_client_id = $2
           AND family.resource = $3
           AND family.audience = $4`,
        [
          rotation.currentTokenHash,
          rotation.expectedClientId,
          rotation.expectedResource,
          rotation.expectedAudience,
        ],
      );
      const lookedUpFamilyId = familyLookup.rows[0]?.family_id;
      if (!lookedUpFamilyId) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      await this.#lockMcpRefreshFamily(client, lookedUpFamilyId);
      const selected = await client.query(
        `SELECT refresh_token.*, family.oauth_installation_id, family.binding_id,
                family.connection_id, family.oauth_client_id, family.resource, family.audience,
                family.granted_scopes, family.family_status,
                binding.binding_status, binding.workspace_id,
                installation.installation_status,
                connection.connection_status,
                provider_auth.authorization_status,
                provider_auth.workspace_id AS authorization_workspace_id
         FROM mcp_refresh_tokens refresh_token
         JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
         JOIN agent_connection_bindings binding
           ON binding.binding_id = family.binding_id
          AND binding.oauth_installation_id = family.oauth_installation_id
          AND binding.connection_id = family.connection_id
         JOIN oauth_installations installation
           ON installation.installation_id = family.oauth_installation_id
         JOIN provider_connections connection ON connection.connection_id = family.connection_id
         JOIN provider_authorizations provider_auth
           ON provider_auth.authorization_id = connection.authorization_id
         WHERE refresh_token.token_hash = $1
           AND family.oauth_client_id = $2
           AND family.resource = $3
           AND family.audience = $4
         FOR UPDATE OF refresh_token, family, binding, installation, connection, provider_auth`,
        [
          rotation.currentTokenHash,
          rotation.expectedClientId,
          rotation.expectedResource,
          rotation.expectedAudience,
        ],
      );
      const row = selected.rows[0] as Row | undefined;
      if (
        !row ||
        row.family_status !== "ACTIVE" ||
        row.binding_status !== "ACTIVE" ||
        row.installation_status !== "ACTIVE" ||
        row.connection_status !== "ACTIVE" ||
        row.authorization_status !== "ACTIVE" ||
        row.authorization_workspace_id !== row.workspace_id
      ) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const familyId = String(row.family_id);
      const familyScopes = stringArray(row.granted_scopes);
      const expectedScopes = [...(rotation.requestedScopes ?? familyScopes)];
      if (
        row.parent_token_hash &&
        !row.consumed_at &&
        !row.replaced_by_token_hash &&
        !row.revoked_at &&
        date(row.expires_at) > rotation.issuedAt
      ) {
        const parentRetry = await client.query<{
          source_token_hash: string;
          access_token_hash: string;
          refresh_token_hash: string;
          response_ciphertext: string;
          granted_scopes: string[];
        }>(
          `SELECT parent.token_hash AS source_token_hash,
                  access_token.token_hash AS access_token_hash,
                  refresh_token.token_hash AS refresh_token_hash,
                  parent.retry_response_ciphertext AS response_ciphertext,
                  access_token.granted_scopes
           FROM mcp_refresh_tokens parent
           JOIN mcp_refresh_tokens refresh_token
             ON refresh_token.token_hash = $1
            AND refresh_token.family_id = parent.family_id
            AND refresh_token.parent_token_hash = parent.token_hash
            AND refresh_token.consumed_at IS NULL
            AND refresh_token.replaced_by_token_hash IS NULL
            AND refresh_token.revoked_at IS NULL
            AND refresh_token.expires_at > $10
           JOIN mcp_access_tokens access_token
             ON access_token.token_hash = parent.retry_access_token_hash
            AND access_token.refresh_family_id = parent.family_id
            AND access_token.oauth_installation_id = $4
            AND access_token.binding_id = $5
            AND access_token.connection_id = $6
            AND access_token.oauth_client_id = $7
            AND access_token.resource = $8
            AND access_token.audience = $9
            AND access_token.revoked_at IS NULL
            AND access_token.expires_at > $10
           WHERE parent.token_hash = $2
             AND parent.family_id = $3
             AND parent.replaced_by_token_hash = $1
             AND parent.consumed_at IS NOT NULL
             AND parent.consumed_at + ($11::bigint * interval '1 millisecond') > $10
             AND parent.retry_response_ciphertext IS NOT NULL
             AND parent.retry_expires_at > $10`,
          [
            rotation.currentTokenHash,
            row.parent_token_hash,
            familyId,
            row.oauth_installation_id,
            row.binding_id,
            row.connection_id,
            row.oauth_client_id,
            row.resource,
            row.audience,
            rotation.issuedAt,
            MCP_OAUTH_REFRESH_RETRY_GRACE_MS,
          ],
        );
        const parentRetryRow = parentRetry.rows[0];
        if (
          parentRetryRow &&
          hasSameScopes(stringArray(parentRetryRow.granted_scopes), expectedScopes)
        ) {
          await client.query("COMMIT");
          return {
            status: "COALESCED",
            sourceTokenHash: parentRetryRow.source_token_hash,
            accessTokenHash: parentRetryRow.access_token_hash,
            refreshTokenHash: parentRetryRow.refresh_token_hash,
            responseCiphertext: parentRetryRow.response_ciphertext,
            grantedScopes: stringArray(parentRetryRow.granted_scopes),
          };
        }
        if (
          date(row.issued_at).getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
          rotation.issuedAt.getTime()
        ) {
          await client.query("COMMIT");
          return { status: "INVALID" };
        }
      }
      if (row.consumed_at) {
        if (
          row.replaced_by_token_hash &&
          row.retry_access_token_hash &&
          row.retry_response_ciphertext &&
          row.retry_expires_at &&
          date(row.retry_expires_at) > rotation.issuedAt &&
          date(row.consumed_at).getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
            rotation.issuedAt.getTime()
        ) {
          const retry = await client.query<{
            refresh_token_hash: string;
            access_token_hash: string;
            granted_scopes: string[];
          }>(
            `SELECT successor.token_hash AS refresh_token_hash,
                    access_token.token_hash AS access_token_hash,
                    access_token.granted_scopes
             FROM mcp_refresh_tokens successor
             JOIN mcp_access_tokens access_token
               ON access_token.token_hash = $2
              AND access_token.refresh_family_id = $3
              AND access_token.oauth_installation_id = $4
              AND access_token.binding_id = $5
              AND access_token.connection_id = $6
              AND access_token.oauth_client_id = $7
              AND access_token.resource = $8
              AND access_token.audience = $9
             WHERE successor.token_hash = $1
               AND successor.family_id = $3
               AND successor.consumed_at IS NULL
               AND successor.replaced_by_token_hash IS NULL
               AND successor.revoked_at IS NULL
               AND successor.expires_at > $10
               AND access_token.revoked_at IS NULL
               AND access_token.expires_at > $10`,
            [
              row.replaced_by_token_hash,
              row.retry_access_token_hash,
              familyId,
              row.oauth_installation_id,
              row.binding_id,
              row.connection_id,
              row.oauth_client_id,
              row.resource,
              row.audience,
              rotation.issuedAt,
            ],
          );
          const retryRow = retry.rows[0];
          if (retryRow && hasSameScopes(stringArray(retryRow.granted_scopes), expectedScopes)) {
            await client.query("COMMIT");
            return {
              status: "COALESCED",
              sourceTokenHash: rotation.currentTokenHash,
              accessTokenHash: retryRow.access_token_hash,
              refreshTokenHash: retryRow.refresh_token_hash,
              responseCiphertext: String(row.retry_response_ciphertext),
              grantedScopes: stringArray(retryRow.granted_scopes),
            };
          }
        }
        if (
          date(row.consumed_at).getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS >
          rotation.issuedAt.getTime()
        ) {
          await client.query("COMMIT");
          return { status: "INVALID" };
        }
        await client.query(
          `UPDATE mcp_refresh_tokens
           SET retry_access_token_hash = NULL,
               retry_response_ciphertext = NULL,
               retry_expires_at = NULL
           WHERE token_hash = $1`,
          [rotation.currentTokenHash],
        );
        await this.#revokeMcpRefreshGrant(
          client,
          familyId,
          String(row.oauth_installation_id),
          String(row.binding_id),
          String(row.connection_id),
          rotation.issuedAt,
          rotation.issuedAt,
        );
        await client.query("COMMIT");
        return { status: "REPLAY_DETECTED", familyId };
      }
      if (date(row.expires_at) <= rotation.issuedAt) {
        await this.#revokeMcpRefreshGrant(
          client,
          familyId,
          String(row.oauth_installation_id),
          String(row.binding_id),
          String(row.connection_id),
          rotation.issuedAt,
        );
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const grantedScopes = expectedScopes;
      if (
        row.revoked_at ||
        !isNonEmpty(input.retryResponseCiphertext) ||
        !isValidDate(input.retryExpiresAt) ||
        input.retryExpiresAt <= rotation.issuedAt ||
        input.retryExpiresAt.getTime() >
          rotation.issuedAt.getTime() + MCP_OAUTH_REFRESH_RETRY_GRACE_MS ||
        accessToken.installationId !== String(row.oauth_installation_id) ||
        accessToken.bindingId !== String(row.binding_id) ||
        accessToken.connectionId !== String(row.connection_id) ||
        accessToken.refreshFamilyId !== familyId ||
        accessToken.clientId !== String(row.oauth_client_id) ||
        accessToken.resource !== String(row.resource) ||
        accessToken.audience !== String(row.audience) ||
        !isScopeSubset(grantedScopes, familyScopes) ||
        !hasSameScopes(accessToken.grantedScopes, grantedScopes) ||
        accessToken.issuedAt.getTime() !== rotation.issuedAt.getTime() ||
        accessToken.expiresAt <= accessToken.issuedAt ||
        accessToken.revokedAt
      ) {
        await client.query("COMMIT");
        return { status: "INVALID" };
      }
      const insertedRefresh = await client.query(
        `INSERT INTO mcp_refresh_tokens(
           token_hash, token_id, family_id, parent_token_hash, issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          rotation.newTokenHash,
          rotation.newTokenId,
          familyId,
          rotation.currentTokenHash,
          rotation.issuedAt,
          rotation.expiresAt,
        ],
      );
      await client.query(
        `UPDATE mcp_refresh_tokens
         SET consumed_at = $2,
             replaced_by_token_hash = $3,
             retry_access_token_hash = $4,
             retry_response_ciphertext = $5,
             retry_expires_at = $6
         WHERE token_hash = $1`,
        [
          rotation.currentTokenHash,
          rotation.issuedAt,
          rotation.newTokenHash,
          accessToken.tokenHash,
          input.retryResponseCiphertext,
          input.retryExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO mcp_access_tokens(
           token_hash, token_id, oauth_installation_id, binding_id, connection_id,
           refresh_family_id, oauth_client_id, resource, audience, granted_scopes,
           issued_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          accessToken.tokenHash,
          accessToken.tokenId,
          accessToken.installationId,
          accessToken.bindingId,
          accessToken.connectionId,
          accessToken.refreshFamilyId,
          accessToken.clientId,
          accessToken.resource,
          accessToken.audience,
          accessToken.grantedScopes,
          accessToken.issuedAt,
          accessToken.expiresAt,
        ],
      );
      await client.query(
        "UPDATE mcp_refresh_token_families SET updated_at = $2 WHERE family_id = $1",
        [familyId, rotation.issuedAt],
      );
      await client.query("COMMIT");
      return {
        status: "ROTATED",
        familyId,
        refreshToken: mapMcpRefreshToken(insertedRefresh.rows[0] as Row),
        accessToken: structuredClone(accessToken),
        installationId: String(row.oauth_installation_id),
        bindingId: String(row.binding_id),
        connectionId: String(row.connection_id),
        grantedScopes,
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeMcpRefreshTokenFamilyByTokenHash(tokenHash: string, revokedAt: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lookup = await client.query<{ family_id: string }>(
        `SELECT family_id FROM mcp_refresh_tokens
         WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = lookup.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return false;
      }
      await this.#lockMcpRefreshFamily(client, row.family_id);
      const selected = await client.query(
        `SELECT token_hash FROM mcp_refresh_tokens
         WHERE token_hash = $1 AND family_id = $2
         FOR UPDATE`,
        [tokenHash, row.family_id],
      );
      if (selected.rowCount !== 1) {
        await client.query("COMMIT");
        return false;
      }
      await this.#revokeMcpRefreshFamily(client, row.family_id, revokedAt);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeOAuthTokenForClient(
    input: RevokeOAuthTokenForClientInput,
  ): Promise<RevokeOAuthTokenForClientResult> {
    if (!isValidDate(input.revokedAt)) return { status: "ACCEPTED" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const refresh = await client.query(
        `SELECT family.family_id, family.oauth_installation_id, family.binding_id, family.connection_id
         FROM mcp_refresh_tokens refresh_token
         JOIN mcp_refresh_token_families family ON family.family_id = refresh_token.family_id
         WHERE refresh_token.token_hash = $1 AND family.oauth_client_id = $2`,
        [input.tokenHash, input.clientId],
      );
      const refreshRow = refresh.rows[0] as Row | undefined;
      if (refreshRow) {
        const familyId = String(refreshRow.family_id);
        const installationId = String(refreshRow.oauth_installation_id);
        const bindingId = String(refreshRow.binding_id);
        const connectionId = String(refreshRow.connection_id);

        // Every mutation of an existing family acquires this lock before row locks.
        await this.#lockMcpRefreshFamily(client, familyId);
        await client.query(
          `SELECT installation_id FROM oauth_installations
           WHERE installation_id = $1
           FOR UPDATE`,
          [installationId],
        );
        await client.query(
          `SELECT binding_id FROM agent_connection_bindings
           WHERE binding_id = $1 AND oauth_installation_id = $2 AND connection_id = $3
           FOR UPDATE`,
          [bindingId, installationId, connectionId],
        );
        const lockedToken = await client.query(
          `SELECT token_hash FROM mcp_refresh_tokens
           WHERE token_hash = $1 AND family_id = $2
           FOR UPDATE`,
          [input.tokenHash, familyId],
        );
        const lockedFamily = await client.query(
          `SELECT family_id FROM mcp_refresh_token_families
           WHERE family_id = $1
             AND oauth_client_id = $2
             AND oauth_installation_id = $3
             AND binding_id = $4
             AND connection_id = $5
           FOR UPDATE`,
          [familyId, input.clientId, installationId, bindingId, connectionId],
        );
        if (lockedToken.rowCount === 1 && lockedFamily.rowCount === 1) {
          await this.#revokeMcpRefreshGrant(
            client,
            familyId,
            installationId,
            bindingId,
            connectionId,
            input.revokedAt,
          );
        }
      }
      await client.query(
        `UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, $3)
         WHERE token_hash = $1 AND oauth_client_id = $2`,
        [input.tokenHash, input.clientId, input.revokedAt],
      );
      await client.query("COMMIT");
      return { status: "ACCEPTED" };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveOAuthState(
    stateHash: string,
    browserSessionHash: string,
    actorId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_states(state_hash, browser_session_hash, actor_id, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (state_hash) DO NOTHING`,
      [stateHash, browserSessionHash, actorId, expiresAt],
    );
  }

  async consumeOAuthState(
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<{ actorId: string } | undefined> {
    const result = await this.pool.query<{ actor_id: string }>(
      `UPDATE oauth_states
       SET consumed_at = $3
       WHERE state_hash = $1 AND browser_session_hash = $2 AND consumed_at IS NULL AND expires_at > $3
       RETURNING actor_id`,
      [stateHash, browserSessionHash, now],
    );
    const row = result.rows[0];
    return row ? { actorId: row.actor_id } : undefined;
  }

  async saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO connect_tickets(ticket_hash, actor_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (ticket_hash) DO NOTHING`,
      [ticketHash, actorId, expiresAt],
    );
  }

  async consumeConnectTicket(ticketHash: string, now: Date): Promise<{ actorId: string } | undefined> {
    const result = await this.pool.query<{ actor_id: string }>(
      `UPDATE connect_tickets SET consumed_at = $2
       WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING actor_id`,
      [ticketHash, now],
    );
    const row = result.rows[0];
    return row ? { actorId: row.actor_id } : undefined;
  }

  async saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator_sessions(session_hash, actor_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_hash) DO NOTHING`,
      [sessionHash, actorId, expiresAt],
    );
  }

  async getOperatorSession(sessionHash: string, now: Date): Promise<{ actorId: string } | undefined> {
    const result = await this.pool.query<{ actor_id: string }>(
      "SELECT actor_id FROM operator_sessions WHERE session_hash = $1 AND expires_at > $2",
      [sessionHash, now],
    );
    const row = result.rows[0];
    return row ? { actorId: row.actor_id } : undefined;
  }

  async revokeOperatorSessions(actorId: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM operator_sessions WHERE actor_id = $1", [actorId]);
    return result.rowCount ?? 0;
  }

  async saveReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO review_csrf_tokens(
         csrf_hash, session_hash, actor_id, posting_request_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [csrfHash, sessionHash, actorId, postingRequestId, expiresAt],
    );
  }

  async consumeReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE review_csrf_tokens SET consumed_at = $5
       WHERE csrf_hash = $1 AND session_hash = $2 AND actor_id = $3
         AND posting_request_id = $4 AND consumed_at IS NULL AND expires_at > $5
       RETURNING csrf_hash`,
      [csrfHash, sessionHash, actorId, postingRequestId, now],
    );
    return result.rowCount === 1;
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '250ms'");
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
        [EPHEMERAL_CLEANUP_ADVISORY_LOCK_KEY],
      );
      if (lock.rows[0]?.locked !== true) {
        await client.query("COMMIT");
        return { lockAcquired: false, deleted: emptyEphemeralCleanupCounts() };
      }

      const mcpRefreshRetryResponses = await client.query(
        `WITH targets AS (
           SELECT refresh_token.token_hash
           FROM mcp_refresh_tokens refresh_token
           WHERE refresh_token.retry_response_ciphertext IS NOT NULL
             AND refresh_token.retry_expires_at <= $1
           ORDER BY refresh_token.retry_expires_at, refresh_token.token_hash
           LIMIT $2
           FOR UPDATE OF refresh_token SKIP LOCKED
         )
         UPDATE mcp_refresh_tokens refresh_token
         SET retry_access_token_hash = NULL,
             retry_response_ciphertext = NULL,
             retry_expires_at = NULL
         FROM targets
         WHERE refresh_token.token_hash = targets.token_hash`,
        [brokerFlowCutoff, batchSize],
      );

      const organisationSwitchSessions = await client.query(
        `WITH targets AS (
           SELECT switch.session_hash
           FROM organisation_switch_sessions switch
           WHERE switch.expires_at <= $1 OR switch.consumed_at IS NOT NULL
           ORDER BY switch.expires_at, switch.session_hash
           LIMIT $2
           FOR UPDATE OF switch SKIP LOCKED
         )
         DELETE FROM organisation_switch_sessions switch
         USING targets
         WHERE switch.session_hash = targets.session_hash`,
        [brokerFlowCutoff, batchSize],
      );

      const ledgerTargetSessions = await client.query(
        `WITH targets AS (
           SELECT target.session_hash
           FROM ledger_target_sessions target
           WHERE (target.expires_at <= $1 OR target.revoked_at IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1 FROM accounting_cases case_head
               WHERE case_head.target_session_hash = target.session_hash
             )
             AND NOT EXISTS (
               SELECT 1 FROM accounting_case_recovery_residual_grants residual_grant
               WHERE residual_grant.target_session_hash = target.session_hash
             )
           ORDER BY target.expires_at, target.session_hash
           LIMIT $2
           FOR UPDATE OF target SKIP LOCKED
         )
         DELETE FROM ledger_target_sessions target
         USING targets
         WHERE target.session_hash = targets.session_hash`,
        [brokerFlowCutoff, batchSize],
      );

      const expiredBrokerFlows = await client.query(
        `SELECT flow.*
         FROM oauth_broker_flows flow
         WHERE flow.flow_version = 2
           AND flow.flow_status IN ('AUTHORIZING_XERO','EXCHANGING_XERO','AWAITING_SELECTION')
           AND flow.consumed_at IS NULL
           AND flow.outer_state_ciphertext IS NOT NULL
           AND flow.expires_at <= $1
         ORDER BY flow.expires_at, flow.flow_hash
         LIMIT $2
         FOR UPDATE OF flow SKIP LOCKED`,
        [brokerFlowCutoff, batchSize],
      );
      for (const rawRow of expiredBrokerFlows.rows) {
        await this.#revokePendingBrokerGrant(client, rawRow as Row, brokerFlowCutoff);
      }
      const expiredFlowHashes = expiredBrokerFlows.rows.map((rawRow) => String((rawRow as Row).flow_hash));
      const oauthBrokerFlows = expiredFlowHashes.length === 0
        ? { rowCount: 0 }
        : await client.query(
          `UPDATE oauth_broker_flows SET
             flow_status = 'FAILED',
             consumed_at = $1,
             updated_at = $1,
             outer_state_ciphertext = NULL,
             selection_csrf_hash = NULL
           WHERE flow_hash = ANY($2::text[])
             AND flow_version = 2
             AND flow_status IN ('AUTHORIZING_XERO','EXCHANGING_XERO','AWAITING_SELECTION')
             AND consumed_at IS NULL`,
          [brokerFlowCutoff, expiredFlowHashes],
        );

      // A CSRF token is unusable once either it or its parent operator session
      // has expired. Delete those children first so parent cleanup remains
      // bounded instead of relying on an unbounded FK cascade.
      const reviewCsrf = await client.query(
        `WITH targets AS (
           SELECT csrf.csrf_hash
           FROM review_csrf_tokens csrf
           WHERE csrf.expires_at <= $1
              OR EXISTS (
                SELECT 1 FROM operator_sessions sessions
                WHERE sessions.session_hash = csrf.session_hash
                  AND sessions.expires_at <= $1
              )
           ORDER BY csrf.expires_at, csrf.csrf_hash
           LIMIT $2
           FOR UPDATE OF csrf SKIP LOCKED
         )
         DELETE FROM review_csrf_tokens csrf
         USING targets
         WHERE csrf.csrf_hash = targets.csrf_hash`,
        [cutoff, batchSize],
      );

      const operatorSessions = await client.query(
        `WITH targets AS (
           SELECT sessions.session_hash
           FROM operator_sessions sessions
           WHERE sessions.expires_at <= $1
             AND NOT EXISTS (
               SELECT 1 FROM review_csrf_tokens csrf
               WHERE csrf.session_hash = sessions.session_hash
             )
           ORDER BY sessions.expires_at, sessions.session_hash
           LIMIT $2
           FOR UPDATE OF sessions SKIP LOCKED
         )
         DELETE FROM operator_sessions sessions
         USING targets
         WHERE sessions.session_hash = targets.session_hash`,
        [cutoff, batchSize],
      );

      const oauthStates = await client.query(
        `WITH targets AS (
           SELECT state.state_hash
           FROM oauth_states state
           WHERE state.expires_at <= $1
           ORDER BY state.expires_at, state.state_hash
           LIMIT $2
           FOR UPDATE OF state SKIP LOCKED
         )
         DELETE FROM oauth_states state
         USING targets
         WHERE state.state_hash = targets.state_hash`,
        [cutoff, batchSize],
      );

      const connectTickets = await client.query(
        `WITH targets AS (
           SELECT ticket.ticket_hash
           FROM connect_tickets ticket
           WHERE ticket.expires_at <= $1
           ORDER BY ticket.expires_at, ticket.ticket_hash
           LIMIT $2
           FOR UPDATE OF ticket SKIP LOCKED
         )
         DELETE FROM connect_tickets ticket
         USING targets
         WHERE ticket.ticket_hash = targets.ticket_hash`,
        [cutoff, batchSize],
      );

      await client.query("COMMIT");
      return {
        lockAcquired: true,
        deleted: {
          mcpRefreshRetryResponses: mcpRefreshRetryResponses.rowCount ?? 0,
          organisationSwitchSessions: organisationSwitchSessions.rowCount ?? 0,
          ledgerTargetSessions: ledgerTargetSessions.rowCount ?? 0,
          oauthBrokerFlows: oauthBrokerFlows.rowCount ?? 0,
          oauthStates: oauthStates.rowCount ?? 0,
          connectTickets: connectTickets.rowCount ?? 0,
          operatorSessions: operatorSessions.rowCount ?? 0,
          reviewCsrfTokens: reviewCsrf.rowCount ?? 0,
        },
      };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getConnectionByActorTenant(actorId: string, tenantId: string): Promise<ProviderConnection | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM provider_connections WHERE actor_id = $1 AND provider = 'xero' AND tenant_id = $2`,
      [actorId, tenantId],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
  }

  async listActiveConnections(actorId: string): Promise<ProviderConnection[]> {
    const result = await this.pool.query(
      `SELECT * FROM provider_connections
       WHERE actor_id = $1 AND provider = 'xero' AND connection_status = 'ACTIVE'
       ORDER BY created_at ASC`,
      [actorId],
    );
    return result.rows.map(mapConnection);
  }

  async upsertConnection(connection: ProviderConnection): Promise<ProviderConnection> {
    const result = await this.pool.query(
      `INSERT INTO provider_connections(
         connection_id, actor_id, provider, tenant_id, tenant_name, tenant_short_code, granted_scopes,
         token_ciphertext, token_expires_at, refresh_version, connection_status, created_at, updated_at
       ) VALUES ($1,$2,'xero',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (actor_id, provider, tenant_id) DO UPDATE SET
         tenant_name = EXCLUDED.tenant_name,
         tenant_short_code = EXCLUDED.tenant_short_code,
         granted_scopes = EXCLUDED.granted_scopes,
         token_ciphertext = EXCLUDED.token_ciphertext,
         token_expires_at = EXCLUDED.token_expires_at,
         refresh_version = provider_connections.refresh_version + 1,
         connection_status = 'ACTIVE',
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        connection.connectionId,
        connection.actorId,
        connection.tenantId,
        connection.tenantName,
        connection.tenantShortCode ?? null,
        connection.grantedScopes,
        connection.tokenCiphertext,
        connection.tokenExpiresAt,
        connection.refreshVersion,
        connection.status,
        connection.createdAt,
        connection.updatedAt,
      ],
    );
    return mapConnection(result.rows[0] as Row);
  }

  async updateConnectionToken(
    connectionId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
  ): Promise<ProviderConnection | undefined> {
    const result = await this.pool.query(
      `UPDATE provider_connections SET
         token_ciphertext = $3,
         token_expires_at = $4,
         refresh_version = refresh_version + 1,
         connection_status = 'ACTIVE',
         updated_at = now()
       WHERE connection_id = $1 AND refresh_version = $2
         AND connection_status <> 'REVOKED'
       RETURNING *`,
      [connectionId, expectedRefreshVersion, tokenCiphertext, tokenExpiresAt],
    );
    return result.rows[0] ? mapConnection(result.rows[0]) : undefined;
  }

  async markConnectionStatus(connectionId: string, status: ProviderConnection["status"]): Promise<void> {
    await this.pool.query(
      `UPDATE provider_connections SET connection_status = $2, updated_at = now()
       WHERE connection_id = $1 AND connection_status <> 'REVOKED'`,
      [connectionId, status],
    );
  }

  async markConnectionStatusIfVersion(
    connectionId: string,
    expectedRefreshVersion: number,
    status: ProviderConnection["status"],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE provider_connections
       SET connection_status = $3, updated_at = now()
       WHERE connection_id = $1 AND refresh_version = $2 AND connection_status = 'ACTIVE'`,
      [connectionId, expectedRefreshVersion, status],
    );
    return result.rowCount === 1;
  }

  async createOrGetPosting(input: CreatePostingInput): Promise<{ posting: PostingRequest; created: boolean }> {
    const identity = xeroSupplierPostingIdentity(input.providerPayload);
    const documentType = input.documentType ?? identity.documentType;
    if (identity.documentType !== documentType) {
      throw new AppError("VALIDATION_FAILED", "Xero document type does not match the canonical provider payload.");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.pool.query(
        `INSERT INTO posting_requests(
           posting_request_id, actor_id, tenant_id, source_ref, source_sha256,
           source_evidence_type, provider_payload, request_payload_hash, provider_payload_hash, state,
           request_id, create_operation, create_idempotency_key, document_type
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VALIDATED',$10,'CREATE_DRAFT',$11,$12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.postingRequestId,
          input.actorId,
          input.tenantId,
          input.sourceRef,
          input.sourceSha256,
          input.sourceEvidenceType,
          input.providerPayload,
          input.requestPayloadHash,
          input.providerPayloadHash,
          input.requestId,
          input.createIdempotencyKey,
          documentType,
        ],
      );
      if (inserted.rows[0]) return { posting: mapPosting(inserted.rows[0]), created: true };

      const existing = await this.pool.query(
        `SELECT * FROM posting_requests
         WHERE tenant_id = $2 AND (
           (actor_id = $1 AND request_id = $3 AND create_operation = 'CREATE_DRAFT' AND document_type = $6) OR (
           state = ANY($4::text[]) AND source_sha256 = $5
           )
         )
         ORDER BY (actor_id = $1 AND request_id = $3 AND create_operation = 'CREATE_DRAFT' AND document_type = $6) DESC,
                  created_at DESC
         LIMIT 1`,
        [
          input.actorId,
          input.tenantId,
          input.requestId,
          ACTIVE_XERO_DUPLICATE_STATES,
          input.sourceSha256,
          documentType,
        ],
      );
      if (existing.rows[0]) return { posting: mapPosting(existing.rows[0]), created: false };
    }

    const legacyCompatibilityConflict = await this.pool.query(
      `SELECT 1
       FROM posting_requests
       WHERE tenant_id = $2 AND (
         (actor_id = $1 AND request_id = $3 AND create_operation = 'CREATE_DRAFT')
       )
       LIMIT 1`,
      [
        input.actorId,
        input.tenantId,
        input.requestId,
      ],
    );
    if (legacyCompatibilityConflict.rowCount === 1) {
      throw new AppError(
        "CONFLICT",
        "The request conflicts with a temporary legacy-runtime duplicate guard.",
        {
          httpStatus: 409,
          details: { reason: "LEGACY_RUNTIME_DUPLICATE_GUARD" },
        },
      );
    }
    throw new Error("Xero posting conflict row disappeared");
  }

  async findActivePostingDuplicate(
    input: FindActiveXeroPostingDuplicateInput,
  ): Promise<PostingRequest | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM posting_requests
       WHERE tenant_id = $1
         AND state = ANY($2::text[])
         AND source_sha256 = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [
        input.tenantId,
        ACTIVE_XERO_DUPLICATE_STATES,
        input.sourceSha256,
      ],
    );
    return result.rows[0] ? mapPosting(result.rows[0]) : undefined;
  }

  async getPosting(postingRequestId: string): Promise<PostingRequest | undefined> {
    const result = await this.pool.query("SELECT * FROM posting_requests WHERE posting_request_id = $1", [
      postingRequestId,
    ]);
    return result.rows[0] ? mapPosting(result.rows[0]) : undefined;
  }

  async markDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest> {
    const result = await this.pool.query(
      `UPDATE posting_requests SET
         xero_invoice_id = $2,
         provider_payload = $3,
         provider_payload_hash = $4,
         write_receipt = $5,
         readback_snapshot = $6,
         draft_write_receipt = $5,
         draft_readback_snapshot = $6,
         state = CASE WHEN document_type = 'ACCREC' THEN 'DRAFT_READBACK_VERIFIED' ELSE 'APPROVAL_PENDING' END,
         updated_at = now()
       WHERE posting_request_id = $1 AND state = 'VALIDATED'
       RETURNING *`,
      [
        postingRequestId,
        update.xeroInvoiceId,
        update.providerPayload,
        update.providerPayloadHash,
        update.writeReceipt,
        update.readbackSnapshot,
      ],
    );
    if (!result.rows[0]) throw new AppError("CONFLICT", "Posting request is not in VALIDATED state.", { httpStatus: 409 });
    return mapPosting(result.rows[0]);
  }

  async recoverDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest> {
    const result = await this.pool.query(
      `UPDATE posting_requests SET
         xero_invoice_id = $2,
         provider_payload = $3,
         provider_payload_hash = $4,
         write_receipt = $5,
         readback_snapshot = $6,
         draft_write_receipt = $5,
         draft_readback_snapshot = $6,
         state = CASE WHEN document_type = 'ACCREC' THEN 'DRAFT_READBACK_VERIFIED' ELSE 'APPROVAL_PENDING' END,
         updated_at = now()
       WHERE posting_request_id = $1
         AND state = 'WRITE_RESULT_UNKNOWN'
         AND authorise_request_id IS NULL
         AND (xero_invoice_id IS NULL OR xero_invoice_id = $2)
       RETURNING *`,
      [
        postingRequestId,
        update.xeroInvoiceId,
        update.providerPayload,
        update.providerPayloadHash,
        update.writeReceipt,
        update.readbackSnapshot,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError("CONFLICT", "Posting request is not in WRITE_RESULT_UNKNOWN state.", { httpStatus: 409 });
    }
    return mapPosting(result.rows[0]);
  }

  async markDraftReadbackMismatch(
    postingRequestId: string,
    update: DraftReadbackMismatchUpdate,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE posting_requests SET
         xero_invoice_id = $2,
         write_receipt = $3,
         readback_snapshot = $4,
         draft_write_receipt = $3,
         draft_readback_snapshot = $4,
         state = 'READBACK_MISMATCH',
         updated_at = now()
       WHERE posting_request_id = $1
         AND state IN ('VALIDATED', 'WRITE_RESULT_UNKNOWN')
         AND authorise_request_id IS NULL
         AND (xero_invoice_id IS NULL OR xero_invoice_id = $2)
       RETURNING posting_request_id`,
      [postingRequestId, update.xeroInvoiceId, update.writeReceipt, update.readbackSnapshot],
    );
    if (result.rowCount !== 1) {
      throw new AppError("CONFLICT", "Draft readback mismatch cannot overwrite the current posting state.", {
        httpStatus: 409,
      });
    }
  }

  async markDraftWriteUnknown(
    postingRequestId: string,
    xeroInvoiceId?: string,
    writeReceipt?: Record<string, unknown>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT state, authorise_request_id, xero_invoice_id, write_receipt
         FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE`,
        [postingRequestId],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const state = row.state as PostingState;
      if (row.authorise_request_id) {
        throw new AppError("CONFLICT", "Draft write uncertainty cannot overwrite an authorisation attempt.", {
          httpStatus: 409,
        });
      }
      if (state === "AUTHORISED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return;
      }
      if (state !== "VALIDATED" && state !== "WRITE_RESULT_UNKNOWN") {
        throw new AppError("CONFLICT", `Draft write uncertainty cannot be recorded from ${state}.`, {
          httpStatus: 409,
        });
      }
      const existingInvoiceId = row.xero_invoice_id ? String(row.xero_invoice_id) : undefined;
      if (xeroInvoiceId && existingInvoiceId && xeroInvoiceId !== existingInvoiceId) {
        throw new AppError("CONFLICT", "Draft write recovery cannot replace the known Xero InvoiceID.", {
          httpStatus: 409,
        });
      }
      if (
        writeReceipt && row.write_receipt &&
        stableStringify(writeReceipt) !== stableStringify(row.write_receipt)
      ) {
        throw new AppError("CONFLICT", "Draft write recovery cannot replace the known Provider receipt.", {
          httpStatus: 409,
        });
      }
      await client.query(
        `UPDATE posting_requests SET
           state = 'WRITE_RESULT_UNKNOWN',
           xero_invoice_id = COALESCE(xero_invoice_id, $2),
           write_receipt = COALESCE(write_receipt, $3),
           draft_write_receipt = COALESCE(draft_write_receipt, $3),
           updated_at = now()
         WHERE posting_request_id = $1`,
        [postingRequestId, xeroInvoiceId ?? null, writeReceipt ?? null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPostingState(postingRequestId: string, state: PostingState): Promise<void> {
    if (state !== "BLOCKED_VALIDATION" && state !== "READBACK_MISMATCH") {
      throw new AppError("CONFLICT", `${state} is not a draft failure state.`, { httpStatus: 409 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT state, authorise_request_id
         FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE`,
        [postingRequestId],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const currentState = row.state as PostingState;
      if (currentState === "AUTHORISED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return;
      }
      if (
        currentState !== "VALIDATED" &&
        (currentState !== "WRITE_RESULT_UNKNOWN" || row.authorise_request_id)
      ) {
        throw new AppError("CONFLICT", `Draft failure cannot be recorded from ${currentState}.`, {
          httpStatus: 409,
        });
      }
      await client.query(
        "UPDATE posting_requests SET state = $2, updated_at = now() WHERE posting_request_id = $1",
        [postingRequestId, state],
      );
      await client.query("COMMIT");
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async approvePosting(
    postingRequestId: string,
    approvedBy: string,
    approvalRefHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<PostingRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT * FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE",
        [postingRequestId],
      );
      if (!selected.rows[0]) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const posting = mapPosting(selected.rows[0]);
      let result;
      if (posting.state === "APPROVAL_PENDING") {
        result = await client.query(
          `UPDATE posting_requests SET
             state = 'APPROVED', approval_ref_hash = $3, approved_by = $2,
             approved_at = $5, approval_expires_at = $4, updated_at = $5
           WHERE posting_request_id = $1
           RETURNING *`,
          [postingRequestId, approvedBy, approvalRefHash, expiresAt, now],
        );
      } else if (
        posting.state === "APPROVED" &&
        posting.approvedBy === approvedBy &&
        !posting.approvalConsumedAt &&
        posting.approvalRefHash
      ) {
        const renewedExpiry = posting.approvalExpiresAt && posting.approvalExpiresAt > expiresAt
          ? posting.approvalExpiresAt
          : expiresAt;
        result = await client.query(
          `UPDATE posting_requests SET approval_expires_at = $2, updated_at = $3
           WHERE posting_request_id = $1
           RETURNING *`,
          [postingRequestId, renewedExpiry, now],
        );
      } else {
        throw new AppError("CONFLICT", `Posting request cannot be approved from ${posting.state}.`, { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return mapPosting(result.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectPosting(postingRequestId: string, rejectedBy: string, now: Date): Promise<PostingRequest> {
    const result = await this.pool.query(
      `UPDATE posting_requests SET state = 'REJECTED', approved_by = $2, updated_at = $3
       WHERE posting_request_id = $1 AND state = 'APPROVAL_PENDING'
       RETURNING *`,
      [postingRequestId, rejectedBy, now],
    );
    if (!result.rows[0]) throw new AppError("CONFLICT", "Posting request is not awaiting approval.", { httpStatus: 409 });
    return mapPosting(result.rows[0]);
  }

  async beginAuthorise(input: BeginAuthoriseInput): Promise<BeginAuthoriseResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query("SELECT * FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE", [
        input.postingRequestId,
      ]);
      if (!selected.rows[0]) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const posting = mapPosting(selected.rows[0]);
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
        await client.query("COMMIT");
        return { posting, mode: "ALREADY_COMPLETE" };
      }
      if (posting.state === "AUTHORISING" || posting.state === "WRITE_RESULT_UNKNOWN") {
        if (posting.authoriseRequestId !== input.requestId) {
          throw new AppError("CONFLICT", "An authorisation attempt is already in progress.", { httpStatus: 409 });
        }
        await client.query("COMMIT");
        return { posting, mode: "RESUME_READBACK_ONLY" };
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

      const updated = await client.query(
        `UPDATE posting_requests SET
           state = 'AUTHORISING', authorise_request_id = $2, authorise_operation = 'AUTHORISE',
           authorise_idempotency_key = $3, approval_consumed_at = $4, updated_at = $4
         WHERE posting_request_id = $1
         RETURNING *`,
        [input.postingRequestId, input.requestId, input.idempotencyKey, input.now],
      );
      await client.query("COMMIT");
      return { posting: mapPosting(updated.rows[0] as Row), mode: "CALL_PROVIDER" };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginReviewAuthorise(input: BeginReviewAuthoriseInput): Promise<BeginAuthoriseResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT * FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE",
        [input.postingRequestId],
      );
      if (!selected.rows[0]) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const posting = mapPosting(selected.rows[0]);
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

      const consumed = await client.query(
        `UPDATE review_csrf_tokens SET consumed_at = $5
         WHERE csrf_hash = $1 AND session_hash = $2 AND actor_id = $3
           AND posting_request_id = $4 AND consumed_at IS NULL AND expires_at > $5
         RETURNING csrf_hash`,
        [input.csrfHash, input.sessionHash, input.actorId, input.postingRequestId, input.now],
      );
      if (consumed.rowCount !== 1) {
        throw new AppError("FORBIDDEN", "Review CSRF token is invalid, expired, or already used.", { httpStatus: 403 });
      }

      if (mode !== "CALL_PROVIDER") {
        await client.query("COMMIT");
        return { posting, mode };
      }
      const approvalRefHash = posting.state === "APPROVED"
        ? posting.approvalRefHash as string
        : input.approvalRefHash;
      const updated = await client.query(
        `UPDATE posting_requests SET
           state = 'AUTHORISING', authorise_request_id = $2, authorise_operation = 'AUTHORISE',
           authorise_idempotency_key = $3, approval_ref_hash = $4, approved_by = $5,
           approved_at = COALESCE(approved_at, $6), approval_expires_at = $7,
           approval_consumed_at = $6, updated_at = $6
         WHERE posting_request_id = $1
         RETURNING *`,
        [
          input.postingRequestId,
          input.requestId,
          input.idempotencyKey,
          approvalRefHash,
          input.actorId,
          input.now,
          input.approvalExpiresAt,
        ],
      );
      await client.query("COMMIT");
      return { posting: mapPosting(updated.rows[0] as Row), mode };
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectPostingFromReview(input: RejectReviewInput): Promise<PostingRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT * FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE",
        [input.postingRequestId],
      );
      if (!selected.rows[0]) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const posting = mapPosting(selected.rows[0]);
      if (posting.actorId !== input.actorId) {
        throw new AppError("FORBIDDEN", "Posting request belongs to another actor.", { httpStatus: 403 });
      }
      if (posting.state !== "APPROVAL_PENDING") {
        throw new AppError("CONFLICT", `Posting request cannot be rejected from ${posting.state}.`, { httpStatus: 409 });
      }
      const consumed = await client.query(
        `UPDATE review_csrf_tokens SET consumed_at = $5
         WHERE csrf_hash = $1 AND session_hash = $2 AND actor_id = $3
           AND posting_request_id = $4 AND consumed_at IS NULL AND expires_at > $5
         RETURNING csrf_hash`,
        [input.csrfHash, input.sessionHash, input.actorId, input.postingRequestId, input.now],
      );
      if (consumed.rowCount !== 1) {
        throw new AppError("FORBIDDEN", "Review CSRF token is invalid, expired, or already used.", { httpStatus: 403 });
      }
      const rejected = await client.query(
        `UPDATE posting_requests SET state = 'REJECTED', approved_by = $2, updated_at = $3
         WHERE posting_request_id = $1
         RETURNING *`,
        [input.postingRequestId, input.actorId, input.now],
      );
      await client.query("COMMIT");
      return mapPosting(rejected.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeAuthorise(
    postingRequestId: string,
    writeReceipt: Record<string, unknown>,
    readbackSnapshot: Record<string, unknown>,
  ): Promise<PostingRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT * FROM posting_requests WHERE posting_request_id = $1 FOR UPDATE",
        [postingRequestId],
      );
      if (!selected.rows[0]) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
      const posting = mapPosting(selected.rows[0]);
      const readbackInvoiceId = readbackSnapshot.invoiceId;
      if (typeof readbackInvoiceId !== "string" || posting.xeroInvoiceId !== readbackInvoiceId) {
        throw new AppError("READBACK_MISMATCH", "Authorisation readback does not match the posting Xero InvoiceID.", {
          httpStatus: 409,
        });
      }
      if (posting.state === "AUTHORISED_READBACK_VERIFIED") {
        await client.query("COMMIT");
        return posting;
      }
      if (posting.state !== "AUTHORISING" && posting.state !== "WRITE_RESULT_UNKNOWN") {
        throw new AppError("CONFLICT", "Posting request cannot be completed from its current state.", { httpStatus: 409 });
      }
      const result = await client.query(
        `UPDATE posting_requests SET
           state = 'AUTHORISED_READBACK_VERIFIED', write_receipt = $2,
           readback_snapshot = $3,
           draft_write_receipt = COALESCE(draft_write_receipt, write_receipt),
           draft_readback_snapshot = COALESCE(draft_readback_snapshot, readback_snapshot),
           authorise_write_receipt = $2,
           authorise_readback_snapshot = $3, updated_at = now()
         WHERE posting_request_id = $1
         RETURNING *`,
        [postingRequestId, writeReceipt, readbackSnapshot],
      );
      await client.query("COMMIT");
      return mapPosting(result.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markAuthoriseFailure(
    postingRequestId: string,
    state: "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION",
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE posting_requests SET state = $2, updated_at = now()
       WHERE posting_request_id = $1 AND state IN ('AUTHORISING', 'WRITE_RESULT_UNKNOWN')
       RETURNING state`,
      [postingRequestId, state],
    );
    if (result.rowCount === 1) return;

    const existing = await this.pool.query<{ state: PostingState }>(
      "SELECT state FROM posting_requests WHERE posting_request_id = $1",
      [postingRequestId],
    );
    const posting = existing.rows[0];
    if (!posting) {
      throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
    }
    if (posting.state === "AUTHORISED_READBACK_VERIFIED") return;
    throw new AppError("CONFLICT", `Authorisation failure cannot be recorded from ${posting.state}.`, {
      httpStatus: 409,
    });
  }

  async createXeroMutationPreparation(
    input: CreateXeroMutationPreparationInput,
  ): Promise<XeroMutationPreparation> {
    const result = await this.pool.query(
      `INSERT INTO xero_mutation_preparations(
         preparation_id, actor_id, workspace_id, tenant_id, oauth_installation_id,
         binding_id, connection_id, binding_revision, target_session_id,
         object_type, operation, target_xero_object_id, canonical_payload,
         canonical_payload_hash, source_ref, source_unit_key, source_sha256, source_evidence_type,
         confirmation_summary_hash, confirmation_phrase_hash, state, expires_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'PREPARED',$21,$22,$22
       )
       RETURNING *`,
      [
        input.preparationId,
        input.actorId,
        input.workspaceId,
        input.tenantId,
        input.installationId,
        input.bindingId,
        input.connectionId,
        input.bindingRevision ?? null,
        input.targetSessionId ?? null,
        input.objectType,
        input.operation,
        input.targetXeroObjectId ?? null,
        input.canonicalPayload,
        input.canonicalPayloadHash,
        input.sourceRef ?? null,
        input.sourceUnitKey,
        input.sourceSha256,
        input.sourceEvidenceType,
        input.confirmationSummaryHash,
        input.confirmationPhraseHash,
        input.expiresAt,
        input.now,
      ],
    );
    return mapXeroMutationPreparation(result.rows[0] as Row);
  }

  async getXeroMutationPreparation(preparationId: string): Promise<XeroMutationPreparation | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM xero_mutation_preparations WHERE preparation_id = $1",
      [preparationId],
    );
    return result.rows[0] ? mapXeroMutationPreparation(result.rows[0]) : undefined;
  }

  async confirmXeroMutationPreparation(
    input: ConfirmXeroMutationPreparationInput,
  ): Promise<ConfirmXeroMutationPreparationResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if ((input.expectedAuthoritySnapshotRevision === undefined) !==
          (input.expectedAuthoritySnapshotHash === undefined)) {
        throw new AppError("VALIDATION_FAILED", "Authority snapshot claim binding is incomplete.", {
          httpStatus: 422,
        });
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
      const selected = await client.query(
        `SELECT * FROM xero_mutation_preparations
         WHERE preparation_id = $1
           AND actor_id = $2 AND workspace_id = $3 AND tenant_id = $4
           AND oauth_installation_id = $5 AND binding_id = $6 AND connection_id = $7
           AND object_type = $8 AND operation = $9
           AND target_xero_object_id IS NOT DISTINCT FROM $10::text
           AND canonical_payload = $11::jsonb AND canonical_payload_hash = $12
           AND source_ref IS NOT DISTINCT FROM $13::text
           AND source_unit_key = $14
           AND source_sha256 = $15 AND source_evidence_type = $16
           AND confirmation_summary_hash = $17 AND confirmation_phrase_hash = $18
           AND binding_revision IS NOT DISTINCT FROM $19::bigint
           AND target_session_id IS NOT DISTINCT FROM $20::text
         FOR UPDATE`,
        [
          input.preparationId,
          input.actorId,
          input.workspaceId,
          input.tenantId,
          input.installationId,
          input.bindingId,
          input.connectionId,
          input.objectType,
          input.operation,
          input.targetXeroObjectId ?? null,
          input.canonicalPayload,
          input.canonicalPayloadHash,
          input.sourceRef ?? null,
          input.sourceUnitKey,
          input.sourceSha256,
          input.sourceEvidenceType,
          input.confirmationSummaryHash,
          input.confirmationPhraseHash,
          input.bindingRevision ?? null,
          input.targetSessionId ?? null,
        ],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const preparation = mapXeroMutationPreparation(row);
      if (preparation.state === "CONSUMED") {
        const existing = await client.query(
          `SELECT * FROM xero_mutation_requests
           WHERE preparation_id = $1 AND mutation_request_id = $2 AND request_id = $3
             AND actor_id = $4 AND tenant_id = $5 AND object_type = $6 AND operation = $7
             AND target_xero_object_id IS NOT DISTINCT FROM $8::text
             AND canonical_payload = $9::jsonb AND canonical_payload_hash = $10
             AND source_ref IS NOT DISTINCT FROM $11::text
             AND source_unit_key = $12
             AND source_sha256 = $13 AND source_evidence_type = $14
             AND confirmation_summary_hash = $15
             AND binding_revision IS NOT DISTINCT FROM $16::bigint
             AND target_session_id IS NOT DISTINCT FROM $17::text`,
          [
            input.preparationId,
            input.mutationRequestId,
            input.requestId,
            input.actorId,
            input.tenantId,
            input.objectType,
            input.operation,
            input.targetXeroObjectId ?? null,
            input.canonicalPayload,
            input.canonicalPayloadHash,
            input.sourceRef ?? null,
            input.sourceUnitKey,
            input.sourceSha256,
            input.sourceEvidenceType,
            input.confirmationSummaryHash,
            input.bindingRevision ?? null,
            input.targetSessionId ?? null,
          ],
        );
        await client.query("COMMIT");
        return existing.rows[0]
          ? { request: mapXeroMutationRequest(existing.rows[0]), created: false }
          : undefined;
      }
      if (preparation.state !== "PREPARED") {
        await client.query("COMMIT");
        return undefined;
      }
      let lockedGovernanceAuthority: ReturnType<typeof exactFirmGovernanceAuthorityFromSnapshot>;
      if (input.expectedAuthoritySnapshotRevision !== undefined) {
        const authority = await client.query(
          `SELECT * FROM ledger_authority_snapshots
           WHERE provider_id = 'xero' FOR UPDATE`,
        );
        const current = authority.rows[0]
          ? mapLedgerAuthoritySnapshot(authority.rows[0] as Row)
          : undefined;
        if (
          !current || current.revision !== input.expectedAuthoritySnapshotRevision ||
          current.snapshotHash !== input.expectedAuthoritySnapshotHash
        ) {
          throw new AppError("APPROVAL_INVALID", "Ledger authority changed before the provider-write claim.", {
            httpStatus: 409,
          });
        }
        if (input.expectedFirmGovernanceClaim) {
          lockedGovernanceAuthority = exactFirmGovernanceAuthorityFromSnapshot(
            current,
            input.expectedFirmGovernanceClaim,
          );
          if (!lockedGovernanceAuthority) {
            throw new AppError("APPROVAL_INVALID", "Firm-governance authority changed before the provider-write claim.", {
              httpStatus: 409,
            });
          }
        }
      }
      // Read the database clock only after the authority row lock is held, so
      // lock wait time cannot make the expiry comparison stale.
      const repositoryClock = await client.query<{ repository_now: Date }>(
        "SELECT statement_timestamp() AS repository_now",
      );
      const repositoryNow = repositoryClock.rows[0]?.repository_now;
      if (!(repositoryNow instanceof Date) || !Number.isFinite(repositoryNow.getTime())) {
        throw new AppError("PERSISTENCE_FAILURE", "PostgreSQL did not return a valid repository timestamp.", {
          httpStatus: 503,
        });
      }
      if (lockedGovernanceAuthority && lockedGovernanceAuthority.effectiveExpiresAt <= repositoryNow) {
        throw new AppError("APPROVAL_INVALID", "Firm-governance authority expired before the provider-write claim.", {
          httpStatus: 409,
        });
      }
      let targetLeaseUnavailable = false;
      if (preparation.targetSessionId) {
        const targetLease = await client.query<{ expires_at: Date; revoked_at: Date | null }>(
          `SELECT expires_at, revoked_at
           FROM ledger_target_sessions
           WHERE session_id = $1
             AND oauth_installation_id = $2
             AND binding_id = $3
             AND connection_id = $4
             AND binding_revision = $5`,
          [
            preparation.targetSessionId,
            preparation.installationId,
            preparation.bindingId,
            preparation.connectionId,
            preparation.bindingRevision,
          ],
        );
        const target = targetLease.rows[0];
        targetLeaseUnavailable = !target || target.revoked_at !== null || target.expires_at <= repositoryNow;
      }
      if (preparation.expiresAt <= repositoryNow || targetLeaseUnavailable) {
        await client.query(
          `UPDATE xero_mutation_preparations
           SET state = 'EXPIRED', updated_at = GREATEST(updated_at, statement_timestamp())
           WHERE preparation_id = $1 AND state = 'PREPARED'`,
          [input.preparationId],
        );
        await client.query("COMMIT");
        return undefined;
      }

      const inserted = await client.query(
        `INSERT INTO xero_mutation_requests(
           mutation_request_id, preparation_id, request_id,
           actor_id, workspace_id, tenant_id, oauth_installation_id, binding_id, connection_id,
           binding_revision, target_session_id, object_type, operation,
           target_xero_object_id, canonical_payload, canonical_payload_hash,
           source_ref, source_unit_key, source_sha256, source_evidence_type, confirmation_summary_hash,
           authorization_receipt, validation_receipt, state, confirmed_at, write_started_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$25,$25
         )
         RETURNING *`,
        [
          input.mutationRequestId,
          input.preparationId,
          input.requestId,
          input.actorId,
          input.workspaceId,
          input.tenantId,
          input.installationId,
          input.bindingId,
          input.connectionId,
          input.bindingRevision ?? null,
          input.targetSessionId ?? null,
          input.objectType,
          input.operation,
          input.targetXeroObjectId ?? null,
          input.canonicalPayload,
          input.canonicalPayloadHash,
          input.sourceRef ?? null,
          input.sourceUnitKey,
          input.sourceSha256,
          input.sourceEvidenceType,
          input.confirmationSummaryHash,
          input.authorizationReceipt,
          input.successfulValidationReceipt ?? null,
          input.claimForWrite ? "WRITE_IN_FLIGHT" : "CONFIRMED",
          input.now,
          input.claimForWrite ? input.now : null,
        ],
      );
      const consumed = await client.query(
        `UPDATE xero_mutation_preparations
         SET state = 'CONSUMED', consumed_at = $2, updated_at = $2
         WHERE preparation_id = $1 AND state = 'PREPARED'
         RETURNING preparation_id`,
        [input.preparationId, input.now],
      );
      if (consumed.rowCount !== 1) {
        throw new AppError("CONFLICT", "Mutation preparation could not be consumed atomically.", { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return { request: mapXeroMutationRequest(inserted.rows[0] as Row), created: true };
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "Mutation request conflicts with an active idempotency or source guard.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getXeroMutationRequest(mutationRequestId: string): Promise<XeroMutationRequest | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM xero_mutation_requests WHERE mutation_request_id = $1",
      [mutationRequestId],
    );
    return result.rows[0] ? mapXeroMutationRequest(result.rows[0]) : undefined;
  }

  async beginXeroMutationWrite(input: BeginXeroMutationWriteInput): Promise<BeginXeroMutationWriteResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (request.state === "READBACK_VERIFIED") {
        await client.query("COMMIT");
        return { request, mode: "ALREADY_VERIFIED" };
      }
      if (["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
        await client.query("COMMIT");
        return { request, mode: "RECOVER_ONLY" };
      }
      if (request.state !== "CONFIRMED") {
        throw new AppError("CONFLICT", `Mutation cannot start from ${request.state}.`, { httpStatus: 409 });
      }
      const targetsExistingObject = xeroMutationTargetsExistingObject(request.operation);
      const targetXeroObjectId = targetsExistingObject ? request.targetXeroObjectId : undefined;
      if (targetsExistingObject && !targetXeroObjectId) {
        throw new AppError("CONFLICT", "Existing-object mutation has no immutable Xero target identifier.", {
          httpStatus: 409,
        });
      }
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'WRITE_IN_FLIGHT', xero_object_id = COALESCE(xero_object_id, $2),
           write_started_at = $3, updated_at = $3
         WHERE mutation_request_id = $1
         RETURNING *`,
        [input.mutationRequestId, targetXeroObjectId ?? null, input.now],
      );
      await client.query("COMMIT");
      return { request: mapXeroMutationRequest(updated.rows[0] as Row), mode: "CALL_PROVIDER" };
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "The exact Xero object is already bound to another active mutation.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordXeroMutationWriteEvidence(
    input: RecordXeroMutationWriteEvidenceInput,
  ): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      const nativeRecoveryReplay = request.state === "WRITE_UNCERTAIN" &&
        request.nativeRecoveryClaim !== undefined &&
        request.xeroObjectId === undefined;
      if (request.state !== "WRITE_IN_FLIGHT" && !nativeRecoveryReplay) {
        throw new AppError("CONFLICT", `Mutation write evidence cannot be recorded from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           xero_object_id = $2, write_receipt = $3, updated_at = $4
         WHERE mutation_request_id = $1
           AND (
             state = 'WRITE_IN_FLIGHT'
             OR (state = 'WRITE_UNCERTAIN' AND native_recovery_claim IS NOT NULL AND xero_object_id IS NULL)
           )
         RETURNING *`,
        [input.mutationRequestId, input.xeroObjectId, input.writeReceipt, input.now],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "Mutation write evidence CAS failed.", { httpStatus: 409 });
      }
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "The exact Xero object is already bound to another active mutation.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markXeroMutationWriteUnknown(
    input: MarkXeroMutationWriteUnknownInput & {
      nativeRecoveryClaim?: XeroNativeIdempotencyRecoveryClaim;
    },
  ): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (request.state !== "WRITE_IN_FLIGHT" && request.state !== "WRITE_UNCERTAIN") {
        throw new AppError("CONFLICT", `Mutation uncertainty cannot be recorded from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      const nativeRecoveryClaim = input.nativeRecoveryClaim;
      if (nativeRecoveryClaim && (
        request.state !== "WRITE_UNCERTAIN" ||
        request.xeroObjectId !== undefined ||
        request.nativeRecoveryClaim !== undefined ||
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
        nativeRecoveryClaim.agentId !== request.authorizationReceipt.agentId ||
        new Date(nativeRecoveryClaim.claimedAt) > input.now ||
        new Date(nativeRecoveryClaim.expiresAt) <= input.now
      )) {
        throw new AppError("CONFLICT", "Native idempotency recovery was already claimed or is not uncertain.", {
          httpStatus: 409,
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
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'WRITE_UNCERTAIN',
           xero_object_id = COALESCE(xero_object_id, $2),
           write_receipt = COALESCE(write_receipt, $3::jsonb),
           native_recovery_claim = COALESCE(native_recovery_claim, $5::jsonb),
           write_unknown_at = COALESCE(write_unknown_at, $4),
           updated_at = $4
         WHERE mutation_request_id = $1
           AND ($5::jsonb IS NULL OR (state = 'WRITE_UNCERTAIN' AND xero_object_id IS NULL AND native_recovery_claim IS NULL))
         RETURNING *`,
        [
          input.mutationRequestId,
          input.xeroObjectId ?? null,
          input.writeReceipt ?? null,
          input.now,
          nativeRecoveryClaim ? nativeRecoveryClaim : null,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "Native idempotency recovery was already claimed concurrently.", {
          httpStatus: 409,
        });
      }
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "The exact Xero object is already bound to another active mutation.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markXeroMutationReadbackVerified(
    input: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (
        input.readbackPayloadHash !== request.canonicalPayloadHash ||
        input.readbackStatus !== expectedXeroMutationReadbackStatus(request.objectType, request.operation)
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
        await client.query("COMMIT");
        return request;
      }
      if (!["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
        throw new AppError("CONFLICT", `Mutation readback cannot complete from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'READBACK_VERIFIED', xero_object_id = $2,
           write_receipt = $3, readback_snapshot = $4, readback_snapshot_hash = $5,
           readback_canonical_payload = $6, readback_payload_hash = $7, readback_status = $8,
           readback_mismatch_receipt = NULL, verified_at = $9, updated_at = $9
         WHERE mutation_request_id = $1
         RETURNING *`,
        [
          input.mutationRequestId,
          input.xeroObjectId,
          input.writeReceipt,
          input.readbackSnapshot,
          input.readbackSnapshotHash,
          input.readbackCanonicalPayload,
          input.readbackPayloadHash,
          input.readbackStatus,
          input.now,
        ],
      );
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "The exact Xero object is already bound to another mutation.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markXeroMutationReadbackMismatch(
    input: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (
        input.readbackPayloadHash === request.canonicalPayloadHash &&
        input.readbackStatus === expectedXeroMutationReadbackStatus(request.objectType, request.operation)
      ) {
        throw new AppError("CONFLICT", "Matching readback cannot be recorded as a mismatch.", { httpStatus: 409 });
      }
      if (!request.xeroObjectId || !request.writeReceipt) {
        throw new AppError("CONFLICT", "Mutation write evidence must be persisted before readback completion.", {
          httpStatus: 409,
        });
      }
      if (!["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
        throw new AppError("CONFLICT", `Mutation mismatch cannot be recorded from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
      if (request.state === "READBACK_MISMATCH") {
        this.#assertExactMismatchEvidence(request, input);
        await client.query("COMMIT");
        return request;
      }
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'READBACK_MISMATCH', xero_object_id = $2,
           write_receipt = $3, readback_snapshot = $4, readback_snapshot_hash = $5,
           readback_canonical_payload = $6, readback_payload_hash = $7, readback_status = $8,
           readback_mismatch_receipt = $9::jsonb, verified_at = NULL, updated_at = $10
         WHERE mutation_request_id = $1
         RETURNING *`,
        [
          input.mutationRequestId,
          input.xeroObjectId,
          input.writeReceipt,
          input.readbackSnapshot,
          input.readbackSnapshotHash,
          input.readbackCanonicalPayload,
          input.readbackPayloadHash,
          input.readbackStatus,
          {
            receiptType: "XERO_READBACK_MISMATCH",
            mismatchType: "PAYLOAD_OR_STATUS",
            reasonCodes: [
              ...(input.readbackPayloadHash !== request.canonicalPayloadHash
                ? ["CANONICAL_PAYLOAD_HASH_MISMATCH"]
                : []),
              ...(input.readbackStatus !== expectedXeroMutationReadbackStatus(request.objectType, request.operation)
                ? ["READBACK_STATUS_MISMATCH"]
                : []),
            ],
          },
          input.now,
        ],
      );
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      if (isPostgresUniqueViolation(error)) {
        throw new AppError("CONFLICT", "The exact Xero object is already bound to another mutation.", {
          httpStatus: 409,
          cause: error,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async failXeroMutationValidation(input: FailXeroMutationValidationInput): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (request.state === "FAILED_VALIDATION") {
        if (!sameOptionalJson(request.validationReceipt, input.validationReceipt)) {
          throw new AppError("CONFLICT", "Validation failure evidence cannot be replaced.", { httpStatus: 409 });
        }
        await client.query("COMMIT");
        return request;
      }
      if (request.state !== "CONFIRMED") {
        throw new AppError("CONFLICT", `Mutation validation cannot fail from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'FAILED_VALIDATION', validation_receipt = $2,
           validation_failed_at = $3, updated_at = $3
         WHERE mutation_request_id = $1
         RETURNING *`,
        [input.mutationRequestId, input.validationReceipt ?? null, input.now],
      );
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectXeroMutationProvider(input: RejectXeroMutationProviderInput): Promise<XeroMutationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const request = await this.#selectBoundXeroMutationRequest(client, input, true);
      if (request.state === "PROVIDER_REJECTED") {
        if (!sameOptionalJson(request.providerRejectionReceipt, input.providerRejectionReceipt)) {
          throw new AppError("CONFLICT", "Provider rejection evidence cannot be replaced.", { httpStatus: 409 });
        }
        await client.query("COMMIT");
        return request;
      }
      if (request.state !== "WRITE_IN_FLIGHT") {
        throw new AppError("CONFLICT", `Provider rejection cannot be recorded from ${request.state}.`, {
          httpStatus: 409,
        });
      }
      const updated = await client.query(
        `UPDATE xero_mutation_requests SET
           state = 'PROVIDER_REJECTED', provider_rejection_receipt = $2,
           provider_rejected_at = $3, updated_at = $3
         WHERE mutation_request_id = $1
         RETURNING *`,
        [input.mutationRequestId, input.providerRejectionReceipt, input.now],
      );
      await client.query("COMMIT");
      return mapXeroMutationRequest(updated.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Bind-or-conflict in one statement. The upsert returns the row that now
   * holds the pairing, so a losing concurrent bind observes the winner's
   * tenant rather than overwriting it; the primary key is what actually
   * guarantees one upstream case cannot span two organisations.
   */
  async bindAccountingCaseSourceCase(
    input: BindAccountingCaseSourceCaseInput,
  ): Promise<BindAccountingCaseSourceCaseResult> {
    const result = await this.pool.query(
      `INSERT INTO accounting_case_source_case_bindings AS binding (
         workspace_id, source_system, source_case_ref_hash, tenant_id,
         first_bound_at, last_seen_at, case_count
       ) VALUES ($1, $2, $3, $4, $5, $5, 1)
       ON CONFLICT (workspace_id, source_system, source_case_ref_hash) DO UPDATE
         SET last_seen_at = CASE WHEN binding.tenant_id = EXCLUDED.tenant_id
                                 THEN EXCLUDED.last_seen_at ELSE binding.last_seen_at END,
             case_count = binding.case_count
               + CASE WHEN binding.tenant_id = EXCLUDED.tenant_id THEN 1 ELSE 0 END
       RETURNING tenant_id, case_count, (xmax = 0) AS inserted`,
      [
        input.workspaceId,
        input.sourceCase.system,
        input.sourceCase.caseRefHash,
        input.tenantId,
        input.now,
      ],
    );
    const row = result.rows[0] as { tenant_id: string; inserted: boolean } | undefined;
    if (!row) throw new AppError("PERSISTENCE_FAILURE", "The source-case binding did not return a row.");
    if (row.tenant_id !== input.tenantId) return { outcome: "TENANT_CONFLICT" };
    return { outcome: row.inserted ? "BOUND_FIRST_USE" : "BOUND_CONFIRMED" };
  }

  async createOrAdvanceAccountingCase(
    input: CreateOrAdvanceAccountingCaseInput,
  ): Promise<CreateOrAdvanceAccountingCaseResult> {
    assertAccountingCaseInput(input);
    if (input.continuationAuthorization && input.recoveryResidualAuthorization) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case continuation modes are mutually exclusive.", {
        httpStatus: 422,
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const grantRows = await client.query(
        `SELECT * FROM accounting_case_recovery_residual_grants
         WHERE successor_case_id = $1
         FOR UPDATE`,
        [input.compiled.caseId],
      );
      const reservedGrantRow = grantRows.rows[0] as Row | undefined;
      const recoveryAuthorization = input.recoveryResidualAuthorization;
      if (reservedGrantRow && !recoveryAuthorization) {
        throw new AppError("CONFLICT", "This recovery successor Case requires its server-issued continuation token.", {
          httpStatus: 409,
        });
      }
      let recoveryGrant: AccountingCaseRecoveryResidualGrant | undefined;
      if (recoveryAuthorization) {
        if (!reservedGrantRow) {
          throw new AppError("CONFLICT", "Accounting Case recovery successor authorization is invalid.", {
            httpStatus: 409,
          });
        }
        recoveryGrant = mapAccountingCaseRecoveryResidualGrant(reservedGrantRow);
        const clock = await client.query("SELECT statement_timestamp() AS repository_now");
        const repositoryNow = date((clock.rows[0] as Row).repository_now);
        if (
          recoveryGrant.grantId !== recoveryAuthorization.grantId ||
          recoveryGrant.sourceCaseId !== recoveryAuthorization.sourceCaseId ||
          recoveryGrant.sourceVersion !== recoveryAuthorization.sourceVersion ||
          recoveryGrant.successorCaseId !== recoveryAuthorization.successorCaseId ||
          recoveryGrant.templateHash !== recoveryAuthorization.templateHash ||
          recoveryGrant.successorCaseId !== input.compiled.caseId ||
          !sameAccountingCaseBinding(recoveryGrant.successorBinding, input.binding) ||
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
        await this.#assertAccountingCaseTargetActive(client, input.binding, repositoryNow);
      }
      const contactOperations = input.compiled.operations
        .filter((operation) => operation.actionId === "contact.create_basic")
        .sort((left, right) =>
          left.businessReservation.coordinateHash.localeCompare(right.businessReservation.coordinateHash));
      for (const operation of contactOperations) {
        const recovery = await client.query<{ abandoned_count: number }>(
          `SELECT abandon_expired_accounting_case_contact_reservation(
             $1, $2::jsonb, $3::jsonb, $4, $5, $6
           ) AS abandoned_count`,
          [
            input.binding.tenantId,
            operation.businessIdentity,
            operation.canonicalPayload,
            input.compiled.caseId,
            input.compiled.version,
            operation.operationId,
          ],
        );
        const abandonedCount = Number(recovery.rows[0]?.abandoned_count);
        if (!Number.isSafeInteger(abandonedCount) || abandonedCount < 0) {
          throw new AppError("PERSISTENCE_FAILURE", "Contact reservation recovery returned invalid evidence.", {
            httpStatus: 503,
          });
        }
      }
      const selectedHead = await client.query(
        `SELECT * FROM accounting_cases WHERE case_id = $1 FOR UPDATE`,
        [input.compiled.caseId],
      );
      const head = selectedHead.rows[0] as Row | undefined;
      if (head) {
        if (!sameAccountingCaseBinding(mapAccountingCaseBinding(head), input.binding)) {
          throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
        }
        await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
        const currentVersion = positiveSafeInteger(head.current_version, "Accounting Case current version");
        const currentRow = await this.#selectBoundAccountingCaseVersion(
          client,
          { binding: input.binding, caseId: input.compiled.caseId, version: currentVersion },
          true,
        );
        if (!currentRow) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case head is incomplete.", { httpStatus: 503 });
        }
        if (
          input.compiled.version === currentVersion &&
          input.compiledPlanHash === String(currentRow.compiled_plan_hash)
        ) {
          if (recoveryGrant && (
            recoveryGrant.state !== "CONSUMED" ||
            recoveryGrant.consumedPlanHash !== input.compiledPlanHash
          )) {
            throw new AppError("CONFLICT", "Accounting Case recovery successor grant was not consumed by this plan.", {
              httpStatus: 409,
            });
          }
          const current = await this.#hydrateAccountingCaseVersion(client, currentRow);
          if (stableStringify(current.compiled) !== stableStringify(input.compiled)) {
            throw new AppError("CONFLICT", "Accounting Case plan hash was reused for different compiled content.", {
              httpStatus: 409,
            });
          }
          if (input.compiled.version > 1) {
            const continuationRow = await this.#selectBoundAccountingCaseVersion(
              client,
              { binding: input.binding, caseId: input.compiled.caseId, version: input.compiled.version - 1 },
              false,
            );
            const continuationSource = continuationRow
              ? await this.#hydrateAccountingCaseVersion(client, continuationRow)
              : undefined;
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
          }
          await client.query("COMMIT");
          return { mode: "IDEMPOTENT_REPLAY", record: current };
        }
        if (input.compiled.version !== currentVersion + 1) {
          throw new AppError("CONFLICT", "Accounting Case version compare-and-swap failed.", {
            httpStatus: 409,
            details: { currentVersion },
          });
        }
        if (["PREFLIGHTED", "READY_TO_RESUME", "EXECUTING", "RECOVERY_REQUIRED"].includes(String(currentRow.version_state))) {
          throw new AppError("CONFLICT", "Accounting Case cannot advance while execution or recovery is active.", {
            httpStatus: 409,
          });
        }
        const current = await this.#hydrateAccountingCaseVersion(client, currentRow);
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
        // The upstream source case is Case identity, fixed by version 1 (the
        // Case head, already locked by the FOR UPDATE select above). A later
        // version citing a different one -- or newly citing/dropping one --
        // is an identity change, never a silent reinterpretation.
        if (!sameAccountingCaseSourceCaseReference(mapAccountingCaseSourceCase(head), input.sourceCase)) {
          throw new AppError("CONFLICT", "Accounting Case upstream source case cannot change across versions.", {
            httpStatus: 409,
            retryable: false,
            details: {
              failureLayer: "ACCOUNTING_CASE_SOURCE_CASE_BINDING",
              reasonCodes: ["SOURCE_CASE_CHANGED"],
              providerMutationPossible: false,
            },
          });
        }
        // Preserve the global row-lock -> coordinate-lock order used by
        // preflight/reseal. This Case head/version is already locked here.
        await this.#lockAccountingCaseNativeDocumentReservations(client, input);
        await this.#insertAccountingCaseVersion(client, input);
        const advanced = await client.query(
          `UPDATE accounting_cases SET current_version = $2, updated_at = $3
           WHERE case_id = $1 AND current_version = $4
             AND actor_id = $5 AND workspace_id = $6 AND subject_type = $7 AND subject_id = $8
             AND agent_id = $9 AND oauth_installation_id = $10 AND binding_id = $11
             AND binding_revision = $12 AND connection_id = $13 AND tenant_id = $14
             AND target_session_id = $15 AND target_session_hash = $16
             AND target_session_expires_at = $17
           RETURNING case_id`,
          [
            input.compiled.caseId,
            input.compiled.version,
            input.now,
            currentVersion,
            ...accountingCaseBindingValues(input.binding),
          ],
        );
        if (advanced.rowCount !== 1) {
          throw new AppError("CONFLICT", "Accounting Case version compare-and-swap failed.", { httpStatus: 409 });
        }
        const advancedRow = await this.#selectBoundAccountingCaseVersion(
          client,
          { binding: input.binding, caseId: input.compiled.caseId, version: input.compiled.version },
          false,
        );
        if (!advancedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case advance was not durable.");
        const record = await this.#hydrateAccountingCaseVersion(client, advancedRow);
        await client.query("COMMIT");
        return { mode: "ADVANCED", record };
      }

      if (input.compiled.version !== 1) {
        throw new AppError("CONFLICT", "A new Accounting Case must start at version 1.", { httpStatus: 409 });
      }
      if (recoveryGrant?.state === "CONSUMED") {
        throw new AppError("CONFLICT", "Accounting Case recovery successor grant is already consumed.", {
          httpStatus: 409,
        });
      }
      await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
      const insertedHead = await client.query(
        `INSERT INTO accounting_cases(
           case_id, provider_id, actor_id, workspace_id, subject_type, subject_id, agent_id,
           oauth_installation_id, binding_id, binding_revision, connection_id, tenant_id,
           target_session_id, target_session_hash, target_session_expires_at,
           source_case_system, source_case_ref_hash,
           current_version, created_at, updated_at
         ) VALUES ($1,'xero',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17,$17)
         ON CONFLICT (case_id) DO NOTHING
         RETURNING case_id`,
        [
          input.compiled.caseId,
          ...accountingCaseBindingValues(input.binding),
          // Case-head identity: fixed forever by whichever version first
          // prepares this case_id, exactly like its tenant.
          input.sourceCase?.system ?? null,
          input.sourceCase?.caseRefHash ?? null,
          input.now,
        ],
      );
      if (insertedHead.rowCount === 0) {
        // A concurrent creator committed the same identity after our initial
        // miss. Re-lock and accept only a byte-equivalent v1 plan as replay.
        const racedHead = await client.query(
          `SELECT * FROM accounting_cases WHERE case_id = $1 FOR UPDATE`,
          [input.compiled.caseId],
        );
        const concurrentHead = racedHead.rows[0] as Row | undefined;
        if (!concurrentHead || !sameAccountingCaseBinding(mapAccountingCaseBinding(concurrentHead), input.binding)) {
          throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
        }
        await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
        const racedRow = await this.#selectBoundAccountingCaseVersion(
          client,
          { binding: input.binding, caseId: input.compiled.caseId, version: 1 },
          true,
        );
        if (!racedRow) {
          throw new AppError("PERSISTENCE_FAILURE", "Concurrent Accounting Case creation was incomplete.", {
            httpStatus: 503,
          });
        }
        const concurrent = await this.#hydrateAccountingCaseVersion(client, racedRow);
        if (
          concurrent.compiledPlanHash !== input.compiledPlanHash ||
          stableStringify(concurrent.compiled) !== stableStringify(input.compiled)
        ) {
          throw new AppError("CONFLICT", "Accounting Case identity was concurrently created with another plan.", {
            httpStatus: 409,
          });
        }
        await client.query("COMMIT");
        return { mode: "IDEMPOTENT_REPLAY", record: concurrent };
      }
      // A new head is now owned by this transaction. Lock every native
      // coordinate in deterministic order before its PENDING rows are
      // inserted and judged by the final ALWAYS trigger.
      await this.#lockAccountingCaseNativeDocumentReservations(client, input);
      await this.#insertAccountingCaseVersion(client, input);
      if (recoveryGrant) {
        const consumed = await client.query(
          `UPDATE accounting_case_recovery_residual_grants SET
             state = 'CONSUMED', consumed_plan_hash = $2,
             consumed_at = statement_timestamp(), updated_at = statement_timestamp()
           WHERE grant_id = $1 AND state = 'ISSUED'
           RETURNING grant_id`,
          [recoveryGrant.grantId, input.compiledPlanHash],
        );
        if (consumed.rowCount !== 1) {
          throw new AppError("CONFLICT", "Accounting Case recovery successor grant consumption lost its compare-and-swap.", {
            httpStatus: 409,
          });
        }
      }
      const createdRow = await this.#selectBoundAccountingCaseVersion(
        client,
        { binding: input.binding, caseId: input.compiled.caseId, version: 1 },
        false,
      );
      if (!createdRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case creation was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, createdRow);
      await client.query("COMMIT");
      return { mode: "CREATED", record };
    } catch (error) {
      await this.#safeRollback(client);
      await this.#throwReservationHolderConflict(client, input, error);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  /**
   * A coordinate refusal that hides who holds the coordinate is a dead end:
   * the caller cannot resume the holding Case, cannot know when it frees, and
   * ends up guessing Case ids. The holder is always another Case on the same
   * tenant that this same binding could see through get_status, so naming it
   * and its release time reveals nothing new — it just makes the refusal
   * actionable. Runs after rollback on the same client.
   */
  async #throwReservationHolderConflict(
    client: PoolClient,
    input: CreateOrAdvanceAccountingCaseInput,
    error: unknown,
  ): Promise<void> {
    if (!isPostgresConstraintViolation(error)) return;
    if (String((error as { constraint?: unknown }).constraint) !== "accounting_case_active_business_reservation_overlap") {
      return;
    }
    const hashes = [...new Set(input.compiled.operations
      .map((operation) => operation.businessReservation.coordinateHash)
      .filter((hash): hash is string => typeof hash === "string" && hash.length > 0))];
    if (hashes.length === 0) return;
    let holder: { case_id: string; case_version: unknown; target_session_expires_at: unknown } | undefined;
    try {
      const rows = await client.query(
        `SELECT o.case_id, o.case_version, h.target_session_expires_at
           FROM accounting_case_operations o
           JOIN accounting_cases h
             ON h.case_id = o.case_id AND h.current_version = o.case_version
          WHERE o.tenant_id = $1
            AND o.business_reservation_coordinate_hash = ANY($2::text[])
            AND o.case_id <> $3
            AND o.state IN ('PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
                            'WRITE_UNCERTAIN', 'READBACK_MISMATCH', 'NOT_EXECUTED_AFTER_TARGET_EXPIRY')
          ORDER BY h.target_session_expires_at DESC NULLS LAST
          LIMIT 1`,
        [input.binding.tenantId, hashes, input.compiled.caseId],
      );
      holder = rows.rows[0] as typeof holder;
    } catch {
      return; // fall through to the plain conflict; never mask the original error
    }
    if (!holder) return;
    const expiresAt = holder.target_session_expires_at instanceof Date
      ? holder.target_session_expires_at.toISOString()
      : typeof holder.target_session_expires_at === "string"
      ? holder.target_session_expires_at
      : undefined;
    throw new AppError(
      "CONFLICT",
      "This tenant already has an active Accounting Case claim for the provider business coordinate.",
      {
        httpStatus: 409,
        details: {
          reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
          providerMutationPossible: false,
          holdingCaseId: holder.case_id,
          ...(Number.isSafeInteger(Number(holder.case_version)) ? { holdingCaseVersion: Number(holder.case_version) } : {}),
          ...(expiresAt ? { holdReleasesAt: expiresAt } : {}),
          recoveryAction: "GET_CURRENT_CASE_STATUS",
        },
        cause: error,
      },
    );
  }

  async findVerifiedAccountingCaseContactIdentity(
    input: FindVerifiedAccountingCaseContactIdentityInput,
  ): Promise<{ contactId: string } | undefined> {
    const selected = await this.pool.query(
      `SELECT DISTINCT xero_object_id
       FROM accounting_case_operations
       WHERE tenant_id = $1
         AND action_id = 'contact.create_basic'
         AND business_identity_hash = $2
         AND state = 'READBACK_VERIFIED'
         AND xero_object_id IS NOT NULL
       LIMIT 2`,
      [input.tenantId, input.businessIdentityHash],
    );
    if (selected.rows.length > 1) {
      throw new AppError("PERSISTENCE_FAILURE", "A durable contact identity maps to multiple provider contacts.", {
        httpStatus: 503,
      });
    }
    const row = selected.rows[0] as Row | undefined;
    return row ? { contactId: String(row.xero_object_id) } : undefined;
  }

  async listVerifiedAccountingCaseContactIdentityHashes(
    input: ListVerifiedAccountingCaseContactIdentitiesInput,
  ): Promise<string[]> {
    const selected = await this.pool.query(
      `SELECT DISTINCT business_identity_hash
       FROM accounting_case_operations
       WHERE tenant_id = $1
         AND action_id = 'contact.create_basic'
         AND business_identity ->> 'kind' IN (
           'LEGAL_REGISTRY_CONTACT', 'PROVIDER_TENANT_CONTACT_ACCOUNT'
         )
         AND state = 'READBACK_VERIFIED'
         AND xero_object_id = $2
       ORDER BY business_identity_hash ASC`,
      [input.tenantId, input.contactId],
    );
    return selected.rows.map((row) => String((row as Row).business_identity_hash));
  }

  async getBoundAccountingCase(input: GetBoundAccountingCaseInput): Promise<AccountingCaseVersionRecord | undefined> {
    const client = await this.pool.connect();
    try {
      const selected = await this.#selectBoundAccountingCaseVersion(client, input, false);
      return selected ? await this.#hydrateAccountingCaseVersion(client, selected) : undefined;
    } finally {
      client.release();
    }
  }

  async getAccessibleAccountingCase(
    input: GetAccessibleAccountingCaseInput,
  ): Promise<AccountingCaseVersionRecord | undefined> {
    if (!isValidDate(input.now)) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.#assertAccountingCaseTargetActive(client, input.currentAccessBinding, input.now);
      const selected = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        ...(input.version ? { version: input.version } : {}),
      }, false);
      if (!selected) {
        await client.query("COMMIT");
        return undefined;
      }
      const record = await this.#hydrateAccountingCaseVersion(client, selected);
      if (input.mode === "RECOVERY_GET_ONLY" &&
          !["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
        await client.query("COMMIT");
        return undefined;
      }
      const grantRows = await client.query(
        `SELECT * FROM accounting_case_recovery_residual_grants
         WHERE source_case_id = $1 AND source_case_version = $2
           AND actor_id = $3 AND workspace_id = $4
           AND subject_type = $5 AND subject_id = $6 AND agent_id = $7
           AND oauth_installation_id = $8 AND binding_id = $9 AND binding_revision = $10
           AND connection_id = $11 AND tenant_id = $12
           AND target_session_id = $13 AND target_session_hash = $14
           AND target_session_expires_at = $15`,
        [
          input.caseId,
          record.compiled.version,
          ...accountingCaseBindingValues(input.currentAccessBinding),
        ],
      );
      const grantRow = grantRows.rows[0] as Row | undefined;
      const projected = grantRow
        ? { ...record, recoveryResidualGrant: mapAccountingCaseRecoveryResidualGrant(grantRow) }
        : record;
      await client.query("COMMIT");
      return projected;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async listAttentionAccountingCases(
    input: ListAttentionAccountingCasesInput,
  ): Promise<ListAttentionAccountingCasesResult> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case attention list limit is invalid.", {
        httpStatus: 422,
      });
    }
    const attentionStates = [...ACCOUNTING_CASE_ATTENTION_OPERATION_STATES];
    // Same durable access identity as getAccessibleAccountingCase (target-session
    // evidence intentionally excluded): a caller only ever sees its own
    // workspace/agent/tenant binding's cases, never another binding or tenant's.
    const selected = await this.pool.query(
      `SELECT case_head.case_id, case_head.current_version AS case_version, version_row.state AS version_state
         FROM accounting_cases case_head
         JOIN accounting_case_versions version_row
           ON version_row.case_id = case_head.case_id
          AND version_row.version = case_head.current_version
        WHERE case_head.actor_id = $1 AND case_head.workspace_id = $2 AND case_head.subject_type = $3
          AND case_head.subject_id = $4 AND case_head.agent_id = $5 AND case_head.oauth_installation_id = $6
          AND case_head.binding_id = $7 AND case_head.binding_revision = $8 AND case_head.connection_id = $9
          AND case_head.tenant_id = $10
          AND (
            version_row.state = 'RECOVERY_REQUIRED'
            OR EXISTS (
              SELECT 1 FROM accounting_case_operations attention_op
               WHERE attention_op.case_id = case_head.case_id
                 AND attention_op.case_version = case_head.current_version
                 AND attention_op.state = ANY($11::text[])
            )
          )
        ORDER BY version_row.updated_at DESC
        LIMIT $12`,
      [
        ...accountingCaseAccessIdentityValues(input.currentAccessBinding),
        attentionStates,
        input.limit + 1,
      ],
    );
    const rows = selected.rows as Row[];
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    if (page.length === 0) return { cases: [], hasMore: false };
    const caseIds = page.map((row) => String(row.case_id));
    const caseVersions = page.map((row) => positiveSafeInteger(row.case_version, "Accounting Case version"));
    const operationRows = await this.pool.query(
      // Pairs case_id[i] with case_version[i] in lockstep so an operation from
      // one case's OTHER (non-current, historical) version can never be
      // attributed to a different case that happens to share that version number.
      `SELECT op.case_id, op.operation_id, op.state, op.xero_object_id
         FROM accounting_case_operations op
         JOIN unnest($1::text[], $2::bigint[]) AS wanted(case_id, case_version)
           ON wanted.case_id = op.case_id AND wanted.case_version = op.case_version
        WHERE op.state = ANY($3::text[])
        ORDER BY op.case_id, op.ordinal ASC`,
      [caseIds, caseVersions, attentionStates],
    );
    const operationsByCaseId = new Map<string, Array<{
      operationId: string;
      state: AccountingCaseOperationState;
      xeroObjectId?: string;
    }>>();
    for (const row of operationRows.rows as Row[]) {
      const caseId = String(row.case_id);
      const list = operationsByCaseId.get(caseId) ?? [];
      list.push({
        operationId: String(row.operation_id),
        state: row.state as AccountingCaseOperationState,
        ...(row.xero_object_id ? { xeroObjectId: String(row.xero_object_id) } : {}),
      });
      operationsByCaseId.set(caseId, list);
    }
    return {
      cases: page.map((row) => ({
        caseId: String(row.case_id),
        caseVersion: positiveSafeInteger(row.case_version, "Accounting Case version"),
        state: row.version_state as AccountingCaseVersionRecord["state"],
        operations: operationsByCaseId.get(String(row.case_id)) ?? [],
      })),
      hasMore,
    };
  }

  async recordAccountingCasePreflight(
    input: RecordAccountingCasePreflightInput,
  ): Promise<RecordAccountingCasePreflightResult> {
    if (
      !isValidDate(input.now) ||
      !isNonEmpty(input.requestId) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedPlanHash) ||
      !/^[0-9a-f]{64}$/u.test(input.preflightReceiptHash) ||
      Object.keys(input.preflightReceipt).length === 0 ||
      input.preflightReceiptHash !== accountingCasePreflightReceiptHash({
        binding: input.binding,
        caseId: input.caseId,
        version: input.version,
        compiledPlanHash: input.expectedPlanHash,
        requestId: input.requestId,
        preflightReceipt: input.preflightReceipt,
      })
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case preflight receipt is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (positiveSafeInteger(selected.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can be preflighted.", {
          httpStatus: 409,
        });
      }
      if (String(selected.compiled_plan_hash) !== input.expectedPlanHash) {
        throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
      }
      await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);

      // Lock the complete operation set in deterministic ordinal order after
      // the Case/version lock, keeping the transaction short and deadlock-safe.
      const locked = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2
         ORDER BY ordinal ASC
         FOR UPDATE`,
        [input.caseId, input.version],
      );
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      const durableOperations = locked.rows.map((row) => mapAccountingCaseOperation(row as Row));
      if (input.operations.length !== durableOperations.length) {
        throw new AppError("CONFLICT", "Accounting Case preflight operation set is incomplete.", { httpStatus: 409 });
      }
      const byId = new Map(input.operations.map((operation) => [operation.operationId, operation]));
      if (
        byId.size !== input.operations.length ||
        durableOperations.some((operation) => !byId.has(operation.operation.operationId))
      ) {
        throw new AppError("CONFLICT", "Accounting Case preflight operation set does not match the durable plan.", {
          httpStatus: 409,
        });
      }
      if (!Array.isArray(input.preflightReceipt.operations) ||
          input.preflightReceipt.operations.length !== durableOperations.length ||
          durableOperations.some((operation) =>
            !preflightReceiptOperationMatches(
              input.preflightReceipt,
              operation,
              byId.get(operation.operation.operationId)!,
            ))) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case preflight receipt operation evidence is invalid.", {
          httpStatus: 422,
        });
      }
      if (current.preflightRequestId || current.preflightReceipt || current.preflightReceiptHash || current.preflightedAt) {
        const operationEvidenceMatches = durableOperations.every((operation) => {
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
          current.preflightRequestId === input.requestId &&
          current.preflightReceiptHash === input.preflightReceiptHash &&
          current.preflightReceipt && sameJson(current.preflightReceipt, input.preflightReceipt) &&
          operationEvidenceMatches
        ) {
          await client.query("COMMIT");
          return { mode: "IDEMPOTENT_REPLAY", record: current };
        }
        throw new AppError("CONFLICT", "Accounting Case already has a different preflight receipt.", {
          httpStatus: 409,
        });
      }
      if (!["PLANNED_NEEDS_PREFLIGHT", "PLANNED_WITH_EXCEPTIONS"].includes(current.state)) {
        throw new AppError("CONFLICT", `Accounting Case cannot be preflighted from ${current.state}.`, {
          httpStatus: 409,
        });
      }
      const preparationIds = new Set<string>();
      const noWriteObjects = new Set<string>();
      for (const operation of durableOperations) {
        if (operation.state !== "PENDING") {
          throw new AppError("CONFLICT", "Accounting Case preflight requires every operation to remain pending.", {
            httpStatus: 409,
          });
        }
        const preflight = byId.get(operation.operation.operationId)!;
        if (preflight.state === "PREPARED") {
          const selectedPreparation = await client.query(
            "SELECT * FROM xero_mutation_preparations WHERE preparation_id = $1 FOR UPDATE",
            [preflight.preparationId],
          );
          const preparationRow = selectedPreparation.rows[0] as Row | undefined;
          const preparation = preparationRow ? mapXeroMutationPreparation(preparationRow) : undefined;
          const route = accountingCaseMutationRoute(operation.operation);
          if (
            !isNonEmpty(preflight.preparationId) || preparationIds.has(preflight.preparationId) ||
            !/^[0-9a-f]{64}$/u.test(preflight.operationCanonicalPayloadHash) ||
            !/^[0-9a-f]{64}$/u.test(preflight.preparationCanonicalPayloadHash) ||
            !/^[0-9a-f]{64}$/u.test(preflight.sourceSha256) ||
            preflight.operationCanonicalPayloadHash !== operation.operation.canonicalPayloadHash ||
            !preparation || preparation.state !== "PREPARED" || preparation.expiresAt <= input.now ||
            preparation.actorId !== current.binding.actorId ||
            preparation.workspaceId !== current.binding.workspaceId ||
            preparation.tenantId !== current.binding.tenantId ||
            preparation.installationId !== current.binding.installationId ||
            preparation.bindingId !== current.binding.bindingId ||
            preparation.bindingRevision !== current.binding.bindingRevision ||
            preparation.connectionId !== current.binding.connectionId ||
            preparation.targetSessionId !== current.binding.targetSessionId ||
            preparation.objectType !== route.objectType || preparation.operation !== route.operation ||
            preparation.sourceRef !== `case:${current.compiled.caseId}` ||
            preparation.sourceUnitKey !== operation.operation.operationId ||
            preparation.sourceSha256 !== preflight.sourceSha256 ||
            preparation.canonicalPayloadHash !== preflight.preparationCanonicalPayloadHash ||
            preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload)
          ) {
            throw new AppError("VALIDATION_FAILED", "Accounting Case preflight preparation identity is invalid.", {
              httpStatus: 422,
            });
          }
          preparationIds.add(preflight.preparationId);
          const updated = await client.query(
            `UPDATE accounting_case_operations SET
               state = 'PREPARED', preparation_id = $4, original_preparation_id = $4,
               preparation_canonical_payload_hash = $5,
               operation_source_sha256 = $6, updated_at = $7
             WHERE case_id = $1 AND case_version = $2 AND operation_id = $3 AND state = 'PENDING'
             RETURNING operation_id`,
            [
              input.caseId,
              input.version,
              preflight.operationId,
              preflight.preparationId,
              preflight.preparationCanonicalPayloadHash,
              preflight.sourceSha256,
              input.now,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new AppError("CONFLICT", "Accounting Case preflight operation compare-and-swap failed.", {
              httpStatus: 409,
            });
          }
          continue;
        }
        if (!isNonEmpty(preflight.xeroObjectId) || Object.keys(preflight.readbackSnapshot).length === 0 ||
            !accountingCaseNoWriteEvidenceMatches(operation.operation, preflight.xeroObjectId, preflight.readbackSnapshot)) {
          throw new AppError("VALIDATION_FAILED", "Accounting Case no-write preflight evidence is invalid.", {
            httpStatus: 422,
          });
        }
        const objectKey = `${operation.operation.actionId}:${preflight.xeroObjectId}`;
        if (noWriteObjects.has(objectKey)) {
          throw new AppError("CONFLICT", "Accounting Case preflight reuses one Xero object for multiple operations.", {
            httpStatus: 409,
          });
        }
        noWriteObjects.add(objectKey);
        const updated = await client.query(
          `UPDATE accounting_case_operations SET
             state = 'NO_WRITE_REQUIRED', xero_object_id = $4,
             readback_snapshot = $5::jsonb, updated_at = $6
           WHERE case_id = $1 AND case_version = $2 AND operation_id = $3 AND state = 'PENDING'
           RETURNING operation_id`,
          [
            input.caseId,
            input.version,
            preflight.operationId,
            preflight.xeroObjectId,
            preflight.readbackSnapshot,
            input.now,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new AppError("CONFLICT", "Accounting Case preflight operation compare-and-swap failed.", {
            httpStatus: 409,
          });
        }
      }
      const preflighted = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'PREFLIGHTED', preflight_request_id = $3,
           preflight_receipt = $4::jsonb, preflight_receipt_hash = $5,
           preflighted_at = $6,
           original_preflight_receipt_hash = $5,
           effective_preflight_seal_hash = $5,
           effective_preflight_sealed_at = $6,
           preflight_reseal_revision = 0,
           updated_at = $6
         WHERE case_id = $1 AND version = $2
           AND state = $7 AND compiled_plan_hash = $8
           AND preflight_request_id IS NULL AND preflight_receipt IS NULL
           AND preflight_receipt_hash IS NULL AND preflighted_at IS NULL
         RETURNING case_id`,
        [
          input.caseId,
          input.version,
          input.requestId,
          input.preflightReceipt,
          input.preflightReceiptHash,
          input.now,
          current.state,
          input.expectedPlanHash,
        ],
      );
      if (preflighted.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case preflight compare-and-swap failed.", { httpStatus: 409 });
      }
      const preflightedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!preflightedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, preflightedRow);
      await client.query("COMMIT");
      return { mode: "PREFLIGHTED", record };
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async claimAccountingCaseExecution(
    input: ClaimAccountingCaseExecutionInput,
  ): Promise<ClaimAccountingCaseExecutionResult> {
    if (
      !isValidDate(input.now) ||
      (input.minimumPreparationExpiresAt !== undefined &&
        (!isValidDate(input.minimumPreparationExpiresAt) ||
          input.minimumPreparationExpiresAt.getTime() <
            input.now.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS)) ||
      !isNonEmpty(input.requestId) ||
      !/^[0-9a-f]{64}$/u.test(input.expectedPlanHash)
    ) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case execution claim is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
      const selected = recoveryAccess
        ? await this.#selectAccessibleAccountingCaseVersion(client, {
            currentAccessBinding: input.binding,
            caseId: input.caseId,
            version: input.version,
          }, true)
        : await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      const currentVersion = positiveSafeInteger(selected.current_version, "Accounting Case current version");
      if (currentVersion !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can execute.", {
          httpStatus: 409,
          details: { currentVersion },
        });
      }
      if (String(selected.compiled_plan_hash) !== input.expectedPlanHash) {
        throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
      }
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (recoveryAccess) {
        await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
        if (!["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(current.state)) {
          throw new AppError("NOT_FOUND", "Accounting Case was not found for recovery access.", { httpStatus: 404 });
        }
        if (current.executionRequestId !== input.requestId) {
          throw new AppError("CONFLICT", "Accounting Case recovery does not own the original execution claim.", {
            httpStatus: 409,
          });
        }
        await client.query("COMMIT");
        return {
          mode: ["PARTIALLY_COMMITTED", "TERMINAL"].includes(current.state)
            ? "ALREADY_TERMINAL"
            : "RECOVERY_GET_ONLY",
          record: current,
        };
      }
      if (current.executionRequestId) {
        if (current.executionRequestId !== input.requestId) {
          throw new AppError("CONFLICT", "Accounting Case is already claimed by another execution request.", {
            httpStatus: 409,
          });
        }
        if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(current.state)) {
          await client.query("COMMIT");
          return { mode: "ALREADY_TERMINAL", record: current };
        }
        await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
        if (["EXECUTING", "RECOVERY_REQUIRED"].includes(current.state)) {
          await client.query("COMMIT");
          return { mode: "RESUME", record: current };
        }
        throw new AppError("CONFLICT", `Accounting Case cannot resume from ${current.state}.`, { httpStatus: 409 });
      }
      await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
      if (current.state !== "PREFLIGHTED" && current.state !== "READY_TO_RESUME") {
        throw new AppError("VALIDATION_FAILED", `Accounting Case cannot execute from ${current.state}.`, {
          httpStatus: 422,
        });
      }
      if (current.state === "PREFLIGHTED" && current.preflightRequestId !== input.requestId) {
        throw new AppError("VALIDATION_FAILED", "The first execution request must own the durable preflight.", {
          httpStatus: 422,
        });
      }
      if (input.minimumPreparationExpiresAt) {
        for (const operation of current.operations.filter((candidate) => candidate.state === "PREPARED")) {
          if (!operation.preparationId) {
            throw new AppError("STALE_PREFLIGHT", "Accounting Case preparation must be resealed before execution.", {
              httpStatus: 409,
              retryable: true,
              details: { operationId: operation.operation.operationId },
            });
          }
          const selectedPreparation = await client.query(
            "SELECT * FROM xero_mutation_preparations WHERE preparation_id = $1 FOR UPDATE",
            [operation.preparationId],
          );
          const preparationRow = selectedPreparation.rows[0] as Row | undefined;
          const preparation = preparationRow ? mapXeroMutationPreparation(preparationRow) : undefined;
          const existingRequest = await client.query(
            "SELECT mutation_request_id FROM xero_mutation_requests WHERE preparation_id = $1 LIMIT 1",
            [operation.preparationId],
          );
          if (existingRequest.rowCount) {
            throw new AppError("CONFLICT", "Accounting Case preparation already has a mutation request.", {
              httpStatus: 409,
              details: { operationId: operation.operation.operationId },
            });
          }
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
      const claimed = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'EXECUTING', execution_request_id = $3,
           execution_started_at = $4, updated_at = $4
         WHERE case_id = $1 AND version = $2
           AND state = $5 AND compiled_plan_hash = $6
           AND execution_request_id IS NULL
           AND ($5 = 'READY_TO_RESUME' OR preflight_request_id = $3)
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, input.now, current.state, input.expectedPlanHash],
      );
      if (claimed.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case execution compare-and-swap failed.", { httpStatus: 409 });
      }
      const claimedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!claimedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case claim was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, claimedRow);
      await client.query("COMMIT");
      return { mode: "CLAIMED", record };
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const clock = await client.query("SELECT statement_timestamp() AS repository_now");
      const repositoryNow = date((clock.rows[0] as Row).repository_now);
      await this.#assertAccountingCaseTargetActive(client, input.currentAccessBinding, repositoryNow);

      // Lock Case/head first. Every competing Case projection follows this
      // boundary, so an old worker and recovery adopter cannot both project
      // the same still-PREPARED operation.
      const selected = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (positiveSafeInteger(selected.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can be adopted.", {
          httpStatus: 409,
        });
      }
      if (String(selected.compiled_plan_hash) !== input.expectedPlanHash) {
        throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
      }
      if (
        String(selected.version_state) !== "EXECUTING" ||
        String(selected.execution_request_id ?? "") !== input.requestId
      ) {
        throw new AppError("CONFLICT", "Accounting Case recovery adoption does not own the executing Case.", {
          httpStatus: 409,
        });
      }
      const originalBinding = mapAccountingCaseBinding(selected);
      if (originalBinding.targetSessionHash === input.currentAccessBinding.targetSessionHash) {
        throw new AppError("CONFLICT", "Recovery adoption requires a new live target session.", {
          httpStatus: 409,
        });
      }
      const selectedOriginalTarget = await client.query(
        "SELECT * FROM ledger_target_sessions WHERE session_hash = $1 FOR UPDATE",
        [originalBinding.targetSessionHash],
      );
      const originalTargetRow = selectedOriginalTarget.rows[0] as Row | undefined;
      const originalTarget = originalTargetRow ? mapLedgerTargetSession(originalTargetRow) : undefined;
      if (
        originalBinding.targetSessionExpiresAt > repositoryNow ||
        (originalTarget !== undefined && (
          originalTarget.sessionId !== originalBinding.targetSessionId ||
          originalTarget.installationId !== originalBinding.installationId ||
          originalTarget.bindingId !== originalBinding.bindingId ||
          originalTarget.bindingRevision !== originalBinding.bindingRevision ||
          originalTarget.connectionId !== originalBinding.connectionId ||
          originalTarget.expiresAt.getTime() !== originalBinding.targetSessionExpiresAt.getTime() ||
          originalTarget.expiresAt > repositoryNow
        ))
      ) {
        throw new AppError("CONFLICT", "The original Accounting Case target lease is not durably expired.", {
          httpStatus: 409,
        });
      }

      // Fixed lock order: Case/version -> all operations by ordinal -> all
      // preparations by id -> all mutation requests by id.
      const lockedOperations = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2
         ORDER BY ordinal ASC
         FOR UPDATE`,
        [input.caseId, input.version],
      );
      const operations = lockedOperations.rows.map((row) => mapAccountingCaseOperation(row as Row));
      const preparationIds = [...new Set(operations.flatMap((operation) =>
        operation.preparationId ? [operation.preparationId] : []))].sort();
      const lockedPreparations = preparationIds.length > 0
        ? await client.query(
            `SELECT * FROM xero_mutation_preparations
             WHERE preparation_id = ANY($1::text[])
             ORDER BY preparation_id ASC
             FOR UPDATE`,
            [preparationIds],
          )
        : { rows: [] as Row[] };
      const preparations = new Map(lockedPreparations.rows.map((row) => {
        const preparation = mapXeroMutationPreparation(row as Row);
        return [preparation.preparationId, preparation] as const;
      }));
      const lockedRequests = preparationIds.length > 0
        ? await client.query(
            `SELECT * FROM xero_mutation_requests
             WHERE preparation_id = ANY($1::text[])
             ORDER BY mutation_request_id ASC
             FOR UPDATE`,
            [preparationIds],
          )
        : { rows: [] as Row[] };
      const requestsByPreparation = new Map<string, XeroMutationRequest[]>();
      for (const row of lockedRequests.rows) {
        const request = mapXeroMutationRequest(row as Row);
        const existing = requestsByPreparation.get(request.preparationId) ?? [];
        existing.push(request);
        requestsByPreparation.set(request.preparationId, existing);
      }

      const projections: Array<{
        operation: AccountingCaseOperationRecord;
        request: XeroMutationRequest;
        state: "WRITE_IN_FLIGHT" | "WRITE_UNCERTAIN" | "READBACK_MISMATCH";
        errorReceipt?: Record<string, unknown>;
      }> = [];
      for (const operation of operations) {
        if (operation.state !== "PREPARED" || !operation.preparationId) continue;
        const requests = requestsByPreparation.get(operation.preparationId) ?? [];
        if (requests.length === 0) continue;
        if (requests.length !== 1) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preparation has ambiguous mutation requests.", {
            httpStatus: 503,
          });
        }
        const request = requests[0]!;
        const preparation = preparations.get(operation.preparationId);
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
          request.actorId !== originalBinding.actorId ||
          request.workspaceId !== originalBinding.workspaceId ||
          request.tenantId !== originalBinding.tenantId ||
          request.installationId !== originalBinding.installationId ||
          request.bindingId !== originalBinding.bindingId ||
          request.bindingRevision !== originalBinding.bindingRevision ||
          request.connectionId !== originalBinding.connectionId ||
          request.targetSessionId !== originalBinding.targetSessionId ||
          request.objectType !== route.objectType || request.operation !== route.operation ||
          request.sourceRef !== `case:${input.caseId}` ||
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
        projections.push({
          operation,
          request,
          state: projectedState as "WRITE_IN_FLIGHT" | "WRITE_UNCERTAIN" | "READBACK_MISMATCH",
          ...(errorReceipt ? { errorReceipt } : {}),
        });
      }
      if (projections.length === 0) {
        throw new AppError(
          "CONFLICT",
          "No PREPARED Accounting Case operation has a durable potentially-written mutation request.",
          {
            httpStatus: 409,
            details: { reasonCodes: ["NO_POTENTIALLY_WRITTEN_MUTATION_REQUEST"] },
          },
        );
      }

      for (const projection of projections) {
        const updated = await client.query(
          `UPDATE accounting_case_operations SET
             state = $4, mutation_request_id = $5,
             xero_object_id = $6, write_receipt = $7::jsonb,
             readback_snapshot = $8::jsonb, error_receipt = $9::jsonb,
             updated_at = $10
           WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
             AND state = 'PREPARED' AND preparation_id = $11
           RETURNING operation_id`,
          [
            input.caseId,
            input.version,
            projection.operation.operation.operationId,
            projection.state,
            projection.request.mutationRequestId,
            projection.request.xeroObjectId ?? null,
            projection.request.writeReceipt ?? null,
            projection.request.readbackSnapshot ?? null,
            projection.errorReceipt ?? null,
            repositoryNow,
            projection.request.preparationId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new AppError("CONFLICT", "Accounting Case recovery projection compare-and-swap failed.", {
            httpStatus: 409,
          });
        }
      }
      const adopted = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'RECOVERY_REQUIRED',
           terminal_summary = accounting_case_terminal_state_projection(case_id, version, 'RECOVERY_REQUIRED'),
           updated_at = $4
         WHERE case_id = $1 AND version = $2
           AND state = 'EXECUTING' AND execution_request_id = $3
           AND compiled_plan_hash = $5
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, repositoryNow, input.expectedPlanHash],
      );
      if (adopted.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case recovery adoption compare-and-swap failed.", {
          httpStatus: 409,
        });
      }
      const adoptedRow = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, false);
      if (!adoptedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case recovery adoption was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, adoptedRow);
      await client.query("COMMIT");
      return { mode: "ADOPTED", record };
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async resealAndClaimAccountingCaseExecution(
    input: ResealAndClaimAccountingCaseExecutionInput,
  ): Promise<ResealAndClaimAccountingCaseExecutionResult> {
    const receiptAuthority = input.resealReceipt.authorityReceipt as unknown;
    const nextRevision = input.expectedResealRevision + 1;
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
      !Number.isSafeInteger(input.expectedResealRevision) || input.expectedResealRevision < 0 ||
      input.operations.length === 0 ||
      typeof receiptAuthority !== "object" || receiptAuthority === null || Array.isArray(receiptAuthority) ||
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      const currentVersion = positiveSafeInteger(selected.current_version, "Accounting Case current version");
      if (currentVersion !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can be resealed.", {
          httpStatus: 409,
          details: { currentVersion },
        });
      }
      if (String(selected.compiled_plan_hash) !== input.expectedPlanHash) {
        throw new AppError("CONFLICT", "Accounting Case plan hash is stale.", { httpStatus: 409 });
      }
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (current.executionRequestId) {
        if (current.executionRequestId !== input.requestId) {
          throw new AppError("CONFLICT", "Accounting Case is already claimed by another execution request.", {
            httpStatus: 409,
          });
        }
        if (["PARTIALLY_COMMITTED", "TERMINAL"].includes(current.state)) {
          await client.query("COMMIT");
          return { mode: "ALREADY_TERMINAL", record: current };
        }
        if (["EXECUTING", "RECOVERY_REQUIRED"].includes(current.state)) {
          await client.query("COMMIT");
          return { mode: "RESUME", record: current };
        }
        throw new AppError("CONFLICT", `Accounting Case cannot resume from ${current.state}.`, { httpStatus: 409 });
      }
      await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
      if (current.state !== "PREFLIGHTED" && current.state !== "READY_TO_RESUME") {
        throw new AppError("CONFLICT", `Accounting Case cannot be resealed from ${current.state}.`, {
          httpStatus: 409,
        });
      }
      if (current.state === "PREFLIGHTED" && current.preflightRequestId !== input.requestId) {
        throw new AppError("VALIDATION_FAILED", "The first execution request must own the durable preflight.", {
          httpStatus: 422,
        });
      }
      if (
        current.originalPreflightReceiptHash !== input.expectedOriginalPreflightReceiptHash ||
        current.effectivePreflightSealHash !== input.expectedEffectiveSealHash ||
        current.preflightResealRevision !== input.expectedResealRevision
      ) {
        throw new AppError("CONFLICT", "Accounting Case effective preflight seal is stale.", { httpStatus: 409 });
      }

      const lockedOperations = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2
         ORDER BY ordinal ASC
         FOR UPDATE`,
        [input.caseId, input.version],
      );
      const durableOperations = lockedOperations.rows.map((row) => mapAccountingCaseOperation(row as Row));
      const remaining = durableOperations.filter((operation) => operation.state === "PREPARED");
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

      const allPreparationIds = [...new Set(input.operations.flatMap((operation) => [
        operation.oldPreparationId,
        operation.newPreparationId,
      ]))].sort();
      const lockedPreparations = await client.query(
        `SELECT * FROM xero_mutation_preparations
         WHERE preparation_id = ANY($1::text[])
         ORDER BY preparation_id ASC
         FOR UPDATE`,
        [allPreparationIds],
      );
      const preparations = new Map(lockedPreparations.rows.map((row) => {
        const preparation = mapXeroMutationPreparation(row as Row);
        return [preparation.preparationId, preparation] as const;
      }));
      const requestedOldPreparations = await client.query(
        `SELECT DISTINCT preparation_id
         FROM xero_mutation_requests
         WHERE preparation_id = ANY($1::text[])`,
        [input.operations.map((operation) => operation.oldPreparationId)],
      );
      const oldPreparationsWithRequest = new Set(
        requestedOldPreparations.rows.map((row) => String((row as Row).preparation_id)),
      );
      const sealedReplacements = await client.query(
        `SELECT preparation_id, original_preparation_id
         FROM accounting_case_operations
         WHERE preparation_id = ANY($1::text[])
            OR original_preparation_id = ANY($1::text[])`,
        [input.operations.map((operation) => operation.newPreparationId)],
      );
      if (sealedReplacements.rowCount) {
        throw new AppError("CONFLICT", "Accounting Case reseal replacement is already sealed.", { httpStatus: 409 });
      }

      const replacementIds = new Set<string>();
      let hasStalePreparation = false;
      for (const operation of remaining) {
        const reseal = byId.get(operation.operation.operationId)!;
        const oldPreparation = preparations.get(reseal.oldPreparationId);
        const newPreparation = preparations.get(reseal.newPreparationId);
        const route = accountingCaseMutationRoute(operation.operation);
        const replacementExpiry = new Date(reseal.newPreparationExpiresAt);
        if (
          !isNonEmpty(reseal.oldPreparationId) || !isNonEmpty(reseal.newPreparationId) ||
          reseal.oldPreparationId === reseal.newPreparationId ||
          replacementIds.has(reseal.newPreparationId) ||
          !/^[0-9a-f]{64}$/u.test(reseal.operationCanonicalPayloadHash) ||
          !/^[0-9a-f]{64}$/u.test(reseal.preparationCanonicalPayloadHash) ||
          !/^[0-9a-f]{64}$/u.test(reseal.sourceSha256) ||
          !isValidDate(replacementExpiry) || replacementExpiry.toISOString() !== reseal.newPreparationExpiresAt ||
          operation.mutationRequestId !== undefined ||
          operation.preparationId !== reseal.oldPreparationId ||
          reseal.operationCanonicalPayloadHash !== operation.operation.canonicalPayloadHash ||
          reseal.preparationCanonicalPayloadHash !== operation.preparationCanonicalPayloadHash ||
          reseal.sourceSha256 !== operation.sourceSha256 ||
          oldPreparationsWithRequest.has(reseal.oldPreparationId) ||
          !oldPreparation || !["PREPARED", "EXPIRED"].includes(oldPreparation.state) ||
          (oldPreparation.state === "EXPIRED" && oldPreparation.expiresAt > input.now) ||
          !newPreparation || newPreparation.state !== "PREPARED" ||
          newPreparation.expiresAt < input.minimumPreparationExpiresAt ||
          newPreparation.expiresAt.toISOString() !== reseal.newPreparationExpiresAt ||
          oldPreparation.objectType !== route.objectType || oldPreparation.operation !== route.operation ||
          !sameResealPreparationIdentity(oldPreparation, newPreparation) ||
          newPreparation.actorId !== current.binding.actorId ||
          newPreparation.workspaceId !== current.binding.workspaceId ||
          newPreparation.tenantId !== current.binding.tenantId ||
          newPreparation.installationId !== current.binding.installationId ||
          newPreparation.bindingId !== current.binding.bindingId ||
          newPreparation.bindingRevision !== current.binding.bindingRevision ||
          newPreparation.connectionId !== current.binding.connectionId ||
          newPreparation.targetSessionId !== current.binding.targetSessionId ||
          newPreparation.canonicalPayloadHash !== reseal.preparationCanonicalPayloadHash ||
          newPreparation.canonicalPayloadHash !== hashObject(newPreparation.canonicalPayload) ||
          newPreparation.sourceSha256 !== reseal.sourceSha256 ||
          newPreparation.sourceRef !== `case:${current.compiled.caseId}` ||
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
      }
      if (!hasStalePreparation) {
        throw new AppError("CONFLICT", "Accounting Case preparations still have sufficient execution runway.", {
          httpStatus: 409,
        });
      }

      await client.query(
        `INSERT INTO accounting_case_preflight_reseals(
           case_id, case_version, reseal_revision, request_id,
           previous_effective_seal_hash, reseal_receipt, reseal_receipt_hash,
           checked_at, minimum_preparation_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [
          input.caseId,
          input.version,
          nextRevision,
          input.requestId,
          input.expectedEffectiveSealHash,
          input.resealReceipt,
          input.resealReceiptHash,
          input.now,
          input.minimumPreparationExpiresAt,
        ],
      );
      for (const reseal of input.operations) {
        await client.query(
          `INSERT INTO accounting_case_preflight_reseal_operations(
             case_id, case_version, reseal_revision, operation_id,
             old_preparation_id, new_preparation_id,
             operation_canonical_payload_hash, preparation_canonical_payload_hash,
             source_sha256, new_preparation_expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            input.caseId,
            input.version,
            nextRevision,
            reseal.operationId,
            reseal.oldPreparationId,
            reseal.newPreparationId,
            reseal.operationCanonicalPayloadHash,
            reseal.preparationCanonicalPayloadHash,
            reseal.sourceSha256,
            reseal.newPreparationExpiresAt,
          ],
        );
      }
      for (const reseal of input.operations) {
        const updated = await client.query(
          `UPDATE accounting_case_operations SET
             preparation_id = $4,
             preparation_canonical_payload_hash = $5,
             operation_source_sha256 = $6,
             updated_at = $7
           WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
             AND state = 'PREPARED' AND preparation_id = $8
             AND mutation_request_id IS NULL
           RETURNING operation_id`,
          [
            input.caseId,
            input.version,
            reseal.operationId,
            reseal.newPreparationId,
            reseal.preparationCanonicalPayloadHash,
            reseal.sourceSha256,
            input.now,
            reseal.oldPreparationId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new AppError("CONFLICT", "Accounting Case reseal operation compare-and-swap failed.", {
            httpStatus: 409,
          });
        }
      }
      const claimed = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'EXECUTING', execution_request_id = $3,
           execution_started_at = $4, updated_at = $4,
           effective_preflight_seal_hash = $5,
           effective_preflight_sealed_at = $4,
           preflight_reseal_revision = $6
         WHERE case_id = $1 AND version = $2
           AND state = $7 AND execution_request_id IS NULL
           AND compiled_plan_hash = $8
           AND original_preflight_receipt_hash = $9
           AND effective_preflight_seal_hash = $10
           AND preflight_reseal_revision = $11
           AND ($7 = 'READY_TO_RESUME' OR preflight_request_id = $3)
         RETURNING case_id`,
        [
          input.caseId,
          input.version,
          input.requestId,
          input.now,
          input.resealReceiptHash,
          nextRevision,
          current.state,
          input.expectedPlanHash,
          input.expectedOriginalPreflightReceiptHash,
          input.expectedEffectiveSealHash,
          input.expectedResealRevision,
        ],
      );
      if (claimed.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case reseal claim compare-and-swap failed.", { httpStatus: 409 });
      }
      const claimedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!claimedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case reseal claim was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, claimedRow);
      await client.query("COMMIT");
      return { mode: "RESEALED_AND_CLAIMED", record };
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async updateAccountingCaseOperation(
    input: UpdateAccountingCaseOperationInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || input.expectedStates.length === 0 || !isNonEmpty(input.requestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case operation update is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selectedCase = await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selectedCase) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (positiveSafeInteger(selectedCase.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can change.", { httpStatus: 409 });
      }
      if (!["EXECUTING", "RECOVERY_REQUIRED"].includes(String(selectedCase.version_state))) {
        throw new AppError("CONFLICT", "Accounting Case operation cannot change outside execution/recovery.", {
          httpStatus: 409,
        });
      }
      if (String(selectedCase.execution_request_id ?? "") !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case operation update does not own the execution claim.", {
          httpStatus: 409,
        });
      }
      const selectedOperation = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
         FOR UPDATE`,
        [input.caseId, input.version, input.operationId],
      );
      const operationRow = selectedOperation.rows[0] as Row | undefined;
      if (!operationRow) {
        throw new AppError("NOT_FOUND", "Accounting Case operation was not found.", { httpStatus: 404 });
      }
      const current = mapAccountingCaseOperation(operationRow);
      if (!input.expectedStates.includes(current.state)) {
        throw new AppError("CONFLICT", `Accounting Case operation cannot transition from ${current.state}.`, {
          httpStatus: 409,
        });
      }
      if (input.mutationRequestId || input.writeReceipt ||
          (input.xeroObjectId && input.state !== "NO_WRITE_REQUIRED") || current.mutationRequestId ||
          ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED", "PROVIDER_REJECTED"]
            .includes(input.state)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Mutation-linked Accounting Case evidence must be projected from the durable mutation request.",
          { httpStatus: 422 },
        );
      }
      const allowedTransitions: Record<AccountingCaseOperationState, readonly AccountingCaseOperationState[]> = {
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
      if (input.state === "NOT_EXECUTED_AFTER_PRIOR_FAILURE") {
        const earlierFailure = await client.query(
          `SELECT 1 FROM accounting_case_operations
           WHERE case_id = $1 AND case_version = $2 AND ordinal < $3
             AND state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
           LIMIT 1`,
          [input.caseId, input.version, current.ordinal],
        );
        if (earlierFailure.rowCount !== 1) {
          throw new AppError("CONFLICT", "A residual operation requires an earlier definite failure.", {
            httpStatus: 409,
          });
        }
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
      this.#assertCompatibleAccountingCaseOperationEvidence(current, input);
      if (
        ["NO_WRITE_REQUIRED", "READBACK_VERIFIED", "PROVIDER_REJECTED", "BLOCKED_VALIDATION", "NOT_EXECUTED_AFTER_PRIOR_FAILURE"].includes(current.state) &&
        current.state === input.state
      ) {
        const existing = await this.#hydrateAccountingCaseVersion(client, selectedCase);
        await client.query("COMMIT");
        return existing;
      }
      const replaceMismatchReadback = current.state === "READBACK_MISMATCH" && input.state === "READBACK_VERIFIED";
      const updated = await client.query(
        `UPDATE accounting_case_operations SET
           state = $4,
           preparation_id = COALESCE(preparation_id, $5),
           mutation_request_id = COALESCE(mutation_request_id, $6),
           xero_object_id = COALESCE(xero_object_id, $7),
           write_receipt = COALESCE(write_receipt, $8::jsonb),
           readback_snapshot = CASE WHEN $12::boolean
             THEN COALESCE($9::jsonb, readback_snapshot)
             ELSE COALESCE(readback_snapshot, $9::jsonb)
           END,
           error_receipt = COALESCE(error_receipt, $10::jsonb),
           updated_at = $11
         WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
           AND state = ANY($13::text[])
         RETURNING operation_id`,
        [
          input.caseId,
          input.version,
          input.operationId,
          input.state,
          input.preparationId ?? null,
          input.mutationRequestId ?? null,
          input.xeroObjectId ?? null,
          input.writeReceipt ?? null,
          input.readbackSnapshot ?? null,
          input.errorReceipt ?? null,
          input.now,
          replaceMismatchReadback,
          input.expectedStates,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case operation compare-and-swap failed.", { httpStatus: 409 });
      }
      await client.query(
        `UPDATE accounting_case_versions SET
           updated_at = $4,
           terminal_summary = CASE WHEN state = 'RECOVERY_REQUIRED'
             THEN accounting_case_terminal_state_projection(case_id, version, state)
             ELSE terminal_summary END
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3
           AND state IN ('EXECUTING', 'RECOVERY_REQUIRED')`,
        [input.caseId, input.version, input.requestId, input.now],
      );
      const updatedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!updatedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation update was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, updatedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async projectAccountingCaseOperationFromMutation(
    input: ProjectAccountingCaseOperationFromMutationInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || input.expectedStates.length === 0 || !isNonEmpty(input.mutationRequestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case mutation projection is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
      const selectedCase = recoveryAccess
        ? await this.#selectAccessibleAccountingCaseVersion(client, {
            currentAccessBinding: input.binding,
            caseId: input.caseId,
            version: input.version,
          }, true)
        : await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selectedCase) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (recoveryAccess) await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
      if (positiveSafeInteger(selectedCase.current_version, "Accounting Case current version") !== input.version ||
          String(selectedCase.execution_request_id ?? "") !== input.requestId ||
          (recoveryAccess
            ? String(selectedCase.version_state) !== "RECOVERY_REQUIRED"
            : !["EXECUTING", "RECOVERY_REQUIRED"].includes(String(selectedCase.version_state)))) {
        throw new AppError("CONFLICT", "Accounting Case mutation projection does not own an executable Case.", {
          httpStatus: 409,
        });
      }
      const selectedOperation = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
         FOR UPDATE`,
        [input.caseId, input.version, input.operationId],
      );
      const operationRow = selectedOperation.rows[0] as Row | undefined;
      if (!operationRow) throw new AppError("NOT_FOUND", "Accounting Case operation was not found.", { httpStatus: 404 });
      const current = mapAccountingCaseOperation(operationRow);
      if (!input.expectedStates.includes(current.state)) {
        throw new AppError("CONFLICT", `Accounting Case operation cannot transition from ${current.state}.`, {
          httpStatus: 409,
        });
      }
      const selectedRequest = await client.query(
        "SELECT * FROM xero_mutation_requests WHERE mutation_request_id = $1 FOR UPDATE",
        [input.mutationRequestId],
      );
      const requestRow = selectedRequest.rows[0] as Row | undefined;
      let request = requestRow ? mapXeroMutationRequest(requestRow) : undefined;
      const selectedPreparation = request
        ? await client.query("SELECT * FROM xero_mutation_preparations WHERE preparation_id = $1 FOR UPDATE", [request.preparationId])
        : undefined;
      const preparationRow = selectedPreparation?.rows[0] as Row | undefined;
      const preparation = preparationRow ? mapXeroMutationPreparation(preparationRow) : undefined;
      const originalBinding = mapAccountingCaseBinding(selectedCase);
      const route = accountingCaseMutationRoute(current.operation);
      let projectedState = request && accountingCaseStateForMutation(request.state);
      if (
        !request || !preparation || !projectedState || projectedState !== input.desiredState ||
        request.preparationId !== current.preparationId || preparation.preparationId !== current.preparationId ||
        current.preparationCanonicalPayloadHash !== request.canonicalPayloadHash ||
        current.preparationCanonicalPayloadHash !== preparation.canonicalPayloadHash ||
        current.sourceSha256 !== request.sourceSha256 || current.sourceSha256 !== preparation.sourceSha256 ||
        request.canonicalPayloadHash !== hashObject(request.canonicalPayload) ||
        preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload) ||
        !sameJson(request.canonicalPayload, preparation.canonicalPayload) ||
        request.actorId !== originalBinding.actorId || request.workspaceId !== originalBinding.workspaceId ||
        request.tenantId !== originalBinding.tenantId || request.installationId !== originalBinding.installationId ||
        request.bindingId !== originalBinding.bindingId || request.bindingRevision !== originalBinding.bindingRevision ||
        request.connectionId !== originalBinding.connectionId || request.targetSessionId !== originalBinding.targetSessionId ||
        request.objectType !== route.objectType || request.operation !== route.operation ||
        request.sourceRef !== `case:${input.caseId}` || request.sourceUnitKey !== current.operation.operationId ||
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
          const mismatchedRequest = await client.query(
            `UPDATE xero_mutation_requests SET
               state = 'READBACK_MISMATCH',
               readback_mismatch_receipt = $2::jsonb,
               verified_at = NULL, updated_at = $3
             WHERE mutation_request_id = $1 AND state = 'READBACK_VERIFIED'
             RETURNING *`,
            [
              request.mutationRequestId,
              {
                receiptType: "ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH",
                mismatchType: "ACCOUNTING_CASE_ECONOMICS",
                reasonCodes: [...economics.reasons],
              },
              input.now,
            ],
          );
          if (mismatchedRequest.rowCount !== 1) {
            throw new AppError("CONFLICT", "Xero mutation economics mismatch convergence lost its compare-and-swap.", {
              httpStatus: 409,
            });
          }
          request = mapXeroMutationRequest(mismatchedRequest.rows[0] as Row);
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
      const replaceMismatchReadback = current.state === "READBACK_MISMATCH" && projectedState === "READBACK_VERIFIED";
      const updated = await client.query(
        `UPDATE accounting_case_operations SET
           state = $4, preparation_id = $5,
           preparation_canonical_payload_hash = $6,
           operation_source_sha256 = $7,
           mutation_request_id = $8,
           xero_object_id = $9, write_receipt = $10::jsonb,
           readback_snapshot = CASE WHEN $14::boolean THEN $11::jsonb ELSE COALESCE(readback_snapshot, $11::jsonb) END,
           error_receipt = CASE WHEN $4 = 'READBACK_VERIFIED'
             THEN NULL ELSE $12::jsonb END,
           updated_at = $13
         WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
           AND state = ANY($15::text[])
         RETURNING operation_id`,
        [
          input.caseId,
          input.version,
          input.operationId,
          projectedState,
          request.preparationId,
          request.canonicalPayloadHash,
          request.sourceSha256,
          request.mutationRequestId,
          request.xeroObjectId ?? null,
          request.writeReceipt ?? null,
          request.readbackSnapshot ?? null,
          errorReceipt ?? null,
          input.now,
          replaceMismatchReadback,
          input.expectedStates,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case mutation projection compare-and-swap failed.", { httpStatus: 409 });
      }
      const requiresRecovery = ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(projectedState);
      await client.query(
        `UPDATE accounting_case_versions SET
           state = CASE WHEN $5::boolean AND state = 'EXECUTING'
             THEN 'RECOVERY_REQUIRED' ELSE state END,
           updated_at = $4,
           terminal_summary = CASE WHEN $5::boolean OR state = 'RECOVERY_REQUIRED'
             THEN accounting_case_terminal_state_projection(case_id, version, 'RECOVERY_REQUIRED')
             ELSE terminal_summary END
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3
           AND state IN ('EXECUTING', 'RECOVERY_REQUIRED')`,
        [input.caseId, input.version, input.requestId, input.now, requiresRecovery],
      );
      const updatedRow = recoveryAccess
        ? await this.#selectAccessibleAccountingCaseVersion(client, {
            currentAccessBinding: input.binding,
            caseId: input.caseId,
            version: input.version,
          }, false)
        : await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!updatedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case mutation projection was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, updatedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async pauseAccountingCaseExecution(
    input: PauseAccountingCaseExecutionInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.errorReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case pause receipt is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (current.state !== "EXECUTING" || current.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case execution cannot be paused by this request.", {
          httpStatus: 409,
        });
      }
      if (!current.operations.some((operation) => operation.state === "PREPARED") ||
          current.operations.some((operation) =>
            ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state))) {
        throw new AppError("CONFLICT", "Accounting Case cannot pause while provider evidence needs recovery.", {
          httpStatus: 409,
        });
      }
      const receipt = {
        receiptType: "ACCOUNTING_CASE_EXECUTION_PAUSED",
        previousExecutionRequestId: input.requestId,
        error: input.errorReceipt,
      };
      const paused = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'READY_TO_RESUME', execution_request_id = NULL,
           execution_started_at = NULL, terminal_summary = NULL,
           last_execution_error_receipt = $4::jsonb, updated_at = $5
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3 AND state = 'EXECUTING'
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, receipt, input.now],
      );
      if (paused.rowCount !== 1) throw new AppError("CONFLICT", "Accounting Case pause compare-and-swap failed.", { httpStatus: 409 });
      const pausedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!pausedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case pause was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, pausedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async releaseAccountingCaseRecovery(
    input: ReleaseAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.reasonReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case recovery release receipt is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.#assertAccountingCaseTargetActive(client, input.currentAccessBinding, input.now);
      const selected = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found for current recovery access.", { httpStatus: 404 });
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (current.state !== "RECOVERY_REQUIRED" || current.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case recovery cannot be released by this request.", {
          httpStatus: 409,
        });
      }
      if (!current.operations.some((operation) => operation.state === "PREPARED") ||
          current.operations.some((operation) =>
            ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state))) {
        throw new AppError("CONFLICT", "Accounting Case recovery is not fully resolved to prepared residual work.", {
          httpStatus: 409,
        });
      }
      const receipt = {
        receiptType: "ACCOUNTING_CASE_RECOVERY_RELEASED",
        previousExecutionRequestId: input.requestId,
        reason: input.reasonReceipt,
      };
      const released = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'READY_TO_RESUME', execution_request_id = NULL,
           execution_started_at = NULL, terminal_summary = NULL,
           last_execution_error_receipt = $4::jsonb, updated_at = $5
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3 AND state = 'RECOVERY_REQUIRED'
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, receipt, input.now],
      );
      if (released.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case recovery release compare-and-swap failed.", { httpStatus: 409 });
      }
      const releasedRow = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, false);
      if (!releasedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case recovery release was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, releasedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async completeExpiredTargetAccountingCaseRecovery(
    input: CompleteExpiredTargetAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || Object.keys(input.reasonReceipt).length === 0) {
      throw new AppError("VALIDATION_FAILED", "Expired-target recovery completion receipt is invalid.", {
        httpStatus: 422,
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const clock = await client.query("SELECT statement_timestamp() AS repository_now");
      const repositoryNow = date((clock.rows[0] as Row).repository_now);
      await this.#assertAccountingCaseTargetActive(client, input.currentAccessBinding, repositoryNow);
      const selected = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, true);
      if (!selected) {
        throw new AppError("NOT_FOUND", "Accounting Case was not found for recovery completion.", {
          httpStatus: 404,
        });
      }
      if (positiveSafeInteger(selected.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can complete recovery.", {
          httpStatus: 409,
        });
      }
      const originalBinding = mapAccountingCaseBinding(selected);
      if (
        originalBinding.targetSessionHash === input.currentAccessBinding.targetSessionHash ||
        originalBinding.targetSessionExpiresAt > repositoryNow
      ) {
        throw new AppError("CONFLICT", "Expired-target recovery completion requires an expired original target.", {
          httpStatus: 409,
        });
      }
      if (
        String(selected.version_state) !== "RECOVERY_REQUIRED" ||
        String(selected.execution_request_id ?? "") !== input.requestId
      ) {
        throw new AppError("CONFLICT", "Accounting Case recovery completion does not own the execution claim.", {
          httpStatus: 409,
        });
      }
      const lockedOperations = await client.query(
        `SELECT *, state AS operation_state, updated_at AS operation_updated_at
         FROM accounting_case_operations
         WHERE case_id = $1 AND case_version = $2
         ORDER BY ordinal ASC
         FOR UPDATE`,
        [input.caseId, input.version],
      );
      const operations = lockedOperations.rows.map((row) => mapAccountingCaseOperation(row as Row));
      const residual = operations.filter((operation) => operation.state === "PREPARED");
      if (
        residual.length === 0 ||
        operations.some((operation) =>
          !["PREPARED", "READBACK_VERIFIED", "NO_WRITE_REQUIRED"].includes(operation.state)) ||
        !operations.some((operation) => operation.state === "READBACK_VERIFIED")
      ) {
        throw new AppError("CONFLICT", "Expired-target recovery is not fully GET-resolved to residual no-write intent.", {
          httpStatus: 409,
        });
      }
      const preparationIds = residual.map((operation) => operation.preparationId).filter((value): value is string => Boolean(value));
      if (preparationIds.length !== residual.length || new Set(preparationIds).size !== residual.length) {
        throw new AppError("PERSISTENCE_FAILURE", "Residual Accounting Case preparations are incomplete.", {
          httpStatus: 503,
        });
      }
      const preparationRows = await client.query(
        `SELECT * FROM xero_mutation_preparations
         WHERE preparation_id = ANY($1::text[])
         ORDER BY preparation_id ASC
         FOR UPDATE`,
        [preparationIds],
      );
      const preparations = new Map(preparationRows.rows.map((row) => {
        const preparation = mapXeroMutationPreparation(row as Row);
        return [preparation.preparationId, preparation] as const;
      }));
      const requestRows = await client.query(
        `SELECT * FROM xero_mutation_requests
         WHERE preparation_id = ANY($1::text[])
         ORDER BY mutation_request_id ASC
         FOR UPDATE`,
        [preparationIds],
      );
      if (requestRows.rowCount !== 0) {
        throw new AppError("CONFLICT", "Residual recovery preparation already has a mutation request.", {
          httpStatus: 409,
        });
      }
      for (const operation of residual) {
        const preparation = preparations.get(operation.preparationId!);
        if (
          !preparation ||
          !["PREPARED", "EXPIRED"].includes(preparation.state) ||
          preparation.actorId !== originalBinding.actorId ||
          preparation.workspaceId !== originalBinding.workspaceId ||
          preparation.tenantId !== originalBinding.tenantId ||
          preparation.installationId !== originalBinding.installationId ||
          preparation.bindingId !== originalBinding.bindingId ||
          preparation.bindingRevision !== originalBinding.bindingRevision ||
          preparation.connectionId !== originalBinding.connectionId ||
          preparation.targetSessionId !== originalBinding.targetSessionId ||
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
      const residualOperationIds = residual.map((operation) => operation.operation.operationId);
      let grant: AccountingCaseRecoveryResidualGrant | undefined;
      if (input.continuation) {
        let expectedTemplate;
        try {
          expectedTemplate = accountingCaseRecoveryResidualContinuationTemplate({
            source: jsonClone(selected.compiled_case, "compiled Accounting Case"),
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
        const insertedGrant = await client.query(
          `INSERT INTO accounting_case_recovery_residual_grants(
             grant_id, source_case_id, source_case_version, source_plan_hash,
             issued_request_id, successor_case_id, residual_operation_ids,
             continuation_template, template_hash,
             actor_id, workspace_id, subject_type, subject_id, agent_id,
             oauth_installation_id, binding_id, binding_revision, connection_id, tenant_id,
             target_session_id, target_session_hash, target_session_expires_at,
             state, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,
             $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
             'ISSUED',$23,$23
           )
           RETURNING *`,
          [
            input.continuation.grantId,
            input.caseId,
            input.version,
            String(selected.compiled_plan_hash),
            input.requestId,
            input.continuation.successorCaseId,
            residualOperationIds,
            input.continuation.template,
            input.continuation.templateHash,
            ...accountingCaseBindingValues(input.currentAccessBinding),
            repositoryNow,
          ],
        );
        grant = mapAccountingCaseRecoveryResidualGrant(insertedGrant.rows[0] as Row);
      }

      const expired = await client.query(
        `UPDATE xero_mutation_preparations
         SET state = 'EXPIRED', updated_at = GREATEST(updated_at, $2)
         WHERE preparation_id = ANY($1::text[]) AND state IN ('PREPARED', 'EXPIRED')
         RETURNING preparation_id`,
        [preparationIds, repositoryNow],
      );
      if (expired.rowCount !== preparationIds.length) {
        throw new AppError("CONFLICT", "Residual recovery preparation expiry compare-and-swap failed.", {
          httpStatus: 409,
        });
      }
      for (const operation of residual) {
        const errorReceipt = {
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
          reason: input.reasonReceipt,
        };
        const updated = await client.query(
          `UPDATE accounting_case_operations SET
             state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY',
             error_receipt = $5::jsonb, updated_at = $6
           WHERE case_id = $1 AND case_version = $2 AND operation_id = $3
             AND state = 'PREPARED' AND preparation_id = $4
             AND mutation_request_id IS NULL
           RETURNING operation_id`,
          [input.caseId, input.version, operation.operation.operationId, operation.preparationId, errorReceipt, repositoryNow],
        );
        if (updated.rowCount !== 1) {
          throw new AppError("CONFLICT", "Residual recovery operation compare-and-swap failed.", {
            httpStatus: 409,
          });
        }
      }
      const terminal = await client.query(
        `UPDATE accounting_case_versions SET
           state = 'TERMINAL',
           terminal_summary = accounting_case_terminal_state_projection(case_id, version, 'TERMINAL'),
           updated_at = $4
         WHERE case_id = $1 AND version = $2
           AND execution_request_id = $3 AND state = 'RECOVERY_REQUIRED'
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, repositoryNow],
      );
      if (terminal.rowCount !== 1) {
        throw new AppError("CONFLICT", "Expired-target recovery completion compare-and-swap failed.", {
          httpStatus: 409,
        });
      }
      const terminalRow = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: input.caseId,
        version: input.version,
      }, false);
      if (!terminalRow) {
        throw new AppError("PERSISTENCE_FAILURE", "Expired-target recovery completion was not durable.", {
          httpStatus: 503,
        });
      }
      const record = await this.#hydrateAccountingCaseVersion(client, terminalRow);
      await client.query("COMMIT");
      return grant ? { ...record, recoveryResidualGrant: grant } : record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async getAccountingCaseRecoveryResidualGrant(
    input: GetAccountingCaseRecoveryResidualGrantInput,
  ): Promise<GetAccountingCaseRecoveryResidualGrantResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const clock = await client.query("SELECT statement_timestamp() AS repository_now");
      const repositoryNow = date((clock.rows[0] as Row).repository_now);
      await this.#assertAccountingCaseTargetActive(client, input.currentAccessBinding, repositoryNow);
      const selectedGrant = await client.query(
        `SELECT * FROM accounting_case_recovery_residual_grants
         WHERE successor_case_id = $1
           AND actor_id = $2 AND workspace_id = $3
           AND subject_type = $4 AND subject_id = $5 AND agent_id = $6
           AND oauth_installation_id = $7 AND binding_id = $8 AND binding_revision = $9
           AND connection_id = $10 AND tenant_id = $11
           AND target_session_id = $12 AND target_session_hash = $13
           AND target_session_expires_at = $14
         FOR SHARE`,
        [input.successorCaseId, ...accountingCaseBindingValues(input.currentAccessBinding)],
      );
      const row = selectedGrant.rows[0] as Row | undefined;
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const grant = mapAccountingCaseRecoveryResidualGrant(row);
      const sourceRow = await this.#selectAccessibleAccountingCaseVersion(client, {
        currentAccessBinding: input.currentAccessBinding,
        caseId: grant.sourceCaseId,
        version: grant.sourceVersion,
      }, false);
      if (!sourceRow || String(sourceRow.version_state) !== "TERMINAL" ||
          String(sourceRow.compiled_plan_hash) !== grant.sourcePlanHash) {
        throw new AppError("PERSISTENCE_FAILURE", "Recovery residual grant source is not durable.", {
          httpStatus: 503,
        });
      }
      const source = await this.#hydrateAccountingCaseVersion(client, sourceRow);
      await client.query("COMMIT");
      return { grant, source: { ...source, recoveryResidualGrant: grant } };
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async awaitAccountingCaseContinuation(
    input: AwaitAccountingCaseContinuationInput,
  ): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || !isNonEmpty(input.requestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case continuation evidence is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (positiveSafeInteger(selected.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can await continuation.", {
          httpStatus: 409,
        });
      }
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (current.state === "AWAITING_CONTINUATION" && current.executionRequestId === input.requestId) {
        await client.query("COMMIT");
        return current;
      }
      if (current.state !== "EXECUTING" || current.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case continuation request does not own the execution claim.", {
          httpStatus: 409,
        });
      }
      if (
        !hasAccountingCaseDependentContinuation(current.compiled) ||
        current.operations.length === 0 ||
        current.operations.some((operation) =>
          operation.state !== "READBACK_VERIFIED" && operation.state !== "NO_WRITE_REQUIRED")
      ) {
        throw new AppError("CONFLICT", "Accounting Case cannot await continuation without verified writes and dependent residual work.", {
          httpStatus: 409,
        });
      }
      const updated = await client.query(
        `UPDATE accounting_case_versions SET state = 'AWAITING_CONTINUATION', updated_at = $4
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3 AND state = 'EXECUTING'
         RETURNING case_id`,
        [input.caseId, input.version, input.requestId, input.now],
      );
      if (updated.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case continuation compare-and-swap failed.", { httpStatus: 409 });
      }
      const updatedRow = await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!updatedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case continuation was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, updatedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async finalizeAccountingCase(input: FinalizeAccountingCaseInput): Promise<AccountingCaseVersionRecord> {
    if (!isValidDate(input.now) || !isNonEmpty(input.requestId)) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case terminal evidence is invalid.", { httpStatus: 422 });
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recoveryAccess = input.accessMode === "RECOVERY_GET_ONLY";
      const selected = recoveryAccess
        ? await this.#selectAccessibleAccountingCaseVersion(client, {
            currentAccessBinding: input.binding,
            caseId: input.caseId,
            version: input.version,
          }, true)
        : await this.#selectBoundAccountingCaseVersion(client, input, true);
      if (!selected) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
      if (recoveryAccess) await this.#assertAccountingCaseTargetActive(client, input.binding, input.now);
      if (positiveSafeInteger(selected.current_version, "Accounting Case current version") !== input.version) {
        throw new AppError("CONFLICT", "Only the current Accounting Case version can finalize.", { httpStatus: 409 });
      }
      const current = await this.#hydrateAccountingCaseVersion(client, selected);
      if (current.executionRequestId !== input.requestId) {
        throw new AppError("CONFLICT", "Accounting Case finalization request does not own the execution claim.", {
          httpStatus: 409,
        });
      }
      const terminalSummary = accountingCaseTerminalSummary(current, input.state);
      if (
        current.state === input.state &&
        current.terminalSummary &&
        sameJson(current.terminalSummary, terminalSummary)
      ) {
        await client.query("COMMIT");
        return current;
      }
      if (recoveryAccess && current.state !== "RECOVERY_REQUIRED") {
        throw new AppError("CONFLICT", "Current-access finalization is recovery-only.", { httpStatus: 409 });
      }
      if (!["EXECUTING", "RECOVERY_REQUIRED"].includes(current.state)) {
        throw new AppError("CONFLICT", `Accounting Case cannot finalize from ${current.state}.`, { httpStatus: 409 });
      }
      const unfinished = new Set(["PENDING", "PREPARED", "WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]);
      const uncertain = new Set(["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]);
      const completed = new Set(["READBACK_VERIFIED", "NO_WRITE_REQUIRED"]);
      const failed = new Set(["PROVIDER_REJECTED", "BLOCKED_VALIDATION"]);
      const hasUnfinished = current.operations.some((operation) => unfinished.has(operation.state));
      const hasUncertain = current.operations.some((operation) => uncertain.has(operation.state));
      const hasCompleted = current.operations.some((operation) => completed.has(operation.state));
      const hasFailed = current.operations.some((operation) => failed.has(operation.state));
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
      const finalized = await client.query(
        `UPDATE accounting_case_versions SET state = $4, terminal_summary = $5, updated_at = $6
         WHERE case_id = $1 AND version = $2 AND execution_request_id = $3 AND state = $7
         RETURNING case_id`,
        [
          input.caseId,
          input.version,
          input.requestId,
          input.state,
          terminalSummary,
          input.now,
          current.state,
        ],
      );
      if (finalized.rowCount !== 1) {
        throw new AppError("CONFLICT", "Accounting Case finalization compare-and-swap failed.", { httpStatus: 409 });
      }
      const finalizedRow = recoveryAccess
        ? await this.#selectAccessibleAccountingCaseVersion(client, {
            currentAccessBinding: input.binding,
            caseId: input.caseId,
            version: input.version,
          }, false)
        : await this.#selectBoundAccountingCaseVersion(client, input, false);
      if (!finalizedRow) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case finalization was not durable.");
      const record = await this.#hydrateAccountingCaseVersion(client, finalizedRow);
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await this.#safeRollback(client);
      this.#throwAccountingCaseConstraint(error);
    } finally {
      client.release();
    }
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_audit_logs(
         call_id, actor_id, tenant_id, tool_name, request_hash, result_status,
         provider_request_id, record_id, error_class, started_at, finished_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        record.callId,
        record.actorId,
        record.tenantId ?? null,
        record.toolName,
        record.requestHash,
        record.resultStatus,
        record.providerRequestId ?? null,
        record.recordId ?? null,
        record.errorClass ?? null,
        record.startedAt,
        record.finishedAt,
      ],
    );
  }

  async beginAudit(intent: AuditIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO tool_audit_logs(
         call_id, actor_id, tenant_id, tool_name, request_hash, result_status,
         started_at, finished_at
       ) VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',$6,NULL)`,
      [
        intent.callId,
        intent.actorId,
        intent.tenantId ?? null,
        intent.toolName,
        intent.requestHash,
        intent.startedAt,
      ],
    );
  }

  async completeAudit(callId: string, completion: AuditCompletion): Promise<void> {
    const result = await this.pool.query(
      `UPDATE tool_audit_logs
       SET result_status = $2,
           provider_request_id = $3,
           record_id = $4,
           error_class = $5,
           finished_at = $6
       WHERE call_id = $1 AND result_status = 'IN_PROGRESS'
       RETURNING call_id`,
      [
        callId,
        completion.resultStatus,
        completion.providerRequestId ?? null,
        completion.recordId ?? null,
        completion.errorClass ?? null,
        completion.finishedAt,
      ],
    );
    if (result.rowCount === 1) return;

    const existing = await this.pool.query<{ result_status: string }>(
      "SELECT result_status FROM tool_audit_logs WHERE call_id = $1",
      [callId],
    );
    if (existing.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Audit intent was not found.", { httpStatus: 404 });
    }
    throw new AppError("CONFLICT", "Audit intent is already complete.", { httpStatus: 409 });
  }

  async appendGovernanceAuditEvent(input: GovernanceAuditEventInput): Promise<GovernanceAuditEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.streamId]);
      const previous = await client.query<{ event_hash: string }>(
        `SELECT event_hash FROM governance_audit_events
         WHERE stream_id = $1
         ORDER BY event_sequence DESC
         LIMIT 1`,
        [input.streamId],
      );
      const previousEventHash = previous.rows[0]?.event_hash;
      const recordedAt = new Date();
      const eventHash = governanceAuditEventHash(input, previousEventHash, recordedAt);
      const inserted = await client.query(
        `INSERT INTO governance_audit_events(
           event_id, stream_id, schema_version, event_type, event_source, action,
           actor_id, workspace_id, agent_id, oauth_installation_id, binding_id,
           connection_id, tenant_id, mandate_id, policy_id, correlation_id,
           causation_id, disposition, outcome, input_hash, output_hash, evidence,
           previous_event_hash, event_hash, occurred_at, recorded_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
         )
         RETURNING *`,
        [
          input.eventId,
          input.streamId,
          input.schemaVersion,
          input.eventType,
          input.source,
          input.action,
          input.actorId,
          input.workspaceId ?? null,
          input.agentId ?? null,
          input.installationId ?? null,
          input.bindingId ?? null,
          input.connectionId ?? null,
          input.tenantId ?? null,
          input.mandateId ?? null,
          input.policyId ?? null,
          input.correlationId,
          input.causationId ?? null,
          input.disposition,
          input.outcome,
          input.inputHash ?? null,
          input.outputHash ?? null,
          input.evidence,
          previousEventHash ?? null,
          eventHash,
          input.occurredAt,
          recordedAt,
        ],
      );
      await client.query("COMMIT");
      return mapGovernanceAuditEvent(inserted.rows[0] as Row);
    } catch (error) {
      await this.#safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #assertAccountingCaseTargetActive(
    client: PoolClient,
    binding: AccountingCaseBinding,
    now: Date,
  ): Promise<void> {
    if (!isValidDate(now) || binding.targetSessionExpiresAt <= now) {
      throw new AppError("TARGET_SESSION_EXPIRED", "Accounting Case target session has expired.", {
        httpStatus: 409,
      });
    }
    const active = await client.query(
      `SELECT target.session_hash
       FROM ledger_target_sessions target
       JOIN agent_connection_bindings binding
         ON binding.binding_id = target.binding_id
        AND binding.oauth_installation_id = target.oauth_installation_id
        AND binding.connection_id = target.connection_id
       JOIN oauth_installations installation
         ON installation.installation_id = binding.oauth_installation_id
        AND installation.workspace_id = binding.workspace_id
        AND installation.subject_type = binding.subject_type
        AND installation.subject_id = binding.subject_id
        AND installation.agent_id = binding.agent_id
       JOIN oauth_installation_active_bindings active_binding
         ON active_binding.oauth_installation_id = target.oauth_installation_id
        AND active_binding.binding_id = target.binding_id
        AND active_binding.connection_id = target.connection_id
        AND active_binding.binding_revision = target.binding_revision
       JOIN provider_connections connection
         ON connection.connection_id = target.connection_id
       WHERE target.session_hash = $1 AND target.session_id = $2
         AND target.oauth_installation_id = $3
         AND target.binding_id = $4 AND target.connection_id = $5
         AND target.binding_revision = $6 AND target.expires_at = $7
         AND target.revoked_at IS NULL AND target.expires_at > $8
         AND binding.workspace_id = $9 AND binding.subject_type = $10
         AND binding.subject_id = $11 AND binding.agent_id = $12
         AND binding.binding_status = 'ACTIVE' AND installation.installation_status = 'ACTIVE'
         AND connection.connection_status = 'ACTIVE' AND connection.tenant_id = $13`,
      [
        binding.targetSessionHash,
        binding.targetSessionId,
        binding.installationId,
        binding.bindingId,
        binding.connectionId,
        binding.bindingRevision,
        binding.targetSessionExpiresAt,
        now,
        binding.workspaceId,
        binding.subjectType,
        binding.subjectId,
        binding.agentId,
        binding.tenantId,
      ],
    );
    if (active.rowCount !== 1) {
      throw new AppError(
        "TARGET_SESSION_EXPIRED",
        "Accounting Case target session is expired, revoked, or no longer exact.",
        { httpStatus: 409 },
      );
    }
  }

  async #insertAccountingCaseVersion(
    client: PoolClient,
    input: CreateOrAdvanceAccountingCaseInput,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO accounting_case_versions(
         case_id, version, compiled_case, compiled_plan_hash, source_revision_hash,
         initial_state, state, execution_request_id, execution_started_at,
         terminal_summary, source_case_claim, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,NULL,NULL,NULL,$7,$8,$8)
       ON CONFLICT (case_id, version) DO NOTHING
       RETURNING case_id`,
      [
        input.compiled.caseId,
        input.compiled.version,
        input.compiled,
        input.compiledPlanHash,
        input.compiled.sourceRevisionHash,
        input.compiled.status,
        // Sealed once, at preparation time: never recomputed on a later read.
        // Falls back to the column's own honest-absent default so a caller
        // that omits the (required-by-type) claim never trips the NOT NULL
        // constraint instead of a clear domain error.
        input.sourceCaseClaim ?? "SOURCE_CASE_ABSENT",
        input.now,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new AppError("CONFLICT", "Accounting Case version already exists.", { httpStatus: 409 });
    }
    for (const [ordinal, operation] of input.compiled.operations.entries()) {
      await client.query(
        `INSERT INTO accounting_case_operations(
           case_id, case_version, tenant_id, operation_id, ordinal, event_id, action_id,
         native_route, dependency_event_keys, operation_json, canonical_payload,
           canonical_payload_hash, business_identity, business_identity_hash,
           business_reservation, business_reservation_coordinate,
           business_reservation_coordinate_hash,
           business_reservation_scope, business_reservation_occurrence_date,
           source_revision_hash, state,
           preparation_id, mutation_request_id, xero_object_id,
           write_receipt, readback_snapshot, error_receipt, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'PENDING',
           NULL,NULL,NULL,NULL,NULL,NULL,$21,$21
         )`,
        [
          input.compiled.caseId,
          input.compiled.version,
          input.binding.tenantId,
          operation.operationId,
          ordinal,
          operation.eventId,
          operation.actionId,
          operation.nativeRoute,
          operation.dependencyEventKeys,
          operation,
          operation.canonicalPayload,
          operation.canonicalPayloadHash,
          operation.businessIdentity,
          operation.businessIdentityHash,
          operation.businessReservation,
          {
            schemaVersion: operation.businessReservation.schemaVersion,
            providerId: operation.businessReservation.providerId,
            kind: operation.businessReservation.kind,
            canonicalFields: operation.businessReservation.canonicalFields,
          },
          operation.businessReservation.coordinateHash,
          operation.businessReservation.scope,
          operation.businessReservation.scope === "DATED_OCCURRENCE"
            ? operation.businessReservation.occurrenceDate
            : null,
          operation.sourceRevisionHash,
          input.now,
        ],
      );
    }
  }

  async #lockAccountingCaseNativeDocumentReservations(
    client: PoolClient,
    input: CreateOrAdvanceAccountingCaseInput,
  ): Promise<void> {
    const operations = input.compiled.operations
      .filter((operation) => operation.actionId !== "contact.create_basic")
      .sort((left, right) => {
        const leftKey = `${left.actionId}:${left.businessReservation.coordinateHash}`;
        const rightKey = `${right.actionId}:${right.businessReservation.coordinateHash}`;
        return leftKey.localeCompare(rightKey);
      });
    for (const operation of operations) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           $1 || ':' || $2 || ':' || $3::jsonb::text,
           0
         ))`,
        [
          input.binding.tenantId,
          operation.actionId,
          {
            schemaVersion: operation.businessReservation.schemaVersion,
            providerId: operation.businessReservation.providerId,
            kind: operation.businessReservation.kind,
            canonicalFields: operation.businessReservation.canonicalFields,
          },
        ],
      );
    }
  }

  async #selectBoundAccountingCaseVersion(
    client: PoolClient,
    input: GetBoundAccountingCaseInput,
    forUpdate: boolean,
  ): Promise<Row | undefined> {
    const selected = await client.query(
      `SELECT
         case_head.actor_id, case_head.workspace_id, case_head.subject_type,
         case_head.subject_id, case_head.agent_id, case_head.oauth_installation_id,
         case_head.binding_id, case_head.binding_revision, case_head.connection_id,
         case_head.tenant_id, case_head.target_session_id, case_head.target_session_hash,
         case_head.target_session_expires_at, case_head.current_version,
         case_head.source_case_system, case_head.source_case_ref_hash,
         version_row.case_id, version_row.version, version_row.compiled_case,
         version_row.compiled_plan_hash, version_row.source_revision_hash,
         version_row.initial_state, version_row.state AS version_state,
         version_row.preflight_request_id, version_row.preflight_receipt,
         version_row.preflight_receipt_hash, version_row.preflighted_at,
         version_row.original_preflight_receipt_hash,
         version_row.effective_preflight_seal_hash,
         version_row.effective_preflight_sealed_at,
         version_row.preflight_reseal_revision,
         version_row.execution_request_id, version_row.execution_started_at,
         version_row.last_execution_error_receipt, version_row.terminal_summary,
         version_row.source_case_claim,
         version_row.created_at AS version_created_at,
         version_row.updated_at AS version_updated_at
       FROM accounting_cases case_head
       JOIN accounting_case_versions version_row
         ON version_row.case_id = case_head.case_id
        AND version_row.version = COALESCE($15::bigint, case_head.current_version)
       WHERE case_head.case_id = $1
         AND case_head.actor_id = $2 AND case_head.workspace_id = $3
         AND case_head.subject_type = $4 AND case_head.subject_id = $5
         AND case_head.agent_id = $6 AND case_head.oauth_installation_id = $7
         AND case_head.binding_id = $8 AND case_head.binding_revision = $9
         AND case_head.connection_id = $10 AND case_head.tenant_id = $11
         AND case_head.target_session_id = $12 AND case_head.target_session_hash = $13
         AND case_head.target_session_expires_at = $14
       ${forUpdate ? "FOR UPDATE OF case_head, version_row" : ""}`,
      [input.caseId, ...accountingCaseBindingValues(input.binding), input.version ?? null],
    );
    return selected.rows[0] as Row | undefined;
  }

  async #selectAccessibleAccountingCaseVersion(
    client: PoolClient,
    input: Pick<GetAccessibleAccountingCaseInput, "currentAccessBinding" | "caseId" | "version">,
    forUpdate: boolean,
  ): Promise<Row | undefined> {
    const selected = await client.query(
      `SELECT
         case_head.actor_id, case_head.workspace_id, case_head.subject_type,
         case_head.subject_id, case_head.agent_id, case_head.oauth_installation_id,
         case_head.binding_id, case_head.binding_revision, case_head.connection_id,
         case_head.tenant_id, case_head.target_session_id, case_head.target_session_hash,
         case_head.target_session_expires_at, case_head.current_version,
         case_head.source_case_system, case_head.source_case_ref_hash,
         version_row.case_id, version_row.version, version_row.compiled_case,
         version_row.compiled_plan_hash, version_row.source_revision_hash,
         version_row.initial_state, version_row.state AS version_state,
         version_row.preflight_request_id, version_row.preflight_receipt,
         version_row.preflight_receipt_hash, version_row.preflighted_at,
         version_row.original_preflight_receipt_hash,
         version_row.effective_preflight_seal_hash,
         version_row.effective_preflight_sealed_at,
         version_row.preflight_reseal_revision,
         version_row.execution_request_id, version_row.execution_started_at,
         version_row.last_execution_error_receipt, version_row.terminal_summary,
         version_row.source_case_claim,
         version_row.created_at AS version_created_at,
         version_row.updated_at AS version_updated_at
       FROM accounting_cases case_head
       JOIN accounting_case_versions version_row
         ON version_row.case_id = case_head.case_id
        AND version_row.version = COALESCE($12::bigint, case_head.current_version)
       WHERE case_head.case_id = $1
         AND case_head.actor_id = $2 AND case_head.workspace_id = $3
         AND case_head.subject_type = $4 AND case_head.subject_id = $5
         AND case_head.agent_id = $6 AND case_head.oauth_installation_id = $7
         AND case_head.binding_id = $8 AND case_head.binding_revision = $9
         AND case_head.connection_id = $10 AND case_head.tenant_id = $11
       ${forUpdate ? "FOR UPDATE OF case_head, version_row" : ""}`,
      [input.caseId, ...accountingCaseAccessIdentityValues(input.currentAccessBinding), input.version ?? null],
    );
    return selected.rows[0] as Row | undefined;
  }

  async #hydrateAccountingCaseVersion(
    client: PoolClient,
    row: Row,
  ): Promise<AccountingCaseVersionRecord> {
    const operations = await client.query(
      `SELECT *, state AS operation_state, updated_at AS operation_updated_at
       FROM accounting_case_operations
       WHERE case_id = $1 AND case_version = $2
       ORDER BY ordinal ASC`,
      [String(row.case_id), positiveSafeInteger(row.version, "Accounting Case version")],
    );
    const reseals = await client.query(
      `SELECT * FROM accounting_case_preflight_reseals
       WHERE case_id = $1 AND case_version = $2
       ORDER BY reseal_revision ASC`,
      [String(row.case_id), positiveSafeInteger(row.version, "Accounting Case version")],
    );
    const binding = mapAccountingCaseBinding(row);
    const compiled = jsonClone<AccountingCaseVersionRecord["compiled"]>(
      row.compiled_case,
      "compiled Accounting Case",
    );
    const compiledPlanHash = String(row.compiled_plan_hash);
    if (compiledPlanHash !== accountingCasePlanHash(binding, compiled)) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case compiled plan integrity check failed.", {
        httpStatus: 503,
      });
    }
    const operationRecords = operations.rows.map((operation) => mapAccountingCaseOperation(operation as Row));
    if (
      operationRecords.length !== compiled.operations.length ||
      operationRecords.some((record, ordinal) => {
        const compiledOperation = compiled.operations[ordinal] as typeof record.operation & {
          businessReservation?: AccountingCaseBusinessReservation;
        };
        const durableOperation = record.operation;
        const comparableDurable = compiledOperation?.businessReservation
          ? durableOperation
          : (() => {
              const { businessReservation: _reservation, ...legacy } = durableOperation;
              return legacy;
            })();
        return record.ordinal !== ordinal ||
          stableStringify(comparableDurable) !== stableStringify(compiledOperation);
      })
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation plan does not match its compiled Case.", {
        httpStatus: 503,
      });
    }
    const sourceCase = mapAccountingCaseSourceCase(row);
    const record: AccountingCaseVersionRecord = {
      binding,
      compiled,
      compiledPlanHash,
      ...(sourceCase ? { sourceCase } : {}),
      sourceCaseClaim: mapAccountingCaseSourceCaseClaim(row),
      state: row.version_state as AccountingCaseVersionRecord["state"],
      operations: operationRecords,
      createdAt: date(row.version_created_at),
      updatedAt: date(row.version_updated_at),
    };
    const hasAnyPreflightEvidence = Boolean(
      row.preflight_request_id || row.preflight_receipt || row.preflight_receipt_hash || row.preflighted_at,
    );
    if (hasAnyPreflightEvidence) {
      if (!row.preflight_request_id || !row.preflight_receipt || !row.preflight_receipt_hash || !row.preflighted_at) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight evidence is incomplete.", {
          httpStatus: 503,
        });
      }
      record.preflightRequestId = String(row.preflight_request_id);
      record.preflightReceipt = jsonClone<Record<string, unknown>>(
        row.preflight_receipt,
        "Accounting Case preflight receipt",
      );
      record.preflightReceiptHash = String(row.preflight_receipt_hash);
      record.preflightedAt = date(row.preflighted_at);
      if (!row.original_preflight_receipt_hash || !row.effective_preflight_seal_hash ||
          !row.effective_preflight_sealed_at || row.preflight_reseal_revision === null ||
          row.preflight_reseal_revision === undefined) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal is incomplete.", {
          httpStatus: 503,
        });
      }
      record.originalPreflightReceiptHash = String(row.original_preflight_receipt_hash);
      record.effectivePreflightSealHash = String(row.effective_preflight_seal_hash);
      record.effectivePreflightSealedAt = date(row.effective_preflight_sealed_at);
      record.preflightResealRevision = nonNegativeSafeInteger(
        row.preflight_reseal_revision,
        "Accounting Case preflight reseal revision",
      );
      if (record.preflightReceiptHash !== accountingCasePreflightReceiptHash({
        binding,
        caseId: compiled.caseId,
        version: compiled.version,
        compiledPlanHash,
        requestId: record.preflightRequestId,
        preflightReceipt: record.preflightReceipt,
      })) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight receipt integrity check failed.", {
          httpStatus: 503,
        });
      }
      if (!Array.isArray(record.preflightReceipt.operations) ||
          record.preflightReceipt.operations.length !== operationRecords.length ||
          operationRecords.some((operation) => {
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
      if (record.originalPreflightReceiptHash !== record.preflightReceiptHash) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case original preflight receipt hash changed.", {
          httpStatus: 503,
        });
      }
      const resealRecords = reseals.rows.map((resealRow, index) => {
        const revision = positiveSafeInteger(resealRow.reseal_revision, "Accounting Case preflight reseal revision");
        const receipt = jsonClone<AccountingCasePreflightResealReceipt>(
          resealRow.reseal_receipt,
          "Accounting Case preflight reseal receipt",
        );
        const previousEffectiveSealHash = String(resealRow.previous_effective_seal_hash);
        const effectiveSealHash = String(resealRow.reseal_receipt_hash);
        const requestId = String(resealRow.request_id);
        const expectedPreviousSealHash = index === 0
          ? record.originalPreflightReceiptHash!
          : String(reseals.rows[index - 1]!.reseal_receipt_hash);
        if (
          revision !== index + 1 ||
          previousEffectiveSealHash !== expectedPreviousSealHash ||
          receipt.receiptType !== "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL" ||
          receipt.receiptVersion !== 1 ||
          receipt.caseId !== compiled.caseId || receipt.caseVersion !== compiled.version ||
          receipt.requestId !== requestId || receipt.compiledPlanHash !== compiledPlanHash ||
          receipt.originalPreflightReceiptHash !== record.originalPreflightReceiptHash ||
          receipt.previousEffectiveSealHash !== previousEffectiveSealHash || receipt.revision !== revision ||
          receipt.checkedAt !== date(resealRow.checked_at).toISOString() ||
          receipt.minimumPreparationExpiresAt !== date(resealRow.minimum_preparation_expires_at).toISOString() ||
          effectiveSealHash !== accountingCasePreflightResealReceiptHash({
            binding,
            caseId: compiled.caseId,
            version: compiled.version,
            compiledPlanHash,
            originalPreflightReceiptHash: record.originalPreflightReceiptHash!,
            previousEffectiveSealHash,
            revision,
            requestId,
            resealReceipt: receipt,
          })
        ) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight reseal chain is invalid.", {
            httpStatus: 503,
          });
        }
        return {
          revision,
          requestId,
          previousEffectiveSealHash,
          effectiveSealHash,
          receipt,
          resealedAt: date(resealRow.checked_at),
        };
      });
      record.preflightReseals = resealRecords;
      const latestReseal = resealRecords.at(-1);
      if (
        resealRecords.length !== record.preflightResealRevision ||
        record.effectivePreflightSealHash !==
          (latestReseal?.effectiveSealHash ?? record.originalPreflightReceiptHash) ||
        record.effectivePreflightSealedAt.getTime() !==
          (latestReseal?.resealedAt ?? record.preflightedAt).getTime()
      ) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal metadata is invalid.", {
          httpStatus: 503,
        });
      }
    }
    if (
      ["PREFLIGHTED", "READY_TO_RESUME", "EXECUTING", "RECOVERY_REQUIRED", "AWAITING_CONTINUATION", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state) &&
      !hasAnyPreflightEvidence
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight evidence is missing.", {
        httpStatus: 503,
      });
    }
    if (
      record.state === "PREFLIGHTED" &&
      operationRecords.some((operation) =>
        (operation.state === "PREPARED" &&
          (!operation.preparationId || !operation.preparationCanonicalPayloadHash || !operation.sourceSha256)) ||
        (operation.state !== "PREPARED" && operation.state !== "NO_WRITE_REQUIRED"))
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight operation set is incomplete.", {
        httpStatus: 503,
      });
    }
    if (row.execution_request_id) record.executionRequestId = String(row.execution_request_id);
    if (row.execution_started_at) record.executionStartedAt = date(row.execution_started_at);
    if (row.last_execution_error_receipt) {
      record.lastExecutionErrorReceipt = jsonClone<Record<string, unknown>>(
        row.last_execution_error_receipt,
        "Accounting Case last execution error receipt",
      );
    }
    if (row.terminal_summary) {
      record.terminalSummary = jsonClone<Record<string, unknown>>(
        row.terminal_summary,
        "Accounting Case terminal summary",
      );
    }
    if (["RECOVERY_REQUIRED", "PARTIALLY_COMMITTED", "TERMINAL"].includes(record.state)) {
      const expectedSummary = accountingCaseTerminalSummary(
        record,
        record.state as "RECOVERY_REQUIRED" | "PARTIALLY_COMMITTED" | "TERMINAL",
      );
      if (!record.terminalSummary || !sameJson(record.terminalSummary, expectedSummary)) {
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
        operationRecords.length === 0 ||
        operationRecords.some((operation) =>
          operation.state !== "READBACK_VERIFIED" && operation.state !== "NO_WRITE_REQUIRED")
      )
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case continuation state is invalid.", { httpStatus: 503 });
    }
    if (record.state === "READY_TO_RESUME" &&
        (record.executionRequestId || record.executionStartedAt || !record.lastExecutionErrorReceipt || record.terminalSummary)) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case ready-to-resume evidence is invalid.", {
        httpStatus: 503,
      });
    }
    return record;
  }

  #assertCompatibleAccountingCaseOperationEvidence(
    current: AccountingCaseOperationRecord,
    input: UpdateAccountingCaseOperationInput,
  ): void {
    const immutableStrings = [
      ["preparation", current.preparationId, input.preparationId],
      ["mutation request", current.mutationRequestId, input.mutationRequestId],
      ["Xero object", current.xeroObjectId, input.xeroObjectId],
    ] as const;
    for (const [field, existing, proposed] of immutableStrings) {
      if (existing !== undefined && proposed !== undefined && existing !== proposed) {
        throw new AppError("CONFLICT", `Accounting Case operation cannot replace its ${field}.`, {
          httpStatus: 409,
        });
      }
    }
    if (current.writeReceipt && input.writeReceipt && !sameJson(current.writeReceipt, input.writeReceipt)) {
      throw new AppError("CONFLICT", "Accounting Case operation cannot replace its write receipt.", {
        httpStatus: 409,
      });
    }
    if (current.errorReceipt && input.errorReceipt && !sameJson(current.errorReceipt, input.errorReceipt)) {
      throw new AppError("CONFLICT", "Accounting Case operation cannot replace its error receipt.", {
        httpStatus: 409,
      });
    }
    const recoveringMismatch = current.state === "READBACK_MISMATCH" && input.state === "READBACK_VERIFIED";
    if (
      current.readbackSnapshot && input.readbackSnapshot &&
      !sameJson(current.readbackSnapshot, input.readbackSnapshot) &&
      !recoveringMismatch
    ) {
      throw new AppError("CONFLICT", "Accounting Case operation cannot replace its readback evidence.", {
        httpStatus: 409,
      });
    }
  }

  #throwAccountingCaseConstraint(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (!isPostgresConstraintViolation(error)) throw error;
    const postgresCode = String((error as { code: unknown }).code);
    if (postgresCode === "23503") {
      throw new AppError("FORBIDDEN", "Accounting Case does not match an active exact OAuth target binding.", {
        httpStatus: 403,
        cause: error,
      });
    }
    if (postgresCode === "23505") {
      if (
        String((error as { constraint?: unknown }).constraint) ===
          "accounting_case_contact_bare_number_reservation_overlap"
      ) {
        throw new AppError(
          "CONFLICT",
          "This tenant already has an active provider bare-number claim for another contact plan.",
          {
            httpStatus: 409,
            details: {
              reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"],
              providerMutationPossible: false,
            },
            cause: error,
          },
        );
      }
      if (
        String((error as { constraint?: unknown }).constraint) ===
          "accounting_case_active_business_reservation_overlap"
      ) {
        throw new AppError(
          "CONFLICT",
          "This tenant already has an active Accounting Case claim for the provider business coordinate.",
          {
            httpStatus: 409,
            details: {
              reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
              providerMutationPossible: false,
            },
            cause: error,
          },
        );
      }
      throw new AppError("CONFLICT", "Accounting Case compare-and-swap or immutable identity conflicted.", {
        httpStatus: 409,
        cause: error,
      });
    }
    throw new AppError("VALIDATION_FAILED", "Accounting Case state or evidence violates its durable contract.", {
      httpStatus: 422,
      cause: error,
    });
  }

  async #selectBoundXeroMutationRequest(
    client: PoolClient,
    input: BoundXeroMutationRequestInput,
    forUpdate: boolean,
  ): Promise<XeroMutationRequest> {
    const result = await client.query(
      `SELECT * FROM xero_mutation_requests
       WHERE mutation_request_id = $1
         AND actor_id = $2 AND workspace_id = $3 AND tenant_id = $4
         AND oauth_installation_id = $5 AND binding_id = $6 AND connection_id = $7
         AND object_type = $8 AND operation = $9
         AND target_xero_object_id IS NOT DISTINCT FROM $10::text
         AND canonical_payload_hash = $11
         AND source_ref IS NOT DISTINCT FROM $12::text
         AND source_unit_key = $13
         AND source_sha256 = $14 AND source_evidence_type = $15
         AND binding_revision IS NOT DISTINCT FROM $16::bigint
         AND target_session_id IS NOT DISTINCT FROM $17::text
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [
        input.mutationRequestId,
        input.actorId,
        input.workspaceId,
        input.tenantId,
        input.installationId,
        input.bindingId,
        input.connectionId,
        input.objectType,
        input.operation,
        input.targetXeroObjectId ?? null,
        input.canonicalPayloadHash,
        input.sourceRef ?? null,
        input.sourceUnitKey,
        input.sourceSha256,
        input.sourceEvidenceType,
        input.bindingRevision ?? null,
        input.targetSessionId ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError("NOT_FOUND", "Mutation request is unavailable for this OAuth binding.", {
        httpStatus: 404,
      });
    }
    return mapXeroMutationRequest(result.rows[0]);
  }

  #assertCompatibleMutationEvidence(
    request: XeroMutationRequest,
    xeroObjectId?: string,
    writeReceipt?: Record<string, unknown>,
  ): void {
    if (
      xeroMutationTargetsExistingObject(request.operation) &&
      xeroObjectId &&
      request.targetXeroObjectId !== xeroObjectId
    ) {
      throw new AppError("CONFLICT", "Mutation result does not match its immutable Xero target.", {
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

  async #revokeMcpRefreshFamily(
    client: PoolClient,
    familyId: string,
    revokedAt: Date,
    replayDetectedAt?: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE mcp_refresh_tokens SET revoked_at = COALESCE(revoked_at, $2)
       WHERE family_id = $1`,
      [familyId, revokedAt],
    );
    await client.query(
      `UPDATE mcp_access_tokens SET revoked_at = COALESCE(revoked_at, $2)
       WHERE refresh_family_id = $1`,
      [familyId, revokedAt],
    );
    await client.query(
      `UPDATE mcp_refresh_token_families SET
         family_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         replay_detected_at = COALESCE(replay_detected_at, $3),
         updated_at = $2
       WHERE family_id = $1`,
      [familyId, revokedAt, replayDetectedAt ?? null],
    );
  }

  /** Exact-family validation selects the installation-wide MCP grant boundary to disconnect. */
  async #revokeMcpRefreshGrant(
    client: PoolClient,
    familyId: string,
    installationId: string,
    bindingId: string,
    connectionId: string,
    revokedAt: Date,
    replayDetectedAt?: Date,
  ): Promise<void> {
    const exactFamily = await client.query(
      `SELECT 1
       FROM mcp_refresh_token_families
       WHERE family_id = $1
         AND oauth_installation_id = $2
         AND binding_id = $3
         AND connection_id = $4`,
      [familyId, installationId, bindingId, connectionId],
    );
    if (exactFamily.rowCount !== 1) return;
    await this.#revokeMcpInstallationGrant(
      client,
      installationId,
      revokedAt,
      familyId,
      replayDetectedAt,
    );
  }

  async #revokeMcpInstallationGrant(
    client: PoolClient,
    installationId: string,
    revokedAt: Date,
    replayFamilyId?: string,
    replayDetectedAt?: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE mcp_refresh_tokens refresh_token SET
         revoked_at = COALESCE(refresh_token.revoked_at, $2)
       FROM mcp_refresh_token_families family
       WHERE refresh_token.family_id = family.family_id
         AND family.oauth_installation_id = $1`,
      [installationId, revokedAt],
    );
    await client.query(
      `UPDATE mcp_access_tokens SET
         revoked_at = COALESCE(revoked_at, $2)
       WHERE oauth_installation_id = $1`,
      [installationId, revokedAt],
    );
    await client.query(
      `UPDATE mcp_refresh_token_families SET
         family_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         replay_detected_at = CASE
           WHEN family_id = $3 THEN COALESCE(replay_detected_at, $4)
           ELSE replay_detected_at
         END,
         updated_at = $2
       WHERE oauth_installation_id = $1`,
      [installationId, revokedAt, replayFamilyId ?? null, replayDetectedAt ?? null],
    );
    await client.query(
      `UPDATE agent_connection_bindings SET
         binding_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         updated_at = $2
       WHERE oauth_installation_id = $1`,
      [installationId, revokedAt],
    );
    await client.query(
      `UPDATE oauth_installations SET
         installation_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         updated_at = $2
       WHERE installation_id = $1`,
      [installationId, revokedAt],
    );
  }

  async #revokePendingBrokerGrant(client: PoolClient, flow: Row, revokedAt: Date): Promise<void> {
    if (flow.flow_status !== "AWAITING_SELECTION" || !flow.authorization_id) return;
    const exactPendingGrant = await client.query(
      `SELECT installation.installation_id, provider_auth.authorization_id
       FROM oauth_installations installation
       JOIN provider_authorizations provider_auth ON provider_auth.authorization_id = $2
       WHERE installation.installation_id = $1
         AND installation.workspace_id = $3
         AND installation.subject_type = $4
         AND installation.subject_id = $5
         AND installation.agent_id = $6
         AND installation.oauth_client_id = $7
         AND installation.installation_status = 'PENDING'
         AND provider_auth.workspace_id = $3
         AND provider_auth.authorized_by_subject = $5
       FOR UPDATE OF installation, provider_auth`,
      [
        flow.oauth_installation_id,
        flow.authorization_id,
        flow.workspace_id,
        flow.subject_type,
        flow.subject_id,
        flow.agent_id,
        flow.oauth_client_id,
      ],
    );
    if (exactPendingGrant.rowCount !== 1) return;

    await client.query(
      `UPDATE provider_connections SET
         connection_status = 'REVOKED',
         updated_at = $2
       WHERE authorization_id = $1
         AND connection_status <> 'REVOKED'`,
      [flow.authorization_id, revokedAt],
    );
    await client.query(
      `UPDATE provider_authorizations SET
         authorization_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         updated_at = $2
       WHERE authorization_id = $1
         AND workspace_id = $3
         AND authorized_by_subject = $4
         AND authorization_status <> 'REVOKED'`,
      [flow.authorization_id, revokedAt, flow.workspace_id, flow.subject_id],
    );
    await client.query(
      `UPDATE oauth_installations SET
         installation_status = 'REVOKED',
         revoked_at = COALESCE(revoked_at, $2),
         updated_at = $2
       WHERE installation_id = $1
         AND workspace_id = $3
         AND installation_status = 'PENDING'`,
      [flow.oauth_installation_id, revokedAt, flow.workspace_id],
    );
  }

  async #lockMcpRefreshFamily(client: PoolClient, familyId: string): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, $2::bigint))",
      [familyId, MCP_REFRESH_FAMILY_ADVISORY_SALT],
    );
  }

  async #safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection cleanup will handle an already-closed transaction.
    }
  }
}
