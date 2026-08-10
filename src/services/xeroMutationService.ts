import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import {
  XERO_MUTATION_ALLOWED_OPERATIONS,
  XERO_MUTATION_EXPECTED_READBACK_STATUS,
  type BoundXeroMutationRequestInput,
  type CompleteXeroMutationReadbackInput as RepositoryReadbackInput,
  type RecordXeroMutationWriteEvidenceInput as RepositoryWriteEvidenceInput,
  type RejectXeroMutationProviderInput as RepositoryProviderRejectionInput,
  type XeroMutationBindingIdentity,
  type XeroMutationObjectType,
  type XeroMutationOperation,
  type XeroMutationRequest,
  type XeroMutationSourceEvidenceType,
} from "../domain/xeroMutation.js";
import {
  completeXeroMutationReadbackSchema,
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
  type RequestContext,
} from "../security/requestContext.js";
import { z } from "zod/v4";

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MIN_CONFIRMATION_TTL_MS = 30 * 1_000;
const MAX_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
const MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1_024;
const MAX_CONFIRMATION_DETAILS_BYTES = 16 * 1_024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 50_000;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
  confirmationTtlMs?: number;
  now?: () => Date;
  unsafeAllowLegacyContextForTests?: boolean;
  legacyBindingForTests?: XeroMutationBindingIdentity;
}

export interface XeroMutationRecoveryResult {
  outcome: "READBACK_VERIFIED" | "READBACK_MISMATCH";
  request: XeroMutationRequest;
}

export interface XeroMutationConfirmationExpectation {
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
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
      mutationRequestId: `xmr_${hashObject({ preparationId: input.preparationId }).slice(0, 32)}`,
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
      now: this.#currentTime(),
    });
    if (!result) {
      throw new AppError("APPROVAL_INVALID", "Mutation confirmation is invalid, expired, or already consumed.", {
        httpStatus: 409,
      });
    }
    return result.request;
  }

  async start(context: RequestContext, rawInput: StartXeroMutationInput) {
    const input = parseStrict(startXeroMutationSchema, rawInput, "Mutation start");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
    return this.repository.beginXeroMutationWrite({
      ...this.#boundRequestInput(binding, request),
      now: this.#currentTime(),
    });
  }

  async markUnknown(context: RequestContext, rawInput: MarkXeroMutationUnknownInput): Promise<XeroMutationRequest> {
    const input = parseStrict(markXeroMutationUnknownSchema, rawInput, "Unknown mutation result");
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
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
      completion.repositoryInput.readbackStatus !== XERO_MUTATION_EXPECTED_READBACK_STATUS[completion.request.objectType]
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
      completion.repositoryInput.readbackStatus === XERO_MUTATION_EXPECTED_READBACK_STATUS[completion.request.objectType]
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
    const { binding, request } = await this.#boundRequest(context, input.mutationRequestId);
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
  ): Promise<{ binding: XeroMutationBindingIdentity; request: XeroMutationRequest }> {
    const binding = await this.#resolveBinding(context);
    const request = await this.repository.getXeroMutationRequest(mutationRequestId);
    if (
      !request ||
      request.actorId !== binding.actorId ||
      request.workspaceId !== binding.workspaceId ||
      request.tenantId !== binding.tenantId ||
      request.installationId !== binding.installationId ||
      request.bindingId !== binding.bindingId ||
      request.connectionId !== binding.connectionId
    ) {
      throw new AppError("NOT_FOUND", "Mutation request is unavailable for this OAuth binding.", {
        httpStatus: 404,
      });
    }
    return { binding, request };
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
    const resolved = await this.repository.resolveAgentConnectionBinding({
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
    return {
      actorId: oauth.actorId,
      workspaceId: oauth.workspaceId,
      tenantId: resolved.tenantId,
      installationId: oauth.oauthInstallationId,
      bindingId: oauth.bindingId,
      connectionId: oauth.connectionId,
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
      record.connectionId === binding.connectionId;
  }

  #hashConfirmationPhrase(preparationId: string, confirmationPhrase: string): string {
    return createHmac("sha256", this.#confirmationSecret)
      .update(`xero-mutation-confirmation:v1:${preparationId}:${confirmationPhrase}`, "utf8")
      .digest("hex");
  }

  #currentTime(): Date {
    const now = this.#now();
    if (!nowIsValid(now)) throw new AppError("CONFIGURATION_ERROR", "Xero mutation clock returned an invalid time.");
    return new Date(now);
  }
}
