import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import {
  parseTrackingCanonicalPayload,
  type TrackingActionId,
  type TrackingCanonicalPayload,
} from "../domain/xeroTrackingCanonical.js";
import type { XeroMutationObjectType, XeroMutationOperation, XeroMutationRequest } from "../domain/xeroMutation.js";
import { AppError } from "../errors.js";
import type {
  TrackingProviderReceipt,
  TrackingProviderWriteEvidence,
  TrackingProviderWriteResult,
  XeroTrackingMutationProvider,
} from "../providers/xeroTrackingMutationProvider.js";
import type { RequestContext } from "../security/requestContext.js";
import { hashObject } from "../security/hash.js";
import { XeroMutationService } from "./xeroMutationService.js";

export interface PrepareTrackingCaseMutationInput {
  actionId: TrackingActionId;
  payload: Record<string, unknown>;
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
}

export interface ExecuteTrackingCaseMutationInput {
  preparation_id: string;
  request_id: string;
  actionId: TrackingActionId;
}

export interface TrackingCaseMutationWriteResult {
  state: "READBACK_VERIFIED";
  action_id: TrackingActionId;
  object_type: "TRACKING_CATEGORY" | "TRACKING_OPTION";
  xero_object_id: string;
  mutation_request_id: string;
  status: "ACTIVE";
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
}

type TrackingExpectation = Readonly<{
  actionId: TrackingActionId;
  objectType: "TRACKING_CATEGORY" | "TRACKING_OPTION";
  operation: "CREATE" | "UPDATE";
  targetXeroObjectId?: string;
  payload: TrackingCanonicalPayload;
}>;

function expectationFor(actionId: TrackingActionId, rawPayload: unknown): TrackingExpectation {
  const payload = parseTrackingCanonicalPayload(rawPayload);
  if (payload.actionId !== actionId) {
    throw new AppError("VALIDATION_FAILED", "Tracking Case action does not match its canonical payload.", {
      httpStatus: 422,
      details: { providerMutationPossible: false },
    });
  }
  switch (payload.actionId) {
    case "tracking_category.create":
      return { actionId, objectType: "TRACKING_CATEGORY", operation: "CREATE", payload };
    case "tracking_category.update":
      return {
        actionId,
        objectType: "TRACKING_CATEGORY",
        operation: "UPDATE",
        targetXeroObjectId: payload.trackingCategoryId,
        payload,
      };
    case "tracking_option.create":
      return { actionId, objectType: "TRACKING_OPTION", operation: "CREATE", payload };
    case "tracking_option.update":
      return {
        actionId,
        objectType: "TRACKING_OPTION",
        operation: "UPDATE",
        targetXeroObjectId: payload.trackingOptionId,
        payload,
      };
  }
}

function definiteRejection(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.writeOutcome === "DEFINITELY_REJECTED";
}

function receiptRecord(receipt: TrackingProviderReceipt): Record<string, unknown> {
  return receipt as unknown as Record<string, unknown>;
}

/** Durable Accounting Case lifecycle for the four closed tracking actions. */
export class XeroTrackingCaseMutationService {
  constructor(
    private readonly provider: XeroTrackingMutationProvider,
    private readonly mutations: XeroMutationService,
  ) {}

  async prepare(
    context: RequestContext,
    input: PrepareTrackingCaseMutationInput,
  ): Promise<{ preparation_id: string }> {
    const expected = expectationFor(input.actionId, input.payload);
    await this.provider.validatePreflight(context, expected.payload);
    const prepared = await this.mutations.prepare(context, {
      objectType: expected.objectType,
      operation: expected.operation,
      ...(expected.targetXeroObjectId ? { targetXeroObjectId: expected.targetXeroObjectId } : {}),
      canonicalPayload: expected.payload,
      sourceRef: input.sourceRef,
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256: input.sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: {
        actionId: expected.actionId,
        ...(expected.targetXeroObjectId ? { targetXeroObjectId: expected.targetXeroObjectId } : {}),
        payloadHash: hashObject(expected.payload),
      },
    });
    return { preparation_id: prepared.preparationId };
  }

  async execute(
    context: RequestContext,
    input: ExecuteTrackingCaseMutationInput,
  ): Promise<TrackingCaseMutationWriteResult> {
    const shape = expectationShape(input.actionId);
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, shape);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, shape);
    const expected = expectationFor(input.actionId, preparation.canonicalPayload);
    if (
      preparation.objectType !== expected.objectType ||
      preparation.operation !== expected.operation ||
      preparation.targetXeroObjectId?.toLowerCase() !== expected.targetXeroObjectId?.toLowerCase() ||
      hashObject(preparation.canonicalPayload) !== hashObject(expected.payload)
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Tracking preparation does not match its closed Case action.", {
        httpStatus: 503,
      });
    }

    if (!recovery) await this.provider.validatePreflight(context, expected.payload);
    const validationReceipt = issueObjectPreparationValidationReceipt({
      actionId: expected.actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-accounting-case-tracking-reference-data-v1",
      checks: [{
        code: "TRACKING_REFERENCE_PRECONDITIONS_VALID",
        evidence: {
          objectType: expected.objectType,
          operation: expected.operation,
          ...(expected.targetXeroObjectId ? { targetXeroObjectId: expected.targetXeroObjectId } : {}),
          canonicalPayloadHash: hashObject(expected.payload),
        },
      }],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(
      context,
      { preparationId: input.preparation_id, requestId: input.request_id },
      shape,
      validationReceipt,
      async () => { await this.provider.validatePreflight(context, expected.payload); },
    );
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request, expected);

    // Tracking recovery is exact GET-only. The generic foundation can offer a
    // one-shot native replay when an old create has no object ID; this family
    // deliberately refuses that claim because it cannot prove an exact target.
    if (recovery && started.mode === "CALL_PROVIDER") {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Tracking recovery has no exact object ID for GET-only reconciliation.", {
        httpStatus: 409,
        retryable: false,
        details: { recoveryAction: "MANUAL_RECONCILIATION_REQUIRED" },
      });
    }

    const request = started.request;
    let objectId = request.xeroObjectId;
    let receipt = request.writeReceipt as TrackingProviderReceipt | undefined;
    if (started.mode === "CALL_PROVIDER") {
      let persistedEvidence: TrackingProviderWriteEvidence | undefined;
      try {
        const result = await this.#callProvider(
          context,
          expected,
          request.mutationRequestId,
          started.providerWritePermit,
          async (evidence) => {
            await this.mutations.recordWriteEvidence(context, {
              mutationRequestId: request.mutationRequestId,
              xeroObjectId: evidence.objectId,
              writeReceipt: receiptRecord(evidence.receipt),
            });
            persistedEvidence = evidence;
          },
        );
        objectId = result.objectId;
        receipt = result.receipt;
        if (!persistedEvidence) {
          await this.mutations.recordWriteEvidence(context, {
            mutationRequestId: request.mutationRequestId,
            xeroObjectId: result.objectId,
            writeReceipt: receiptRecord(result.receipt),
          });
        }
      } catch (error) {
        if (definiteRejection(error) && !persistedEvidence) {
          await this.mutations.rejectProvider(context, {
            mutationRequestId: request.mutationRequestId,
            providerRejectionReceipt: {
              errorCode: error.code,
              httpStatus: error.httpStatus,
              writeOutcome: "DEFINITELY_REJECTED",
              ...(error.details ? { providerDetails: error.details } : {}),
            },
          });
          throw error;
        }
        await this.mutations.markUnknown(context, {
          mutationRequestId: request.mutationRequestId,
          ...(persistedEvidence
            ? { xeroObjectId: persistedEvidence.objectId, writeReceipt: receiptRecord(persistedEvidence.receipt) }
            : expected.targetXeroObjectId
              ? { xeroObjectId: expected.targetXeroObjectId }
              : {}),
        });
        throw new AppError("WRITE_RESULT_UNKNOWN", "The tracking write result requires exact GET recovery.", {
          httpStatus: 502,
          retryable: false,
          cause: error,
          details: { recoveryAction: "READBACK_RECOVERY_ONLY" },
        });
      }
    }

    if (!objectId || !receipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Tracking recovery has no durable exact object ID and receipt.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    try {
      const readback = await this.provider.readAndVerify(context, expected.payload, objectId);
      const verifiedReadback = {
        xeroObjectId: objectId,
        status: "ACTIVE",
        canonicalPayload: expected.payload,
        evidence: readback as unknown as Record<string, unknown>,
      };
      const completed = started.mode === "RECOVER_ONLY"
        ? (await this.mutations.recover(context, {
            mutationRequestId: request.mutationRequestId,
            writeReceipt: receiptRecord(receipt),
            verifiedReadback,
          })).request
        : await this.mutations.markReadbackVerified(context, {
            mutationRequestId: request.mutationRequestId,
            writeReceipt: receiptRecord(receipt),
            verifiedReadback,
          });
      return this.#verifiedResult(completed, expected);
    } catch (error) {
      await this.mutations.markUnknown(context, {
        mutationRequestId: request.mutationRequestId,
        xeroObjectId: objectId,
        writeReceipt: receiptRecord(receipt),
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "The exact tracking object did not pass canonical readback.", {
        httpStatus: 502,
        retryable: false,
        cause: error,
        details: { xeroObjectId: objectId, recoveryAction: "READBACK_RECOVERY_ONLY" },
      });
    }
  }

  #callProvider(
    context: RequestContext,
    expected: TrackingExpectation,
    mutationRequestId: string,
    permit: LedgerProviderWritePermit,
    recordEvidence: (evidence: TrackingProviderWriteEvidence) => Promise<void>,
  ): Promise<TrackingProviderWriteResult> {
    switch (expected.payload.actionId) {
      case "tracking_category.create":
        return this.provider.createCategory(context, expected.payload, mutationRequestId, permit, recordEvidence);
      case "tracking_category.update":
        return this.provider.updateCategory(context, expected.payload, mutationRequestId, permit, recordEvidence);
      case "tracking_option.create":
        return this.provider.createOption(context, expected.payload, mutationRequestId, permit, recordEvidence);
      case "tracking_option.update":
        return this.provider.updateOption(context, expected.payload, mutationRequestId, permit, recordEvidence);
    }
  }

  #verifiedResult(request: XeroMutationRequest, expected: TrackingExpectation): TrackingCaseMutationWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      !request.xeroObjectId ||
      !request.writeReceipt ||
      !request.readbackSnapshot
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Verified tracking mutation evidence is incomplete.", {
        httpStatus: 503,
      });
    }
    return {
      state: "READBACK_VERIFIED",
      action_id: expected.actionId,
      object_type: expected.objectType,
      xero_object_id: request.xeroObjectId,
      mutation_request_id: request.mutationRequestId,
      status: "ACTIVE",
      receipt: request.writeReceipt,
      readback: request.readbackSnapshot,
    };
  }
}

function expectationShape(actionId: TrackingActionId): {
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
} {
  switch (actionId) {
    case "tracking_category.create": return { objectType: "TRACKING_CATEGORY", operation: "CREATE" };
    case "tracking_category.update": return { objectType: "TRACKING_CATEGORY", operation: "UPDATE" };
    case "tracking_option.create": return { objectType: "TRACKING_OPTION", operation: "CREATE" };
    case "tracking_option.update": return { objectType: "TRACKING_OPTION", operation: "UPDATE" };
  }
}
