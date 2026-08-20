import { AppError } from "../errors.js";
import {
  ledgerAdjustmentExpectedReadbackStatus,
  ledgerAdjustmentObjectType,
  ledgerAdjustmentOperation,
  ledgerAdjustmentTargetId,
  parseLedgerAdjustmentPayload,
  type CanonicalLedgerAdjustmentPayload,
  type LedgerAdjustmentAction,
} from "../domain/xeroLedgerAdjustment.js";
import { parseAccountingFixedDecimal } from "../control-kernel/accountingMonetary.js";
import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";
import { hashObject } from "../security/hash.js";
import type { RequestContext } from "../security/requestContext.js";
import type { AccountingProvider, AccountingPrincipal } from "../providers/types.js";
import type {
  XeroLedgerAdjustmentProvider,
  XeroLedgerAdjustmentResult,
} from "../providers/xeroLedgerAdjustmentProvider.js";
import { XeroMutationService } from "./xeroMutationService.js";

export interface PrepareLedgerAdjustmentInput {
  actionId: LedgerAdjustmentAction;
  payload: CanonicalLedgerAdjustmentPayload;
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
}

export interface ExecuteLedgerAdjustmentInput {
  preparation_id: string;
  request_id: string;
  actionId: LedgerAdjustmentAction;
}

export interface LedgerAdjustmentWriteResult {
  mutation_request_id: string;
  xero_object_id: string;
  status: "AUTHORISED" | "VOIDED";
  provider_receipt: Record<string, unknown>;
  exact_readback: Record<string, unknown>;
}

type LedgerAdjustmentExpectation = Readonly<{
  actionId: LedgerAdjustmentAction;
  objectType: ReturnType<typeof ledgerAdjustmentObjectType>;
  operation: ReturnType<typeof ledgerAdjustmentOperation>;
  targetXeroObjectId: string;
  canonicalPayload: CanonicalLedgerAdjustmentPayload;
  finalStatus: "AUTHORISED" | "VOIDED";
}>;

function expectationFor(actionId: LedgerAdjustmentAction, rawPayload: unknown): LedgerAdjustmentExpectation {
  const canonicalPayload = parseLedgerAdjustmentPayload(actionId, rawPayload);
  return {
    actionId,
    objectType: ledgerAdjustmentObjectType(actionId),
    operation: ledgerAdjustmentOperation(actionId),
    targetXeroObjectId: ledgerAdjustmentTargetId(canonicalPayload),
    canonicalPayload,
    finalStatus: ledgerAdjustmentExpectedReadbackStatus(actionId),
  };
}

function stale(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("STALE_PREFLIGHT", message, {
    httpStatus: 409,
    retryable: false,
    details: { providerMutationPossible: false, ...(details ?? {}) },
  });
}

function unavailable(message: string, cause?: unknown): AppError {
  return new AppError("PROVIDER_UNAVAILABLE", message, {
    httpStatus: 503,
    retryable: true,
    ...(cause ? { cause } : {}),
    details: { providerMutationPossible: false, phase: "LEDGER_ADJUSTMENT_PREFLIGHT" },
  });
}

function definiteRejection(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.writeOutcome === "DEFINITELY_REJECTED";
}

function exactZero(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return parseAccountingFixedDecimal(value) === 0n;
  } catch {
    return false;
  }
}

function atLeast(value: string | undefined, amount: string): boolean {
  if (value === undefined) return false;
  try {
    return parseAccountingFixedDecimal(value) >= parseAccountingFixedDecimal(amount);
  } catch {
    return false;
  }
}

/**
 * Closed Case execution for the eight non-draft ledger adjustments. Preflight
 * is repeated immediately before the one-shot provider claim; post-write work
 * is GET-only and starts only after the provider receipt has been persisted.
 */
export class XeroLedgerAdjustmentService {
  constructor(
    private readonly readProvider: AccountingProvider,
    private readonly writeProvider: XeroLedgerAdjustmentProvider,
    private readonly mutations: XeroMutationService,
  ) {}

  async prepare(
    context: RequestContext,
    input: PrepareLedgerAdjustmentInput,
  ): Promise<{ preparation_id: string }> {
    const expected = expectationFor(input.actionId, input.payload);
    await this.#preflight(context, expected);
    const prepared = await this.mutations.prepare(context, {
      objectType: expected.objectType,
      operation: expected.operation,
      targetXeroObjectId: expected.targetXeroObjectId,
      canonicalPayload: expected.canonicalPayload,
      sourceRef: input.sourceRef,
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256: input.sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: {
        actionId: expected.actionId,
        targetXeroObjectId: expected.targetXeroObjectId,
        expectedFinalStatus: expected.finalStatus,
      },
    });
    return { preparation_id: prepared.preparationId };
  }

  async execute(
    context: RequestContext,
    input: ExecuteLedgerAdjustmentInput,
  ): Promise<LedgerAdjustmentWriteResult> {
    const operationExpectation = {
      objectType: ledgerAdjustmentObjectType(input.actionId),
      operation: ledgerAdjustmentOperation(input.actionId),
    } as const;
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, operationExpectation);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, operationExpectation);
    const expected = expectationFor(input.actionId, preparation.canonicalPayload);
    if (
      preparation.objectType !== expected.objectType ||
      preparation.operation !== expected.operation ||
      preparation.targetXeroObjectId?.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() ||
      hashObject(preparation.canonicalPayload) !== hashObject(expected.canonicalPayload)
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger-adjustment preparation does not match its closed action.", {
        httpStatus: 503,
      });
    }
    if (!recovery) await this.#preflight(context, expected);
    const validationReceipt = issueObjectPreparationValidationReceipt({
      actionId: expected.actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-ledger-adjustment-v1",
      checks: [{
        code: "EXACT_TARGET_AND_LEDGER_PRECONDITIONS_REVALIDATED",
        evidence: {
          targetXeroObjectId: expected.targetXeroObjectId,
          objectType: expected.objectType,
          operation: expected.operation,
        },
      }],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(
      context,
      { preparationId: input.preparation_id, requestId: input.request_id },
      operationExpectation,
      validationReceipt,
      async () => { await this.#preflight(context, expected); },
    );
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request, expected);
    if (recovery && started.mode === "CALL_PROVIDER") {
      await this.mutations.markUnknown(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: expected.targetXeroObjectId,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Ledger-adjustment recovery is exact GET-only and cannot replay the write.", {
        httpStatus: 409,
        retryable: false,
        details: { targetXeroObjectId: expected.targetXeroObjectId, recoveryAction: "READBACK_RECOVERY_ONLY" },
      });
    }

    let writeReceipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let written: XeroLedgerAdjustmentResult;
      try {
        written = await this.#callProvider(
          context,
          expected,
          started.request.mutationRequestId,
          started.providerWritePermit,
        );
      } catch (error) {
        if (definiteRejection(error)) {
          await this.mutations.rejectProvider(context, {
            mutationRequestId: started.request.mutationRequestId,
            providerRejectionReceipt: {
              errorCode: error.code,
              httpStatus: error.httpStatus,
              writeOutcome: "DEFINITELY_REJECTED",
              ...(error.details ? { providerDetails: error.details } : {}),
            },
          });
        } else {
          await this.mutations.markUnknown(context, {
            mutationRequestId: started.request.mutationRequestId,
            xeroObjectId: expected.targetXeroObjectId,
          });
        }
        throw error;
      }
      if (
        written.objectId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() ||
        written.status !== expected.finalStatus
      ) {
        await this.mutations.markUnknown(context, {
          mutationRequestId: started.request.mutationRequestId,
          xeroObjectId: written.objectId,
          writeReceipt: written.receipt,
        });
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned a mismatched ledger-adjustment write receipt.", {
          httpStatus: 502,
          retryable: false,
        });
      }
      // Persist receipt/target first. If the process dies or GET fails after
      // this point, recovery is GET-only and cannot issue another mutation.
      const persisted = await this.mutations.recordWriteEvidence(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: written.objectId,
        writeReceipt: written.receipt,
      });
      writeReceipt = persisted.writeReceipt;
    }

    if (!writeReceipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The ledger adjustment has no durable provider receipt for safe recovery.", {
        httpStatus: 502,
        retryable: false,
        details: { targetXeroObjectId: expected.targetXeroObjectId },
      });
    }

    let verified;
    try {
      verified = await this.writeProvider.readAndVerifyAdjustment(
        context,
        expected.actionId,
        expected.canonicalPayload,
        writeReceipt,
      );
    } catch (error) {
      // Both an unavailable GET and a concrete mismatch are not a success;
      // retain the receipt and force the next attempt onto GET-only recovery.
      await this.mutations.markUnknown(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: expected.targetXeroObjectId,
        writeReceipt,
      });
      throw error;
    }
    if (verified.objectId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() || verified.status !== expected.finalStatus) {
      await this.mutations.markUnknown(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: expected.targetXeroObjectId,
        writeReceipt,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned a mismatched same-ID ledger-adjustment readback.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    const completed = started.mode === "RECOVER_ONLY"
      ? (await this.mutations.recover(context, {
          mutationRequestId: started.request.mutationRequestId,
          writeReceipt,
          verifiedReadback: {
            xeroObjectId: verified.objectId,
            status: verified.status,
            canonicalPayload: expected.canonicalPayload,
            evidence: verified.snapshot,
          },
        })).request
      : await this.mutations.markReadbackVerified(context, {
          mutationRequestId: started.request.mutationRequestId,
          writeReceipt,
          verifiedReadback: {
            xeroObjectId: verified.objectId,
            status: verified.status,
            canonicalPayload: expected.canonicalPayload,
            evidence: verified.snapshot,
          },
        });
    return this.#verifiedResult(completed, expected);
  }

  async #preflight(principal: AccountingPrincipal, expected: LedgerAdjustmentExpectation): Promise<void> {
    try {
      switch (expected.actionId) {
        case "customer_invoice.void":
        case "supplier_bill.void": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { invoiceId: string }>;
          const invoice = expected.actionId === "customer_invoice.void"
            ? await this.readProvider.getInvoice(principal, payload.invoiceId, "ACCREC")
            : await this.readProvider.getSupplierBill(principal, payload.invoiceId);
          if (
            invoice.invoiceId.toLowerCase() !== payload.invoiceId.toLowerCase() ||
            invoice.type !== payload.invoiceType || invoice.status !== payload.expectedStatus ||
            !exactZero(invoice.amountPaid) || !exactZero(invoice.amountCredited)
          ) {
            throw stale("The exact invoice/bill is not an un-applied AUTHORISED void target.", {
              targetXeroObjectId: payload.invoiceId,
              actualStatus: invoice.status,
            });
          }
          return;
        }
        case "credit_note.authorise": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { creditNoteId: string; expectedStatus: "DRAFT" }>;
          const credit = await this.readProvider.getCreditNote(principal, payload.creditNoteId, payload.creditNoteType);
          if (credit.creditNoteId.toLowerCase() !== payload.creditNoteId.toLowerCase() || credit.status !== payload.expectedStatus) {
            throw stale("The exact credit note is not a DRAFT authorisation target.", { actualStatus: credit.status });
          }
          return;
        }
        case "credit_note.allocate": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { targetInvoiceId: string }>;
          const [credit, invoice] = await Promise.all([
            this.readProvider.getCreditNote(principal, payload.creditNoteId, payload.creditNoteType),
            this.readProvider.getInvoice(principal, payload.targetInvoiceId, payload.targetInvoiceType),
          ]);
          if (
            credit.creditNoteId.toLowerCase() !== payload.creditNoteId.toLowerCase() ||
            credit.status !== payload.expectedCreditStatus ||
            invoice.invoiceId.toLowerCase() !== payload.targetInvoiceId.toLowerCase() ||
            invoice.type !== payload.targetInvoiceType || invoice.status !== payload.expectedTargetStatus ||
            credit.contact.contactId.toLowerCase() !== invoice.contact.contactId.toLowerCase() ||
            !credit.currency || credit.currency !== invoice.currency ||
            !atLeast(credit.remainingCredit, payload.amount) || !atLeast(invoice.amountDue, payload.amount)
          ) {
            throw stale("The exact credit note and target invoice no longer meet allocation preconditions.");
          }
          return;
        }
        case "credit_note.refund": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { bankAccountId: string }>;
          const [credit, accounts] = await Promise.all([
            this.readProvider.getCreditNote(principal, payload.creditNoteId, payload.creditNoteType),
            this.readProvider.listAccounts(principal),
          ]);
          const account = accounts.find((candidate) => candidate.accountId?.toLowerCase() === payload.bankAccountId.toLowerCase());
          if (
            credit.creditNoteId.toLowerCase() !== payload.creditNoteId.toLowerCase() ||
            credit.status !== payload.expectedStatus || !atLeast(credit.remainingCredit, payload.amount) ||
            !account || account.status !== "ACTIVE" || account.type !== "BANK"
          ) {
            throw stale("The exact credit note or active bank account no longer meets refund preconditions.");
          }
          return;
        }
        case "credit_note.void": {
          const payload = expected.canonicalPayload as {
            creditNoteId: string;
            creditNoteType: "ACCRECCREDIT" | "ACCPAYCREDIT";
            expectedStatus: "AUTHORISED";
          };
          const credit = await this.readProvider.getCreditNote(principal, payload.creditNoteId, payload.creditNoteType);
          if (
            credit.creditNoteId.toLowerCase() !== payload.creditNoteId.toLowerCase() ||
            credit.status !== payload.expectedStatus || !exactZero(credit.appliedAmount) ||
            credit.associatedInvoiceIdCount !== 0
          ) {
            throw stale("The exact credit note is not an un-applied AUTHORISED void target.");
          }
          return;
        }
        case "credit_note.unallocate": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { creditNoteId: string; allocationId: string }>;
          const credit = await this.readProvider.getCreditNote(principal, payload.creditNoteId);
          if (
            credit.creditNoteId.toLowerCase() !== payload.creditNoteId.toLowerCase() ||
            credit.status !== payload.expectedStatus
          ) {
            throw stale("The exact credit note is not an AUTHORISED unallocation target.");
          }
          return;
        }
        case "manual_journal.void": {
          const payload = expected.canonicalPayload as Extract<CanonicalLedgerAdjustmentPayload, { manualJournalId: string }>;
          const [journal, organisation] = await Promise.all([
            this.readProvider.getManualJournal(principal, payload.manualJournalId),
            this.readProvider.getOrganisation(principal),
          ]);
          if (journal.manualJournalId.toLowerCase() !== payload.manualJournalId.toLowerCase() || journal.status !== payload.expectedStatus) {
            throw stale("The exact manual journal is not a POSTED void target.");
          }
          if (!journal.journalDate) {
            throw stale("Xero did not return the manual-journal posting date required for lock-period validation.");
          }
          if (
            (organisation.periodLockDate && journal.journalDate <= organisation.periodLockDate) ||
            (organisation.endOfYearLockDate && journal.journalDate <= organisation.endOfYearLockDate)
          ) {
            throw stale("The manual journal falls inside the current Xero locked period.", {
              journalDate: journal.journalDate,
              periodLockDate: organisation.periodLockDate,
              endOfYearLockDate: organisation.endOfYearLockDate,
            });
          }
          return;
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable("The exact Xero ledger-adjustment preflight could not be read; no provider write was attempted.", error);
    }
  }

  #callProvider(
    principal: AccountingPrincipal,
    expected: LedgerAdjustmentExpectation,
    mutationRequestId: string,
    permit: Parameters<XeroLedgerAdjustmentProvider["voidSalesInvoice"]>[3],
  ): Promise<XeroLedgerAdjustmentResult> {
    switch (expected.actionId) {
      case "customer_invoice.void":
        return this.writeProvider.voidSalesInvoice(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["voidSalesInvoice"]>[1], mutationRequestId, permit);
      case "supplier_bill.void":
        return this.writeProvider.voidSupplierBill(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["voidSupplierBill"]>[1], mutationRequestId, permit);
      case "credit_note.authorise":
        return this.writeProvider.authoriseCreditNote(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["authoriseCreditNote"]>[1], mutationRequestId, permit);
      case "credit_note.allocate":
        return this.writeProvider.allocateCreditNote(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["allocateCreditNote"]>[1], mutationRequestId, permit);
      case "credit_note.refund":
        return this.writeProvider.refundCreditNote(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["refundCreditNote"]>[1], mutationRequestId, permit);
      case "credit_note.void":
        return this.writeProvider.voidCreditNote(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["voidCreditNote"]>[1], mutationRequestId, permit);
      case "credit_note.unallocate":
        return this.writeProvider.unallocateCreditNote(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["unallocateCreditNote"]>[1], mutationRequestId, permit);
      case "manual_journal.void":
        return this.writeProvider.voidManualJournal(principal, expected.canonicalPayload as Parameters<XeroLedgerAdjustmentProvider["voidManualJournal"]>[1], mutationRequestId, permit);
    }
  }

  #verifiedResult(
    request: {
      state: string;
      mutationRequestId: string;
      xeroObjectId?: string;
      writeReceipt?: Record<string, unknown>;
      readbackSnapshot?: Record<string, unknown>;
      readbackStatus?: string;
    },
    expected: LedgerAdjustmentExpectation,
  ): LedgerAdjustmentWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      !request.xeroObjectId || request.xeroObjectId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() ||
      request.readbackStatus !== expected.finalStatus || !request.writeReceipt || !request.readbackSnapshot
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The ledger adjustment is not exactly readback-verified.", {
        httpStatus: 502,
        retryable: false,
      });
    }
    return {
      mutation_request_id: request.mutationRequestId,
      xero_object_id: request.xeroObjectId,
      status: expected.finalStatus,
      provider_receipt: request.writeReceipt,
      exact_readback: request.readbackSnapshot,
    };
  }
}
