import { AppError } from "../errors.js";
import { hashObject } from "../security/hash.js";
import {
  LEDGER_CONTROL_KERNEL_VERSION,
  LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION,
  type LedgerAutonomousAuthorizationReceipt,
  type LedgerFirmGovernanceClaim,
} from "./ledgerControlKernel.js";

declare const ledgerProviderWritePermitBrand: unique symbol;

export interface LedgerProviderPermitContract {
  readonly providerId: string;
  readonly actionByAdapterOperation: Readonly<Record<string, string>>;
}

/** Provider-neutral durable authority projection; provider request domains stay outside the kernel. */
export interface LedgerProviderPermitRequestProjection {
  readonly mutationRequestId: string;
  readonly canonicalPayloadHash: string;
  readonly authorizationReceipt: unknown;
}

export interface LedgerProviderWritePermitClaims {
  readonly providerId: string;
  readonly adapterOperation: string;
  readonly actionId: string;
  readonly mutationRequestId: string;
  readonly canonicalPayloadHash: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionId: string;
  readonly targetSessionId: string;
}

/**
 * Opaque, process-local authority for exactly one provider write. Authority
 * and one-shot state live in this module's WeakMap, never in serialisable data.
 */
export type LedgerProviderWritePermit = Readonly<{
  [ledgerProviderWritePermitBrand]: never;
}>;

export interface IssueLedgerProviderWritePermitInput {
  readonly contract: LedgerProviderPermitContract;
  readonly adapterOperation: string;
  readonly request: LedgerProviderPermitRequestProjection;
}

interface PermitState {
  readonly claims: Readonly<LedgerProviderWritePermitClaims>;
  consumed: boolean;
}

type PermitDenialReason =
  | "INVALID"
  | "CONSUMED"
  | "PROVIDER_MISMATCH"
  | "ADAPTER_OPERATION_MISMATCH"
  | "ACTION_MISMATCH"
  | "MUTATION_REQUEST_MISMATCH"
  | "PAYLOAD_MISMATCH"
  | "TENANT_MISMATCH"
  | "ACTOR_MISMATCH"
  | "WORKSPACE_MISMATCH"
  | "AGENT_MISMATCH"
  | "INSTALLATION_MISMATCH"
  | "BINDING_MISMATCH"
  | "BINDING_REVISION_MISMATCH"
  | "CONNECTION_MISMATCH"
  | "TARGET_SESSION_MISMATCH";

type PermitIssuanceFailureReason =
  | "INVALID_ISSUER_INPUT"
  | "AUTHORIZATION_RECEIPT_INVALID"
  | "REQUEST_RECEIPT_MISMATCH"
  | "PROVIDER_RECEIPT_MISMATCH"
  | "ADAPTER_ACTION_MISMATCH";

const permitState = new WeakMap<object, PermitState>();

const AUTHORIZATION_RECEIPT_KEYS = Object.freeze([
  "receiptType",
  "kernelVersion",
  "actionId",
  "providerId",
  "tenantId",
  "actorId",
  "workspaceId",
  "agentId",
  "installationId",
  "bindingId",
  "bindingRevision",
  "connectionId",
  "targetSessionId",
  "delegationId",
  "delegationRevision",
  "canonicalPayloadHash",
  "sourceRevisionHash",
  "caseVersion",
  "authoritySnapshotRevision",
  "authoritySnapshotHash",
  "deterministicValidationReceiptHash",
  "providerCapabilityReceiptHash",
  "firmGovernanceClaim",
  "issuedAt",
  "receiptHash",
] as const satisfies readonly (keyof LedgerAutonomousAuthorizationReceipt)[]);

const FIRM_GOVERNANCE_CLAIM_KEYS = Object.freeze([
  "schemaVersion", "providerId", "tenantId", "authorityId", "revision",
  "providerAtomicUniqueness", "route", "referenceKind", "authoritativeProviderField",
  "writerId", "writerKind", "workspaceId", "agentId", "installationId",
  "coordinationDomainId", "receiptClaimsSha256", "statusClaimsSha256",
  "trustBundleFileSha256", "receiptsFileSha256", "statusFileSha256",
  "actionId", "delegationId", "delegationRevision", "delegationExpiresAt",
  "authorityEffectiveExpiresAt", "effectiveExpiresAt", "firmGovernanceStatement",
  "recurringSeriesAuthority",
] as const);

const FIRM_GOVERNANCE_STATEMENT_KEYS = Object.freeze([
  "allNonEnumeratedWritersProhibited", "humanXeroUiWritesProhibited",
  "externalAppWritesProhibited", "importWritesProhibited",
] as const);

const RECURRING_AUTHORITY_KEYS = Object.freeze([
  "authorityId", "revision", "route", "contactId", "normalizedReference",
  "authoritativeProviderField", "normalizationVersion", "occurrenceKey",
] as const);

function permitDenied(reason: PermitDenialReason): AppError {
  return new AppError(
    "FORBIDDEN",
    "The raw ledger provider write is not authorised by a valid one-shot permit.",
    {
      httpStatus: 403,
      retryable: false,
      details: { providerMutationPossible: false, permitReason: reason },
    },
  );
}

function permitIssuanceFailed(reason: PermitIssuanceFailureReason): AppError {
  return new AppError(
    "APPROVAL_INVALID",
    "The persisted autonomous write authority cannot issue a raw provider permit.",
    {
      httpStatus: 409,
      retryable: false,
      details: { providerMutationPossible: false, permitReason: reason },
    },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    allowed.every((key) => optional.includes(key) || Object.hasOwn(value, key));
}

function parseFirmGovernanceClaim(raw: unknown): LedgerFirmGovernanceClaim | undefined {
  if (!isRecord(raw) || !exactKeys(raw, FIRM_GOVERNANCE_CLAIM_KEYS, ["recurringSeriesAuthority"])) {
    return undefined;
  }
  const statement = raw.firmGovernanceStatement;
  if (!isRecord(statement) || !exactKeys(statement, FIRM_GOVERNANCE_STATEMENT_KEYS) ||
      FIRM_GOVERNANCE_STATEMENT_KEYS.some((key) => statement[key] !== true)) return undefined;
  const recurring = raw.recurringSeriesAuthority;
  if (recurring !== undefined && (
    !isRecord(recurring) || !exactKeys(recurring, RECURRING_AUTHORITY_KEYS) ||
    !isExactNonEmptyString(recurring.authorityId) || !isPositiveSafeInteger(recurring.revision) ||
    !isExactNonEmptyString(recurring.route) || !isExactNonEmptyString(recurring.contactId) ||
    !isExactNonEmptyString(recurring.normalizedReference) ||
    !isExactNonEmptyString(recurring.authoritativeProviderField) ||
    !isExactNonEmptyString(recurring.normalizationVersion) || recurring.occurrenceKey !== "DOCUMENT_DATE"
  )) return undefined;
  const delegationExpiry = raw.delegationExpiresAt;
  if (delegationExpiry !== null && !isCanonicalIsoDate(delegationExpiry)) return undefined;
  if (!isCanonicalIsoDate(raw.authorityEffectiveExpiresAt) || !isCanonicalIsoDate(raw.effectiveExpiresAt)) {
    return undefined;
  }
  const expectedEffectiveExpiry = delegationExpiry !== null && delegationExpiry < raw.authorityEffectiveExpiresAt
    ? delegationExpiry
    : raw.authorityEffectiveExpiresAt;
  if (
    raw.schemaVersion !== LEDGER_FIRM_GOVERNANCE_AUTHORITY_SCHEMA_VERSION ||
    !isExactNonEmptyString(raw.providerId) || !isExactNonEmptyString(raw.tenantId) ||
    !isExactNonEmptyString(raw.authorityId) || !isPositiveSafeInteger(raw.revision) ||
    raw.providerAtomicUniqueness !== false || !isExactNonEmptyString(raw.route) ||
    !isExactNonEmptyString(raw.referenceKind) || !isExactNonEmptyString(raw.authoritativeProviderField) ||
    !isExactNonEmptyString(raw.writerId) || raw.writerKind !== "XERO_MCP_INSTALLATION" ||
    !isExactNonEmptyString(raw.workspaceId) || !isExactNonEmptyString(raw.agentId) ||
    !isExactNonEmptyString(raw.installationId) || !isExactNonEmptyString(raw.coordinationDomainId) ||
    !isExactNonEmptyString(raw.actionId) || !isExactNonEmptyString(raw.delegationId) ||
    !isPositiveSafeInteger(raw.delegationRevision) || raw.effectiveExpiresAt !== expectedEffectiveExpiry ||
    !isSha256(raw.receiptClaimsSha256) || !isSha256(raw.statusClaimsSha256) ||
    !isSha256(raw.trustBundleFileSha256) || !isSha256(raw.receiptsFileSha256) ||
    !isSha256(raw.statusFileSha256)
  ) return undefined;
  return raw as unknown as LedgerFirmGovernanceClaim;
}

function parseAuthorizationReceipt(rawReceipt: unknown): LedgerAutonomousAuthorizationReceipt | undefined {
  if (!isRecord(rawReceipt)) return undefined;
  const firmGovernanceClaim = rawReceipt.firmGovernanceClaim === undefined
    ? undefined
    : parseFirmGovernanceClaim(rawReceipt.firmGovernanceClaim);
  if (rawReceipt.firmGovernanceClaim !== undefined && !firmGovernanceClaim) return undefined;
  const actualKeys = Object.keys(rawReceipt);
  const expectedKeyCount = AUTHORIZATION_RECEIPT_KEYS.length - (firmGovernanceClaim ? 0 : 1);
  if (
    actualKeys.length !== expectedKeyCount ||
    actualKeys.some((key) => !(AUTHORIZATION_RECEIPT_KEYS as readonly string[]).includes(key))
  ) return undefined;
  if (
    rawReceipt.receiptType !== "LEDGER_AUTONOMOUS_AUTHORIZATION" ||
    rawReceipt.kernelVersion !== LEDGER_CONTROL_KERNEL_VERSION ||
    !isExactNonEmptyString(rawReceipt.actionId) ||
    !isExactNonEmptyString(rawReceipt.providerId) ||
    !isExactNonEmptyString(rawReceipt.tenantId) ||
    !isExactNonEmptyString(rawReceipt.actorId) ||
    !isExactNonEmptyString(rawReceipt.workspaceId) ||
    !isExactNonEmptyString(rawReceipt.agentId) ||
    !isExactNonEmptyString(rawReceipt.installationId) ||
    !isExactNonEmptyString(rawReceipt.bindingId) ||
    !isPositiveSafeInteger(rawReceipt.bindingRevision) ||
    !isExactNonEmptyString(rawReceipt.connectionId) ||
    !isExactNonEmptyString(rawReceipt.targetSessionId) ||
    !isExactNonEmptyString(rawReceipt.delegationId) ||
    !isPositiveSafeInteger(rawReceipt.delegationRevision) ||
    !isSha256(rawReceipt.canonicalPayloadHash) ||
    !isSha256(rawReceipt.sourceRevisionHash) ||
    !isNonNegativeSafeInteger(rawReceipt.caseVersion) ||
    !isPositiveSafeInteger(rawReceipt.authoritySnapshotRevision) ||
    !isSha256(rawReceipt.authoritySnapshotHash) ||
    !isSha256(rawReceipt.deterministicValidationReceiptHash) ||
    !isSha256(rawReceipt.providerCapabilityReceiptHash) ||
    !isCanonicalIsoDate(rawReceipt.issuedAt) ||
    !isSha256(rawReceipt.receiptHash)
  ) return undefined;

  const unsignedReceipt = {
    receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
    kernelVersion: rawReceipt.kernelVersion,
    actionId: rawReceipt.actionId,
    providerId: rawReceipt.providerId,
    tenantId: rawReceipt.tenantId,
    actorId: rawReceipt.actorId,
    workspaceId: rawReceipt.workspaceId,
    agentId: rawReceipt.agentId,
    installationId: rawReceipt.installationId,
    bindingId: rawReceipt.bindingId,
    bindingRevision: rawReceipt.bindingRevision,
    connectionId: rawReceipt.connectionId,
    targetSessionId: rawReceipt.targetSessionId,
    delegationId: rawReceipt.delegationId,
    delegationRevision: rawReceipt.delegationRevision,
    canonicalPayloadHash: rawReceipt.canonicalPayloadHash,
    sourceRevisionHash: rawReceipt.sourceRevisionHash,
    caseVersion: rawReceipt.caseVersion,
    authoritySnapshotRevision: rawReceipt.authoritySnapshotRevision,
    authoritySnapshotHash: rawReceipt.authoritySnapshotHash,
    deterministicValidationReceiptHash: rawReceipt.deterministicValidationReceiptHash,
    providerCapabilityReceiptHash: rawReceipt.providerCapabilityReceiptHash,
    ...(firmGovernanceClaim ? { firmGovernanceClaim } : {}),
    issuedAt: rawReceipt.issuedAt,
  };
  if (hashObject(unsignedReceipt) !== rawReceipt.receiptHash) return undefined;
  return Object.freeze({ ...unsignedReceipt, receiptHash: rawReceipt.receiptHash });
}

function validContract(contract: unknown): contract is LedgerProviderPermitContract {
  if (!isRecord(contract) || !isExactNonEmptyString(contract.providerId) ||
      !isRecord(contract.actionByAdapterOperation)) return false;
  const entries = Object.entries(contract.actionByAdapterOperation);
  return entries.length > 0 && entries.every(([operation, action]) =>
    isExactNonEmptyString(operation) && isExactNonEmptyString(action));
}

/** Issues one provider-neutral authority from a hash-valid kernel receipt. */
export function issueLedgerProviderWritePermit(
  input: IssueLedgerProviderWritePermitInput,
): LedgerProviderWritePermit {
  if (
    !isRecord(input) ||
    !validContract(input.contract) ||
    !isRecord(input.request) ||
    !Object.hasOwn(input.contract.actionByAdapterOperation, input.adapterOperation) ||
    !isExactNonEmptyString(input.request.mutationRequestId) ||
    !isSha256(input.request.canonicalPayloadHash)
  ) throw permitIssuanceFailed("INVALID_ISSUER_INPUT");

  const receipt = parseAuthorizationReceipt(input.request.authorizationReceipt);
  if (!receipt) throw permitIssuanceFailed("AUTHORIZATION_RECEIPT_INVALID");
  if (receipt.providerId !== input.contract.providerId) {
    throw permitIssuanceFailed("PROVIDER_RECEIPT_MISMATCH");
  }
  if (receipt.canonicalPayloadHash !== input.request.canonicalPayloadHash) {
    throw permitIssuanceFailed("REQUEST_RECEIPT_MISMATCH");
  }
  const actionId = input.contract.actionByAdapterOperation[input.adapterOperation];
  if (!actionId || receipt.actionId !== actionId) {
    throw permitIssuanceFailed("ADAPTER_ACTION_MISMATCH");
  }

  const claims = Object.freeze({
    providerId: receipt.providerId,
    adapterOperation: input.adapterOperation,
    actionId,
    mutationRequestId: input.request.mutationRequestId,
    canonicalPayloadHash: input.request.canonicalPayloadHash,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    workspaceId: receipt.workspaceId,
    agentId: receipt.agentId,
    installationId: receipt.installationId,
    bindingId: receipt.bindingId,
    bindingRevision: receipt.bindingRevision,
    connectionId: receipt.connectionId,
    targetSessionId: receipt.targetSessionId,
  }) satisfies Readonly<LedgerProviderWritePermitClaims>;
  const permit = Object.freeze(Object.create(null)) as LedgerProviderWritePermit;
  permitState.set(permit, { claims, consumed: false });
  return permit;
}

function mismatchReason(
  actual: Readonly<LedgerProviderWritePermitClaims>,
  expected: Readonly<LedgerProviderWritePermitClaims>,
): PermitDenialReason | undefined {
  if (actual.providerId !== expected.providerId) return "PROVIDER_MISMATCH";
  if (actual.adapterOperation !== expected.adapterOperation) return "ADAPTER_OPERATION_MISMATCH";
  if (actual.actionId !== expected.actionId) return "ACTION_MISMATCH";
  if (actual.mutationRequestId !== expected.mutationRequestId) return "MUTATION_REQUEST_MISMATCH";
  if (actual.canonicalPayloadHash !== expected.canonicalPayloadHash) return "PAYLOAD_MISMATCH";
  if (actual.tenantId !== expected.tenantId) return "TENANT_MISMATCH";
  if (actual.actorId !== expected.actorId) return "ACTOR_MISMATCH";
  if (actual.workspaceId !== expected.workspaceId) return "WORKSPACE_MISMATCH";
  if (actual.agentId !== expected.agentId) return "AGENT_MISMATCH";
  if (actual.installationId !== expected.installationId) return "INSTALLATION_MISMATCH";
  if (actual.bindingId !== expected.bindingId) return "BINDING_MISMATCH";
  if (actual.bindingRevision !== expected.bindingRevision) return "BINDING_REVISION_MISMATCH";
  if (actual.connectionId !== expected.connectionId) return "CONNECTION_MISMATCH";
  if (actual.targetSessionId !== expected.targetSessionId) return "TARGET_SESSION_MISMATCH";
  return undefined;
}

/**
 * Irreversibly consumes before any provider token refresh or network I/O.
 * Poison-first semantics ensure even a mismatched first presentation cannot
 * be retried at another adapter or target.
 */
export function consumeLedgerProviderWritePermit(
  permit: LedgerProviderWritePermit | undefined,
  expected: Readonly<LedgerProviderWritePermitClaims>,
): Readonly<LedgerProviderWritePermitClaims> {
  if (!permit || (typeof permit !== "object" && typeof permit !== "function")) {
    throw permitDenied("INVALID");
  }
  const state = permitState.get(permit);
  if (!state) throw permitDenied("INVALID");
  if (state.consumed) throw permitDenied("CONSUMED");
  state.consumed = true;
  const mismatch = mismatchReason(state.claims, expected);
  if (mismatch) throw permitDenied(mismatch);
  return state.claims;
}
