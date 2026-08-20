import type { AccountingProvider, AccountSummary, TaxRateSummary } from "../providers/types.js";
import type {
  XeroControlledCreateReceipt,
  XeroControlledMutationProvider,
} from "../providers/xeroControlledMutationProvider.js";
import {
  allowedWriteTenantForRequest,
  type RequestContext,
} from "../security/requestContext.js";
import type { ExecutePreparedXeroMutationInput } from "../domain/xeroControlledMutationSchemas.js";
import {
  buildPurchaseOrderDraftPrimitive,
  buildQuoteDraftPrimitive,
  parseCanonicalPurchaseOrderDraftPayload,
  parseCanonicalQuoteDraftPayload,
  preparePurchaseOrderDraftInputSchema,
  prepareQuoteDraftInputSchema,
  type CanonicalPurchaseOrderDraftPayload,
  type CanonicalQuoteDraftPayload,
  type PreparePurchaseOrderDraftInput,
  type PrepareQuoteDraftInput,
  type PreparedControlledDraft,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import { executePreparedXeroMutationSchema } from "../domain/xeroControlledMutationSchemas.js";
import { XeroMutationService } from "./xeroMutationService.js";
import { AppError } from "../errors.js";
import { evaluateEffectiveXeroCapability } from "../policy/xeroEffectiveCapability.js";
import type { XeroCapabilityPermission } from "../policy/xeroCapabilityPolicy.js";
import { xeroCapabilityDenied } from "../policy/xeroCapabilityError.js";
import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";

type SupportedDraft = CanonicalQuoteDraftPayload | CanonicalPurchaseOrderDraftPayload;
type SupportedPrimitive = PreparedControlledDraft<SupportedDraft>;

export interface ControlledMutationRuntimeConfig {
  xeroWriteEnabled: boolean;
  xeroAllowedTenantId?: string;
}

export interface ControlledDraftPreparationResult {
  preparation_id: string;
  state: "PREPARED";
  object_type: "QUOTE" | "PURCHASE_ORDER";
  operation: "CREATE_DRAFT";
  proposal: SupportedDraft;
  canonical_payload_hash: string;
  source: {
    ref: string;
    unit_key: string;
    sha256: string;
    evidence_type: SupportedPrimitive["sourceEvidenceType"];
    original_file_verified: false;
  };
  expires_at: string;
  execution_mode: "STANDING_AUTONOMOUS_DELEGATION";
  per_transaction_confirmation_required: false;
  next_action: "CALL_EXECUTE_TOOL";
  warning: string;
}

export interface ControlledDraftWriteResult {
  state: "DRAFT_READBACK_VERIFIED";
  object_type: "QUOTE" | "PURCHASE_ORDER";
  xero_object_id: string;
  mutation_request_id: string;
  status: "DRAFT";
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
}

function exactActiveAccount(
  accounts: readonly AccountSummary[],
  code: string,
): AccountSummary | undefined {
  const matches = accounts.filter((account) =>
    account.code === code &&
    (!account.status || account.status === "ACTIVE") &&
    account.type !== "BANK" &&
    !["DEBTORS", "CREDITORS", "RETAINEDEARNINGS"].includes(account.systemAccount ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

function taxApplies(tax: TaxRateSummary, account: AccountSummary): boolean {
  switch (account.class) {
    case "EXPENSE": return tax.canApplyToExpenses !== false;
    case "ASSET": return tax.canApplyToAssets !== false;
    case "LIABILITY": return tax.canApplyToLiabilities !== false;
    case "REVENUE": return tax.canApplyToRevenue !== false;
    case "EQUITY": return tax.canApplyToEquity !== false;
    default: return false;
  }
}

function exactActiveTax(
  taxes: readonly TaxRateSummary[],
  taxType: string,
  account: AccountSummary,
): TaxRateSummary | undefined {
  const matches = taxes.filter((tax) =>
    tax.taxType === taxType && (!tax.status || tax.status === "ACTIVE") && taxApplies(tax, account));
  return matches.length === 1 ? matches[0] : undefined;
}

function permissionsFor(context: RequestContext): XeroCapabilityPermission[] {
  const permissions: XeroCapabilityPermission[] = [];
  if (context.scopes.includes("xero.read")) permissions.push("XERO_ACCOUNTING_READ");
  if (context.scopes.includes("xero.draft.write")) permissions.push("XERO_DRAFT_WRITE");
  if (context.roles.includes("xero.dual_approval")) permissions.push("XERO_DUAL_APPROVAL");
  return permissions;
}

function safeValidation(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("VALIDATION_FAILED", message, {
    httpStatus: 422,
    ...(details ? { details } : {}),
  });
}

/**
 * One controlled workflow for the non-invoice draft objects. Preparation is
 * read-only. Execution consumes a server-persisted immutable preparation and
 * never accepts a tenant, status, number, URL, raw provider object, or payload.
 */
export class XeroControlledMutationService {
  constructor(
    private readonly readProvider: AccountingProvider,
    private readonly writeProvider: XeroControlledMutationProvider,
    private readonly mutations: XeroMutationService,
    private readonly config: ControlledMutationRuntimeConfig,
  ) {}

  async prepareQuoteDraft(
    context: RequestContext,
    rawInput: PrepareQuoteDraftInput,
  ): Promise<ControlledDraftPreparationResult> {
    const input = prepareQuoteDraftInputSchema.parse(rawInput);
    const prepared = buildQuoteDraftPrimitive(input);
    await this.#validateDocumentReferences(context, prepared.canonicalPayload);
    return this.#persistPreparation(context, prepared);
  }

  async preparePurchaseOrderDraft(
    context: RequestContext,
    rawInput: PreparePurchaseOrderDraftInput,
  ): Promise<ControlledDraftPreparationResult> {
    const input = preparePurchaseOrderDraftInputSchema.parse(rawInput);
    const prepared = buildPurchaseOrderDraftPrimitive(input);
    await this.#validateDocumentReferences(context, prepared.canonicalPayload);
    return this.#persistPreparation(context, prepared);
  }

  async createQuoteDraft(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ControlledDraftWriteResult> {
    return this.#execute(context, rawInput, "QUOTE", "quote.create_draft");
  }

  async createPurchaseOrderDraft(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<ControlledDraftWriteResult> {
    return this.#execute(context, rawInput, "PURCHASE_ORDER", "purchase_order.create_draft");
  }

  async #persistPreparation(
    context: RequestContext,
    prepared: SupportedPrimitive,
  ): Promise<ControlledDraftPreparationResult> {
    const persisted = await this.mutations.prepare(context, {
      objectType: prepared.objectType,
      operation: prepared.operation,
      canonicalPayload: prepared.canonicalPayload as unknown as Record<string, unknown>,
      sourceRef: prepared.sourceRef,
      sourceUnitKey: prepared.sourceUnitKey,
      ...(prepared.sourceEvidenceType === "AGENT_ASSERTED_UNVERIFIED"
        ? { sourceSha256: prepared.sourceSha256 }
        : {}),
      sourceEvidenceType: prepared.sourceEvidenceType,
      confirmationDetails: {
        contactId: prepared.canonicalPayload.contactId,
        currency: prepared.canonicalPayload.currency,
        enteredLineSubtotal: prepared.canonicalPayload.enteredLineSubtotal,
        lineCount: prepared.canonicalPayload.lines.length,
        status: "DRAFT",
      },
    });
    return {
      preparation_id: persisted.preparationId,
      state: "PREPARED",
      object_type: prepared.objectType,
      operation: "CREATE_DRAFT",
      proposal: prepared.canonicalPayload,
      canonical_payload_hash: persisted.canonicalPayloadHash,
      source: {
        ref: prepared.sourceRef,
        unit_key: prepared.sourceUnitKey,
        sha256: persisted.sourceSha256,
        evidence_type: prepared.sourceEvidenceType,
        original_file_verified: false,
      },
      expires_at: persisted.expiresAt.toISOString(),
      execution_mode: "STANDING_AUTONOMOUS_DELEGATION",
      per_transaction_confirmation_required: false,
      next_action: "CALL_EXECUTE_TOOL",
      warning: "Execution revalidates the exact target, standing delegation, immutable payload and provider readback. Source facts remain model-extracted provenance.",
    };
  }

  async #execute(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
    expectedObjectType: "QUOTE" | "PURCHASE_ORDER",
    actionId: "quote.create_draft" | "purchase_order.create_draft",
  ): Promise<ControlledDraftWriteResult> {
    const input = executePreparedXeroMutationSchema.parse(rawInput);
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, { objectType: expectedObjectType, operation: "CREATE_DRAFT" });
    if (!recovery) await this.#assertWriteAuthority(context, actionId);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, { objectType: expectedObjectType, operation: "CREATE_DRAFT" });
    const expected = expectedObjectType === "QUOTE"
      ? parseCanonicalQuoteDraftPayload(preparation.canonicalPayload)
      : parseCanonicalPurchaseOrderDraftPayload(preparation.canonicalPayload);
    if (!recovery) await this.#validateDocumentReferences(context, expected);
    const validationReceipt = issueObjectPreparationValidationReceipt({
      actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-quote-purchase-order-v1",
      checks: [
        { code: "CANONICAL_SCHEMA_VALID", evidence: { objectType: expected.objectType } },
        {
          code: "ACCOUNT_TAX_CONTACT_ITEM_REFERENCES_REVALIDATED",
          evidence: { objectType: expected.objectType, lineCount: expected.lines.length },
        },
      ],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, { objectType: expectedObjectType, operation: "CREATE_DRAFT" }, validationReceipt);
    const confirmed = started.request;
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request);

    let objectId = started.request.xeroObjectId;
    let receipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let created: XeroControlledCreateReceipt;
      try {
        created = expectedObjectType === "QUOTE"
          ? await this.writeProvider.createQuoteDraft(
              context,
              expected as CanonicalQuoteDraftPayload,
              confirmed.mutationRequestId,
              started.providerWritePermit,
            )
          : await this.writeProvider.createPurchaseOrderDraft(
              context,
              expected as CanonicalPurchaseOrderDraftPayload,
              confirmed.mutationRequestId,
              started.providerWritePermit,
            );
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "PROVIDER_ERROR" &&
          error.retryable === false &&
          error.details?.writeOutcome === "DEFINITELY_REJECTED"
        ) {
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
          // A timeout, 5xx, missing ID, or unclassified transport failure may
          // have written successfully, so the source reservation is retained.
          await this.mutations.markUnknown(context, { mutationRequestId: confirmed.mutationRequestId });
        }
        throw error;
      }

      try {
        const persistedEvidence = await this.mutations.recordWriteEvidence(context, {
          mutationRequestId: confirmed.mutationRequestId,
          xeroObjectId: created.objectId,
          writeReceipt: created.receipt,
        });
        objectId = persistedEvidence.xeroObjectId;
        receipt = persistedEvidence.writeReceipt;
      } catch (error) {
        try {
          await this.mutations.markUnknown(context, {
            mutationRequestId: confirmed.mutationRequestId,
            xeroObjectId: created.objectId,
            writeReceipt: created.receipt,
          });
        } catch {
          // The primary error remains a fail-closed unknown result. The exact
          // Xero ID is returned below so an operator can recover by exact GET.
        }
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "Xero returned an exact object ID, but its write evidence could not be durably persisted.",
          {
            httpStatus: 502,
            retryable: false,
            details: { xeroObjectId: created.objectId },
            cause: error,
          },
        );
      }
    }

    if (!objectId || !receipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero write has no exact object ID for safe recovery.", {
        httpStatus: 502,
        retryable: false,
      });
    }

    try {
      const verified = expectedObjectType === "QUOTE"
        ? await this.writeProvider.readAndVerifyQuoteDraft(
            context,
            objectId,
            expected as CanonicalQuoteDraftPayload,
          )
        : await this.writeProvider.readAndVerifyPurchaseOrderDraft(
            context,
            objectId,
            expected as CanonicalPurchaseOrderDraftPayload,
          );
      if (!verified.ok) {
        if (verified.snapshot && verified.readbackCanonicalPayload) {
          const recovered = await this.mutations.recover(context, {
            mutationRequestId: confirmed.mutationRequestId,
            writeReceipt: receipt,
            verifiedReadback: this.#controlledReadback(
              objectId,
              verified.readbackCanonicalPayload as unknown as Record<string, unknown>,
              verified.snapshot as unknown as Record<string, unknown>,
            ),
          });
          throw new AppError("READBACK_MISMATCH", "Xero readback does not match the confirmed draft.", {
            httpStatus: 409,
            details: {
              outcome: recovered.outcome,
              xeroObjectId: objectId,
              ...(verified.mismatchFields ? { mismatchFields: verified.mismatchFields } : {}),
            },
          });
        }
        await this.mutations.markUnknown(context, {
          mutationRequestId: confirmed.mutationRequestId,
          xeroObjectId: objectId,
          writeReceipt: receipt,
        });
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned an unreadable draft projection; recovery is required.", {
          httpStatus: 502,
          retryable: false,
          details: { xeroObjectId: objectId },
        });
      }
      const completed = await this.mutations.markReadbackVerified(context, {
        mutationRequestId: confirmed.mutationRequestId,
        writeReceipt: receipt,
        verifiedReadback: this.#controlledReadback(
          objectId,
          verified.readbackCanonicalPayload as unknown as Record<string, unknown>,
          verified.snapshot as unknown as Record<string, unknown>,
        ),
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
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero draft exists but exact readback was not verified.", {
        httpStatus: 502,
        retryable: false,
        details: { xeroObjectId: objectId },
        cause: error,
      });
    }
  }

  #verifiedResult(request: {
    objectType: string;
    mutationRequestId: string;
    xeroObjectId?: string;
    writeReceipt?: Record<string, unknown>;
    readbackSnapshot?: Record<string, unknown>;
    state: string;
  }): ControlledDraftWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      (request.objectType !== "QUOTE" && request.objectType !== "PURCHASE_ORDER") ||
      !request.xeroObjectId || !request.writeReceipt || !request.readbackSnapshot
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The persisted Xero mutation is not readback-verified.", {
        httpStatus: 502,
      });
    }
    return {
      state: "DRAFT_READBACK_VERIFIED",
      object_type: request.objectType,
      xero_object_id: request.xeroObjectId,
      mutation_request_id: request.mutationRequestId,
      status: "DRAFT",
      receipt: request.writeReceipt,
      readback: request.readbackSnapshot,
    };
  }

  #controlledReadback(
    xeroObjectId: string,
    canonicalPayload: Record<string, unknown>,
    providerSnapshot: Record<string, unknown>,
  ) {
    const { canonicalPayload: snapshotCanonicalPayload, ...providerEvidence } = providerSnapshot;
    let effectiveCanonicalPayload = canonicalPayload;
    let effectiveEvidence: Record<string, unknown> = providerEvidence;
    if (
      snapshotCanonicalPayload !== undefined &&
      JSON.stringify(snapshotCanonicalPayload) !== JSON.stringify(canonicalPayload)
    ) {
      if (!snapshotCanonicalPayload || typeof snapshotCanonicalPayload !== "object" || Array.isArray(snapshotCanonicalPayload)) {
        throw new AppError("WRITE_RESULT_UNKNOWN", "The provider readback projection is internally malformed.", {
          httpStatus: 502,
          retryable: false,
        });
      }
      effectiveCanonicalPayload = snapshotCanonicalPayload as Record<string, unknown>;
      effectiveEvidence = {
        ...providerEvidence,
        providerProjectionConsistency: "MISMATCH",
        alternateCanonicalPayload: canonicalPayload,
      };
    }
    const status = effectiveCanonicalPayload.status;
    if (typeof status !== "string" || status.trim().length === 0) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero readback has no controlled business status.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    return {
      xeroObjectId,
      status,
      canonicalPayload: effectiveCanonicalPayload,
      evidence: effectiveEvidence,
    };
  }

  async #validateDocumentReferences(
    context: RequestContext,
    input: SupportedDraft,
  ): Promise<void> {
    const [contact, accounts, taxes] = await Promise.all([
      this.readProvider.getContact(context, input.contactId),
      this.readProvider.listAccounts(context),
      this.readProvider.listTaxRates(context),
    ]);
    if (!contact || (contact.status && contact.status !== "ACTIVE")) {
      throw safeValidation("The exact Xero contact is unavailable or inactive.", { path: "contact_id" });
    }
    for (const [index, line] of input.lines.entries()) {
      const account = exactActiveAccount(accounts, line.accountCode);
      if (!account) throw safeValidation("A line account is unavailable or protected.", { path: `lines[${index}].account_code` });
      if (!exactActiveTax(taxes, line.taxType, account)) {
        throw safeValidation("A line tax type is inactive, ambiguous, or incompatible with its account.", {
          path: `lines[${index}].tax_type`,
        });
      }
      if (line.itemCode) {
        const item = await this.writeProvider.getItemByCode(context, line.itemCode);
        if (!item || item.code !== line.itemCode || item.projectionIncomplete) {
          throw safeValidation("The exact Xero item code could not be verified.", { path: `lines[${index}].item_code` });
        }
        if (input.objectType === "QUOTE" && item.isSold !== true) {
          throw safeValidation("The Xero item is not enabled for sales.", { path: `lines[${index}].item_code` });
        }
        if (input.objectType === "PURCHASE_ORDER" && item.isPurchased !== true) {
          throw safeValidation("The Xero item is not enabled for purchases.", { path: `lines[${index}].item_code` });
        }
      }
    }
    const trackingIds = input.lines.flatMap((line) => line.trackingOptionIds);
    const tracking = await this.writeProvider.resolveTrackingOptionIds(context, trackingIds);
    if (!tracking.complete) throw safeValidation("One or more tracking options could not be resolved exactly.", { path: "lines.tracking_option_ids" });
  }

  async #assertWriteAuthority(
    context: RequestContext,
    actionId: "quote.create_draft" | "purchase_order.create_draft",
  ): Promise<void> {
    const [status, tenant] = await Promise.all([
      this.readProvider.connectionStatus(context),
      this.readProvider.resolveContext(context),
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
    });
    if (!decision.allowed) {
      throw xeroCapabilityDenied(
        "This Xero draft operation is not currently authorised.",
        decision.denyReasons,
      );
    }
  }
}
