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
  McpRefreshToken,
  McpRefreshTokenContextPreview,
  McpRefreshTokenFamily,
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
  RevokeOAuthTokenForClientInput,
  RevokeOAuthTokenForClientResult,
  ResolveAgentConnectionBindingInput,
  ResolvedAgentConnectionBinding,
  ResolvedMcpAccessToken,
  ResolveMcpAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenInput,
  RotateMcpRefreshTokenAndIssueAccessTokenResult,
  RotateMcpRefreshTokenInput,
  RotateMcpRefreshTokenResult,
  TerminateBrokerAuthorizationFlowInput,
  TerminateBrokerAuthorizationFlowResult,
  GetBrokerSelectionInput,
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
import { stableStringify } from "../security/hash.js";
import type {
  AccountingRepository,
  EphemeralCleanupBatchResult,
  EphemeralCleanupCounts,
  FindActiveXeroPostingDuplicateInput,
} from "./repository.js";
import {
  isXeroPostingDuplicate,
  xeroSupplierPostingIdentity,
} from "./xeroPostingDuplicate.js";

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
  readonly #providerAuthorizations = new Map<string, ProviderAuthorization>();
  readonly #authorizedConnections = new Map<string, AuthorizedProviderConnection>();
  readonly #oauthInstallations = new Map<string, OAuthInstallation>();
  readonly #agentConnectionBindings = new Map<string, AgentConnectionBinding>();
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
  readonly audits: AuditLog[] = [];

  async readiness(): Promise<boolean> {
    return true;
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
    const installationBinding = [...this.#agentConnectionBindings.values()].find(
      (candidate) => candidate.installationId === binding.installationId && candidate.bindingId !== binding.bindingId,
    );
    if (installationBinding) {
      throw new AppError("CONFLICT", "An OAuth installation can bind only one provider connection.", {
        httpStatus: 409,
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
    return clone(saved);
  }

  async resolveAgentConnectionBinding(
    input: ResolveAgentConnectionBindingInput,
  ): Promise<ResolvedAgentConnectionBinding | undefined> {
    return this.#resolveActiveBinding(input);
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
        candidate.installationId !== flow.installationId && candidate.status === "ACTIVE"
      );
      const staleInstallations: Array<{ installationId: string; familyId: string }> = [];
      for (const candidate of otherActiveInstallations) {
        const samePrincipalAndClient =
          candidate.workspaceId === flow.workspaceId &&
          candidate.subjectType === flow.subjectType &&
          candidate.subjectId === flow.subjectId &&
          candidate.agentId === flow.agentId &&
          candidate.clientId === flow.clientId;
        const families = [...this.#mcpRefreshTokenFamilies.values()].filter((family) =>
          family.installationId === candidate.installationId
        );
        if (
          !samePrincipalAndClient ||
          families.length === 0 ||
          this.#hasUsableMcpRefreshToken(candidate.installationId, input.now)
        ) return undefined;
        staleInstallations.push({
          installationId: candidate.installationId,
          familyId: families[0]!.familyId,
        });
      }
      for (const stale of staleInstallations) {
        this.#revokeRefreshGrant(stale.familyId, input.now);
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
    const binding = this.#resolveActiveBindingByTuple(
      token.installationId,
      token.bindingId,
      token.connectionId,
    );
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
    if (preparation.expiresAt <= input.now) {
      this.#xeroMutationPreparations.set(input.preparationId, {
        ...preparation,
        state: "EXPIRED",
        updatedAt: input.now,
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
      state: "CONFIRMED",
      confirmedAt: input.now,
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
    if (request.state !== "WRITE_IN_FLIGHT") {
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
    input: MarkXeroMutationWriteUnknownInput,
  ): Promise<XeroMutationRequest> {
    const request = this.#requireBoundXeroMutationRequest(input);
    if (request.state !== "WRITE_IN_FLIGHT" && request.state !== "WRITE_UNCERTAIN") {
      throw new AppError("CONFLICT", `Mutation uncertainty cannot be recorded from ${request.state}.`, {
        httpStatus: 409,
      });
    }
    this.#assertCompatibleMutationEvidence(request, input.xeroObjectId, input.writeReceipt);
    if (input.xeroObjectId) this.#assertXeroMutationObjectIdAvailable(request, input.xeroObjectId);
    const updated: XeroMutationRequest = {
      ...request,
      ...(input.xeroObjectId ? { xeroObjectId: input.xeroObjectId } : {}),
      ...(input.writeReceipt ? { writeReceipt: clone(input.writeReceipt) } : {}),
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

  #hasUsableMcpRefreshToken(installationId: string, now: Date): boolean {
    for (const family of this.#mcpRefreshTokenFamilies.values()) {
      if (
        family.installationId !== installationId ||
        family.status !== "ACTIVE" ||
        !this.#resolveActiveBindingByTuple(family.installationId, family.bindingId, family.connectionId)
      ) continue;
      if ([...this.#mcpRefreshTokens.values()].some((token) =>
        token.familyId === family.familyId &&
        !token.revokedAt &&
        !token.consumedAt &&
        token.issuedAt <= now &&
        token.expiresAt > now
      )) return true;
    }
    return false;
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
