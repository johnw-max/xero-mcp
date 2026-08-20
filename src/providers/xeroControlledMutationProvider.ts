import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import type {
  CanonicalPurchaseOrderDraftPayload,
  CanonicalQuoteDraftPayload,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import {
  toXeroPurchaseOrderCreatePayload,
  toXeroQuoteCreatePayload,
  toXeroPurchaseOrderUpdatePayload,
  toXeroQuoteUpdatePayload,
  verifyPurchaseOrderDraftReadback,
  verifyQuoteDraftReadback,
  type DraftReadbackVerificationResult,
  type PurchaseOrderDraftReadbackSnapshot,
  type QuoteDraftReadbackSnapshot,
} from "./xeroQuotePurchaseOrderDraft.js";
import { mapItemSummary, type ItemSummary } from "./xeroExtendedReadMapper.js";
import { AppError } from "../errors.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import { xeroProviderInstant } from "./xeroProviderDate.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";

export interface XeroControlledCreateReceipt {
  objectId: string;
  receipt: Record<string, unknown>;
}

export interface TrackingOptionResolution {
  requestedIds: string[];
  matchedIds: string[];
  complete: boolean;
}

type SdkResponse = { headers?: unknown };

function providerRequestId(response: SdkResponse): string | undefined {
  if (!response.headers || typeof response.headers !== "object") return undefined;
  const headers = response.headers as Record<string, unknown>;
  const value = headers["xero-correlation-id"] ?? headers["x-request-id"];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function providerValidationErrors(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return Array.isArray(record.validationErrors) ? record.validationErrors : [];
}

function providerHasErrors(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).hasErrors === true || providerValidationErrors(value).length > 0;
}

function providerRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    ...(details ? { details: { ...details, writeOutcome: "DEFINITELY_REJECTED" } } : {
      details: { writeOutcome: "DEFINITELY_REJECTED" },
    }),
  });
}

function writeUnknown(message: string, error?: unknown): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(error ? { cause: error } : {}),
  });
}

function exactUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)
    ? trimmed.toLowerCase()
    : undefined;
}

function sameUuid(left: unknown, right: string): boolean {
  const normalizedLeft = exactUuid(left);
  const normalizedRight = exactUuid(right);
  return normalizedLeft !== undefined && normalizedRight !== undefined && normalizedLeft === normalizedRight;
}

function targetUuid(value: string, objectName: string): string {
  if (!sameUuid(value, value)) {
    throw new AppError("VALIDATION_FAILED", `${objectName} update target must be an exact UUID.`, {
      httpStatus: 422,
      retryable: false,
      details: { path: "targetXeroObjectId" },
    });
  }
  return value.trim();
}

function providerPreconditionRejected(message: string, details?: Record<string, unknown>): AppError {
  return providerRejected(message, {
    phase: "EXACT_DRAFT_PRECONDITION",
    providerMutationPossible: false,
    ...(details ?? {}),
  });
}

function providerPreconditionUnavailable(message: string, error?: unknown): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 503,
    retryable: true,
    ...(error ? { cause: error } : {}),
    details: {
      phase: "EXACT_DRAFT_PRECONDITION",
      reasonCodes: ["EXACT_DRAFT_PRECONDITION_UNAVAILABLE"],
      providerMutationPossible: false,
    },
  });
}

function expectedUpdatedAtInstant(value: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    throw new AppError("VALIDATION_FAILED", "expectedUpdatedAt must be an ISO datetime with an explicit offset.", {
      httpStatus: 422,
      retryable: false,
      details: { path: "expectedUpdatedAt", providerMutationPossible: false },
    });
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new AppError("VALIDATION_FAILED", "expectedUpdatedAt must be a valid ISO datetime.", {
      httpStatus: 422,
      retryable: false,
      details: { path: "expectedUpdatedAt", providerMutationPossible: false },
    });
  }
  return instant;
}

function providerUpdatedAtInstant(record: Record<string, unknown>): Date | undefined {
  return xeroProviderInstant(record.updatedDateUTC) ?? xeroProviderInstant(record.updatedDateUTCString) ??
    (typeof record.updatedDateUTC === "string" ? validPlainProviderInstant(record.updatedDateUTC) : undefined) ??
    (typeof record.updatedDateUTCString === "string" ? validPlainProviderInstant(record.updatedDateUTCString) : undefined);
}

function validPlainProviderInstant(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function providerPreconditionConflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      phase: "EXACT_DRAFT_PRECONDITION",
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
      ...(details ?? {}),
    },
  });
}

/**
 * An update must prove that its exact target still exists as a DRAFT before
 * the SDK mutation is sent. This callback runs on the mutation-capable client
 * so the GET and update share the same resolved tenant/token boundary.
 */
function requireExactDraft(
  response: unknown,
  objectId: string,
  expectedUpdatedAt: Date,
  objectName: "Quote" | "Purchase Order",
  idField: "quoteID" | "purchaseOrderID",
): Record<string, unknown> {
  if (!response || typeof response !== "object") {
    throw providerPreconditionRejected(`Xero returned no ${objectName} draft for the exact update target.`);
  }
  const body = (response as { body?: unknown }).body;
  if (!body || typeof body !== "object") {
    throw providerPreconditionRejected(`Xero returned no ${objectName} draft for the exact update target.`);
  }
  const values = (body as Record<string, unknown>)[objectName === "Quote" ? "quotes" : "purchaseOrders"];
  if (!Array.isArray(values)) {
    throw providerPreconditionRejected(`Xero returned no ${objectName} draft for the exact update target.`);
  }
  const exact = values.find((candidate) =>
    candidate !== null && typeof candidate === "object" && sameUuid((candidate as Record<string, unknown>)[idField], objectId),
  );
  if (!exact || typeof exact !== "object" || Array.isArray(exact)) {
    throw providerPreconditionRejected(`The exact Xero ${objectName} update target was not found.`, {
      targetXeroObjectId: objectId,
    });
  }
  const record = exact as Record<string, unknown>;
  if (providerHasErrors(record)) {
    throw providerPreconditionRejected(`Xero returned validation errors for the ${objectName} update target.`, {
      validationErrorCount: providerValidationErrors(record).length,
    });
  }
  if (record[idField] === undefined || !sameUuid(record[idField], objectId)) {
    throw providerPreconditionRejected(`Xero returned a different ${objectName} ID for the update target.`);
  }
  if (record.status !== "DRAFT") {
    throw providerPreconditionRejected(`Only a Xero DRAFT ${objectName} can be replaced.`, {
      expectedStatus: "DRAFT",
    });
  }
  const actualUpdatedAt = providerUpdatedAtInstant(record);
  if (!actualUpdatedAt) {
    throw providerPreconditionConflict(`The exact Xero ${objectName} has no readable updated timestamp.`, {
      reasonCodes: ["UPDATED_AT_UNAVAILABLE"],
    });
  }
  if (actualUpdatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw providerPreconditionConflict(`The Xero ${objectName} changed after it was reviewed; read it again before updating.`, {
      reasonCodes: ["STALE_UPDATED_AT"],
    });
  }
  return record;
}

function updateResponseRecord(
  response: unknown,
  objectId: string,
  objectName: "Quote" | "Purchase Order",
  idField: "quoteID" | "purchaseOrderID",
): Record<string, unknown> {
  if (!response || typeof response !== "object") {
    throw writeUnknown(`Xero returned no ${objectName} update response; recovery is required.`);
  }
  const body = (response as { body?: unknown }).body;
  const values = body && typeof body === "object"
    ? (body as Record<string, unknown>)[objectName === "Quote" ? "quotes" : "purchaseOrders"]
    : undefined;
  if (body && typeof body === "object" && providerHasErrors(body)) {
    throw providerRejected(`Xero rejected the ${objectName.toLowerCase()} draft update.`, {
      validationErrorCount: providerValidationErrors(body).length,
    });
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw writeUnknown(`Xero returned no ${objectName} update response; recovery is required.`);
  }
  const first = values[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw writeUnknown(`Xero returned a malformed ${objectName} update response; recovery is required.`);
  }
  const record = first as Record<string, unknown>;
  if (providerHasErrors(record)) {
    throw providerRejected(`Xero rejected the ${objectName.toLowerCase()} draft update.`, {
      validationErrorCount: providerValidationErrors(record).length,
    });
  }
  if (!sameUuid(record[idField], objectId)) {
    throw writeUnknown(`Xero returned a different ${objectName} ID after update; recovery is required.`);
  }
  if (record.status !== undefined && record.status !== "DRAFT") {
    throw writeUnknown(`Xero returned a non-DRAFT ${objectName} after update; recovery is required.`);
  }
  return record;
}

/**
 * Provider transport for newly controlled mutations. It deliberately keeps
 * create and read-back as separate operations so the service can persist an
 * uncertain result before attempting recovery.
 */
export class XeroControlledMutationProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async createQuoteDraft(
    principal: AccountingPrincipal,
    payload: CanonicalQuoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroControlledCreateReceipt> {
    const xeroPayload = toXeroQuoteCreatePayload(payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroControlledMutationProvider.createQuoteDraft",
      actionId: "quote.create_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      try {
        const created = await client.accountingApi.createQuotes(
          connection.tenantId,
          xeroPayload,
          true,
          idempotencyKey,
        );
        const quote = created.body?.quotes?.[0];
        if (providerHasErrors(quote)) {
          throw providerRejected("Xero rejected the quote draft.", {
            validationErrorCount: providerValidationErrors(quote).length,
          });
        }
        if (!quote?.quoteID) throw writeUnknown("Xero returned no QuoteID; recovery is required.");
        return {
          objectId: quote.quoteID,
          receipt: {
            operation: "CREATE_QUOTE_DRAFT",
            quoteId: quote.quoteID,
            ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero quote-draft result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the quote draft.");
      }
    });
  }

  async readAndVerifyQuoteDraft(
    principal: AccountingPrincipal,
    quoteId: string,
    expected: CanonicalQuoteDraftPayload,
  ): Promise<DraftReadbackVerificationResult<QuoteDraftReadbackSnapshot, CanonicalQuoteDraftPayload>> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getQuote(connection.tenantId, quoteId);
      const raw = response.body?.quotes?.find((quote) => sameUuid(quote.quoteID, quoteId));
      if (!raw) throw new AppError("NOT_FOUND", "The created Xero quote could not be read back.", { httpStatus: 404 });
      return verifyQuoteDraftReadback(quoteId, expected, raw);
    });
  }

  async createPurchaseOrderDraft(
    principal: AccountingPrincipal,
    payload: CanonicalPurchaseOrderDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroControlledCreateReceipt> {
    const xeroPayload = toXeroPurchaseOrderCreatePayload(payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroControlledMutationProvider.createPurchaseOrderDraft",
      actionId: "purchase_order.create_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      try {
        const created = await client.accountingApi.createPurchaseOrders(
          connection.tenantId,
          xeroPayload,
          true,
          idempotencyKey,
        );
        const purchaseOrder = created.body?.purchaseOrders?.[0];
        if (providerHasErrors(purchaseOrder)) {
          throw providerRejected("Xero rejected the purchase-order draft.", {
            validationErrorCount: providerValidationErrors(purchaseOrder).length,
          });
        }
        if (!purchaseOrder?.purchaseOrderID) {
          throw writeUnknown("Xero returned no PurchaseOrderID; recovery is required.");
        }
        return {
          objectId: purchaseOrder.purchaseOrderID,
          receipt: {
            operation: "CREATE_PURCHASE_ORDER_DRAFT",
            purchaseOrderId: purchaseOrder.purchaseOrderID,
            ...(providerRequestId(created.response) ? { providerRequestId: providerRequestId(created.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero purchase-order draft result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the purchase-order draft.");
      }
    });
  }

  async updateQuoteDraft(
    principal: AccountingPrincipal,
    targetQuoteId: string,
    expectedUpdatedAt: string,
    payload: CanonicalQuoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroControlledCreateReceipt> {
    const exactTargetId = targetUuid(targetQuoteId, "Quote");
    const expectedUpdatedAtValue = expectedUpdatedAtInstant(expectedUpdatedAt);
    const xeroPayload = toXeroQuoteUpdatePayload(exactTargetId, payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroControlledMutationProvider.updateQuoteDraft",
      actionId: "quote.update_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: { targetXeroObjectId: exactTargetId, expectedUpdatedAt, replacement: payload },
    }, async (client, connection) => {
      try {
        let preflight;
        try {
          preflight = await client.accountingApi.getQuote(connection.tenantId, exactTargetId);
        } catch (error) {
          if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
            throw providerPreconditionRejected("Xero rejected the exact Quote draft precondition.");
          }
          throw providerPreconditionUnavailable(
            "The exact Xero Quote draft could not be read before update; retry without recovery.",
            error,
          );
        }
        requireExactDraft(preflight, exactTargetId, expectedUpdatedAtValue, "Quote", "quoteID");
        const updated = await client.accountingApi.updateQuote(
          connection.tenantId,
          exactTargetId,
          xeroPayload,
          idempotencyKey,
        );
        const record = updateResponseRecord(updated, exactTargetId, "Quote", "quoteID");
        return {
          objectId: exactUuid(record.quoteID) as string,
          receipt: {
            operation: "UPDATE_QUOTE_DRAFT",
            quoteId: exactUuid(record.quoteID) as string,
            ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero quote-draft update result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the quote-draft update.");
      }
    });
  }

  async updatePurchaseOrderDraft(
    principal: AccountingPrincipal,
    targetPurchaseOrderId: string,
    expectedUpdatedAt: string,
    payload: CanonicalPurchaseOrderDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroControlledCreateReceipt> {
    const exactTargetId = targetUuid(targetPurchaseOrderId, "Purchase Order");
    const expectedUpdatedAtValue = expectedUpdatedAtInstant(expectedUpdatedAt);
    const xeroPayload = toXeroPurchaseOrderUpdatePayload(exactTargetId, payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroControlledMutationProvider.updatePurchaseOrderDraft",
      actionId: "purchase_order.update_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: { targetXeroObjectId: exactTargetId, expectedUpdatedAt, replacement: payload },
    }, async (client, connection) => {
      try {
        let preflight;
        try {
          preflight = await client.accountingApi.getPurchaseOrder(connection.tenantId, exactTargetId);
        } catch (error) {
          if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
            throw providerPreconditionRejected("Xero rejected the exact Purchase Order draft precondition.");
          }
          throw providerPreconditionUnavailable(
            "The exact Xero Purchase Order draft could not be read before update; retry without recovery.",
            error,
          );
        }
        requireExactDraft(preflight, exactTargetId, expectedUpdatedAtValue, "Purchase Order", "purchaseOrderID");
        const updated = await client.accountingApi.updatePurchaseOrder(
          connection.tenantId,
          exactTargetId,
          xeroPayload,
          idempotencyKey,
        );
        const record = updateResponseRecord(updated, exactTargetId, "Purchase Order", "purchaseOrderID");
        return {
          objectId: exactUuid(record.purchaseOrderID) as string,
          receipt: {
            operation: "UPDATE_PURCHASE_ORDER_DRAFT",
            purchaseOrderId: exactUuid(record.purchaseOrderID) as string,
            ...(providerRequestId(updated.response) ? { providerRequestId: providerRequestId(updated.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero purchase-order update result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the purchase-order update.");
      }
    });
  }

  async readAndVerifyPurchaseOrderDraft(
    principal: AccountingPrincipal,
    purchaseOrderId: string,
    expected: CanonicalPurchaseOrderDraftPayload,
  ): Promise<DraftReadbackVerificationResult<PurchaseOrderDraftReadbackSnapshot, CanonicalPurchaseOrderDraftPayload>> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getPurchaseOrder(connection.tenantId, purchaseOrderId);
      const raw = response.body?.purchaseOrders?.find(
        (purchaseOrder) => sameUuid(purchaseOrder.purchaseOrderID, purchaseOrderId),
      );
      if (!raw) {
        throw new AppError("NOT_FOUND", "The created Xero purchase order could not be read back.", { httpStatus: 404 });
      }
      return verifyPurchaseOrderDraftReadback(purchaseOrderId, expected, raw);
    });
  }

  async getItemByCode(principal: AccountingPrincipal, code: string): Promise<ItemSummary | undefined> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getItem(connection.tenantId, code, 4);
      const exact = response.body?.items?.find((item) => item.code === code);
      return mapItemSummary(exact);
    });
  }

  async resolveTrackingOptionIds(
    principal: AccountingPrincipal,
    requestedIds: readonly string[],
  ): Promise<TrackingOptionResolution> {
    const unique = [...new Set(requestedIds.map((id) => id.toLowerCase()))];
    if (unique.length === 0) return { requestedIds: [], matchedIds: [], complete: true };
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getTrackingCategories(connection.tenantId, undefined, undefined, false);
      const available = new Set<string>();
      for (const category of response.body?.trackingCategories ?? []) {
        for (const option of category.options ?? []) {
          if (option.trackingOptionID) available.add(option.trackingOptionID.toLowerCase());
        }
      }
      const matchedIds = unique.filter((id) => available.has(id));
      return { requestedIds: unique, matchedIds, complete: matchedIds.length === unique.length };
    });
  }
}
