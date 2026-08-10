import type { AccountingProvider, AccountSummary, TaxRateSummary } from "../providers/types.js";
import type { CreditNoteManualJournalWriteProvider } from "../providers/xeroCreditNoteManualJournalProvider.js";
import {
  allowedWriteTenantForRequest,
  type RequestContext,
} from "../security/requestContext.js";
import type { ExecutePreparedXeroMutationInput } from "../domain/xeroControlledMutationSchemas.js";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
  parseCanonicalCreditNoteDraftPayload,
  parseCanonicalManualJournalDraftPayload,
  prepareCreditNoteDraftInputSchema,
  prepareManualJournalDraftInputSchema,
  type CanonicalCreditNoteDraftPayload,
  type CanonicalManualJournalDraftPayload,
  type PrepareCreditNoteDraftInput,
  type PrepareManualJournalDraftInput,
  type PreparedCreditNoteDraft,
  type PreparedManualJournalDraft,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import { executePreparedXeroMutationSchema } from "../domain/xeroControlledMutationSchemas.js";
import { XeroMutationService } from "./xeroMutationService.js";
import { AppError } from "../errors.js";

type SupportedObjectType = "CREDIT_NOTE" | "MANUAL_JOURNAL";
type SupportedDraft = CanonicalCreditNoteDraftPayload | CanonicalManualJournalDraftPayload;
type SupportedPrimitive = PreparedCreditNoteDraft | PreparedManualJournalDraft;

export interface CreditNoteManualJournalRuntimeConfig {
  xeroWriteEnabled: boolean;
  xeroAllowedTenantId?: string;
}

export interface LedgerAdjustmentDraftPreparationResult {
  preparation_id: string;
  state: "PREPARED";
  object_type: SupportedObjectType;
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
  confirmation_phrase: string;
  expires_at: string;
  execution_allowed_before_confirmation: false;
  warning: string;
}

export interface LedgerAdjustmentDraftWriteResult {
  state: "DRAFT_READBACK_VERIFIED";
  object_type: SupportedObjectType;
  xero_object_id: string;
  mutation_request_id: string;
  status: "DRAFT";
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
}

function exactActiveUnprotectedAccount(
  accounts: readonly AccountSummary[],
  accountId: string,
  accountCode: string,
): AccountSummary | undefined {
  const matches = accounts.filter((account) =>
    account.accountId?.toLowerCase() === accountId.toLowerCase() &&
    account.code === accountCode &&
    (!account.status || account.status === "ACTIVE") &&
    account.type !== "BANK" &&
    !account.systemAccount);
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
    tax.taxType === taxType &&
    (!tax.status || tax.status === "ACTIVE") &&
    taxApplies(tax, account));
  return matches.length === 1 ? matches[0] : undefined;
}

function validationError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("VALIDATION_FAILED", message, {
    httpStatus: 422,
    ...(details ? { details } : {}),
  });
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function confirmationBase(primitivePhrase: string): string {
  // The mutation foundation appends the authoritative persisted source
  // fingerprint. Remove the primitive's pre-persistence display hash so the
  // accountant sees one source fingerprint rather than two similar values.
  return primitivePhrase.replace(/｜来源 [A-F0-9]{8}(?=｜校验)/u, "");
}

/**
 * Controlled ledger-adjustment draft workflow. This service is deliberately
 * not registered in MCP until the central capability policy is released. It
 * still validates every runtime authority prerequisite itself so later wiring
 * cannot bypass tenant, OAuth, Host-scope, confirmation, or write-gate checks.
 */
export class XeroCreditNoteManualJournalService {
  constructor(
    private readonly readProvider: AccountingProvider,
    private readonly writeProvider: CreditNoteManualJournalWriteProvider,
    private readonly mutations: XeroMutationService,
    private readonly config: CreditNoteManualJournalRuntimeConfig,
  ) {}

  async prepareCreditNoteDraft(
    context: RequestContext,
    rawInput: PrepareCreditNoteDraftInput,
  ): Promise<LedgerAdjustmentDraftPreparationResult> {
    const input = prepareCreditNoteDraftInputSchema.parse(rawInput);
    const prepared = buildCreditNoteDraftPrimitive(input);
    await this.#validateCreditNoteReferences(context, prepared.canonicalPayload);
    return this.#persistPreparation(context, prepared);
  }

  async prepareManualJournalDraft(
    context: RequestContext,
    rawInput: PrepareManualJournalDraftInput,
  ): Promise<LedgerAdjustmentDraftPreparationResult> {
    const input = prepareManualJournalDraftInputSchema.parse(rawInput);
    const prepared = buildManualJournalDraftPrimitive(input);
    await this.#validateManualJournalReferences(context, prepared.canonicalPayload);
    return this.#persistPreparation(context, prepared);
  }

  async createCreditNoteDraft(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<LedgerAdjustmentDraftWriteResult> {
    return this.#execute(context, rawInput, "CREDIT_NOTE");
  }

  async createManualJournalDraft(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
  ): Promise<LedgerAdjustmentDraftWriteResult> {
    return this.#execute(context, rawInput, "MANUAL_JOURNAL");
  }

  async #persistPreparation(
    context: RequestContext,
    prepared: SupportedPrimitive,
  ): Promise<LedgerAdjustmentDraftPreparationResult> {
    const confirmationDetails = prepared.objectType === "CREDIT_NOTE"
      ? {
          contactId: prepared.canonicalPayload.contactId,
          creditNoteType: prepared.canonicalPayload.creditNoteType,
          currency: prepared.canonicalPayload.currency,
          enteredLineSubtotal: prepared.canonicalPayload.enteredLineSubtotal,
          lineCount: prepared.canonicalPayload.lines.length,
          reason: prepared.reason,
          status: "DRAFT",
        }
      : {
          journalDate: prepared.canonicalPayload.journalDate,
          debitTotal: prepared.canonicalPayload.debitTotal,
          creditTotal: prepared.canonicalPayload.creditTotal,
          lineCount: prepared.canonicalPayload.lines.length,
          taxTreatment: "NoTax/NONE",
          status: "DRAFT",
        };
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
      confirmationDetails,
      confirmationPhrase: confirmationBase(prepared.confirmationPhrase),
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
      confirmation_phrase: persisted.confirmationPhrase,
      expires_at: persisted.expiresAt.toISOString(),
      execution_allowed_before_confirmation: false,
      warning: "The draft is tenant-bound and readback-verified, but source evidence remains conversation-attested unless the Host later supplies a signed file receipt.",
    };
  }

  async #execute(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput,
    expectedObjectType: SupportedObjectType,
  ): Promise<LedgerAdjustmentDraftWriteResult> {
    const input = executePreparedXeroMutationSchema.parse(rawInput);
    await this.#assertWriteAuthority(context, expectedObjectType);
    const confirmed = await this.mutations.confirm(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
      confirmationPhrase: input.confirmation_phrase,
    }, { objectType: expectedObjectType, operation: "CREATE_DRAFT" });
    if (confirmed.objectType !== expectedObjectType || confirmed.operation !== "CREATE_DRAFT") {
      throw new AppError("APPROVAL_INVALID", "The confirmed preparation is for a different Xero object.", {
        httpStatus: 409,
      });
    }
    const expected = expectedObjectType === "CREDIT_NOTE"
      ? parseCanonicalCreditNoteDraftPayload(confirmed.canonicalPayload)
      : parseCanonicalManualJournalDraftPayload(confirmed.canonicalPayload);
    try {
      if (expected.objectType === "CREDIT_NOTE") {
        await this.#validateCreditNoteReferences(context, expected);
      } else {
        await this.#validateManualJournalReferences(context, expected);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
        await this.mutations.failValidation(context, {
          mutationRequestId: confirmed.mutationRequestId,
          validationReceipt: {
            reasonCode: "PREWRITE_REFERENCE_REVALIDATION_FAILED",
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }
      throw error;
    }
    const started = await this.mutations.start(context, { mutationRequestId: confirmed.mutationRequestId });
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request);

    let objectId = started.request.xeroObjectId;
    let receipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let providerWriteSucceeded = false;
      try {
        const created = expectedObjectType === "CREDIT_NOTE"
          ? await this.writeProvider.createCreditNoteDraft(
              context,
              expected as CanonicalCreditNoteDraftPayload,
              confirmed.mutationRequestId,
            )
          : await this.writeProvider.createManualJournalDraft(
              context,
              expected as CanonicalManualJournalDraftPayload,
              confirmed.mutationRequestId,
            );
        objectId = created.objectId;
        receipt = created.receipt;
        providerWriteSucceeded = true;
        // The provider has confirmed a concrete object. Persist that durable
        // evidence before any GET so a process failure during readback cannot
        // lose the exact recovery target or invite a duplicate create.
        await this.mutations.recordWriteEvidence(context, {
          mutationRequestId: confirmed.mutationRequestId,
          xeroObjectId: objectId,
          writeReceipt: receipt,
        });
      } catch (error) {
        if (providerWriteSucceeded) {
          try {
            await this.mutations.markUnknown(context, {
              mutationRequestId: confirmed.mutationRequestId,
              ...(objectId ? { xeroObjectId: objectId } : {}),
              ...(receipt ? { writeReceipt: receipt } : {}),
            });
          } catch {
            // Preserve the primary fail-closed outcome and return only the exact
            // Xero ID needed for operator recovery. Never misclassify this as a
            // definite provider rejection.
          }
          throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero draft exists but its write evidence could not be durably recorded.", {
            httpStatus: 502,
            retryable: false,
            ...(objectId ? { details: { xeroObjectId: objectId } } : {}),
            cause: error,
          });
        } else if (
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
          await this.mutations.markUnknown(context, {
            mutationRequestId: confirmed.mutationRequestId,
          });
        }
        throw error;
      }
    }

    if (!objectId || !receipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero write has no exact object ID for safe recovery.", {
        httpStatus: 502,
        retryable: false,
      });
    }

    try {
      const verified = expectedObjectType === "CREDIT_NOTE"
        ? await this.writeProvider.readAndVerifyCreditNoteDraft(
            context,
            objectId,
            expected as CanonicalCreditNoteDraftPayload,
          )
        : await this.writeProvider.readAndVerifyManualJournalDraft(
            context,
            objectId,
            expected as CanonicalManualJournalDraftPayload,
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
            details: { outcome: recovered.outcome, xeroObjectId: objectId },
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
  }): LedgerAdjustmentDraftWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      (request.objectType !== "CREDIT_NOTE" && request.objectType !== "MANUAL_JOURNAL") ||
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
    return {
      xeroObjectId,
      status: typeof effectiveCanonicalPayload.status === "string"
        ? effectiveCanonicalPayload.status
        : "UNKNOWN",
      canonicalPayload: effectiveCanonicalPayload,
      evidence: effectiveEvidence,
    };
  }

  async #validateCreditNoteReferences(
    context: RequestContext,
    input: CanonicalCreditNoteDraftPayload,
  ): Promise<void> {
    const [contact, accounts, taxes] = await Promise.all([
      this.readProvider.getContact(context, input.contactId),
      this.readProvider.listAccounts(context),
      this.readProvider.listTaxRates(context),
    ]);
    if (
      !contact || contact.contactId.toLowerCase() !== input.contactId.toLowerCase() ||
      (contact.status && contact.status !== "ACTIVE")
    ) {
      throw validationError("The exact Xero contact is unavailable or inactive.", { path: "contact_id" });
    }
    for (const [index, line] of input.lines.entries()) {
      const account = exactActiveUnprotectedAccount(accounts, line.accountId, line.accountCode);
      if (!account) {
        throw validationError("A line account ID/code pair is unavailable, ambiguous, inactive, or protected.", {
          path: `lines[${index}].account_id`,
        });
      }
      if (!exactActiveTax(taxes, line.taxType, account)) {
        throw validationError("A line tax type is inactive, ambiguous, or incompatible with its exact account.", {
          path: `lines[${index}].tax_type`,
        });
      }
      if (line.itemCode) {
        const item = await this.writeProvider.getItemByCode(context, line.itemCode);
        if (!item || item.code !== line.itemCode || item.projectionIncomplete) {
          throw validationError("The exact Xero item code could not be verified.", {
            path: `lines[${index}].item_code`,
          });
        }
        const correctSide = input.creditNoteType === "ACCRECCREDIT" ? item.isSold === true : item.isPurchased === true;
        if (!correctSide) {
          throw validationError("The Xero item is not enabled for this credit-note side.", {
            path: `lines[${index}].item_code`,
          });
        }
      }
    }
    await this.#validateTracking(context, input.lines.flatMap((line) => line.trackingOptionIds));
  }

  async #validateManualJournalReferences(
    context: RequestContext,
    input: CanonicalManualJournalDraftPayload,
  ): Promise<void> {
    const accounts = await this.readProvider.listAccounts(context);
    for (const [index, line] of input.lines.entries()) {
      if (!exactActiveUnprotectedAccount(accounts, line.accountId, line.accountCode)) {
        throw validationError("A journal account ID/code pair is unavailable, ambiguous, inactive, or protected.", {
          path: `lines[${index}].account_id`,
        });
      }
    }
    await this.#validateTracking(context, input.lines.flatMap((line) => line.trackingOptionIds));
  }

  async #validateTracking(context: RequestContext, trackingIds: readonly string[]): Promise<void> {
    const tracking = await this.writeProvider.resolveTrackingOptionIds(context, trackingIds);
    if (!tracking.complete) {
      throw validationError("One or more tracking options could not be resolved exactly.", {
        path: "lines.tracking_option_ids",
      });
    }
  }

  async #assertWriteAuthority(context: RequestContext, objectType: SupportedObjectType): Promise<void> {
    const [status, tenant] = await Promise.all([
      this.readProvider.connectionStatus(context),
      this.readProvider.resolveContext(context),
    ]);
    const denyReasons: string[] = [];
    if (!status.connected || !nonEmpty(context.connectionId)) denyReasons.push("CONNECTION_NOT_READY");
    if (!status.tenant?.id || status.tenant.id !== tenant.tenantId) denyReasons.push("TENANT_BINDING_MISMATCH");
    if (!context.scopes.includes("xero.draft.write")) denyReasons.push("MISSING_MCP_SCOPE");
    const oauthScopes = new Set(status.scopes);
    const hasObjectWriteScope = objectType === "CREDIT_NOTE"
      ? oauthScopes.has("accounting.invoices") || oauthScopes.has("accounting.transactions")
      : oauthScopes.has("accounting.manualjournals");
    if (!hasObjectWriteScope) denyReasons.push("MISSING_XERO_OAUTH_SCOPE");
    if (!this.config.xeroWriteEnabled) denyReasons.push("WRITE_GATE_CLOSED");
    const allowedWriteTenantId = allowedWriteTenantForRequest(
      context,
      tenant.tenantId,
      this.config.xeroAllowedTenantId,
    );
    if (!nonEmpty(allowedWriteTenantId) || allowedWriteTenantId !== tenant.tenantId) {
      denyReasons.push("WRITE_TENANT_NOT_ALLOWED");
    }
    if (denyReasons.length > 0) {
      throw new AppError("FORBIDDEN", "This Xero draft operation is not currently authorised.", {
        httpStatus: 403,
        details: { denyReasons },
      });
    }
  }
}
