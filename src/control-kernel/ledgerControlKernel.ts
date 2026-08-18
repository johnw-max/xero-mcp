import { hashObject, stableStringify } from "../security/hash.js";

export const LEDGER_CONTROL_KERNEL_VERSION = "0.2.0";

export const LEDGER_AUTONOMOUS_DENY_REASONS = [
  "WRITE_KILL_SWITCH_DISABLED",
  "STATIC_ACTION_NOT_RELEASED",
  "TRANSPORT_SCOPE_MISSING",
  "TARGET_SESSION_REQUIRED",
  "TARGET_SESSION_EXPIRED",
  "TARGET_BINDING_INVALID",
  "PROVIDER_CAPABILITY_RECEIPT_MISSING",
  "PROVIDER_ACCESS_DENIED",
  "STANDING_DELEGATION_MISSING",
  "STANDING_DELEGATION_AMBIGUOUS",
  "STANDING_DELEGATION_REVOKED",
  "STANDING_DELEGATION_EXPIRED",
  "STANDING_DELEGATION_TARGET_MISMATCH",
  "STANDING_DELEGATION_ACTION_MISMATCH",
  "FIRM_GOVERNANCE_AUTHORITY_INVALID",
  "FIRM_GOVERNANCE_AUTHORITY_EXPIRED",
  "DETERMINISTIC_VALIDATION_FAILED",
] as const;

export type LedgerAutonomousDenyReason = typeof LEDGER_AUTONOMOUS_DENY_REASONS[number];

export interface LedgerOperationPrincipal {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
}

export interface LedgerOperationTarget {
  readonly providerId: string;
  readonly tenantId: string;
  readonly targetSessionId: string;
  readonly targetSessionExpiresAt: Date;
}

export const LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION =
  "ledger-firm-governance-authority:v1";

export interface LedgerFirmGovernanceRecurringSeriesAuthority {
  readonly authorityId: string;
  readonly revision: number;
  readonly route: string;
  readonly contactId: string;
  readonly normalizedReference: string;
  readonly authoritativeProviderField: string;
  readonly normalizationVersion: string;
  readonly occurrenceKey: "DOCUMENT_DATE";
}

export interface LedgerFirmGovernanceRequirement {
  readonly actionId: string;
  readonly route: string;
  readonly referenceKind: string;
  readonly authoritativeProviderField: string;
}

/**
 * Normalized projection of externally signed firm governance. This proves an
 * accountable writer perimeter; providerAtomicUniqueness is deliberately and
 * permanently false because Xero does not provide this atomicity guarantee.
 */
export interface LedgerFirmGovernanceAuthority {
  readonly schemaVersion: typeof LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION;
  readonly providerId: string;
  readonly tenantId: string;
  readonly authorityId: string;
  readonly revision: number;
  readonly providerAtomicUniqueness: false;
  readonly route: string;
  readonly referenceKind: string;
  readonly authoritativeProviderField: string;
  readonly writerId: string;
  readonly writerKind: "XERO_MCP_INSTALLATION";
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly coordinationDomainId: string;
  /** Digest of canonical signed receipt claims, not the receipt-set file. */
  readonly receiptClaimsSha256: string;
  /** Digest of canonical signed status claims, not the status file. */
  readonly statusClaimsSha256: string;
  /** Whole-file digests pinned by root-owned production admission. */
  readonly trustBundleFileSha256: string;
  readonly receiptsFileSha256: string;
  readonly statusFileSha256: string;
  readonly effectiveExpiresAt: Date;
  readonly firmGovernanceStatement: Readonly<{
    allNonEnumeratedWritersProhibited: true;
    humanXeroUiWritesProhibited: true;
    externalAppWritesProhibited: true;
    importWritesProhibited: true;
  }>;
  readonly recurringSeriesAuthorities: readonly LedgerFirmGovernanceRecurringSeriesAuthority[];
}

export interface LedgerFirmGovernanceClaim extends Omit<
  LedgerFirmGovernanceAuthority,
  "recurringSeriesAuthorities" | "effectiveExpiresAt"
> {
  /** Exact standing delegation/action selected by the kernel. */
  readonly actionId: string;
  readonly delegationId: string;
  readonly delegationRevision: number;
  readonly delegationExpiresAt: string | null;
  /** Original external-authority expiry and the effective minimum expiry. */
  readonly authorityEffectiveExpiresAt: string;
  readonly effectiveExpiresAt: string;
  readonly recurringSeriesAuthority?: LedgerFirmGovernanceRecurringSeriesAuthority;
}

/**
 * A standing delegation is business authority. It is deliberately separate
 * from transport scopes, provider OAuth scopes and the emergency write gate.
 * Every target and action is exact; wildcard grants are not supported.
 */
export interface LedgerStandingDelegation {
  readonly delegationId: string;
  readonly revision: number;
  readonly status: "ACTIVE" | "REVOKED";
  readonly providerId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId?: string;
  /** Server-owned identity of this exact writer inside the firm perimeter. */
  readonly writerId?: string;
  readonly coordinationDomainId?: string;
  readonly tenantIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly expiresAt?: Date;
  /** Server-owned declaration that every covered write needs firm governance. */
  readonly firmGovernanceRequired?: true;
  readonly firmGovernanceRequirements?: readonly LedgerFirmGovernanceRequirement[];
  readonly firmGovernanceAuthorities?: readonly LedgerFirmGovernanceAuthority[];
}

export interface LedgerDeterministicValidation {
  readonly passed: boolean;
  readonly receiptHash?: string;
  readonly reasonCodes?: readonly string[];
}

export interface EvaluateAutonomousLedgerWriteInput {
  readonly actionId: string;
  readonly canonicalPayloadHash: string;
  readonly sourceRevisionHash: string;
  readonly caseVersion: number;
  readonly authoritySnapshotRevision: number;
  readonly authoritySnapshotHash: string;
  readonly principal: LedgerOperationPrincipal;
  readonly target?: LedgerOperationTarget;
  readonly standingDelegations: readonly LedgerStandingDelegation[];
  readonly writeKillSwitchEnabled: boolean;
  readonly staticActionReleased: boolean;
  readonly transportScopeAllowed: boolean;
  /** Provider-specific capability failures, already resolved from live state. */
  readonly providerAccessDenyReasons: readonly string[];
  /** Server-issued proof that live provider capability was evaluated. */
  readonly providerCapabilityReceiptHash?: string;
  /** Exact externally verified projection selected from this durable snapshot. */
  readonly firmGovernanceClaim?: LedgerFirmGovernanceClaim;
  readonly firmGovernanceRequired?: boolean;
  readonly validation: LedgerDeterministicValidation;
  readonly now: Date;
}

export interface LedgerAutonomousAuthorizationReceipt {
  readonly receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION";
  readonly kernelVersion: string;
  readonly actionId: string;
  readonly providerId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
  readonly targetSessionId: string;
  readonly delegationId: string;
  readonly delegationRevision: number;
  readonly canonicalPayloadHash: string;
  readonly sourceRevisionHash: string;
  readonly caseVersion: number;
  readonly authoritySnapshotRevision: number;
  readonly authoritySnapshotHash: string;
  readonly deterministicValidationReceiptHash: string;
  readonly providerCapabilityReceiptHash: string;
  readonly firmGovernanceClaim?: LedgerFirmGovernanceClaim;
  readonly issuedAt: string;
  readonly receiptHash: string;
}

export type LedgerAutonomousAuthorizationDecision = Readonly<
  | {
      allowed: false;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
    }
  | {
      allowed: true;
      denyReasons: readonly LedgerAutonomousDenyReason[];
      providerAccessDenyReasons: readonly string[];
      validationReasonCodes: readonly string[];
      delegation: LedgerStandingDelegation;
      receipt: LedgerAutonomousAuthorizationReceipt;
    }
>;

function exactNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validPrincipal(principal: LedgerOperationPrincipal): boolean {
  return exactNonEmpty(principal.actorId) &&
    exactNonEmpty(principal.workspaceId) &&
    exactNonEmpty(principal.agentId) &&
    exactNonEmpty(principal.installationId) &&
    exactNonEmpty(principal.bindingId) &&
    Number.isSafeInteger(principal.bindingRevision) &&
    principal.bindingRevision > 0 &&
    exactNonEmpty(principal.connectionId);
}

function validTarget(target: LedgerOperationTarget): boolean {
  return exactNonEmpty(target.providerId) &&
    exactNonEmpty(target.tenantId) &&
    exactNonEmpty(target.targetSessionId) &&
    target.targetSessionExpiresAt instanceof Date &&
    Number.isFinite(target.targetSessionExpiresAt.getTime());
}

function matchingSubject(
  delegation: LedgerStandingDelegation,
  input: EvaluateAutonomousLedgerWriteInput,
): boolean {
  return delegation.providerId === input.target?.providerId &&
    delegation.workspaceId === input.principal.workspaceId &&
    delegation.agentId === input.principal.agentId &&
    (delegation.installationId === undefined || delegation.installationId === input.principal.installationId);
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validFirmGovernanceClaim(
  claim: LedgerFirmGovernanceClaim,
  input: EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget },
  delegation: LedgerStandingDelegation,
): boolean {
  const stored = delegation.firmGovernanceAuthorities?.find((candidate) =>
    candidate.providerId === claim.providerId && candidate.tenantId === claim.tenantId &&
    candidate.route === claim.route && candidate.referenceKind === claim.referenceKind &&
    candidate.authoritativeProviderField === claim.authoritativeProviderField &&
    candidate.authorityId === claim.authorityId && candidate.revision === claim.revision &&
    candidate.writerId === claim.writerId &&
    candidate.coordinationDomainId === claim.coordinationDomainId);
  if (!stored) return false;
  const statement = claim.firmGovernanceStatement;
  const delegationExpiresAt = delegation.expiresAt?.toISOString() ?? null;
  const authorityEffectiveExpiresAt = stored.effectiveExpiresAt.toISOString();
  const effectiveExpiresAt = delegation.expiresAt && delegation.expiresAt < stored.effectiveExpiresAt
    ? delegation.expiresAt.toISOString()
    : authorityEffectiveExpiresAt;
  const exactRequirement = delegation.firmGovernanceRequirements?.some((requirement) =>
    requirement.actionId === input.actionId && requirement.route === claim.route &&
    requirement.referenceKind === claim.referenceKind &&
    requirement.authoritativeProviderField === claim.authoritativeProviderField) === true;
  const common = claim.schemaVersion === LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION &&
    claim.providerAtomicUniqueness === false && claim.providerId === input.target.providerId &&
    claim.tenantId === input.target.tenantId && claim.workspaceId === input.principal.workspaceId &&
    claim.agentId === input.principal.agentId && claim.installationId === input.principal.installationId &&
    claim.workspaceId === delegation.workspaceId && claim.agentId === delegation.agentId &&
    claim.installationId === delegation.installationId && claim.writerId === delegation.writerId &&
    claim.coordinationDomainId === delegation.coordinationDomainId &&
    claim.actionId === input.actionId && claim.delegationId === delegation.delegationId &&
    claim.delegationRevision === delegation.revision && claim.delegationExpiresAt === delegationExpiresAt &&
    claim.authorityEffectiveExpiresAt === authorityEffectiveExpiresAt &&
    claim.effectiveExpiresAt === effectiveExpiresAt && exactRequirement &&
    claim.writerKind === "XERO_MCP_INSTALLATION" &&
    [
      claim.receiptClaimsSha256,
      claim.statusClaimsSha256,
      claim.trustBundleFileSha256,
      claim.receiptsFileSha256,
      claim.statusFileSha256,
    ].every(validHash) && typeof claim.effectiveExpiresAt === "string" &&
    Number.isFinite(Date.parse(claim.effectiveExpiresAt)) &&
    new Date(claim.effectiveExpiresAt).toISOString() === claim.effectiveExpiresAt &&
    statement.allNonEnumeratedWritersProhibited === true &&
    statement.humanXeroUiWritesProhibited === true && statement.externalAppWritesProhibited === true &&
    statement.importWritesProhibited === true;
  const { recurringSeriesAuthorities: _storedSeries, effectiveExpiresAt: _storedExpiry, ...storedBase } = stored;
  const {
    recurringSeriesAuthority: _claimSeries,
    actionId: _claimAction,
    delegationId: _claimDelegation,
    delegationRevision: _claimDelegationRevision,
    delegationExpiresAt: _claimDelegationExpiry,
    authorityEffectiveExpiresAt: _claimAuthorityExpiry,
    effectiveExpiresAt: _claimEffectiveExpiry,
    ...claimBase
  } = claim;
  if (!common || stableStringify(storedBase) !== stableStringify(claimBase)) return false;
  if (claim.referenceKind === "GENERIC_RECURRING_REFERENCE" && !claim.recurringSeriesAuthority) {
    return false;
  }
  if (!claim.recurringSeriesAuthority) return true;
  return stored.recurringSeriesAuthorities.some((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(claim.recurringSeriesAuthority));
}

function buildReceipt(
  input: EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget },
  delegation: LedgerStandingDelegation,
): LedgerAutonomousAuthorizationReceipt {
  const unsigned = {
    receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
    kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
    actionId: input.actionId,
    providerId: input.target.providerId,
    tenantId: input.target.tenantId,
    actorId: input.principal.actorId,
    workspaceId: input.principal.workspaceId,
    agentId: input.principal.agentId,
    installationId: input.principal.installationId,
    bindingId: input.principal.bindingId,
    bindingRevision: input.principal.bindingRevision,
    connectionId: input.principal.connectionId,
    targetSessionId: input.target.targetSessionId,
    delegationId: delegation.delegationId,
    delegationRevision: delegation.revision,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseVersion: input.caseVersion,
    authoritySnapshotRevision: input.authoritySnapshotRevision,
    authoritySnapshotHash: input.authoritySnapshotHash,
    deterministicValidationReceiptHash: input.validation.receiptHash as string,
    providerCapabilityReceiptHash: input.providerCapabilityReceiptHash as string,
    ...(input.firmGovernanceClaim ? { firmGovernanceClaim: input.firmGovernanceClaim } : {}),
    issuedAt: input.now.toISOString(),
  };
  return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
}

/**
 * Provider-neutral, fail-closed authority intersection for one ledger write.
 * It never calls a provider and never trusts model-supplied authority fields.
 */
export function evaluateAutonomousLedgerWrite(
  input: EvaluateAutonomousLedgerWriteInput,
): LedgerAutonomousAuthorizationDecision {
  const denyReasons: LedgerAutonomousDenyReason[] = [];
  if (!input.writeKillSwitchEnabled) denyReasons.push("WRITE_KILL_SWITCH_DISABLED");
  if (!input.staticActionReleased) denyReasons.push("STATIC_ACTION_NOT_RELEASED");
  if (!input.transportScopeAllowed) denyReasons.push("TRANSPORT_SCOPE_MISSING");
  if (!input.target) {
    denyReasons.push("TARGET_SESSION_REQUIRED");
  } else {
    if (!validPrincipal(input.principal) || !validTarget(input.target)) {
      denyReasons.push("TARGET_BINDING_INVALID");
    }
    if (input.target.targetSessionExpiresAt.getTime() <= input.now.getTime()) {
      denyReasons.push("TARGET_SESSION_EXPIRED");
    }
  }
  if (input.providerAccessDenyReasons.length > 0) denyReasons.push("PROVIDER_ACCESS_DENIED");
  if (!exactNonEmpty(input.providerCapabilityReceiptHash)) {
    denyReasons.push("PROVIDER_CAPABILITY_RECEIPT_MISSING");
  }
  if (!input.validation.passed || !exactNonEmpty(input.validation.receiptHash)) {
    denyReasons.push("DETERMINISTIC_VALIDATION_FAILED");
  }
  if (
    !Number.isSafeInteger(input.authoritySnapshotRevision) || input.authoritySnapshotRevision < 1 ||
    !/^[0-9a-f]{64}$/u.test(input.authoritySnapshotHash)
  ) {
    denyReasons.push("TARGET_BINDING_INVALID");
  }

  const subjectDelegations = input.standingDelegations.filter((delegation) =>
    matchingSubject(delegation, input));
  if (subjectDelegations.length === 0) {
    denyReasons.push("STANDING_DELEGATION_MISSING");
  }
  const targetDelegations = input.target
    ? subjectDelegations.filter((candidate) => candidate.tenantIds.includes(input.target!.tenantId))
    : [];
  const exactDelegations = targetDelegations.filter((candidate) => candidate.actionIds.includes(input.actionId));
  if (subjectDelegations.length > 0 && targetDelegations.length === 0) {
    denyReasons.push("STANDING_DELEGATION_TARGET_MISMATCH");
  } else if (targetDelegations.length > 0 && exactDelegations.length === 0) {
    denyReasons.push("STANDING_DELEGATION_ACTION_MISMATCH");
  } else if (exactDelegations.length > 1) {
    // Multiple grants for other tenants/actions are expected. Only duplicate
    // authority over this exact provider/tenant/action is ambiguous.
    denyReasons.push("STANDING_DELEGATION_AMBIGUOUS");
  }
  const delegation = exactDelegations.length === 1 ? exactDelegations[0] : undefined;
  if (delegation) {
    if (delegation.status !== "ACTIVE") denyReasons.push("STANDING_DELEGATION_REVOKED");
    if (delegation.expiresAt && delegation.expiresAt.getTime() <= input.now.getTime()) {
      denyReasons.push("STANDING_DELEGATION_EXPIRED");
    }
    if (input.firmGovernanceRequired === true && !input.firmGovernanceClaim) {
      denyReasons.push("FIRM_GOVERNANCE_AUTHORITY_INVALID");
    } else if (input.firmGovernanceClaim) {
      if (!input.target || !validFirmGovernanceClaim(
        input.firmGovernanceClaim,
        input as EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget },
        delegation,
      )) {
        denyReasons.push("FIRM_GOVERNANCE_AUTHORITY_INVALID");
      } else if (Date.parse(input.firmGovernanceClaim.effectiveExpiresAt) <= input.now.getTime()) {
        denyReasons.push("FIRM_GOVERNANCE_AUTHORITY_EXPIRED");
      }
    }
  }

  if (
    denyReasons.length > 0 ||
    !delegation ||
    !input.target ||
    !input.validation.receiptHash ||
    !input.providerCapabilityReceiptHash
  ) {
    return Object.freeze({
      allowed: false,
      denyReasons: Object.freeze([...new Set(denyReasons)]),
      providerAccessDenyReasons: Object.freeze([...input.providerAccessDenyReasons]),
      validationReasonCodes: Object.freeze([...(input.validation.reasonCodes ?? [])]),
    });
  }
  return Object.freeze({
    allowed: true,
    denyReasons: Object.freeze([]),
    providerAccessDenyReasons: Object.freeze([]),
    validationReasonCodes: Object.freeze([]),
    delegation,
    receipt: buildReceipt(input as EvaluateAutonomousLedgerWriteInput & { target: LedgerOperationTarget }, delegation),
  });
}
