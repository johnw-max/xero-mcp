import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  AccountingRepository,
  XeroNativeIdempotencyRecoveryClaim,
} from "../db/repository.js";
import { XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS } from "../db/repository.js";
import {
  XERO_MUTATION_ALLOWED_OPERATIONS,
  expectedXeroMutationReadbackStatus,
  type BoundXeroMutationRequestInput,
  type CompleteXeroMutationReadbackInput as RepositoryReadbackInput,
  type RecordXeroMutationWriteEvidenceInput as RepositoryWriteEvidenceInput,
  type RejectXeroMutationProviderInput as RepositoryProviderRejectionInput,
  type XeroMutationBindingIdentity,
  type XeroMutationObjectType,
  type XeroMutationOperation,
  type XeroMutationPreparation,
  type XeroMutationRequest,
  type XeroMutationSourceEvidenceType,
} from "../domain/xeroMutation.js";
import {
  completeXeroMutationReadbackSchema,
  authoriseAutonomousXeroMutationSchema,
  confirmXeroMutationSchema,
  failXeroMutationValidationSchema,
  markXeroMutationUnknownSchema,
  prepareXeroMutationSchema,
  recordXeroMutationWriteEvidenceSchema,
  rejectXeroMutationProviderSchema,
  startXeroMutationSchema,
  xeroMutationObjectTypeSchema,
  xeroMutationOperationSchema,
  xeroMutationSourceEvidenceTypeSchema,
  type CompleteXeroMutationReadbackInput,
  type AuthoriseAutonomousXeroMutationInput,
  type ConfirmXeroMutationInput,
  type FailXeroMutationValidationInput,
  type MarkXeroMutationUnknownInput,
  type PrepareXeroMutationInput,
  type RecordXeroMutationWriteEvidenceInput,
  type RejectXeroMutationProviderInput,
  type StartXeroMutationInput,
} from "../domain/xeroMutationSchemas.js";
import { AppError } from "../errors.js";
import { hashObject, stableStringify } from "../security/hash.js";
import {
  requireOAuthBoundRequestContext,
  type OAuthBoundRequestContext,
  type RequestContext,
} from "../security/requestContext.js";
import { z } from "zod/v4";
import {
  LEDGER_CONTROL_KERNEL_VERSION,
  type LedgerAutonomousAuthorizationReceipt,
} from "../control-kernel/ledgerControlKernel.js";
import {
  xeroAutonomousActionForMutation,
  type XeroAutonomousWriteAction,
} from "../policy/xeroAutonomousActions.js";
import { lookupAgentFacingXeroCapabilityDecision } from "../policy/xeroCapabilityPolicy.js";
import { xeroCapabilityDenied } from "../policy/xeroCapabilityError.js";
import type { XeroRuntimeCapabilityEvaluator } from "../policy/xeroRuntimeCapabilityService.js";
import {
  objectPreparationSourceRevisionHash,
  verifyDeterministicValidationReceipt,
  type DeterministicValidationReceipt,
} from "../control-kernel/deterministicValidation.js";
import {
  issueXeroProviderWritePermit,
  issueXeroProviderWriteRecoveryPermit,
  type LedgerProviderWritePermit,
  type XeroProviderWriteAdapterOperation,
} from "../security/xeroProviderWritePermit.js";
import type { LedgerAuthoritySnapshotResolver } from "../domain/ledgerAuthority.js";
import type { XeroFirmGovernanceExpectation } from "../policy/xeroFirmGovernanceClaim.js";

import { XERO_WRITE_ACTIONS, type XeroWriteActionId } from "../domain/xeroWriteActions.js";

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MIN_CONFIRMATION_TTL_MS = 30 * 1_000;
const MAX_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
const MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1_024;
const MAX_CONFIRMATION_DETAILS_BYTES = 16 * 1_024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 50_000;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CURRENT_WRITE_GATE_DELEGATION_ID = "xero-current-case-write-gate";
const CURRENT_WRITE_GATE_REVISION = 1;
const CURRENT_WRITE_GATE_COMPATIBILITY_HASH = hashObject({
  executionAuthority: "OAUTH_TARGET_BOUND_WRITE_GATE",
  providerId: "xero",
  version: 1,
});

const PROVIDER_ADAPTER_OPERATION_BY_ACTION: Readonly<
  Record<XeroAutonomousWriteAction, XeroProviderWriteAdapterOperation>
> = Object.freeze(
  // Derived from the write-action registry; the adapter an action calls is part
  // of that action's definition, not a second list that has to agree with it.
  Object.fromEntries(
    (Object.keys(XERO_WRITE_ACTIONS) as XeroWriteActionId[]).map((actionId) =>
      [actionId, XERO_WRITE_ACTIONS[actionId].providerAdapterOperation]
    ),
  ) as Record<XeroAutonomousWriteAction, XeroProviderWriteAdapterOperation>,
);

const confirmationSummarySchema = z.object({
  objectType: xeroMutationObjectTypeSchema,
  operation: xeroMutationOperationSchema,
  tenantId: z.string().trim().min(1).max(255),
  canonicalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRef: z.string().min(1).max(512).optional(),
  sourceUnitKey: z.string().min(1).max(256),
  sourceEvidenceType: xeroMutationSourceEvidenceTypeSchema,
  sourceHashSemantics: z.enum([
    "CALLER_ASSERTED_UNVERIFIED",
    "CANONICAL_EXTRACTION_FINGERPRINT_NOT_FILE_HASH",
  ]),
  targetXeroObjectId: z.string().trim().min(1).max(255).optional(),
  details: z.record(z.string(), z.unknown()),
}).strict();

export type XeroMutationConfirmationSummary = z.infer<typeof confirmationSummarySchema>;

export interface PreparedXeroMutation {
  preparationId: string;
  state: "PREPARED";
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  confirmationSummary: XeroMutationConfirmationSummary;
  confirmationSummaryHash: string;
  confirmationPhrase: string;
  expiresAt: Date;
}

export interface XeroMutationServiceOptions {
  confirmationSecret: string | Buffer;
  /** Current release process-level XERO_WRITE_ENABLED gate. */
  writeEnabled?: boolean;
  /** @deprecated Historical-test input; ignored by the current release path. */
  authoritySnapshotResolver?: LedgerAuthoritySnapshotResolver;
  /** @deprecated Historical-test alias for writeEnabled. */
  writeKillSwitchEnabled?: boolean;
  confirmationTtlMs?: number;
  now?: () => Date;
  unsafeAllowLegacyContextForTests?: boolean;
  legacyBindingForTests?: XeroMutationBindingIdentity;
  providerCapabilityEvaluator?: XeroRuntimeCapabilityEvaluator;
}

export interface XeroMutationRecoveryResult {
  outcome: "READBACK_VERIFIED" | "READBACK_MISMATCH";
  request: XeroMutationRequest;
}

export type AutonomousXeroMutationClaim =
  | {
      request: XeroMutationRequest;
      mode: "CALL_PROVIDER";
      providerWritePermit: LedgerProviderWritePermit;
    }
  | {
      request: XeroMutationRequest;
      mode: "RECOVER_ONLY" | "ALREADY_VERIFIED";
    };

export interface AutonomousXeroMutationRecoveryClaim {
  preparation: XeroMutationPreparation;
  claim: AutonomousXeroMutationClaim;
}

export interface XeroMutationConfirmationExpectation {
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
}

/**
 * Stable identity shared by the mutation foundation and its enclosing
 * Accounting Case. A provider retry must always resolve to the same durable
 * request; callers never get to choose this identifier.
 */
export function xeroMutationRequestIdForPreparation(preparationId: string): string {
  return `xmr_${hashObject({ preparationId }).slice(0, 32)}`;
}

export interface AutonomousActionsPreflightReceipt {
  receiptType: "XERO_AUTONOMOUS_ACTIONS_PREFLIGHT";
  tenantId: string;
  targetSessionId: string;
  bindingRevision: number;
  checkedAt: string;
  checks: Array<{
    actionId: XeroAutonomousWriteAction;
    providerCapabilityReceiptHash: string;
    writeGateReceiptHash: string;
  }>;
  receiptHash: string;
}

function validationError(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { httpStatus: 400 });
}

function parseStrict<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(`${label} is invalid.`);
  return parsed.data;
}

function canonicalJsonRecord(
  input: Record<string, unknown>,
  label: string,
  maxBytes: number,
): Record<string, unknown> {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw validationError(`${label} is too complex.`);
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw validationError(`${label} must contain finite JSON numbers.`);
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw validationError(`${label} must not contain sparse arrays.`);
        visit(value[index], depth + 1);
      }
      return;
    }
    if (typeof value !== "object") throw validationError(`${label} must contain JSON values only.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError(`${label} must contain plain JSON objects only.`);
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) throw validationError(`${label} contains a reserved key.`);
      visit(child, depth + 1);
    }
  };
  visit(input, 0);
  const serialized = stableStringify(input);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw validationError(`${label} is too large.`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function ensureAllowedOperation(objectType: XeroMutationObjectType, operation: XeroMutationOperation): void {
  if (!XERO_MUTATION_ALLOWED_OPERATIONS[objectType].some((candidate) => candidate === operation)) {
    throw validationError(`${operation} is not an approved operation for ${objectType}.`);
  }
}

function nowIsValid(now: Date): boolean {
  return now instanceof Date && Number.isFinite(now.getTime());
}

function tenantConfirmationLabel(tenantId: string): string {
  return tenantId.length <= 16 ? tenantId : `${tenantId.slice(0, 8)}…${tenantId.slice(-4)}`;
}

export class XeroMutationService {
  readonly #confirmationSecret: Buffer;
  readonly #confirmationTtlMs: number;
  readonly #now: () => Date;
  readonly #allowLegacyForTests: boolean;
  readonly #legacyBinding?: XeroMutationBindingIdentity;
  readonly #writeEnabled: boolean;
  readonly #providerCapabilityEvaluator: XeroRuntimeCapabilityEvaluator | undefined;

  constructor(
    private readonly repository: AccountingRepository,
    options: XeroMutationServiceOptions,
  ) {
    this.#confirmationSecret = Buffer.isBuffer(options.confirmationSecret)
      ? Buffer.from(options.confirmationSecret)
      : Buffer.from(options.confirmationSecret, "utf8");
    if (this.#confirmationSecret.byteLength < 32) {
      throw new AppError("CONFIGURATION_ERROR", "Xero mutation confirmation secret must be at least 32 bytes.");
    }
    const ttl = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    if (!Number.isInteger(ttl) || ttl < MIN_CONFIRMATION_TTL_MS || ttl > MAX_CONFIRMATION_TTL_MS) {
      throw new AppError("CONFIGURATION_ERROR", "Xero mutation confirmation TTL is outside the safe range.");
    }
    this.#confirmationTtlMs = ttl;
    this.#now = options.now ?? (() => new Date());
    this.#writeEnabled = options.writeEnabled ?? options.writeKillSwitchEnabled === true;
    this.#providerCapabilityEvaluator = options.providerCapabilityEvaluator;
    this.#allowLegacyForTests = options.unsafeAllowLegacyContextForTests === true;
    if (this.#allowLegacyForTests) {
      if (process.env.NODE_ENV !== "test" || !options.legacyBindingForTests) {
        throw new AppError(
          "CONFIGURATION_ERROR",
          "Legacy Xero mutation contexts are permitted only by an explicit test-only binding.",
        );
      }
      this.#legacyBinding = { ...options.legacyBindingForTests };
    } else if (options.legacyBindingForTests) {
      throw new AppError("CONFIGURATION_ERROR", "A legacy test binding requires the explicit test-only switch.");
    }
  }

  async prepare(context: RequestContext, rawInput: PrepareXeroMutationInput): Promise<PreparedXeroMutation> {
    const input = parseStrict(prepareXeroMutationSchema, rawInput, "Mutation preparation");
    ensureAllowedOperation(input.objectType, input.operation);
    if (input.sourceEvidenceType === "HOST_ATTESTED_FILE_RECEIPT") {
      throw validationError("HOST_ATTESTED_FILE_RECEIPT is reserved until a server-verified host receipt is available.");
    }
    const binding = await this.#resolveBinding(context);
    const canonicalPayload = canonicalJsonRecord(
      input.canonicalPayload,
      "Canonical mutation payload",
      MAX_CANONICAL_PAYLOAD_BYTES,
    );
    const details = canonicalJsonRecord(
      input.confirmationDetails,
      "Mutation confirmation details",
      MAX_CONFIRMATION_DETAILS_BYTES,
    );
    const canonicalPayloadHash = hashObject(canonicalPayload);
    const sourceSha256 = input.sourceEvidenceType === "SERVER_FINGERPRINTED_EXTRACTION"
      ? hashObject({
          semantics: "xero-server-source-fingerprint:v1",
          sourceRef: input.sourceRef,
          sourceUnitKey: input.sourceUnitKey,
          canonicalPayload,
        })
      : input.sourceSha256;
    if (!sourceSha256) {
      throw validationError("Agent-asserted source evidence requires a caller-provided source hash.");
    }
    const confirmationSummary: XeroMutationConfirmationSummary = {
      objectType: input.objectType,
      operation: input.operation,
      tenantId: binding.tenantId,
      canonicalPayloadHash,
      sourceSha256,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      sourceUnitKey: input.sourceUnitKey,
      sourceEvidenceType: input.sourceEvidenceType,
      sourceHashSemantics: input.sourceEvidenceType === "SERVER_FINGERPRINTED_EXTRACTION"
        ? "CANONICAL_EXTRACTION_FINGERPRINT_NOT_FILE_HASH"
        : "CALLER_ASSERTED_UNVERIFIED",
      ...(input.targetXeroObjectId ? { targetXeroObjectId: input.targetXeroObjectId } : {}),
      details,
    };
    const confirmationSummaryHash = this.#hashConfirmationSummary(binding, confirmationSummary);
    const preparationId = `xmp_${randomUUID().replaceAll("-", "")}`;
    const serverChallenge = randomBytes(10).toString("hex").toUpperCase();
    const confirmationBase = input.confirmationPhrase ?? `CONFIRM-${input.objectType}`;
    const confirmationPhrase = `${confirmationBase}｜账套 ${tenantConfirmationLabel(binding.tenantId)}｜挑战 ${serverChallenge}｜来源指纹 ${sourceSha256.slice(0, 12).toUpperCase()}`;
    if (confirmationPhrase.length > 256) {
      throw validationError("Mutation confirmation phrase is too long after adding the server challenge.");
    }
    const confirmationPhraseHash = this.#hashConfirmationPhrase(preparationId, confirmationPhrase);
    const now = this.#currentTime();
    const expiresAt = new Date(now.getTime() + this.#confirmationTtlMs);
    const preparation = await this.repository.createXeroMutationPreparation({
      ...binding,
      preparationId,
      objectType: input.objectType,
      operation: input.operation,
      ...(input.targetXeroObjectId ? { targetXeroObjectId: input.targetXeroObjectId } : {}),
      canonicalPayload,
      canonicalPayloadHash,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256,
      sourceEvidenceType: input.sourceEvidenceType,
      confirmationSummaryHash,
      confirmationPhraseHash,
      expiresAt,
      now,
    });
    return {
      preparationId: preparation.preparationId,
      state: "PREPARED",
      objectType: preparation.objectType,
      operation: preparation.operation,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummary,
      confirmationSummaryHash,
      confirmationPhrase,
      expiresAt: preparation.expiresAt,
    };
  }

  async confirm(
    context: RequestContext,
    rawInput: ConfirmXeroMutationInput,
    expectation?: XeroMutationConfirmationExpectation,
  ): Promise<XeroMutationRequest> {
    if (!this.#allowLegacyForTests) {
      throw new AppError(
        "ACTION_UNSUPPORTED",
        "Per-transaction confirmation phrases are disabled; use standing autonomous authorisation.",
        { httpStatus: 403, details: { providerMutationPossible: false } },
      );
    }
    const input = parseStrict(confirmXeroMutationSchema, rawInput, "Mutation confirmation");
    const binding = await this.#resolveBinding(context);
    const preparation = await this.repository.getXeroMutationPreparation(input.preparationId);
    if (!preparation || !this.#sameBinding(preparation, binding)) {
      throw new AppError("APPROVAL_INVALID", "Mutation confirmation does not match the prepared payload.", {
        httpStatus: 409,
      });
    }
    if (
      expectation &&
      (preparation.objectType !== expectation.objectType || preparation.operation !== expectation.operation)
    ) {
      throw new AppError("APPROVAL_INVALID", "Mutation confirmation is for a different Xero object or operation.", {
        httpStatus: 409,
      });
    }
    ensureAllowedOperation(preparation.objectType, preparation.operation);
    const result = await this.repository.confirmXeroMutationPreparation({
      ...binding,
      mutationRequestId: xeroMutationRequestIdForPreparation(input.preparationId),
      preparationId: input.preparationId,
      requestId: input.requestId,
      objectType: preparation.objectType,
      operation: preparation.operation,
      ...(preparation.targetXeroObjectId
        ? { targetXeroObjectId: preparation.targetXeroObjectId }
        : {}),
      canonicalPayload: preparation.canonicalPayload,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummaryHash: preparation.confirmationSummaryHash,
      confirmationPhraseHash: this.#hashConfirmationPhrase(input.preparationId, input.confirmationPhrase),
      authorizationReceipt: canonicalJsonRecord({
        receiptType: "LEGACY_EXPLICIT_CONFIRMATION_AUTHORITY",
        preparationId: preparation.preparationId,
        canonicalPayloadHash: preparation.canonicalPayloadHash,
        sourceRevisionHash: hashObject({
          sourceRef: preparation.sourceRef,
          sourceUnitKey: preparation.sourceUnitKey,
          sourceSha256: preparation.sourceSha256,
        }),
        issuedAt: this.#currentTime().toISOString(),
      }, "Legacy mutation authority receipt", MAX_CONFIRMATION_DETAILS_BYTES),
      now: this.#currentTime(),
    });
    if (!result) {
      throw new AppError("APPROVAL_INVALID", "Mutation confirmation is invalid, expired, or already consumed.", {
        httpStatus: 409,
      });
    }
    return result.request;
  }

  /**
   * Loads the server-owned proposal for provider-specific deterministic
   * validation. No authority is issued and no provider write slot is claimed.
   */
  async loadAutonomousPreparation(
    context: RequestContext,
    rawInput: AuthoriseAutonomousXeroMutationInput,
    expectation: XeroMutationConfirmationExpectation,
  ): Promise<XeroMutationPreparation> {
    const input = parseStrict(
      authoriseAutonomousXeroMutationSchema,
      rawInput,
      "Autonomous mutation validation load",
    );
    const oauth = requireOAuthBoundRequestContext(context);
    if (
      !oauth.targetSessionId ||
      !oauth.targetSessionHash ||
      !(oauth.targetSessionExpiresAt instanceof Date)
    ) {
      throw xeroCapabilityDenied(
        "Autonomous Xero writes require a pinned ledger target session.",
        ["TARGET_SESSION_REQUIRED"],
      );
    }
    const binding = await this.#resolveBinding(context);
    const preparation = await this.repository.getXeroMutationPreparation(input.preparationId);
    const recoveryRequest = preparation
      ? await this.repository.getXeroMutationRequest(
          xeroMutationRequestIdForPreparation(preparation.preparationId),
        )
      : undefined;
    const renewedTargetRecovery = Boolean(
      preparation && recoveryRequest &&
      recoveryRequest.preparationId === preparation.preparationId &&
      recoveryRequest.requestId === input.requestId &&
      this.#sameStableBinding(preparation, binding) &&
      this.#sameStableBinding(recoveryRequest, binding) &&
      ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED"]
        .includes(recoveryRequest.state),
    );
    if (!preparation || (!this.#sameBinding(preparation, binding) && !renewedTargetRecovery)) {
      throw new AppError("APPROVAL_INVALID", "Mutation authorisation does not match the prepared payload.", {
        httpStatus: 409,
      });
    }
    if (
      preparation.objectType !== expectation.objectType ||
      preparation.operation !== expectation.operation
    ) {
      throw new AppError("APPROVAL_INVALID", "Mutation authorisation is for a different Xero object or operation.", {
        httpStatus: 409,
      });
    }
    if (preparation.expiresAt <= this.#currentTime() && !renewedTargetRecovery) {
      throw new AppError("APPROVAL_INVALID", "Mutation preparation has expired.", { httpStatus: 409 });
    }
    return preparation;
  }

  /**
   * Returns only an already-existing readback/recovery claim. It can never
   * create a mutation request or issue a provider-write permit, which lets
   * object services bypass duplicate/staleness checks that are valid before a
   * create but would incorrectly block read-only reconciliation afterwards.
   */
  async resumeAutonomousRecovery(
    context: RequestContext,
    rawInput: AuthoriseAutonomousXeroMutationInput,
    expectation: XeroMutationConfirmationExpectation,
  ): Promise<AutonomousXeroMutationRecoveryClaim | undefined> {
    const input = parseStrict(
      authoriseAutonomousXeroMutationSchema,
      rawInput,
      "Autonomous mutation recovery",
    );
    const binding = await this.#resolveBinding(context);
    const preparation = await this.repository.getXeroMutationPreparation(input.preparationId);
    if (!preparation ||
        preparation.objectType !== expectation.objectType ||
        preparation.operation !== expectation.operation) return undefined;
    const request = await this.repository.getXeroMutationRequest(
      xeroMutationRequestIdForPreparation(preparation.preparationId),
    );
    if (!request ||
        request.preparationId !== preparation.preparationId ||
        request.requestId !== input.requestId ||
        request.canonicalPayloadHash !== preparation.canonicalPayloadHash ||
        !["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED"]
          .includes(request.state)) return undefined;
    const accessMatches = this.#sameBinding(preparation, binding) && this.#sameBinding(request, binding) ||
      this.#sameStableBinding(preparation, binding) && this.#sameStableBinding(request, binding);
    if (!accessMatches) {
      throw new AppError("NOT_FOUND", "Mutation recovery is unavailable for this OAuth binding.", {
        httpStatus: 404,
      });
    }
    if (request.state === "READBACK_VERIFIED") {
      return { preparation, claim: { request, mode: "ALREADY_VERIFIED" } };
    }
    if (request.state === "WRITE_UNCERTAIN" && !request.xeroObjectId) {
      // A legacy invoice posting may already hold the exact Provider ID even
      // when the newer mutation projection lost its own evidence callback.
      // That is read-only reconciliation, never a native create replay.
      const legacyDocumentType = request.objectType === "SUPPLIER_BILL"
        ? "ACCPAY" as const
        : request.objectType === "SALES_INVOICE"
          ? "ACCREC" as const
          : undefined;
      if (legacyDocumentType) {
        const legacyPosting = await this.repository.findActivePostingDuplicate({
          tenantId: request.tenantId,
          sourceSha256: request.sourceSha256,
          documentType: legacyDocumentType,
        });
        if (legacyPosting?.xeroInvoiceId) {
          return { preparation, claim: { request, mode: "RECOVER_ONLY" } };
        }
      }
      const exactTargetBinding = this.#sameBinding(preparation, binding) && this.#sameBinding(request, binding);
      // A renewed target session can inspect/reconcile a previous write, but
      // cannot receive the one-shot native replay permit from the old target.
      if (!exactTargetBinding) {
        return { preparation, claim: { request, mode: "RECOVER_ONLY" } };
      }
      const actionId = xeroAutonomousActionForMutation(request.objectType, request.operation);
      if (!actionId) {
        throw new AppError("CONFLICT", "Native idempotency recovery has no released action binding.", {
          httpStatus: 409,
        });
      }
      if (request.nativeRecoveryClaim !== undefined || request.writeReceipt) {
        throw new AppError("CONFLICT", "Native idempotency recovery was already claimed or has ambiguous evidence.", {
          httpStatus: 409,
          details: { reasonCode: "RECOVERY_REPLAY_ALREADY_CONSUMED" },
        });
      }
      return {
        preparation,
        claim: await this.#claimNativeIdempotencyRecovery(context, request, binding, actionId),
      };
    }
    return { preparation, claim: { request, mode: "RECOVER_ONLY" } };
  }

  /**
   * Claims the only safe provider replay: the original Xero idempotency key is
   * retained, the claim is durable/CAS-protected, and a fresh one-shot permit
   * is issued only for the exact original OAuth binding, target and payload.
   */
  async #claimNativeIdempotencyRecovery(
    context: RequestContext,
    request: XeroMutationRequest,
    binding: XeroMutationBindingIdentity,
    actionId: XeroAutonomousWriteAction,
  ): Promise<Extract<AutonomousXeroMutationClaim, { mode: "CALL_PROVIDER" }>> {
    const now = this.#currentTime();
    const unknownAt = request.writeUnknownAt;
    const firstAttemptAt = request.writeStartedAt;
    const authorityReceipt = request.authorizationReceipt;
    const adapterOperation = PROVIDER_ADAPTER_OPERATION_BY_ACTION[actionId];
    const expectedAgentId = typeof authorityReceipt.agentId === "string" ? authorityReceipt.agentId : undefined;
    const receiptAuthorityRevision = authorityReceipt.authoritySnapshotRevision;
    const receiptAuthorityHash = authorityReceipt.authoritySnapshotHash;
    if (
      !unknownAt ||
      !firstAttemptAt ||
      now.getTime() - firstAttemptAt.getTime() >= XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS ||
      now < firstAttemptAt ||
      !request.targetSessionId ||
      !(context.targetSessionExpiresAt instanceof Date) ||
      context.targetSessionExpiresAt <= now ||
      !expectedAgentId ||
      expectedAgentId !== context.agentId ||
      authorityReceipt.actionId !== actionId ||
      authorityReceipt.providerId !== "xero" ||
      authorityReceipt.tenantId !== binding.tenantId ||
      authorityReceipt.actorId !== binding.actorId ||
      authorityReceipt.workspaceId !== binding.workspaceId ||
      authorityReceipt.installationId !== binding.installationId ||
      authorityReceipt.bindingId !== binding.bindingId ||
      authorityReceipt.bindingRevision !== binding.bindingRevision ||
      authorityReceipt.connectionId !== binding.connectionId ||
      authorityReceipt.targetSessionId !== binding.targetSessionId ||
      authorityReceipt.canonicalPayloadHash !== request.canonicalPayloadHash ||
      !Number.isSafeInteger(receiptAuthorityRevision) ||
      typeof receiptAuthorityHash !== "string"
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Native idempotency recovery binding or window is invalid.", {
        httpStatus: 409,
        retryable: false,
        details: { reasonCode: "RECOVERY_AUTHORITY_OR_WINDOW_INVALID" },
      });
    }
    const recoveryFirstAttemptAt = firstAttemptAt;
    const recoveryTargetSessionId = request.targetSessionId;
    const recoveryTargetSessionExpiresAt = context.targetSessionExpiresAt;
    const recoveryAgentId = expectedAgentId;
    const recoveryAuthorityRevision = receiptAuthorityRevision as number;
    const recoveryAuthorityHash = receiptAuthorityHash as string;
    if (
      !recoveryFirstAttemptAt || !recoveryTargetSessionId || !recoveryAgentId ||
      !(recoveryTargetSessionExpiresAt instanceof Date)
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Native idempotency recovery binding is incomplete.", {
        httpStatus: 409,
        retryable: false,
      });
    }
    if (!this.#providerCapabilityEvaluator) {
      throw new AppError("CONFIGURATION_ERROR", "Native idempotency recovery requires current Provider capability evidence.", {
        httpStatus: 503,
      });
    }
    const oauth = requireOAuthBoundRequestContext(context);
    if (!oauth.targetSessionId || !(oauth.targetSessionExpiresAt instanceof Date)) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Native idempotency recovery target session is unavailable.", {
        httpStatus: 409,
        retryable: false,
      });
    }
    const [providerCapability, actionPolicy] = await Promise.all([
      this.#providerCapabilityEvaluator.evaluate(context, actionId),
      Promise.resolve(lookupAgentFacingXeroCapabilityDecision(actionId)),
    ]);
    const denyReasons = this.#currentWriteGateDenyReasons(
      oauth,
      actionPolicy.knownAction && actionPolicy.policyAllowsExecution,
      providerCapability.denyReasons,
      providerCapability.receiptHash,
      now,
    );
    if (denyReasons.length > 0) {
      throw xeroCapabilityDenied(
        "The current OAuth-bound write gate is not effective for native idempotency recovery.",
        denyReasons,
        { providerAccessDenyReasons: providerCapability.denyReasons },
      );
    }
    const claim: XeroNativeIdempotencyRecoveryClaim = {
      receiptType: "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM",
      claimId: `xrc_${randomUUID().replaceAll("-", "")}`,
      mutationRequestId: request.mutationRequestId,
      canonicalPayloadHash: request.canonicalPayloadHash,
      actionId,
      adapterOperation,
      tenantId: binding.tenantId,
      actorId: binding.actorId,
      workspaceId: binding.workspaceId,
      agentId: recoveryAgentId,
      installationId: binding.installationId,
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision ?? -1,
      connectionId: binding.connectionId,
      targetSessionId: recoveryTargetSessionId,
      authoritySnapshotRevision: recoveryAuthorityRevision,
      authoritySnapshotHash: recoveryAuthorityHash,
      claimedAt: now.toISOString(),
      expiresAt: new Date(recoveryFirstAttemptAt.getTime() + XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS).toISOString(),
    };
    const claimed = await this.repository.markXeroMutationWriteUnknown({
      ...this.#boundRequestInput(binding, request),
      nativeRecoveryClaim: claim,
      now,
    } as Parameters<AccountingRepository["markXeroMutationWriteUnknown"]>[0]);
    return {
      request: claimed,
      mode: "CALL_PROVIDER",
      providerWritePermit: issueXeroProviderWriteRecoveryPermit({
        adapterOperation,
        request: claimed,
      }),
    };
  }

  /** Read-only whole-case capability preflight. This is not user approval or
   * standing authority; every operation repeats the same current OAuth target,
   * release gate, action-policy and Provider-capability checks before claim. */
  async preflightAutonomousActions(
    context: RequestContext,
    actionIds: readonly XeroAutonomousWriteAction[],
  ): Promise<AutonomousActionsPreflightReceipt> {
    const oauth = requireOAuthBoundRequestContext(context);
    if (!oauth.targetSessionId || !(oauth.targetSessionExpiresAt instanceof Date)) {
      throw xeroCapabilityDenied(
        "Autonomous Xero writes require a pinned ledger target session.",
        ["TARGET_SESSION_REQUIRED"],
      );
    }
    if (!this.#providerCapabilityEvaluator) {
      throw new AppError(
        "CONFIGURATION_ERROR",
        "Autonomous Xero writes require the central runtime capability evaluator.",
        { httpStatus: 503 },
      );
    }
    const providerCapabilityEvaluator = this.#providerCapabilityEvaluator;
    const binding = await this.#resolveBinding(context);
    const checks: AutonomousActionsPreflightReceipt["checks"] = [];
    const capabilityChecks = await Promise.all([...new Set(actionIds)].sort().map(async (actionId) => {
      const [providerCapability, actionPolicy] = await Promise.all([
        providerCapabilityEvaluator.evaluate(context, actionId),
        Promise.resolve(lookupAgentFacingXeroCapabilityDecision(actionId)),
      ]);
      return { actionId, providerCapability, actionPolicy };
    }));
    const now = this.#currentTime();
    for (const { actionId, providerCapability, actionPolicy } of capabilityChecks) {
      const denyReasons = this.#currentWriteGateDenyReasons(
        oauth,
        actionPolicy.knownAction && actionPolicy.policyAllowsExecution,
        providerCapability.denyReasons,
        providerCapability.receiptHash,
        now,
      );
      if (denyReasons.length > 0) {
        throw xeroCapabilityDenied(
          "The current Xero write gate is not effective for the full Accounting Case.",
          denyReasons,
          { providerAccessDenyReasons: providerCapability.denyReasons },
        );
      }
      checks.push({
        actionId,
        providerCapabilityReceiptHash: providerCapability.receiptHash,
        writeGateReceiptHash: hashObject({
          receiptType: "XERO_CASE_WRITE_PREFLIGHT_CHECK",
          actionId,
          tenantId: binding.tenantId,
          targetSessionId: oauth.targetSessionId,
          bindingRevision: oauth.bindingRevision,
          providerCapabilityReceiptHash: providerCapability.receiptHash,
          checkedAt: now.toISOString(),
        }),
      });
    }
    const unsigned = {
      receiptType: "XERO_AUTONOMOUS_ACTIONS_PREFLIGHT" as const,
      tenantId: binding.tenantId,
      targetSessionId: oauth.targetSessionId,
      bindingRevision: oauth.bindingRevision,
      checkedAt: now.toISOString(),
      checks,
    };
    return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
  }

  /** Atomically consumes a deterministically validated immutable preparation
   * and claims the one-shot Provider-write slot under the current OAuth-bound
   * target and process write gate. The Agent supplies no authority material. */
  async authoriseAutonomous(
    context: RequestContext,
    rawInput: AuthoriseAutonomousXeroMutationInput,
    expectation: XeroMutationConfirmationExpectation,
    rawValidationReceipt: DeterministicValidationReceipt,
    beforeProviderClaimValidation?: () => Promise<void>,
    _sealedFirmGovernanceExpectation?: XeroFirmGovernanceExpectation,
  ): Promise<AutonomousXeroMutationClaim> {
    const input = parseStrict(
      authoriseAutonomousXeroMutationSchema,
      rawInput,
      "Autonomous mutation authorisation",
    );
    const oauth = requireOAuthBoundRequestContext(context);
    if (!oauth.targetSessionId || !(oauth.targetSessionExpiresAt instanceof Date)) {
      throw xeroCapabilityDenied(
        "Autonomous Xero writes require a pinned ledger target session.",
        ["TARGET_SESSION_REQUIRED"],
      );
    }
    const binding = await this.#resolveBinding(context);
    const preparation = await this.loadAutonomousPreparation(context, input, expectation);
    const actionId = xeroAutonomousActionForMutation(preparation.objectType, preparation.operation);
    if (!actionId) {
      throw xeroCapabilityDenied(
        "This Xero mutation has no released autonomous action.",
        ["STATIC_ACTION_NOT_RELEASED"],
      );
    }
    if (!this.#sameBinding(preparation, binding)) {
      const recoveryRequest = await this.repository.getXeroMutationRequest(
        xeroMutationRequestIdForPreparation(preparation.preparationId),
      );
      if (
        !recoveryRequest ||
        recoveryRequest.preparationId !== preparation.preparationId ||
        recoveryRequest.requestId !== input.requestId ||
        recoveryRequest.canonicalPayloadHash !== preparation.canonicalPayloadHash ||
        !this.#sameStableBinding(preparation, binding) ||
        !this.#sameStableBinding(recoveryRequest, binding) ||
        !["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED"]
          .includes(recoveryRequest.state)
      ) {
        throw new AppError("APPROVAL_INVALID", "Renewed target access is not eligible for read-only recovery.", {
          httpStatus: 409,
        });
      }
      return recoveryRequest.state === "READBACK_VERIFIED"
        ? { request: recoveryRequest, mode: "ALREADY_VERIFIED" }
        : { request: recoveryRequest, mode: "RECOVER_ONLY" };
    }
    const actionPolicy = lookupAgentFacingXeroCapabilityDecision(actionId);
    if (!this.#providerCapabilityEvaluator) {
      throw new AppError(
        "CONFIGURATION_ERROR",
        "Autonomous Xero writes require the central runtime capability evaluator.",
        { httpStatus: 503 },
      );
    }
    const providerCapability = await this.#providerCapabilityEvaluator.evaluate(context, actionId);
    const sourceRevisionHash = objectPreparationSourceRevisionHash(preparation);
    const validationReceipt = verifyDeterministicValidationReceipt(rawValidationReceipt, {
      actionId,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      sourceRevisionHash,
    });
    if (!validationReceipt) {
      throw xeroCapabilityDenied(
        "The deterministic validation receipt is missing, stale, or does not bind this proposal.",
        ["DETERMINISTIC_VALIDATION_FAILED"],
      );
    }
    const now = this.#currentTime();
    const denyReasons = this.#currentWriteGateDenyReasons(
      oauth,
      actionPolicy.knownAction && actionPolicy.policyAllowsExecution,
      providerCapability.denyReasons,
      providerCapability.receiptHash,
      now,
    );
    if (denyReasons.length > 0) {
      throw xeroCapabilityDenied(
        "The current OAuth-bound Xero write gate is not effective.",
        denyReasons,
        {
          providerAccessDenyReasons: providerCapability.denyReasons,
        },
      );
    }
    // Provider-specific, server-owned facts that can drift (for example a
    // tenant COA semantic binding) must be checked after the complete object
    // validation and immediately before the durable WRITE_IN_FLIGHT claim.
    // A failure here creates neither a mutation request nor a provider permit.
    await beforeProviderClaimValidation?.();
    const authorizationReceipt = this.#currentWriteAuthorizationReceipt({
      actionId,
      preparation,
      oauth,
      targetSessionId: oauth.targetSessionId,
      validationReceipt,
      providerCapabilityReceiptHash: providerCapability.receiptHash,
      issuedAt: now,
    });
    const result = await this.repository.confirmXeroMutationPreparation({
      ...binding,
      mutationRequestId: xeroMutationRequestIdForPreparation(input.preparationId),
      preparationId: input.preparationId,
      requestId: input.requestId,
      objectType: preparation.objectType,
      operation: preparation.operation,
      ...(preparation.targetXeroObjectId ? { targetXeroObjectId: preparation.targetXeroObjectId } : {}),
      canonicalPayload: preparation.canonicalPayload,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummaryHash: preparation.confirmationSummaryHash,
      // This is a server-owned storage compatibility hash. It is never exposed
      // to or supplied by the Agent on the autonomous path.
      confirmationPhraseHash: preparation.confirmationPhraseHash,
      authorizationReceipt: canonicalJsonRecord(
        authorizationReceipt as unknown as Record<string, unknown>,
        "OAuth-bound mutation write receipt",
        MAX_CONFIRMATION_DETAILS_BYTES,
      ),
      successfulValidationReceipt: canonicalJsonRecord(
        validationReceipt as unknown as Record<string, unknown>,
        "Deterministic validation receipt",
        MAX_CONFIRMATION_DETAILS_BYTES,
      ),
      claimForWrite: true,
      now,
    });
    if (!result) {
      throw new AppError("APPROVAL_INVALID", "Mutation authorisation is stale, expired, or already consumed.", {
        httpStatus: 409,
      });
    }
    const request = result.request;
    if (!result.created && request.state !== "READBACK_VERIFIED") {
      const current = authorizationReceipt;
      const existing = request.authorizationReceipt;
      const stableClaims = [
        "receiptType", "kernelVersion", "actionId", "providerId", "tenantId",
        "actorId", "workspaceId", "agentId", "installationId", "bindingId",
        "bindingRevision", "connectionId", "targetSessionId", "delegationId",
        "delegationRevision", "canonicalPayloadHash", "sourceRevisionHash",
        "caseVersion", "deterministicValidationReceiptHash", "providerCapabilityReceiptHash",
        "authoritySnapshotRevision", "authoritySnapshotHash",
        "firmGovernanceClaim",
      ] as const;
      if (stableClaims.some((key) => stableStringify(existing[key]) !== stableStringify(current[key]))) {
        throw new AppError(
          "APPROVAL_INVALID",
          "The existing operation was claimed under a different OAuth target or sealed payload.",
          { httpStatus: 409 },
        );
      }
    }
    if (request.state === "READBACK_VERIFIED") return { request, mode: "ALREADY_VERIFIED" };
    if (["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(request.state)) {
      if (!result.created) return { request, mode: "RECOVER_ONLY" };
      if (request.state !== "WRITE_IN_FLIGHT") {
        throw new AppError(
          "APPROVAL_INVALID",
          "A newly claimed autonomous mutation did not enter the provider-write state.",
          { httpStatus: 409 },
        );
      }
      return {
        request,
        mode: "CALL_PROVIDER",
        providerWritePermit: issueXeroProviderWritePermit({
          adapterOperation: PROVIDER_ADAPTER_OPERATION_BY_ACTION[actionId],
          request,
        }),
      };
    }
    throw new AppError(
      "APPROVAL_INVALID",
      `Autonomous mutation cannot execute from ${request.state}.`,
      { httpStatus: 409 },
    );
  }

  async start(context: RequestContext, rawInput: StartXeroMutationInput) {
    const input = parseStrict(startXeroMutationSchema, rawInput, "Mutation start");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
    if (
      request.authorizationReceipt.receiptType !== "LEDGER_AUTONOMOUS_AUTHORIZATION" &&
      !this.#allowLegacyForTests
    ) {
      throw new AppError(
        "ACTION_UNSUPPORTED",
        "Legacy mutation authority cannot start a provider write.",
        { httpStatus: 403, details: { providerMutationPossible: false } },
      );
    }
    return this.repository.beginXeroMutationWrite({
      ...this.#boundRequestInput(binding, request),
      now: this.#currentTime(),
    });
  }

  async markUnknown(context: RequestContext, rawInput: MarkXeroMutationUnknownInput): Promise<XeroMutationRequest> {
    const input = parseStrict(markXeroMutationUnknownSchema, rawInput, "Unknown mutation result");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId, true);
    const writeReceipt = input.writeReceipt
      ? canonicalJsonRecord(input.writeReceipt, "Mutation write receipt", MAX_CONFIRMATION_DETAILS_BYTES)
      : undefined;
    return this.repository.markXeroMutationWriteUnknown({
      ...this.#boundRequestInput(binding, request),
      ...(input.xeroObjectId ? { xeroObjectId: input.xeroObjectId } : {}),
      ...(writeReceipt ? { writeReceipt } : {}),
      now: this.#currentTime(),
    });
  }

  async recordWriteEvidence(
    context: RequestContext,
    rawInput: RecordXeroMutationWriteEvidenceInput,
  ): Promise<XeroMutationRequest> {
    const input = parseStrict(
      recordXeroMutationWriteEvidenceSchema,
      rawInput,
      "Mutation write evidence",
    );
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
    const repositoryInput: RepositoryWriteEvidenceInput = {
      ...this.#boundRequestInput(binding, request),
      xeroObjectId: input.xeroObjectId,
      writeReceipt: canonicalJsonRecord(
        input.writeReceipt,
        "Mutation write receipt",
        MAX_CONFIRMATION_DETAILS_BYTES,
      ),
      now: this.#currentTime(),
    };
    return this.repository.recordXeroMutationWriteEvidence(repositoryInput);
  }

  async markReadbackVerified(
    context: RequestContext,
    rawInput: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRequest> {
    const completion = await this.#readbackCompletion(context, rawInput);
    if (
      completion.repositoryInput.readbackPayloadHash !== completion.request.canonicalPayloadHash ||
      completion.repositoryInput.readbackStatus !== expectedXeroMutationReadbackStatus(
        completion.request.objectType,
        completion.request.operation,
      )
    ) {
      await this.repository.markXeroMutationReadbackMismatch(completion.repositoryInput);
      throw new AppError("READBACK_MISMATCH", "Xero readback does not match the confirmed mutation payload.", {
        httpStatus: 409,
      });
    }
    return this.repository.markXeroMutationReadbackVerified(completion.repositoryInput);
  }

  async recover(
    context: RequestContext,
    rawInput: CompleteXeroMutationReadbackInput,
  ): Promise<XeroMutationRecoveryResult> {
    const completion = await this.#readbackCompletion(context, rawInput);
    if (
      completion.repositoryInput.readbackPayloadHash === completion.request.canonicalPayloadHash &&
      completion.repositoryInput.readbackStatus === expectedXeroMutationReadbackStatus(
        completion.request.objectType,
        completion.request.operation,
      )
    ) {
      return {
        outcome: "READBACK_VERIFIED",
        request: await this.repository.markXeroMutationReadbackVerified(completion.repositoryInput),
      };
    }
    return {
      outcome: "READBACK_MISMATCH",
      request: await this.repository.markXeroMutationReadbackMismatch(completion.repositoryInput),
    };
  }

  async failValidation(
    context: RequestContext,
    rawInput: FailXeroMutationValidationInput,
  ): Promise<XeroMutationRequest> {
    const input = parseStrict(failXeroMutationValidationSchema, rawInput, "Mutation validation failure");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
    const validationReceipt = input.validationReceipt
      ? canonicalJsonRecord(input.validationReceipt, "Mutation validation receipt", MAX_CONFIRMATION_DETAILS_BYTES)
      : undefined;
    return this.repository.failXeroMutationValidation({
      ...this.#boundRequestInput(binding, request),
      ...(validationReceipt ? { validationReceipt } : {}),
      now: this.#currentTime(),
    });
  }

  async rejectProvider(
    context: RequestContext,
    rawInput: RejectXeroMutationProviderInput,
  ): Promise<XeroMutationRequest> {
    const input = parseStrict(rejectXeroMutationProviderSchema, rawInput, "Provider mutation rejection");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
    const providerRejectionReceipt = canonicalJsonRecord(
      input.providerRejectionReceipt,
      "Provider rejection receipt",
      MAX_CONFIRMATION_DETAILS_BYTES,
    );
    const repositoryInput: RepositoryProviderRejectionInput = {
      ...this.#boundRequestInput(binding, request),
      providerRejectionReceipt,
      now: this.#currentTime(),
    };
    return this.repository.rejectXeroMutationProvider(repositoryInput);
  }

  async #readbackCompletion(
    context: RequestContext,
    rawInput: CompleteXeroMutationReadbackInput,
  ): Promise<{ request: XeroMutationRequest; repositoryInput: RepositoryReadbackInput }> {
    const input = parseStrict(completeXeroMutationReadbackSchema, rawInput, "Mutation readback");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId, true);
    const readbackCanonicalPayload = canonicalJsonRecord(
      input.verifiedReadback.canonicalPayload,
      "Canonical Xero readback payload",
      MAX_CANONICAL_PAYLOAD_BYTES,
    );
    const evidence = input.verifiedReadback.evidence
      ? canonicalJsonRecord(
          input.verifiedReadback.evidence,
          "Xero readback evidence",
          MAX_CANONICAL_PAYLOAD_BYTES,
        )
      : undefined;
    const readbackSnapshot = canonicalJsonRecord({
      xeroObjectId: input.verifiedReadback.xeroObjectId,
      status: input.verifiedReadback.status,
      canonicalPayload: readbackCanonicalPayload,
      ...(input.verifiedReadback.serverCoaExecutionConstraints
        ? {
            serverCoaExecutionConstraints: canonicalJsonRecord(
              input.verifiedReadback.serverCoaExecutionConstraints,
              "Server-owned COA readback constraints",
              MAX_CANONICAL_PAYLOAD_BYTES,
            ),
          }
        : {}),
      ...(evidence ? { evidence } : {}),
    }, "Verified Xero readback", MAX_CANONICAL_PAYLOAD_BYTES);
    return {
      request,
      repositoryInput: {
        ...this.#boundRequestInput(binding, request),
        xeroObjectId: input.verifiedReadback.xeroObjectId,
        writeReceipt: canonicalJsonRecord(input.writeReceipt, "Mutation write receipt", MAX_CONFIRMATION_DETAILS_BYTES),
        readbackSnapshot,
        readbackSnapshotHash: hashObject(readbackSnapshot),
        readbackCanonicalPayload,
        readbackPayloadHash: hashObject(readbackCanonicalPayload),
        readbackStatus: input.verifiedReadback.status,
        now: this.#currentTime(),
      },
    };
  }

  async #boundRequest(
    context: RequestContext,
    mutationRequestId: string,
    allowRenewedTargetRecovery = false,
  ): Promise<{ binding: XeroMutationBindingIdentity; request: XeroMutationRequest }> {
    const binding = await this.#resolveBinding(context);
    const request = await this.repository.getXeroMutationRequest(mutationRequestId);
    if (!request) {
      throw new AppError("NOT_FOUND", "Mutation request is unavailable for this OAuth binding.", {
        httpStatus: 404,
      });
    }
    if (this.#sameBinding(request, binding)) return { binding, request };
    if (
      allowRenewedTargetRecovery &&
      this.#sameStableBinding(request, binding) &&
      ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH", "READBACK_VERIFIED"]
        .includes(request.state)
    ) {
      // Repository mutation rows remain bound to the original immutable
      // target receipt. The current live target only authorises the GET-only
      // recovery access, so persistence receives the original binding tuple.
      return { binding: this.#requestBinding(request), request };
    }
    throw new AppError("NOT_FOUND", "Mutation request is unavailable for this OAuth binding.", {
      httpStatus: 404,
    });
  }

  #requestBinding(request: XeroMutationRequest): XeroMutationBindingIdentity {
    return {
      actorId: request.actorId,
      workspaceId: request.workspaceId,
      tenantId: request.tenantId,
      installationId: request.installationId,
      bindingId: request.bindingId,
      connectionId: request.connectionId,
      ...(request.bindingRevision !== undefined ? { bindingRevision: request.bindingRevision } : {}),
      ...(request.targetSessionId ? { targetSessionId: request.targetSessionId } : {}),
    };
  }

  #boundRequestInput(
    binding: XeroMutationBindingIdentity,
    request: XeroMutationRequest,
  ): Omit<BoundXeroMutationRequestInput, "now"> {
    return {
      ...binding,
      mutationRequestId: request.mutationRequestId,
      objectType: request.objectType,
      operation: request.operation,
      ...(request.targetXeroObjectId ? { targetXeroObjectId: request.targetXeroObjectId } : {}),
      canonicalPayloadHash: request.canonicalPayloadHash,
      ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}),
      sourceUnitKey: request.sourceUnitKey,
      sourceSha256: request.sourceSha256,
      sourceEvidenceType: request.sourceEvidenceType,
    };
  }

  async #resolveBinding(context: RequestContext): Promise<XeroMutationBindingIdentity> {
    if (context.legacyDemo) {
      const binding = this.#legacyBinding;
      if (!this.#allowLegacyForTests || !binding || context.actorId !== binding.actorId) {
        throw new AppError("FORBIDDEN", "Xero mutations require an OAuth-bound connection.", { httpStatus: 403 });
      }
      return { ...binding };
    }
    const oauth = requireOAuthBoundRequestContext(context);
    const targetSession = oauth.targetSessionHash
      ? await this.repository.resolveLedgerTargetSession({
          sessionHash: oauth.targetSessionHash,
          installationId: oauth.oauthInstallationId,
          workspaceId: oauth.workspaceId,
          subjectType: oauth.subjectType,
          subjectId: oauth.subjectId,
          agentId: oauth.agentId,
          now: this.#currentTime(),
        })
      : undefined;
    const resolved = oauth.targetSessionHash
      ? targetSession?.binding
      : await this.repository.resolveAgentConnectionBinding({
          installationId: oauth.oauthInstallationId,
          bindingId: oauth.bindingId,
          workspaceId: oauth.workspaceId,
          subjectType: oauth.subjectType,
          subjectId: oauth.subjectId,
          agentId: oauth.agentId,
          connectionId: oauth.connectionId,
        });
    if (!resolved) {
      throw new AppError("FORBIDDEN", "Xero mutation does not match an active OAuth tenant binding.", {
        httpStatus: 403,
      });
    }
    if (
      oauth.targetSessionHash &&
      (
        !targetSession ||
        targetSession.session.sessionId !== oauth.targetSessionId ||
        targetSession.session.bindingId !== oauth.bindingId ||
        targetSession.session.connectionId !== oauth.connectionId ||
        targetSession.session.bindingRevision !== oauth.bindingRevision
      )
    ) {
      throw new AppError("FORBIDDEN", "Xero mutation does not match the pinned ledger target session.", {
        httpStatus: 403,
      });
    }
    return {
      actorId: oauth.actorId,
      workspaceId: oauth.workspaceId,
      tenantId: resolved.tenantId,
      installationId: oauth.oauthInstallationId,
      bindingId: oauth.bindingId,
      connectionId: oauth.connectionId,
      bindingRevision: oauth.bindingRevision,
      ...(oauth.targetSessionId ? { targetSessionId: oauth.targetSessionId } : {}),
    };
  }

  #hashConfirmationSummary(
    binding: XeroMutationBindingIdentity,
    summary: XeroMutationConfirmationSummary,
  ): string {
    return hashObject({ binding, summary });
  }

  #sameBinding(
    record: XeroMutationBindingIdentity,
    binding: XeroMutationBindingIdentity,
  ): boolean {
    return record.actorId === binding.actorId &&
      record.workspaceId === binding.workspaceId &&
      record.tenantId === binding.tenantId &&
      record.installationId === binding.installationId &&
      record.bindingId === binding.bindingId &&
      record.connectionId === binding.connectionId &&
      record.bindingRevision === binding.bindingRevision &&
      record.targetSessionId === binding.targetSessionId;
  }

  #sameStableBinding(
    record: XeroMutationBindingIdentity,
    binding: XeroMutationBindingIdentity,
  ): boolean {
    return record.actorId === binding.actorId &&
      record.workspaceId === binding.workspaceId &&
      record.tenantId === binding.tenantId &&
      record.installationId === binding.installationId &&
      record.bindingId === binding.bindingId &&
      record.connectionId === binding.connectionId &&
      record.bindingRevision === binding.bindingRevision;
  }

  #hashConfirmationPhrase(preparationId: string, confirmationPhrase: string): string {
    return createHmac("sha256", this.#confirmationSecret)
      .update(`xero-mutation-confirmation:v1:${preparationId}:${confirmationPhrase}`, "utf8")
      .digest("hex");
  }

  #currentWriteGateDenyReasons(
    oauth: OAuthBoundRequestContext,
    actionReleased: boolean,
    providerAccessDenyReasons: readonly string[],
    providerCapabilityReceiptHash: string,
    now: Date,
  ): string[] {
    const denyReasons: string[] = [];
    if (!this.#writeEnabled) denyReasons.push("WRITE_KILL_SWITCH_DISABLED");
    if (!actionReleased) denyReasons.push("STATIC_ACTION_NOT_RELEASED");
    if (!oauth.scopes.includes("xero.draft.write")) denyReasons.push("TRANSPORT_SCOPE_MISSING");
    if (
      !oauth.targetSessionId ||
      !oauth.targetSessionHash ||
      !(oauth.targetSessionExpiresAt instanceof Date)
    ) {
      denyReasons.push("TARGET_SESSION_REQUIRED");
    } else if (oauth.targetSessionExpiresAt <= now) {
      denyReasons.push("TARGET_SESSION_EXPIRED");
    }
    if (providerAccessDenyReasons.length > 0) denyReasons.push(...providerAccessDenyReasons);
    if (!/^[a-f0-9]{64}$/u.test(providerCapabilityReceiptHash)) {
      denyReasons.push("PROVIDER_CAPABILITY_RECEIPT_MISSING");
    }
    return [...new Set(denyReasons)];
  }

  #currentWriteAuthorizationReceipt(input: {
    actionId: XeroAutonomousWriteAction;
    preparation: XeroMutationPreparation;
    oauth: OAuthBoundRequestContext;
    targetSessionId: string;
    validationReceipt: DeterministicValidationReceipt;
    providerCapabilityReceiptHash: string;
    issuedAt: Date;
  }): LedgerAutonomousAuthorizationReceipt {
    const unsigned = {
      receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
      kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
      actionId: input.actionId,
      providerId: "xero",
      tenantId: input.preparation.tenantId,
      actorId: input.oauth.actorId,
      workspaceId: input.oauth.workspaceId,
      agentId: input.oauth.agentId,
      installationId: input.oauth.oauthInstallationId,
      bindingId: input.oauth.bindingId,
      bindingRevision: input.oauth.bindingRevision,
      connectionId: input.oauth.connectionId,
      targetSessionId: input.targetSessionId,
      // Compatibility-only fields retained in the persisted receipt format;
      // no Standing Delegation or authority snapshot is resolved or consulted.
      delegationId: CURRENT_WRITE_GATE_DELEGATION_ID,
      delegationRevision: CURRENT_WRITE_GATE_REVISION,
      canonicalPayloadHash: input.preparation.canonicalPayloadHash,
      sourceRevisionHash: objectPreparationSourceRevisionHash(input.preparation),
      caseVersion: input.validationReceipt.caseVersion,
      authoritySnapshotRevision: CURRENT_WRITE_GATE_REVISION,
      authoritySnapshotHash: CURRENT_WRITE_GATE_COMPATIBILITY_HASH,
      deterministicValidationReceiptHash: input.validationReceipt.receiptHash,
      providerCapabilityReceiptHash: input.providerCapabilityReceiptHash,
      issuedAt: input.issuedAt.toISOString(),
    };
    return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
  }

  #currentTime(): Date {
    const now = this.#now();
    if (!nowIsValid(now)) throw new AppError("CONFIGURATION_ERROR", "Xero mutation clock returned an invalid time.");
    return new Date(now);
  }
}
