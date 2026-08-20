import { CreditNote, Invoice, ManualJournal, Payment, type XeroClient } from "xero-node";
import { AppError } from "../errors.js";
import {
  ledgerAdjustmentAmountToSdkNumber,
  parseLedgerAdjustmentPayload,
  type AllocateCreditNotePayload,
  type AuthoriseCreditNotePayload,
  type RefundCreditNotePayload,
  type UnallocateCreditNotePayload,
  type VoidCreditNotePayload,
  type VoidInvoicePayload,
  type VoidManualJournalPayload,
} from "../domain/xeroLedgerAdjustment.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import { xeroProviderDate } from "./xeroProviderDate.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";

export interface XeroLedgerAdjustmentResult {
  /** The Case target ID, never a substituted allocation or payment ID. */
  objectId: string;
  status: "AUTHORISED" | "VOIDED";
  receipt: Record<string, unknown>;
}

export interface XeroLedgerAdjustmentReadback {
  objectId: string;
  status: "AUTHORISED" | "VOIDED";
  snapshot: Record<string, unknown>;
}

type SdkResponse = { headers?: unknown };
type ProviderRecord = Record<string, unknown>;
type XeroAdjustmentReadClient = Readonly<{
  accountingApi: Pick<XeroClient["accountingApi"],
    "getAccounts" | "getCreditNote" | "getInvoices" | "getManualJournal" | "getPayment">;
}>;

function providerRequestId(response: SdkResponse): string | undefined {
  if (!response.headers || typeof response.headers !== "object") return undefined;
  const headers = response.headers as Record<string, unknown>;
  const value = headers["xero-correlation-id"] ?? headers["x-request-id"];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function record(value: unknown): ProviderRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderRecord
    : undefined;
}

function sameId(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function xeroInvoiceType(value: "ACCREC" | "ACCPAY"): Invoice.TypeEnum {
  return value === "ACCREC" ? Invoice.TypeEnum.ACCREC : Invoice.TypeEnum.ACCPAY;
}

function xeroCreditNoteType(value: "ACCRECCREDIT" | "ACCPAYCREDIT"): CreditNote.TypeEnum {
  return value === "ACCRECCREDIT" ? CreditNote.TypeEnum.ACCRECCREDIT : CreditNote.TypeEnum.ACCPAYCREDIT;
}

function validationErrors(value: unknown): unknown[] {
  const candidate = record(value);
  return Array.isArray(candidate?.validationErrors) ? candidate.validationErrors : [];
}

function hasProviderErrors(value: unknown): boolean {
  const candidate = record(value);
  return candidate?.hasErrors === true || validationErrors(candidate).length > 0;
}

function preconditionRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("STALE_PREFLIGHT", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      providerMutationPossible: false,
      writeOutcome: "DEFINITELY_REJECTED",
      ...(details ?? {}),
    },
  });
}

function providerRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: { writeOutcome: "DEFINITELY_REJECTED", ...(details ?? {}) },
  });
}

function preflightUnavailable(message: string, cause?: unknown): AppError {
  return new AppError("PROVIDER_UNAVAILABLE", message, {
    httpStatus: 503,
    retryable: true,
    ...(cause ? { cause } : {}),
    details: { providerMutationPossible: false, phase: "EXACT_PREWRITE_READ" },
  });
}

function writeUnknown(message: string, cause?: unknown): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

function readbackMismatch(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("READBACK_MISMATCH", message, {
    httpStatus: 409,
    retryable: false,
    details: { providerMutationPossible: false, ...(details ?? {}) },
  });
}

function readbackUnavailable(message: string, cause?: unknown): AppError {
  return new AppError("PROVIDER_UNAVAILABLE", message, {
    httpStatus: 503,
    retryable: true,
    ...(cause ? { cause } : {}),
    details: { providerMutationPossible: false, phase: "EXACT_READBACK" },
  });
}

function decimalFixedFour(value: unknown): bigint | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 900_000_000_000) {
    return undefined;
  }
  const rounded = value.toFixed(4);
  // This is intentionally stricter than a numerical epsilon. A hidden fifth
  // decimal would make an exact allocation/refund comparison ambiguous.
  if (Number(rounded) !== value) return undefined;
  return BigInt(rounded.replace(".", ""));
}

function requireExactRecord(
  body: unknown,
  collection: string,
  idField: string,
  expectedId: string,
  label: string,
): ProviderRecord {
  const envelope = record(body);
  const values = envelope?.[collection];
  if (!Array.isArray(values)) {
    throw preconditionRejected(`Xero did not return the exact ${label} target.`, { expectedId });
  }
  const exact = values.find((candidate) => sameId(record(candidate)?.[idField], expectedId));
  const result = record(exact);
  if (!result) throw preconditionRejected(`The exact Xero ${label} target was not found.`, { expectedId });
  if (hasProviderErrors(result)) {
    throw preconditionRejected(`Xero returned validation errors for the ${label} target.`, {
      expectedId,
      validationErrorCount: validationErrors(result).length,
    });
  }
  return result;
}

function requireStatusAndType(
  value: ProviderRecord,
  expectedStatus: string,
  expectedType: string,
  label: string,
): void {
  if (value.status !== expectedStatus || value.type !== expectedType) {
    throw preconditionRejected(`The exact Xero ${label} is no longer eligible for this action.`, {
      expectedStatus,
      actualStatus: typeof value.status === "string" ? value.status : "UNKNOWN",
      expectedType,
      actualType: typeof value.type === "string" ? value.type : "UNKNOWN",
    });
  }
}

function requireNoAppliedInvoiceValue(value: ProviderRecord): void {
  if (decimalFixedFour(value.amountPaid) !== 0n || decimalFixedFour(value.amountCredited) !== 0n) {
    throw preconditionRejected("An invoice or bill with payments or credit applications cannot be voided.", {
      amountPaidKnown: decimalFixedFour(value.amountPaid) !== undefined,
      amountCreditedKnown: decimalFixedFour(value.amountCredited) !== undefined,
    });
  }
  for (const field of ["payments", "creditNotes", "prepayments", "overpayments"] as const) {
    const entries = value[field];
    if (entries !== undefined && (!Array.isArray(entries) || entries.length !== 0)) {
      throw preconditionRejected("An invoice or bill with payments or credit applications cannot be voided.", {
        applicationField: field,
      });
    }
  }
}

function requireNoAppliedCredit(value: ProviderRecord): void {
  if (decimalFixedFour(value.appliedAmount) !== 0n) {
    throw preconditionRejected("A credit note with allocations or payments cannot be voided.", {
      appliedAmountKnown: decimalFixedFour(value.appliedAmount) !== undefined,
    });
  }
  for (const field of ["allocations", "payments"] as const) {
    const entries = value[field];
    if (entries !== undefined && (!Array.isArray(entries) || entries.length !== 0)) {
      throw preconditionRejected("A credit note with allocations or payments cannot be voided.", {
        applicationField: field,
      });
    }
  }
}

function requireCreditAndInvoiceCompatibility(
  credit: ProviderRecord,
  invoice: ProviderRecord,
  input: AllocateCreditNotePayload,
): void {
  const expectedAmount = BigInt(input.amount.replace(".", ""));
  const remaining = decimalFixedFour(credit.remainingCredit);
  const due = decimalFixedFour(invoice.amountDue);
  if (remaining === undefined || remaining < expectedAmount || due === undefined || due < expectedAmount) {
    throw preconditionRejected("The credit note or target invoice has insufficient exact remaining balance.", {
      creditRemainingKnown: remaining !== undefined,
      invoiceAmountDueKnown: due !== undefined,
    });
  }
  const creditContactId = record(credit.contact)?.contactID;
  const invoiceContactId = record(invoice.contact)?.contactID;
  if (!sameId(creditContactId, String(invoiceContactId ?? ""))) {
    throw preconditionRejected("The credit note and target invoice must have the same exact Xero contact.");
  }
  const creditCurrency = credit.currencyCode;
  const invoiceCurrency = invoice.currencyCode;
  if (typeof creditCurrency !== "string" || typeof invoiceCurrency !== "string" || creditCurrency !== invoiceCurrency) {
    throw preconditionRejected("The credit note and target invoice must have the same known currency.", {
      creditCurrency: typeof creditCurrency === "string" ? creditCurrency : "UNKNOWN",
      invoiceCurrency: typeof invoiceCurrency === "string" ? invoiceCurrency : "UNKNOWN",
    });
  }
}

function requireAllocationReadback(
  credit: ProviderRecord,
  input: AllocateCreditNotePayload,
): string {
  if (credit.status !== CreditNote.StatusEnum.AUTHORISED || credit.type !== input.creditNoteType) {
    throw writeUnknown("Xero allocation did not leave the same credit note AUTHORISED.");
  }
  const expectedAmount = BigInt(input.amount.replace(".", ""));
  const allocations = credit.allocations;
  if (!Array.isArray(allocations)) throw writeUnknown("Xero allocation readback has no allocation evidence.");
  const allocation = allocations.find((candidate) => {
    const raw = record(candidate);
    return sameId(record(raw?.invoice)?.invoiceID, input.targetInvoiceId) &&
      decimalFixedFour(raw?.amount) === expectedAmount && xeroProviderDate(raw?.date) === input.allocationDate;
  });
  const allocationId = record(allocation)?.allocationID;
  if (typeof allocationId !== "string" || allocationId.length === 0) {
    throw writeUnknown("Xero allocation could not be exactly read back on the target credit note.");
  }
  return allocationId;
}

function requireUnallocationPreflight(
  credit: ProviderRecord,
  input: UnallocateCreditNotePayload,
): ProviderRecord {
  if (credit.status !== CreditNote.StatusEnum.AUTHORISED || credit.creditNoteID === undefined) {
    throw preconditionRejected("Only an exact AUTHORISED Xero credit note can have an allocation removed.", {
      creditNoteId: input.creditNoteId,
      actualStatus: typeof credit.status === "string" ? credit.status : "UNKNOWN",
    });
  }
  const allocations = credit.allocations;
  if (!Array.isArray(allocations)) {
    throw preconditionRejected("Xero did not return allocation evidence for the exact credit note.", {
      creditNoteId: input.creditNoteId,
      reasonCodes: ["CREDIT_NOTE_ALLOCATIONS_UNAVAILABLE"],
    });
  }
  const allocation = allocations.find((candidate) => sameId(record(candidate)?.allocationID, input.allocationId));
  const exact = record(allocation);
  if (!exact) {
    throw preconditionRejected("The exact allocation does not belong to the target credit note.", {
      creditNoteId: input.creditNoteId,
      allocationId: input.allocationId,
    });
  }
  if (exact.isDeleted === true) {
    throw preconditionRejected("The exact allocation is already deleted.", {
      creditNoteId: input.creditNoteId,
      allocationId: input.allocationId,
    });
  }
  const nestedCreditNoteId = record(exact.creditNote)?.creditNoteID;
  if (nestedCreditNoteId !== undefined && !sameId(nestedCreditNoteId, input.creditNoteId)) {
    throw preconditionRejected("The exact allocation belongs to a different credit note.", {
      creditNoteId: input.creditNoteId,
      allocationId: input.allocationId,
    });
  }
  return exact;
}

/**
 * Explicit Xero-only ledger adjustment adapter. Each method owns exactly one
 * Accounting Case action; it intentionally exposes neither generic status
 * mutation nor hard delete nor any external payment instruction. The one
 * delete call is the typed Xero Credit Note allocation-unallocate primitive.
 */
export class XeroLedgerAdjustmentProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async voidSalesInvoice(
    principal: AccountingPrincipal,
    rawInput: VoidInvoicePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("customer_invoice.void", rawInput) as VoidInvoicePayload;
    return this.#voidInvoice(principal, input, mutationRequestId, providerWritePermit, {
      actionId: "customer_invoice.void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidSalesInvoice",
      receiptOperation: "VOID_SALES_INVOICE",
    });
  }

  async voidSupplierBill(
    principal: AccountingPrincipal,
    rawInput: VoidInvoicePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("supplier_bill.void", rawInput) as VoidInvoicePayload;
    return this.#voidInvoice(principal, input, mutationRequestId, providerWritePermit, {
      actionId: "supplier_bill.void",
      adapterOperation: "XeroLedgerAdjustmentProvider.voidSupplierBill",
      receiptOperation: "VOID_SUPPLIER_BILL",
    });
  }

  async authoriseCreditNote(
    principal: AccountingPrincipal,
    rawInput: AuthoriseCreditNotePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("credit_note.authorise", rawInput) as AuthoriseCreditNotePayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.authoriseCreditNote",
      actionId: "credit_note.authorise",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const before = await this.#getCreditPrewrite(client, connection.tenantId, input.creditNoteId);
      requireStatusAndType(before, input.expectedStatus, input.creditNoteType, "credit note");
      let updated: Awaited<ReturnType<typeof client.accountingApi.updateCreditNote>>;
      try {
        updated = await client.accountingApi.updateCreditNote(
          connection.tenantId,
          input.creditNoteId,
          { creditNotes: [{ creditNoteID: input.creditNoteId, type: xeroCreditNoteType(input.creditNoteType), status: CreditNote.StatusEnum.AUTHORISED }] },
          4,
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero credit-note authorisation outcome is unknown.", "Xero rejected the credit-note authorisation.", error);
      }
      if (hasProviderErrors(updated.body?.creditNotes?.[0])) {
        throw providerRejected("Xero rejected the credit-note authorisation.", {
          validationErrorCount: validationErrors(updated.body?.creditNotes?.[0]).length,
        });
      }
      return {
        objectId: input.creditNoteId,
        status: "AUTHORISED",
        receipt: {
          operation: "AUTHORISE_CREDIT_NOTE",
          creditNoteId: input.creditNoteId,
          ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
        },
      };
    });
  }

  async allocateCreditNote(
    principal: AccountingPrincipal,
    rawInput: AllocateCreditNotePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("credit_note.allocate", rawInput) as AllocateCreditNotePayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.allocateCreditNote",
      actionId: "credit_note.allocate",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const [credit, invoice] = await Promise.all([
        this.#getCreditPrewrite(client, connection.tenantId, input.creditNoteId),
        this.#getInvoicePrewrite(client, connection.tenantId, input.targetInvoiceId),
      ]);
      requireStatusAndType(credit, input.expectedCreditStatus, input.creditNoteType, "credit note");
      requireStatusAndType(invoice, input.expectedTargetStatus, input.targetInvoiceType, "target invoice");
      requireCreditAndInvoiceCompatibility(credit, invoice, input);
      let allocated: Awaited<ReturnType<typeof client.accountingApi.createCreditNoteAllocation>>;
      try {
        allocated = await client.accountingApi.createCreditNoteAllocation(
          connection.tenantId,
          input.creditNoteId,
          { allocations: [{ invoice: { invoiceID: input.targetInvoiceId }, amount: ledgerAdjustmentAmountToSdkNumber(input.amount), date: input.allocationDate }] },
          true,
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero credit-note allocation outcome is unknown.", "Xero rejected the credit-note allocation.", error);
      }
      const responseAllocation = allocated.body?.allocations?.[0];
      if (hasProviderErrors(responseAllocation)) {
        throw providerRejected("Xero rejected the credit-note allocation.", {
          validationErrorCount: validationErrors(responseAllocation).length,
        });
      }
      if (!responseAllocation?.allocationID) {
        throw writeUnknown("Xero returned no allocation ID; exact recovery is required.");
      }
      const allocationId = responseAllocation.allocationID;
      return {
        objectId: input.creditNoteId,
        status: "AUTHORISED",
        receipt: {
          operation: "ALLOCATE_CREDIT_NOTE",
          creditNoteId: input.creditNoteId,
          targetInvoiceId: input.targetInvoiceId,
          allocationId,
          ...(providerRequestId(allocated.response) ? { providerRequestId: providerRequestId(allocated.response) } : {}),
        },
      };
    });
  }

  async unallocateCreditNote(
    principal: AccountingPrincipal,
    rawInput: UnallocateCreditNotePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("credit_note.unallocate", rawInput) as UnallocateCreditNotePayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.unallocateCreditNote",
      actionId: "credit_note.unallocate",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const credit = await this.#getCreditPrewrite(client, connection.tenantId, input.creditNoteId);
      requireUnallocationPreflight(credit, input);
      let deleted: Awaited<ReturnType<typeof client.accountingApi.deleteCreditNoteAllocations>>;
      try {
        deleted = await client.accountingApi.deleteCreditNoteAllocations(
          connection.tenantId,
          input.creditNoteId,
          input.allocationId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero credit-note unallocation outcome is unknown.", "Xero rejected the credit-note unallocation.", error);
      }
      const deletedAllocation = record(deleted.body);
      if (hasProviderErrors(deleted.body)) {
        throw providerRejected("Xero rejected the credit-note unallocation.", {
          validationErrorCount: validationErrors(deleted.body).length,
        });
      }
      if (!deletedAllocation || !sameId(deletedAllocation.allocationID, input.allocationId) || deletedAllocation.isDeleted !== true) {
        throw writeUnknown("Xero did not return the same allocation as deleted; exact recovery is required.");
      }
      return {
        objectId: input.creditNoteId,
        status: "AUTHORISED",
        receipt: {
          operation: "UNALLOCATE_CREDIT_NOTE",
          creditNoteId: input.creditNoteId,
          allocationId: input.allocationId,
          allocationDeleted: true,
          ...(providerRequestId(deleted.response) ? { providerRequestId: providerRequestId(deleted.response) } : {}),
        },
      };
    });
  }

  async refundCreditNote(
    principal: AccountingPrincipal,
    rawInput: RefundCreditNotePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("credit_note.refund", rawInput) as RefundCreditNotePayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.refundCreditNote",
      actionId: "credit_note.refund",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const [credit, accountsResponse] = await Promise.all([
        this.#getCreditPrewrite(client, connection.tenantId, input.creditNoteId),
        this.#getAccountsPrewrite(client, connection.tenantId),
      ]);
      requireStatusAndType(credit, input.expectedStatus, input.creditNoteType, "credit note");
      const requestedAmount = BigInt(input.amount.replace(".", ""));
      const remaining = decimalFixedFour(credit.remainingCredit);
      if (remaining === undefined || remaining < requestedAmount) {
        throw preconditionRejected("The credit note has insufficient exact remaining credit for this refund.", {
          remainingCreditKnown: remaining !== undefined,
        });
      }
      const bankAccount = accountsResponse.find((candidate) => sameId(candidate.accountID, input.bankAccountId));
      if (!bankAccount || bankAccount.status !== "ACTIVE" || bankAccount.type !== "BANK" || bankAccount.enablePaymentsToAccount !== true) {
        throw preconditionRejected("The refund requires one exact ACTIVE BANK account enabled for payments.", {
          bankAccountId: input.bankAccountId,
        });
      }
      let created: Awaited<ReturnType<typeof client.accountingApi.createPayment>>;
      try {
        // This only records the payment/refund fact in Xero. It does not call
        // any bank, payment processor, batch-payment, or external release API.
        created = await client.accountingApi.createPayment(
          connection.tenantId,
          {
            creditNote: { creditNoteID: input.creditNoteId },
            account: { accountID: input.bankAccountId },
            date: input.refundDate,
            amount: ledgerAdjustmentAmountToSdkNumber(input.amount),
          },
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero credit-note refund outcome is unknown.", "Xero rejected the credit-note refund.", error);
      }
      const responsePayment = created.body?.payments?.[0];
      if (hasProviderErrors(responsePayment)) {
        throw providerRejected("Xero rejected the credit-note refund.", {
          validationErrorCount: validationErrors(responsePayment).length,
        });
      }
      if (!responsePayment?.paymentID) throw writeUnknown("Xero returned no refund payment ID; recovery is required.");
      return {
        objectId: input.creditNoteId,
        status: "AUTHORISED",
        receipt: {
          operation: "REFUND_CREDIT_NOTE",
          creditNoteId: input.creditNoteId,
          refundPaymentId: responsePayment.paymentID,
          ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
        },
      };
    });
  }

  async voidCreditNote(
    principal: AccountingPrincipal,
    rawInput: VoidCreditNotePayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("credit_note.void", rawInput) as VoidCreditNotePayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.voidCreditNote",
      actionId: "credit_note.void",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const before = await this.#getCreditPrewrite(client, connection.tenantId, input.creditNoteId);
      requireStatusAndType(before, input.expectedStatus, input.creditNoteType, "credit note");
      requireNoAppliedCredit(before);
      let updated: Awaited<ReturnType<typeof client.accountingApi.updateCreditNote>>;
      try {
        updated = await client.accountingApi.updateCreditNote(
          connection.tenantId,
          input.creditNoteId,
          { creditNotes: [{ creditNoteID: input.creditNoteId, type: xeroCreditNoteType(input.creditNoteType), status: CreditNote.StatusEnum.VOIDED }] },
          4,
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero credit-note void outcome is unknown.", "Xero rejected the credit-note void.", error);
      }
      if (hasProviderErrors(updated.body?.creditNotes?.[0])) {
        throw providerRejected("Xero rejected the credit-note void.", {
          validationErrorCount: validationErrors(updated.body?.creditNotes?.[0]).length,
        });
      }
      return {
        objectId: input.creditNoteId,
        status: "VOIDED",
        receipt: {
          operation: "VOID_CREDIT_NOTE",
          creditNoteId: input.creditNoteId,
          ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
        },
      };
    });
  }

  async voidManualJournal(
    principal: AccountingPrincipal,
    rawInput: VoidManualJournalPayload,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerAdjustmentResult> {
    const input = parseLedgerAdjustmentPayload("manual_journal.void", rawInput) as VoidManualJournalPayload;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroLedgerAdjustmentProvider.voidManualJournal",
      actionId: "manual_journal.void",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const before = await this.#getManualJournalPrewrite(client, connection.tenantId, input.manualJournalId);
      if (before.status !== input.expectedStatus) {
        throw preconditionRejected("The exact Xero manual journal is no longer POSTED.", {
          expectedStatus: input.expectedStatus,
          actualStatus: typeof before.status === "string" ? before.status : "UNKNOWN",
        });
      }
      if (typeof before.narration !== "string" || before.narration.length === 0) {
        throw preconditionRejected("Xero returned an incomplete manual-journal target; it cannot be safely voided.");
      }
      let updated: Awaited<ReturnType<typeof client.accountingApi.updateManualJournal>>;
      try {
        updated = await client.accountingApi.updateManualJournal(
          connection.tenantId,
          input.manualJournalId,
          { manualJournals: [{ manualJournalID: input.manualJournalId, narration: before.narration, status: ManualJournal.StatusEnum.VOIDED }] },
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero manual-journal void outcome is unknown.", "Xero rejected the manual-journal void.", error);
      }
      if (hasProviderErrors(updated.body?.manualJournals?.[0])) {
        throw providerRejected("Xero rejected the manual-journal void.", {
          validationErrorCount: validationErrors(updated.body?.manualJournals?.[0]).length,
        });
      }
      return {
        objectId: input.manualJournalId,
        status: "VOIDED",
        receipt: {
          operation: "VOID_MANUAL_JOURNAL",
          manualJournalId: input.manualJournalId,
          ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
        },
      };
    });
  }

  /**
   * GET-only readback seam for the Case operation store and recovery path.
   * It never receives a permit and cannot replay a provider mutation.
   */
  async readAndVerifyAdjustment(
    principal: AccountingPrincipal,
    actionId: Parameters<typeof parseLedgerAdjustmentPayload>[0],
    rawInput: unknown,
    receipt: Record<string, unknown>,
  ): Promise<XeroLedgerAdjustmentReadback> {
    const input = parseLedgerAdjustmentPayload(actionId, rawInput);
    return this.manager.withClient(principal, async (client, connection) => {
      switch (actionId) {
        case "customer_invoice.void":
        case "supplier_bill.void": {
          const typed = input as VoidInvoicePayload;
          const invoice = await this.#getInvoiceReadback(client, connection.tenantId, typed.invoiceId);
          if (invoice.status !== Invoice.StatusEnum.VOIDED || invoice.type !== typed.invoiceType) {
            throw readbackMismatch("The same Xero invoice/bill was not VOIDED on exact readback.");
          }
          return {
            objectId: typed.invoiceId,
            status: "VOIDED",
            snapshot: { actionId, invoice },
          };
        }
        case "credit_note.authorise": {
          const typed = input as AuthoriseCreditNotePayload;
          const creditNote = await this.#getCreditReadback(client, connection.tenantId, typed.creditNoteId);
          if (creditNote.status !== CreditNote.StatusEnum.AUTHORISED || creditNote.type !== typed.creditNoteType) {
            throw readbackMismatch("The same Xero credit note was not AUTHORISED on exact readback.");
          }
          return {
            objectId: typed.creditNoteId,
            status: "AUTHORISED",
            snapshot: { actionId, creditNote },
          };
        }
        case "credit_note.allocate": {
          const typed = input as AllocateCreditNotePayload;
          const [creditNote, invoice] = await Promise.all([
            this.#getCreditReadback(client, connection.tenantId, typed.creditNoteId),
            this.#getInvoiceReadback(client, connection.tenantId, typed.targetInvoiceId),
          ]);
          const allocationId = requireAllocationReadback(creditNote, typed);
          if (
            receipt.allocationId !== allocationId ||
            invoice.status !== Invoice.StatusEnum.AUTHORISED || invoice.type !== typed.targetInvoiceType
          ) {
            throw readbackMismatch("The Xero credit-note allocation does not match its provider receipt and exact targets.");
          }
          return {
            objectId: typed.creditNoteId,
            status: "AUTHORISED",
            snapshot: { actionId, creditNote, targetInvoice: invoice, allocationId },
          };
        }
        case "credit_note.unallocate": {
          const typed = input as UnallocateCreditNotePayload;
          if (!sameId(receipt.allocationId, typed.allocationId)) {
            throw readbackMismatch("The credit-note unallocation receipt does not match the exact allocation target.");
          }
          const creditNote = await this.#getCreditReadback(client, connection.tenantId, typed.creditNoteId);
          if (creditNote.status !== CreditNote.StatusEnum.AUTHORISED) {
            throw readbackMismatch("The same Xero credit note was not AUTHORISED on unallocation readback.");
          }
          const allocations = creditNote.allocations;
          if (!Array.isArray(allocations)) {
            throw readbackUnavailable("Xero credit-note unallocation readback has no allocation evidence.");
          }
          const allocation = allocations.find((candidate) => sameId(record(candidate)?.allocationID, typed.allocationId));
          if (allocation && record(allocation)?.isDeleted !== true) {
            throw readbackMismatch("The exact Xero credit-note allocation still exists after unallocation.");
          }
          return {
            objectId: typed.creditNoteId,
            status: "AUTHORISED",
            snapshot: {
              actionId,
              creditNote,
              allocationId: typed.allocationId,
              allocationRemoved: allocation === undefined || record(allocation)?.isDeleted === true,
            },
          };
        }
        case "credit_note.refund": {
          const typed = input as RefundCreditNotePayload;
          const paymentId = receipt.refundPaymentId;
          if (typeof paymentId !== "string" || paymentId.length === 0) {
            throw readbackMismatch("The durable refund receipt has no exact Xero payment ID.");
          }
          const [creditNote, payment] = await Promise.all([
            this.#getCreditReadback(client, connection.tenantId, typed.creditNoteId),
            this.#getPaymentReadback(client, connection.tenantId, paymentId),
          ]);
          const expectedAmount = BigInt(typed.amount.replace(".", ""));
          if (
            creditNote.status !== CreditNote.StatusEnum.AUTHORISED || creditNote.type !== typed.creditNoteType ||
            !sameId(record(payment.creditNote)?.creditNoteID, typed.creditNoteId) ||
            !sameId(record(payment.account)?.accountID, typed.bankAccountId) ||
            payment.status !== Payment.StatusEnum.AUTHORISED || xeroProviderDate(payment.date) !== typed.refundDate ||
            decimalFixedFour(payment.amount) !== expectedAmount
          ) {
            throw readbackMismatch("The Xero credit-note refund does not match its exact payment readback.");
          }
          return {
            objectId: typed.creditNoteId,
            status: "AUTHORISED",
            snapshot: { actionId, creditNote, refundPayment: payment, refundPaymentId: paymentId },
          };
        }
        case "credit_note.void": {
          const typed = input as VoidCreditNotePayload;
          const creditNote = await this.#getCreditReadback(client, connection.tenantId, typed.creditNoteId);
          if (creditNote.status !== CreditNote.StatusEnum.VOIDED || creditNote.type !== typed.creditNoteType) {
            throw readbackMismatch("The same Xero credit note was not VOIDED on exact readback.");
          }
          return {
            objectId: typed.creditNoteId,
            status: "VOIDED",
            snapshot: { actionId, creditNote },
          };
        }
        case "manual_journal.void": {
          const typed = input as VoidManualJournalPayload;
          const manualJournal = await this.#getManualJournalReadback(client, connection.tenantId, typed.manualJournalId);
          if (manualJournal.status !== ManualJournal.StatusEnum.VOIDED) {
            throw readbackMismatch("The same Xero manual journal was not VOIDED on exact readback.");
          }
          return {
            objectId: typed.manualJournalId,
            status: "VOIDED",
            snapshot: { actionId, manualJournal },
          };
        }
      }
    });
  }

  async #voidInvoice(
    principal: AccountingPrincipal,
    input: VoidInvoicePayload,
    mutationRequestId: string,
    providerWritePermit: LedgerProviderWritePermit | undefined,
    metadata: Readonly<{
      actionId: "customer_invoice.void" | "supplier_bill.void";
      adapterOperation: "XeroLedgerAdjustmentProvider.voidSalesInvoice" | "XeroLedgerAdjustmentProvider.voidSupplierBill";
      receiptOperation: "VOID_SALES_INVOICE" | "VOID_SUPPLIER_BILL";
    }>,
  ): Promise<XeroLedgerAdjustmentResult> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: metadata.adapterOperation,
      actionId: metadata.actionId,
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      const before = await this.#getInvoicePrewrite(client, connection.tenantId, input.invoiceId);
      requireStatusAndType(before, input.expectedStatus, input.invoiceType, "invoice or bill");
      requireNoAppliedInvoiceValue(before);
      let updated: Awaited<ReturnType<typeof client.accountingApi.updateInvoice>>;
      try {
        updated = await client.accountingApi.updateInvoice(
          connection.tenantId,
          input.invoiceId,
          { invoices: [{ invoiceID: input.invoiceId, type: xeroInvoiceType(input.invoiceType), status: Invoice.StatusEnum.VOIDED }] },
          4,
          mutationRequestId,
        );
      } catch (error) {
        throw this.#classifyMutationFailure("The Xero invoice/bill void outcome is unknown.", "Xero rejected the invoice/bill void.", error);
      }
      if (hasProviderErrors(updated.body?.invoices?.[0])) {
        throw providerRejected("Xero rejected the invoice/bill void.", {
          validationErrorCount: validationErrors(updated.body?.invoices?.[0]).length,
        });
      }
      return {
        objectId: input.invoiceId,
        status: "VOIDED",
        receipt: {
          operation: metadata.receiptOperation,
          invoiceId: input.invoiceId,
          ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
        },
      };
    });
  }

  async #getInvoicePrewrite(client: XeroAdjustmentReadClient, tenantId: string, invoiceId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getInvoices(
        tenantId, undefined, undefined, undefined, [invoiceId], undefined, undefined, undefined,
        1, false, undefined, 4, false, 1,
      );
      return requireExactRecord(record(response)?.body, "invoices", "invoiceID", invoiceId, "invoice");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw preflightUnavailable("The exact Xero invoice/bill pre-write read is unavailable.", error);
    }
  }

  async #getInvoiceReadback(client: XeroAdjustmentReadClient, tenantId: string, invoiceId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getInvoices(
        tenantId, undefined, undefined, undefined, [invoiceId], undefined, undefined, undefined,
        1, false, undefined, 4, false, 1,
      );
      return requireExactRecord(record(response)?.body, "invoices", "invoiceID", invoiceId, "invoice");
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_PREFLIGHT") {
        throw readbackMismatch("Xero invoice/bill exact readback is incomplete.", error.details);
      }
      if (error instanceof AppError) throw error;
      throw readbackUnavailable("Xero invoice/bill exact readback is unavailable.", error);
    }
  }

  async #getCreditPrewrite(client: XeroAdjustmentReadClient, tenantId: string, creditNoteId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getCreditNote(tenantId, creditNoteId, 4);
      return requireExactRecord(record(response)?.body, "creditNotes", "creditNoteID", creditNoteId, "credit note");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw preflightUnavailable("The exact Xero credit-note pre-write read is unavailable.", error);
    }
  }

  async #getCreditReadback(client: XeroAdjustmentReadClient, tenantId: string, creditNoteId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getCreditNote(tenantId, creditNoteId, 4);
      return requireExactRecord(record(response)?.body, "creditNotes", "creditNoteID", creditNoteId, "credit note");
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_PREFLIGHT") {
        throw readbackMismatch("Xero credit-note exact readback is incomplete.", error.details);
      }
      if (error instanceof AppError) throw error;
      throw readbackUnavailable("Xero credit-note exact readback is unavailable.", error);
    }
  }

  async #getManualJournalPrewrite(client: XeroAdjustmentReadClient, tenantId: string, manualJournalId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getManualJournal(tenantId, manualJournalId);
      return requireExactRecord(record(response)?.body, "manualJournals", "manualJournalID", manualJournalId, "manual journal");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw preflightUnavailable("The exact Xero manual-journal pre-write read is unavailable.", error);
    }
  }

  async #getManualJournalReadback(client: XeroAdjustmentReadClient, tenantId: string, manualJournalId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getManualJournal(tenantId, manualJournalId);
      return requireExactRecord(record(response)?.body, "manualJournals", "manualJournalID", manualJournalId, "manual journal");
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_PREFLIGHT") {
        throw readbackMismatch("Xero manual-journal exact readback is incomplete.", error.details);
      }
      if (error instanceof AppError) throw error;
      throw readbackUnavailable("Xero manual-journal exact readback is unavailable.", error);
    }
  }

  async #getAccountsPrewrite(client: XeroAdjustmentReadClient, tenantId: string): Promise<ProviderRecord[]> {
    try {
      const response = await client.accountingApi.getAccounts(tenantId);
      const accounts = record(response)?.body && record(record(response)?.body)?.accounts;
      if (!Array.isArray(accounts)) throw preconditionRejected("Xero did not return an exact account list for the refund account check.");
      const parsed = accounts.map(record).filter((candidate): candidate is ProviderRecord => candidate !== undefined);
      if (parsed.length !== accounts.length) throw preconditionRejected("Xero returned an incomplete account projection for the refund account check.");
      return parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw preflightUnavailable("The Xero bank-account pre-write read is unavailable.", error);
    }
  }

  async #getPaymentReadback(client: XeroAdjustmentReadClient, tenantId: string, paymentId: string): Promise<ProviderRecord> {
    try {
      const response = await client.accountingApi.getPayment(tenantId, paymentId);
      return requireExactRecord(record(response)?.body, "payments", "paymentID", paymentId, "refund payment");
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_PREFLIGHT") {
        throw readbackMismatch("Xero refund-payment exact readback is incomplete.", error.details);
      }
      if (error instanceof AppError) throw error;
      throw readbackUnavailable("Xero refund-payment exact readback is unavailable.", error);
    }
  }

  #classifyMutationFailure(unknownMessage: string, rejectedMessage: string, error: unknown): AppError {
    if (error instanceof AppError) return error;
    return classifyXeroWriteException(error) === "DEFINITELY_REJECTED"
      ? providerRejected(rejectedMessage)
      : writeUnknown(unknownMessage, error);
  }
}
