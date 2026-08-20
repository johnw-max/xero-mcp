import { issueObjectPreparationValidationReceipt } from "../control-kernel/deterministicValidation.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import {
  parseCanonicalBankTransactionCreatePayload,
  parseCanonicalBankTransactionReversePayload,
  parseCanonicalBankTransactionUpdatePayload,
  parseCanonicalPaymentCreatePayload,
  parseCanonicalPaymentReversePayload,
  type CanonicalBankTransactionCreatePayload,
  type CanonicalBankTransactionReversePayload,
  type CanonicalBankTransactionUpdatePayload,
  type CanonicalPaymentCreatePayload,
  type CanonicalPaymentReversePayload,
} from "../domain/xeroPaymentBankTransaction.js";
import { AppError } from "../errors.js";
import type { AccountingProvider } from "../providers/types.js";
import type {
  PaymentBankTransactionWriteReceipt,
  XeroPaymentBankTransactionProvider,
} from "../providers/xeroPaymentBankTransactionProvider.js";
import type { RequestContext } from "../security/requestContext.js";
import { hashObject } from "../security/hash.js";
import { XeroMutationService } from "./xeroMutationService.js";

export type PaymentBankAction = "payment.create" | "payment.reverse" | "bank_transaction.create" | "bank_transaction.update" | "bank_transaction.reverse";
type Payload = CanonicalPaymentCreatePayload | CanonicalPaymentReversePayload |
  CanonicalBankTransactionCreatePayload | CanonicalBankTransactionUpdatePayload | CanonicalBankTransactionReversePayload;

export interface PreparePaymentBankCaseInput {
  actionId: PaymentBankAction;
  payload: Record<string, unknown>;
  sourceRef: string;
  sourceUnitKey: string;
  sourceSha256: string;
}
export interface ExecutePaymentBankCaseInput { preparation_id: string; request_id: string; actionId: PaymentBankAction }

type Expected = Readonly<{
  actionId: PaymentBankAction;
  objectType: "PAYMENT" | "BANK_TRANSACTION";
  operation: "CREATE" | "UPDATE" | "REVERSE";
  payload: Payload;
  sealedPayload: Record<string, unknown>;
  targetXeroObjectId?: string;
  finalStatus: "AUTHORISED" | "DELETED";
}>;

function expected(actionId: PaymentBankAction, raw: unknown): Expected {
  switch (actionId) {
    case "payment.create": {
      const payload = parseCanonicalPaymentCreatePayload(raw);
      return { actionId, objectType: "PAYMENT", operation: "CREATE", payload, sealedPayload: payload as unknown as Record<string, unknown>, finalStatus: "AUTHORISED" };
    }
    case "payment.reverse": {
      const payload = parseCanonicalPaymentReversePayload(raw);
      return { actionId, objectType: "PAYMENT", operation: "REVERSE", payload, sealedPayload: payload as unknown as Record<string, unknown>, targetXeroObjectId: payload.paymentId, finalStatus: "DELETED" };
    }
    case "bank_transaction.create": {
      const payload = parseCanonicalBankTransactionCreatePayload(raw);
      return { actionId, objectType: "BANK_TRANSACTION", operation: "CREATE", payload, sealedPayload: payload as unknown as Record<string, unknown>, finalStatus: "AUTHORISED" };
    }
    case "bank_transaction.update": {
      const payload = parseCanonicalBankTransactionUpdatePayload(raw);
      const sealedPayload = {
        targetXeroObjectId: payload.bankTransactionId,
        expectedUpdatedAt: payload.expectedUpdatedAt,
        replacement: payload,
      };
      return { actionId, objectType: "BANK_TRANSACTION", operation: "UPDATE", payload, sealedPayload, targetXeroObjectId: payload.bankTransactionId, finalStatus: "AUTHORISED" };
    }
    case "bank_transaction.reverse": {
      const payload = parseCanonicalBankTransactionReversePayload(raw);
      return { actionId, objectType: "BANK_TRANSACTION", operation: "REVERSE", payload, sealedPayload: payload as unknown as Record<string, unknown>, targetXeroObjectId: payload.bankTransactionId, finalStatus: "DELETED" };
    }
  }
}

function expectedFromStored(actionId: PaymentBankAction, stored: Record<string, unknown>): Expected {
  return actionId === "bank_transaction.update"
    ? expected(actionId, stored.replacement)
    : expected(actionId, stored);
}

function receiptRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export class XeroPaymentBankCaseService {
  constructor(
    private readonly reads: AccountingProvider,
    private readonly provider: XeroPaymentBankTransactionProvider,
    private readonly mutations: XeroMutationService,
  ) {}

  async prepare(context: RequestContext, input: PreparePaymentBankCaseInput): Promise<{ preparation_id: string }> {
    const item = expected(input.actionId, input.payload);
    await this.#preflight(context, item);
    const prepared = await this.mutations.prepare(context, {
      objectType: item.objectType,
      operation: item.operation,
      ...(item.targetXeroObjectId ? { targetXeroObjectId: item.targetXeroObjectId } : {}),
      canonicalPayload: item.sealedPayload,
      sourceRef: input.sourceRef,
      sourceUnitKey: input.sourceUnitKey,
      sourceSha256: input.sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { actionId: item.actionId, payloadHash: hashObject(item.payload) },
    });
    return { preparation_id: prepared.preparationId };
  }

  async execute(context: RequestContext, input: ExecutePaymentBankCaseInput) {
    const shape = expectedShape(input.actionId);
    const recovery = await this.mutations.resumeAutonomousRecovery(context, {
      preparationId: input.preparation_id, requestId: input.request_id,
    }, shape);
    const preparation = recovery?.preparation ?? await this.mutations.loadAutonomousPreparation(context, {
      preparationId: input.preparation_id, requestId: input.request_id,
    }, shape);
    const item = expectedFromStored(input.actionId, preparation.canonicalPayload);
    if (hashObject(item.sealedPayload) !== hashObject(preparation.canonicalPayload) ||
        preparation.targetXeroObjectId?.toLowerCase() !== item.targetXeroObjectId?.toLowerCase()) {
      throw new AppError("PERSISTENCE_FAILURE", "Payment/Bank preparation does not match its closed action.", { httpStatus: 503 });
    }
    if (!recovery) await this.#preflight(context, item);
    const validation = issueObjectPreparationValidationReceipt({
      actionId: item.actionId,
      preparation,
      policyVersion: "xero-autonomous-policy-v1",
      compilerVersion: "xero-accounting-case-payment-bank-v1",
      checks: [{ code: "PAYMENT_BANK_EXACT_PRECONDITIONS_REVALIDATED", evidence: { objectType: item.objectType, operation: item.operation } }],
    });
    const started = recovery?.claim ?? await this.mutations.authoriseAutonomous(
      context, { preparationId: input.preparation_id, requestId: input.request_id }, shape, validation,
      async () => { await this.#preflight(context, item); },
    );
    if (started.mode === "ALREADY_VERIFIED") return this.#result(started.request);
    if (recovery && started.mode === "CALL_PROVIDER") {
      throw new AppError("WRITE_RESULT_UNKNOWN", "Payment/Bank recovery requires an exact provider object ID.", {
        httpStatus: 409, retryable: false,
      });
    }
    let objectId = started.request.xeroObjectId;
    let writeReceipt = started.request.writeReceipt;
    if (started.mode === "CALL_PROVIDER") {
      let written: PaymentBankTransactionWriteReceipt;
      try {
        written = await this.#write(context, item, started.request.mutationRequestId, started.providerWritePermit);
      } catch (error) {
        if (error instanceof AppError && error.details?.writeOutcome === "DEFINITELY_REJECTED") {
          await this.mutations.rejectProvider(context, {
            mutationRequestId: started.request.mutationRequestId,
            providerRejectionReceipt: { errorCode: error.code, httpStatus: error.httpStatus, writeOutcome: "DEFINITELY_REJECTED" },
          });
        } else {
          await this.mutations.markUnknown(context, {
            mutationRequestId: started.request.mutationRequestId,
            ...(item.targetXeroObjectId ? { xeroObjectId: item.targetXeroObjectId } : {}),
          });
        }
        throw error;
      }
      if (item.targetXeroObjectId && written.objectId.toLowerCase() !== item.targetXeroObjectId.toLowerCase()) {
        await this.mutations.markUnknown(context, { mutationRequestId: started.request.mutationRequestId, xeroObjectId: written.objectId, writeReceipt: receiptRecord(written.receipt) });
        throw new AppError("WRITE_RESULT_UNKNOWN", "Payment/Bank write returned a different target ID.", { httpStatus: 502, retryable: false });
      }
      const persisted = await this.mutations.recordWriteEvidence(context, {
        mutationRequestId: started.request.mutationRequestId,
        xeroObjectId: written.objectId,
        writeReceipt: receiptRecord(written.receipt),
      });
      objectId = written.objectId;
      writeReceipt = persisted.writeReceipt;
    }
    if (!objectId || !writeReceipt) throw new AppError("WRITE_RESULT_UNKNOWN", "Payment/Bank mutation has no durable target and receipt.", { httpStatus: 502, retryable: false });
    try {
      const readback = await this.#readback(context, item, objectId);
      const verifiedReadback = { xeroObjectId: objectId, status: item.finalStatus, canonicalPayload: item.sealedPayload, evidence: readback };
      const completed = started.mode === "RECOVER_ONLY"
        ? (await this.mutations.recover(context, { mutationRequestId: started.request.mutationRequestId, writeReceipt, verifiedReadback })).request
        : await this.mutations.markReadbackVerified(context, { mutationRequestId: started.request.mutationRequestId, writeReceipt, verifiedReadback });
      return this.#result(completed);
    } catch (error) {
      await this.mutations.markUnknown(context, { mutationRequestId: started.request.mutationRequestId, xeroObjectId: objectId, writeReceipt });
      throw new AppError("WRITE_RESULT_UNKNOWN", "Payment/Bank exact readback was not verified.", { httpStatus: 502, retryable: false, cause: error });
    }
  }

  async #preflight(principal: RequestContext, item: Expected): Promise<void> {
    switch (item.actionId) {
      case "payment.create": {
        const payload = item.payload as CanonicalPaymentCreatePayload;
        const invoice = payload.invoiceType === "ACCREC"
          ? await this.reads.getInvoice(principal, payload.invoiceId, "ACCREC")
          : await this.reads.getSupplierBill(principal, payload.invoiceId);
        if (invoice.status !== "AUTHORISED") throw new AppError("STALE_PREFLIGHT", "Payment target is not AUTHORISED.", { httpStatus: 409 });
        await this.reads.listAccounts(principal);
        return;
      }
      case "payment.reverse":
        if ((await this.reads.getPayment(principal, (item.payload as CanonicalPaymentReversePayload).paymentId)).status !== "AUTHORISED") {
          throw new AppError("STALE_PREFLIGHT", "Only an AUTHORISED Payment can be reversed.", { httpStatus: 409 });
        }
        return;
      case "bank_transaction.update": {
        const payload = item.payload as CanonicalBankTransactionUpdatePayload;
        const current = await this.reads.getBankTransaction(principal, payload.bankTransactionId);
        if (current.status !== "AUTHORISED" || !current.updatedAt || new Date(current.updatedAt).toISOString() !== payload.expectedUpdatedAt) {
          throw new AppError("STALE_PREFLIGHT", "Bank Transaction status or optimistic version changed.", { httpStatus: 409 });
        }
        return;
      }
      case "bank_transaction.reverse": {
        const payload = item.payload as CanonicalBankTransactionReversePayload;
        const current = await this.reads.getBankTransaction(principal, payload.bankTransactionId);
        if (current.status !== "AUTHORISED" || current.isReconciled !== false) {
          throw new AppError("STALE_PREFLIGHT", "Only an AUTHORISED, unreconciled Bank Transaction can be reversed.", { httpStatus: 409 });
        }
        return;
      }
      case "bank_transaction.create":
        await Promise.all([this.reads.listAccounts(principal), this.reads.listTaxRates(principal)]);
        return;
    }
  }

  #write(principal: RequestContext, item: Expected, key: string, permit: LedgerProviderWritePermit) {
    switch (item.actionId) {
      case "payment.create": return this.provider.createPayment(principal, item.payload as CanonicalPaymentCreatePayload, key, permit);
      case "payment.reverse": return this.provider.reversePayment(principal, item.payload as CanonicalPaymentReversePayload, key, permit);
      case "bank_transaction.create": return this.provider.createBankTransaction(principal, item.payload as CanonicalBankTransactionCreatePayload, key, permit);
      case "bank_transaction.update": return this.provider.updateBankTransaction(principal, item.payload as CanonicalBankTransactionUpdatePayload, key, permit);
      case "bank_transaction.reverse": return this.provider.reverseBankTransaction(principal, item.payload as CanonicalBankTransactionReversePayload, key, permit);
    }
  }

  async #readback(principal: RequestContext, item: Expected, objectId: string): Promise<Record<string, unknown>> {
    switch (item.actionId) {
      case "payment.create":
        return await this.provider.readAndVerifyPayment(
          principal, objectId, item.payload as CanonicalPaymentCreatePayload,
        ) as unknown as Record<string, unknown>;
      case "payment.reverse":
        return await this.provider.readAndVerifyPayment(
          principal, objectId, item.payload as CanonicalPaymentReversePayload,
        ) as unknown as Record<string, unknown>;
      case "bank_transaction.create":
        return await this.provider.readAndVerifyBankTransaction(
          principal, objectId, item.payload as CanonicalBankTransactionCreatePayload,
        ) as unknown as Record<string, unknown>;
      case "bank_transaction.update":
        return await this.provider.readAndVerifyBankTransaction(
          principal, objectId, item.payload as CanonicalBankTransactionUpdatePayload,
        ) as unknown as Record<string, unknown>;
      case "bank_transaction.reverse":
        return await this.provider.readAndVerifyBankTransactionReversal(
          principal, objectId, item.payload as CanonicalBankTransactionReversePayload,
        ) as unknown as Record<string, unknown>;
    }
  }

  #result(request: { state: string; mutationRequestId: string; xeroObjectId?: string; writeReceipt?: Record<string, unknown>; readbackSnapshot?: Record<string, unknown>; readbackStatus?: string }) {
    if (request.state !== "READBACK_VERIFIED" || !request.xeroObjectId || !request.writeReceipt || !request.readbackSnapshot || !request.readbackStatus) {
      throw new AppError("PERSISTENCE_FAILURE", "Verified Payment/Bank evidence is incomplete.", { httpStatus: 503 });
    }
    return { mutation_request_id: request.mutationRequestId, xero_object_id: request.xeroObjectId, status: request.readbackStatus, provider_receipt: request.writeReceipt, exact_readback: request.readbackSnapshot };
  }
}

function expectedShape(actionId: PaymentBankAction) {
  switch (actionId) {
    case "payment.create": return { objectType: "PAYMENT" as const, operation: "CREATE" as const };
    case "payment.reverse": return { objectType: "PAYMENT" as const, operation: "REVERSE" as const };
    case "bank_transaction.create": return { objectType: "BANK_TRANSACTION" as const, operation: "CREATE" as const };
    case "bank_transaction.update": return { objectType: "BANK_TRANSACTION" as const, operation: "UPDATE" as const };
    case "bank_transaction.reverse": return { objectType: "BANK_TRANSACTION" as const, operation: "REVERSE" as const };
  }
}
