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
  McpAccessToken,
  McpRefreshTokenContextPreview,
  OAuthAuthorizationCode,
  OAuthAuthorizationCodeExchangePreview,
  OAuthBrokerAuthorizationFlow,
  OAuthBrokerFlow,
  OAuthInstallation,
  OrganisationSwitchContext,
  OrganisationSwitchSession,
  LedgerTargetSession,
  ResolveLedgerTargetSessionInput,
  ResolvedLedgerTargetSession,
  PostingRequest,
  PostingState,
  PeekMcpRefreshTokenContextInput,
  PeekOAuthAuthorizationCodeForExchangeInput,
  ProviderAuthorization,
  ProviderConnection,
  RejectReviewInput,
  ResolveAgentConnectionBindingInput,
  ResolvedAgentConnectionBinding,
  ResolvedMcpAccessToken,
  ResolveMcpAccessTokenInput,
  RevokeOAuthTokenForClientInput,
  RevokeOAuthTokenForClientResult,
  RotateMcpRefreshTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenResult,
  RotateMcpRefreshTokenResult,
  TerminateBrokerAuthorizationFlowInput,
  TerminateBrokerAuthorizationFlowResult,
  GetBrokerSelectionInput,
  GovernanceAuditEvent,
  GovernanceAuditEventInput,
  XeroPostingDocumentType,
} from "../domain/models.js";
import type {
  BeginXeroMutationWriteInput,
  BeginXeroMutationWriteResult,
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

/** Durable CAS marker for one bounded native-idempotency recovery replay. */
export interface XeroNativeIdempotencyRecoveryClaim {
  receiptType: "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM";
  claimId: string;
  mutationRequestId: string;
  canonicalPayloadHash: string;
  actionId: string;
  adapterOperation: string;
  tenantId: string;
  actorId: string;
  workspaceId: string;
  agentId: string;
  installationId: string;
  bindingId: string;
  bindingRevision: number;
  connectionId: string;
  targetSessionId: string;
  authoritySnapshotRevision: number;
  authoritySnapshotHash: string;
  claimedAt: string;
  expiresAt: string;
}

export const XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS = 5 * 60 * 1_000;
export const XERO_NATIVE_RECOVERY_ADAPTER_BY_ACTION = Object.freeze({
  "supplier_bill.create_draft": "XeroAccountingProvider.createDraftSupplierBill",
  "customer_invoice.create_draft": "XeroAccountingProvider.createDraftSalesInvoice",
  "quote.create_draft": "XeroControlledMutationProvider.createQuoteDraft",
  "purchase_order.create_draft": "XeroControlledMutationProvider.createPurchaseOrderDraft",
  "credit_note.create_draft": "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
  "manual_journal.create_draft": "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
} as const);

export type XeroNativeRecoveryWriteUnknownInput = MarkXeroMutationWriteUnknownInput & {
  nativeRecoveryClaim?: XeroNativeIdempotencyRecoveryClaim;
};
import type {
  AdoptExpiredExecutingAccountingCaseForRecoveryInput,
  AdoptExpiredExecutingAccountingCaseForRecoveryResult,
  ClaimAccountingCaseExecutionInput,
  ClaimAccountingCaseExecutionResult,
  CompleteExpiredTargetAccountingCaseRecoveryInput,
  CreateOrAdvanceAccountingCaseInput,
  CreateOrAdvanceAccountingCaseResult,
  FinalizeAccountingCaseInput,
  AwaitAccountingCaseContinuationInput,
  GetAccessibleAccountingCaseInput,
  GetAccountingCaseRecoveryResidualGrantInput,
  GetAccountingCaseRecoveryResidualGrantResult,
  GetBoundAccountingCaseInput,
  AccountingCaseVersionRecord,
  RecordAccountingCasePreflightInput,
  RecordAccountingCasePreflightResult,
  ResealAndClaimAccountingCaseExecutionInput,
  ResealAndClaimAccountingCaseExecutionResult,
  PauseAccountingCaseExecutionInput,
  ProjectAccountingCaseOperationFromMutationInput,
  ReleaseAccountingCaseRecoveryInput,
  UpdateAccountingCaseOperationInput,
} from "../domain/accountingCasePersistence.js";
import type {
  LedgerAuthoritySnapshot,
  LedgerAuthorityRepositoryReadiness,
  LedgerFirmGovernanceReadinessEvidence,
  PublishLedgerAuthoritySnapshotInput,
  PublishLedgerAuthoritySnapshotResult,
} from "../domain/ledgerAuthority.js";
import type { ActiveAccountingCaseRecoveryProjectionEvidence } from "./accountingCaseRecoveryProjectionReadiness.js";

export interface EphemeralCleanupCounts {
  mcpRefreshRetryResponses: number;
  organisationSwitchSessions: number;
  ledgerTargetSessions: number;
  oauthBrokerFlows: number;
  oauthStates: number;
  connectTickets: number;
  operatorSessions: number;
  reviewCsrfTokens: number;
}

export interface EphemeralCleanupBatchResult {
  lockAcquired: boolean;
  deleted: EphemeralCleanupCounts;
}

export type RepositoryStorageMode = "POSTGRES" | "IN_MEMORY" | "UNKNOWN";

export type RequiredMigrationStatus = "APPLIED" | "MISSING" | "NOT_APPLICABLE" | "UNKNOWN";

/**
 * Safe, public readiness evidence. Implementations must not include connection
 * strings, SQL errors, tenant identifiers, or other configuration values.
 */
export interface RepositoryReadinessEvidence {
  ready: boolean;
  storageMode: RepositoryStorageMode;
  requiredMigration: string;
  requiredMigrationStatus: RequiredMigrationStatus;
  migrationHead: string | null;
  activeAccountingCaseRecoveryProjection: ActiveAccountingCaseRecoveryProjectionEvidence;
  /** Same REPEATABLE READ transaction and repository clock as the other readiness facts. */
  authoritySnapshotRevision: number | null;
  authoritySnapshotHash: string | null;
  authorityWriteKillSwitchEnabled: boolean | null;
  firmGovernance: LedgerFirmGovernanceReadinessEvidence;
}

export interface FindActiveXeroPostingDuplicateInput {
  tenantId: string;
  sourceSha256: string;
  documentType?: XeroPostingDocumentType;
  contactId?: string;
  normalizedReference?: string;
}

export interface FindVerifiedAccountingCaseContactIdentityInput {
  tenantId: string;
  businessIdentityHash: string;
}

export interface ListVerifiedAccountingCaseContactIdentitiesInput {
  tenantId: string;
  contactId: string;
}

export interface AccountingRepository {
  readiness(): Promise<boolean>;
  /**
   * Optional for compatibility with narrow test doubles. The HTTP edge treats
   * an absent implementation as unknown evidence and therefore not ready.
   */
  readinessEvidence?(requiredMigration: string): Promise<RepositoryReadinessEvidence>;

  publishLedgerAuthoritySnapshot(
    input: PublishLedgerAuthoritySnapshotInput,
  ): Promise<PublishLedgerAuthoritySnapshotResult>;
  getLedgerAuthoritySnapshot(providerId: string): Promise<LedgerAuthoritySnapshot | undefined>;
  /** Same-row snapshot and repository-clock governance aggregate for /readyz. */
  ledgerAuthorityReadiness?(providerId: string): Promise<LedgerAuthorityRepositoryReadiness>;

  saveProviderAuthorization(authorization: ProviderAuthorization): Promise<ProviderAuthorization>;
  getProviderAuthorization(
    authorizationId: string,
    workspaceId: string,
    authorizedBySubject: string,
  ): Promise<ProviderAuthorization | undefined>;
  updateProviderAuthorizationToken(
    authorizationId: string,
    workspaceId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
    grantedScopes: string[],
  ): Promise<ProviderAuthorization | undefined>;
  markProviderAuthorizationStatus(
    authorizationId: string,
    workspaceId: string,
    status: ProviderAuthorization["status"],
    changedAt: Date,
  ): Promise<boolean>;

  upsertAuthorizedProviderConnection(
    workspaceId: string,
    connection: AuthorizedProviderConnection,
  ): Promise<AuthorizedProviderConnection>;
  listActiveConnectionsByAuthorization(
    authorizationId: string,
    workspaceId: string,
  ): Promise<AuthorizedProviderConnection[]>;

  saveOAuthInstallation(installation: OAuthInstallation): Promise<OAuthInstallation>;
  saveAgentConnectionBinding(binding: AgentConnectionBinding): Promise<AgentConnectionBinding>;
  resolveAgentConnectionBinding(
    input: ResolveAgentConnectionBindingInput,
  ): Promise<ResolvedAgentConnectionBinding | undefined>;
  saveOrganisationSwitchSession(session: OrganisationSwitchSession): Promise<void>;
  getOrganisationSwitchContext(
    sessionHash: string,
    now: Date,
  ): Promise<OrganisationSwitchContext | undefined>;
  completeOrganisationSwitch(
    input: CompleteOrganisationSwitchInput,
  ): Promise<CompleteOrganisationSwitchResult | undefined>;
  saveLedgerTargetSession(session: LedgerTargetSession): Promise<void>;
  resolveLedgerTargetSession(
    input: ResolveLedgerTargetSessionInput,
  ): Promise<ResolvedLedgerTargetSession | undefined>;
  revokeLedgerTargetSession(
    sessionHash: string,
    installationId: string,
    revokedAt: Date,
  ): Promise<boolean>;
  revokeOAuthInstallation(installationId: string, workspaceId: string, revokedAt: Date): Promise<boolean>;

  saveOAuthBrokerFlow(flow: OAuthBrokerFlow): Promise<void>;
  consumeOAuthBrokerFlow(input: ConsumeOAuthBrokerFlowInput): Promise<OAuthBrokerFlow | undefined>;
  createBrokerAuthorizationFlow(
    input: CreateBrokerAuthorizationFlowInput,
  ): Promise<CreateBrokerAuthorizationFlowResult>;
  beginBrokerXeroCallback(
    input: BeginBrokerXeroCallbackInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined>;
  completeBrokerXeroExchange(
    input: CompleteBrokerXeroExchangeInput,
  ): Promise<OAuthBrokerAuthorizationFlow | undefined>;
  getBrokerSelection(input: GetBrokerSelectionInput): Promise<BrokerSelectionContext | undefined>;
  completeBrokerOrganisationSelection(
    input: CompleteBrokerOrganisationSelectionInput,
  ): Promise<CompleteBrokerOrganisationSelectionResult | undefined>;
  terminateBrokerAuthorizationFlow(
    input: TerminateBrokerAuthorizationFlowInput,
  ): Promise<TerminateBrokerAuthorizationFlowResult | undefined>;
  saveOAuthAuthorizationCode(code: OAuthAuthorizationCode): Promise<void>;
  peekOAuthAuthorizationCodeForExchange(
    input: PeekOAuthAuthorizationCodeForExchangeInput,
  ): Promise<OAuthAuthorizationCodeExchangePreview | undefined>;
  /** Low-level compatibility primitive. Broker token endpoints must use the composite exchange below. */
  consumeOAuthAuthorizationCode(
    input: ConsumeOAuthAuthorizationCodeInput,
  ): Promise<OAuthAuthorizationCode | undefined>;
  exchangeOAuthAuthorizationCodeForTokenSet(
    input: ExchangeOAuthAuthorizationCodeForTokenSetInput,
  ): Promise<ExchangeOAuthAuthorizationCodeForTokenSetResult>;

  saveMcpAccessToken(token: McpAccessToken): Promise<void>;
  resolveMcpAccessToken(input: ResolveMcpAccessTokenInput): Promise<ResolvedMcpAccessToken | undefined>;
  revokeMcpAccessToken(tokenHash: string, revokedAt: Date): Promise<boolean>;
  createMcpRefreshTokenFamily(input: CreateMcpRefreshTokenFamilyInput): Promise<void>;
  peekMcpRefreshTokenContext(
    input: PeekMcpRefreshTokenContextInput,
  ): Promise<McpRefreshTokenContextPreview | undefined>;
  /** Low-level compatibility primitive. Broker refresh endpoints must use the composite rotation below. */
  rotateMcpRefreshToken(input: RotateMcpRefreshTokenInput): Promise<RotateMcpRefreshTokenResult>;
  rotateMcpRefreshTokenAndIssueAccessToken(
    input: RotateMcpRefreshTokenAndIssueAccessTokenInput,
  ): Promise<RotateMcpRefreshTokenAndIssueAccessTokenResult>;
  revokeMcpRefreshTokenFamilyByTokenHash(tokenHash: string, revokedAt: Date): Promise<boolean>;
  /**
   * Client-safe RFC 7009 operation: unknown/wrong-client tokens are indistinguishable;
   * access tokens revoke only themselves, while refresh tokens disconnect their exact grant tuple.
   */
  revokeOAuthTokenForClient(
    input: RevokeOAuthTokenForClientInput,
  ): Promise<RevokeOAuthTokenForClientResult>;

  saveOAuthState(stateHash: string, browserSessionHash: string, actorId: string, expiresAt: Date): Promise<void>;
  consumeOAuthState(
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<{ actorId: string } | undefined>;

  saveConnectTicket(ticketHash: string, actorId: string, expiresAt: Date): Promise<void>;
  consumeConnectTicket(ticketHash: string, now: Date): Promise<{ actorId: string } | undefined>;

  saveOperatorSession(sessionHash: string, actorId: string, expiresAt: Date): Promise<void>;
  getOperatorSession(sessionHash: string, now: Date): Promise<{ actorId: string } | undefined>;
  revokeOperatorSessions(actorId: string): Promise<number>;
  saveReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    expiresAt: Date,
  ): Promise<void>;
  consumeReviewCsrf(
    csrfHash: string,
    sessionHash: string,
    actorId: string,
    postingRequestId: string,
    now: Date,
  ): Promise<boolean>;
  cleanupExpiredEphemeral(
    cutoff: Date,
    batchSize: number,
    /** Broker outer-state ciphertext has no grace period; pass the current time here. */
    brokerFlowCutoff?: Date,
  ): Promise<EphemeralCleanupBatchResult>;

  getConnectionByActorTenant(actorId: string, tenantId: string): Promise<ProviderConnection | undefined>;
  listActiveConnections(actorId: string): Promise<ProviderConnection[]>;
  upsertConnection(connection: ProviderConnection): Promise<ProviderConnection>;
  updateConnectionToken(
    connectionId: string,
    expectedRefreshVersion: number,
    tokenCiphertext: string,
    tokenExpiresAt: Date,
  ): Promise<ProviderConnection | undefined>;
  markConnectionStatus(connectionId: string, status: ProviderConnection["status"]): Promise<void>;
  markConnectionStatusIfVersion(
    connectionId: string,
    expectedRefreshVersion: number,
    status: ProviderConnection["status"],
  ): Promise<boolean>;

  createOrGetPosting(input: CreatePostingInput): Promise<{ posting: PostingRequest; created: boolean }>;
  findActivePostingDuplicate(
    input: FindActiveXeroPostingDuplicateInput,
  ): Promise<PostingRequest | undefined>;
  getPosting(postingRequestId: string): Promise<PostingRequest | undefined>;
  markDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest>;
  recoverDraftCreated(postingRequestId: string, update: DraftCreatedUpdate): Promise<PostingRequest>;
  markDraftReadbackMismatch(postingRequestId: string, update: DraftReadbackMismatchUpdate): Promise<void>;
  markDraftWriteUnknown(
    postingRequestId: string,
    xeroInvoiceId?: string,
    writeReceipt?: Record<string, unknown>,
  ): Promise<void>;
  markPostingState(postingRequestId: string, state: PostingState): Promise<void>;
  approvePosting(
    postingRequestId: string,
    approvedBy: string,
    approvalRefHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<PostingRequest>;
  rejectPosting(postingRequestId: string, rejectedBy: string, now: Date): Promise<PostingRequest>;
  beginAuthorise(input: BeginAuthoriseInput): Promise<BeginAuthoriseResult>;
  beginReviewAuthorise(input: BeginReviewAuthoriseInput): Promise<BeginAuthoriseResult>;
  rejectPostingFromReview(input: RejectReviewInput): Promise<PostingRequest>;
  completeAuthorise(
    postingRequestId: string,
    writeReceipt: Record<string, unknown>,
    readbackSnapshot: Record<string, unknown>,
  ): Promise<PostingRequest>;
  markAuthoriseFailure(
    postingRequestId: string,
    state: "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION",
  ): Promise<void>;

  createXeroMutationPreparation(
    input: CreateXeroMutationPreparationInput,
  ): Promise<XeroMutationPreparation>;
  getXeroMutationPreparation(preparationId: string): Promise<XeroMutationPreparation | undefined>;
  confirmXeroMutationPreparation(
    input: ConfirmXeroMutationPreparationInput,
  ): Promise<ConfirmXeroMutationPreparationResult | undefined>;
  getXeroMutationRequest(mutationRequestId: string): Promise<XeroMutationRequest | undefined>;
  beginXeroMutationWrite(input: BeginXeroMutationWriteInput): Promise<BeginXeroMutationWriteResult>;
  recordXeroMutationWriteEvidence(input: RecordXeroMutationWriteEvidenceInput): Promise<XeroMutationRequest>;
  markXeroMutationWriteUnknown(input: XeroNativeRecoveryWriteUnknownInput): Promise<XeroMutationRequest>;
  markXeroMutationReadbackVerified(input: CompleteXeroMutationReadbackInput): Promise<XeroMutationRequest>;
  markXeroMutationReadbackMismatch(input: CompleteXeroMutationReadbackInput): Promise<XeroMutationRequest>;
  failXeroMutationValidation(input: FailXeroMutationValidationInput): Promise<XeroMutationRequest>;
  rejectXeroMutationProvider(input: RejectXeroMutationProviderInput): Promise<XeroMutationRequest>;

  createOrAdvanceAccountingCase(
    input: CreateOrAdvanceAccountingCaseInput,
  ): Promise<CreateOrAdvanceAccountingCaseResult>;
  getBoundAccountingCase(input: GetBoundAccountingCaseInput): Promise<AccountingCaseVersionRecord | undefined>;
  getAccessibleAccountingCase(
    input: GetAccessibleAccountingCaseInput,
  ): Promise<AccountingCaseVersionRecord | undefined>;
  /**
   * Tenant-bound identity registry backed only by an Accounting Case contact
   * create whose exact provider read-back reached READBACK_VERIFIED.
   */
  findVerifiedAccountingCaseContactIdentity(
    input: FindVerifiedAccountingCaseContactIdentityInput,
  ): Promise<{ contactId: string } | undefined>;
  listVerifiedAccountingCaseContactIdentityHashes(
    input: ListVerifiedAccountingCaseContactIdentitiesInput,
  ): Promise<string[]>;
  recordAccountingCasePreflight(
    input: RecordAccountingCasePreflightInput,
  ): Promise<RecordAccountingCasePreflightResult>;
  claimAccountingCaseExecution(
    input: ClaimAccountingCaseExecutionInput,
  ): Promise<ClaimAccountingCaseExecutionResult>;
  adoptExpiredExecutingAccountingCaseForRecovery(
    input: AdoptExpiredExecutingAccountingCaseForRecoveryInput,
  ): Promise<AdoptExpiredExecutingAccountingCaseForRecoveryResult>;
  resealAndClaimAccountingCaseExecution(
    input: ResealAndClaimAccountingCaseExecutionInput,
  ): Promise<ResealAndClaimAccountingCaseExecutionResult>;
  updateAccountingCaseOperation(
    input: UpdateAccountingCaseOperationInput,
  ): Promise<AccountingCaseVersionRecord>;
  projectAccountingCaseOperationFromMutation(
    input: ProjectAccountingCaseOperationFromMutationInput,
  ): Promise<AccountingCaseVersionRecord>;
  pauseAccountingCaseExecution(
    input: PauseAccountingCaseExecutionInput,
  ): Promise<AccountingCaseVersionRecord>;
  releaseAccountingCaseRecovery(
    input: ReleaseAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord>;
  completeExpiredTargetAccountingCaseRecovery(
    input: CompleteExpiredTargetAccountingCaseRecoveryInput,
  ): Promise<AccountingCaseVersionRecord>;
  getAccountingCaseRecoveryResidualGrant(
    input: GetAccountingCaseRecoveryResidualGrantInput,
  ): Promise<GetAccountingCaseRecoveryResidualGrantResult | undefined>;
  awaitAccountingCaseContinuation(
    input: AwaitAccountingCaseContinuationInput,
  ): Promise<AccountingCaseVersionRecord>;
  finalizeAccountingCase(input: FinalizeAccountingCaseInput): Promise<AccountingCaseVersionRecord>;

  beginAudit(intent: AuditIntent): Promise<void>;
  completeAudit(callId: string, completion: AuditCompletion): Promise<void>;
  appendAudit(record: AuditRecord): Promise<void>;
  appendGovernanceAuditEvent(input: GovernanceAuditEventInput): Promise<GovernanceAuditEvent>;
}
