import { BankTransaction, LineAmountTypes, Payment, type XeroClient } from "xero-node";
import { AppError } from "../errors.js";
import type {
  CanonicalBankTransactionCreatePayload,
  CanonicalBankTransactionReversePayload,
  CanonicalBankTransactionUpdatePayload,
  CanonicalPaymentCreatePayload,
  CanonicalPaymentReversePayload,
} from "../domain/xeroPaymentBankTransaction.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";

type ProviderRecord = Record<string, unknown>;

export interface PaymentBankTransactionReceipt {
  readonly operation:
    | "CREATE_PAYMENT_RECORD"
    | "REVERSE_PAYMENT_RECORD"
    | "CREATE_BANK_TRANSACTION"
    | "UPDATE_BANK_TRANSACTION"
    | "REVERSE_BANK_TRANSACTION";
  readonly objectId: string;
  readonly providerRequestId?: string | undefined;
  /** Xero's Payment `DELETED` state is a ledger reversal, not a hard delete. */
  readonly reversalModel?: "XERO_STATUS_DELETED_SOFT_REVERSAL";
}

export interface PaymentExactReadback {
  readonly paymentId: string;
  readonly status: "AUTHORISED" | "DELETED";
  readonly type: "ACCRECPAYMENT" | "ACCPAYPAYMENT";
  readonly invoiceId: string;
  readonly accountId: string;
  readonly paymentDate: string;
  readonly amount: string;
  readonly reference?: string;
}

export interface PaymentReversalReadback {
  readonly paymentId: string;
  readonly status: "DELETED";
}

export interface BankTransactionExactReadback {
  readonly bankTransactionId: string;
  readonly status: "AUTHORISED";
  readonly type: "SPEND" | "RECEIVE";
  readonly contactId: string;
  readonly bankAccountId: string;
  readonly transactionDate: string;
  readonly reference: string;
  readonly lineAmountType: "EXCLUSIVE" | "INCLUSIVE" | "NO_TAX";
  readonly currencyRate?: string;
  readonly lines: readonly {
    description: string;
    quantity: string;
    unitAmount: string;
    accountCode: string;
    taxType: string;
    trackingOptionIds: readonly string[];
  }[];
  readonly updatedAt?: string;
}

export interface BankTransactionReversalReadback {
  readonly bankTransactionId: string;
  readonly status: "DELETED";
}

/** Provider mutation evidence only. Case persists this before any GET readback. */
export interface PaymentBankTransactionWriteReceipt {
  readonly objectId: string;
  readonly receipt: PaymentBankTransactionReceipt;
}

function record(value: unknown): ProviderRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderRecord
    : undefined;
}

function exactUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function sameUuid(value: unknown, expected: string): boolean {
  return exactUuid(value) === exactUuid(expected);
}

function fixedFour(value: unknown): string | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  const scaled = Math.round(numberValue * 10_000);
  if (!Number.isSafeInteger(scaled) || Math.abs(numberValue * 10_000 - scaled) > 0.000001) return undefined;
  return (scaled / 10_000).toFixed(4);
}

function providerDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function providerInstant(value: unknown): string | undefined {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

function validationErrors(value: unknown): readonly unknown[] {
  const candidate = record(value);
  const errors = candidate?.validationErrors ?? candidate?.ValidationErrors;
  return Array.isArray(errors) ? errors : [];
}

function providerHasErrors(value: unknown): boolean {
  const candidate = record(value);
  return candidate?.hasErrors === true || candidate?.HasErrors === true || validationErrors(value).length > 0;
}

function providerRequestId(response: unknown): string | undefined {
  const headers = record(record(response)?.headers);
  const value = headers?.["xero-correlation-id"] ?? headers?.["x-request-id"] ?? headers?.["x-correlation-id"];
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function rejected(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: {
      ...details,
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
    },
  });
}

function conflict(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("CONFLICT", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      ...details,
      phase: "PAYMENT_BANK_PREFLIGHT",
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
    },
  });
}

function notFound(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("NOT_FOUND", message, {
    httpStatus: 404,
    retryable: false,
    details: { ...details, phase: "PAYMENT_BANK_PREFLIGHT", providerMutationPossible: false },
  });
}

function preflightUnavailable(message: string, cause?: unknown): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 503,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
    details: {
      phase: "PAYMENT_BANK_PREFLIGHT",
      reasonCodes: ["PAYMENT_BANK_PREFLIGHT_UNAVAILABLE"],
      providerMutationPossible: false,
      recoveryAction: "RETRY_BEFORE_MUTATION",
    },
  });
}

function writeUnknown(message: string, cause?: unknown, details: Record<string, unknown> = {}): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    details: {
      ...details,
      providerMutationPossible: true,
      recoveryAction: "READBACK_RECOVERY_ONLY",
    },
  });
}

function readbackMismatch(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("READBACK_MISMATCH", message, {
    httpStatus: 502,
    retryable: false,
    details: {
      ...details,
      providerMutationPossible: true,
      recoveryAction: "READBACK_RECOVERY_ONLY",
    },
  });
}

function responsePayment(body: unknown, paymentId?: string): ProviderRecord | undefined {
  const payments = record(body)?.payments;
  if (!Array.isArray(payments)) return undefined;
  const candidate = paymentId === undefined
    ? payments[0]
    : payments.find((value) => sameUuid(record(value)?.paymentID, paymentId));
  return record(candidate);
}

function responseBankTransaction(body: unknown, bankTransactionId?: string): ProviderRecord | undefined {
  const transactions = record(body)?.bankTransactions;
  if (!Array.isArray(transactions)) return undefined;
  const candidate = bankTransactionId === undefined
    ? transactions[0]
    : transactions.find((value) => sameUuid(record(value)?.bankTransactionID, bankTransactionId));
  return record(candidate);
}

function paymentReadback(raw: ProviderRecord): PaymentExactReadback | undefined {
  const paymentId = exactUuid(raw.paymentID);
  const status = raw.status === Payment.StatusEnum.AUTHORISED
    ? "AUTHORISED" as const
    : raw.status === Payment.StatusEnum.DELETED ? "DELETED" as const : undefined;
  const type = raw.paymentType === Payment.PaymentTypeEnum.ACCRECPAYMENT
    ? "ACCRECPAYMENT" as const
    : raw.paymentType === Payment.PaymentTypeEnum.ACCPAYPAYMENT ? "ACCPAYPAYMENT" as const : undefined;
  const invoiceId = exactUuid(record(raw.invoice)?.invoiceID);
  const accountId = exactUuid(record(raw.account)?.accountID);
  const paymentDate = providerDate(raw.date);
  const amount = fixedFour(raw.amount);
  if (!paymentId || !status || !type || !invoiceId || !accountId || !paymentDate || !amount) return undefined;
  const reference = typeof raw.reference === "string" && raw.reference.length > 0 && raw.reference.length <= 512
    ? raw.reference
    : undefined;
  return {
    paymentId,
    status,
    type,
    invoiceId,
    accountId,
    paymentDate,
    amount,
    ...(reference ? { reference } : {}),
  };
}

function lineAmountType(value: unknown): "EXCLUSIVE" | "INCLUSIVE" | "NO_TAX" | undefined {
  switch (value) {
    case LineAmountTypes.Exclusive:
    case "Exclusive":
    case "EXCLUSIVE": return "EXCLUSIVE";
    case LineAmountTypes.Inclusive:
    case "Inclusive":
    case "INCLUSIVE": return "INCLUSIVE";
    case LineAmountTypes.NoTax:
    case "NoTax":
    case "NOTAX":
    case "NO_TAX": return "NO_TAX";
    default: return undefined;
  }
}

function trackingIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    const id = exactUuid(record(item)?.trackingOptionID);
    if (!id) return undefined;
    ids.push(id);
  }
  const sorted = [...new Set(ids)].sort();
  return sorted.length === ids.length ? sorted : undefined;
}

function bankTransactionReadback(raw: ProviderRecord): BankTransactionExactReadback | undefined {
  const bankTransactionId = exactUuid(raw.bankTransactionID);
  const type = raw.type === BankTransaction.TypeEnum.SPEND
    ? "SPEND" as const
    : raw.type === BankTransaction.TypeEnum.RECEIVE ? "RECEIVE" as const : undefined;
  const status = raw.status === BankTransaction.StatusEnum.AUTHORISED ? "AUTHORISED" as const : undefined;
  const contactId = exactUuid(record(raw.contact)?.contactID);
  const bankAccountId = exactUuid(record(raw.bankAccount)?.accountID);
  const transactionDate = providerDate(raw.date);
  const reference = typeof raw.reference === "string" && raw.reference.length > 0 && raw.reference.length <= 512
    ? raw.reference
    : undefined;
  const mappedLineAmountType = lineAmountType(raw.lineAmountTypes);
  const sourceLines = raw.lineItems;
  if (!bankTransactionId || !type || !status || !contactId || !bankAccountId || !transactionDate || !reference ||
    !mappedLineAmountType || !Array.isArray(sourceLines) || sourceLines.length < 1 || sourceLines.length > 50) return undefined;
  const lines: BankTransactionExactReadback["lines"][number][] = [];
  for (const candidate of sourceLines) {
    const line = record(candidate);
    const description = typeof line?.description === "string" && line.description.length > 0 ? line.description : undefined;
    const quantity = fixedFour(line?.quantity);
    const unitAmount = fixedFour(line?.unitAmount);
    const accountCode = typeof line?.accountCode === "string" && line.accountCode.length > 0 ? line.accountCode : undefined;
    const taxType = typeof line?.taxType === "string" && line.taxType.length > 0 ? line.taxType : undefined;
    const trackingOptionIds = trackingIds(line?.tracking);
    if (!description || !quantity || !unitAmount || !accountCode || !taxType || !trackingOptionIds) return undefined;
    lines.push({ description, quantity, unitAmount, accountCode, taxType, trackingOptionIds });
  }
  const currencyRate = raw.currencyRate === undefined ? undefined : fixedFour(raw.currencyRate);
  if (raw.currencyRate !== undefined && !currencyRate) return undefined;
  const updatedAt = providerInstant(raw.updatedDateUTC ?? raw.updatedDateUTCString);
  return {
    bankTransactionId,
    status,
    type,
    contactId,
    bankAccountId,
    transactionDate,
    reference,
    lineAmountType: mappedLineAmountType,
    ...(currencyRate ? { currencyRate } : {}),
    lines,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function paymentMatchesCreate(readback: PaymentExactReadback, expected: CanonicalPaymentCreatePayload): boolean {
  return readback.status === "AUTHORISED" &&
    readback.type === (expected.invoiceType === "ACCREC" ? "ACCRECPAYMENT" : "ACCPAYPAYMENT") &&
    readback.invoiceId === expected.invoiceId &&
    readback.accountId === expected.bankAccountId &&
    readback.paymentDate === expected.paymentDate &&
    readback.amount === expected.amount &&
    readback.reference === expected.reference;
}

function bankTransactionMatches(
  readback: BankTransactionExactReadback,
  expected: CanonicalBankTransactionCreatePayload | CanonicalBankTransactionUpdatePayload,
): boolean {
  return readback.status === "AUTHORISED" && readback.type === expected.type &&
    readback.contactId === expected.contactId && readback.bankAccountId === expected.bankAccountId &&
    readback.transactionDate === expected.transactionDate && readback.reference === expected.reference &&
    readback.lineAmountType === expected.lineAmountType && readback.currencyRate === expected.currencyRate &&
    readback.lines.length === expected.lines.length && readback.lines.every((line, index) => {
      const source = expected.lines[index];
      return source !== undefined && line.description === source.description && line.quantity === source.quantity &&
        line.unitAmount === source.unitAmount &&
        line.accountCode === source.accountCode && line.taxType === source.taxType &&
        sameStrings(line.trackingOptionIds, source.trackingOptionIds);
    });
}

type ResolvedBankTransactionLine = CanonicalBankTransactionCreatePayload["lines"][number] & {
  accountId: string;
};

const XERO_LINE_AMOUNT_TYPES: Readonly<Record<CanonicalBankTransactionCreatePayload["lineAmountType"], LineAmountTypes>> = {
  EXCLUSIVE: LineAmountTypes.Exclusive,
  INCLUSIVE: LineAmountTypes.Inclusive,
  NO_TAX: LineAmountTypes.NoTax,
};

function bankTransactionBody(
  payload: CanonicalBankTransactionCreatePayload | CanonicalBankTransactionUpdatePayload,
  resolvedLines: readonly ResolvedBankTransactionLine[],
  targetId?: string,
) {
  return {
    bankTransactions: [{
      ...(targetId ? { bankTransactionID: targetId } : {}),
      type: payload.type === "SPEND" ? BankTransaction.TypeEnum.SPEND : BankTransaction.TypeEnum.RECEIVE,
      status: BankTransaction.StatusEnum.AUTHORISED,
      contact: { contactID: payload.contactId },
      bankAccount: { accountID: payload.bankAccountId },
      date: payload.transactionDate,
      reference: payload.reference,
      lineAmountTypes: XERO_LINE_AMOUNT_TYPES[payload.lineAmountType],
      ...(payload.currencyRate ? { currencyRate: Number(payload.currencyRate) } : {}),
      lineItems: resolvedLines.map((line) => ({
        description: line.description,
        quantity: Number(line.quantity),
        unitAmount: Number(line.unitAmount),
        accountID: line.accountId,
        accountCode: line.accountCode,
        taxType: line.taxType,
        ...(line.trackingOptionIds.length > 0
          ? { tracking: line.trackingOptionIds.map((trackingOptionID) => ({ trackingOptionID })) }
          : {}),
      })),
    }],
  };
}

function expectedUpdateInstant(value: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_FAILED", "Bank Transaction expectedUpdatedAt must be a valid ISO timestamp.", {
      httpStatus: 422,
      details: { path: "expectedUpdatedAt", providerMutationPossible: false },
    });
  }
  return parsed.getTime();
}

/**
 * Narrow Xero SDK adapter. There is intentionally no transfer, batch payment,
 * bank-feed, reconciliation, void/delete, or arbitrary-object method here.
 */
export class XeroPaymentBankTransactionProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async createPayment(
    principal: AccountingPrincipal,
    payload: CanonicalPaymentCreatePayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<PaymentBankTransactionWriteReceipt> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroPaymentBankTransactionProvider.createPayment",
      actionId: "payment.create",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      await this.#preflightPayment(client.accountingApi, connection.tenantId, payload);
      let created: Awaited<ReturnType<typeof client.accountingApi.createPayment>>;
      try {
        created = await client.accountingApi.createPayment(connection.tenantId, {
          invoice: { invoiceID: payload.invoiceId },
          account: { accountID: payload.bankAccountId },
          date: payload.paymentDate,
          amount: Number(payload.amount),
          ...(payload.reference ? { reference: payload.reference } : {}),
        }, idempotencyKey);
      } catch (error) {
        throw this.#mutationFailure("Xero could not confirm the payment-record creation result.", error);
      }
      const returned = responsePayment(created.body);
      if (providerHasErrors(returned ?? created.body)) {
        throw rejected("Xero rejected the invoice or bill payment record.", {
          validationErrorCount: validationErrors(returned ?? created.body).length,
        });
      }
      const paymentId = exactUuid(returned?.paymentID);
      if (!paymentId) throw writeUnknown("Xero returned no PaymentID for the payment record; recovery is required.");
      return {
        objectId: paymentId,
        receipt: {
          operation: "CREATE_PAYMENT_RECORD",
          objectId: paymentId,
          ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
        },
      };
    });
  }

  async reversePayment(
    principal: AccountingPrincipal,
    payload: CanonicalPaymentReversePayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<PaymentBankTransactionWriteReceipt> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroPaymentBankTransactionProvider.reversePayment",
      actionId: "payment.reverse",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      await this.#preflightPaymentReverse(client.accountingApi, connection.tenantId, payload.paymentId);
      let reversed: Awaited<ReturnType<typeof client.accountingApi.deletePayment>>;
      try {
        // Xero calls this SDK endpoint deletePayment, but the permitted action
        // is only its documented `status: DELETED` soft reversal. No hard-delete
        // model is exposed by this provider.
        reversed = await client.accountingApi.deletePayment(
          connection.tenantId,
          payload.paymentId,
          { status: "DELETED" },
          idempotencyKey,
        );
      } catch (error) {
        throw this.#mutationFailure("Xero could not confirm the payment reversal result.", error);
      }
      const returned = responsePayment(reversed.body, payload.paymentId);
      if (providerHasErrors(returned ?? reversed.body)) {
        throw rejected("Xero rejected the payment reversal.", {
          paymentId: payload.paymentId,
          validationErrorCount: validationErrors(returned ?? reversed.body).length,
        });
      }
      if (!returned || returned.status !== Payment.StatusEnum.DELETED) {
        throw writeUnknown("Xero did not return the same PaymentID in DELETED status for the reversal.", undefined, {
          paymentId: payload.paymentId,
        });
      }
      return {
        objectId: payload.paymentId,
        receipt: {
          operation: "REVERSE_PAYMENT_RECORD",
          objectId: payload.paymentId,
          reversalModel: "XERO_STATUS_DELETED_SOFT_REVERSAL",
          ...(providerRequestId(reversed.response) ? { providerRequestId: providerRequestId(reversed.response) } : {}),
        },
      };
    });
  }

  async createBankTransaction(
    principal: AccountingPrincipal,
    payload: CanonicalBankTransactionCreatePayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<PaymentBankTransactionWriteReceipt> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroPaymentBankTransactionProvider.createBankTransaction",
      actionId: "bank_transaction.create",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      const resolvedLines = await this.#preflightBankTransactionReferences(client.accountingApi, connection.tenantId, payload);
      let created: Awaited<ReturnType<typeof client.accountingApi.createBankTransactions>>;
      try {
        created = await client.accountingApi.createBankTransactions(
          connection.tenantId,
          bankTransactionBody(payload, resolvedLines),
          true,
          4,
          idempotencyKey,
        );
      } catch (error) {
        throw this.#mutationFailure("Xero could not confirm the Bank Transaction creation result.", error);
      }
      const returned = responseBankTransaction(created.body);
      if (providerHasErrors(returned ?? created.body)) {
        throw rejected("Xero rejected the Bank Transaction creation.", {
          validationErrorCount: validationErrors(returned ?? created.body).length,
        });
      }
      const bankTransactionId = exactUuid(returned?.bankTransactionID);
      if (!bankTransactionId) throw writeUnknown("Xero returned no BankTransactionID; recovery is required.");
      return {
        objectId: bankTransactionId,
        receipt: {
          operation: "CREATE_BANK_TRANSACTION",
          objectId: bankTransactionId,
          ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
        },
      };
    });
  }

  async updateBankTransaction(
    principal: AccountingPrincipal,
    payload: CanonicalBankTransactionUpdatePayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<PaymentBankTransactionWriteReceipt> {
    const authorizationPayload = {
      targetXeroObjectId: payload.bankTransactionId,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      replacement: payload,
    };
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroPaymentBankTransactionProvider.updateBankTransaction",
      actionId: "bank_transaction.update",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: authorizationPayload,
    }, async (client, connection) => {
      await this.#preflightBankTransactionUpdate(client.accountingApi, connection.tenantId, payload);
      const resolvedLines = await this.#preflightBankTransactionReferences(client.accountingApi, connection.tenantId, payload);
      let updated: Awaited<ReturnType<typeof client.accountingApi.updateBankTransaction>>;
      try {
        updated = await client.accountingApi.updateBankTransaction(
          connection.tenantId,
          payload.bankTransactionId,
          bankTransactionBody(payload, resolvedLines, payload.bankTransactionId),
          4,
          idempotencyKey,
        );
      } catch (error) {
        throw this.#mutationFailure("Xero could not confirm the Bank Transaction replacement result.", error);
      }
      const returned = responseBankTransaction(updated.body, payload.bankTransactionId);
      if (providerHasErrors(returned ?? updated.body)) {
        throw rejected("Xero rejected the Bank Transaction replacement.", {
          bankTransactionId: payload.bankTransactionId,
          validationErrorCount: validationErrors(returned ?? updated.body).length,
        });
      }
      if (!returned) {
        throw writeUnknown("Xero returned no same-ID Bank Transaction after replacement; recovery is required.", undefined, {
          bankTransactionId: payload.bankTransactionId,
        });
      }
      return {
        objectId: payload.bankTransactionId,
        receipt: {
          operation: "UPDATE_BANK_TRANSACTION",
          objectId: payload.bankTransactionId,
          ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
        },
      };
    });
  }

  async reverseBankTransaction(
    principal: AccountingPrincipal,
    payload: CanonicalBankTransactionReversePayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<PaymentBankTransactionWriteReceipt> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroPaymentBankTransactionProvider.reverseBankTransaction",
      actionId: "bank_transaction.reverse",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      await this.#preflightBankTransactionReverse(client.accountingApi, connection.tenantId, payload.bankTransactionId);
      let reversed: Awaited<ReturnType<typeof client.accountingApi.updateBankTransaction>>;
      try {
        // The SDK names this endpoint updateBankTransaction. The released
        // action is only exact-ID status=DELETED (Xero soft reversal), never
        // hard deletion or bank-feed/reconciliation mutation.
        reversed = await client.accountingApi.updateBankTransaction(
          connection.tenantId,
          payload.bankTransactionId,
          { bankTransactions: [{ bankTransactionID: payload.bankTransactionId, status: BankTransaction.StatusEnum.DELETED } as BankTransaction] },
          4,
          idempotencyKey,
        );
      } catch (error) {
        throw this.#mutationFailure("Xero could not confirm the Bank Transaction reversal result.", error);
      }
      const returned = responseBankTransaction(reversed.body, payload.bankTransactionId);
      if (providerHasErrors(returned ?? reversed.body)) {
        throw rejected("Xero rejected the Bank Transaction reversal.", {
          bankTransactionId: payload.bankTransactionId,
          validationErrorCount: validationErrors(returned ?? reversed.body).length,
        });
      }
      if (!returned || returned.status !== BankTransaction.StatusEnum.DELETED) {
        throw writeUnknown("Xero did not return the same BankTransactionID in DELETED status for the reversal.", undefined, {
          bankTransactionId: payload.bankTransactionId,
        });
      }
      return {
        objectId: payload.bankTransactionId,
        receipt: {
          operation: "REVERSE_BANK_TRANSACTION",
          objectId: payload.bankTransactionId,
          reversalModel: "XERO_STATUS_DELETED_SOFT_REVERSAL",
          ...(providerRequestId(reversed.response) ? { providerRequestId: providerRequestId(reversed.response) } : {}),
        },
      };
    });
  }

  /** GET-only recovery seam: never attempts a second provider mutation. */
  async readAndVerifyPayment(
    principal: AccountingPrincipal,
    paymentId: string,
    expected: CanonicalPaymentCreatePayload,
  ): Promise<PaymentExactReadback>;
  async readAndVerifyPayment(
    principal: AccountingPrincipal,
    paymentId: string,
    expected: CanonicalPaymentReversePayload,
  ): Promise<PaymentReversalReadback>;
  async readAndVerifyPayment(
    principal: AccountingPrincipal,
    paymentId: string,
    expected: CanonicalPaymentCreatePayload | CanonicalPaymentReversePayload,
  ): Promise<PaymentExactReadback | PaymentReversalReadback> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getPayment(connection.tenantId, paymentId);
      const raw = responsePayment(response.body, paymentId);
      if (!raw) throw new AppError("NOT_FOUND", "The exact Xero Payment could not be read back.", { httpStatus: 404 });
      if (expected.operation === "REVERSE") {
        if (!sameUuid(raw.paymentID, expected.paymentId) || raw.status !== Payment.StatusEnum.DELETED) {
          throw readbackMismatch("The exact Xero Payment reversal was not read back as same-ID DELETED.", { paymentId });
        }
        return { paymentId: expected.paymentId, status: "DELETED" };
      }
      const readback = paymentReadback(raw);
      if (!readback || !paymentMatchesCreate(readback, expected)) {
        throw readbackMismatch("The exact Xero Payment readback did not match its prepared action.", { paymentId });
      }
      return readback;
    });
  }

  /** GET-only recovery seam: never creates, replaces, deletes, or reconciles. */
  async readAndVerifyBankTransaction(
    principal: AccountingPrincipal,
    bankTransactionId: string,
    expected: CanonicalBankTransactionCreatePayload | CanonicalBankTransactionUpdatePayload,
  ): Promise<BankTransactionExactReadback> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getBankTransaction(connection.tenantId, bankTransactionId, 4);
      const raw = responseBankTransaction(response.body, bankTransactionId);
      const readback = raw ? bankTransactionReadback(raw) : undefined;
      if (!readback) throw new AppError("NOT_FOUND", "The exact Xero Bank Transaction could not be read back.", { httpStatus: 404 });
      if (!bankTransactionMatches(readback, expected)) {
        throw readbackMismatch("The exact Xero Bank Transaction readback did not match its prepared full record.", {
          bankTransactionId,
        });
      }
      return readback;
    });
  }

  /** GET-only recovery seam for a Bank Transaction reversal. */
  async readAndVerifyBankTransactionReversal(
    principal: AccountingPrincipal,
    bankTransactionId: string,
    expected: CanonicalBankTransactionReversePayload,
  ): Promise<BankTransactionReversalReadback> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getBankTransaction(connection.tenantId, bankTransactionId, 4);
      const raw = responseBankTransaction(response.body, bankTransactionId);
      if (!raw || !sameUuid(raw.bankTransactionID, expected.bankTransactionId) ||
          raw.status !== BankTransaction.StatusEnum.DELETED) {
        throw readbackMismatch("The exact Xero Bank Transaction reversal was not read back as same-ID DELETED.", {
          bankTransactionId,
        });
      }
      return { bankTransactionId: expected.bankTransactionId, status: "DELETED" };
    });
  }

  #mutationFailure(message: string, error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
      return rejected("Xero rejected the requested Payment or Bank Transaction mutation.");
    }
    return writeUnknown(message, error);
  }

  async #preflightPayment(
    api: Pick<XeroClient["accountingApi"], "getInvoices" | "getAccounts">,
    tenantId: string,
    payload: CanonicalPaymentCreatePayload,
  ): Promise<void> {
    let invoiceResponse: unknown;
    let accountsResponse: unknown;
    try {
      [invoiceResponse, accountsResponse] = await Promise.all([
        api.getInvoices(
          tenantId, undefined, undefined, undefined, [payload.invoiceId], undefined, undefined, undefined,
          1, false, undefined, 4, false, 1,
        ),
        api.getAccounts(tenantId),
      ]);
    } catch (error) {
      throw preflightUnavailable("The exact Invoice/Bill and payment account could not be confirmed before Payment creation.", error);
    }
    const invoices = record(invoiceResponse)?.body;
    const source = record(invoices)?.invoices;
    const invoice = Array.isArray(source)
      ? record(source.find((value) => sameUuid(record(value)?.invoiceID, payload.invoiceId)))
      : undefined;
    if (!invoice) throw notFound("The exact Xero Invoice/Bill payment target was not found.", { invoiceId: payload.invoiceId });
    if (invoice.status !== "AUTHORISED") {
      throw conflict("Only an AUTHORISED Xero Invoice/Bill can receive this Payment record.", {
        invoiceId: payload.invoiceId,
        actualStatus: invoice.status,
      });
    }
    const expectedType = payload.invoiceType === "ACCREC" ? "ACCREC" : "ACCPAY";
    if (invoice.type !== expectedType) {
      throw conflict("The Payment invoice/bill type does not match the exact Xero target.", {
        invoiceId: payload.invoiceId,
        expectedType,
        actualType: invoice.type,
      });
    }
    const amountDue = fixedFour(invoice.amountDue);
    if (!amountDue || BigInt(amountDue.replace(".", "")) < BigInt(payload.amount.replace(".", ""))) {
      throw conflict("The Payment amount exceeds the exact Xero Invoice/Bill amount due.", {
        invoiceId: payload.invoiceId,
        amountDue: amountDue ?? "UNAVAILABLE",
      });
    }
    this.#requireActiveBankAccount(record(accountsResponse)?.body, payload.bankAccountId, true);
  }

  async #preflightPaymentReverse(
    api: Pick<XeroClient["accountingApi"], "getPayment">,
    tenantId: string,
    paymentId: string,
  ): Promise<void> {
    let response: unknown;
    try {
      response = await api.getPayment(tenantId, paymentId);
    } catch (error) {
      throw preflightUnavailable("The exact Xero Payment could not be confirmed before reversal.", error);
    }
    const payment = responsePayment(record(response)?.body, paymentId);
    if (!payment) throw notFound("The exact Xero Payment reversal target was not found.", { paymentId });
    if (payment.status !== Payment.StatusEnum.AUTHORISED) {
      throw conflict("Only an AUTHORISED Xero Payment can be soft-reversed.", { paymentId, actualStatus: payment.status });
    }
    if (payment.paymentType !== Payment.PaymentTypeEnum.ACCRECPAYMENT && payment.paymentType !== Payment.PaymentTypeEnum.ACCPAYPAYMENT) {
      throw conflict("Only Xero Invoice/Bill payments are implemented for reversal.", { paymentId, actualPaymentType: payment.paymentType });
    }
    if (exactUuid(payment.batchPaymentID)) {
      throw conflict("Batch Payment reversal is excluded from this provider.", { paymentId });
    }
  }

  async #preflightBankTransactionUpdate(
    api: Pick<XeroClient["accountingApi"], "getBankTransaction">,
    tenantId: string,
    payload: CanonicalBankTransactionUpdatePayload,
  ): Promise<void> {
    let response: unknown;
    try {
      response = await api.getBankTransaction(tenantId, payload.bankTransactionId, 4);
    } catch (error) {
      throw preflightUnavailable("The exact Xero Bank Transaction could not be confirmed before replacement.", error);
    }
    const current = responseBankTransaction(record(response)?.body, payload.bankTransactionId);
    if (!current) throw notFound("The exact Xero Bank Transaction update target was not found.", {
      bankTransactionId: payload.bankTransactionId,
    });
    if (current.status !== BankTransaction.StatusEnum.AUTHORISED) {
      throw conflict("Only an AUTHORISED Xero Bank Transaction can be fully replaced.", {
        bankTransactionId: payload.bankTransactionId,
        actualStatus: current.status,
      });
    }
    if (current.type !== payload.type) {
      throw conflict("A Bank Transaction replacement cannot change the original SPEND/RECEIVE type.", {
        bankTransactionId: payload.bankTransactionId,
        expectedType: payload.type,
        actualType: current.type,
      });
    }
    if (current.isReconciled !== false) {
      throw conflict("A reconciled or reconciliation-unknown Bank Transaction cannot be replaced.", {
        bankTransactionId: payload.bankTransactionId,
        isReconciled: current.isReconciled ?? "UNAVAILABLE",
        reasonCodes: ["FINAL_RECONCILIATION_EXCLUDED"],
      });
    }
    const actualUpdatedAt = providerInstant(current.updatedDateUTC ?? current.updatedDateUTCString);
    const expectedInstant = expectedUpdateInstant(payload.expectedUpdatedAt);
    if (!actualUpdatedAt) {
      throw conflict("The exact Xero Bank Transaction has no readable updated timestamp.", {
        bankTransactionId: payload.bankTransactionId,
        reasonCodes: ["UPDATED_AT_UNAVAILABLE"],
      });
    }
    if (new Date(actualUpdatedAt).getTime() !== expectedInstant) {
      throw conflict("The Xero Bank Transaction changed after it was prepared.", {
        bankTransactionId: payload.bankTransactionId,
        expectedUpdatedAt: payload.expectedUpdatedAt,
        actualUpdatedAt,
        reasonCodes: ["STALE_UPDATED_AT"],
      });
    }
  }

  async #preflightBankTransactionReverse(
    api: Pick<XeroClient["accountingApi"], "getBankTransaction">,
    tenantId: string,
    bankTransactionId: string,
  ): Promise<void> {
    let response: unknown;
    try {
      response = await api.getBankTransaction(tenantId, bankTransactionId, 4);
    } catch (error) {
      throw preflightUnavailable("The exact Xero Bank Transaction could not be confirmed before reversal.", error);
    }
    const current = responseBankTransaction(record(response)?.body, bankTransactionId);
    if (!current) throw notFound("The exact Xero Bank Transaction reversal target was not found.", { bankTransactionId });
    if (current.status !== BankTransaction.StatusEnum.AUTHORISED) {
      throw conflict("Only an AUTHORISED Xero Bank Transaction can be soft-reversed.", {
        bankTransactionId,
        actualStatus: current.status,
      });
    }
    if (current.isReconciled !== false) {
      throw conflict("A reconciled or reconciliation-unknown Bank Transaction cannot be reversed.", {
        bankTransactionId,
        isReconciled: current.isReconciled ?? "UNAVAILABLE",
        reasonCodes: ["FINAL_RECONCILIATION_EXCLUDED"],
      });
    }
  }

  async #preflightBankTransactionReferences(
    api: Pick<XeroClient["accountingApi"], "getContact" | "getAccounts" | "getTaxRates" | "getTrackingCategories">,
    tenantId: string,
    payload: CanonicalBankTransactionCreatePayload | CanonicalBankTransactionUpdatePayload,
  ): Promise<ResolvedBankTransactionLine[]> {
    let contactResponse: unknown;
    let accountsResponse: unknown;
    let taxesResponse: unknown;
    let trackingResponse: unknown;
    try {
      [contactResponse, accountsResponse, taxesResponse, trackingResponse] = await Promise.all([
        api.getContact(tenantId, payload.contactId),
        api.getAccounts(tenantId),
        api.getTaxRates(tenantId),
        api.getTrackingCategories(tenantId, undefined, undefined, false),
      ]);
    } catch (error) {
      throw preflightUnavailable("The exact Bank Transaction references could not be confirmed before mutation.", error);
    }
    const contacts = record(record(contactResponse)?.body)?.contacts;
    const contact = Array.isArray(contacts)
      ? record(contacts.find((value) => sameUuid(record(value)?.contactID, payload.contactId)))
      : undefined;
    if (!contact) throw notFound("The exact Xero Bank Transaction contact was not found.", { contactId: payload.contactId });
    if (contact.contactStatus !== "ACTIVE") {
      throw conflict("The Xero Bank Transaction contact is not ACTIVE.", { contactId: payload.contactId, actualStatus: contact.contactStatus });
    }
    const accounts = record(accountsResponse)?.body;
    this.#requireActiveBankAccount(accounts, payload.bankAccountId, false);
    const resolvedLines = this.#resolveBankTransactionLines(accounts, record(taxesResponse)?.body, payload.lines);
    const categories = record(record(trackingResponse)?.body)?.trackingCategories;
    if (!Array.isArray(categories)) throw preflightUnavailable("Xero returned no complete Tracking reference data.");
    const requested = new Set(payload.lines.flatMap((line) => line.trackingOptionIds));
    for (const optionId of requested) {
      let matched = false;
      for (const categoryValue of categories) {
        const category = record(categoryValue);
        if (!category || category.status !== "ACTIVE" || !Array.isArray(category.options)) continue;
        const option = category.options.map(record).find((value) => sameUuid(value?.trackingOptionID, optionId));
        if (option?.status === "ACTIVE") {
          matched = true;
          break;
        }
      }
      if (!matched) throw notFound("A Bank Transaction line Tracking option is not an exact ACTIVE Xero option.", {
        trackingOptionId: optionId,
      });
    }
    return resolvedLines;
  }

  #requireActiveBankAccount(body: unknown, accountId: string, requirePaymentEnabled: boolean): void {
    const accounts = record(body)?.accounts;
    if (!Array.isArray(accounts)) throw preflightUnavailable("Xero returned no complete Account reference data.");
    const account = record(accounts.find((value) => sameUuid(record(value)?.accountID, accountId)));
    if (!account) throw notFound("The exact Xero Bank account was not found.", { accountId });
    if (account.type !== "BANK" || account.status !== "ACTIVE") {
      throw conflict("The exact Xero account is not an ACTIVE BANK account.", {
        accountId,
        actualType: account.type,
        actualStatus: account.status,
      });
    }
    if (requirePaymentEnabled && account.enablePaymentsToAccount !== true) {
      throw conflict("The exact ACTIVE Xero BANK account is not enabled for Payment records.", { accountId });
    }
  }

  #resolveBankTransactionLines(
    body: unknown,
    taxBody: unknown,
    lines: ReadonlyArray<CanonicalBankTransactionCreatePayload["lines"][number]>,
  ): ResolvedBankTransactionLine[] {
    const accounts = record(body)?.accounts;
    if (!Array.isArray(accounts)) throw preflightUnavailable("Xero returned no complete Account reference data.");
    const taxRates = record(taxBody)?.taxRates;
    if (!Array.isArray(taxRates)) throw preflightUnavailable("Xero returned no complete Tax Rate reference data.");
    return lines.map((line) => {
      const matches = accounts.map(record).filter((value): value is ProviderRecord => value?.code === line.accountCode);
      if (matches.length === 0) throw notFound("A Bank Transaction line account code was not found.", { accountCode: line.accountCode });
      if (matches.length !== 1) throw conflict("A Bank Transaction line account code is not unique in the current tenant.", {
        accountCode: line.accountCode,
        matchCount: matches.length,
      });
      const account = matches[0]!;
      const accountId = exactUuid(account.accountID);
      if (!accountId) throw preflightUnavailable("Xero returned no exact account ID for a Bank Transaction line account.");
      if (account.status !== "ACTIVE" || (account.systemAccount !== undefined && account.systemAccount !== "")) {
        throw conflict("A Bank Transaction line account is not an ACTIVE postable account.", {
          accountCode: line.accountCode,
          actualStatus: account.status,
          systemAccount: account.systemAccount,
        });
      }
      const tax = record(taxRates.find((value) => record(value)?.taxType === line.taxType));
      if (!tax) throw notFound("A Bank Transaction line tax type was not found in Xero.", { taxType: line.taxType });
      if (tax.status !== "ACTIVE") throw conflict("A Bank Transaction line tax type is not ACTIVE.", {
        taxType: line.taxType,
        actualStatus: tax.status,
      });
      const accountClass = typeof (account.class ?? account._class) === "string"
        ? String(account.class ?? account._class).toLowerCase()
        : undefined;
      const taxApplicability = accountClass === "asset" ? tax.canApplyToAssets
        : accountClass === "equity" ? tax.canApplyToEquity
          : accountClass === "liability" ? tax.canApplyToLiabilities
            : accountClass === "revenue" ? tax.canApplyToRevenue
              : accountClass === "expense" ? tax.canApplyToExpenses : undefined;
      if (taxApplicability === false || (typeof account.taxType === "string" && account.taxType.length > 0 && account.taxType !== line.taxType)) {
        throw conflict("The Bank Transaction line tax type is incompatible with its exact Xero account.", {
          accountCode: line.accountCode,
          taxType: line.taxType,
          accountTaxType: account.taxType,
        });
      }
      return { ...line, accountId };
    });
  }
}
