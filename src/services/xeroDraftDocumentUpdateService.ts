import type {
  DraftDocumentUpdateAction,
} from "../domain/accountingCase.js";
import type {
  CanonicalPurchaseOrderDraftPayload,
  CanonicalQuoteDraftPayload,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import {
  parseCanonicalPurchaseOrderDraftPayload,
  parseCanonicalQuoteDraftPayload,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import type {
  CanonicalCreditNoteDraftPayload,
  CanonicalManualJournalDraftPayload,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import {
  parseCanonicalCreditNoteDraftPayload,
  parseCanonicalManualJournalDraftPayload,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import type { ExecutePreparedXeroMutationInput } from "../domain/xeroControlledMutationSchemas.js";
import { executePreparedXeroMutationSchema } from "../domain/xeroControlledMutationSchemas.js";
import type { XeroMutationObjectType, XeroMutationRequest } from "../domain/xeroMutation.js";
import { AppError } from "../errors.js";
import type { XeroControlledMutationProvider } from "../providers/xeroControlledMutationProvider.js";
import type { CreditNoteManualJournalWriteProvider } from "../providers/xeroCreditNoteManualJournalProvider.js";
import type {
  AccountingProvider,
  AccountingPrincipal,
  InvoiceSnapshot,
  ProviderDraftWriteEvidence,
  ProviderSalesInvoiceWriteResult,
  ProviderWriteResult,
} from "../providers/types.js";
import type { InvoiceDraftUpdateCanonicalPayload } from "../providers/xeroProvider.js";
import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import { allowedWriteTenantForRequest, type RequestContext } from "../security/requestContext.js";
import { xeroCapabilityDenied } from "../policy/xeroCapabilityError.js";
import { hashObject, stableStringify } from "../security/hash.js";
import { XeroMutationService } from "./xeroMutationService.js";

export interface DraftDocumentUpdateEnvelope {
  targetXeroObjectId: string;
  expectedUpdatedAt: string;
  replacement: Record<string, unknown>;
}

export interface PrepareDraftDocumentUpdateInput extends DraftDocumentUpdateEnvelope {
  actionId: DraftDocumentUpdateAction;
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
}

export interface DraftDocumentUpdatePreparationResult {
  preparation_id: string;
  state: "PREPARED";
  object_type: XeroMutationObjectType;
  operation: "UPDATE";
  canonical_payload_hash: string;
  expires_at: string;
}

export interface DraftDocumentUpdateWriteResult {
  state: "DRAFT_READBACK_VERIFIED";
  object_type: XeroMutationObjectType;
  xero_object_id: string;
  mutation_request_id: string;
  status: "DRAFT";
  receipt: Record<string, unknown>;
  readback: Record<string, unknown>;
}

type InvoiceUpdateProvider = AccountingProvider & {
  updateDraftSupplierBill(
    principal: AccountingPrincipal,
    targetXeroObjectId: string,
    expectedUpdatedAt: string,
    input: InvoiceDraftUpdateCanonicalPayload,
    idempotencyKey: string,
    recordWriteEvidence?: (evidence: ProviderDraftWriteEvidence) => Promise<void>,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderWriteResult>;
  updateDraftSalesInvoice(
    principal: AccountingPrincipal,
    targetXeroObjectId: string,
    expectedUpdatedAt: string,
    input: InvoiceDraftUpdateCanonicalPayload,
    idempotencyKey: string,
    recordWriteEvidence?: (evidence: ProviderDraftWriteEvidence) => Promise<void>,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ): Promise<ProviderSalesInvoiceWriteResult>;
};

type ProviderReplacement =
  | InvoiceDraftUpdateCanonicalPayload
  | CanonicalQuoteDraftPayload
  | CanonicalPurchaseOrderDraftPayload
  | CanonicalCreditNoteDraftPayload
  | CanonicalManualJournalDraftPayload;

const ACTION_OBJECT_TYPE: Readonly<Record<DraftDocumentUpdateAction, XeroMutationObjectType>> = Object.freeze({
  "customer_invoice.update_draft": "SALES_INVOICE",
  "supplier_bill.update_draft": "SUPPLIER_BILL",
  "quote.update_draft": "QUOTE",
  "purchase_order.update_draft": "PURCHASE_ORDER",
  "credit_note.update_draft": "CREDIT_NOTE",
  "manual_journal.update_draft": "MANUAL_JOURNAL",
});

const ISO_OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function exactTargetId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new AppError("VALIDATION_FAILED", "A DRAFT document update requires an exact Xero UUID.", {
      httpStatus: 422,
      details: { path: "targetXeroObjectId", providerMutationPossible: false },
    });
  }
  return value.toLowerCase();
}

function expectedInstant(value: string): string {
  if (!ISO_OFFSET_DATETIME.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new AppError("VALIDATION_FAILED", "expectedUpdatedAt must be an ISO datetime with an explicit offset.", {
      httpStatus: 422,
      details: { path: "expectedUpdatedAt", providerMutationPossible: false },
    });
  }
  return value;
}

function invoiceReplacement(input: unknown): InvoiceDraftUpdateCanonicalPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("VALIDATION_FAILED", "The invoice replacement must be a complete canonical object.", {
      httpStatus: 422,
    });
  }
  const replacement = input as Record<string, unknown>;
  if (replacement.status !== "DRAFT" || !Array.isArray(replacement.lines) || replacement.lines.length === 0) {
    throw new AppError("VALIDATION_FAILED", "The invoice replacement must be complete and remain DRAFT.", {
      httpStatus: 422,
    });
  }
  return replacement;
}

function providerReplacement(actionId: DraftDocumentUpdateAction, input: unknown): ProviderReplacement {
  switch (actionId) {
    case "customer_invoice.update_draft":
    case "supplier_bill.update_draft":
      return invoiceReplacement(input);
    case "quote.update_draft":
      return parseCanonicalQuoteDraftPayload(input);
    case "purchase_order.update_draft":
      return parseCanonicalPurchaseOrderDraftPayload(input);
    case "credit_note.update_draft":
      return parseCanonicalCreditNoteDraftPayload(input);
    case "manual_journal.update_draft":
      return parseCanonicalManualJournalDraftPayload(input);
    default: {
      const unreachable: never = actionId;
      throw new AppError("VALIDATION_FAILED", `Unsupported DRAFT update action: ${String(unreachable)}`, {
        httpStatus: 422,
      });
    }
  }
}

function canonicalEnvelope(input: Pick<PrepareDraftDocumentUpdateInput,
  "actionId" | "targetXeroObjectId" | "expectedUpdatedAt" | "replacement">): DraftDocumentUpdateEnvelope {
  return Object.freeze({
    targetXeroObjectId: exactTargetId(input.targetXeroObjectId),
    expectedUpdatedAt: expectedInstant(input.expectedUpdatedAt),
    replacement: providerReplacement(input.actionId, input.replacement) as unknown as Record<string, unknown>,
  });
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/**
 * One mutation lifecycle for all six exact-target DRAFT replacements. Object
 * adapters retain their own precondition and same-ID readback semantics; this
 * service owns the shared preparation, permit, evidence and GET-only recovery.
 */
export class XeroDraftDocumentUpdateService {
  constructor(
    private readonly invoiceProvider: InvoiceUpdateProvider,
    private readonly commercialProvider: XeroControlledMutationProvider,
    private readonly adjustmentProvider: CreditNoteManualJournalWriteProvider,
    private readonly mutations: XeroMutationService,
    private readonly config: { xeroWriteEnabled: boolean; xeroAllowedTenantId?: string },
  ) {}

  async prepare(
    context: RequestContext,
    input: PrepareDraftDocumentUpdateInput,
  ): Promise<DraftDocumentUpdatePreparationResult> {
    const objectType = ACTION_OBJECT_TYPE[input.actionId];
    const envelope = canonicalEnvelope(input);
    const prepared = await this.mutations.prepare(context, {
      objectType,
      operation: "UPDATE",
      targetXeroObjectId: envelope.targetXeroObjectId,
      canonicalPayload: envelope as unknown as Record<string, unknown>,
      sourceRef: input.sourceRef,
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256: input.sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: {
        actionId: input.actionId,
        targetXeroObjectId: envelope.targetXeroObjectId,
        expectedUpdatedAt: envelope.expectedUpdatedAt,
        replacementHash: hashObject(envelope.replacement),
        status: "DRAFT",
      },
    });
    return {
      preparation_id: prepared.preparationId,
      state: "PREPARED",
      object_type: objectType,
      operation: "UPDATE",
      canonical_payload_hash: prepared.canonicalPayloadHash,
      expires_at: prepared.expiresAt.toISOString(),
    };
  }

  async execute(
    context: RequestContext,
    rawInput: ExecutePreparedXeroMutationInput & { actionId: DraftDocumentUpdateAction },
    beforeProviderClaimValidation: (envelope: DraftDocumentUpdateEnvelope) => Promise<void>,
  ): Promise<DraftDocumentUpdateWriteResult> {
    const { actionId, ...executionInput } = rawInput;
    const input = executePreparedXeroMutationSchema.parse(executionInput);
    const objectType = ACTION_OBJECT_TYPE[actionId];
    const expectation = { objectType, operation: "UPDATE" as const };
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, expectation);
    if (!recovery) await this.#assertWriteAuthority(context, actionId, objectType);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, expectation);
    const stored = preparation.canonicalPayload;
    const envelope = canonicalEnvelope({
      actionId,
      targetXeroObjectId: String(stored.targetXeroObjectId ?? ""),
      expectedUpdatedAt: String(stored.expectedUpdatedAt ?? ""),
      replacement: stored.replacement as Record<string, unknown>,
    });
    if (preparation.targetXeroObjectId?.toLowerCase() !== envelope.targetXeroObjectId) {
      throw new AppError("PERSISTENCE_FAILURE", "The DRAFT update target binding changed after preparation.", {
        httpStatus: 503,
      });
    }
    const validationReceipt = issueObjectPreparationValidationReceipt({
      actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-accounting-case-draft-update-v1",
      checks: [
        { code: "CANONICAL_SCHEMA_VALID", evidence: { objectType, operation: "UPDATE" } },
        {
          code: "EXACT_TARGET_VERSION_AND_FULL_DRAFT_REPLACEMENT_SEALED",
          evidence: {
            targetXeroObjectId: envelope.targetXeroObjectId,
            expectedUpdatedAt: envelope.expectedUpdatedAt,
            replacementHash: hashObject(envelope.replacement),
          },
        },
      ],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(
      context,
      { preparationId: input.preparation_id, requestId: input.request_id },
      expectation,
      validationReceipt,
      () => beforeProviderClaimValidation(envelope),
    );
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request);

    const request = started.request;
    let receipt = request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      try {
        const providerResult = await this.#callProvider(
          context,
          actionId,
          envelope,
          request.mutationRequestId,
          started.providerWritePermit,
        );
        receipt = providerResult.receipt;
        if (!providerResult.evidencePersisted) {
          await this.mutations.recordWriteEvidence(context, {
            mutationRequestId: request.mutationRequestId,
            xeroObjectId: envelope.targetXeroObjectId,
            writeReceipt: receipt,
          });
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          error.retryable === false &&
          error.details?.writeOutcome === "DEFINITELY_REJECTED"
        ) {
          await this.mutations.rejectProvider(context, {
            mutationRequestId: request.mutationRequestId,
            providerRejectionReceipt: {
              errorCode: error.code,
              httpStatus: error.httpStatus,
              retryable: false,
              writeOutcome: "DEFINITELY_REJECTED",
              ...(error.details ? { providerDetails: error.details } : {}),
            },
          });
        } else {
          // Updates always know their exact target. Persist it even when the
          // transport outcome is unknown, so resumeAutonomousRecovery can only
          // issue RECOVER_ONLY and can never claim a replay permit.
          await this.mutations.markUnknown(context, {
            mutationRequestId: request.mutationRequestId,
            xeroObjectId: envelope.targetXeroObjectId,
            ...(receipt ? { writeReceipt: receipt } : {}),
          });
        }
        throw error;
      }
    }

    if (!receipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The DRAFT update has no durable provider receipt.", {
        httpStatus: 502,
        retryable: false,
        details: { xeroObjectId: envelope.targetXeroObjectId },
      });
    }

    try {
      const readback = await this.#readAndVerify(context, actionId, envelope);
      const verifiedReadback = {
        xeroObjectId: envelope.targetXeroObjectId,
        status: "DRAFT",
        canonicalPayload: envelope as unknown as Record<string, unknown>,
        evidence: readback,
      };
      const completed = started.mode === "RECOVER_ONLY"
        ? (await this.mutations.recover(context, {
            mutationRequestId: request.mutationRequestId,
            writeReceipt: receipt,
            verifiedReadback,
          })).request
        : await this.mutations.markReadbackVerified(context, {
            mutationRequestId: request.mutationRequestId,
            writeReceipt: receipt,
            verifiedReadback,
          });
      return this.#verifiedResult(completed);
    } catch (error) {
      await this.mutations.markUnknown(context, {
        mutationRequestId: request.mutationRequestId,
        xeroObjectId: envelope.targetXeroObjectId,
        writeReceipt: receipt,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "The exact updated DRAFT could not be read back and verified.", {
        httpStatus: 502,
        retryable: false,
        details: { xeroObjectId: envelope.targetXeroObjectId },
        cause: error,
      });
    }
  }

  async #callProvider(
    context: RequestContext,
    actionId: DraftDocumentUpdateAction,
    envelope: DraftDocumentUpdateEnvelope,
    mutationRequestId: string,
    permit: Parameters<XeroControlledMutationProvider["updateQuoteDraft"]>[5],
  ): Promise<{ receipt: Record<string, unknown>; evidencePersisted: boolean }> {
    const replacement = providerReplacement(actionId, envelope.replacement);
    if (actionId === "customer_invoice.update_draft" || actionId === "supplier_bill.update_draft") {
      let persisted = false;
      const recordEvidence = async (evidence: ProviderDraftWriteEvidence) => {
        await this.mutations.recordWriteEvidence(context, {
          mutationRequestId,
          xeroObjectId: envelope.targetXeroObjectId,
          writeReceipt: evidence.receipt,
        });
        persisted = true;
      };
      const result = actionId === "supplier_bill.update_draft"
        ? await this.invoiceProvider.updateDraftSupplierBill(
            context,
            envelope.targetXeroObjectId,
            envelope.expectedUpdatedAt,
            replacement as InvoiceDraftUpdateCanonicalPayload,
            mutationRequestId,
            recordEvidence,
            permit,
            mutationRequestId,
          )
        : await this.invoiceProvider.updateDraftSalesInvoice(
            context,
            envelope.targetXeroObjectId,
            envelope.expectedUpdatedAt,
            replacement as InvoiceDraftUpdateCanonicalPayload,
            mutationRequestId,
            recordEvidence,
            permit,
            mutationRequestId,
          );
      return { receipt: result.receipt, evidencePersisted: persisted };
    }
    const result = actionId === "quote.update_draft"
      ? await this.commercialProvider.updateQuoteDraft(
          context, envelope.targetXeroObjectId, envelope.expectedUpdatedAt,
          replacement as CanonicalQuoteDraftPayload, mutationRequestId, permit,
        )
      : actionId === "purchase_order.update_draft"
        ? await this.commercialProvider.updatePurchaseOrderDraft(
            context, envelope.targetXeroObjectId, envelope.expectedUpdatedAt,
            replacement as CanonicalPurchaseOrderDraftPayload, mutationRequestId, permit,
          )
        : actionId === "credit_note.update_draft"
          ? await this.adjustmentProvider.updateCreditNoteDraft(
              context, envelope.targetXeroObjectId, envelope.expectedUpdatedAt,
              replacement as CanonicalCreditNoteDraftPayload, mutationRequestId, permit,
            )
          : await this.adjustmentProvider.updateManualJournalDraft(
              context, envelope.targetXeroObjectId, envelope.expectedUpdatedAt,
              replacement as CanonicalManualJournalDraftPayload, mutationRequestId, permit,
            );
    if (result.objectId.toLowerCase() !== envelope.targetXeroObjectId) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned a different object ID for the DRAFT replacement.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    return { receipt: result.receipt, evidencePersisted: false };
  }

  async #readAndVerify(
    context: RequestContext,
    actionId: DraftDocumentUpdateAction,
    envelope: DraftDocumentUpdateEnvelope,
  ): Promise<Record<string, unknown>> {
    const replacement = providerReplacement(actionId, envelope.replacement);
    if (actionId === "customer_invoice.update_draft" || actionId === "supplier_bill.update_draft") {
      const expectedType = actionId === "supplier_bill.update_draft" ? "ACCPAY" : "ACCREC";
      const snapshot = await this.invoiceProvider.getInvoice(context, envelope.targetXeroObjectId, expectedType);
      const mismatchFields = this.#invoiceReadbackMismatches(
        snapshot,
        replacement as InvoiceDraftUpdateCanonicalPayload,
        envelope.targetXeroObjectId,
        expectedType,
      );
      if (mismatchFields.length > 0) {
        throw new AppError("READBACK_MISMATCH", "The exact invoice DRAFT readback differs from the replacement.", {
          httpStatus: 409,
          details: { xeroObjectId: envelope.targetXeroObjectId, mismatchFields },
        });
      }
      return snapshot as unknown as Record<string, unknown>;
    }
    const verified = actionId === "quote.update_draft"
      ? await this.commercialProvider.readAndVerifyQuoteDraft(
          context, envelope.targetXeroObjectId, replacement as CanonicalQuoteDraftPayload,
        )
      : actionId === "purchase_order.update_draft"
        ? await this.commercialProvider.readAndVerifyPurchaseOrderDraft(
            context, envelope.targetXeroObjectId, replacement as CanonicalPurchaseOrderDraftPayload,
          )
        : actionId === "credit_note.update_draft"
          ? await this.adjustmentProvider.readAndVerifyCreditNoteDraft(
              context, envelope.targetXeroObjectId, replacement as CanonicalCreditNoteDraftPayload,
            )
          : await this.adjustmentProvider.readAndVerifyManualJournalDraft(
              context, envelope.targetXeroObjectId, replacement as CanonicalManualJournalDraftPayload,
            );
    if (!verified.ok || !verified.snapshot) {
      throw new AppError("READBACK_MISMATCH", "The exact updated DRAFT failed canonical same-ID readback.", {
        httpStatus: 409,
        details: {
          xeroObjectId: envelope.targetXeroObjectId,
          ...("mismatchFields" in verified && verified.mismatchFields
            ? { mismatchFields: verified.mismatchFields }
            : {}),
        },
      });
    }
    return verified.snapshot as unknown as Record<string, unknown>;
  }

  #invoiceReadbackMismatches(
    actual: InvoiceSnapshot,
    expected: InvoiceDraftUpdateCanonicalPayload,
    targetId: string,
    expectedType: "ACCPAY" | "ACCREC",
  ): string[] {
    const value = expected as Record<string, unknown>;
    const lines = Array.isArray(value.lines) ? value.lines as Array<Record<string, unknown>> : [];
    const sameDecimal = (left: unknown, right: unknown) =>
      left !== undefined && right !== undefined && Number(left).toFixed(4) === Number(right).toFixed(4);
    const mismatches: string[] = [];
    if (actual.invoiceId.toLowerCase() !== targetId) mismatches.push("invoiceId");
    if (actual.type !== expectedType) mismatches.push("type");
    if (actual.status !== "DRAFT") mismatches.push("status");
    if (actual.contact.contactId.toLowerCase() !== String(value.xeroContactId ?? value.contactId ?? "").toLowerCase()) {
      mismatches.push("contactId");
    }
    if (actual.invoiceDate !== (value.documentDate ?? value.invoiceDate)) mismatches.push("invoiceDate");
    if (actual.dueDate !== value.dueDate) mismatches.push("dueDate");
    if (actual.currency !== value.currency) mismatches.push("currency");
    if (value.invoiceRate !== undefined && !sameDecimal(value.invoiceRate, actual.currencyRate)) mismatches.push("currencyRate");
    if (value.authoritativeProviderField === "REFERENCE") {
      if (actual.reference !== value.reference) mismatches.push("reference");
    } else if (actual.invoiceNumber !== value.reference) mismatches.push("invoiceNumber");
    const expectedLineAmountType = String(value.lineAmountType ?? "").replace(/[^A-Za-z]/gu, "").toUpperCase();
    const actualLineAmountType = String(actual.lineAmountType ?? "").replace(/[^A-Za-z]/gu, "").toUpperCase();
    if (expectedLineAmountType !== actualLineAmountType) mismatches.push("lineAmountType");
    if (actual.linesTruncated || actual.lineItemCount !== lines.length || actual.lines.length !== lines.length) {
      mismatches.push("lines");
    } else {
      lines.forEach((line, index) => {
        const observed = actual.lines[index];
        if (!observed || observed.description !== line.description ||
            !sameDecimal(line.quantity, observed.quantity) ||
            !sameDecimal(line.unitAmount, observed.unitAmount) ||
            observed.accountCode !== line.accountCode || observed.taxType !== line.taxType ||
            (typeof line.accountId === "string" && observed.accountId?.toLowerCase() !== line.accountId.toLowerCase())) {
          mismatches.push(`lines[${index}]`);
        }
      });
    }
    for (const [field, observed] of [
      ["net", actual.subTotal], ["tax", actual.totalTax], ["gross", actual.total],
    ] as const) {
      if (!sameDecimal(value[field], observed)) mismatches.push(field);
    }
    return [...new Set(mismatches)];
  }

  #verifiedResult(request: XeroMutationRequest): DraftDocumentUpdateWriteResult {
    if (request.state !== "READBACK_VERIFIED" || !request.xeroObjectId ||
        !request.writeReceipt || !request.readbackSnapshot) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The persisted DRAFT update is not readback-verified.", {
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

  async #assertWriteAuthority(
    context: RequestContext,
    actionId: DraftDocumentUpdateAction,
    objectType: XeroMutationObjectType,
  ): Promise<void> {
    const [status, tenant] = await Promise.all([
      this.invoiceProvider.connectionStatus(context),
      this.invoiceProvider.resolveContext(context),
    ]);
    const denyReasons: string[] = [];
    if (!status.connected || !nonEmpty(context.connectionId)) denyReasons.push("CONNECTION_NOT_READY");
    if (!status.tenant?.id || status.tenant.id !== tenant.tenantId) denyReasons.push("TENANT_BINDING_MISMATCH");
    if (!context.scopes.includes("xero.draft.write")) denyReasons.push("MISSING_MCP_SCOPE");
    const oauthScopes = new Set(status.scopes);
    const scopeAllowed = objectType === "MANUAL_JOURNAL"
      ? oauthScopes.has("accounting.manualjournals")
      : oauthScopes.has("accounting.invoices") || oauthScopes.has("accounting.transactions");
    if (!scopeAllowed) denyReasons.push("MISSING_XERO_OAUTH_SCOPE");
    if (!this.config.xeroWriteEnabled) denyReasons.push("WRITE_GATE_CLOSED");
    const allowedTenant = allowedWriteTenantForRequest(context, tenant.tenantId, this.config.xeroAllowedTenantId);
    if (!allowedTenant || allowedTenant !== tenant.tenantId) denyReasons.push("WRITE_TENANT_NOT_ALLOWED");
    if (denyReasons.length > 0) {
      throw xeroCapabilityDenied(`The ${actionId} action is not currently authorised.`, denyReasons);
    }
  }
}

export function assertPreparedDraftUpdateMatches(
  expected: DraftDocumentUpdateEnvelope,
  actual: DraftDocumentUpdateEnvelope,
): void {
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new AppError("PERSISTENCE_FAILURE", "The prepared provider DRAFT replacement differs from the compiled Case.", {
      httpStatus: 503,
      details: { reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"] },
    });
  }
}
