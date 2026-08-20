import { Invoice, ManualJournal } from "xero-node";
import { AppError } from "../errors.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";

export type XeroAuthorisableInvoiceType = "ACCREC" | "ACCPAY";
const XERO_INVOICE_DRAFT = Invoice.StatusEnum.DRAFT;
const XERO_MANUAL_JOURNAL_DRAFT = ManualJournal.StatusEnum.DRAFT;

export interface AuthoriseInvoiceInput {
  invoiceId: string;
  invoiceType: XeroAuthorisableInvoiceType;
  expectedStatus: typeof XERO_INVOICE_DRAFT;
}

export interface PostManualJournalInput {
  manualJournalId: string;
  expectedStatus: typeof XERO_MANUAL_JOURNAL_DRAFT;
}

export interface XeroLedgerTransitionResult {
  objectId: string;
  status: "AUTHORISED" | "POSTED";
  receipt: Record<string, unknown>;
}

type SdkResponse = { headers?: unknown };

function providerRequestId(response: SdkResponse): string | undefined {
  if (!response.headers || typeof response.headers !== "object") return undefined;
  const headers = response.headers as Record<string, unknown>;
  const value = headers["xero-correlation-id"] ?? headers["x-request-id"];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function validationErrorCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const errors = (value as Record<string, unknown>).validationErrors;
  return Array.isArray(errors) ? errors.length : 0;
}

function hasProviderErrors(value: unknown): boolean {
  return !!value && typeof value === "object" && (
    (value as Record<string, unknown>).hasErrors === true || validationErrorCount(value) > 0
  );
}

function providerRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: { ...details, writeOutcome: "DEFINITELY_REJECTED" },
  });
}

function writeUnknown(message: string, cause?: unknown): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

function stateConflict(objectType: string, objectId: string, actualStatus: unknown): AppError {
  return new AppError("CONFLICT", `The Xero ${objectType} is no longer in DRAFT state.`, {
    httpStatus: 409,
    details: {
      objectId,
      expectedStatus: "DRAFT",
      actualStatus: typeof actualStatus === "string" ? actualStatus : "UNKNOWN",
      writeOutcome: "DEFINITELY_REJECTED",
    },
  });
}

/**
 * Thin, action-specific Xero transitions. This provider deliberately exposes
 * neither a generic status setter nor public MCP routes: Case integration owns
 * when these internal capabilities become reachable.
 */
export class XeroControlledLedgerTransitionProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async authoriseSalesInvoice(
    principal: AccountingPrincipal,
    input: AuthoriseInvoiceInput & { invoiceType: "ACCREC" },
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerTransitionResult> {
    return this.#authoriseInvoice(
      principal,
      input,
      mutationRequestId,
      providerWritePermit,
      "XeroControlledLedgerTransitionProvider.authoriseSalesInvoice",
      "customer_invoice.authorise",
    );
  }

  async authoriseSupplierBill(
    principal: AccountingPrincipal,
    input: AuthoriseInvoiceInput & { invoiceType: "ACCPAY" },
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerTransitionResult> {
    return this.#authoriseInvoice(
      principal,
      input,
      mutationRequestId,
      providerWritePermit,
      "XeroControlledLedgerTransitionProvider.authoriseSupplierBill",
      "supplier_bill.authorise",
    );
  }

  async postManualJournal(
    principal: AccountingPrincipal,
    input: PostManualJournalInput,
    mutationRequestId: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroLedgerTransitionResult> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroControlledLedgerTransitionProvider.postManualJournal",
      actionId: "manual_journal.post",
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      try {
        const beforeResponse = await client.accountingApi.getManualJournal(connection.tenantId, input.manualJournalId);
        const before = beforeResponse.body?.manualJournals?.find(
          (candidate) => candidate.manualJournalID === input.manualJournalId,
        );
        if (!before) {
          throw new AppError("NOT_FOUND", "The requested Xero manual journal was not found.", { httpStatus: 404 });
        }
        if (before.status !== input.expectedStatus) {
          throw stateConflict("manual journal", input.manualJournalId, before.status);
        }
        if (typeof before.narration !== "string" || before.narration.length === 0) {
          throw writeUnknown("Xero returned an incomplete manual-journal draft; recovery is required.");
        }

        const updated = await client.accountingApi.updateManualJournal(
          connection.tenantId,
          input.manualJournalId,
          { manualJournals: [{ manualJournalID: input.manualJournalId, narration: before.narration, status: ManualJournal.StatusEnum.POSTED }] },
          mutationRequestId,
        );
        if (hasProviderErrors(updated.body?.manualJournals?.[0])) {
          throw providerRejected("Xero rejected the manual-journal post.", {
            validationErrorCount: validationErrorCount(updated.body?.manualJournals?.[0]),
          });
        }

        const requestId = providerRequestId(updated.response);
        return {
          objectId: input.manualJournalId,
          status: "POSTED",
          receipt: {
            operation: "POST_MANUAL_JOURNAL",
            manualJournalId: input.manualJournalId,
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero manual-journal post result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the manual-journal post.");
      }
    });
  }

  async #authoriseInvoice(
    principal: AccountingPrincipal,
    input: AuthoriseInvoiceInput,
    mutationRequestId: string,
    providerWritePermit: LedgerProviderWritePermit | undefined,
    adapterOperation:
      | "XeroControlledLedgerTransitionProvider.authoriseSalesInvoice"
      | "XeroControlledLedgerTransitionProvider.authoriseSupplierBill",
    actionId: "customer_invoice.authorise" | "supplier_bill.authorise",
  ): Promise<XeroLedgerTransitionResult> {
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation,
      actionId,
      mutationRequestId,
      providerIdempotencyKey: mutationRequestId,
      canonicalPayload: input,
    }, async (client, connection) => {
      try {
        const beforeResponse = await client.accountingApi.getInvoices(
          connection.tenantId,
          undefined,
          undefined,
          undefined,
          [input.invoiceId],
          undefined,
          undefined,
          undefined,
          1,
          false,
          undefined,
          4,
          false,
          1,
        );
        const before = beforeResponse.body?.invoices?.find((candidate) => candidate.invoiceID === input.invoiceId);
        const expectedType = input.invoiceType === "ACCREC" ? Invoice.TypeEnum.ACCREC : Invoice.TypeEnum.ACCPAY;
        if (!before || before.type !== expectedType) {
          throw new AppError("NOT_FOUND", "The requested Xero invoice was not found.", { httpStatus: 404 });
        }
        if (before.status !== input.expectedStatus) {
          throw stateConflict("invoice", input.invoiceId, before.status);
        }

        const updated = await client.accountingApi.updateInvoice(
          connection.tenantId,
          input.invoiceId,
          {
            invoices: [{
              status: Invoice.StatusEnum.AUTHORISED,
            }],
          },
          4,
          mutationRequestId,
        );
        if (hasProviderErrors(updated.body?.invoices?.[0])) {
          throw providerRejected("Xero rejected the invoice authorisation.", {
            validationErrorCount: validationErrorCount(updated.body?.invoices?.[0]),
          });
        }

        const requestId = providerRequestId(updated.response);
        return {
          objectId: input.invoiceId,
          status: "AUTHORISED",
          receipt: {
            operation: input.invoiceType === "ACCREC" ? "AUTHORISE_SALES_INVOICE" : "AUTHORISE_SUPPLIER_BILL",
            invoiceId: input.invoiceId,
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero invoice authorisation result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the invoice authorisation.");
      }
    });
  }
}
