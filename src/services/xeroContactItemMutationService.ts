import { z } from "zod/v4";
import {
  parseCanonicalContactCreatePrimitive,
  parseCanonicalContactUpdatePrimitive,
  parseCanonicalItemCreatePrimitive,
  parseCanonicalItemUpdatePrimitive,
} from "../domain/xeroContactItemCanonical.js";
import {
  prepareContactCreateMutationSchema,
  prepareContactUpdateMutationSchema,
  prepareItemCreateMutationSchema,
  prepareItemUpdateMutationSchema,
  type PrepareContactCreateMutationInput,
  type PrepareContactUpdateMutationInput,
  type PrepareItemCreateMutationInput,
  type PrepareItemUpdateMutationInput,
} from "../domain/xeroContactItemMutationSchemas.js";
import {
  assertContactCurrentVersion,
  assertItemCurrentVersion,
  prepareContactCreate,
  prepareContactUpdate,
  prepareItemCreate,
  prepareItemUpdate,
  type ContactCreatePrimitive,
  type ContactUpdatePrimitive,
  type ItemCreatePrimitive,
  type ItemUpdatePrimitive,
  type NormalizedBusinessKey,
  type SafeContactSnapshot,
  type SafeContactTarget,
  type SafeItemSnapshot,
} from "../domain/xeroContactItemPrimitives.js";
import {
  executePreparedXeroMutationSchema,
  type ExecutePreparedXeroMutationInput,
} from "../domain/xeroControlledMutationSchemas.js";
import { AppError } from "../errors.js";
import { evaluateEffectiveXeroCapability } from "../policy/xeroEffectiveCapability.js";
import type { XeroCapabilityPermission } from "../policy/xeroCapabilityPolicy.js";
import type {
  ContactItemMutationProvider,
  ContactItemReadbackVerification,
  ContactItemWriteReceipt,
} from "../providers/xeroContactItemMutationProvider.js";
import type {
  AccountingPrincipal,
  ActorTenantContext,
  ConnectionSummary,
} from "../providers/types.js";
import { hashObject } from "../security/hash.js";
import {
  allowedWriteTenantForRequest,
  type RequestContext,
} from "../security/requestContext.js";
import type { XeroMutationRequest, XeroMutationSourceEvidenceType } from "../domain/xeroMutation.js";
import { XeroMutationService } from "./xeroMutationService.js";

type SupportedPrimitive =
  | ContactCreatePrimitive
  | ContactUpdatePrimitive
  | ItemCreatePrimitive
  | ItemUpdatePrimitive;

type SupportedObjectType = SupportedPrimitive["objectType"];
type SupportedOperation = SupportedPrimitive["operation"];
type SupportedActionId =
  | "contact.create_basic"
  | "contact.update_basic"
  | "item.create_basic_untracked"
  | "item.update_basic_untracked";

type SourceInput = {
  source_ref: string;
  source_unit_key: string;
  source_sha256?: string;
};

export interface XeroContactItemRuntimeProvider {
  connectionStatus(principal: AccountingPrincipal): Promise<ConnectionSummary>;
  resolveContext(principal: AccountingPrincipal): Promise<ActorTenantContext>;
}

export interface XeroContactItemMutationRuntimeConfig {
  xeroWriteEnabled: boolean;
  xeroAllowedTenantId?: string;
  contactNamespace: string;
}

export interface ContactItemPreparationResult {
  preparation_id: string;
  state: "PREPARED";
  object_type: SupportedObjectType;
  operation: SupportedOperation;
  proposal: Record<string, unknown>;
  canonical_payload_hash: string;
  source: {
    ref: string;
    unit_key: string;
    sha256: string;
    evidence_type: XeroMutationSourceEvidenceType;
    original_file_verified: false;
  };
  confirmation_phrase: string;
  expires_at: string;
  execution_allowed_before_confirmation: false;
  warning: string;
}

export interface ContactItemWriteResult {
  state: "READBACK_VERIFIED";
  object_type: SupportedObjectType;
  operation: SupportedOperation;
  xero_object_id: string;
  mutation_request_id: string;
  status: string;
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
}

interface PrewriteFailure {
  code: "DUPLICATE" | "OBJECT_NOT_FOUND" | "STALE_VERSION";
  message: string;
  details: Record<string, unknown>;
}

const contactNamespaceSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,11}$/);

function permissionsFor(context: RequestContext): XeroCapabilityPermission[] {
  const permissions: XeroCapabilityPermission[] = [];
  if (context.scopes.includes("xero.read")) permissions.push("XERO_ACCOUNTING_READ");
  if (context.scopes.includes("xero.draft.write")) permissions.push("XERO_DRAFT_WRITE");
  if (context.roles.includes("xero.dual_approval")) permissions.push("XERO_DUAL_APPROVAL");
  return permissions;
}

function contactTarget(snapshot: SafeContactSnapshot): SafeContactTarget {
  const {
    contactId: _contactId,
    externalReference: _externalReference,
    contactNumberEvidence: _contactNumberEvidence,
    updatedAt: _updatedAt,
    ...target
  } = snapshot;
  return target;
}

function contactBusinessKeys(target: SafeContactTarget): NormalizedBusinessKey[] {
  const compact = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase();
  const keys: NormalizedBusinessKey[] = [];
  if (target.companyNumber) keys.push({ kind: "COMPANY_NUMBER", value: compact(target.companyNumber) });
  if (target.email) keys.push({ kind: "EMAIL", value: target.email.trim().toLowerCase() });
  if (target.accountNumber) keys.push({ kind: "ACCOUNT_NUMBER", value: compact(target.accountNumber) });
  keys.push({
    kind: "NAME",
    value: target.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
  });
  return keys;
}

function itemTarget(snapshot: SafeItemSnapshot): Record<string, unknown> {
  const { itemId: _itemId, updatedAt: _updatedAt, ...target } = snapshot;
  return target;
}

function sourceEvidence(source: SourceInput): {
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  sourceSha256?: string;
} {
  return source.source_sha256
    ? { sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED", sourceSha256: source.source_sha256 }
    : { sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION" };
}

function definiteProviderRejection(error: unknown): error is AppError {
  return error instanceof AppError &&
    error.code === "PROVIDER_ERROR" &&
    error.retryable === false &&
    error.details?.writeOutcome === "DEFINITELY_REJECTED";
}

function preparationValidation(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("VALIDATION_FAILED", message, {
    httpStatus: 422,
    ...(details ? { details } : {}),
  });
}

/**
 * Controlled basic Contact and untracked Item mutations. Public prepare calls
 * accept only the reviewed W1 fields. Public execution accepts only the server
 * preparation ID, request ID and exact one-time confirmation phrase.
 */
export class XeroContactItemMutationService {
  readonly #contactNamespace: string;

  constructor(
    private readonly runtime: XeroContactItemRuntimeProvider,
    private readonly provider: ContactItemMutationProvider,
    private readonly mutations: XeroMutationService,
    private readonly config: XeroContactItemMutationRuntimeConfig,
  ) {
    const namespace = contactNamespaceSchema.safeParse(config.contactNamespace);
    if (!namespace.success) {
      throw new AppError("CONFIGURATION_ERROR", "The Xero contact namespace is invalid.");
    }
    this.#contactNamespace = namespace.data;
  }

  async prepareContactCreate(
    context: RequestContext,
    rawInput: PrepareContactCreateMutationInput,
  ): Promise<ContactItemPreparationResult> {
    const input = prepareContactCreateMutationSchema.parse(rawInput);
    const { source_ref, source_unit_key, source_sha256, ...contactInput } = input;
    const source: SourceInput = {
      source_ref,
      source_unit_key,
      ...(source_sha256 !== undefined ? { source_sha256 } : {}),
    };
    const prepared = prepareContactCreate(contactInput, {
      namespace: this.#contactNamespace,
      externalKey: hashObject({
        semantics: "xero-contact-source-key:v1",
        sourceRef: source_ref,
        sourceUnitKey: source_unit_key,
      }),
    });
    if (await this.provider.contactDuplicateExists(
      context,
      prepared.externalReference,
      contactBusinessKeys(prepared.target),
    )) {
      throw preparationValidation("An exact Xero contact duplicate already exists.", {
        duplicateKeyKind: prepared.normalizedBusinessKey.kind,
      });
    }
    return this.#persistPreparation(context, prepared, source);
  }

  async prepareContactUpdate(
    context: RequestContext,
    rawInput: PrepareContactUpdateMutationInput,
  ): Promise<ContactItemPreparationResult> {
    const input = prepareContactUpdateMutationSchema.parse(rawInput);
    const before = await this.provider.getContactExact(context, input.contact_id);
    if (!before) {
      throw preparationValidation("The exact active Xero contact could not be read.", { path: "contact_id" });
    }
    const prepared = prepareContactUpdate({
      contact_id: input.contact_id,
      expected_updated_at: before.updatedAt,
      patch: input.patch,
    }, before);
    if (await this.provider.contactDuplicateExists(
      context,
      prepared.before.externalReference,
      contactBusinessKeys(prepared.target),
      prepared.contactId,
    )) {
      throw preparationValidation("The contact change would collide with an exact Xero duplicate.", {
        duplicateKeyKind: prepared.normalizedBusinessKey.kind,
      });
    }
    return this.#persistPreparation(context, prepared, {
      source_ref: input.source_ref,
      source_unit_key: input.source_unit_key,
      ...(input.source_sha256 !== undefined ? { source_sha256: input.source_sha256 } : {}),
    });
  }

  async prepareItemCreate(
    context: RequestContext,
    rawInput: PrepareItemCreateMutationInput,
  ): Promise<ContactItemPreparationResult> {
    const input = prepareItemCreateMutationSchema.parse(rawInput);
    const { source_ref, source_unit_key, source_sha256, ...itemInput } = input;
    const source: SourceInput = {
      source_ref,
      source_unit_key,
      ...(source_sha256 !== undefined ? { source_sha256 } : {}),
    };
    const prepared = prepareItemCreate(itemInput);
    if (await this.provider.itemCodeExists(context, prepared.target.code)) {
      throw preparationValidation("An exact Xero item code already exists.", { path: "code" });
    }
    return this.#persistPreparation(context, prepared, source);
  }

  async prepareItemUpdate(
    context: RequestContext,
    rawInput: PrepareItemUpdateMutationInput,
  ): Promise<ContactItemPreparationResult> {
    const input = prepareItemUpdateMutationSchema.parse(rawInput);
    const before = await this.provider.getItemExact(context, input.item_id);
    if (!before) {
      throw preparationValidation("The exact untracked Xero item could not be read.", { path: "item_id" });
    }
    const prepared = prepareItemUpdate({
      item_id: input.item_id,
      expected_updated_at: before.updatedAt,
      patch: input.patch,
    }, before);
    return this.#persistPreparation(context, prepared, {
      source_ref: input.source_ref,
      source_unit_key: input.source_unit_key,
      ...(input.source_sha256 !== undefined ? { source_sha256: input.source_sha256 } : {}),
    });
  }

  async createContact(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ContactItemWriteResult> {
    return this.#execute(context, rawInput, "CONTACT", "CREATE", "contact.create_basic");
  }

  async updateContact(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ContactItemWriteResult> {
    return this.#execute(context, rawInput, "CONTACT", "UPDATE", "contact.update_basic");
  }

  async createItem(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ContactItemWriteResult> {
    return this.#execute(context, rawInput, "ITEM", "CREATE", "item.create_basic_untracked");
  }

  async updateItem(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ContactItemWriteResult> {
    return this.#execute(context, rawInput, "ITEM", "UPDATE", "item.update_basic_untracked");
  }

  async #persistPreparation(
    context: RequestContext,
    prepared: SupportedPrimitive,
    source: SourceInput,
  ): Promise<ContactItemPreparationResult> {
    const evidence = sourceEvidence(source);
    const persisted = await this.mutations.prepare(context, {
      objectType: prepared.objectType,
      operation: prepared.operation,
      canonicalPayload: prepared.canonicalPayload,
      sourceRef: source.source_ref,
      sourceUnitKey: source.source_unit_key,
      ...(evidence.sourceSha256 !== undefined ? { sourceSha256: evidence.sourceSha256 } : {}),
      sourceEvidenceType: evidence.sourceEvidenceType,
      confirmationDetails: this.#confirmationDetails(prepared),
      confirmationPhrase: prepared.confirmationPhrase,
      ...(prepared.operation === "UPDATE" ? { targetXeroObjectId: this.#targetId(prepared) } : {}),
    });
    return {
      preparation_id: persisted.preparationId,
      state: "PREPARED",
      object_type: prepared.objectType,
      operation: prepared.operation,
      proposal: prepared.canonicalPayload,
      canonical_payload_hash: persisted.canonicalPayloadHash,
      source: {
        ref: source.source_ref,
        unit_key: source.source_unit_key,
        sha256: persisted.sourceSha256,
        evidence_type: persisted.sourceEvidenceType,
        original_file_verified: false,
      },
      confirmation_phrase: persisted.confirmationPhrase,
      expires_at: persisted.expiresAt.toISOString(),
      execution_allowed_before_confirmation: false,
      warning: "The confirmation is bound to this OAuth tenant, exact proposal and source fingerprint; it is not proof of the original file contents.",
    };
  }

  async #execute(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
    expectedObjectType: SupportedObjectType,
    expectedOperation: SupportedOperation,
    actionId: SupportedActionId,
  ): Promise<ContactItemWriteResult> {
    const input = executePreparedXeroMutationSchema.parse(rawInput);
    await this.#assertWriteAuthority(context, actionId);
    const confirmed = await this.mutations.confirm(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
      confirmationPhrase: input.confirmation_phrase,
    }, { objectType: expectedObjectType, operation: expectedOperation });
    if (confirmed.objectType !== expectedObjectType || confirmed.operation !== expectedOperation) {
      throw new AppError("APPROVAL_INVALID", "The confirmed preparation is for a different Xero mutation.", {
        httpStatus: 409,
      });
    }
    const prepared = this.#parsePrimitive(expectedObjectType, expectedOperation, confirmed.canonicalPayload);

    if (confirmed.state === "CONFIRMED") {
      const failure = await this.#prewriteFailure(context, prepared);
      if (failure) {
        await this.mutations.failValidation(context, {
          mutationRequestId: confirmed.mutationRequestId,
          validationReceipt: {
            reason: failure.code,
            objectType: prepared.objectType,
            operation: prepared.operation,
            ...failure.details,
          },
        });
        throw new AppError(failure.code === "OBJECT_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT", failure.message, {
          httpStatus: 409,
          details: failure.details,
        });
      }
    }

    const started = await this.mutations.start(context, { mutationRequestId: confirmed.mutationRequestId });
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request);

    let objectId = started.request.xeroObjectId;
    let receipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let written: ContactItemWriteReceipt;
      try {
        written = await this.#write(context, prepared, confirmed.mutationRequestId);
      } catch (error) {
        if (definiteProviderRejection(error)) {
          await this.mutations.rejectProvider(context, {
            mutationRequestId: confirmed.mutationRequestId,
            providerRejectionReceipt: {
              errorCode: error.code,
              httpStatus: error.httpStatus,
              retryable: false,
              writeOutcome: "DEFINITELY_REJECTED",
              ...(error.details ? { providerDetails: error.details } : {}),
            },
          });
        } else {
          await this.mutations.markUnknown(context, { mutationRequestId: confirmed.mutationRequestId });
        }
        throw error;
      }
      try {
        const persistedEvidence = await this.mutations.recordWriteEvidence(context, {
          mutationRequestId: confirmed.mutationRequestId,
          xeroObjectId: written.objectId,
          writeReceipt: written.receipt,
        });
        objectId = persistedEvidence.xeroObjectId;
        receipt = persistedEvidence.writeReceipt;
      } catch (error) {
        try {
          await this.mutations.markUnknown(context, {
            mutationRequestId: confirmed.mutationRequestId,
            xeroObjectId: written.objectId,
            writeReceipt: written.receipt,
          });
        } catch (persistenceError) {
          throw new AppError("WRITE_RESULT_UNKNOWN", "Xero wrote the object but durable write evidence failed.", {
            httpStatus: 503,
            retryable: false,
            details: { xeroObjectId: written.objectId },
            cause: new AggregateError([error, persistenceError], "Write evidence persistence failed."),
          });
        }
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero wrote the object but durable evidence needs recovery.", {
          httpStatus: 503,
          retryable: false,
          details: { xeroObjectId: written.objectId },
          cause: error,
        });
      }
    }

    if (!objectId || !receipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero mutation has no exact write receipt for safe recovery.", {
        httpStatus: 502,
        retryable: false,
      });
    }

    try {
      const verification = await this.#readAndVerify(context, objectId, prepared);
      if (!verification.verified || !verification.snapshot) {
        if (verification.snapshot) {
          const actualCanonical = this.#actualCanonicalPayload(prepared, verification.snapshot);
          if (hashObject(actualCanonical) !== confirmed.canonicalPayloadHash) {
            const recovered = await this.mutations.recover(context, {
              mutationRequestId: confirmed.mutationRequestId,
              writeReceipt: receipt,
              verifiedReadback: {
                xeroObjectId: objectId,
                status: this.#readbackStatus(prepared.objectType),
                canonicalPayload: actualCanonical,
                evidence: { snapshot: verification.snapshot, mismatches: verification.mismatches },
              },
            });
            throw new AppError("READBACK_MISMATCH", "Xero readback does not match the confirmed mutation.", {
              httpStatus: 409,
              details: { outcome: recovered.outcome, xeroObjectId: objectId, mismatches: verification.mismatches },
            });
          }
        }
        await this.mutations.markUnknown(context, {
          mutationRequestId: confirmed.mutationRequestId,
          xeroObjectId: objectId,
          writeReceipt: receipt,
        });
        throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero object exists but exact readback was not verified.", {
          httpStatus: 502,
          retryable: false,
          details: { xeroObjectId: objectId, mismatches: verification.mismatches },
        });
      }
      const completed = await this.mutations.markReadbackVerified(context, {
        mutationRequestId: confirmed.mutationRequestId,
        writeReceipt: receipt,
        verifiedReadback: {
          xeroObjectId: objectId,
          status: this.#readbackStatus(prepared.objectType),
          canonicalPayload: confirmed.canonicalPayload,
          evidence: { snapshot: verification.snapshot },
        },
      });
      return this.#verifiedResult(completed);
    } catch (error) {
      if (error instanceof AppError && ["READBACK_MISMATCH", "WRITE_RESULT_UNKNOWN"].includes(error.code)) {
        throw error;
      }
      await this.mutations.markUnknown(context, {
        mutationRequestId: confirmed.mutationRequestId,
        xeroObjectId: objectId,
        writeReceipt: receipt,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero object exists but its exact readback failed.", {
        httpStatus: 502,
        retryable: false,
        details: { xeroObjectId: objectId },
        cause: error,
      });
    }
  }

  #parsePrimitive(
    objectType: SupportedObjectType,
    operation: SupportedOperation,
    canonicalPayload: Record<string, unknown>,
  ): SupportedPrimitive {
    if (objectType === "CONTACT") {
      return operation === "CREATE"
        ? parseCanonicalContactCreatePrimitive(canonicalPayload)
        : parseCanonicalContactUpdatePrimitive(canonicalPayload);
    }
    return operation === "CREATE"
      ? parseCanonicalItemCreatePrimitive(canonicalPayload)
      : parseCanonicalItemUpdatePrimitive(canonicalPayload);
  }

  async #prewriteFailure(
    context: RequestContext,
    prepared: SupportedPrimitive,
  ): Promise<PrewriteFailure | undefined> {
    if (prepared.objectType === "CONTACT" && prepared.operation === "CREATE") {
      return await this.provider.contactDuplicateExists(
        context,
        prepared.externalReference,
        contactBusinessKeys(prepared.target),
      ) ? {
        code: "DUPLICATE",
        message: "An exact Xero contact duplicate appeared after preparation.",
        details: { duplicateKeyKind: prepared.normalizedBusinessKey.kind },
      } : undefined;
    }
    if (prepared.objectType === "ITEM" && prepared.operation === "CREATE") {
      return await this.provider.itemCodeExists(context, prepared.target.code) ? {
        code: "DUPLICATE",
        message: "The exact Xero item code appeared after preparation.",
        details: { itemCode: prepared.target.code },
      } : undefined;
    }
    if (prepared.objectType === "CONTACT") {
      const current = await this.provider.getContactExact(context, prepared.contactId);
      if (!current) {
        return {
          code: "OBJECT_NOT_FOUND",
          message: "The exact active Xero contact is no longer available.",
          details: { contactId: prepared.contactId },
        };
      }
      try {
        assertContactCurrentVersion(prepared, current);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
        return {
          code: "STALE_VERSION",
          message: error.message,
          details: { contactId: prepared.contactId },
        };
      }
      return await this.provider.contactDuplicateExists(
        context,
        prepared.before.externalReference,
        contactBusinessKeys(prepared.target),
        prepared.contactId,
      ) ? {
        code: "DUPLICATE",
        message: "The contact change now collides with an exact Xero duplicate.",
        details: { contactId: prepared.contactId, duplicateKeyKind: prepared.normalizedBusinessKey.kind },
      } : undefined;
    }
    const current = await this.provider.getItemExact(context, prepared.itemId);
    if (!current) {
      return {
        code: "OBJECT_NOT_FOUND",
        message: "The exact untracked Xero item is no longer available.",
        details: { itemId: prepared.itemId },
      };
    }
    try {
      assertItemCurrentVersion(prepared, current);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
      return {
        code: "STALE_VERSION",
        message: error.message,
        details: { itemId: prepared.itemId },
      };
    }
    return undefined;
  }

  async #write(
    context: RequestContext,
    prepared: SupportedPrimitive,
    idempotencyKey: string,
  ): Promise<ContactItemWriteReceipt> {
    if (prepared.objectType === "CONTACT") {
      return prepared.operation === "CREATE"
        ? this.provider.createContact(context, prepared, idempotencyKey)
        : this.provider.updateContact(context, prepared, idempotencyKey);
    }
    return prepared.operation === "CREATE"
      ? this.provider.createItem(context, prepared, idempotencyKey)
      : this.provider.updateItem(context, prepared, idempotencyKey);
  }

  async #readAndVerify(
    context: RequestContext,
    objectId: string,
    prepared: SupportedPrimitive,
  ): Promise<ContactItemReadbackVerification<SafeContactSnapshot | SafeItemSnapshot>> {
    return prepared.objectType === "CONTACT"
      ? this.provider.readAndVerifyContact(context, objectId, prepared)
      : this.provider.readAndVerifyItem(context, objectId, prepared);
  }

  #actualCanonicalPayload(
    prepared: SupportedPrimitive,
    snapshot: SafeContactSnapshot | SafeItemSnapshot,
  ): Record<string, unknown> {
    if (prepared.objectType === "CONTACT") {
      if (!("contactId" in snapshot)) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "The Contact readback projection has the wrong object type.", {
          httpStatus: 502,
        });
      }
      const {
        externalReference: _expectedExternalReference,
        contactNumberEvidence: _expectedEvidence,
        target: _expectedTarget,
        ...base
      } = prepared.canonicalPayload;
      return {
        ...base,
        ...(snapshot.externalReference ? { externalReference: snapshot.externalReference } : {}),
        ...(prepared.operation === "UPDATE" ? { contactNumberEvidence: snapshot.contactNumberEvidence } : {}),
        target: contactTarget(snapshot),
      };
    }
    if (!("itemId" in snapshot)) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Item readback projection has the wrong object type.", {
        httpStatus: 502,
      });
    }
    return { ...prepared.canonicalPayload, target: itemTarget(snapshot) };
  }

  #confirmationDetails(prepared: SupportedPrimitive): Record<string, unknown> {
    if (prepared.objectType === "CONTACT") {
      return {
        name: prepared.target.name,
        businessKeyKind: prepared.normalizedBusinessKey.kind,
        operation: prepared.operation,
        ...(prepared.operation === "UPDATE"
          ? { contactId: prepared.contactId, changedFields: prepared.diff.map((entry) => entry.path) }
          : {}),
      };
    }
    return {
      itemCode: prepared.target.code,
      operation: prepared.operation,
      untrackedInventoryOnly: true,
      ...(prepared.operation === "UPDATE"
        ? { itemId: prepared.itemId, changedFields: prepared.diff.map((entry) => entry.path) }
        : {}),
    };
  }

  #targetId(prepared: ContactUpdatePrimitive | ItemUpdatePrimitive): string {
    return prepared.objectType === "CONTACT" ? prepared.contactId : prepared.itemId;
  }

  #readbackStatus(objectType: SupportedObjectType): string {
    return objectType === "CONTACT" ? "ACTIVE" : "UNTRACKED";
  }

  #verifiedResult(request: XeroMutationRequest): ContactItemWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      (request.objectType !== "CONTACT" && request.objectType !== "ITEM") ||
      (request.operation !== "CREATE" && request.operation !== "UPDATE") ||
      !request.xeroObjectId ||
      !request.writeReceipt ||
      !request.readbackSnapshot ||
      !request.readbackStatus
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The persisted Xero mutation is not readback-verified.", {
        httpStatus: 502,
      });
    }
    return {
      state: "READBACK_VERIFIED",
      object_type: request.objectType,
      operation: request.operation,
      xero_object_id: request.xeroObjectId,
      mutation_request_id: request.mutationRequestId,
      status: request.readbackStatus,
      receipt: request.writeReceipt,
      readback: request.readbackSnapshot,
    };
  }

  async #assertWriteAuthority(context: RequestContext, actionId: SupportedActionId): Promise<void> {
    const [status, tenant] = await Promise.all([
      this.runtime.connectionStatus(context),
      this.runtime.resolveContext(context),
    ]);
    const allowedWriteTenantId = allowedWriteTenantForRequest(
      context,
      tenant.tenantId,
      this.config.xeroAllowedTenantId,
    );
    const decision = evaluateEffectiveXeroCapability(actionId, {
      connectionConnected: status.connected,
      ...(context.connectionId ? { connectionId: context.connectionId } : {}),
      ...(status.tenant?.id ? { connectionTenantId: status.tenant.id } : {}),
      boundTenantId: tenant.tenantId,
      grantedMcpScopes: context.scopes,
      grantedPermissions: permissionsFor(context),
      grantedXeroOAuthScopes: status.scopes,
      writeGateEnabled: this.config.xeroWriteEnabled,
      ...(allowedWriteTenantId ? { allowedWriteTenantId } : {}),
      explicitConfirmationVerified: true,
    });
    if (!decision.allowed) {
      throw new AppError("FORBIDDEN", "This Xero Contact/Item mutation is not currently authorised.", {
        httpStatus: 403,
        details: { denyReasons: decision.denyReasons },
      });
    }
  }
}
