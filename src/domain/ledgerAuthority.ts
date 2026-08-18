import {
  LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION,
  type LedgerFirmGovernanceAuthority,
  type LedgerFirmGovernanceClaim,
  type LedgerFirmGovernanceRecurringSeriesAuthority,
  type LedgerStandingDelegation,
} from "../control-kernel/ledgerControlKernel.js";
import { hashObject } from "../security/hash.js";

export const LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION = "ledger-authority-snapshot:v2";
export const LEGACY_LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION = "ledger-authority-snapshot:v1";

export interface LedgerAuthoritySnapshotMaterial {
  readonly providerId: string;
  readonly revision: number;
  readonly writeKillSwitchEnabled: boolean;
  readonly standingDelegations: readonly LedgerStandingDelegation[];
}

export interface LedgerAuthoritySnapshot extends LedgerAuthoritySnapshotMaterial {
  readonly schemaVersion: typeof LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotHash: string;
  readonly publishedAt: Date;
}

export type LedgerFirmGovernanceReadinessStatus =
  | "CURRENT"
  | "NOT_REQUIRED"
  | "MISSING_OR_INVALID"
  | "EXPIRED"
  | "UNKNOWN";

/** Public aggregate only; no tenant, writer, delegation, or case identities. */
export interface LedgerFirmGovernanceReadinessEvidence {
  readonly status: LedgerFirmGovernanceReadinessStatus;
  readonly repositoryObservedAt: string | null;
  readonly requiredDelegationCount: number | null;
  readonly authorityCount: number | null;
  readonly authorityAggregateHash: string | null;
  /** Exact root-admitted file identities carried by the durable snapshot. */
  readonly trustBundleFileSha256: string | null;
  readonly receiptsFileSha256: string | null;
  readonly statusFileSha256: string | null;
  readonly minEffectiveExpiresAt: string | null;
}

export interface LedgerAuthorityRepositoryReadiness {
  readonly snapshot?: LedgerAuthoritySnapshot;
  readonly firmGovernance: LedgerFirmGovernanceReadinessEvidence;
}

export interface PublishLedgerAuthoritySnapshotInput extends LedgerAuthoritySnapshotMaterial {
  readonly publishedAt: Date;
}

export type LedgerAuthoritySnapshotPublishMode = "CREATED" | "ADVANCED" | "IDEMPOTENT_REPLAY";

export interface PublishLedgerAuthoritySnapshotResult {
  readonly snapshot: LedgerAuthoritySnapshot;
  readonly mode: LedgerAuthoritySnapshotPublishMode;
}

export interface LedgerAuthoritySnapshotResolver {
  /** Production resolvers must use the repository-atomic claim mode. */
  readonly claimConsistency: "REPOSITORY_ATOMIC" | "TEST_RESOLVER_GUARDED";
  resolveCurrent(): Promise<LedgerAuthoritySnapshot>;
}

function exactNonEmpty(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function canonicalDelegation(delegation: LedgerStandingDelegation) {
  return {
    delegationId: delegation.delegationId,
    revision: delegation.revision,
    status: delegation.status,
    providerId: delegation.providerId,
    workspaceId: delegation.workspaceId,
    agentId: delegation.agentId,
    ...(delegation.installationId ? { installationId: delegation.installationId } : {}),
    ...(delegation.writerId ? { writerId: delegation.writerId } : {}),
    ...(delegation.coordinationDomainId
      ? { coordinationDomainId: delegation.coordinationDomainId }
      : {}),
    tenantIds: [...delegation.tenantIds].sort(),
    actionIds: [...delegation.actionIds].sort(),
    ...(delegation.expiresAt ? { expiresAt: delegation.expiresAt.toISOString() } : {}),
    ...(delegation.firmGovernanceRequired ? { firmGovernanceRequired: true } : {}),
    ...(delegation.firmGovernanceRequirements ? {
      firmGovernanceRequirements: delegation.firmGovernanceRequirements
        .map((requirement) => ({ ...requirement }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en")),
    } : {}),
    ...(delegation.firmGovernanceAuthorities ? {
      firmGovernanceAuthorities: delegation.firmGovernanceAuthorities
        .map(canonicalFirmGovernanceAuthority)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en")),
    } : {}),
  };
}

function canonicalLegacyDelegation(delegation: LedgerStandingDelegation) {
  if (delegation.writerId !== undefined || delegation.coordinationDomainId !== undefined ||
      delegation.firmGovernanceRequired !== undefined || delegation.firmGovernanceRequirements !== undefined ||
      delegation.firmGovernanceAuthorities !== undefined) {
    throw new Error("Legacy ledger authority material contains post-v1 fields.");
  }
  return {
    delegationId: delegation.delegationId,
    revision: delegation.revision,
    status: delegation.status,
    providerId: delegation.providerId,
    workspaceId: delegation.workspaceId,
    agentId: delegation.agentId,
    ...(delegation.installationId ? { installationId: delegation.installationId } : {}),
    tenantIds: [...delegation.tenantIds].sort(),
    actionIds: [...delegation.actionIds].sort(),
    ...(delegation.expiresAt ? { expiresAt: delegation.expiresAt.toISOString() } : {}),
  };
}

function canonicalRecurringAuthority(authority: LedgerFirmGovernanceRecurringSeriesAuthority) {
  return {
    authorityId: authority.authorityId,
    revision: authority.revision,
    route: authority.route,
    contactId: authority.contactId,
    normalizedReference: authority.normalizedReference,
    authoritativeProviderField: authority.authoritativeProviderField,
    normalizationVersion: authority.normalizationVersion,
    occurrenceKey: authority.occurrenceKey,
  };
}

function canonicalFirmGovernanceAuthority(
  authority: Omit<LedgerFirmGovernanceAuthority, "effectiveExpiresAt"> & {
    readonly effectiveExpiresAt: Date | string;
  },
) {
  return {
    schemaVersion: authority.schemaVersion,
    providerId: authority.providerId,
    tenantId: authority.tenantId,
    authorityId: authority.authorityId,
    revision: authority.revision,
    providerAtomicUniqueness: false,
    route: authority.route,
    referenceKind: authority.referenceKind,
    authoritativeProviderField: authority.authoritativeProviderField,
    writerId: authority.writerId,
    writerKind: authority.writerKind,
    workspaceId: authority.workspaceId,
    agentId: authority.agentId,
    installationId: authority.installationId,
    coordinationDomainId: authority.coordinationDomainId,
    receiptClaimsSha256: authority.receiptClaimsSha256,
    statusClaimsSha256: authority.statusClaimsSha256,
    trustBundleFileSha256: authority.trustBundleFileSha256,
    receiptsFileSha256: authority.receiptsFileSha256,
    statusFileSha256: authority.statusFileSha256,
    effectiveExpiresAt: authority.effectiveExpiresAt instanceof Date
      ? authority.effectiveExpiresAt.toISOString()
      : authority.effectiveExpiresAt,
    firmGovernanceStatement: { ...authority.firmGovernanceStatement },
    recurringSeriesAuthorities: authority.recurringSeriesAuthorities
      .map(canonicalRecurringAuthority)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en")),
  };
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validRecurringAuthority(authority: LedgerFirmGovernanceRecurringSeriesAuthority): boolean {
  return exactNonEmpty(authority.authorityId) && Number.isSafeInteger(authority.revision) && authority.revision > 0 &&
    exactNonEmpty(authority.route) && exactNonEmpty(authority.contactId) &&
    exactNonEmpty(authority.normalizedReference) && exactNonEmpty(authority.authoritativeProviderField) &&
    exactNonEmpty(authority.normalizationVersion) && authority.occurrenceKey === "DOCUMENT_DATE";
}

function validFirmGovernanceAuthority(
  authority: LedgerFirmGovernanceAuthority,
  delegation: LedgerStandingDelegation,
): boolean {
  const statement = authority.firmGovernanceStatement;
  const recurringCoordinates = authority.recurringSeriesAuthorities.map((item) => JSON.stringify([
    item.authorityId,
    item.route,
    item.contactId,
    item.normalizedReference,
  ]));
  return authority.schemaVersion === LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION &&
    authority.providerId === delegation.providerId && delegation.tenantIds.includes(authority.tenantId) &&
    exactNonEmpty(authority.authorityId) && Number.isSafeInteger(authority.revision) && authority.revision > 0 &&
    authority.providerAtomicUniqueness === false && exactNonEmpty(authority.route) &&
    exactNonEmpty(authority.referenceKind) && exactNonEmpty(authority.authoritativeProviderField) &&
    exactNonEmpty(authority.writerId) && authority.writerKind === "XERO_MCP_INSTALLATION" &&
    authority.workspaceId === delegation.workspaceId && authority.agentId === delegation.agentId &&
    authority.installationId === delegation.installationId && authority.writerId === delegation.writerId &&
    authority.coordinationDomainId === delegation.coordinationDomainId &&
    [
      authority.receiptClaimsSha256,
      authority.statusClaimsSha256,
      authority.trustBundleFileSha256,
      authority.receiptsFileSha256,
      authority.statusFileSha256,
    ].every(validHash) && authority.effectiveExpiresAt instanceof Date &&
    Number.isFinite(authority.effectiveExpiresAt.getTime()) &&
    statement.allNonEnumeratedWritersProhibited === true &&
    statement.humanXeroUiWritesProhibited === true && statement.externalAppWritesProhibited === true &&
    statement.importWritesProhibited === true &&
    authority.recurringSeriesAuthorities.every(validRecurringAuthority) &&
    new Set(recurringCoordinates).size === recurringCoordinates.length;
}

function assertValidMaterial(material: LedgerAuthoritySnapshotMaterial): void {
  if (!exactNonEmpty(material.providerId) || !Number.isSafeInteger(material.revision) || material.revision < 1) {
    throw new Error("Ledger authority snapshot provider and revision are invalid.");
  }
  const ids = new Set<string>();
  for (const delegation of material.standingDelegations) {
    const requirements = delegation.firmGovernanceRequirements ?? [];
    const requirementKeys = requirements.map((requirement) => JSON.stringify([
      requirement.actionId,
      requirement.route,
      requirement.referenceKind,
      requirement.authoritativeProviderField,
    ]));
    const authorityKeys = (delegation.firmGovernanceAuthorities ?? []).map((authority) => JSON.stringify([
      authority.tenantId,
      authority.route,
      authority.referenceKind,
      authority.authoritativeProviderField,
    ]));
    const requiredAuthorityKeys = delegation.tenantIds.flatMap((tenantId) => requirements.map((requirement) =>
      JSON.stringify([
        tenantId,
        requirement.route,
        requirement.referenceKind,
        requirement.authoritativeProviderField,
      ])));
    if (
      !exactNonEmpty(delegation.delegationId) || ids.has(delegation.delegationId) ||
      !Number.isSafeInteger(delegation.revision) || delegation.revision < 1 ||
      !exactNonEmpty(delegation.providerId) || delegation.providerId !== material.providerId ||
      !exactNonEmpty(delegation.workspaceId) || !exactNonEmpty(delegation.agentId) ||
      (delegation.installationId !== undefined && !exactNonEmpty(delegation.installationId)) ||
      (delegation.writerId !== undefined && !exactNonEmpty(delegation.writerId)) ||
      (delegation.coordinationDomainId !== undefined && !exactNonEmpty(delegation.coordinationDomainId)) ||
      ((delegation.writerId === undefined) !== (delegation.coordinationDomainId === undefined)) ||
      delegation.tenantIds.length === 0 || new Set(delegation.tenantIds).size !== delegation.tenantIds.length ||
      delegation.tenantIds.some((value) => !exactNonEmpty(value)) ||
      delegation.actionIds.length === 0 || new Set(delegation.actionIds).size !== delegation.actionIds.length ||
      delegation.actionIds.some((value) => !exactNonEmpty(value)) ||
      (delegation.expiresAt !== undefined && !Number.isFinite(delegation.expiresAt.getTime())) ||
      (delegation.firmGovernanceAuthorities !== undefined && (
        delegation.writerId === undefined || delegation.installationId === undefined ||
        delegation.firmGovernanceAuthorities.some((authority) =>
          !validFirmGovernanceAuthority(authority, delegation)) ||
        new Set(delegation.firmGovernanceAuthorities.map((authority) => JSON.stringify([
          authority.tenantId,
          authority.route,
          authority.referenceKind,
          authority.authoritativeProviderField,
        ]))).size !== delegation.firmGovernanceAuthorities.length
      )) ||
      (delegation.firmGovernanceRequired === true &&
        (!delegation.firmGovernanceAuthorities || delegation.firmGovernanceAuthorities.length === 0 ||
          requirements.length === 0 || new Set(requirementKeys).size !== requirementKeys.length ||
          requirements.some((requirement) => !exactNonEmpty(requirement.actionId) ||
            !delegation.actionIds.includes(requirement.actionId) || !exactNonEmpty(requirement.route) ||
            !exactNonEmpty(requirement.referenceKind) || !exactNonEmpty(requirement.authoritativeProviderField)) ||
          new Set(authorityKeys).size !== new Set(requiredAuthorityKeys).size ||
          requiredAuthorityKeys.some((key) => !authorityKeys.includes(key)) ||
          authorityKeys.some((key) => !requiredAuthorityKeys.includes(key)))) ||
      (delegation.firmGovernanceAuthorities !== undefined && delegation.firmGovernanceRequired !== true) ||
      ((delegation.firmGovernanceRequirements !== undefined) !== (delegation.firmGovernanceRequired === true))
    ) {
      throw new Error("Ledger authority snapshot contains an invalid standing delegation.");
    }
    ids.add(delegation.delegationId);
  }
}

export function ledgerAuthoritySnapshotHash(material: LedgerAuthoritySnapshotMaterial): string {
  assertValidMaterial(material);
  return hashObject({
    schemaVersion: LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    providerId: material.providerId,
    revision: material.revision,
    writeKillSwitchEnabled: material.writeKillSwitchEnabled,
    standingDelegations: material.standingDelegations
      .map(canonicalDelegation)
      .sort((left, right) => left.delegationId.localeCompare(right.delegationId, "en")),
  });
}

/** Verification only. A v1 hash can never be returned as current authority. */
export function legacyLedgerAuthoritySnapshotV1Hash(material: LedgerAuthoritySnapshotMaterial): string {
  if (!exactNonEmpty(material.providerId) || !Number.isSafeInteger(material.revision) || material.revision < 1) {
    throw new Error("Legacy ledger authority snapshot provider and revision are invalid.");
  }
  const ids = new Set<string>();
  for (const delegation of material.standingDelegations) {
    if (!exactNonEmpty(delegation.delegationId) || ids.has(delegation.delegationId) ||
        !Number.isSafeInteger(delegation.revision) || delegation.revision < 1 ||
        delegation.providerId !== material.providerId || !exactNonEmpty(delegation.workspaceId) ||
        !exactNonEmpty(delegation.agentId) || delegation.tenantIds.length === 0 ||
        delegation.actionIds.length === 0 || delegation.tenantIds.some((value) => !exactNonEmpty(value)) ||
        delegation.actionIds.some((value) => !exactNonEmpty(value))) {
      throw new Error("Legacy ledger authority snapshot contains an invalid delegation.");
    }
    canonicalLegacyDelegation(delegation);
    ids.add(delegation.delegationId);
  }
  return hashObject({
    schemaVersion: LEGACY_LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    providerId: material.providerId,
    revision: material.revision,
    writeKillSwitchEnabled: material.writeKillSwitchEnabled,
    standingDelegations: material.standingDelegations
      .map(canonicalLegacyDelegation)
      .sort((left, right) => left.delegationId.localeCompare(right.delegationId, "en")),
  });
}

export function createLedgerAuthoritySnapshot(input: PublishLedgerAuthoritySnapshotInput): LedgerAuthoritySnapshot {
  if (!(input.publishedAt instanceof Date) || !Number.isFinite(input.publishedAt.getTime())) {
    throw new Error("Ledger authority snapshot publication time is invalid.");
  }
  const standingDelegations = Object.freeze(input.standingDelegations.map((delegation) => Object.freeze({
    ...delegation,
    tenantIds: Object.freeze([...delegation.tenantIds]),
    actionIds: Object.freeze([...delegation.actionIds]),
    ...(delegation.expiresAt ? { expiresAt: new Date(delegation.expiresAt) } : {}),
    ...(delegation.firmGovernanceRequirements ? {
      firmGovernanceRequirements: Object.freeze(delegation.firmGovernanceRequirements.map((requirement) =>
        Object.freeze({ ...requirement }))),
    } : {}),
    ...(delegation.firmGovernanceAuthorities ? {
      firmGovernanceAuthorities: Object.freeze(delegation.firmGovernanceAuthorities.map((authority) =>
        Object.freeze({
          ...authority,
          effectiveExpiresAt: new Date(authority.effectiveExpiresAt),
          firmGovernanceStatement: Object.freeze({ ...authority.firmGovernanceStatement }),
          recurringSeriesAuthorities: Object.freeze(authority.recurringSeriesAuthorities.map((series) =>
            Object.freeze({ ...series }))),
        }))),
    } : {}),
  })));
  const material = {
    providerId: input.providerId,
    revision: input.revision,
    writeKillSwitchEnabled: input.writeKillSwitchEnabled,
    standingDelegations,
  };
  return Object.freeze({
    schemaVersion: LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    ...material,
    snapshotHash: ledgerAuthoritySnapshotHash(material),
    publishedAt: new Date(input.publishedAt),
  });
}

export class RepositoryLedgerAuthoritySnapshotResolver implements LedgerAuthoritySnapshotResolver {
  readonly claimConsistency = "REPOSITORY_ATOMIC" as const;

  constructor(
    private readonly repository: {
      getLedgerAuthoritySnapshot(providerId: string): Promise<LedgerAuthoritySnapshot | undefined>;
    },
    private readonly providerId = "xero",
  ) {}

  async resolveCurrent(): Promise<LedgerAuthoritySnapshot> {
    const snapshot = await this.repository.getLedgerAuthoritySnapshot(this.providerId);
    if (!snapshot) throw new Error("The durable ledger authority snapshot is not published.");
    return snapshot;
  }
}

/** Explicitly test-only dynamic resolver. Production startup never constructs it. */
export class MutableTestLedgerAuthoritySnapshotResolver implements LedgerAuthoritySnapshotResolver {
  readonly claimConsistency = "TEST_RESOLVER_GUARDED" as const;
  #snapshot: LedgerAuthoritySnapshot;

  constructor(initial: PublishLedgerAuthoritySnapshotInput) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Mutable ledger authority resolver is test-only.");
    }
    this.#snapshot = createLedgerAuthoritySnapshot(initial);
  }

  async resolveCurrent(): Promise<LedgerAuthoritySnapshot> {
    return this.#snapshot;
  }

  publish(next: PublishLedgerAuthoritySnapshotInput): LedgerAuthoritySnapshot {
    const candidate = createLedgerAuthoritySnapshot(next);
    if (candidate.revision < this.#snapshot.revision) {
      throw new Error("Ledger authority snapshot revision cannot decrease.");
    }
    if (candidate.revision === this.#snapshot.revision && candidate.snapshotHash !== this.#snapshot.snapshotHash) {
      throw new Error("Ledger authority snapshot revision cannot identify different content.");
    }
    if (candidate.revision > this.#snapshot.revision) this.#snapshot = candidate;
    return this.#snapshot;
  }
}

export interface ExactLedgerFirmGovernanceAuthorityMatch {
  readonly authority: LedgerFirmGovernanceAuthority;
  readonly delegation: LedgerStandingDelegation;
  readonly effectiveExpiresAt: Date;
}

export function exactFirmGovernanceAuthorityFromSnapshot(
  snapshot: LedgerAuthoritySnapshot,
  claim: LedgerFirmGovernanceClaim,
): ExactLedgerFirmGovernanceAuthorityMatch | undefined {
  const delegations = snapshot.standingDelegations.filter((delegation) =>
    delegation.status === "ACTIVE" && delegation.firmGovernanceRequired === true &&
    delegation.delegationId === claim.delegationId && delegation.revision === claim.delegationRevision &&
    delegation.actionIds.includes(claim.actionId) &&
    delegation.providerId === claim.providerId && delegation.tenantIds.includes(claim.tenantId) &&
    delegation.workspaceId === claim.workspaceId && delegation.agentId === claim.agentId &&
    delegation.installationId === claim.installationId && delegation.writerId === claim.writerId &&
    delegation.coordinationDomainId === claim.coordinationDomainId);
  if (delegations.length !== 1) return undefined;
  const delegation = delegations[0]!;
  const delegationExpiresAt = delegation.expiresAt?.toISOString() ?? null;
  if (claim.delegationExpiresAt !== delegationExpiresAt ||
      !delegation.firmGovernanceRequirements?.some((requirement) =>
        requirement.actionId === claim.actionId && requirement.route === claim.route &&
        requirement.referenceKind === claim.referenceKind &&
        requirement.authoritativeProviderField === claim.authoritativeProviderField)) return undefined;
  const authorities = delegation.firmGovernanceAuthorities?.filter((authority) =>
    authority.providerId === claim.providerId && authority.tenantId === claim.tenantId &&
    authority.authorityId === claim.authorityId && authority.revision === claim.revision &&
    authority.route === claim.route && authority.referenceKind === claim.referenceKind &&
    authority.authoritativeProviderField === claim.authoritativeProviderField &&
    authority.providerAtomicUniqueness === false && authority.writerId === claim.writerId &&
    authority.coordinationDomainId === claim.coordinationDomainId) ?? [];
  if (authorities.length !== 1) return undefined;
  const authority = authorities[0]!;
  const authorityEffectiveExpiresAt = authority.effectiveExpiresAt.toISOString();
  const effectiveExpiresAt = delegation.expiresAt && delegation.expiresAt < authority.effectiveExpiresAt
    ? delegation.expiresAt
    : authority.effectiveExpiresAt;
  if (claim.authorityEffectiveExpiresAt !== authorityEffectiveExpiresAt ||
      claim.effectiveExpiresAt !== effectiveExpiresAt.toISOString()) return undefined;
  const {
    recurringSeriesAuthority,
    actionId: _actionId,
    delegationId: _delegationId,
    delegationRevision: _delegationRevision,
    delegationExpiresAt: _delegationExpiresAt,
    authorityEffectiveExpiresAt: _authorityEffectiveExpiresAt,
    effectiveExpiresAt: _effectiveExpiresAt,
    ...claimBase
  } = claim;
  const { recurringSeriesAuthorities } = authority;
  const {
    recurringSeriesAuthorities: _authoritySeries,
    effectiveExpiresAt: _authorityExpiry,
    ...authorityBase
  } = authority;
  if (hashObject(authorityBase) !== hashObject(claimBase)) return undefined;
  if (claim.referenceKind === "GENERIC_RECURRING_REFERENCE" && !recurringSeriesAuthority) {
    return undefined;
  }
  if (!recurringSeriesAuthority) return Object.freeze({ authority, delegation, effectiveExpiresAt });
  return recurringSeriesAuthorities.some((candidate) =>
    JSON.stringify(canonicalRecurringAuthority(candidate)) ===
      JSON.stringify(canonicalRecurringAuthority(recurringSeriesAuthority)))
    ? Object.freeze({ authority, delegation, effectiveExpiresAt })
    : undefined;
}

export function ledgerFirmGovernanceReadinessEvidence(
  snapshot: LedgerAuthoritySnapshot | undefined,
  repositoryObservedAt: Date,
): LedgerFirmGovernanceReadinessEvidence {
  const observed = repositoryObservedAt instanceof Date && Number.isFinite(repositoryObservedAt.getTime())
    ? repositoryObservedAt.toISOString()
    : null;
  if (!snapshot || !observed) {
    return Object.freeze({
      status: "UNKNOWN",
      repositoryObservedAt: observed,
      requiredDelegationCount: null,
      authorityCount: null,
      authorityAggregateHash: null,
      trustBundleFileSha256: null,
      receiptsFileSha256: null,
      statusFileSha256: null,
      minEffectiveExpiresAt: null,
    });
  }
  const required = snapshot.standingDelegations.filter((delegation) =>
    delegation.status === "ACTIVE" && delegation.firmGovernanceRequired === true);
  if (required.length === 0) {
    return Object.freeze({
      status: "NOT_REQUIRED",
      repositoryObservedAt: observed,
      requiredDelegationCount: 0,
      authorityCount: 0,
      authorityAggregateHash: null,
      trustBundleFileSha256: null,
      receiptsFileSha256: null,
      statusFileSha256: null,
      minEffectiveExpiresAt: null,
    });
  }
  const authorities = required.flatMap((delegation) => [...(delegation.firmGovernanceAuthorities ?? [])]);
  const complete = required.every((delegation) => {
    const requirements = delegation.firmGovernanceRequirements ?? [];
    const keys = new Set((delegation.firmGovernanceAuthorities ?? []).map((authority) => JSON.stringify([
      authority.tenantId,
      authority.route,
      authority.referenceKind,
      authority.authoritativeProviderField,
    ])));
    return requirements.length > 0 && delegation.tenantIds.every((tenantId) => requirements.every((requirement) =>
      keys.has(JSON.stringify([
        tenantId,
        requirement.route,
        requirement.referenceKind,
        requirement.authoritativeProviderField,
      ]))));
  });
  const trustBundleFileSha256s = new Set(authorities.map((authority) => authority.trustBundleFileSha256));
  const receiptsFileSha256s = new Set(authorities.map((authority) => authority.receiptsFileSha256));
  const statusFileSha256s = new Set(authorities.map((authority) => authority.statusFileSha256));
  if (authorities.length === 0 || !complete || trustBundleFileSha256s.size !== 1 ||
      receiptsFileSha256s.size !== 1 || statusFileSha256s.size !== 1) {
    return Object.freeze({
      status: "MISSING_OR_INVALID",
      repositoryObservedAt: observed,
      requiredDelegationCount: required.length,
      authorityCount: authorities.length,
      authorityAggregateHash: null,
      trustBundleFileSha256: null,
      receiptsFileSha256: null,
      statusFileSha256: null,
      minEffectiveExpiresAt: null,
    });
  }
  const effectiveExpiries = [
    ...authorities.map((authority) => authority.effectiveExpiresAt),
    ...required.flatMap((delegation) => delegation.expiresAt ? [delegation.expiresAt] : []),
  ];
  const minExpiry = effectiveExpiries.reduce((minimum, expiry) => expiry < minimum ? expiry : minimum);
  const aggregate = required.flatMap((delegation) =>
    (delegation.firmGovernanceAuthorities ?? []).map((authority) => ({
      delegationId: delegation.delegationId,
      delegationRevision: delegation.revision,
      delegationExpiresAt: delegation.expiresAt?.toISOString() ?? null,
      authorityId: authority.authorityId,
      revision: authority.revision,
      providerAtomicUniqueness: false,
      receiptClaimsSha256: authority.receiptClaimsSha256,
      statusClaimsSha256: authority.statusClaimsSha256,
      trustBundleFileSha256: authority.trustBundleFileSha256,
      receiptsFileSha256: authority.receiptsFileSha256,
      statusFileSha256: authority.statusFileSha256,
      authorityEffectiveExpiresAt: authority.effectiveExpiresAt.toISOString(),
      effectiveExpiresAt: delegation.expiresAt && delegation.expiresAt < authority.effectiveExpiresAt
        ? delegation.expiresAt.toISOString()
        : authority.effectiveExpiresAt.toISOString(),
    }))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  return Object.freeze({
    status: minExpiry.getTime() <= repositoryObservedAt.getTime() ? "EXPIRED" : "CURRENT",
    repositoryObservedAt: observed,
    requiredDelegationCount: required.length,
    authorityCount: authorities.length,
    authorityAggregateHash: hashObject(aggregate),
    trustBundleFileSha256: [...trustBundleFileSha256s][0]!,
    receiptsFileSha256: [...receiptsFileSha256s][0]!,
    statusFileSha256: [...statusFileSha256s][0]!,
    minEffectiveExpiresAt: minExpiry.toISOString(),
  });
}
