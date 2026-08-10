import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import type {
  CanonicalPurchaseOrderDraftPayload,
  CanonicalQuoteDraftPayload,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import {
  toXeroPurchaseOrderCreatePayload,
  toXeroQuoteCreatePayload,
  verifyPurchaseOrderDraftReadback,
  verifyQuoteDraftReadback,
  type DraftReadbackVerificationResult,
  type PurchaseOrderDraftReadbackSnapshot,
  type QuoteDraftReadbackSnapshot,
} from "./xeroQuotePurchaseOrderDraft.js";
import { mapItemSummary, type ItemSummary } from "./xeroExtendedReadMapper.js";
import { AppError } from "../errors.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";

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
  ): Promise<XeroControlledCreateReceipt> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const created = await client.accountingApi.createQuotes(
          connection.tenantId,
          toXeroQuoteCreatePayload(payload),
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
      const raw = response.body?.quotes?.find((quote) => quote.quoteID === quoteId);
      if (!raw) throw new AppError("NOT_FOUND", "The created Xero quote could not be read back.", { httpStatus: 404 });
      return verifyQuoteDraftReadback(quoteId, expected, raw);
    });
  }

  async createPurchaseOrderDraft(
    principal: AccountingPrincipal,
    payload: CanonicalPurchaseOrderDraftPayload,
    idempotencyKey: string,
  ): Promise<XeroControlledCreateReceipt> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const created = await client.accountingApi.createPurchaseOrders(
          connection.tenantId,
          toXeroPurchaseOrderCreatePayload(payload),
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

  async readAndVerifyPurchaseOrderDraft(
    principal: AccountingPrincipal,
    purchaseOrderId: string,
    expected: CanonicalPurchaseOrderDraftPayload,
  ): Promise<DraftReadbackVerificationResult<PurchaseOrderDraftReadbackSnapshot, CanonicalPurchaseOrderDraftPayload>> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getPurchaseOrder(connection.tenantId, purchaseOrderId);
      const raw = response.body?.purchaseOrders?.find(
        (purchaseOrder) => purchaseOrder.purchaseOrderID === purchaseOrderId,
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
