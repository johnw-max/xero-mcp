import { createHmac } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import {
  executeAccountingCaseSchema,
  getAccountingCaseStatusSchema,
  prepareAccountingCasePublicSchema,
  type ExecuteAccountingCaseInput,
  type GetAccountingCaseStatusInput,
  type PrepareAccountingCasePublicInput,
} from "../domain/accountingCaseSchemas.js";
import type {
  AccountingCaseOperation,
  AccountingCaseTarget,
  AccountingFact,
  ContactDurableIdentity,
  NativeDocumentFact,
  OriginalTransactionEvidenceFact,
} from "../domain/accountingCase.js";
import type {
  AccountingCaseBinding,
  CreateOrAdvanceAccountingCaseInput,
  AccountingCaseOperationPreflight,
  AccountingCaseOperationRecord,
  AccountingCaseOperationReseal,
  AccountingCasePreflightResealReceipt,
  AccountingCaseSourceCaseClaim,
  AccountingCaseSourceCaseReference,
  AccountingCaseVersionRecord,
} from "../domain/accountingCasePersistence.js";
import {
  accountingCaseBusinessContinuationTemplate,
  accountingCaseContinuationTemplateHash,
  accountingCaseDependentContinuationTemplate,
  accountingCaseRecoveryResidualContinuationTemplate,
  accountingCaseRecoveryBusinessContinuationTemplate,
  hasAccountingCaseDependentContinuation,
  type AccountingCaseBusinessContinuationTemplate,
} from "../domain/accountingCaseContinuation.js";
import {
  ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS,
  accountingCasePlanHash,
  accountingCasePreflightReceiptHash,
  accountingCasePreflightResealReceiptHash,
  accountingCaseTerminalSummary,
} from "../domain/accountingCasePersistence.js";
import {
  AccountingCaseCompilationError,
  compileAccountingCase,
  validateCompiledOperationAgainstSource,
} from "../control-kernel/accountingCaseCompiler.js";
import {
  parseSealedAccountingMonetaryRule,
  quantizeAccountingLineNet,
  quantizeAccountingLineTax,
  resolveSupportedAccountingMonetaryRule,
  type SupportedAccountingMonetaryRule,
} from "../control-kernel/accountingMonetary.js";
import {
  createXeroAccountingCaseProviderContract,
  createXeroAccountingCaseProviderContractFromProjection,
  XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
  xeroDeclaredLedgerBindingFromProviderProjection,
  xeroContactDurableBusinessIdentityHash,
  xeroOriginalTransactionBindingFromProviderProjection,
  type XeroOriginalTransactionBindings,
  type XeroAccountingCaseContactBinding,
  type XeroAccountingCaseContactBindings,
} from "../policy/xeroAccountingCaseProviderContract.js";
import {
  createXeroDeclaredLedgerPolicy,
  createXeroDeclaredLedgerPolicyFromProjection,
  XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
} from "../policy/xeroDeclaredLedgerPolicy.js";
import { AppError, toSafeError } from "../errors.js";
import type { AccountingProvider, ContactSummary } from "../providers/types.js";
import { hashObject, safeEqual, sha256, stableStringify } from "../security/hash.js";
import { requireOAuthBoundRequestContext, type RequestContext } from "../security/requestContext.js";
import type { AccountingService } from "./accountingService.js";
import type {
  AutonomousActionsPreflightReceipt,
  XeroMutationService,
} from "./xeroMutationService.js";
import { xeroMutationRequestIdForPreparation } from "./xeroMutationService.js";
import type { XeroMutationRequest } from "../domain/xeroMutation.js";
import { resolveStableXeroTaxRate } from "../policy/xeroTaxRateResolver.js";
import { evaluateXeroNativeRouteContract } from "../policy/xeroNativeRouteContract.js";
import type { XeroFirmGovernanceExpectation } from "../policy/xeroFirmGovernanceClaim.js";
import {
  XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
  createXeroContactIdentityDecision,
  normalizeXeroContactIdentity,
  xeroContactIdentityEvidenceFromSummary,
  xeroContactIdentityMismatchReasons,
  xeroContactNamespaceContinuityEvidence,
  type XeroContactIdentityDecision,
  type XeroContactIdentityEvidence,
} from "../policy/xeroContactIdentity.js";
import {
  XeroDeclaredLedgerBindingError,
  bindXeroDeclaredLedger,
  createXeroDeclaredLedgerExecutionConstraints,
  requireXeroDeclaredLedgerAccount,
  xeroDeclaredLedgerAccount,
  type XeroDeclaredLedgerBinding,
  type XeroDeclaredLedgerExecutionConstraints,
} from "../policy/xeroDeclaredLedgerBinding.js";
import type { XeroTenantCoaProfile } from "../policy/xeroTenantCoaProfile.js";
import {
  findTrustedXeroRecurringSeriesAuthority,
  parseXeroAccountingCaseBusinessAuthorityProjection,
  xeroDocumentCoordinateAuthority,
  type XeroAccountingCaseBusinessAuthorityProfile,
} from "../policy/xeroBusinessCoordinateAuthority.js";
import {
  lookupXeroProviderBusinessCoordinate,
  lookupXeroOriginalTransaction,
  type XeroBusinessCoordinateHistoryReadPort,
} from "./xeroBusinessCoordinateHistory.js";
import type { AccountingCaseProviderBusinessHistoryLookup } from "../control-kernel/accountingCaseProviderContract.js";
import { createXeroExistingDocumentNoWriteEvidence } from "../policy/xeroAccountingCaseExistingDocumentEvidence.js";
import {
  createXeroOriginalTransactionEvidence,
  XeroOriginalTransactionEvidenceError,
} from "../policy/xeroOriginalTransactionEvidence.js";

type CaseMutationProjectionState =
  | "WRITE_IN_FLIGHT"
  | "READBACK_VERIFIED"
  | "WRITE_UNCERTAIN"
  | "READBACK_MISMATCH"
  | "PROVIDER_REJECTED"
  | "BLOCKED_VALIDATION";

type CasePreparationProviderReferences = {
  contact?: ContactSummary;
  creditLineAccountIds?: readonly string[];
  ledgerBinding?: XeroDeclaredLedgerBinding;
};

type ContactResolution = Readonly<{
  requestedName: string;
  contactId: string;
  contactName: string;
  status: "ACTIVE";
  identity: XeroContactIdentityDecision;
}>;

type XeroContactLifecycleStatus = "ACTIVE" | "ARCHIVED" | "GDPRREQUEST";

type XeroContactLifecycleIndex = Readonly<{
  active: readonly ContactSummary[];
  archived: readonly ContactSummary[];
  gdprRequest: readonly ContactSummary[];
  all: readonly ContactSummary[];
}>;

type SafeOperationStatus = {
  operation_id: string;
  event_id: string;
  action_id: AccountingCaseOperation["actionId"];
  state: AccountingCaseOperationRecord["state"];
  xero_object_id?: string;
  provider_receipt_recorded: boolean;
  exact_readback_recorded: boolean;
  failure?: {
    code?: string;
    retryable?: boolean;
    mutation_state?: string;
    failure_layer?: string;
    recovery_action?: string;
    reason_codes?: string[];
  };
};

export interface AccountingCaseSummary {
  case_id: string;
  case_version: number;
    state: AccountingCaseVersionRecord["state"];
  source_revision_hash: string;
  compiled_plan_hash: string;
  compiler_version: string;
  policy_version: string;
  coverage: {
    supplied_set: "COMPLETE" | "INCOMPLETE";
    expected_artifacts: number;
    expected_source_units: number;
    expected_fact_requirements: number;
    satisfied_fact_requirements: number;
    missing_fact_requirements: AccountingCaseVersionRecord["compiled"]["coverage"]["missingFactRequirements"];
  };
  events: Array<{
    event_id: string;
    event_key: string;
    disposition: AccountingCaseVersionRecord["compiled"]["events"][number]["disposition"];
    route?: string;
    reason_codes: string[];
  }>;
  operations: SafeOperationStatus[];
  residual_event_count: number;
  source_claim: {
    /** The current public intake contains submitted/model-extracted facts, not an independently verified original file. */
    trust: "UNVERIFIED_SUBMITTED_FACTS";
    source_truth_claim: "NOT_VERIFIED";
    original_file_verified: false;
    fact_origins: Array<"MODEL_EXTRACTED" | "AGENT_ASSERTED" | "SERVER_RESOLVED_PROVIDER_EVIDENCE">;
    document_validity_basis: "SUBMITTED_ASSERTION";
  };
  completion_claim: {
    supplied_set_coverage: "COMPLETE" | "INCOMPLETE";
    eligible_write_status: "NONE" | "PARTIAL" | "ALL_READBACK_VERIFIED" | "UNKNOWN";
    whole_business_completeness: "NOT_ASSERTED";
    ledger_write_claim: "NOT_WRITTEN" | "PARTIALLY_VERIFIED" | "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" | "RECOVERY_REQUIRED";
  };
  last_execution_error?: {
    code?: string;
    retryable?: boolean;
    failure_layer?: string;
    recovery_action?: string;
    reason_codes?: string[];
  };
  continuation?:
    | {
        action: "PREPARE_NEXT_CASE_VERSION";
        next_expected_version: number;
        token: string;
        prepare_template: AccountingCaseBusinessContinuationTemplate;
      }
    | {
        action: "PREPARE_RECOVERY_SUCCESSOR_CASE";
        next_expected_version: 0;
        token: string;
        prepare_template: AccountingCaseBusinessContinuationTemplate;
      };
}

function caseBinding(context: RequestContext, tenantId: string): AccountingCaseBinding {
  const principal = requireOAuthBoundRequestContext(context);
  if (
    !principal.targetSessionId ||
    !principal.targetSessionHash ||
    !principal.targetSessionExpiresAt
  ) {
    throw new AppError("TARGET_SESSION_REQUIRED", "A pinned Xero ledger target is required for an Accounting Case.", {
      httpStatus: 403,
    });
  }
  if (principal.targetSessionExpiresAt.getTime() <= Date.now()) {
    throw new AppError("TARGET_SESSION_EXPIRED", "The pinned Xero ledger target has expired.", {
      httpStatus: 409,
    });
  }
  return {
    actorId: principal.actorId,
    workspaceId: principal.workspaceId,
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    agentId: principal.agentId,
    installationId: principal.oauthInstallationId,
    bindingId: principal.bindingId,
    bindingRevision: principal.bindingRevision,
    connectionId: principal.connectionId,
    tenantId,
    targetSessionId: principal.targetSessionId,
    targetSessionHash: principal.targetSessionHash,
    targetSessionExpiresAt: new Date(principal.targetSessionExpiresAt),
  };
}

/** Every provider-native coordinate a submitted Case explicitly declares. */
function declaredLedgerCoordinates(
  facts: readonly AccountingFact[],
): Readonly<{ accountCodes: readonly string[]; taxTypes: readonly string[] }> {
  const accountCodes = new Set<string>();
  const taxTypes = new Set<string>();
  for (const fact of facts) {
    if (fact.kind !== "NATIVE_DOCUMENT") continue;
    for (const line of fact.lines) {
      accountCodes.add(line.accountCode);
      taxTypes.add(line.taxType);
    }
  }
  return Object.freeze({ accountCodes: [...accountCodes], taxTypes: [...taxTypes] });
}

/** Recover the declared coordinate set a sealed binding was built from. */
function sealedDeclaredLedgerCoordinates(
  binding: XeroDeclaredLedgerBinding,
): Readonly<{ accountCodes: readonly string[]; taxTypes: readonly string[] }> {
  return Object.freeze({
    accountCodes: [
      ...binding.accounts.map((account) => account.declaredCode),
      ...binding.unresolvedAccountCodes.map((entry) => entry.declared),
    ],
    taxTypes: [
      ...binding.taxRates.map((taxRate) => taxRate.taxType),
      ...binding.unresolvedTaxTypes.map((entry) => entry.declared),
    ],
  });
}

function canonicalContactName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

function exactName(left: string | undefined, right: string): boolean {
  return left !== undefined && canonicalContactName(left) === canonicalContactName(right);
}

function fixedNumber(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u.test(value)) {
    throw new AppError("VALIDATION_FAILED", `Accounting Case ${field} is not a canonical non-negative decimal.`, {
      httpStatus: 422,
    });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError("VALIDATION_FAILED", `Accounting Case ${field} is outside the supported range.`, {
      httpStatus: 422,
    });
  }
  return parsed;
}

function lineAmountType(value: unknown): "Exclusive" | "Inclusive" | "NoTax" {
  if (value === "EXCLUSIVE") return "Exclusive";
  if (value === "INCLUSIVE") return "Inclusive";
  if (value === "NO_TAX") return "NoTax";
  throw new AppError("VALIDATION_FAILED", "Accounting Case line amount type is invalid.", { httpStatus: 422 });
}

const CASE_DECIMAL_SCALE = 10_000n;

function scaledCaseDecimal(value: unknown, field: string): bigint {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u.test(value)) {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * CASE_DECIMAL_SCALE + BigInt((fraction + "0000").slice(0, 4));
  }
  if (
    typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    Number.isSafeInteger(Math.round(value * Number(CASE_DECIMAL_SCALE))) &&
    Math.abs(value * Number(CASE_DECIMAL_SCALE) - Math.round(value * Number(CASE_DECIMAL_SCALE))) < 1e-7
  ) {
    return BigInt(Math.round(value * Number(CASE_DECIMAL_SCALE)));
  }
  throw new AppError("PERSISTENCE_FAILURE", `Prepared Xero ${field} is not an exact non-negative four-decimal value.`, {
    httpStatus: 503,
    details: { reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"] },
  });
}

function fixedFourScaled(value: bigint): string {
  return `${value / CASE_DECIMAL_SCALE}.${(value % CASE_DECIMAL_SCALE).toString().padStart(4, "0")}`;
}

function enteredLineAmount(
  quantity: unknown,
  unitAmount: unknown,
  field: string,
  monetaryRule: SupportedAccountingMonetaryRule,
): string {
  const quantityScaled = scaledCaseDecimal(quantity, `${field}.quantity`);
  const unitAmountScaled = scaledCaseDecimal(unitAmount, `${field}.unitAmount`);
  return fixedFourScaled(quantizeAccountingLineNet(quantityScaled, unitAmountScaled, monetaryRule));
}

function canonicalOptionalFixedFour(value: unknown, field: string): string | null {
  return value === undefined ? null : fixedFourScaled(scaledCaseDecimal(value, field));
}

function compactCaseText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function contactDurableIdentityFromPayload(value: unknown): ContactDurableIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("PERSISTENCE_FAILURE", "The compiled contact durable identity is invalid.", {
      httpStatus: 503,
      details: { reasonCodes: ["CONTACT_DURABLE_IDENTITY_INVALID"] },
    });
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === "LEGAL_REGISTRY" &&
    typeof candidate.jurisdiction === "string" &&
    typeof candidate.registryScheme === "string" &&
    typeof candidate.number === "string"
  ) return Object.freeze({
    kind: "LEGAL_REGISTRY",
    jurisdiction: candidate.jurisdiction,
    registryScheme: candidate.registryScheme,
    number: candidate.number,
  });
  if (
    candidate.kind === "PROVIDER_TENANT_ACCOUNT" &&
    typeof candidate.providerId === "string" &&
    typeof candidate.namespace === "string" &&
    typeof candidate.number === "string"
  ) return Object.freeze({
    kind: "PROVIDER_TENANT_ACCOUNT",
    providerId: candidate.providerId,
    namespace: candidate.namespace,
    number: candidate.number,
  });
  throw new AppError("PERSISTENCE_FAILURE", "The compiled contact durable identity is invalid.", {
    httpStatus: 503,
    details: { reasonCodes: ["CONTACT_DURABLE_IDENTITY_INVALID"] },
  });
}

function safeErrorReceipt(error: unknown): Record<string, unknown> {
  const safe = toSafeError(error);
  const reasonCodes = [
    safe.details?.reasonCodes,
    safe.details?.denyReasons,
    safe.details?.validationReasonCodes,
    safe.details?.providerAccessDenyReasons,
  ].flatMap((values) => Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : []).slice(0, 16);
  return {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    ...(typeof safe.details?.failureLayer === "string" ? { failureLayer: safe.details.failureLayer } : {}),
    ...(reasonCodes && reasonCodes.length > 0 ? { reasonCodes } : {}),
    ...(typeof safe.details?.recoveryAction === "string" ? { recoveryAction: safe.details.recoveryAction } : {}),
    ...(typeof safe.details?.providerMutationPossible === "boolean"
      ? { providerMutationPossible: safe.details.providerMutationPossible }
      : {}),
    recordedAt: new Date().toISOString(),
  };
}

function safeFailureProjection(receipt: Record<string, unknown> | undefined): SafeOperationStatus["failure"] {
  if (!receipt) return undefined;
  const code = typeof receipt.code === "string"
    ? receipt.code
    : typeof receipt.errorCode === "string"
      ? receipt.errorCode
      : undefined;
  const retryable = typeof receipt.retryable === "boolean" ? receipt.retryable : undefined;
  const mutationState = typeof receipt.mutationState === "string" ? receipt.mutationState : undefined;
  const failureLayer = typeof receipt.failureLayer === "string" ? receipt.failureLayer : undefined;
  const recoveryAction = typeof receipt.recoveryAction === "string" ? receipt.recoveryAction : undefined;
  const reasonCodes = Array.isArray(receipt.reasonCodes)
    ? receipt.reasonCodes.filter((value): value is string => typeof value === "string").slice(0, 16)
    : undefined;
  if (!code && retryable === undefined && !mutationState && !failureLayer && !recoveryAction && !reasonCodes?.length) {
    return undefined;
  }
  return {
    ...(code ? { code } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(mutationState ? { mutation_state: mutationState } : {}),
    ...(failureLayer ? { failure_layer: failureLayer } : {}),
    ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
    ...(reasonCodes?.length ? { reason_codes: reasonCodes } : {}),
  };
}

function operationStatus(record: AccountingCaseOperationRecord): SafeOperationStatus {
  const failure = safeFailureProjection(record.errorReceipt);
  return {
    operation_id: record.operation.operationId,
    event_id: record.operation.eventId,
    action_id: record.operation.actionId,
    state: record.state,
    ...(record.xeroObjectId ? { xero_object_id: record.xeroObjectId } : {}),
    provider_receipt_recorded: record.writeReceipt !== undefined,
    exact_readback_recorded: record.readbackSnapshot !== undefined,
    ...(failure ? { failure } : {}),
  };
}

function continuationProjection(
  record: AccountingCaseVersionRecord,
  secret: Buffer,
): NonNullable<AccountingCaseSummary["continuation"]> {
  const prepareTemplate = accountingCaseDependentContinuationTemplate(record.compiled);
  const templateHash = accountingCaseContinuationTemplateHash(prepareTemplate);
  const signature = createHmac("sha256", secret).update(stableStringify({
    domain: "xero-accounting-case-continuation:v1",
    caseId: record.compiled.caseId,
    caseVersion: record.compiled.version,
    compiledPlanHash: record.compiledPlanHash,
    templateHash,
  })).digest("hex");
  return {
    action: "PREPARE_NEXT_CASE_VERSION",
    next_expected_version: record.compiled.version,
    token: `acc_${signature}`,
    prepare_template: prepareTemplate,
  };
}

function recoveryResidualContinuationProjection(
  record: AccountingCaseVersionRecord,
  secret: Buffer,
): Extract<NonNullable<AccountingCaseSummary["continuation"]>, {
  action: "PREPARE_RECOVERY_SUCCESSOR_CASE";
}> {
  const grant = record.recoveryResidualGrant;
  if (!grant) throw new Error("Accounting Case recovery residual continuation grant is missing.");
  const signature = createHmac("sha256", secret).update(stableStringify({
    domain: "xero-accounting-case-expired-target-residual:v1",
    grantId: grant.grantId,
    sourceCaseId: grant.sourceCaseId,
    sourceVersion: grant.sourceVersion,
    sourcePlanHash: grant.sourcePlanHash,
    successorCaseId: grant.successorCaseId,
    templateHash: grant.templateHash,
    targetSessionHash: grant.successorBinding.targetSessionHash,
    targetSessionExpiresAt: grant.successorBinding.targetSessionExpiresAt.toISOString(),
  })).digest("hex");
  return {
    action: "PREPARE_RECOVERY_SUCCESSOR_CASE",
    next_expected_version: 0,
    token: `acr_${signature}`,
    prepare_template: grant.template,
  };
}

function summary(record: AccountingCaseVersionRecord, continuationSecret: Buffer): AccountingCaseSummary {
  const operations = record.operations.map(operationStatus);
  const writtenAndVerified = operations.filter((operation) => operation.state === "READBACK_VERIFIED").length;
  const resolved = operations.filter((operation) =>
    operation.state === "READBACK_VERIFIED" || operation.state === "NO_WRITE_REQUIRED").length;
  const uncertain = operations.some((operation) =>
    operation.state === "WRITE_IN_FLIGHT" ||
    operation.state === "WRITE_UNCERTAIN" ||
    operation.state === "READBACK_MISMATCH");
  const awaitingContinuation = record.state === "AWAITING_CONTINUATION";
  const recoveryResidualContinuation = record.recoveryResidualGrant !== undefined;
  const eligibleWriteStatus = uncertain
    ? "UNKNOWN" as const
    : awaitingContinuation && writtenAndVerified > 0
      ? "PARTIAL" as const
    : operations.length === 0 || writtenAndVerified === 0
      ? "NONE" as const
      : resolved === operations.length
        ? "ALL_READBACK_VERIFIED" as const
        : writtenAndVerified > 0
          ? "PARTIAL" as const
          : "NONE" as const;
  const ledgerWriteClaim = uncertain || record.state === "RECOVERY_REQUIRED"
    ? "RECOVERY_REQUIRED" as const
    : eligibleWriteStatus === "ALL_READBACK_VERIFIED"
      ? "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" as const
      : eligibleWriteStatus === "PARTIAL"
        ? "PARTIALLY_VERIFIED" as const
        : "NOT_WRITTEN" as const;
  const residualEventCount = record.compiled.events.filter((event) =>
    event.disposition === "REVIEW_REQUIRED" ||
    event.disposition === "BLOCKED_UNSUPPORTED" ||
    event.disposition === "BLOCKED_VALIDATION").length;
  const lastError = record.lastExecutionErrorReceipt?.error;
  const safeLastError = lastError && typeof lastError === "object" && !Array.isArray(lastError)
    ? safeFailureProjection(lastError as Record<string, unknown>)
    : undefined;
  const factOrigins = [...new Set(record.compiled.activeFacts.map((fact) => fact.origin))]
    .sort((left, right) => left.localeCompare(right));
  return {
    case_id: record.compiled.caseId,
    case_version: record.compiled.version,
    state: record.state,
    source_revision_hash: record.compiled.sourceRevisionHash,
    compiled_plan_hash: record.compiledPlanHash,
    compiler_version: record.compiled.compilerVersion,
    policy_version: record.compiled.policyVersion,
    coverage: {
      supplied_set: record.compiled.completionClaim.suppliedSetCoverage,
      expected_artifacts: record.compiled.coverage.expectedArtifactCount,
      expected_source_units: record.compiled.coverage.expectedSourceUnitCount,
      expected_fact_requirements: record.compiled.coverage.expectedFactRequirementCount,
      satisfied_fact_requirements: record.compiled.coverage.satisfiedFactRequirementCount,
      missing_fact_requirements: record.compiled.coverage.missingFactRequirements,
    },
    events: record.compiled.events.map((event) => ({
      event_id: event.eventId,
      event_key: event.eventKey,
      disposition: event.disposition,
      ...(event.route ? { route: event.route } : {}),
      reason_codes: event.reasonCodes,
    })),
    operations,
    residual_event_count: residualEventCount,
    source_claim: {
      trust: "UNVERIFIED_SUBMITTED_FACTS",
      source_truth_claim: "NOT_VERIFIED",
      original_file_verified: false,
      fact_origins: factOrigins,
      document_validity_basis: "SUBMITTED_ASSERTION",
    },
    completion_claim: {
      supplied_set_coverage: record.compiled.completionClaim.suppliedSetCoverage,
      eligible_write_status: eligibleWriteStatus,
      whole_business_completeness: "NOT_ASSERTED",
      ledger_write_claim: ledgerWriteClaim,
    },
    ...(safeLastError ? {
      last_execution_error: {
        ...(safeLastError.code ? { code: safeLastError.code } : {}),
        ...(safeLastError.retryable !== undefined ? { retryable: safeLastError.retryable } : {}),
        ...(safeLastError.failure_layer ? { failure_layer: safeLastError.failure_layer } : {}),
        ...(safeLastError.recovery_action ? { recovery_action: safeLastError.recovery_action } : {}),
        ...(safeLastError.reason_codes ? { reason_codes: safeLastError.reason_codes } : {}),
      },
    } : {}),
    ...(recoveryResidualContinuation
      ? { continuation: recoveryResidualContinuationProjection(record, continuationSecret) }
      : awaitingContinuation
        ? { continuation: continuationProjection(record, continuationSecret) }
        : {}),
  };
}

export class XeroAccountingCaseService {
  readonly #testTenantIds: ReadonlySet<string>;
  readonly #clock: () => Date;
  readonly #continuationSecret: Buffer;
  readonly #businessAuthorities: ReadonlyMap<string, XeroAccountingCaseBusinessAuthorityProfile>;

  constructor(
    private readonly repository: AccountingRepository,
    private readonly provider: AccountingProvider,
    private readonly accounting: AccountingService,
    private readonly mutations: Pick<XeroMutationService, "preflightAutonomousActions" | "markUnknown">,
    options: {
      continuationSecret: Buffer;
      testTenantIds?: readonly string[];
      /**
       * ADR-002: retained for deployment compatibility only. Account and tax
       * coordinates are declared by the caller and verified against the target
       * tenant's live data, so this profile no longer gates any write.
       */
      tenantCoaProfiles?: readonly XeroTenantCoaProfile[];
      businessAuthorityProfiles?: readonly XeroAccountingCaseBusinessAuthorityProfile[];
      clock?: () => Date;
    },
  ) {
    if (options.continuationSecret.length < 32) {
      throw new Error("Accounting Case continuation secret must contain at least 32 bytes.");
    }
    this.#testTenantIds = new Set(options?.testTenantIds ?? []);
    this.#clock = options?.clock ?? (() => new Date());
    this.#continuationSecret = Buffer.from(options.continuationSecret);
    const authorities = options.businessAuthorityProfiles ?? [];
    this.#businessAuthorities = new Map(authorities.map((profile) => [profile.tenant_id, profile]));
    if (this.#businessAuthorities.size !== authorities.length) {
      throw new Error("Xero Accounting Case business-authority tenant IDs must be unique.");
    }
  }

  #organisationTargetSettings(
    organisation: Awaited<ReturnType<AccountingProvider["getOrganisation"]>>,
  ): Readonly<Pick<AccountingCaseTarget,
    "periodLockDate" | "endOfYearLockDate" | "organisationStatus"> & { paysTax: boolean }> {
    if (organisation.paysTax === undefined) {
      throw new AppError("VALIDATION_FAILED", "The Xero organisation sales-tax registration status is unknown.", {
        httpStatus: 422,
        details: { reasonCodes: ["ORGANISATION_GST_REGISTRATION_UNKNOWN"] },
      });
    }
    const organisationStatus = organisation.organisationStatus?.trim().toUpperCase();
    if (!organisationStatus || !["ACTIVE", "OK"].includes(organisationStatus)) {
      throw new AppError("VALIDATION_FAILED", "The Xero organisation is not in a released active state.", {
        httpStatus: 422,
        details: { reasonCodes: [organisationStatus ? "ORGANISATION_NOT_ACTIVE" : "ORGANISATION_STATUS_UNKNOWN"] },
      });
    }
    return {
      paysTax: organisation.paysTax,
      ...(organisation.periodLockDate ? { periodLockDate: organisation.periodLockDate } : {}),
      ...(organisation.endOfYearLockDate ? { endOfYearLockDate: organisation.endOfYearLockDate } : {}),
      organisationStatus,
    };
  }

  /**
   * Bind the coordinates a Case declared to the target tenant's live chart of
   * accounts and tax-rate table. Unresolvable declarations are carried inside
   * the binding so the accounting policy can block the Case with deterministic
   * per-line reason codes and zero provider writes.
   */
  async #currentLedgerBinding(
    context: RequestContext,
    tenantId: string,
    jurisdiction: string,
    declared: Readonly<{ accountCodes: readonly string[]; taxTypes: readonly string[] }>,
  ): Promise<XeroDeclaredLedgerBinding> {
    const [accounts, taxRates] = await Promise.all([
      this.accounting.listAccounts(context, {}),
      this.accounting.listTaxRates(context),
    ]);
    try {
      return bindXeroDeclaredLedger({
        tenantId,
        jurisdiction,
        accountCodes: declared.accountCodes,
        taxTypes: declared.taxTypes,
        accounts,
        taxRates,
      });
    } catch (error) {
      if (!(error instanceof XeroDeclaredLedgerBindingError)) throw error;
      throw new AppError("VALIDATION_FAILED", error.message, {
        httpStatus: 422,
        retryable: false,
        details: {
          failureLayer: "XERO_DECLARED_LEDGER_BINDING",
          reasonCodes: [error.reasonCode],
          ...(error.declared ? { declaredCoordinate: error.declared } : {}),
          recoveryAction: "CORRECT_DECLARED_LEDGER_COORDINATES_AND_PREPARE_NEW_CASE_VERSION",
          providerMutationPossible: false,
        },
        cause: error,
      });
    }
  }

  async #assertCurrentOrganisationPolicy(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
  ): Promise<void> {
    const pinnedLedgerBinding = xeroDeclaredLedgerBindingFromProviderProjection(
      record.compiled.providerProjection,
    );
    const [organisation, currentLedgerBinding] = await Promise.all([
      this.provider.getOrganisation(context),
      this.#currentLedgerBinding(
        context,
        record.binding.tenantId,
        record.compiled.target.taxJurisdiction,
        sealedDeclaredLedgerCoordinates(pinnedLedgerBinding),
      ),
    ]);
    if (organisation.organisationId !== record.binding.tenantId) {
      throw new AppError("CONFLICT", "Xero organisation settings no longer match the Accounting Case target.", {
        httpStatus: 409,
      });
    }
    const current = this.#organisationTargetSettings(organisation);
    const pinned = record.compiled.target;
    const pinnedPolicy = createXeroDeclaredLedgerPolicyFromProjection(record.compiled.policyProjection);
    const pinnedOrganisation = pinnedPolicy.planProjection.organisation as Readonly<Record<string, unknown>>;
    if (
      current.paysTax !== pinnedOrganisation.paysTax ||
      current.periodLockDate !== pinned.periodLockDate ||
      current.endOfYearLockDate !== pinned.endOfYearLockDate ||
      current.organisationStatus !== pinned.organisationStatus
    ) {
      throw new AppError("VALIDATION_FAILED", "Xero organisation tax or lock settings changed after this Case was compiled.", {
        httpStatus: 409,
        details: { reasonCodes: ["ORGANISATION_POLICY_SNAPSHOT_STALE"] },
      });
    }
    if (currentLedgerBinding.bindingHash !== pinnedLedgerBinding.bindingHash) {
      throw new AppError("STALE_PREFLIGHT", "The live Xero binding for this Case's declared accounts or tax codes changed after it was compiled.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "XERO_DECLARED_LEDGER_BINDING",
          reasonCodes: ["XERO_DECLARED_LEDGER_BINDING_DRIFT"],
          recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
          providerMutationPossible: false,
        },
      });
    }
  }

  #assertSupportedStoredProjection(record: AccountingCaseVersionRecord): void {
    const policyVersion = record.compiled.policyProjection.schemaVersion;
    const providerVersion = record.compiled.providerProjection.schemaVersion;
    if (
      policyVersion === XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION &&
      providerVersion === XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION
    ) return;
    const recoveryRequired = record.state === "RECOVERY_REQUIRED" || record.operations.some((operation) =>
      ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state));
    throw new AppError("STALE_PREFLIGHT", recoveryRequired
      ? "This Accounting Case requires the compatible prior release to complete exact readback recovery; the current release will not reinterpret its legacy account binding."
      : "This Accounting Case was compiled under a legacy policy/provider projection and must be prepared as a new Case under the current tenant COA profile.", {
      httpStatus: 409,
      retryable: false,
      details: {
        failureLayer: "ACCOUNTING_CASE_PROJECTION_UPGRADE",
        reasonCodes: ["ACCOUNTING_CASE_PROJECTION_UPGRADE_REQUIRED"],
        recoveryAction: recoveryRequired
          ? "RESTORE_COMPATIBLE_RELEASE_AND_RECOVER_CASE"
          : "PREPARE_NEW_ACCOUNTING_CASE",
        providerMutationPossible: false,
        storedPolicyProjectionVersion: policyVersion ?? null,
        storedProviderProjectionVersion: providerVersion ?? null,
        requiredPolicyProjectionVersion: XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
        requiredProviderProjectionVersion: XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
      },
    });
  }

  async #providerBusinessCoordinateHistory(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ): Promise<AccountingCaseProviderBusinessHistoryLookup> {
    if (operation.nativeRoute === "CONTACT_CREATE") {
      throw new AppError("PERSISTENCE_FAILURE", "Provider document history requires a native document operation.", {
        httpStatus: 503,
      });
    }
    const nativeRoute = operation.nativeRoute;
    const result = await lookupXeroProviderBusinessCoordinate({
      reader: this.provider as XeroBusinessCoordinateHistoryReadPort,
      principal: context,
      operation,
    });
    if (result.state === "INCOMPLETE") {
      throw new AppError("VALIDATION_FAILED", "The complete Xero business-coordinate history could not be proven.", {
        httpStatus: 422,
        retryable: false,
        details: {
          failureLayer: "XERO_PROVIDER_BUSINESS_COORDINATE_HISTORY",
          reasonCodes: result.reasonCodes,
          lookupState: result.state,
          providerMutationPossible: false,
          recoveryAction: "COMPLETE_PROVIDER_HISTORY_READ_OR_MANUAL_REVIEW",
        },
      });
    }
    if (result.state === "AMBIGUOUS") {
      throw new AppError("CONFLICT", "More than one Xero object owns the sealed business coordinate.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "XERO_PROVIDER_BUSINESS_COORDINATE_HISTORY",
          reasonCodes: ["PROVIDER_BUSINESS_COORDINATE_AMBIGUOUS"],
          lookupState: result.state,
          providerObjectIds: result.providerObjectIds,
          providerMutationPossible: false,
          recoveryAction: "MANUAL_PROVIDER_DUPLICATE_REVIEW",
        },
      });
    }
    if (result.state === "EXACT_ONE" && !result.canonicalEconomicMatch) {
      throw new AppError("CONFLICT", "An existing Xero object owns the coordinate with different canonical economics.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "XERO_PROVIDER_BUSINESS_COORDINATE_HISTORY",
          reasonCodes: ["PROVIDER_BUSINESS_COORDINATE_ECONOMIC_MISMATCH", ...result.mismatchReasons],
          lookupState: result.state,
          providerObjectId: result.providerObjectId,
          providerMutationPossible: false,
          recoveryAction: "MANUAL_PROVIDER_OBJECT_REVIEW",
        },
      });
    }
    if (result.state === "NONE") {
      const rawAuthority = record.compiled.providerProjection.businessAuthority;
      let authority;
      try {
        authority = parseXeroAccountingCaseBusinessAuthorityProjection(rawAuthority);
      } catch (error) {
        throw new AppError("PERSISTENCE_FAILURE", "The sealed Xero business-coordinate authority is invalid.", {
          httpStatus: 503,
          cause: error,
        });
      }
      const reference = operation.canonicalPayload.reference;
      const referenceKind = operation.canonicalPayload.referenceKind;
      const contactId = operation.canonicalPayload.xeroContactId;
      if (
        authority.tenantId.toLowerCase() !== record.binding.tenantId.toLowerCase() ||
        typeof reference !== "string" ||
        typeof contactId !== "string" ||
        (referenceKind !== "FORMAL_DOCUMENT_NUMBER" &&
          referenceKind !== "GENERIC_RECURRING_REFERENCE")
      ) {
        throw new AppError("PERSISTENCE_FAILURE", "The sealed Xero business-coordinate projection is invalid.", {
          httpStatus: 503,
        });
      }
      const coordinateAuthority = xeroDocumentCoordinateAuthority(nativeRoute, referenceKind);
      const recurringAuthority = referenceKind === "GENERIC_RECURRING_REFERENCE"
        ? findTrustedXeroRecurringSeriesAuthority(authority, {
            route: nativeRoute,
            contactId,
            reference,
          })
        : undefined;
      const sealedRecurringAuthority = operation.businessIdentity.canonicalFields.recurringSeriesAuthority;
      const recurringAuthorityProven = referenceKind !== "GENERIC_RECURRING_REFERENCE" || (
        recurringAuthority !== undefined &&
        operation.businessReservation.scope === "DATED_OCCURRENCE" &&
        operation.businessReservation.occurrenceDate === operation.canonicalPayload.documentDate &&
        sealedRecurringAuthority !== null &&
        typeof sealedRecurringAuthority === "object" &&
        !Array.isArray(sealedRecurringAuthority) &&
        (sealedRecurringAuthority as Record<string, unknown>).authorityId === recurringAuthority.authorityId &&
        (sealedRecurringAuthority as Record<string, unknown>).revision === recurringAuthority.revision &&
        (sealedRecurringAuthority as Record<string, unknown>).occurrenceKey === recurringAuthority.occurrenceKey &&
        (sealedRecurringAuthority as Record<string, unknown>).verificationReceiptSha256 ===
          recurringAuthority.verificationReceiptSha256
      );
      const exclusiveWriterProven = authority.writerAuthority.mode === "VERIFIED_FIRM_GOVERNANCE" &&
        authority.writerAuthority.providerAtomicUniqueness === false &&
        authority.writerAuthority.governanceAuthorityActive === true;
      if (!recurringAuthorityProven || (
        coordinateAuthority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER" &&
        !exclusiveWriterProven
      )) {
        throw new AppError(
          "VALIDATION_FAILED",
          "The sealed Xero business coordinate lacks the provider uniqueness or governed-writer authority required for an autonomous create.",
          {
            httpStatus: 422,
            retryable: false,
            details: {
              failureLayer: "XERO_PROVIDER_BUSINESS_COORDINATE_AUTHORITY",
              reasonCodes: [
                ...(!recurringAuthorityProven ? ["PROVIDER_RECURRING_SERIES_AUTHORITY_UNPROVEN"] : []),
                ...(coordinateAuthority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER" &&
                  !exclusiveWriterProven
                  ? ["PROVIDER_BUSINESS_COORDINATE_ATOMICITY_UNPROVEN"]
                  : []),
              ],
              providerMutationPossible: false,
              recoveryAction: "CONFIGURE_VERIFIED_EXCLUSIVE_WRITER_OR_USE_MANUAL_REVIEW",
              exactlyOnceClaim: false,
            },
          },
        );
      }
    }
    return result;
  }

  #sealedFirmGovernanceExpectation(
    operation: AccountingCaseOperation,
  ): XeroFirmGovernanceExpectation {
    if (operation.nativeRoute === "CONTACT_CREATE") {
      throw new AppError("PERSISTENCE_FAILURE", "A contact operation has no document governance coordinate.", {
        httpStatus: 503,
      });
    }
    const payload = operation.canonicalPayload;
    const referenceKind = payload.referenceKind;
    const authoritativeProviderField = payload.authoritativeProviderField;
    const contactId = payload.xeroContactId;
    const reference = payload.reference;
    if ((referenceKind !== "FORMAL_DOCUMENT_NUMBER" &&
          referenceKind !== "GENERIC_RECURRING_REFERENCE") ||
        (authoritativeProviderField !== "INVOICE_NUMBER" &&
          authoritativeProviderField !== "CREDIT_NOTE_NUMBER" &&
          authoritativeProviderField !== "REFERENCE") ||
        typeof contactId !== "string" || typeof reference !== "string") {
      throw new AppError("PERSISTENCE_FAILURE", "The Case has no exact sealed governance coordinate.", {
        httpStatus: 503,
      });
    }
    const rawRecurring = operation.businessIdentity.canonicalFields.recurringSeriesAuthority;
    const recurring = rawRecurring && typeof rawRecurring === "object" && !Array.isArray(rawRecurring)
      ? rawRecurring as Record<string, unknown>
      : undefined;
    return Object.freeze({
      route: operation.nativeRoute,
      referenceKind,
      authoritativeProviderField,
      contactId,
      reference,
      ...(typeof recurring?.authorityId === "string"
        ? { recurringAuthorityId: recurring.authorityId }
        : {}),
      ...(typeof recurring?.revision === "number"
        ? { recurringAuthorityRevision: recurring.revision }
        : {}),
    });
  }

  #sealedOriginalTransactionEvidence(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ) {
    const evidenceHash = operation.canonicalPayload.originalTransactionEvidenceHash;
    if (typeof evidenceHash !== "string" || !/^[a-f0-9]{64}$/u.test(evidenceHash)) {
      throw new AppError("PERSISTENCE_FAILURE", "A credit operation has no sealed original-transaction evidence hash.", {
        httpStatus: 503,
      });
    }
    const event = record.compiled.events.find((candidate) => candidate.eventId === operation.eventId);
    const credit = record.compiled.activeFacts.find((candidate): candidate is NativeDocumentFact =>
      candidate.kind === "NATIVE_DOCUMENT" && candidate.factId === event?.primaryFactId);
    const evidence = record.compiled.activeFacts.filter((candidate): candidate is OriginalTransactionEvidenceFact =>
      candidate.kind === "ORIGINAL_TRANSACTION_EVIDENCE" &&
      candidate.creditEventKey === credit?.eventKey && candidate.evidenceHash === evidenceHash);
    if (!credit || credit.documentKind !== "CREDIT_NOTE" || evidence.length !== 1 ||
        credit.originalTransactionEvidenceHash !== evidenceHash) {
      throw new AppError("PERSISTENCE_FAILURE", "The credit operation's original evidence linkage is incomplete.", {
        httpStatus: 503,
      });
    }
    let binding;
    try {
      binding = xeroOriginalTransactionBindingFromProviderProjection(
        record.compiled.providerProjection,
        evidenceHash,
      );
    } catch (error) {
      throw new AppError("PERSISTENCE_FAILURE", "The provider projection has no sealed original-transaction binding.", {
        httpStatus: 503,
        cause: error,
      });
    }
    if (
      binding.evidenceHash !== evidenceHash ||
      binding.sourceSnapshotSealHash !== evidence[0]!.sourceSnapshotSealHash ||
      binding.originalRoute !== evidence[0]!.originalRoute
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "The provider original binding does not match its provider-neutral evidence.", {
        httpStatus: 503,
      });
    }
    return Object.freeze({ credit, evidence: evidence[0]!, binding });
  }

  async #assertCurrentOriginalTransactionEvidence(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ): Promise<void> {
    if (operation.nativeRoute !== "CUSTOMER_CREDIT" && operation.nativeRoute !== "SUPPLIER_CREDIT") return;
    const sealed = this.#sealedOriginalTransactionEvidence(record, operation);
    const lookup = await lookupXeroOriginalTransaction({
      reader: this.provider as XeroBusinessCoordinateHistoryReadPort,
      principal: context,
      originalRoute: sealed.binding.originalRoute,
      contactId: this.#stringField(operation.canonicalPayload, "xeroContactId"),
      reference: sealed.evidence.reference,
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: sealed.evidence.documentDate,
    });
    if (lookup.state !== "EXACT_ONE" ||
        lookup.providerObjectId.toLowerCase() !== sealed.binding.providerObjectId.toLowerCase()) {
      const reasonCodes = lookup.state === "INCOMPLETE"
        ? lookup.reasonCodes
        : lookup.state === "AMBIGUOUS"
          ? ["ORIGINAL_TRANSACTION_BECAME_AMBIGUOUS"]
          : lookup.state === "NONE"
            ? ["ORIGINAL_TRANSACTION_NO_LONGER_RESOLVES"]
            : ["ORIGINAL_TRANSACTION_PROVIDER_ID_CHANGED"];
      throw new AppError("STALE_PREFLIGHT", "The complete historical original coordinate changed after this Case was sealed.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
          reasonCodes,
          providerMutationPossible: false,
          recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
        },
      });
    }
    const accountingPolicy = createXeroDeclaredLedgerPolicyFromProjection(record.compiled.policyProjection);
    const monetary = resolveSupportedAccountingMonetaryRule(accountingPolicy, sealed.credit.currency);
    if (!monetary.rule) {
      throw new AppError("PERSISTENCE_FAILURE", "The sealed original transaction has no supported monetary rule.", {
        httpStatus: 503,
      });
    }
    const [liveAccounts, liveTaxRates] = await Promise.all([
      this.accounting.listAccounts(context, {}),
      this.accounting.listTaxRates(context),
    ]);
    try {
      const current = createXeroOriginalTransactionEvidence({
        credit: sealed.credit,
        snapshot: lookup.exactReadback,
        expectedTenantId: record.binding.tenantId,
        expectedContactId: this.#stringField(operation.canonicalPayload, "xeroContactId"),
        checkedObjectCount: lookup.checkedObjectCount,
        accounts: liveAccounts,
        taxRates: liveTaxRates,
        monetaryRule: monetary.rule,
      });
      if (
        lookup.exactReadback.invoiceId.toLowerCase() !== sealed.binding.providerObjectId.toLowerCase() ||
        current.evidence.evidenceHash !== sealed.evidence.evidenceHash ||
        current.evidence.sourceSnapshotSealHash !== sealed.evidence.sourceSnapshotSealHash ||
        stableStringify(current.evidence) !== stableStringify(sealed.evidence) ||
        stableStringify(current.binding) !== stableStringify(sealed.binding)
      ) {
        throw new XeroOriginalTransactionEvidenceError(["ORIGINAL_TRANSACTION_EVIDENCE_DRIFT"]);
      }
    } catch (error) {
      if (!(error instanceof XeroOriginalTransactionEvidenceError)) throw error;
      throw new AppError("STALE_PREFLIGHT", "The historical original transaction changed after this Case was sealed.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
          reasonCodes: error.reasonCodes,
          providerMutationPossible: false,
          recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
        },
        cause: error,
      });
    }
  }

  #existingBusinessCoordinateError(
    operation: AccountingCaseOperation,
    result: Extract<AccountingCaseProviderBusinessHistoryLookup, { state: "EXACT_ONE" }>,
  ): AppError {
    const noWriteEvidence = createXeroExistingDocumentNoWriteEvidence(operation, result);
    return new AppError("CONFLICT", "The exact Xero business object appeared before the provider write claim.", {
      httpStatus: 409,
      retryable: false,
      details: {
        failureLayer: "XERO_PROVIDER_BUSINESS_COORDINATE_HISTORY",
        reasonCodes: ["NO_WRITE_REQUIRED_EXISTING"],
        businessCoordinateDecision: "NO_WRITE_REQUIRED_EXISTING",
        providerObjectId: result.providerObjectId,
        exactReadback: result.exactReadback,
        noWriteEvidence,
        providerMutationPossible: false,
      },
    });
  }

  async prepare(context: RequestContext, raw: PrepareAccountingCasePublicInput): Promise<AccountingCaseSummary & {
    persistence_mode: "CREATED" | "ADVANCED" | "IDEMPOTENT_REPLAY";
  }> {
    const input = prepareAccountingCasePublicSchema.parse(raw);
    const [resolved, organisation] = await Promise.all([
      this.provider.resolveContext(context),
      this.provider.getOrganisation(context),
    ]);
    if (resolved.tenantId !== organisation.organisationId) {
      throw new AppError("CONFLICT", "Xero organisation settings do not match the pinned ledger target.", {
        httpStatus: 409,
      });
    }
    // ADR-002: the ledger gateway holds no jurisdiction rules. The tenant's
    // country code is carried as informational target evidence only; it never
    // selects a policy and never gates a write.
    const country = organisation.countryCode?.trim().toUpperCase();
    if (!country || !/^[A-Z]{2,3}$/u.test(country)) {
      throw new AppError("VALIDATION_FAILED", "The Xero organisation country code is unknown.", {
        httpStatus: 422,
        details: { reasonCodes: ["ORGANISATION_COUNTRY_UNKNOWN"] },
      });
    }
    const baseCurrency = organisation.baseCurrency?.toUpperCase();
    if (!baseCurrency || !/^[A-Z]{3}$/u.test(baseCurrency)) {
      throw new AppError("VALIDATION_FAILED", "The Xero organisation base currency is unknown.", {
        httpStatus: 422,
        details: { reasonCodes: ["ORGANISATION_BASE_CURRENCY_UNKNOWN"] },
      });
    }
    const binding = caseBinding(context, resolved.tenantId);
    let continuationAuthorization: CreateOrAdvanceAccountingCaseInput["continuationAuthorization"];
    let recoveryResidualAuthorization: CreateOrAdvanceAccountingCaseInput["recoveryResidualAuthorization"];
    let continuationSource: AccountingCaseVersionRecord | undefined;
    const recoveryResidualToken = input.continuation_token?.startsWith("acr_") === true;
    const prior = !recoveryResidualToken && input.expected_version > 0
      ? await this.repository.getBoundAccountingCase({
          binding,
          caseId: input.case_id,
          version: input.expected_version,
        })
      : undefined;
    if (prior?.state === "AWAITING_CONTINUATION" && !input.continuation_token) {
      throw new AppError("CONFLICT", "Accounting Case continuation requires its server-issued token.", { httpStatus: 409 });
    }
    if (recoveryResidualToken) {
      if (input.expected_version !== 0) {
        throw new AppError("CONFLICT", "An expired-target recovery successor must start as a new Case.", {
          httpStatus: 409,
        });
      }
      const durable = await this.repository.getAccountingCaseRecoveryResidualGrant({
        currentAccessBinding: binding,
        successorCaseId: input.case_id,
        now: this.#now(),
      });
      if (!durable) {
        throw new AppError("CONFLICT", "Accounting Case recovery continuation is not available to this target.", {
          httpStatus: 409,
        });
      }
      continuationSource = durable.source;
      const expected = recoveryResidualContinuationProjection(durable.source, this.#continuationSecret);
      let submittedTemplate: AccountingCaseBusinessContinuationTemplate;
      try {
        submittedTemplate = accountingCaseRecoveryBusinessContinuationTemplate({
          caseId: input.case_id,
          sources: input.sources,
          facts: input.facts as AccountingFact[],
        });
      } catch {
        throw new AppError("CONFLICT", "Accounting Case recovery continuation does not match its residual intent.", {
          httpStatus: 409,
        });
      }
      if (
        !safeEqual(input.continuation_token!, expected.token) ||
        accountingCaseContinuationTemplateHash(submittedTemplate) !== durable.grant.templateHash
      ) {
        throw new AppError("CONFLICT", "Accounting Case recovery continuation does not match its residual intent.", {
          httpStatus: 409,
        });
      }
      recoveryResidualAuthorization = {
        grantId: durable.grant.grantId,
        sourceCaseId: durable.grant.sourceCaseId,
        sourceVersion: durable.grant.sourceVersion,
        successorCaseId: durable.grant.successorCaseId,
        templateHash: durable.grant.templateHash,
      };
    } else if (input.continuation_token) {
      if (!prior || prior.state !== "AWAITING_CONTINUATION") {
        throw new AppError("CONFLICT", "Accounting Case is not awaiting this continuation.", { httpStatus: 409 });
      }
      continuationSource = prior;
      const expected = continuationProjection(prior, this.#continuationSecret);
      let submittedTemplate: AccountingCaseBusinessContinuationTemplate;
      try {
        submittedTemplate = accountingCaseBusinessContinuationTemplate({
          caseId: input.case_id,
          expectedVersion: input.expected_version,
          sources: input.sources,
          facts: input.facts as AccountingFact[],
        });
      } catch {
        throw new AppError("CONFLICT", "Accounting Case continuation does not match the server-bound residual intent.", {
          httpStatus: 409,
        });
      }
      const templateHash = accountingCaseContinuationTemplateHash(expected.prepare_template);
      if (
        !safeEqual(input.continuation_token, expected.token) ||
        accountingCaseContinuationTemplateHash(submittedTemplate) !== templateHash ||
        input.facts.some((fact) => fact.kind !== "NATIVE_DOCUMENT")
      ) {
        throw new AppError("CONFLICT", "Accounting Case continuation does not match the server-bound residual intent.", {
          httpStatus: 409,
        });
      }
      continuationAuthorization = { sourceVersion: prior.compiled.version, templateHash };
    }
    const organisationSettings = this.#organisationTargetSettings(organisation);
    const [contactProjection, ledgerBinding] = await Promise.all([
      this.#resolvePublicContactFacts(
        context,
        resolved.tenantId,
        input.facts as AccountingFact[],
        recoveryResidualToken ? undefined : continuationSource,
      ),
      this.#currentLedgerBinding(
        context,
        resolved.tenantId,
        country,
        declaredLedgerCoordinates(input.facts as AccountingFact[]),
      ),
    ]);
    const target: AccountingCaseTarget = {
      tenantId: resolved.tenantId,
      environment: this.#testTenantIds.has(resolved.tenantId) ? "TEST" : "PRODUCTION",
      baseCurrency,
      taxJurisdiction: country,
      ...(organisationSettings.periodLockDate ? { periodLockDate: organisationSettings.periodLockDate } : {}),
      ...(organisationSettings.endOfYearLockDate
        ? { endOfYearLockDate: organisationSettings.endOfYearLockDate }
        : {}),
      organisationStatus: organisationSettings.organisationStatus,
    };
    const accountingPolicy = createXeroDeclaredLedgerPolicy({
      jurisdiction: country,
      paysTax: organisationSettings.paysTax,
      ledgerBinding,
    });
    const originalProjection = await this.#resolveOriginalTransactionEvidence(
      context,
      resolved.tenantId,
      contactProjection.facts,
      contactProjection.contactBindings,
      accountingPolicy,
    );
    const providerContract = createXeroAccountingCaseProviderContract(
      contactProjection.contactBindings,
      ledgerBinding,
      undefined,
      this.#businessAuthorities.get(resolved.tenantId),
      originalProjection.bindings,
    );
    let compiled;
    try {
      compiled = compileAccountingCase({
        caseId: input.case_id,
        expectedVersion: input.expected_version,
        target,
        sources: input.sources,
        facts: originalProjection.facts,
      }, accountingPolicy, providerContract);
    } catch (error) {
      if (!(error instanceof AccountingCaseCompilationError)) throw error;
      throw new AppError("VALIDATION_FAILED", error.message, {
        httpStatus: 422,
        retryable: false,
        details: {
          failureLayer: "ACCOUNTING_CASE_COMPILER",
          reasonCodes: [error.reasonCode],
          path: error.path,
          providerMutationPossible: false,
        },
        cause: error,
      });
    }
    if (hasAccountingCaseDependentContinuation(compiled)) {
      try {
        accountingCaseDependentContinuationTemplate(compiled);
      } catch (error) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case dependent documents cannot be projected as one safe public continuation.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTINUATION",
            reasonCodes: ["PUBLIC_CONTINUATION_TEMPLATE_UNREPRESENTABLE"],
            providerMutationPossible: false,
          },
          cause: error,
        });
      }
    }
    const compiledPlanHash = accountingCasePlanHash(binding, compiled);
    // Cross-MCP consistency: an upstream source case (for example a Drive case)
    // binds to exactly one Xero tenant on first use. This proves the pairing is
    // consistent, never that the upstream material is correct, so it does not
    // touch source_truth_claim. Material pasted straight into chat cites no
    // upstream case and is recorded as ABSENT rather than treated as suspect.
    const sourceCase: AccountingCaseSourceCaseReference | undefined = input.source_case
      ? { system: input.source_case.system, caseRefHash: sha256(input.source_case.case_ref) }
      : undefined;
    let sourceCaseClaim: AccountingCaseSourceCaseClaim = "SOURCE_CASE_ABSENT";
    if (sourceCase) {
      const bound = await this.repository.bindAccountingCaseSourceCase({
        workspaceId: binding.workspaceId,
        sourceCase,
        tenantId: binding.tenantId,
        now: this.#now(),
      });
      if (bound.outcome === "TENANT_CONFLICT") {
        throw new AppError(
          "CONFLICT",
          "This upstream source case is already bound to a different Xero organisation.",
          {
            httpStatus: 409,
            retryable: false,
            details: {
              failureLayer: "ACCOUNTING_CASE_SOURCE_CASE_BINDING",
              reasonCodes: ["SOURCE_CASE_TENANT_CONFLICT"],
              providerMutationPossible: false,
              recoveryAction: "GET_CURRENT_CASE_STATUS",
            },
          },
        );
      }
      sourceCaseClaim = bound.outcome === "BOUND_FIRST_USE"
        ? "SOURCE_CASE_BOUND_FIRST_USE"
        : "SOURCE_CASE_BOUND_CONFIRMED";
    }
    const persisted = await this.repository.createOrAdvanceAccountingCase({
      binding,
      compiled,
      compiledPlanHash,
      ...(sourceCase ? { sourceCase } : {}),
      sourceCaseClaim,
      ...(continuationAuthorization ? { continuationAuthorization } : {}),
      ...(recoveryResidualAuthorization ? { recoveryResidualAuthorization } : {}),
      now: this.#now(),
    });
    return { ...summary(persisted.record, this.#continuationSecret), persistence_mode: persisted.mode };
  }

  async #resolveOriginalTransactionEvidence(
    context: RequestContext,
    tenantId: string,
    publicFacts: readonly AccountingFact[],
    contactBindings: XeroAccountingCaseContactBindings,
    accountingPolicy: ReturnType<typeof createXeroDeclaredLedgerPolicy>,
  ): Promise<Readonly<{
    facts: AccountingFact[];
    bindings: XeroOriginalTransactionBindings;
  }>> {
    const facts = structuredClone([...publicFacts]) as AccountingFact[];
    const bindings = new Map<string, ReturnType<typeof createXeroOriginalTransactionEvidence>["binding"]>();
    const evidenceFacts: OriginalTransactionEvidenceFact[] = [];
    for (const fact of facts) {
      if (fact.kind !== "NATIVE_DOCUMENT" || fact.documentKind !== "CREDIT_NOTE") continue;
      const contactBinding = contactBindings.get(fact.factId);
      if (!contactBinding) {
        throw new AppError("VALIDATION_FAILED", "Historical credit evidence requires one exact active Xero contact.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: ["EXACT_XERO_CONTACT_REQUIRED"],
            providerMutationPossible: false,
          },
        });
      }
      if (!fact.originalDocumentReference || !fact.originalDocumentReferenceKind || !fact.originalDocumentDate) {
        throw new AppError("VALIDATION_FAILED", "Historical credit evidence has no complete ordinary original coordinate.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: ["ORIGINAL_TRANSACTION_COORDINATE_INCOMPLETE"],
            providerMutationPossible: false,
          },
        });
      }
      if (fact.originalDocumentReferenceKind !== "FORMAL_DOCUMENT_NUMBER") {
        throw new AppError("VALIDATION_FAILED", "Historical Xero credit evidence requires the original formal document number.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: ["ORIGINAL_TRANSACTION_REFERENCE_KIND_UNSUPPORTED"],
            providerMutationPossible: false,
          },
        });
      }
      const originalRoute = fact.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
      const lookup = await lookupXeroOriginalTransaction({
        reader: this.provider as XeroBusinessCoordinateHistoryReadPort,
        principal: context,
        originalRoute,
        contactId: contactBinding.contactId,
        reference: fact.originalDocumentReference,
        referenceKind: fact.originalDocumentReferenceKind,
        documentDate: fact.originalDocumentDate,
      });
      if (lookup.state === "NONE") {
        throw new AppError("VALIDATION_FAILED", "The historical original transaction does not exist in complete Xero history.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: ["ORIGINAL_TRANSACTION_NOT_FOUND"],
            providerMutationPossible: false,
          },
        });
      }
      if (lookup.state === "AMBIGUOUS") {
        throw new AppError("CONFLICT", "The ordinary original coordinate resolves to more than one Xero transaction.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: ["ORIGINAL_TRANSACTION_AMBIGUOUS"],
            providerMutationPossible: false,
          },
        });
      }
      if (lookup.state === "INCOMPLETE") {
        throw new AppError("VALIDATION_FAILED", "Complete Xero history for the original transaction could not be proven.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: lookup.reasonCodes,
            providerMutationPossible: false,
          },
        });
      }
      const monetary = resolveSupportedAccountingMonetaryRule(accountingPolicy, fact.currency);
      if (!monetary.rule) {
        throw new AppError("VALIDATION_FAILED", "The original transaction currency has no supported monetary rule.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: monetary.reasonCodes,
            providerMutationPossible: false,
          },
        });
      }
      const [liveAccounts, liveTaxRates] = await Promise.all([
        this.accounting.listAccounts(context, {}),
        this.accounting.listTaxRates(context),
      ]);
      try {
        const resolved = createXeroOriginalTransactionEvidence({
          credit: fact,
          snapshot: lookup.exactReadback,
          expectedTenantId: tenantId,
          expectedContactId: contactBinding.contactId,
          checkedObjectCount: lookup.checkedObjectCount,
          accounts: liveAccounts,
          taxRates: liveTaxRates,
          monetaryRule: monetary.rule,
        });
        if (bindings.has(resolved.evidence.evidenceHash)) {
          throw new AppError("CONFLICT", "Two credits resolve to the same sealed original evidence identity.", {
            httpStatus: 409,
            retryable: false,
            details: {
              failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
              reasonCodes: ["ORIGINAL_TRANSACTION_EVIDENCE_REUSED_IN_CASE"],
              providerMutationPossible: false,
            },
          });
        }
        fact.originalTransactionEvidenceHash = resolved.evidence.evidenceHash;
        evidenceFacts.push(resolved.evidence);
        bindings.set(resolved.evidence.evidenceHash, resolved.binding);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (!(error instanceof XeroOriginalTransactionEvidenceError)) throw error;
        throw new AppError("VALIDATION_FAILED", error.message, {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "XERO_ORIGINAL_TRANSACTION_EVIDENCE",
            reasonCodes: error.reasonCodes,
            providerMutationPossible: false,
          },
          cause: error,
        });
      }
    }
    return Object.freeze({ facts: [...facts, ...evidenceFacts], bindings });
  }

  /**
   * Provider identities never cross the public tool boundary. The MCP resolves
   * the current tenant's unique active contact for every typed public
   * contact/document pair and stores the result in an adapter-owned projection.
   * Shared facts stay provider-neutral while the projection remains included in
   * sourceRevisionHash, every native operation payload and compiledPlanHash.
   */
  async #resolvePublicContactFacts(
    context: RequestContext,
    tenantId: string,
    publicFacts: readonly AccountingFact[],
    continuationSource?: AccountingCaseVersionRecord,
  ): Promise<Readonly<{
    facts: AccountingFact[];
    contactBindings: XeroAccountingCaseContactBindings;
  }>> {
    const facts = structuredClone([...publicFacts]) as AccountingFact[];
    const requests = new Map<string, {
      identity: XeroContactIdentityEvidence;
    }>();
    const mergeRequest = (
      key: string,
      incoming: XeroContactIdentityEvidence,
    ) => {
      const prior = requests.get(key);
      if (!prior) {
        requests.set(key, { identity: incoming });
        return;
      }
      if (canonicalContactName(prior.identity.name) !== canonicalContactName(incoming.name)) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case contains conflicting names for one durable Xero contact identity.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["CONFLICTING_SOURCE_CONTACT_IDENTITY"],
            providerMutationPossible: false,
          },
        });
      }
      const merged: Record<string, unknown> & { name: string } = { name: prior.identity.name };
      for (const field of ["email", "companyNumber", "accountNumber"] as const) {
        const left = prior.identity[field];
        const right = incoming[field];
        if (left !== undefined && right !== undefined && left !== right) {
          throw new AppError("VALIDATION_FAILED", "Accounting Case contains conflicting identity evidence for one Xero contact.", {
            httpStatus: 422,
            retryable: false,
            details: {
              failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
              reasonCodes: ["CONFLICTING_SOURCE_CONTACT_IDENTITY"],
              providerMutationPossible: false,
            },
          });
        }
        const value = left ?? right;
        if (value !== undefined) merged[field] = value;
      }
      const leftDurable = prior.identity.durableIdentity;
      const rightDurable = incoming.durableIdentity;
      if (
        leftDurable !== undefined && rightDurable !== undefined &&
        stableStringify(leftDurable) !== stableStringify(rightDurable)
      ) {
        throw new AppError("VALIDATION_FAILED", "Accounting Case contains conflicting durable identities for one Xero contact.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["CONFLICTING_SOURCE_CONTACT_DURABLE_IDENTITY"],
            providerMutationPossible: false,
          },
        });
      }
      const durableIdentity = leftDurable ?? rightDurable;
      if (durableIdentity !== undefined) merged.durableIdentity = durableIdentity;
      requests.set(key, { identity: merged as XeroContactIdentityEvidence });
    };
    for (const fact of facts) {
      if (fact.kind === "CONTACT_CANDIDATE") {
        const identity = normalizeXeroContactIdentity({
          name: fact.name,
          ...(fact.email !== undefined ? { email: fact.email } : {}),
          ...(fact.durableIdentity !== undefined ? { durableIdentity: fact.durableIdentity } : {}),
          ...(fact.companyNumber !== undefined ? { companyNumber: fact.companyNumber } : {}),
          ...(fact.accountNumber !== undefined ? { accountNumber: fact.accountNumber } : {}),
        });
        mergeRequest(this.#contactResolutionKey(identity), identity);
      } else if (fact.kind === "NATIVE_DOCUMENT") {
        const identity = normalizeXeroContactIdentity({
          name: fact.contactName,
          ...(fact.contactDurableIdentity !== undefined
            ? { durableIdentity: fact.contactDurableIdentity }
            : {}),
        });
        mergeRequest(this.#contactResolutionKey(identity), identity);
      }
    }
    const needsCollisionIndex = [...requests.values()].some(({ identity }) =>
      identity.email !== undefined || identity.durableIdentity !== undefined ||
      identity.companyNumber !== undefined || identity.accountNumber !== undefined);
    const lifecycle = needsCollisionIndex
      ? await this.#listAllContactsForIdentity(context)
      : undefined;
    const resolutions = continuationSource
      ? await this.#continuationContactResolutions(context, continuationSource)
      : new Map<string, ContactResolution>();
    for (const [key, request] of [...requests].sort(([left], [right]) => left.localeCompare(right))) {
      if (resolutions.has(key)) continue;
      if (request.identity.durableIdentity) {
        const resolved = await this.#resolveVerifiedDurableContact(
          context,
          tenantId,
          request.identity,
          lifecycle,
        );
        if (resolved) {
          resolutions.set(key, this.#contactResolution(
            request.identity.name,
            resolved.contact,
            resolved.decision,
          ));
        }
        continue;
      }
      const resolved = await this.#resolveContactIdentity(context, request.identity, lifecycle);
      if (!resolved) continue;
      resolutions.set(key, this.#contactResolution(request.identity.name, resolved.contact, resolved.decision));
    }
    const contactBindings = new Map<string, XeroAccountingCaseContactBinding>();
    for (const fact of facts) {
      if (fact.kind === "CONTACT_CANDIDATE") {
        const identity = normalizeXeroContactIdentity({
          name: fact.name,
          ...(fact.email !== undefined ? { email: fact.email } : {}),
          ...(fact.durableIdentity !== undefined ? { durableIdentity: fact.durableIdentity } : {}),
          ...(fact.companyNumber !== undefined ? { companyNumber: fact.companyNumber } : {}),
          ...(fact.accountNumber !== undefined ? { accountNumber: fact.accountNumber } : {}),
        });
        const resolution = resolutions.get(this.#contactResolutionKey(identity));
        // Bare name/email/company/account fields can identify a collision but
        // cannot silently convert an explicit contact candidate into an
        // existing legal entity. Only a typed issuer/scope may be bound.
        if (resolution?.identity.policy === "TYPED_DURABLE_IDENTITY") {
          contactBindings.set(fact.factId, Object.freeze({
            contactId: resolution.contactId,
            identity: resolution.identity,
          }));
        }
      }
      if (fact.kind === "NATIVE_DOCUMENT") {
        const identity = normalizeXeroContactIdentity({
          name: fact.contactName,
          ...(fact.contactDurableIdentity !== undefined ? { durableIdentity: fact.contactDurableIdentity } : {}),
        });
        const resolution = resolutions.get(this.#contactResolutionKey(identity));
        if (resolution) {
          contactBindings.set(fact.factId, Object.freeze({
            contactId: resolution.contactId,
            identity: resolution.identity,
          }));
        }
      }
    }
    return Object.freeze({ facts, contactBindings });
  }

  async #continuationContactResolutions(
    context: RequestContext,
    source: AccountingCaseVersionRecord,
  ): Promise<Map<string, ContactResolution>> {
    const resolutions = new Map<string, ContactResolution>();
    for (const fact of source.compiled.activeFacts) {
      if (fact.kind !== "CONTACT_CANDIDATE") continue;
      const event = source.compiled.events.find((candidate) => candidate.primaryFactId === fact.factId);
      const operation = source.operations.find((candidate) =>
        candidate.operation.actionId === "contact.create_basic" &&
        candidate.operation.eventId === event?.eventId);
      if (!operation) continue;
      if (operation.state !== "READBACK_VERIFIED" || !operation.xeroObjectId) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case continuation contact evidence is incomplete.", {
          httpStatus: 503,
        });
      }
      const requested = normalizeXeroContactIdentity({
        name: fact.name,
        ...(fact.email !== undefined ? { email: fact.email } : {}),
        ...(fact.durableIdentity !== undefined ? { durableIdentity: fact.durableIdentity } : {}),
        ...(fact.companyNumber !== undefined ? { companyNumber: fact.companyNumber } : {}),
        ...(fact.accountNumber !== undefined ? { accountNumber: fact.accountNumber } : {}),
      });
      const contact = await this.accounting.getContact(context, { contact_id: operation.xeroObjectId });
      const decision = createXeroContactIdentityDecision(requested, contact);
      if (!decision) {
        const reasonCodes = xeroContactIdentityMismatchReasons(requested, contact);
        throw new AppError("STALE_PREFLIGHT", "The server-bound continuation contact no longer matches its verified v1 identity.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: reasonCodes.length > 0
              ? reasonCodes
              : ["XERO_CONTACT_CONTINUATION_IDENTITY_DRIFT"],
            providerMutationPossible: false,
          },
        });
      }
      const key = this.#contactResolutionKey(requested);
      const resolution = this.#contactResolution(fact.name, contact, decision);
      const existing = resolutions.get(key);
      if (existing && existing.contactId !== resolution.contactId) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case continuation has ambiguous verified contacts.", {
          httpStatus: 503,
        });
      }
      resolutions.set(key, resolution);
    }
    return resolutions;
  }

  async status(context: RequestContext, raw: GetAccountingCaseStatusInput): Promise<AccountingCaseSummary> {
    const input = getAccountingCaseStatusSchema.parse(raw);
    const resolved = await this.provider.resolveContext(context);
    const currentAccessBinding = caseBinding(context, resolved.tenantId);
    const exact = await this.repository.getBoundAccountingCase({
      binding: currentAccessBinding,
      caseId: input.case_id,
      ...(input.case_version ? { version: input.case_version } : {}),
    });
    const record = exact ?? await this.repository.getAccessibleAccountingCase({
      currentAccessBinding,
      caseId: input.case_id,
      ...(input.case_version ? { version: input.case_version } : {}),
      mode: "STATUS",
      now: this.#now(),
    });
    if (!record) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    if (record.compiledPlanHash !== accountingCasePlanHash(record.binding, record.compiled)) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case plan integrity verification failed.", {
        httpStatus: 503,
      });
    }
    return summary(record, this.#continuationSecret);
  }

  async execute(context: RequestContext, raw: ExecuteAccountingCaseInput): Promise<AccountingCaseSummary> {
    const input = executeAccountingCaseSchema.parse(raw);
    const resolved = await this.provider.resolveContext(context);
    const currentAccessBinding = caseBinding(context, resolved.tenantId);
    const exact = await this.repository.getBoundAccountingCase({
      binding: currentAccessBinding,
      caseId: input.case_id,
      version: input.case_version,
    });
    let accessible = exact ?? await this.repository.getAccessibleAccountingCase({
      currentAccessBinding,
      caseId: input.case_id,
      version: input.case_version,
      mode: "STATUS",
      now: this.#now(),
    });
    if (!accessible) throw new AppError("NOT_FOUND", "Accounting Case was not found.", { httpStatus: 404 });
    let recoveryOnly = accessible.state === "RECOVERY_REQUIRED";
    const expiredExecutingRecoveryCandidate = !exact && accessible.state === "EXECUTING";
    const settledReplay = ["TERMINAL", "PARTIALLY_COMMITTED", "AWAITING_CONTINUATION"].includes(accessible.state);
    const requiredScopes = recoveryOnly || expiredExecutingRecoveryCandidate || settledReplay
      ? ["xero.read", "xero.draft.write"] as const
      : ["xero.draft.write"] as const;
    if (!requiredScopes.some((scope) => context.scopes.includes(scope))) {
      throw new AppError(
        "SCOPE_MISSING",
        recoveryOnly || expiredExecutingRecoveryCandidate
          ? "Accounting Case recovery requires xero.read or xero.draft.write for exact GET reconciliation."
          : settledReplay
            ? "Accounting Case settled execution replay requires xero.read or xero.draft.write."
            : "This Accounting Case state requires xero.draft.write before preflight or execution.",
        {
          httpStatus: 403,
          details: {
            failureLayer: "MCP_SCOPE",
            reasonCodes: ["MISSING_MCP_SCOPE"],
            recoveryAction: "REAUTHORISE_MCP_SCOPE",
            providerMutationPossible: false,
            requiredScopes: [...requiredScopes],
            caseState: accessible.state,
          },
        },
      );
    }
    if (settledReplay) return summary(accessible, this.#continuationSecret);

    if (expiredExecutingRecoveryCandidate) {
      const expectedAccessiblePlanHash = accountingCasePlanHash(accessible.binding, accessible.compiled);
      if (accessible.compiledPlanHash !== expectedAccessiblePlanHash) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case plan integrity verification failed.", {
          httpStatus: 503,
        });
      }
      this.#assertSupportedStoredProjection(accessible);
      this.#validateStoredOperations(accessible);
      try {
        accessible = (await this.repository.adoptExpiredExecutingAccountingCaseForRecovery({
          currentAccessBinding,
          caseId: input.case_id,
          version: input.case_version,
          requestId: input.request_id,
          expectedPlanHash: expectedAccessiblePlanHash,
          now: this.#now(),
        })).record;
        recoveryOnly = true;
      } catch (error) {
        const safe = toSafeError(error);
        const reasonCodes = Array.isArray(safe.details?.reasonCodes)
          ? safe.details.reasonCodes.filter((value): value is string => typeof value === "string")
          : [];
        if (safe.code === "CONFLICT" && reasonCodes.includes("NO_POTENTIALLY_WRITTEN_MUTATION_REQUEST")) {
          throw new AppError(
            "TARGET_SESSION_INVALID",
            "The expired-target Case has no durable provider write claim eligible for read-only recovery.",
            {
              httpStatus: 409,
              details: {
                failureLayer: "TARGET_BINDING",
                reasonCodes,
                recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
                providerMutationPossible: false,
              },
            },
          );
        }
        throw error;
      }
    }

    const loaded = recoveryOnly
      ? accessible
      : exact;
    if (!loaded) {
      throw new AppError(
        "TARGET_SESSION_INVALID",
        "A renewed target session may inspect or recover this Case, but cannot resume fresh writes in the old Case.",
        { httpStatus: 409 },
      );
    }
    const expectedPlanHash = accountingCasePlanHash(loaded.binding, loaded.compiled);
    if (loaded.compiledPlanHash !== expectedPlanHash) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case plan integrity verification failed.", {
        httpStatus: 503,
      });
    }
    this.#assertSupportedStoredProjection(loaded);
    if (loaded.compiled.status === "BLOCKED_COVERAGE" || loaded.compiled.status === "BLOCKED_VALIDATION") {
      throw new AppError("VALIDATION_FAILED", "Accounting Case coverage or deterministic validation has not passed.", {
        httpStatus: 422,
        details: { reasonCodes: [loaded.compiled.status] },
      });
    }
    if (!recoveryOnly) await this.#assertCurrentOrganisationPolicy(context, loaded);
    this.#validateStoredOperations(loaded);

    if (recoveryOnly) {
      const claim = await this.repository.claimAccountingCaseExecution({
        binding: currentAccessBinding,
        caseId: input.case_id,
        version: input.case_version,
        requestId: input.request_id,
        expectedPlanHash,
        accessMode: "RECOVERY_GET_ONLY",
        now: this.#now(),
      });
      if (claim.mode === "ALREADY_TERMINAL") return summary(claim.record, this.#continuationSecret);
      return summary(await this.#recoverCase(
        context,
        currentAccessBinding,
        claim.record,
        input.request_id,
      ), this.#continuationSecret);
    }

    const binding = currentAccessBinding;
    let record = loaded;
    let claimedDuringReseal = false;
    if (["PLANNED_NEEDS_PREFLIGHT", "PLANNED_WITH_EXCEPTIONS"].includes(record.state)) {
      const authorityReceipt = await this.mutations.preflightAutonomousActions(
        context,
        record.operations.map((operation) => operation.operation.actionId),
      );
      let operationPreflights: AccountingCaseOperationPreflight[];
      try {
        operationPreflights = await this.#preflightOperations(context, record);
      } catch (error) {
        throw this.#caseExecutionError(error, record);
      }
      const checkedAt = this.#now();
      const preflightReceipt = this.#casePreflightReceipt(
        record,
        input.request_id,
        authorityReceipt,
        operationPreflights,
        checkedAt,
      );
      const preflightReceiptHash = accountingCasePreflightReceiptHash({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        compiledPlanHash: expectedPlanHash,
        requestId: input.request_id,
        preflightReceipt,
      });
      record = (await this.repository.recordAccountingCasePreflight({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        requestId: input.request_id,
        expectedPlanHash,
        preflightReceipt,
        preflightReceiptHash,
        operations: operationPreflights,
        now: checkedAt,
      })).record;
    } else if (record.state === "PREFLIGHTED" || record.state === "READY_TO_RESUME") {
      // A durable preflight does not grant timeless authority. Re-evaluate the
      // live standing delegation/provider capability before the Case claim;
      // every operation repeats it again at the one-shot write boundary.
      const remainingPrepared = record.operations.filter((operation) => operation.state === "PREPARED");
      const authorityReceipt = await this.mutations.preflightAutonomousActions(
        context,
        remainingPrepared.map((operation) => operation.operation.actionId),
      );
      const checkedAt = this.#now();
      const minimumPreparationExpiresAt = new Date(
        checkedAt.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS,
      );
      const durablePreparations = await Promise.all(remainingPrepared.map(async (operation) => {
        if (!operation.preparationId) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case prepared operation has no preparation.", {
            httpStatus: 503,
          });
        }
        const preparation = await this.repository.getXeroMutationPreparation(operation.preparationId);
        if (!preparation) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preparation is missing.", {
            httpStatus: 503,
          });
        }
        return preparation;
      }));
      const needsReseal = durablePreparations.some((preparation) =>
        preparation.state === "EXPIRED" ||
        (preparation.state === "PREPARED" && preparation.expiresAt < minimumPreparationExpiresAt));
      if (needsReseal) {
        if (durablePreparations.some((preparation) =>
          !["PREPARED", "EXPIRED"].includes(preparation.state) ||
          (preparation.state === "EXPIRED" && preparation.expiresAt > checkedAt))) {
          throw new AppError("STALE_PREFLIGHT", "Accounting Case contains a preparation that cannot be safely resealed.", {
            httpStatus: 409,
            retryable: true,
          });
        }
        let refreshed: AccountingCaseOperationPreflight[];
        try {
          refreshed = await this.#preflightOperations(context, record, remainingPrepared);
        } catch (error) {
          throw this.#caseExecutionError(error, record);
        }
        if (refreshed.some((operation) => operation.state !== "PREPARED")) {
          throw new AppError(
            "CONFLICT",
            "Accounting Case reseal cannot change a prepared operation into a no-write decision.",
            { httpStatus: 409 },
          );
        }
        const oldById = new Map(remainingPrepared.map((operation) => [
          operation.operation.operationId,
          operation,
        ]));
        const replacements: AccountingCaseOperationReseal[] = await Promise.all(refreshed.map(async (operation) => {
          if (operation.state !== "PREPARED") {
            throw new AppError("PERSISTENCE_FAILURE", "Accounting Case reseal preparation is incomplete.");
          }
          const old = oldById.get(operation.operationId);
          if (!old?.preparationId) {
            throw new AppError("PERSISTENCE_FAILURE", "Accounting Case reseal has no old preparation.");
          }
          const replacement = await this.repository.getXeroMutationPreparation(operation.preparationId);
          if (!replacement) {
            throw new AppError("PERSISTENCE_FAILURE", "Accounting Case replacement preparation is missing.", {
              httpStatus: 503,
            });
          }
          return {
            operationId: operation.operationId,
            oldPreparationId: old.preparationId,
            newPreparationId: operation.preparationId,
            operationCanonicalPayloadHash: operation.operationCanonicalPayloadHash,
            preparationCanonicalPayloadHash: operation.preparationCanonicalPayloadHash,
            sourceSha256: operation.sourceSha256,
            newPreparationExpiresAt: replacement.expiresAt.toISOString(),
          };
        }));
        const originalPreflightReceiptHash = record.originalPreflightReceiptHash ?? record.preflightReceiptHash;
        const previousEffectiveSealHash = record.effectivePreflightSealHash ?? record.preflightReceiptHash;
        const revision = (record.preflightResealRevision ?? 0) + 1;
        if (!originalPreflightReceiptHash || !previousEffectiveSealHash) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case effective preflight seal is missing.", {
            httpStatus: 503,
          });
        }
        const resealReceipt: AccountingCasePreflightResealReceipt = {
          receiptType: "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL",
          receiptVersion: 1,
          caseId: record.compiled.caseId,
          caseVersion: record.compiled.version,
          requestId: input.request_id,
          compiledPlanHash: expectedPlanHash,
          originalPreflightReceiptHash,
          previousEffectiveSealHash,
          revision,
          authorityReceipt,
          operations: replacements,
          minimumPreparationExpiresAt: minimumPreparationExpiresAt.toISOString(),
          checkedAt: checkedAt.toISOString(),
        };
        const resealReceiptHash = accountingCasePreflightResealReceiptHash({
          binding,
          caseId: record.compiled.caseId,
          version: record.compiled.version,
          compiledPlanHash: expectedPlanHash,
          originalPreflightReceiptHash,
          previousEffectiveSealHash,
          revision,
          requestId: input.request_id,
          resealReceipt,
        });
        const reseal = await this.repository.resealAndClaimAccountingCaseExecution({
          binding,
          caseId: record.compiled.caseId,
          version: record.compiled.version,
          requestId: input.request_id,
          expectedPlanHash,
          expectedOriginalPreflightReceiptHash: originalPreflightReceiptHash,
          expectedEffectiveSealHash: previousEffectiveSealHash,
          expectedResealRevision: revision - 1,
          resealReceipt,
          resealReceiptHash,
          operations: replacements,
          minimumPreparationExpiresAt,
          now: checkedAt,
        });
        record = reseal.record;
        if (reseal.mode === "ALREADY_TERMINAL") return summary(record, this.#continuationSecret);
        claimedDuringReseal = true;
      }
    }
    if (!claimedDuringReseal) {
      const claimAt = this.#now();
      const claim = await this.repository.claimAccountingCaseExecution({
        binding,
        caseId: input.case_id,
        version: input.case_version,
        requestId: input.request_id,
        expectedPlanHash,
        minimumPreparationExpiresAt: new Date(
          claimAt.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS,
        ),
        now: claimAt,
      });
      record = claim.record;
      if (claim.mode === "ALREADY_TERMINAL") return summary(record, this.#continuationSecret);
    }

    const ordered = [...record.operations].sort((left, right) => left.ordinal - right.ordinal);
    for (const initial of ordered) {
      const current = record.operations.find((candidate) =>
        candidate.operation.operationId === initial.operation.operationId);
      if (!current) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation projection is incomplete.", { httpStatus: 503 });
      if ([
        "READBACK_VERIFIED",
        "NO_WRITE_REQUIRED",
        "PROVIDER_REJECTED",
        "BLOCKED_VALIDATION",
        "NOT_EXECUTED_AFTER_PRIOR_FAILURE",
      ].includes(current.state)) continue;
      if (["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(current.state)) {
        record = await this.#finalizeRecovery(binding, record, input.request_id);
        return summary(record, this.#continuationSecret);
      }
      try {
        record = await this.#executeOperation(context, binding, record, current);
        const projected = record.operations.find((candidate) =>
          candidate.operation.operationId === current.operation.operationId);
        if (projected && ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(projected.state)) {
          record = await this.#finalizeRecovery(binding, record, input.request_id);
          return summary(record, this.#continuationSecret);
        }
      } catch (error) {
        const reconciled = await this.#reconcileOperationFailure(
          context,
          binding,
          record,
          current,
          error,
        );
        record = reconciled.record;
        if (reconciled.resolvedAsSuccess) continue;
        throw this.#caseExecutionError(error, record, current.operation.operationId);
      }
    }
    if (this.#shouldAwaitContinuation(record)) {
      record = await this.repository.awaitAccountingCaseContinuation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        requestId: input.request_id,
        now: this.#now(),
      });
      return summary(record, this.#continuationSecret);
    }
    const finalState = this.#terminalCaseState(record);
    record = await this.repository.finalizeAccountingCase({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      requestId: input.request_id,
      state: finalState,
      terminalSummary: accountingCaseTerminalSummary(record, finalState),
      now: this.#now(),
    });
    return summary(record, this.#continuationSecret);
  }

  #validateStoredOperations(record: AccountingCaseVersionRecord): void {
    const providerContract = createXeroAccountingCaseProviderContractFromProjection(
      record.compiled.providerProjection,
    );
    const accountingPolicy = createXeroDeclaredLedgerPolicyFromProjection(
      record.compiled.policyProjection,
    );
    for (const operationRecord of record.operations) {
      const operation = operationRecord.operation;
      if (operation.caseId !== record.compiled.caseId ||
          operation.caseVersion !== record.compiled.version ||
          operation.sourceRevisionHash !== record.compiled.sourceRevisionHash ||
          operation.target.tenantId !== record.binding.tenantId ||
          operation.canonicalPayloadHash !== hashObject(operation.canonicalPayload)) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation integrity verification failed.", {
          httpStatus: 503,
        });
      }
      if (operation.nativeRoute !== "CONTACT_CREATE") {
        const event = record.compiled.events.find((candidate) => candidate.eventId === operation.eventId);
        const fact = record.compiled.activeFacts.find((candidate): candidate is NativeDocumentFact =>
          candidate.kind === "NATIVE_DOCUMENT" && candidate.factId === event?.primaryFactId);
        if (!fact || validateCompiledOperationAgainstSource(
          operation,
          fact,
          accountingPolicy,
          providerContract,
        ).length > 0) {
          throw new AppError("PERSISTENCE_FAILURE", "Accounting Case native operation no longer matches its source facts.", {
            httpStatus: 503,
          });
        }
        if (operation.nativeRoute === "CUSTOMER_CREDIT" || operation.nativeRoute === "SUPPLIER_CREDIT") {
          this.#sealedOriginalTransactionEvidence(record, operation);
        }
      }
      if (operation.terminalState !== "ELIGIBLE_FOR_PREFLIGHT") {
        throw new AppError("VALIDATION_FAILED", "Accounting Case contains an ineligible write operation.", { httpStatus: 422 });
      }
    }
  }

  async #preflightOperations(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
    selectedOperations: readonly AccountingCaseOperationRecord[] = record.operations,
  ): Promise<AccountingCaseOperationPreflight[]> {
    const results: AccountingCaseOperationPreflight[] = [];
    const ordered = [...selectedOperations].sort((left, right) => {
      const leftRank = left.operation.nativeRoute === "CONTACT_CREATE" ? 0 : 1;
      const rightRank = right.operation.nativeRoute === "CONTACT_CREATE" ? 0 : 1;
      return leftRank - rightRank || left.ordinal - right.ordinal;
    });
    for (const operationRecord of ordered) {
      const operation = operationRecord.operation;
      if (operation.nativeRoute === "CONTACT_CREATE") {
        const name = this.#stringField(operation.canonicalPayload, "name");
        const durableIdentity = contactDurableIdentityFromPayload(operation.canonicalPayload.durableIdentity);
        if (!durableIdentity) {
          throw new AppError("VALIDATION_FAILED", "A new contact requires a typed durable identity.", {
            httpStatus: 422,
            retryable: false,
            details: {
              reasonCodes: ["CONTACT_DURABLE_IDENTITY_REQUIRED"],
              providerMutationPossible: false,
            },
          });
        }
        const requested = normalizeXeroContactIdentity({
          name,
          durableIdentity,
          ...(typeof operation.canonicalPayload.email === "string"
            ? { email: operation.canonicalPayload.email }
            : {}),
          ...(typeof operation.canonicalPayload.companyNumber === "string"
            ? { companyNumber: operation.canonicalPayload.companyNumber }
            : {}),
          ...(typeof operation.canonicalPayload.accountNumber === "string"
            ? { accountNumber: operation.canonicalPayload.accountNumber }
            : {}),
        });
        const existing = await this.#resolveVerifiedDurableContact(
          context,
          record.binding.tenantId,
          requested,
        );
        if (existing) {
          results.push({
            operationId: operation.operationId,
            state: "NO_WRITE_REQUIRED",
            xeroObjectId: existing.contact.contactId,
            readbackSnapshot: {
              ...existing.contact,
              xeroContactIdentity: existing.decision,
            } as unknown as Record<string, unknown>,
          });
          continue;
        }
        const contactEvent = record.compiled.events.find((event) => event.eventId === operation.eventId);
        const dependent = contactEvent && record.operations.find((candidate) =>
          candidate.operation.dependencyEventKeys.includes(contactEvent.eventKey));
        if (dependent) {
          throw new AppError(
            "VALIDATION_FAILED",
            "A new Xero contact and a document that depends on it must execute as separate Accounting Case versions.",
            {
              httpStatus: 422,
              details: {
                reasonCodes: ["PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION"],
                caseId: record.compiled.caseId,
                caseVersion: record.compiled.version,
                failedOperationId: dependent.operation.operationId,
                nextAction: "EXECUTE_CONTACT_THEN_PREPARE_NEW_CASE_VERSION",
              },
            },
          );
        }
        const prepared = await this.accounting.prepareContactCreate(context, {
          source_ref: `case:${record.compiled.caseId}`,
          source_unit_key: operation.operationId,
          source_sha256: this.#operationSourceHash(record, operation),
          name,
          ...(typeof operation.canonicalPayload.email === "string"
            ? { email: operation.canonicalPayload.email }
            : {}),
          ...(typeof operation.canonicalPayload.companyNumber === "string"
            ? { company_number: operation.canonicalPayload.companyNumber }
            : durableIdentity.kind === "LEGAL_REGISTRY"
              ? { company_number: durableIdentity.number }
            : {}),
          ...(typeof operation.canonicalPayload.accountNumber === "string"
            ? { account_number: operation.canonicalPayload.accountNumber }
            : durableIdentity.kind === "PROVIDER_TENANT_ACCOUNT"
              ? { account_number: durableIdentity.number }
            : {}),
        });
        results.push(await this.#preparedOperationEvidence(record, operation, prepared.preparation_id));
        continue;
      }

      this.#assertNativeRouteContract(record, operation);
      const contactName = this.#stringField(operation.canonicalPayload, "contactName");
      const sealedIdentity = this.#sealedContactIdentity(operation);
      const resolvedContact = await this.#resolveContactIdentity(context, sealedIdentity.requested);
      if (!resolvedContact) {
        throw new AppError("VALIDATION_FAILED", `Accounting Case has no exact active Xero contact for ${contactName}.`, {
          httpStatus: 422,
          details: {
            reasonCodes: ["EXACT_XERO_CONTACT_REQUIRED"],
            caseId: record.compiled.caseId,
            caseVersion: record.compiled.version,
            failedOperationId: operation.operationId,
            nextAction: "RESOLVE_CONTACT_THEN_PREPARE_NEW_CASE_VERSION",
          },
        });
      }
      if (
        resolvedContact.contact.contactId !== sealedIdentity.contactId ||
        stableStringify(resolvedContact.decision) !== stableStringify(sealedIdentity)
      ) {
        throw new AppError("STALE_PREFLIGHT", "The Xero contact identity no longer matches the compiled Case decision.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_IDENTITY_DECISION_DRIFT"],
            recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
            providerMutationPossible: false,
          },
        });
      }
      await this.#assertCurrentOriginalTransactionEvidence(context, record, operation);
      const providerHistory = await this.#providerBusinessCoordinateHistory(context, record, operation);
      if (providerHistory.state === "EXACT_ONE") {
        results.push({
          operationId: operation.operationId,
          state: "NO_WRITE_REQUIRED",
          xeroObjectId: providerHistory.providerObjectId,
          readbackSnapshot: createXeroExistingDocumentNoWriteEvidence(operation, providerHistory),
        });
        continue;
      }
      const preparedDocument = await this.#prepareNativeDocumentOperation(
        context,
        record,
        operationRecord,
        resolvedContact.contact,
      );
      results.push(await this.#preparedOperationEvidence(
        record,
        operation,
        preparedDocument.preparationId,
        preparedDocument.providerReferences,
      ));
    }
    return results;
  }

  #casePreflightReceipt(
    record: AccountingCaseVersionRecord,
    requestId: string,
    authorityReceipt: AutonomousActionsPreflightReceipt,
    operations: readonly AccountingCaseOperationPreflight[],
    checkedAt: Date,
  ): Record<string, unknown> {
    const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
    return {
      receiptType: "XERO_ACCOUNTING_CASE_PREFLIGHT",
      receiptVersion: 1,
      caseId: record.compiled.caseId,
      caseVersion: record.compiled.version,
      requestId,
      compiledPlanHash: record.compiledPlanHash,
      sourceRevisionHash: record.compiled.sourceRevisionHash,
      coverageHash: record.compiled.coverage.coverageHash,
      compilerVersion: record.compiled.compilerVersion,
      policyVersion: record.compiled.policyVersion,
      targetSessionId: record.binding.targetSessionId,
      bindingRevision: record.binding.bindingRevision,
      authorityReceipt,
      operations: record.operations.map((recorded) => {
        const preflight = byId.get(recorded.operation.operationId);
        if (!preflight) throw new AppError("PERSISTENCE_FAILURE", "Accounting Case preflight is incomplete.");
        const serverCoaExecutionConstraints = recorded.operation.nativeRoute === "CONTACT_CREATE"
          ? undefined
          : this.#serverCoaExecutionConstraints(record, recorded.operation);
        return {
          operationId: recorded.operation.operationId,
          actionId: recorded.operation.actionId,
          operationCanonicalPayloadHash: recorded.operation.canonicalPayloadHash,
          state: preflight.state,
          ...(preflight.state === "PREPARED"
            ? {
                preparationId: preflight.preparationId,
                preparationCanonicalPayloadHash: preflight.preparationCanonicalPayloadHash,
                sourceSha256: preflight.sourceSha256,
                ...(serverCoaExecutionConstraints ? { serverCoaExecutionConstraints } : {}),
              }
            : {
                xeroObjectId: preflight.xeroObjectId,
                readbackHash: hashObject(preflight.readbackSnapshot),
              }),
        };
      }),
      checkedAt: checkedAt.toISOString(),
    };
  }

  async #preparedOperationEvidence(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
    preparationId: string,
    providerReferences: CasePreparationProviderReferences = {},
  ): Promise<Extract<AccountingCaseOperationPreflight, { state: "PREPARED" }>> {
    const preparation = await this.repository.getXeroMutationPreparation(preparationId);
    const expectedSourceHash = this.#operationSourceHash(record, operation);
    if (!preparation ||
        preparation.sourceRef !== `case:${record.compiled.caseId}` ||
        preparation.sourceUnitKey !== operation.operationId ||
        preparation.sourceSha256 !== expectedSourceHash ||
        preparation.canonicalPayloadHash !== hashObject(preparation.canonicalPayload)) {
      throw new AppError("PERSISTENCE_FAILURE", "Prepared Xero proposal does not match its Accounting Case operation.", {
        httpStatus: 503,
      });
    }
    this.#assertPreparationMatchesCaseOperation(record, operation, preparation, providerReferences);
    return {
      operationId: operation.operationId,
      state: "PREPARED",
      preparationId,
      operationCanonicalPayloadHash: operation.canonicalPayloadHash,
      preparationCanonicalPayloadHash: preparation.canonicalPayloadHash,
      sourceSha256: preparation.sourceSha256,
    };
  }

  #assertPreparationMatchesCaseOperation(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
    preparation: NonNullable<Awaited<ReturnType<AccountingRepository["getXeroMutationPreparation"]>>>,
    providerReferences: CasePreparationProviderReferences,
  ): void {
    const fail = (mismatchFields: readonly string[]): never => {
      throw new AppError("PERSISTENCE_FAILURE", "Prepared Xero proposal fields do not match their Accounting Case operation.", {
        httpStatus: 503,
        details: {
          reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"],
          operationId: operation.operationId,
          mismatchFields: [...mismatchFields].slice(0, 32),
        },
      });
    };
    const expectedRoute = (() => {
      switch (operation.nativeRoute) {
        case "CONTACT_CREATE": return { actionId: "contact.create_basic", objectType: "CONTACT", operation: "CREATE" } as const;
        case "SALES_INVOICE": return { actionId: "customer_invoice.create_draft", objectType: "SALES_INVOICE", operation: "CREATE_DRAFT" } as const;
        case "SUPPLIER_BILL": return { actionId: "supplier_bill.create_draft", objectType: "SUPPLIER_BILL", operation: "CREATE_DRAFT" } as const;
        case "CUSTOMER_CREDIT":
        case "SUPPLIER_CREDIT": return { actionId: "credit_note.create_draft", objectType: "CREDIT_NOTE", operation: "CREATE_DRAFT" } as const;
      }
    })();
    const envelopeMismatches = [
      ...(operation.actionId === expectedRoute.actionId ? [] : ["actionId"]),
      ...(preparation.objectType === expectedRoute.objectType ? [] : ["objectType"]),
      ...(preparation.operation === expectedRoute.operation ? [] : ["operation"]),
      ...(preparation.state === "PREPARED" ? [] : ["state"]),
      ...(preparation.actorId === record.binding.actorId ? [] : ["binding.actorId"]),
      ...(preparation.workspaceId === record.binding.workspaceId ? [] : ["binding.workspaceId"]),
      ...(preparation.tenantId === record.binding.tenantId ? [] : ["binding.tenantId"]),
      ...(preparation.installationId === record.binding.installationId ? [] : ["binding.installationId"]),
      ...(preparation.bindingId === record.binding.bindingId ? [] : ["binding.bindingId"]),
      ...(preparation.bindingRevision === record.binding.bindingRevision ? [] : ["binding.bindingRevision"]),
      ...(preparation.connectionId === record.binding.connectionId ? [] : ["binding.connectionId"]),
      ...(preparation.targetSessionId === record.binding.targetSessionId ? [] : ["binding.targetSessionId"]),
    ];
    if (envelopeMismatches.length > 0) fail(envelopeMismatches);

    const payload = preparation.canonicalPayload;
    const casePayload = operation.canonicalPayload;
    const nativeCurrency = operation.nativeRoute === "CONTACT_CREATE"
      ? undefined
      : this.#stringField(casePayload, "currency");
    const monetaryRule = nativeCurrency === undefined
      ? undefined
      : parseSealedAccountingMonetaryRule(casePayload.monetaryRule, nativeCurrency);
    if (
      operation.nativeRoute !== "CONTACT_CREATE" &&
      !monetaryRule
    ) fail(["canonicalPayload.monetaryRule"]);
    let expectedProjection: Record<string, unknown> | undefined;
    let actualProjection: Record<string, unknown> | undefined;

    try {
      if (operation.nativeRoute === "CONTACT_CREATE") {
        const target = payload.target;
        if (!target || typeof target !== "object" || Array.isArray(target)) fail(["canonicalPayload.target"]);
        const externalReferenceRaw = payload.externalReference;
        if (typeof externalReferenceRaw !== "string" || !/^ZC:[a-z][a-z0-9_-]{1,11}:[a-f0-9]{32}$/u.test(externalReferenceRaw)) {
          fail(["canonicalPayload.externalReference"]);
        }
        const externalReference = externalReferenceRaw as string;
        const externalKey = hashObject({
          semantics: "xero-contact-source-key:v1",
          sourceRef: `case:${record.compiled.caseId}`,
          sourceUnitKey: operation.operationId,
        });
        const expectedExternalDigest = sha256(`xero-contact-external-key:v1:${externalKey}`).slice(0, 32);
        expectedProjection = {
          route: operation.nativeRoute,
          actionId: expectedRoute.actionId,
          objectType: expectedRoute.objectType,
          operation: expectedRoute.operation,
          schemaVersion: "xero-contact-safe-v1",
          externalReferenceDigest: expectedExternalDigest,
          target: {
            name: compactCaseText(this.#stringField(casePayload, "name")),
            ...(typeof casePayload.email === "string" ? { email: casePayload.email.toLowerCase() } : {}),
            ...(typeof casePayload.companyNumber === "string"
              ? { companyNumber: compactCaseText(casePayload.companyNumber) }
              : {}),
            ...(typeof casePayload.accountNumber === "string"
              ? { accountNumber: compactCaseText(casePayload.accountNumber) }
              : {}),
          },
        };
        actualProjection = {
          route: operation.nativeRoute,
          actionId: operation.actionId,
          objectType: payload.objectType,
          operation: payload.operation,
          schemaVersion: payload.schemaVersion,
          externalReferenceDigest: externalReference.slice(-32),
          target,
        };
      } else if (operation.nativeRoute === "SALES_INVOICE" || operation.nativeRoute === "SUPPLIER_BILL") {
        const contact = providerReferences.contact;
        const sealedBinding = providerReferences.ledgerBinding;
        if (!contact || !sealedBinding || !exactName(contact.name, this.#stringField(casePayload, "contactName"))) {
          fail(["providerReferences.contact", "providerReferences.ledgerBinding"]);
        }
        const resolvedContact = contact as ContactSummary;
        const expectedLines = this.#payloadLines(casePayload).map((line, index) => {
          const effectiveTaxRateBps = line.effectiveTaxRateBps;
          if (typeof effectiveTaxRateBps !== "number" || !Number.isInteger(effectiveTaxRateBps) ||
              effectiveTaxRateBps < 0 || effectiveTaxRateBps > 10_000) {
            fail([`canonicalPayload.lines[${index}].effectiveTaxRateBps`]);
          }
          return {
            description: this.#stringField(line, "description"),
            quantity: fixedFourScaled(scaledCaseDecimal(line.quantity, `case.lines[${index}].quantity`)),
            unitAmount: fixedFourScaled(scaledCaseDecimal(line.unitAmount, `case.lines[${index}].unitAmount`)),
            enteredLineAmount: this.#stringField(line, "net"),
            accountId: this.#stringField(line, "accountId"),
            accountCode: this.#stringField(line, "accountCode"),
            taxType: this.#stringField(line, "taxType"),
            effectiveTaxRateBps,
          };
        });
        const actualLines = this.#payloadLines(payload).map((line, index) => {
          const expectedLine = expectedLines[index]!;
          if (!expectedLine) fail([`canonicalPayload.lines[${index}]`]);
          return {
            description: this.#stringField(line, "description"),
            quantity: fixedFourScaled(scaledCaseDecimal(line.quantity, `preparation.lines[${index}].quantity`)),
            unitAmount: fixedFourScaled(scaledCaseDecimal(line.unit_amount, `preparation.lines[${index}].unit_amount`)),
            enteredLineAmount: enteredLineAmount(
              line.quantity,
              line.unit_amount,
              `preparation.lines[${index}]`,
              monetaryRule!,
            ),
            accountId: this.#stringField(line, "account_id"),
            accountCode: this.#stringField(line, "account_code"),
            taxType: this.#stringField(line, "tax_type"),
            effectiveTaxRateBps: expectedLine.effectiveTaxRateBps,
          };
        });
        expectedProjection = {
          route: operation.nativeRoute,
          actionId: expectedRoute.actionId,
          objectType: expectedRoute.objectType,
          operation: expectedRoute.operation,
          contactId: resolvedContact.contactId,
          contactName: compactCaseText(this.#stringField(casePayload, "contactName")).toLocaleLowerCase("en"),
          documentDate: this.#stringField(casePayload, "documentDate"),
          dueDate: this.#stringField(casePayload, "dueDate"),
          currency: this.#stringField(casePayload, "currency"),
          currencyRate: canonicalOptionalFixedFour(casePayload.invoiceRate, "case.invoiceRate"),
          reference: this.#stringField(casePayload, "reference"),
          authoritativeProviderField: this.#stringField(casePayload, "authoritativeProviderField"),
          lineAmountType: lineAmountType(casePayload.lineAmountType),
          lines: expectedLines,
          net: this.#stringField(casePayload, "net"),
          tax: this.#stringField(casePayload, "tax"),
          gross: this.#stringField(casePayload, "gross"),
        };
        actualProjection = {
          route: operation.nativeRoute,
          actionId: operation.actionId,
          objectType: preparation.objectType,
          operation: preparation.operation,
          contactId: payload.contact_id,
          contactName: resolvedContact.name
            ? compactCaseText(resolvedContact.name).toLocaleLowerCase("en")
            : undefined,
          documentDate: payload.invoice_date,
          dueDate: payload.due_date,
          currency: payload.currency,
          currencyRate: canonicalOptionalFixedFour(payload.currency_rate, "preparation.currency_rate"),
          reference: payload.reference,
          authoritativeProviderField: payload.authoritative_provider_field,
          lineAmountType: payload.line_amount_type,
          lines: actualLines,
          net: fixedFourScaled(actualLines.reduce(
            (sum, line) => sum + scaledCaseDecimal(line.enteredLineAmount, "preparation.lines.enteredLineAmount"),
            0n,
          )),
          tax: this.#taxTotalForPreparationLines(actualLines, monetaryRule!),
          gross: this.#grossTotalForPreparationLines(actualLines, monetaryRule!),
        };
      } else {
        const contact = providerReferences.contact;
        const accountIds = providerReferences.creditLineAccountIds;
        if (!contact || !exactName(contact.name, this.#stringField(casePayload, "contactName")) || !accountIds) {
          fail(["providerReferences.creditNote"]);
        }
        const resolvedContact = contact as ContactSummary;
        const resolvedAccountIds = accountIds as readonly string[];
        const expectedLines = this.#payloadLines(casePayload).map((line, index) => {
          const effectiveTaxRateBps = line.effectiveTaxRateBps;
          if (typeof effectiveTaxRateBps !== "number" || !Number.isInteger(effectiveTaxRateBps) ||
              effectiveTaxRateBps < 0 || effectiveTaxRateBps > 10_000) {
            fail([`canonicalPayload.lines[${index}].effectiveTaxRateBps`]);
          }
          return {
            description: compactCaseText(this.#stringField(line, "description")),
            quantity: fixedFourScaled(scaledCaseDecimal(line.quantity, `case.lines[${index}].quantity`)),
            unitAmount: fixedFourScaled(scaledCaseDecimal(line.unitAmount, `case.lines[${index}].unitAmount`)),
            enteredLineAmount: this.#stringField(line, "net"),
            accountId: resolvedAccountIds[index],
            accountCode: this.#stringField(line, "accountCode"),
            taxType: this.#stringField(line, "taxType"),
            effectiveTaxRateBps,
            trackingOptionIds: [],
          };
        });
        const actualLines = this.#payloadLines(payload).map((line, index) => {
          const expectedLine = expectedLines[index]!;
          if (!expectedLine) fail([`canonicalPayload.lines[${index}]`]);
          return {
            description: compactCaseText(this.#stringField(line, "description")),
            quantity: fixedFourScaled(scaledCaseDecimal(line.quantity, `preparation.lines[${index}].quantity`)),
            unitAmount: fixedFourScaled(scaledCaseDecimal(line.unitAmount, `preparation.lines[${index}].unitAmount`)),
            enteredLineAmount: enteredLineAmount(
              line.quantity,
              line.unitAmount,
              `preparation.lines[${index}]`,
              monetaryRule!,
            ),
            accountId: this.#stringField(line, "accountId"),
            accountCode: this.#stringField(line, "accountCode"),
            taxType: this.#stringField(line, "taxType"),
            effectiveTaxRateBps: expectedLine.effectiveTaxRateBps,
            ...(typeof line.itemCode === "string" ? { itemCode: line.itemCode } : {}),
            trackingOptionIds: Array.isArray(line.trackingOptionIds) ? line.trackingOptionIds : [],
          };
        });
        expectedProjection = {
          route: operation.nativeRoute,
          actionId: expectedRoute.actionId,
          schemaVersion: "xero-controlled-draft:v1",
          objectType: expectedRoute.objectType,
          operation: expectedRoute.operation,
          status: "DRAFT",
          creditNoteType: operation.nativeRoute === "SUPPLIER_CREDIT" ? "ACCPAYCREDIT" : "ACCRECCREDIT",
          contactId: resolvedContact.contactId,
          contactName: compactCaseText(this.#stringField(casePayload, "contactName")).toLocaleLowerCase("en"),
          creditNoteDate: this.#stringField(casePayload, "documentDate"),
          dueDate: casePayload.dueDate ?? null,
          currency: this.#stringField(casePayload, "currency"),
          currencyRate: canonicalOptionalFixedFour(casePayload.invoiceRate, "case.invoiceRate"),
          reference: this.#stringField(casePayload, "reference"),
          authoritativeProviderField: this.#stringField(casePayload, "authoritativeProviderField"),
          lineAmountType: casePayload.lineAmountType,
          lines: expectedLines,
          enteredLineSubtotal: this.#stringField(casePayload, "net"),
          tax: this.#stringField(casePayload, "tax"),
          gross: this.#stringField(casePayload, "gross"),
        };
        actualProjection = {
          route: operation.nativeRoute,
          actionId: operation.actionId,
          schemaVersion: payload.schemaVersion,
          objectType: payload.objectType,
          operation: payload.operation,
          status: payload.status,
          creditNoteType: payload.creditNoteType,
          contactId: payload.contactId,
          contactName: resolvedContact.name
            ? compactCaseText(resolvedContact.name).toLocaleLowerCase("en")
            : undefined,
          creditNoteDate: payload.creditNoteDate,
          dueDate: null,
          currency: payload.currency,
          currencyRate: null,
          reference: payload.reference,
          authoritativeProviderField: payload.authoritativeProviderField,
          lineAmountType: payload.lineAmountType,
          lines: actualLines,
          enteredLineSubtotal: fixedFourScaled(actualLines.reduce(
            (sum, line) => sum + scaledCaseDecimal(line.enteredLineAmount, "preparation.lines.enteredLineAmount"),
            0n,
          )),
          tax: this.#taxTotalForPreparationLines(actualLines, monetaryRule!),
          gross: this.#grossTotalForPreparationLines(actualLines, monetaryRule!),
        };
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "PERSISTENCE_FAILURE") throw error;
      fail(["canonicalPayload"]);
    }

    if (!actualProjection || !expectedProjection || stableStringify(actualProjection) !== stableStringify(expectedProjection)) {
      fail(["canonicalPayload.semanticProjection"]);
    }
  }

  #taxTotalForPreparationLines(
    lines: readonly Record<string, unknown>[],
    monetaryRule: SupportedAccountingMonetaryRule,
  ): string {
    let tax = 0n;
    for (const [index, line] of lines.entries()) {
      const entered = scaledCaseDecimal(
        line.enteredLineAmount ?? enteredLineAmount(
          line.quantity,
          line.unitAmount ?? line.unit_amount,
          `preparation.lines[${index}]`,
          monetaryRule,
        ),
        `preparation.lines[${index}].enteredLineAmount`,
      );
      const effectiveTaxRateBps = line.effectiveTaxRateBps;
      if (typeof effectiveTaxRateBps !== "number" || !Number.isInteger(effectiveTaxRateBps) ||
          effectiveTaxRateBps < 0 || effectiveTaxRateBps > 10_000) {
        throw new AppError("PERSISTENCE_FAILURE", "Prepared line has no sealed effective tax rate.", {
          httpStatus: 503,
          details: { path: `lines[${index}].effectiveTaxRateBps` },
        });
      }
      tax += quantizeAccountingLineTax(entered, effectiveTaxRateBps, monetaryRule);
    }
    return fixedFourScaled(tax);
  }

  #grossTotalForPreparationLines(
    lines: readonly Record<string, unknown>[],
    monetaryRule: SupportedAccountingMonetaryRule,
  ): string {
    const net = lines.reduce((sum, line, index) => sum + scaledCaseDecimal(
      line.enteredLineAmount ?? enteredLineAmount(
        line.quantity,
        line.unitAmount ?? line.unit_amount,
        `preparation.lines[${index}]`,
        monetaryRule,
      ),
      `preparation.lines[${index}].enteredLineAmount`,
    ), 0n);
    return fixedFourScaled(net + scaledCaseDecimal(
      this.#taxTotalForPreparationLines(lines, monetaryRule),
      "preparation.tax",
    ));
  }

  async #executeOperation(
    context: RequestContext,
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
  ): Promise<AccountingCaseVersionRecord> {
    const operation = operationRecord.operation;
    if (operation.actionId === "contact.create_basic") {
      return this.#executeContact(context, binding, record, operationRecord);
    }
    return this.#executeNativeDocument(context, binding, record, operationRecord);
  }

  #contactLifecycleScanIncomplete(message: string): AppError {
    return new AppError("VALIDATION_FAILED", message, {
      httpStatus: 422,
      retryable: false,
      details: {
        failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
        reasonCodes: ["XERO_CONTACT_STRONG_IDENTITY_SCAN_INCOMPLETE"],
        providerMutationPossible: false,
      },
    });
  }

  async #listAllContactsForIdentity(context: RequestContext): Promise<XeroContactLifecycleIndex> {
    const byStatus = new Map<XeroContactLifecycleStatus, ContactSummary[]>();
    const seenContactIds = new Set<string>();
    for (const status of ["ACTIVE", "ARCHIVED", "GDPRREQUEST"] as const) {
      const contacts: ContactSummary[] = [];
      let expectedPageCount: number | undefined;
      let expectedItemCount: number | undefined;
      for (let page = 1; page <= 1_000; page += 1) {
        const listed = await this.accounting.listContacts(context, { status, page, limit: 100 });
        const evidence = listed.pagination;
        const pageCount = evidence.providerPageCount;
        const itemCount = evidence.providerItemCount;
        const evidenceInvalid = evidence.page !== page || evidence.pageSize !== 100 ||
          evidence.returned !== listed.contacts.length || evidence.hasNextPageIsEstimated ||
          evidence.omittedInvalid > 0 || (evidence.omittedOverflow ?? 0) > 0 ||
          pageCount === undefined || !Number.isInteger(pageCount) || pageCount < 1 ||
          itemCount === undefined || !Number.isInteger(itemCount) || itemCount < 0 ||
          page > pageCount || evidence.hasNextPage !== (page < pageCount) ||
          (expectedPageCount !== undefined && pageCount !== expectedPageCount) ||
          (expectedItemCount !== undefined && itemCount !== expectedItemCount) ||
          listed.contacts.some((contact) =>
            !contact.contactId || contact.status !== status || seenContactIds.has(contact.contactId));
        if (evidenceInvalid) {
          throw this.#contactLifecycleScanIncomplete(
            `The ${status} Xero contact scan did not provide complete, internally consistent pagination evidence.`,
          );
        }
        expectedPageCount = pageCount;
        expectedItemCount = itemCount;
        for (const contact of listed.contacts) {
          seenContactIds.add(contact.contactId);
          contacts.push(contact);
        }
        if (!evidence.hasNextPage) {
          if (contacts.length !== itemCount) {
            throw this.#contactLifecycleScanIncomplete(
              `The ${status} Xero contact scan item count did not match the complete page set.`,
            );
          }
          byStatus.set(status, contacts);
          break;
        }
      }
      if (!byStatus.has(status)) {
        throw this.#contactLifecycleScanIncomplete(
          `The ${status} Xero contact set was too large to prove strong-key uniqueness.`,
        );
      }
    }
    const active = byStatus.get("ACTIVE") ?? [];
    const archived = byStatus.get("ARCHIVED") ?? [];
    const gdprRequest = byStatus.get("GDPRREQUEST") ?? [];
    return Object.freeze({
      active: Object.freeze(active),
      archived: Object.freeze(archived),
      gdprRequest: Object.freeze(gdprRequest),
      all: Object.freeze([...active, ...archived, ...gdprRequest]),
    });
  }

  async #resolveProviderBareNumberContinuity(
    context: RequestContext,
    tenantId: string,
    requested: XeroContactIdentityEvidence,
    activeContacts: readonly ContactSummary[],
  ): Promise<{ contact: ContactSummary; decision: XeroContactIdentityDecision } | undefined> {
    const identity = requested.durableIdentity;
    if (!identity) return undefined;
    const requestedBusinessIdentityHash = xeroContactDurableBusinessIdentityHash(identity);
    const providerField = identity.kind === "LEGAL_REGISTRY" ? "companyNumber" : "accountNumber";
    const expected = identity.number;
    const candidates = activeContacts.filter((contact) => {
      const projected = xeroContactIdentityEvidenceFromSummary(contact);
      return projected?.[providerField] === expected;
    });
    const confirmed: Array<{
      contact: ContactSummary;
      registeredBusinessIdentityHashes: string[];
    }> = [];
    for (const candidate of candidates) {
      const current = await this.accounting.getContact(context, { contact_id: candidate.contactId });
      const projected = xeroContactIdentityEvidenceFromSummary(current);
      if (current.status === "ACTIVE" && projected?.[providerField] === expected) {
        const registeredBusinessIdentityHashes = await this.repository
          .listVerifiedAccountingCaseContactIdentityHashes({
          tenantId,
          contactId: current.contactId,
        });
        confirmed.push({ contact: current, registeredBusinessIdentityHashes });
      }
    }
    if (confirmed.length === 0) return undefined;

    // Close the lookup/scan race. Only an exact server-bound tuple may be
    // reused. A reverse lookup that merely finds some other registered tuple
    // on the same provider contact is not namespace authority.
    const concurrentlyMapped = await this.repository.findVerifiedAccountingCaseContactIdentity({
      tenantId,
      businessIdentityHash: requestedBusinessIdentityHash,
    });
    if (concurrentlyMapped) {
      const contact = await this.accounting.getContact(context, { contact_id: concurrentlyMapped.contactId });
      const decision = createXeroContactIdentityDecision(requested, contact);
      if (!decision || contact.status !== "ACTIVE") {
        throw new AppError("STALE_PREFLIGHT", "The durable contact registry no longer matches Xero.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_DURABLE_IDENTITY_REGISTRY_DRIFT"],
            providerMutationPossible: false,
          },
        });
      }
      return { contact, decision };
    }

    const registeredBusinessIdentityHashes = confirmed.flatMap(
      (candidate) => candidate.registeredBusinessIdentityHashes,
    );
    const continuityEvidence = xeroContactNamespaceContinuityEvidence({
      requestedBusinessIdentityHash,
      registeredBusinessIdentityHashes,
    });
    const hasAnotherServerBoundTuple = registeredBusinessIdentityHashes.length > 0;
    throw new AppError(
      "VALIDATION_FAILED",
      hasAnotherServerBoundTuple
        ? "Xero proves only a matching bare provider number; no verified external namespace authority permits a different identity tuple."
        : "A Xero contact has the same bare provider number, but no exact server-bound identity tuple proves continuity.",
      {
        httpStatus: 422,
        retryable: false,
        details: {
          failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
          reasonCodes: [hasAnotherServerBoundTuple
            ? "XERO_CONTACT_PROVIDER_BARE_NUMBER_NAMESPACE_UNVERIFIED"
            : "XERO_CONTACT_UNREGISTERED_DURABLE_IDENTITY_COLLISION"],
          identityEvidence: continuityEvidence,
          providerMutationPossible: false,
        },
      },
    );
  }

  #contactMatchesStrongIdentity(
    requested: XeroContactIdentityEvidence,
    contact: ContactSummary,
  ): boolean {
    const projected = xeroContactIdentityEvidenceFromSummary(contact);
    if (!projected) return false;
    const fields = ["email", "companyNumber", "accountNumber"] as const;
    if (fields.some((field) => requested[field] !== undefined && projected[field] === requested[field])) {
      return true;
    }
    const durableField = requested.durableIdentity?.kind === "LEGAL_REGISTRY"
      ? "companyNumber" as const
      : requested.durableIdentity?.kind === "PROVIDER_TENANT_ACCOUNT"
        ? "accountNumber" as const
        : undefined;
    return durableField !== undefined && projected[durableField] === requested.durableIdentity?.number;
  }

  async #assertNoInactiveStrongIdentity(
    context: RequestContext,
    requested: XeroContactIdentityEvidence,
    lifecycle: XeroContactLifecycleIndex,
  ): Promise<void> {
    const candidates = [...lifecycle.archived, ...lifecycle.gdprRequest]
      .filter((contact) => this.#contactMatchesStrongIdentity(requested, contact));
    for (const candidate of candidates) {
      const current = await this.accounting.getContact(context, { contact_id: candidate.contactId });
      if (
        current.contactId !== candidate.contactId ||
        (current.status !== "ARCHIVED" && current.status !== "GDPRREQUEST")
      ) {
        throw new AppError("STALE_PREFLIGHT", "Xero contact lifecycle changed during the complete identity scan.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_LIFECYCLE_SCAN_GET_DRIFT"],
            providerMutationPossible: false,
          },
        });
      }
      if (this.#contactMatchesStrongIdentity(requested, current)) {
        throw new AppError("VALIDATION_FAILED", "An inactive Xero contact already owns a supplied strong identity key.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_INACTIVE_STRONG_IDENTITY_COLLISION"],
            providerMutationPossible: false,
          },
        });
      }
    }
  }

  async #resolveVerifiedDurableContact(
    context: RequestContext,
    tenantId: string,
    requested: XeroContactIdentityEvidence,
    lifecycleInput?: XeroContactLifecycleIndex,
  ): Promise<{ contact: ContactSummary; decision: XeroContactIdentityDecision } | undefined> {
    const durableIdentity = requested.durableIdentity;
    if (!durableIdentity) return undefined;
    const lifecycle = lifecycleInput ?? await this.#listAllContactsForIdentity(context);
    await this.#assertNoInactiveStrongIdentity(context, requested, lifecycle);
    const mapped = await this.repository.findVerifiedAccountingCaseContactIdentity({
      tenantId,
      businessIdentityHash: xeroContactDurableBusinessIdentityHash(durableIdentity),
    });
    if (mapped) {
      const contact = await this.accounting.getContact(context, { contact_id: mapped.contactId });
      const decision = createXeroContactIdentityDecision(requested, contact);
      if (!decision || contact.status !== "ACTIVE") {
        throw new AppError("STALE_PREFLIGHT", "The durable contact registry no longer matches Xero.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_DURABLE_IDENTITY_REGISTRY_DRIFT"],
            providerMutationPossible: false,
          },
        });
      }
      return { contact, decision };
    }
    return this.#resolveProviderBareNumberContinuity(context, tenantId, requested, lifecycle.active);
  }

  async #resolveContactIdentity(
    context: RequestContext,
    requestedInput: XeroContactIdentityEvidence,
    lifecycle?: XeroContactLifecycleIndex,
  ): Promise<{ contact: ContactSummary; decision: XeroContactIdentityDecision } | undefined> {
    const requested = normalizeXeroContactIdentity(requestedInput);
    const collisionFields = (["email", "companyNumber", "accountNumber"] as const)
      .filter((field) => requested[field] !== undefined);
    const durableProviderField = requested.durableIdentity?.kind === "LEGAL_REGISTRY"
      ? "companyNumber" as const
      : requested.durableIdentity?.kind === "PROVIDER_TENANT_ACCOUNT"
        ? "accountNumber" as const
        : undefined;
    const durableProviderValue = requested.durableIdentity?.number;
    const collisionIds = new Set<string>();
    if (lifecycle && (collisionFields.length > 0 || durableProviderField)) {
      await this.#assertNoInactiveStrongIdentity(context, requested, lifecycle);
      for (const contact of lifecycle.active) {
        const identity = xeroContactIdentityEvidenceFromSummary(contact);
        if (identity && (
          collisionFields.some((field) => identity[field] === requested[field]) ||
          (durableProviderField !== undefined && identity[durableProviderField] === durableProviderValue)
        )) {
          collisionIds.add(contact.contactId);
        }
      }
    }
    const result = await this.accounting.searchContacts(context, { query: requested.name, limit: 100, page: 1 });
    if (result.pagination.hasNextPage) {
      throw new AppError("VALIDATION_FAILED", "Xero contact search was bounded and cannot prove a unique exact match.", {
        httpStatus: 422,
        details: {
          reasonCodes: ["EXACT_XERO_CONTACT_SEARCH_INCOMPLETE"],
          providerMutationPossible: false,
        },
      });
    }
    const exactSummaries = result.contacts.filter((contact) =>
      exactName(contact.name, requested.name) && contact.status === "ACTIVE");
    const exactIds = new Set(exactSummaries.map((contact) => contact.contactId));
    const crossNameCollisionIds = [...collisionIds].filter((contactId) => !exactIds.has(contactId));
    if (crossNameCollisionIds.length > 0) {
      // GET each collision before blocking so a partial list projection or a
      // stale search result cannot itself become authoritative evidence.
      let confirmedCollision = false;
      for (const contactId of crossNameCollisionIds) {
        const current = await this.accounting.getContact(context, { contact_id: contactId });
        const identity = xeroContactIdentityEvidenceFromSummary(current);
        if (
          current.status === "ACTIVE" && identity &&
          (
            collisionFields.some((field) => identity[field] === requested[field]) ||
            (durableProviderField !== undefined && identity[durableProviderField] === durableProviderValue)
          ) &&
          identity.name !== requested.name
        ) confirmedCollision = true;
      }
      if (confirmedCollision) {
        throw new AppError("VALIDATION_FAILED", "A differently named active Xero contact already owns a supplied strong identity key.", {
          httpStatus: 422,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_STRONG_KEY_COLLISION_DIFFERENT_NAME"],
            providerMutationPossible: false,
          },
        });
      }
    }
    if (exactSummaries.length === 0) return undefined;

    // Search establishes the complete same-name candidate set; exact GET is
    // the authoritative identity evidence for every candidate. This avoids
    // selecting on a partial search projection and is reused at all gates.
    const exact: ContactSummary[] = [];
    for (const summary of exactSummaries) {
      const current = await this.accounting.getContact(context, { contact_id: summary.contactId }).catch((error: unknown) => {
        if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
        throw error;
      });
      if (!current || current.contactId !== summary.contactId) {
        throw new AppError("STALE_PREFLIGHT", "A Xero contact changed between search and exact GET.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_IDENTITY_SEARCH_GET_DRIFT"],
            providerMutationPossible: false,
          },
        });
      }
      exact.push(current);
    }

    const matches = exact.flatMap((contact) => {
      const decision = createXeroContactIdentityDecision(requested, contact);
      return decision ? [{ contact, decision }] : [];
    });
    if (matches.length > 1) {
      throw new AppError("VALIDATION_FAILED", "More than one active Xero contact exactly matches the Accounting Case.", {
        httpStatus: 422,
        details: {
          failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
          reasonCodes: ["AMBIGUOUS_EXACT_ACTIVE_XERO_CONTACT_IDENTITY"],
          providerMutationPossible: false,
        },
      });
    }
    if (matches.length === 1) return matches[0];

    const reasonCodes = [...new Set(exact.flatMap((contact) =>
      xeroContactIdentityMismatchReasons(requested, contact)))].sort();
    throw new AppError("VALIDATION_FAILED", "The exact-name Xero contact does not match the supplied strong identity evidence.", {
      httpStatus: 422,
      retryable: false,
      details: {
        failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
        reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["XERO_CONTACT_IDENTITY_MISMATCH"],
        providerMutationPossible: false,
      },
    });
  }

  #contactResolutionKey(identity: XeroContactIdentityEvidence): string {
    return identity.durableIdentity
      ? `durable:${xeroContactDurableBusinessIdentityHash(identity.durableIdentity)}`
      : `name:${canonicalContactName(identity.name)}`;
  }

  #assertNativeRouteContract(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ): void {
    const event = record.compiled.events.find((candidate) => candidate.eventId === operation.eventId);
    const fact = record.compiled.activeFacts.find((candidate): candidate is NativeDocumentFact =>
      candidate.kind === "NATIVE_DOCUMENT" && candidate.factId === event?.primaryFactId);
    if (!fact) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case native route has no immutable source fact.", {
        httpStatus: 503,
      });
    }
    const decision = evaluateXeroNativeRouteContract(fact, record.compiled.target);
    if (!decision.adapterCanPrepare || decision.route !== operation.nativeRoute) {
      throw new AppError("VALIDATION_FAILED", "The compiled Accounting Case route is not supported by the released Xero adapter.", {
        httpStatus: 422,
        retryable: false,
        details: {
          failureLayer: "ACCOUNTING_CASE_PREFLIGHT",
          reasonCodes: decision.reasonCodes.length > 0
            ? decision.reasonCodes
            : ["XERO_NATIVE_ROUTE_MISMATCH"],
          providerMutationPossible: false,
        },
      });
    }
  }

  #contactResolution(
    requestedName: string,
    contact: ContactSummary,
    identity: XeroContactIdentityDecision,
  ): ContactResolution {
    if (!contact.contactId || contact.status !== "ACTIVE" || !exactName(contact.name, requestedName)) {
      throw new AppError("VALIDATION_FAILED", "The server-resolved Xero contact binding is incomplete or inactive.", {
        httpStatus: 422,
        details: {
          reasonCodes: ["EXACT_ACTIVE_XERO_CONTACT_REQUIRED"],
          providerMutationPossible: false,
        },
      });
    }
    return Object.freeze({
      requestedName,
      contactId: contact.contactId,
      contactName: contact.name!,
      status: "ACTIVE",
      identity,
    });
  }

  #sealedContactIdentity(operation: AccountingCaseOperation): XeroContactIdentityDecision {
    const raw = operation.canonicalPayload.xeroContactIdentity;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError("PERSISTENCE_FAILURE", "The compiled Xero contact identity decision is missing.", {
        httpStatus: 503,
        details: { reasonCodes: ["XERO_CONTACT_IDENTITY_DECISION_MISSING"] },
      });
    }
    const candidate = raw as Record<string, unknown>;
    const requested = candidate.requested;
    const verified = candidate.verified;
    if (
      candidate.contractVersion !== XERO_CONTACT_IDENTITY_CONTRACT_VERSION ||
      (candidate.policy !== "TYPED_DURABLE_IDENTITY" && candidate.policy !== "CANDIDATE_COLLISION_ONLY") ||
      typeof candidate.contactId !== "string" ||
      !requested || typeof requested !== "object" || Array.isArray(requested) ||
      !verified || typeof verified !== "object" || Array.isArray(verified)
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "The compiled Xero contact identity decision is invalid.", {
        httpStatus: 503,
        details: { reasonCodes: ["XERO_CONTACT_IDENTITY_DECISION_INVALID"] },
      });
    }
    const requestedRecord = requested as Record<string, unknown>;
    const verifiedRecord = verified as Record<string, unknown>;
    if (typeof requestedRecord.name !== "string" || typeof verifiedRecord.name !== "string") {
      throw new AppError("PERSISTENCE_FAILURE", "The compiled Xero contact identity evidence is invalid.", {
        httpStatus: 503,
        details: { reasonCodes: ["XERO_CONTACT_IDENTITY_DECISION_INVALID"] },
      });
    }
    return raw as XeroContactIdentityDecision;
  }

  async #assertSealedContactBinding(
    context: RequestContext,
    operationRecord: AccountingCaseOperationRecord,
  ): Promise<ContactSummary> {
    const operation = operationRecord.operation;
    const contactName = this.#stringField(operation.canonicalPayload, "contactName");
    const sealedContactId = this.#stringField(operation.canonicalPayload, "xeroContactId");
    const sealedIdentity = this.#sealedContactIdentity(operation);
    const preparationId = operationRecord.preparationId;
    if (!preparationId) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case execution has no sealed document preparation.", {
        httpStatus: 503,
      });
    }
    const preparation = await this.repository.getXeroMutationPreparation(preparationId);
    if (!preparation) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case sealed document preparation is missing.", {
        httpStatus: 503,
      });
    }
    const preparedContactId = operation.nativeRoute === "SUPPLIER_CREDIT" || operation.nativeRoute === "CUSTOMER_CREDIT"
      ? preparation.canonicalPayload.contactId
      : preparation.canonicalPayload.contact_id;
    if (preparedContactId !== sealedContactId) {
      throw new AppError("PERSISTENCE_FAILURE", "The sealed Xero proposal changed the compiled contact binding.", {
        httpStatus: 503,
        details: { reasonCodes: ["CONTACT_BINDING_ID_MISMATCH"] },
      });
    }

    // Verify both sides of the race immediately before the provider-specific
    // execution service is allowed to claim its one-shot write permit:
    //   (1) the sealed ID still names the exact ACTIVE contact; and
    //   (2) an exact-name search still resolves uniquely to that same ID.
    // This rejects both A-renamed and B-took-A's-name swaps with zero create.
    const [contactById, resolvedByIdentity] = await Promise.all([
      this.accounting.getContact(context, { contact_id: sealedContactId }).catch((error: unknown) => {
        if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
        throw error;
      }),
      this.#resolveContactIdentity(context, sealedIdentity.requested),
    ]);
    const contactByName = resolvedByIdentity?.contact;
    if (
      !contactById ||
      contactById.contactId !== sealedContactId ||
      contactById.status !== "ACTIVE" ||
      !exactName(contactById.name, contactName) ||
      !contactByName ||
      contactByName.contactId !== sealedContactId ||
      contactByName.status !== "ACTIVE" ||
      !exactName(contactByName.name, contactName) ||
      !createXeroContactIdentityDecision(sealedIdentity.requested, contactById) ||
      !resolvedByIdentity ||
      stableStringify(resolvedByIdentity.decision) !== stableStringify(sealedIdentity)
    ) {
      throw new AppError("STALE_PREFLIGHT", "The exact active Xero contact changed after this Case was sealed.", {
        httpStatus: 409,
        retryable: false,
        details: {
          failureLayer: "ACCOUNTING_CASE_PREFLIGHT",
          reasonCodes: ["CONTACT_BINDING_ID_MISMATCH"],
          recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
          providerMutationPossible: false,
        },
      });
    }
    return contactById;
  }

  async #executeContact(
    context: RequestContext,
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
  ): Promise<AccountingCaseVersionRecord> {
    const operation = operationRecord.operation;
    const payload = operation.canonicalPayload;
    const name = payload.name;
    if (typeof name !== "string") throw new AppError("VALIDATION_FAILED", "Contact operation has no canonical name.", { httpStatus: 422 });
    const durableIdentity = contactDurableIdentityFromPayload(payload.durableIdentity);
    if (!durableIdentity) {
      throw new AppError("VALIDATION_FAILED", "A new contact requires a typed durable identity.", {
        httpStatus: 422,
        retryable: false,
        details: {
          reasonCodes: ["CONTACT_DURABLE_IDENTITY_REQUIRED"],
          providerMutationPossible: false,
        },
      });
    }
    const requested = normalizeXeroContactIdentity({
      name,
      durableIdentity,
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      ...(typeof payload.companyNumber === "string" ? { companyNumber: payload.companyNumber } : {}),
      ...(typeof payload.accountNumber === "string" ? { accountNumber: payload.accountNumber } : {}),
    });
    const existing = await this.#resolveVerifiedDurableContact(
      context,
      binding.tenantId,
      requested,
    );
    if (existing) {
      return this.repository.updateAccountingCaseOperation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: operation.operationId,
        requestId: this.#executionRequestId(record),
        expectedStates: ["PENDING", "PREPARED"],
        state: "NO_WRITE_REQUIRED",
        xeroObjectId: existing.contact.contactId,
        readbackSnapshot: {
          ...existing.contact,
          xeroContactIdentity: existing.decision,
        } as unknown as Record<string, unknown>,
        now: this.#now(),
      });
    }
    const preparationId = operationRecord.preparationId;
    if (!preparationId) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case execution has no sealed contact preparation.", {
        httpStatus: 503,
      });
    }
    const requestId = this.#operationRequestId(record, operation);
    const written = await this.accounting.createContact(context, {
      preparation_id: preparationId,
      request_id: requestId,
    }, async () => {
      const current = await this.#resolveVerifiedDurableContact(
        context,
        binding.tenantId,
        requested,
      );
      if (current) {
        throw new AppError("STALE_PREFLIGHT", "The durable Xero contact identity appeared before the provider-write claim.", {
          httpStatus: 409,
          retryable: false,
          details: {
            failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
            reasonCodes: ["XERO_CONTACT_DURABLE_IDENTITY_APPEARED"],
            providerMutationPossible: false,
          },
        });
      }
    });
    const projected = await this.repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      operationId: operation.operationId,
      requestId: this.#executionRequestId(record),
      expectedStates: ["PREPARED"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId: written.mutation_request_id,
      now: this.#now(),
    });
    return projected;
  }

  async #executeNativeDocument(
    context: RequestContext,
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
  ): Promise<AccountingCaseVersionRecord> {
    const operation = operationRecord.operation;
    // Repeat the deployment profile + live AccountID/code/type/class binding at
    // the final Case write boundary. Drift is zero-write and requires a new Case.
    await this.#assertCurrentOrganisationPolicy(context, record);
    this.#assertNativeRouteContract(record, operation);
    const payload = operation.canonicalPayload;
    const contactName = payload.contactName;
    if (typeof contactName !== "string") {
      throw new AppError("VALIDATION_FAILED", "Native document operation has no canonical contact name.", { httpStatus: 422 });
    }
    await this.#assertSealedContactBinding(context, operationRecord);
    const serverCoaConstraints = this.#serverCoaExecutionConstraints(record, operation);
    if (operation.nativeRoute === "SUPPLIER_CREDIT" || operation.nativeRoute === "CUSTOMER_CREDIT") {
      return this.#executeCreditNote(context, binding, record, operationRecord, serverCoaConstraints);
    }
    const preparationId = operationRecord.preparationId;
    if (!preparationId) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case execution has no sealed document preparation.", {
        httpStatus: 503,
      });
    }
    const requestId = this.#operationRequestId(record, operation);
    const firmGovernanceExpectation = this.#sealedFirmGovernanceExpectation(operation);
    const recheckProviderHistoryBeforeWriteClaim = async () => {
      const providerHistory = await this.#providerBusinessCoordinateHistory(context, record, operation);
      if (providerHistory.state === "EXACT_ONE") {
        throw this.#existingBusinessCoordinateError(operation, providerHistory);
      }
    };
    const written = operation.nativeRoute === "SUPPLIER_BILL"
      ? await this.accounting.executePreparedSupplierBillDraft(
          context,
          { preparation_id: preparationId, request_id: requestId },
          serverCoaConstraints,
          recheckProviderHistoryBeforeWriteClaim,
          firmGovernanceExpectation,
        )
      : await this.accounting.executePreparedSalesInvoiceDraft(
          context,
          { preparation_id: preparationId, request_id: requestId },
          serverCoaConstraints,
          recheckProviderHistoryBeforeWriteClaim,
          firmGovernanceExpectation,
        );
    const receipt = written.providerReceipt;
    if (!receipt) throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned no durable provider receipt.", { httpStatus: 502 });
    const projected = await this.repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      operationId: operation.operationId,
      requestId: this.#executionRequestId(record),
      expectedStates: ["PREPARED"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId: written.mutationRequestId,
      now: this.#now(),
    });
    return projected;
  }

  async #executeCreditNote(
    context: RequestContext,
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
    serverCoaConstraints: XeroDeclaredLedgerExecutionConstraints,
  ): Promise<AccountingCaseVersionRecord> {
    const operation = operationRecord.operation;
    const preparationId = operationRecord.preparationId;
    if (!preparationId) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case execution has no sealed credit-note preparation.", {
        httpStatus: 503,
      });
    }
    const written = await this.accounting.createCreditNoteDraft(context, {
      preparation_id: preparationId,
      request_id: this.#operationRequestId(record, operation),
    }, serverCoaConstraints, async () => {
      await this.#assertCurrentOriginalTransactionEvidence(context, record, operation);
      const providerHistory = await this.#providerBusinessCoordinateHistory(context, record, operation);
      if (providerHistory.state === "EXACT_ONE") {
        throw this.#existingBusinessCoordinateError(operation, providerHistory);
      }
    }, this.#sealedFirmGovernanceExpectation(operation));
    const projected = await this.repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      operationId: operation.operationId,
      requestId: this.#executionRequestId(record),
      expectedStates: ["PREPARED"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId: written.mutation_request_id,
      now: this.#now(),
    });
    return projected;
  }

  async #prepareNativeDocumentOperation(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
    contact: ContactSummary,
  ): Promise<{ preparationId: string; providerReferences: CasePreparationProviderReferences }> {
    const operation = operationRecord.operation;
    const payload = operation.canonicalPayload;
    if (payload.xeroContactId !== contact.contactId) {
      throw new AppError("VALIDATION_FAILED", "The server-resolved Xero contact ID does not match the compiled Case binding.", {
        httpStatus: 422,
        details: {
          reasonCodes: ["CONTACT_BINDING_ID_MISMATCH"],
          providerMutationPossible: false,
        },
      });
    }
    const sealedLedgerBinding = xeroDeclaredLedgerBindingFromProviderProjection(record.compiled.providerProjection);
    const serverCoaConstraints = this.#serverCoaExecutionConstraints(record, operation);
    const [accounts, taxes] = await Promise.all([
      this.accounting.listAccounts(context, {}),
      this.accounting.listTaxRates(context),
    ]);
    const resolvedLines = this.#payloadLines(payload).map((line, index) => {
      const code = this.#stringField(line, "accountCode");
      const accountId = this.#stringField(line, "accountId");
      const taxType = this.#stringField(line, "taxType");
      let sealedAccount;
      try {
        sealedAccount = requireXeroDeclaredLedgerAccount(sealedLedgerBinding, code);
      } catch (error) {
        throw new AppError("PERSISTENCE_FAILURE", `Native-document line ${index + 1} has no sealed live account binding.`, {
          httpStatus: 503,
          cause: error,
        });
      }
      const rawProviderBinding = line.providerAccountBinding;
      if (!rawProviderBinding || typeof rawProviderBinding !== "object" || Array.isArray(rawProviderBinding)) {
        throw new AppError("PERSISTENCE_FAILURE", `Native-document line ${index + 1} has no sealed provider account binding.`, {
          httpStatus: 503,
        });
      }
      const providerBinding = rawProviderBinding as Record<string, unknown>;
      if (
        accountId !== sealedAccount.accountId || code !== sealedAccount.accountCode ||
        providerBinding.bindingHash !== sealedLedgerBinding.bindingHash ||
        providerBinding.tenantId !== sealedLedgerBinding.tenantId ||
        providerBinding.accountId !== accountId || providerBinding.accountCode !== code ||
        providerBinding.expectedType !== sealedAccount.accountType ||
        providerBinding.expectedClass !== sealedAccount.accountClass
      ) {
        throw new AppError("PERSISTENCE_FAILURE", `Native-document line ${index + 1} live account binding integrity failed.`, {
          httpStatus: 503,
          details: { reasonCodes: ["XERO_DECLARED_LEDGER_BINDING_MISMATCH"] },
        });
      }
      const idMatches = accounts.filter((account) => account.accountId === accountId);
      const codeMatches = accounts.filter((account) => account.code === code);
      const account = idMatches.length === 1 && codeMatches.length === 1 &&
        idMatches[0] === codeMatches[0] ? idMatches[0] : undefined;
      if (!account || account.status !== "ACTIVE" || account.type === "BANK" || account.systemAccount) {
        throw new AppError("STALE_PREFLIGHT", `Native-document line ${index + 1} no longer has its exact active unprotected Xero AccountID+code binding.`, {
          httpStatus: 409,
          retryable: false,
          details: {
            reasonCodes: ["XERO_DECLARED_LEDGER_BINDING_DRIFT"],
            recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
            providerMutationPossible: false,
          },
        });
      }
      if (account.type?.toUpperCase() !== sealedAccount.accountType ||
          account.class?.toUpperCase() !== sealedAccount.accountClass ||
          (sealedAccount.accountName && compactCaseText(account.name ?? "").toLocaleLowerCase("en") !==
            compactCaseText(sealedAccount.accountName).toLocaleLowerCase("en"))) {
        throw new AppError("STALE_PREFLIGHT", `Native-document line ${index + 1} Xero account semantics drifted from the sealed live binding.`, {
          httpStatus: 409,
          retryable: false,
          details: {
            reasonCodes: ["XERO_DECLARED_LEDGER_BINDING_DRIFT"],
            recoveryAction: "PREPARE_NEW_ACCOUNTING_CASE_VERSION",
            providerMutationPossible: false,
          },
        });
      }
      const taxResolution = resolveStableXeroTaxRate({ taxRates: taxes, taxType, account });
      if (!taxResolution.ok) {
        throw new AppError("VALIDATION_FAILED", `${taxResolution.message} [${taxResolution.code}]`, {
          httpStatus: 422,
          details: { path: `lines[${index}].taxType`, reasonCode: taxResolution.code },
        });
      }
      return {
        description: this.#stringField(line, "description"),
        quantity: fixedNumber(line.quantity, `lines[${index}].quantity`),
        unit_amount: fixedNumber(line.unitAmount, `lines[${index}].unitAmount`),
        account,
        account_id: accountId,
        account_code: code,
        tax_type: taxType,
      };
    });
    if (operation.nativeRoute === "SUPPLIER_CREDIT" || operation.nativeRoute === "CUSTOMER_CREDIT") {
      const lines = resolvedLines.map((line, index) => {
        if (!line.account.accountId) {
          throw new AppError("VALIDATION_FAILED", `Credit-note line ${index + 1} Xero account has no stable account ID.`, {
            httpStatus: 422,
          });
        }
        return {
          description: line.description,
          quantity: line.quantity,
          unit_amount: line.unit_amount,
          account_id: line.account.accountId,
          account_code: line.account_code,
          tax_type: line.tax_type,
        };
      });
      const prepared = await this.accounting.prepareCreditNoteDraft(context, {
        source_ref: `case:${record.compiled.caseId}`,
        source_sha256: this.#operationSourceHash(record, operation),
        source_unit_key: operation.operationId,
        reason: `Accounting Case ${this.#stringField(payload, "reference")}`,
        credit_note_type: operation.nativeRoute === "SUPPLIER_CREDIT" ? "ACCPAYCREDIT" : "ACCRECCREDIT",
        contact_id: contact.contactId,
        credit_note_date: this.#stringField(payload, "documentDate"),
        currency: this.#stringField(payload, "currency"),
        reference: this.#stringField(payload, "reference"),
        authoritative_provider_field: this.#stringField(
          payload,
          "authoritativeProviderField",
        ) as "CREDIT_NOTE_NUMBER" | "REFERENCE",
        line_amount_type: lineAmountType(payload.lineAmountType),
        lines,
      }, serverCoaConstraints);
      return {
        preparationId: prepared.preparation_id,
        providerReferences: {
          contact,
          creditLineAccountIds: lines.map((line) => line.account_id),
          ledgerBinding: sealedLedgerBinding,
        },
      };
    }

    const common = {
      source_ref: `case:${record.compiled.caseId}`,
      source_unit_key: operation.operationId,
      source_sha256: this.#operationSourceHash(record, operation),
      invoice_date: this.#stringField(payload, "documentDate"),
      due_date: this.#stringField(payload, "dueDate"),
      currency: this.#stringField(payload, "currency"),
      ...(payload.invoiceRate !== undefined
        ? { currency_rate: fixedNumber(payload.invoiceRate, "invoiceRate") }
        : {}),
      reference: this.#stringField(payload, "reference"),
      authoritative_provider_field: this.#stringField(
        payload,
        "authoritativeProviderField",
      ) as "INVOICE_NUMBER" | "REFERENCE",
      line_amount_type: lineAmountType(payload.lineAmountType),
      lines: resolvedLines.map(({ account: _account, account_id: _accountId, ...line }) => line),
    };
    const prepared = operation.nativeRoute === "SUPPLIER_BILL"
      ? await this.accounting.prepareSupplierBillDraft(context, {
          ...common,
          authoritative_provider_field: common.authoritative_provider_field as "INVOICE_NUMBER",
          supplier_name: this.#stringField(payload, "contactName"),
        }, serverCoaConstraints)
      : await this.accounting.prepareSalesInvoiceDraft(context, {
          ...common,
          customer_name: this.#stringField(payload, "contactName"),
        }, serverCoaConstraints);
    if (!prepared.technicallyReady || !prepared.preparation_id) {
      throw new AppError("VALIDATION_FAILED", "Xero native-document preflight did not produce an executable proposal.", {
        httpStatus: 422,
        details: { blockers: prepared.blockers },
      });
    }
    return {
      preparationId: prepared.preparation_id,
      providerReferences: { contact, ledgerBinding: sealedLedgerBinding },
    };
  }

  #payloadLines(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    if (!Array.isArray(payload.lines) || payload.lines.some((line) => !line || typeof line !== "object" || Array.isArray(line))) {
      throw new AppError("VALIDATION_FAILED", "Accounting Case native document lines are invalid.", { httpStatus: 422 });
    }
    return payload.lines as Array<Record<string, unknown>>;
  }

  #serverCoaExecutionConstraints(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ): XeroDeclaredLedgerExecutionConstraints {
    const ledgerBinding = xeroDeclaredLedgerBindingFromProviderProjection(record.compiled.providerProjection);
    const lines = this.#payloadLines(operation.canonicalPayload).map((line, index) => {
      const accountCode = this.#stringField(line, "accountCode");
      const taxType = this.#stringField(line, "taxType");
      if (!xeroDeclaredLedgerAccount(ledgerBinding, accountCode)) {
        throw new AppError("PERSISTENCE_FAILURE", `Native-document line ${index + 1} has no sealed live account binding.`, {
          httpStatus: 503,
          retryable: false,
          details: { providerMutationPossible: false },
        });
      }
      return { accountCode, taxType };
    });
    return createXeroDeclaredLedgerExecutionConstraints(ledgerBinding, lines);
  }

  #stringField(payload: Record<string, unknown>, field: string): string {
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new AppError("VALIDATION_FAILED", `Accounting Case ${field} is missing or non-canonical.`, { httpStatus: 422 });
    }
    return value;
  }

  #operationSourceHash(
    record: AccountingCaseVersionRecord,
    operation: AccountingCaseOperation,
  ): string {
    const event = record.compiled.events.find((candidate) => candidate.eventId === operation.eventId);
    if (!event) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case operation has no source event.", {
        httpStatus: 503,
      });
    }
    return hashObject({
      semantics: "accounting-case-operation-source:v1",
      caseId: record.compiled.caseId,
      caseVersion: record.compiled.version,
      caseSourceRevisionHash: record.compiled.sourceRevisionHash,
      operationId: operation.operationId,
      eventId: operation.eventId,
      factIds: event.factIds,
      sourceUnitIds: event.sourceUnitIds,
      canonicalPayloadHash: operation.canonicalPayloadHash,
      sourceFactIds: operation.amountBridge?.sourceFactIds ?? [],
      sourceLineHash: operation.amountBridge?.sourceLineHash ?? null,
    });
  }

  #operationRequestId(record: AccountingCaseVersionRecord, operation: AccountingCaseOperation): string {
    return `caseop:${hashObject({
      caseId: record.compiled.caseId,
      caseVersion: record.compiled.version,
      operationId: operation.operationId,
      actionId: operation.actionId,
      canonicalPayloadHash: operation.canonicalPayloadHash,
    })}`;
  }

  #executionRequestId(record: AccountingCaseVersionRecord): string {
    if (!record.executionRequestId) {
      throw new AppError("PERSISTENCE_FAILURE", "Accounting Case has no execution owner.", { httpStatus: 503 });
    }
    return record.executionRequestId;
  }

  async #reconcileOperationFailure(
    context: RequestContext,
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    failed: AccountingCaseOperationRecord,
    error: unknown,
  ): Promise<{ record: AccountingCaseVersionRecord; resolvedAsSuccess: boolean }> {
    // A repository projection can deliberately persist a stricter state than
    // the generic mutation (for example, Case-economic READBACK_MISMATCH).
    // Re-read before reconciliation so the follow-up CAS never acts on the
    // caller's stale PREPARED snapshot or reopens a provider create.
    record = await this.repository.getBoundAccountingCase({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
    }) ?? record;
    const current = record.operations.find((candidate) =>
      candidate.operation.operationId === failed.operation.operationId) ?? failed;
    const mutationRequestId = current.preparationId
      ? xeroMutationRequestIdForPreparation(current.preparationId)
      : undefined;
    let request = mutationRequestId
      ? await this.repository.getXeroMutationRequest(mutationRequestId)
      : undefined;
    if (request?.state === "WRITE_IN_FLIGHT") {
      try {
        request = await this.mutations.markUnknown(context, { mutationRequestId: request.mutationRequestId });
      } catch {
        request = await this.repository.getXeroMutationRequest(request.mutationRequestId) ?? request;
      }
    }
    const desiredState = request ? this.#mutationProjectionState(request) : undefined;
    if (request && desiredState) {
      record = await this.repository.projectAccountingCaseOperationFromMutation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: current.operation.operationId,
        requestId: this.#executionRequestId(record),
        expectedStates: [current.state],
        mutationRequestId: request.mutationRequestId,
        desiredState,
        now: this.#now(),
      });
      if (desiredState === "READBACK_VERIFIED") return { record, resolvedAsSuccess: true };
      if (["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(desiredState)) {
        record = await this.#finalizeRecovery(binding, record, this.#executionRequestId(record));
        return { record, resolvedAsSuccess: false };
      }
      record = await this.#cancelOperationsAfterFailure(binding, record, current.ordinal);
      record = await this.#finalizeDefiniteOutcome(binding, record);
      return { record, resolvedAsSuccess: false };
    }

    const safe = toSafeError(error);
    if (
      !request &&
      safe.details?.businessCoordinateDecision === "NO_WRITE_REQUIRED_EXISTING" &&
      typeof safe.details.providerObjectId === "string" &&
      safe.details.noWriteEvidence &&
      typeof safe.details.noWriteEvidence === "object" &&
      !Array.isArray(safe.details.noWriteEvidence)
    ) {
      record = await this.repository.updateAccountingCaseOperation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: current.operation.operationId,
        requestId: this.#executionRequestId(record),
        expectedStates: [current.state],
        state: "NO_WRITE_REQUIRED",
        xeroObjectId: safe.details.providerObjectId,
        readbackSnapshot: safe.details.noWriteEvidence as Record<string, unknown>,
        now: this.#now(),
      });
      return { record, resolvedAsSuccess: true };
    }
    if (!request && safe.code === "APPROVAL_INVALID" && current.preparationId) {
      const preparation = await this.repository.getXeroMutationPreparation(current.preparationId);
      const checkedAt = this.#now();
      if (preparation && (
        preparation.state === "EXPIRED" ||
        preparation.expiresAt < new Date(checkedAt.getTime() + ACCOUNTING_CASE_MIN_PREPARATION_RUNWAY_MS)
      )) {
        record = await this.repository.pauseAccountingCaseExecution({
          binding,
          caseId: record.compiled.caseId,
          version: record.compiled.version,
          requestId: this.#executionRequestId(record),
          errorReceipt: {
            code: "STALE_PREFLIGHT",
            retryable: true,
            failureLayer: "ACCOUNTING_CASE_PREFLIGHT",
            recoveryAction: "RESEAL_REMAINING_PREPARED_OPERATIONS",
            reasonCodes: ["MUTATION_PREPARATION_EXPIRED_WITHOUT_REQUEST"],
            providerMutationPossible: false,
            recordedAt: checkedAt.toISOString(),
          },
          now: checkedAt,
        });
        return { record, resolvedAsSuccess: false };
      }
    }
    const deterministicFailure = [
      "VALIDATION_FAILED",
      "CONFLICT",
      "ACTION_UNSUPPORTED",
      "NOT_FOUND",
      "APPROVAL_INVALID",
    ].includes(safe.code);
    if (deterministicFailure) {
      record = await this.repository.updateAccountingCaseOperation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: current.operation.operationId,
        requestId: this.#executionRequestId(record),
        expectedStates: [current.state],
        state: "BLOCKED_VALIDATION",
        errorReceipt: safeErrorReceipt(error),
        now: this.#now(),
      });
      record = await this.#cancelOperationsAfterFailure(binding, record, current.ordinal);
      record = await this.#finalizeDefiniteOutcome(binding, record);
      return { record, resolvedAsSuccess: false };
    }

    // No mutation request means the provider write boundary was never
    // claimed. Preserve all sealed preparations and release the Case owner so
    // permission, connection or transient read failures can be retried without
    // being misreported as a rejected Xero write.
    record = await this.repository.pauseAccountingCaseExecution({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      requestId: this.#executionRequestId(record),
      errorReceipt: safeErrorReceipt(error),
      now: this.#now(),
    });
    return { record, resolvedAsSuccess: false };
  }

  #mutationProjectionState(
    request: XeroMutationRequest,
  ): CaseMutationProjectionState | undefined {
    if (request.state === "FAILED_VALIDATION") return "BLOCKED_VALIDATION";
    if ([
      "WRITE_IN_FLIGHT",
      "READBACK_VERIFIED",
      "WRITE_UNCERTAIN",
      "READBACK_MISMATCH",
      "PROVIDER_REJECTED",
    ].includes(request.state)) {
      return request.state as Exclude<CaseMutationProjectionState, "BLOCKED_VALIDATION">;
    }
    return undefined;
  }

  async #cancelOperationsAfterFailure(
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    failedOrdinal: number,
  ): Promise<AccountingCaseVersionRecord> {
    const later = [...record.operations]
      .filter((operation) =>
        operation.ordinal > failedOrdinal && ["PENDING", "PREPARED"].includes(operation.state))
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const operation of later) {
      record = await this.repository.updateAccountingCaseOperation({
        binding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: operation.operation.operationId,
        requestId: this.#executionRequestId(record),
        expectedStates: [operation.state],
        state: "NOT_EXECUTED_AFTER_PRIOR_FAILURE",
        errorReceipt: {
          code: "PRIOR_OPERATION_FAILED",
          priorFailureOrdinal: failedOrdinal,
          retryable: false,
        },
        now: this.#now(),
      });
    }
    return record;
  }

  async #finalizeDefiniteOutcome(
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
  ): Promise<AccountingCaseVersionRecord> {
    const state = this.#terminalCaseState(record);
    return this.repository.finalizeAccountingCase({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      requestId: this.#executionRequestId(record),
      state,
      terminalSummary: accountingCaseTerminalSummary(record, state),
      now: this.#now(),
    });
  }

  async #recoverCase(
    context: RequestContext,
    currentAccessBinding: AccountingCaseBinding,
    initial: AccountingCaseVersionRecord,
    requestId: string,
  ): Promise<AccountingCaseVersionRecord> {
    let record = initial;
    const recoveryOperations = [...record.operations]
      .filter((operation) => ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(operation.state))
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const initialOperation of recoveryOperations) {
      const current = record.operations.find((candidate) =>
        candidate.operation.operationId === initialOperation.operation.operationId);
      if (!current?.preparationId) {
        throw new AppError("PERSISTENCE_FAILURE", "Accounting Case recovery has no sealed preparation.", {
          httpStatus: 503,
        });
      }
      const mutationRequestId = current.mutationRequestId ??
        xeroMutationRequestIdForPreparation(current.preparationId);
      try {
        await this.#recoverOperation(context, record, current);
      } catch (error) {
        let request = await this.repository.getXeroMutationRequest(mutationRequestId);
        if (request?.state === "WRITE_IN_FLIGHT") {
          try {
            request = await this.mutations.markUnknown(context, { mutationRequestId });
          } catch {
            request = await this.repository.getXeroMutationRequest(mutationRequestId) ?? request;
          }
        }
        const desiredState = request ? this.#mutationProjectionState(request) : undefined;
        if (request && desiredState) {
          record = await this.repository.projectAccountingCaseOperationFromMutation({
            binding: currentAccessBinding,
            caseId: record.compiled.caseId,
            version: record.compiled.version,
            operationId: current.operation.operationId,
            requestId,
            expectedStates: [current.state],
            mutationRequestId,
            desiredState,
            accessMode: "RECOVERY_GET_ONLY",
            now: this.#now(),
          });
          if (desiredState === "READBACK_VERIFIED") continue;
        }
        record = await this.#finalizeRecovery(
          currentAccessBinding,
          record,
          requestId,
          "RECOVERY_GET_ONLY",
        );
        throw this.#caseExecutionError(error, record, current.operation.operationId);
      }
      const request = await this.repository.getXeroMutationRequest(mutationRequestId);
      const desiredState = request ? this.#mutationProjectionState(request) : undefined;
      if (!request || desiredState !== "READBACK_VERIFIED") {
        throw new AppError("PERSISTENCE_FAILURE", "Read-only Xero recovery did not produce verified mutation evidence.", {
          httpStatus: 503,
        });
      }
      record = await this.repository.projectAccountingCaseOperationFromMutation({
        binding: currentAccessBinding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        operationId: current.operation.operationId,
        requestId,
        expectedStates: [current.state],
        mutationRequestId,
        desiredState,
        accessMode: "RECOVERY_GET_ONLY",
        now: this.#now(),
      });
    }

    // This invocation was recovery-only. Even after a successful GET it may
    // not flow into a fresh create; residual sealed work is released for a new
    // exact-target invocation that repeats live authority checks.
    if (record.operations.some((operation) => operation.state === "PREPARED")) {
      const recoveryNow = this.#now();
      const originalTargetExpired = record.binding.targetSessionExpiresAt <= recoveryNow;
      const targetRenewed = record.binding.targetSessionHash !== currentAccessBinding.targetSessionHash;
      if (originalTargetExpired && targetRenewed) {
        const residualOperationIds = record.operations
          .filter((operation) => operation.state === "PREPARED")
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((operation) => operation.operation.operationId);
        const successorCaseId = `recovery-${hashObject({
          domain: "xero-accounting-case-expired-target-successor:v1",
          sourceCaseId: record.compiled.caseId,
          sourceVersion: record.compiled.version,
          sourcePlanHash: record.compiledPlanHash,
          residualOperationIds,
          targetSessionHash: currentAccessBinding.targetSessionHash,
        })}`;
        let continuation: NonNullable<Parameters<
          AccountingRepository["completeExpiredTargetAccountingCaseRecovery"]
        >[0]["continuation"]> | undefined;
        try {
          const template = accountingCaseRecoveryResidualContinuationTemplate({
            source: record.compiled,
            successorCaseId,
            residualOperationIds,
          });
          continuation = {
            grantId: `acrg_${hashObject({
              domain: "xero-accounting-case-expired-target-residual-grant:v1",
              sourceCaseId: record.compiled.caseId,
              sourceVersion: record.compiled.version,
              sourcePlanHash: record.compiledPlanHash,
              successorCaseId,
              residualOperationIds,
              targetSessionHash: currentAccessBinding.targetSessionHash,
            })}`,
            successorCaseId,
            template,
            templateHash: accountingCaseContinuationTemplateHash(template),
          };
        } catch {
          // Some residual dependency graphs cannot be represented by the
          // public business-document template. They still terminate safely
          // with explicit no-write receipts instead of becoming unreachable.
        }
        return this.repository.completeExpiredTargetAccountingCaseRecovery({
          currentAccessBinding,
          caseId: record.compiled.caseId,
          version: record.compiled.version,
          requestId,
          ...(continuation ? { continuation } : {}),
          reasonReceipt: continuation
            ? {
                code: "EXPIRED_TARGET_RECOVERY_CONTINUED_TO_SUCCESSOR",
                successorCaseId,
                providerMutationPossible: false,
              }
            : {
                code: "EXPIRED_TARGET_RECOVERY_REQUIRES_MANUAL_REPREPARATION",
                reasonCodes: ["RECOVERY_RESIDUAL_TEMPLATE_UNREPRESENTABLE"],
                providerMutationPossible: false,
              },
          now: recoveryNow,
        });
      }
      return this.repository.releaseAccountingCaseRecovery({
        currentAccessBinding,
        caseId: record.compiled.caseId,
        version: record.compiled.version,
        requestId,
        reasonReceipt: {
          code: "READBACK_RECOVERY_COMPLETED",
          nextAction: "EXECUTE_CASE_AGAIN_WITH_EXACT_ORIGINAL_TARGET",
        },
        now: this.#now(),
      });
    }
    const state = this.#terminalCaseState(record);
    return this.repository.finalizeAccountingCase({
      binding: currentAccessBinding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      requestId,
      accessMode: "RECOVERY_GET_ONLY",
      state,
      terminalSummary: accountingCaseTerminalSummary(record, state),
      now: this.#now(),
    });
  }

  async #recoverOperation(
    context: RequestContext,
    record: AccountingCaseVersionRecord,
    operationRecord: AccountingCaseOperationRecord,
  ): Promise<void> {
    const preparationId = operationRecord.preparationId;
    if (!preparationId) throw new AppError("PERSISTENCE_FAILURE", "Recovery preparation is missing.");
    const input = {
      preparation_id: preparationId,
      request_id: this.#operationRequestId(record, operationRecord.operation),
    };
    switch (operationRecord.operation.actionId) {
      case "contact.create_basic":
        await this.accounting.createContact(context, input);
        return;
      case "supplier_bill.create_draft":
        await this.accounting.executePreparedSupplierBillDraft(context, input);
        return;
      case "customer_invoice.create_draft":
        await this.accounting.executePreparedSalesInvoiceDraft(context, input);
        return;
      case "credit_note.create_draft":
        await this.accounting.createCreditNoteDraft(context, input);
        return;
    }
  }

  async #finalizeRecovery(
    binding: AccountingCaseBinding,
    record: AccountingCaseVersionRecord,
    requestId: string,
    accessMode?: "RECOVERY_GET_ONLY",
  ): Promise<AccountingCaseVersionRecord> {
    return this.repository.finalizeAccountingCase({
      binding,
      caseId: record.compiled.caseId,
      version: record.compiled.version,
      requestId,
      ...(accessMode ? { accessMode } : {}),
      state: "RECOVERY_REQUIRED",
      terminalSummary: accountingCaseTerminalSummary(record, "RECOVERY_REQUIRED"),
      now: this.#now(),
    });
  }

  #terminalCaseState(record: AccountingCaseVersionRecord): "PARTIALLY_COMMITTED" | "TERMINAL" {
    const hasCompleted = record.operations.some((operation) =>
      operation.state === "READBACK_VERIFIED" || operation.state === "NO_WRITE_REQUIRED");
    const hasFailed = record.operations.some((operation) =>
      operation.state === "PROVIDER_REJECTED" || operation.state === "BLOCKED_VALIDATION");
    return hasCompleted && hasFailed ? "PARTIALLY_COMMITTED" : "TERMINAL";
  }

  #shouldAwaitContinuation(record: AccountingCaseVersionRecord): boolean {
    return hasAccountingCaseDependentContinuation(record.compiled) &&
      record.operations.length > 0 &&
      record.operations.every((operation) =>
        operation.state === "READBACK_VERIFIED" || operation.state === "NO_WRITE_REQUIRED");
  }

  #caseExecutionError(
    error: unknown,
    record: AccountingCaseVersionRecord,
    failedOperationId?: string,
  ): AppError {
    const safe = toSafeError(error);
    const completedOperationIds = record.operations
      .filter((operation) => operation.state === "READBACK_VERIFIED" || operation.state === "NO_WRITE_REQUIRED")
      .map((operation) => operation.operation.operationId);
    return new AppError(safe.code, safe.message, {
      httpStatus: safe.httpStatus,
      retryable: safe.retryable,
      details: {
        ...(safe.details ?? {}),
        caseId: record.compiled.caseId,
        caseVersion: record.compiled.version,
        completedOperationIds,
        ...(failedOperationId ? { failedOperationId } : {}),
        nextAction: typeof safe.details?.nextAction === "string"
          ? safe.details.nextAction
          : "GET_ACCOUNTING_CASE_STATUS",
      },
      cause: error,
    });
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Accounting Case clock returned an invalid date.");
    return new Date(now);
  }
}
