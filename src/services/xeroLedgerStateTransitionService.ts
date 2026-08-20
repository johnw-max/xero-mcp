import { AppError } from "../errors.js";
import type { LedgerStateTransitionAction } from "../domain/accountingCase.js";
import type { AccountingProvider, AccountingPrincipal } from "../providers/types.js";
import type {
  XeroControlledLedgerTransitionProvider,
  XeroLedgerTransitionResult,
} from "../providers/xeroControlledLedgerTransitionProvider.js";
import type { RequestContext } from "../security/requestContext.js";
import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";
import { hashObject } from "../security/hash.js";
import { XeroMutationService } from "./xeroMutationService.js";

export interface PrepareLedgerStateTransitionInput {
  actionId: LedgerStateTransitionAction;
  targetXeroObjectId: string;
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
}

export interface ExecuteLedgerStateTransitionInput {
  preparation_id: string;
  request_id: string;
  actionId: LedgerStateTransitionAction;
}

export interface LedgerStateTransitionWriteResult {
  mutation_request_id: string;
  xero_object_id: string;
  status: "AUTHORISED" | "POSTED";
  provider_receipt: Record<string, unknown>;
  exact_readback: Record<string, unknown>;
}

type TransitionExpectation = Readonly<{
  actionId: LedgerStateTransitionAction;
  objectType: "SALES_INVOICE" | "SUPPLIER_BILL" | "MANUAL_JOURNAL";
  operation: "AUTHORISE" | "POST";
  targetXeroObjectId: string;
  canonicalPayload: Record<string, unknown>;
  finalStatus: "AUTHORISED" | "POSTED";
}>;

function expectationFor(
  actionId: LedgerStateTransitionAction,
  targetXeroObjectId: string,
): TransitionExpectation {
  switch (actionId) {
    case "customer_invoice.authorise":
      return {
        actionId,
        objectType: "SALES_INVOICE",
        operation: "AUTHORISE",
        targetXeroObjectId,
        canonicalPayload: { invoiceId: targetXeroObjectId, invoiceType: "ACCREC", expectedStatus: "DRAFT" },
        finalStatus: "AUTHORISED",
      };
    case "supplier_bill.authorise":
      return {
        actionId,
        objectType: "SUPPLIER_BILL",
        operation: "AUTHORISE",
        targetXeroObjectId,
        canonicalPayload: { invoiceId: targetXeroObjectId, invoiceType: "ACCPAY", expectedStatus: "DRAFT" },
        finalStatus: "AUTHORISED",
      };
    case "manual_journal.post":
      return {
        actionId,
        objectType: "MANUAL_JOURNAL",
        operation: "POST",
        targetXeroObjectId,
        canonicalPayload: { manualJournalId: targetXeroObjectId, expectedStatus: "DRAFT" },
        finalStatus: "POSTED",
      };
  }
}

function definiteRejection(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.writeOutcome === "DEFINITELY_REJECTED";
}

/** Internal Case-only execution service for exactly three existing-draft transitions. */
export class XeroLedgerStateTransitionService {
  constructor(
    private readonly readProvider: AccountingProvider,
    private readonly writeProvider: XeroControlledLedgerTransitionProvider,
    private readonly mutations: XeroMutationService,
  ) {}

  async prepare(
    context: RequestContext,
    input: PrepareLedgerStateTransitionInput,
  ): Promise<{ preparation_id: string }> {
    const expected = expectationFor(input.actionId, input.targetXeroObjectId);
    await this.#exactRead(context, expected, "DRAFT");
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
        expectedStatus: "DRAFT",
      },
    });
    return { preparation_id: prepared.preparationId };
  }

  async execute(
    context: RequestContext,
    input: ExecuteLedgerStateTransitionInput,
  ): Promise<LedgerStateTransitionWriteResult> {
    const actionExpectation = expectationFor(input.actionId, "unused");
    const expectation = {
      objectType: actionExpectation.objectType,
      operation: actionExpectation.operation,
    } as const;
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, expectation);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
    }, expectation);
    const targetXeroObjectId = preparation.targetXeroObjectId;
    if (!targetXeroObjectId) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger-state preparation has no exact target Xero object.", {
        httpStatus: 503,
      });
    }
    const expected = expectationFor(input.actionId, targetXeroObjectId);
    if (
      preparation.objectType !== expected.objectType ||
      preparation.operation !== expected.operation ||
      hashObject(preparation.canonicalPayload) !== hashObject(expected.canonicalPayload)
    ) {
      throw new AppError("PERSISTENCE_FAILURE", "Ledger-state preparation does not match its closed action.", {
        httpStatus: 503,
      });
    }
    if (!recovery) await this.#exactRead(context, expected, "DRAFT");
    const validationReceipt = issueObjectPreparationValidationReceipt({
      actionId: expected.actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-ledger-state-transition-v1",
      checks: [{
        code: "EXACT_TARGET_IS_DRAFT",
        evidence: {
          targetXeroObjectId: expected.targetXeroObjectId,
          objectType: expected.objectType,
          expectedStatus: "DRAFT",
        },
      }],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(
      context,
      { preparationId: input.preparation_id, requestId: input.request_id },
      expectation,
      validationReceipt,
      async () => { await this.#exactRead(context, expected, "DRAFT"); },
    );
    if (started.mode === "ALREADY_VERIFIED") return this.#verifiedResult(started.request, expected);
    if (recovery && started.mode === "CALL_PROVIDER") {
      await this.mutations.markUnknown(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: expected.targetXeroObjectId,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Ledger-state recovery is exact GET-only and cannot replay the transition.", {
        httpStatus: 409,
        retryable: false,
        details: { targetXeroObjectId: expected.targetXeroObjectId, recoveryAction: "READBACK_RECOVERY_ONLY" },
      });
    }

    let writeReceipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let written: XeroLedgerTransitionResult;
      try {
        written = await this.#callProvider(context, expected, started.request.mutationRequestId, started.providerWritePermit);
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
        throw new AppError("WRITE_RESULT_UNKNOWN", "Xero returned a mismatched ledger-state transition result.", {
          httpStatus: 502,
          retryable: false,
        });
      }
      const persisted = await this.mutations.recordWriteEvidence(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: written.objectId,
        writeReceipt: written.receipt,
      });
      writeReceipt = persisted.writeReceipt;
    }

    if (!writeReceipt) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The ledger-state transition has no durable provider receipt for safe recovery.", {
        httpStatus: 502,
        retryable: false,
        details: { targetXeroObjectId: expected.targetXeroObjectId },
      });
    }
    const exactReadback = await this.#exactRead(context, expected, expected.finalStatus);
    const completed = started.mode === "RECOVER_ONLY"
      ? (await this.mutations.recover(context, {
          mutationRequestId: started.request.mutationRequestId,
          writeReceipt,
          verifiedReadback: {
            xeroObjectId: expected.targetXeroObjectId,
            status: expected.finalStatus,
            canonicalPayload: expected.canonicalPayload,
            evidence: { actionId: expected.actionId, exactReadback },
          },
        })).request
      : await this.mutations.markReadbackVerified(context, {
          mutationRequestId: started.request.mutationRequestId,
          writeReceipt,
          verifiedReadback: {
            xeroObjectId: expected.targetXeroObjectId,
            status: expected.finalStatus,
            canonicalPayload: expected.canonicalPayload,
            evidence: { actionId: expected.actionId, exactReadback },
          },
        });
    return this.#verifiedResult(completed, expected);
  }

  async #exactRead(
    principal: AccountingPrincipal,
    expected: TransitionExpectation,
    status: "DRAFT" | "AUTHORISED" | "POSTED",
  ): Promise<Record<string, unknown>> {
    const snapshot = expected.actionId === "customer_invoice.authorise"
      ? await this.readProvider.getInvoice(principal, expected.targetXeroObjectId, "ACCREC")
      : expected.actionId === "supplier_bill.authorise"
        ? await this.readProvider.getSupplierBill(principal, expected.targetXeroObjectId)
        : await this.readProvider.getManualJournal(principal, expected.targetXeroObjectId);
    const actualId = "invoiceId" in snapshot ? snapshot.invoiceId : snapshot.manualJournalId;
    if (actualId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() || snapshot.status !== status) {
      throw new AppError("STALE_PREFLIGHT", "The exact Xero target is not in the required ledger state.", {
        httpStatus: 409,
        retryable: false,
        details: {
          targetXeroObjectId: expected.targetXeroObjectId,
          expectedStatus: status,
          actualStatus: snapshot.status,
          providerMutationPossible: false,
        },
      });
    }
    return snapshot as unknown as Record<string, unknown>;
  }

  #callProvider(
    principal: AccountingPrincipal,
    expected: TransitionExpectation,
    mutationRequestId: string,
    permit: Parameters<XeroControlledLedgerTransitionProvider["authoriseSalesInvoice"]>[3],
  ): Promise<XeroLedgerTransitionResult> {
    switch (expected.actionId) {
      case "customer_invoice.authorise":
        return this.writeProvider.authoriseSalesInvoice(
          principal,
          expected.canonicalPayload as unknown as Parameters<
            XeroControlledLedgerTransitionProvider["authoriseSalesInvoice"]
          >[1],
          mutationRequestId,
          permit,
        );
      case "supplier_bill.authorise":
        return this.writeProvider.authoriseSupplierBill(
          principal,
          expected.canonicalPayload as unknown as Parameters<
            XeroControlledLedgerTransitionProvider["authoriseSupplierBill"]
          >[1],
          mutationRequestId,
          permit,
        );
      case "manual_journal.post":
        return this.writeProvider.postManualJournal(
          principal,
          expected.canonicalPayload as unknown as Parameters<
            XeroControlledLedgerTransitionProvider["postManualJournal"]
          >[1],
          mutationRequestId,
          permit,
        );
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
    expected: TransitionExpectation,
  ): LedgerStateTransitionWriteResult {
    if (
      request.state !== "READBACK_VERIFIED" ||
      !request.xeroObjectId ||
      request.xeroObjectId.toLowerCase() !== expected.targetXeroObjectId.toLowerCase() ||
      request.readbackStatus !== expected.finalStatus ||
      !request.writeReceipt || !request.readbackSnapshot
    ) {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The ledger-state transition is not exactly readback-verified.", {
        httpStatus: 502,
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
