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

export interface EphemeralCleanupCounts {
  mcpRefreshRetryResponses: number;
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

export interface FindActiveXeroPostingDuplicateInput {
  tenantId: string;
  sourceSha256: string;
  documentType?: XeroPostingDocumentType;
  contactId?: string;
  normalizedReference?: string;
}

export interface AccountingRepository {
  readiness(): Promise<boolean>;

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
  markXeroMutationWriteUnknown(input: MarkXeroMutationWriteUnknownInput): Promise<XeroMutationRequest>;
  markXeroMutationReadbackVerified(input: CompleteXeroMutationReadbackInput): Promise<XeroMutationRequest>;
  markXeroMutationReadbackMismatch(input: CompleteXeroMutationReadbackInput): Promise<XeroMutationRequest>;
  failXeroMutationValidation(input: FailXeroMutationValidationInput): Promise<XeroMutationRequest>;
  rejectXeroMutationProvider(input: RejectXeroMutationProviderInput): Promise<XeroMutationRequest>;

  beginAudit(intent: AuditIntent): Promise<void>;
  completeAudit(callId: string, completion: AuditCompletion): Promise<void>;
  appendAudit(record: AuditRecord): Promise<void>;
}
