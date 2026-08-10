export type ConnectionStatus = "ACTIVE" | "TOKEN_REFRESH_FAILED" | "REVOKED";

export interface ProviderConnection {
  connectionId: string;
  actorId: string;
  provider: "xero";
  tenantId: string;
  tenantName: string;
  tenantShortCode?: string;
  grantedScopes: string[];
  tokenCiphertext: string;
  tokenExpiresAt: Date;
  refreshVersion: number;
  status: ConnectionStatus;
  /** Phase 2 expand field. Legacy connections may not have an Authorization yet. */
  authorizationId?: string;
  /** Xero's official connection identifier returned by GET /connections. */
  providerConnectionId?: string;
  lastVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ProviderAuthorizationStatus = "ACTIVE" | "TOKEN_REFRESH_FAILED" | "REVOKED";

/**
 * Owns the provider OAuth token set. A provider connection deliberately does
 * not own new-model credentials: one Authorization can expose several Xero
 * organisations.
 */
export interface ProviderAuthorization {
  authorizationId: string;
  workspaceId: string;
  authorizedBySubject: string;
  provider: "xero";
  providerSubject?: string;
  grantedScopes: string[];
  tokenCiphertext: string;
  tokenExpiresAt: Date;
  refreshVersion: number;
  status: ProviderAuthorizationStatus;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** New-model connection shape. Provider credentials remain on Authorization. */
export interface AuthorizedProviderConnection {
  connectionId: string;
  authorizationId: string;
  provider: "xero";
  providerConnectionId?: string;
  tenantId: string;
  tenantName: string;
  tenantShortCode?: string;
  status: ConnectionStatus;
  lastVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type BindingSubjectType = "USER" | "TEAM";
export type OAuthInstallationStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
export type AgentConnectionBindingStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface OAuthInstallation {
  installationId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  clientId: string;
  status: OAuthInstallationStatus;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentConnectionBinding {
  bindingId: string;
  installationId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  connectionId: string;
  policyId: string;
  status: AgentConnectionBindingStatus;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolveAgentConnectionBindingInput {
  installationId: string;
  bindingId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  connectionId: string;
}

/** Safe control-plane view: no Xero or MCP token material is returned. */
export interface ResolvedAgentConnectionBinding {
  installationId: string;
  bindingId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  connectionId: string;
  authorizationId: string;
  tenantId: string;
  tenantName: string;
  providerConnectionId?: string;
  policyId: string;
}

export interface OAuthBrokerFlow {
  flowHash: string;
  browserSessionHash: string;
  clientId: string;
  redirectUri: string;
  pkceCodeChallenge: string;
  pkceCodeChallengeMethod: "S256";
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  requestedScopes: string[];
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
}

export interface ConsumeOAuthBrokerFlowInput {
  flowHash: string;
  browserSessionHash: string;
  clientId: string;
  redirectUri: string;
  now: Date;
}

export type OAuthBrokerFlowStatus =
  | "AUTHORIZING_XERO"
  | "EXCHANGING_XERO"
  | "AWAITING_SELECTION"
  | "COMPLETED"
  | "DENIED"
  | "FAILED";

/**
 * Complete V2 browser-flow record. Every secret-like browser value is already
 * keyed-hashed or encrypted before it reaches the repository; raw state,
 * cookies, CSRF values, authorization codes, and tokens are never represented.
 */
export interface OAuthBrokerAuthorizationFlow {
  flowHash: string;
  browserSessionHash: string;
  xeroStateHash: string;
  outerStateHash: string;
  outerStateCiphertext?: string;
  clientId: string;
  redirectUri: string;
  pkceCodeChallenge: string;
  pkceCodeChallengeMethod: "S256";
  resource: string;
  audience: string;
  requestedScopes: string[];
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  installationId: string;
  personalPoc: boolean;
  status: OAuthBrokerFlowStatus;
  authorizationId?: string;
  selectionCsrfHash?: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBrokerAuthorizationFlowInput {
  installation: OAuthInstallation;
  flow: OAuthBrokerAuthorizationFlow;
}

export interface CreateBrokerAuthorizationFlowResult {
  installation: OAuthInstallation;
  flow: OAuthBrokerAuthorizationFlow;
}

export interface BeginBrokerXeroCallbackInput {
  flowHash: string;
  browserSessionHash: string;
  xeroStateHash: string;
  now: Date;
}

export interface CompleteBrokerXeroExchangeInput {
  flowHash: string;
  browserSessionHash: string;
  authorization: ProviderAuthorization;
  connections: AuthorizedProviderConnection[];
  selectionCsrfHash: string;
  now: Date;
}

export interface GetBrokerSelectionInput {
  flowHash: string;
  browserSessionHash: string;
  now: Date;
}

export interface BrokerSelectionContext {
  flow: OAuthBrokerAuthorizationFlow;
  connections: AuthorizedProviderConnection[];
}

export interface CompleteBrokerOrganisationSelectionInput {
  flowHash: string;
  browserSessionHash: string;
  selectionCsrfHash: string;
  selectedConnectionId: string;
  bindingId: string;
  policyId: string;
  authorizationCodeHash: string;
  authorizationCodeExpiresAt: Date;
  now: Date;
}

export interface CompleteBrokerOrganisationSelectionResult {
  flow: OAuthBrokerAuthorizationFlow;
  installation: OAuthInstallation;
  binding: AgentConnectionBinding;
  authorizationCode: OAuthAuthorizationCode;
  /** Encrypted Host state captured before the terminal flow record is scrubbed. */
  outerStateCiphertext: string;
}

export interface TerminateBrokerAuthorizationFlowInput {
  flowHash: string;
  browserSessionHash: string;
  terminalStatus: "DENIED" | "FAILED";
  now: Date;
}

export interface TerminateBrokerAuthorizationFlowResult {
  flow: OAuthBrokerAuthorizationFlow;
  outerStateCiphertext: string;
}

export interface OAuthAuthorizationCode {
  codeHash: string;
  /** Consumed broker flow that authorized this code and bounds its scopes/client/PKCE tuple. */
  flowHash: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  clientId: string;
  redirectUri: string;
  pkceCodeChallenge: string;
  pkceCodeChallengeMethod: "S256";
  resource: string;
  audience: string;
  grantedScopes: string[];
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
}

export interface ConsumeOAuthAuthorizationCodeInput {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  /** SHA-256 challenge derived from the presented PKCE verifier. */
  pkceCodeChallenge: string;
  now: Date;
}

/** Final token-endpoint grant tuple; preview results never replace this atomic judgement. */
export interface ExchangeOAuthAuthorizationCodeGrantInput extends ConsumeOAuthAuthorizationCodeInput {
  expectedResource: string;
}

export interface PeekOAuthAuthorizationCodeForExchangeInput {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  pkceCodeChallenge: string;
  expectedResource: string;
  now: Date;
}

export interface OAuthAuthorizationCodeExchangePreview {
  codeHash: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  expiresAt: Date;
}

export interface McpAccessToken {
  tokenHash: string;
  tokenId: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  refreshFamilyId?: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface ResolveMcpAccessTokenInput {
  tokenHash: string;
  expectedResource: string;
  expectedAudience: string;
  now: Date;
}

export interface ResolvedMcpAccessToken {
  tokenId: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  installationId: string;
  bindingId: string;
  connectionId: string;
  authorizationId: string;
  workspaceId: string;
  subjectType: BindingSubjectType;
  subjectId: string;
  agentId: string;
  policyId: string;
  tenantId: string;
}

export type McpRefreshTokenFamilyStatus = "ACTIVE" | "REVOKED";

/**
 * A short idempotency window for OAuth clients that fan out multiple refresh
 * requests after observing the same 401. Requests outside this window retain
 * strict refresh-token replay revocation semantics.
 */
export const MCP_OAUTH_REFRESH_RETRY_GRACE_MS = 10_000;

export interface McpRefreshTokenFamily {
  familyId: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  status: McpRefreshTokenFamilyStatus;
  replayDetectedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Only token hashes are represented or persisted; raw refresh tokens stay at the edge. */
export interface McpRefreshToken {
  tokenHash: string;
  tokenId: string;
  familyId: string;
  parentTokenHash?: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  revokedAt?: Date;
  replacedByTokenHash?: string;
  retryAccessTokenHash?: string;
  retryResponseCiphertext?: string;
  retryExpiresAt?: Date;
}

export interface CreateMcpRefreshTokenFamilyInput {
  family: McpRefreshTokenFamily;
  initialToken: McpRefreshToken;
}

export interface ExchangeOAuthAuthorizationCodeForTokenSetInput {
  grant: ExchangeOAuthAuthorizationCodeGrantInput;
  accessToken: McpAccessToken;
  refreshTokenFamily: CreateMcpRefreshTokenFamilyInput;
}

export type ExchangeOAuthAuthorizationCodeForTokenSetResult =
  | {
      status: "ISSUED";
      authorizationCode: OAuthAuthorizationCode;
      accessToken: McpAccessToken;
      refreshToken: McpRefreshToken;
    }
  | { status: "INVALID" };

export interface RotateMcpRefreshTokenInput {
  currentTokenHash: string;
  expectedClientId: string;
  expectedResource: string;
  expectedAudience: string;
  /** Optional OAuth refresh scope request. Omission preserves the family's full granted scope set. */
  requestedScopes?: string[];
  newTokenHash: string;
  newTokenId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export type RotateMcpRefreshTokenResult =
  | {
      status: "ROTATED";
      familyId: string;
      refreshToken: McpRefreshToken;
      installationId: string;
      bindingId: string;
      connectionId: string;
      grantedScopes: string[];
    }
  | { status: "REPLAY_DETECTED"; familyId: string }
  | { status: "INVALID" };

export interface RotateMcpRefreshTokenAndIssueAccessTokenInput {
  rotation: RotateMcpRefreshTokenInput;
  accessToken: McpAccessToken;
  retryResponseCiphertext: string;
  retryExpiresAt: Date;
}

export interface PeekMcpRefreshTokenContextInput {
  tokenHash: string;
  clientId: string;
  expectedResource: string;
  expectedAudience: string;
  now: Date;
}

export interface McpRefreshTokenContextPreview {
  familyId: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  clientId: string;
  resource: string;
  audience: string;
  grantedScopes: string[];
  consumed: boolean;
  expiresAt: Date;
}

export interface RevokeOAuthTokenForClientInput {
  tokenHash: string;
  clientId: string;
  revokedAt: Date;
}

export interface RevokeOAuthTokenForClientResult {
  status: "ACCEPTED";
}

export type RotateMcpRefreshTokenAndIssueAccessTokenResult =
  | {
      status: "ROTATED";
      familyId: string;
      refreshToken: McpRefreshToken;
      accessToken: McpAccessToken;
      installationId: string;
      bindingId: string;
      connectionId: string;
      grantedScopes: string[];
    }
  | {
      status: "COALESCED";
      sourceTokenHash: string;
      accessTokenHash: string;
      refreshTokenHash: string;
      responseCiphertext: string;
      grantedScopes: string[];
    }
  | { status: "REPLAY_DETECTED"; familyId: string }
  | { status: "INVALID" };

export type PostingState =
  | "VALIDATED"
  | "DRAFT_READBACK_VERIFIED"
  | "APPROVAL_PENDING"
  | "APPROVED"
  | "AUTHORISING"
  | "AUTHORISED_READBACK_VERIFIED"
  | "REJECTED"
  | "BLOCKED_VALIDATION"
  | "WRITE_RESULT_UNKNOWN"
  | "READBACK_MISMATCH";

export type SourceEvidenceType =
  | "LEGACY_UNVERIFIED"
  | "AGENT_ASSERTED_UNVERIFIED"
  | "SERVER_FINGERPRINTED_EXTRACTION";

export type XeroPostingDocumentType = "ACCPAY" | "ACCREC";

export interface PostingRequest {
  postingRequestId: string;
  actorId: string;
  tenantId: string;
  sourceRef: string;
  sourceSha256: string;
  sourceEvidenceType: SourceEvidenceType;
  documentType: XeroPostingDocumentType;
  providerPayload: Record<string, unknown>;
  requestPayloadHash: string;
  providerPayloadHash: string;
  xeroInvoiceId?: string;
  state: PostingState;
  requestId: string;
  createIdempotencyKey: string;
  authoriseRequestId?: string;
  authoriseIdempotencyKey?: string;
  approvalRefHash?: string;
  approvedBy?: string;
  approvedAt?: Date;
  approvalExpiresAt?: Date;
  approvalConsumedAt?: Date;
  /** Latest provider evidence retained for backward-compatible operational views. */
  writeReceipt?: Record<string, unknown>;
  readbackSnapshot?: Record<string, unknown>;
  /** Immutable evidence from the original Xero DRAFT create/recovery phase. */
  draftWriteReceipt?: Record<string, unknown>;
  draftReadbackSnapshot?: Record<string, unknown>;
  /** Immutable evidence from the terminal Xero authorisation/recovery phase. */
  authoriseWriteReceipt?: Record<string, unknown>;
  authoriseReadbackSnapshot?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRecord {
  callId: string;
  actorId: string;
  tenantId?: string;
  toolName: string;
  requestHash: string;
  resultStatus: "SUCCEEDED" | "REJECTED" | "FAILED";
  providerRequestId?: string;
  recordId?: string;
  errorClass?: string;
  startedAt: Date;
  finishedAt: Date;
}

export interface AuditIntent {
  callId: string;
  actorId: string;
  tenantId?: string;
  toolName: string;
  requestHash: string;
  resultStatus: "IN_PROGRESS";
  startedAt: Date;
}

export interface AuditCompletion {
  resultStatus: AuditRecord["resultStatus"];
  providerRequestId?: string;
  recordId?: string;
  errorClass?: string;
  finishedAt: Date;
}

export type AuditLog = AuditIntent | AuditRecord;

export interface CreatePostingInput {
  postingRequestId: string;
  actorId: string;
  tenantId: string;
  sourceRef: string;
  sourceSha256: string;
  sourceEvidenceType: SourceEvidenceType;
  /** Legacy callers omit this and remain ACCPAY; every new write path must set it explicitly. */
  documentType?: XeroPostingDocumentType;
  providerPayload: Record<string, unknown>;
  requestPayloadHash: string;
  providerPayloadHash: string;
  requestId: string;
  createIdempotencyKey: string;
}

export interface DraftCreatedUpdate {
  xeroInvoiceId: string;
  providerPayload: Record<string, unknown>;
  providerPayloadHash: string;
  writeReceipt: Record<string, unknown>;
  readbackSnapshot: Record<string, unknown>;
}

export interface DraftReadbackMismatchUpdate {
  xeroInvoiceId: string;
  writeReceipt: Record<string, unknown>;
  readbackSnapshot: Record<string, unknown>;
}

export type AuthoriseMode = "CALL_PROVIDER" | "RESUME_READBACK_ONLY" | "ALREADY_COMPLETE";

export interface BeginAuthoriseInput {
  postingRequestId: string;
  actorId: string;
  tenantId: string;
  invoiceId: string;
  approvalRefHash: string;
  approvedPayloadHash: string;
  requestId: string;
  idempotencyKey: string;
  now: Date;
}

export interface BeginAuthoriseResult {
  posting: PostingRequest;
  mode: AuthoriseMode;
}

export interface BeginReviewAuthoriseInput extends BeginAuthoriseInput {
  sessionHash: string;
  csrfHash: string;
  approvalExpiresAt: Date;
}

export interface RejectReviewInput {
  postingRequestId: string;
  actorId: string;
  sessionHash: string;
  csrfHash: string;
  now: Date;
}
