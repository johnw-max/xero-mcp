import { describe, expect, it, vi } from "vitest";
import { buildPurchaseOrderDraftPrimitive, buildQuoteDraftPrimitive } from "../src/domain/xeroQuotePurchaseOrderDraft.js";
import type { AccountingPrincipal } from "../src/providers/types.js";
import {
  XeroControlledMutationProvider,
  type XeroControlledCreateReceipt,
} from "../src/providers/xeroControlledMutationProvider.js";
import type {
  XeroClientManager,
  XeroProviderWriteAuthorization,
} from "../src/providers/xeroClientManager.js";
import {
  toXeroPurchaseOrderUpdatePayload,
  toXeroQuoteUpdatePayload,
} from "../src/providers/xeroQuotePurchaseOrderDraft.js";

const tenantId = "tenant-quote-po-update-test";
const quoteId = "33333333-3333-4333-8333-333333333333";
const purchaseOrderId = "44444444-4444-4444-8444-444444444444";
const contactId = "11111111-1111-4111-8111-111111111111";
const quoteUpdatedAt = "2026-08-07T17:00:00.000+08:00";
const purchaseOrderUpdatedAt = "2026-08-07T09:00:00.000Z";
const principal = "actor-quote-po-update-test" as AccountingPrincipal;

const quote = buildQuoteDraftPrimitive({
  source_ref: "work://quote-update",
  source_unit_key: "quote-update:1",
  source_sha256: "a".repeat(64),
  contact_id: contactId,
  quote_date: "2026-08-07",
  expiry_date: "2026-08-21",
  currency: "SGD",
  reference: "Q-UPDATE-001",
  line_amount_type: "Exclusive",
  lines: [{
    description: "Replacement advisory",
    quantity: 2,
    unit_amount: 125.5,
    account_code: "200",
    tax_type: "OUTPUT",
    tracking_option_ids: [],
  }],
}).canonicalPayload;

const purchaseOrder = buildPurchaseOrderDraftPrimitive({
  source_ref: "work://purchase-order-update",
  source_unit_key: "purchase-order-update:1",
  source_sha256: "b".repeat(64),
  contact_id: contactId,
  purchase_order_date: "2026-08-07",
  expected_arrival_date: "2026-08-14",
  delivery_date: "2026-08-21",
  currency: "SGD",
  reference: "PO-UPDATE-001",
  line_amount_type: "Exclusive",
  lines: [{
    description: "Replacement equipment",
    quantity: 3,
    unit_amount: 80,
    account_code: "453",
    tax_type: "INPUT",
    tracking_option_ids: [],
  }],
}).canonicalPayload;

function managerFor(sdk: Record<string, ReturnType<typeof vi.fn>>, authorizationSink?: (value: XeroProviderWriteAuthorization) => void) {
  return {
    withWriteClient: vi.fn(async <T>(
      _principal: AccountingPrincipal,
      authorization: XeroProviderWriteAuthorization,
      callback: (client: unknown, connection: unknown) => Promise<T>,
    ) => {
      authorizationSink?.(authorization);
      if (!authorization.permit) throw new Error("permit required");
      return callback({ accountingApi: sdk }, { tenantId });
    }),
    withClient: vi.fn(async <T>(
      _principal: AccountingPrincipal,
      callback: (client: unknown, connection: unknown) => Promise<T>,
    ) => callback({ accountingApi: sdk }, { tenantId })),
  } as unknown as XeroClientManager;
}

function quotePreflight() {
  return { body: { quotes: [{ quoteID: quoteId, status: "DRAFT", updatedDateUTC: "2026-08-07T09:00:00.000Z" }] } };
}

function purchaseOrderPreflight() {
  return {
    body: { purchaseOrders: [{ purchaseOrderID: purchaseOrderId, status: "DRAFT", updatedDateUTC: purchaseOrderUpdatedAt }] },
  };
}

describe("bounded Quote/Purchase Order draft update provider", () => {
  it("builds complete replacement bodies with the exact target and server-owned DRAFT status", () => {
    expect(toXeroQuoteUpdatePayload(quoteId, quote)).toEqual({
      quotes: [{
        quoteID: quoteId,
        status: "DRAFT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        expiryDate: "2026-08-21",
        currencyCode: "SGD",
        reference: "Q-UPDATE-001",
        lineAmountTypes: "EXCLUSIVE",
        lineItems: [{
          description: "Replacement advisory",
          quantity: 2,
          unitAmount: 125.5,
          accountCode: "200",
          taxType: "OUTPUT",
        }],
      }],
    });
    expect(toXeroPurchaseOrderUpdatePayload(purchaseOrderId, purchaseOrder)).toMatchObject({
      purchaseOrders: [{
        purchaseOrderID: purchaseOrderId,
        status: "DRAFT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        expectedArrivalDate: "2026-08-14",
        deliveryDate: "2026-08-21",
        currencyCode: "SGD",
        reference: "PO-UPDATE-001",
        lineAmountTypes: "Exclusive",
        lineItems: [{ quantity: 3, unitAmount: 80, accountCode: "453", taxType: "INPUT" }],
      }],
    });
    expect(JSON.stringify(toXeroQuoteUpdatePayload(quoteId, quote))).not.toContain("updateOrCreate");
    expect(() => toXeroQuoteUpdatePayload("not-a-uuid", quote)).toThrow();
  });

  it("does exact GET then single-ID Quote update, forwards the permit, and preserves idempotency", async () => {
    const getQuote = vi.fn().mockResolvedValue(quotePreflight());
    const updateQuote = vi.fn().mockResolvedValue({
      body: { quotes: [{ quoteID: quoteId, status: "DRAFT" }] },
      response: { headers: { "xero-correlation-id": "quote-update-request" } },
    });
    const authorizations: XeroProviderWriteAuthorization[] = [];
    const provider = new XeroControlledMutationProvider(managerFor({ getQuote, updateQuote }, (value) => {
      authorizations.push(value);
    }));
    const permit = {} as NonNullable<XeroProviderWriteAuthorization["permit"]>;

    await expect(provider.updateQuoteDraft(principal, quoteId, quoteUpdatedAt, quote, "xmr_quote_update", permit))
      .resolves.toMatchObject<XeroControlledCreateReceipt>({
        objectId: quoteId,
        receipt: { operation: "UPDATE_QUOTE_DRAFT", quoteId },
      });
    expect(getQuote).toHaveBeenCalledWith(tenantId, quoteId);
    expect(updateQuote).toHaveBeenCalledWith(
      tenantId,
      quoteId,
      expect.objectContaining({ quotes: [expect.objectContaining({ quoteID: quoteId, status: "DRAFT" })] }),
      "xmr_quote_update",
    );
    expect(updateQuote.mock.calls[0]?.[2]).toEqual(toXeroQuoteUpdatePayload(quoteId, quote));
    expect(getQuote.mock.invocationCallOrder[0]).toBeLessThan(updateQuote.mock.invocationCallOrder[0]);
    expect(authorizations[0]).toMatchObject({
      adapterOperation: "XeroControlledMutationProvider.updateQuoteDraft",
      actionId: "quote.update_draft",
      mutationRequestId: "xmr_quote_update",
      providerIdempotencyKey: "xmr_quote_update",
      canonicalPayload: { targetXeroObjectId: quoteId, expectedUpdatedAt: quoteUpdatedAt, replacement: quote },
      permit,
    });
  });

  it("does exact GET then single-ID Purchase Order update with a complete replacement", async () => {
    const getPurchaseOrder = vi.fn().mockResolvedValue(purchaseOrderPreflight());
    const updatePurchaseOrder = vi.fn().mockResolvedValue({
      body: { purchaseOrders: [{ purchaseOrderID: purchaseOrderId, status: "DRAFT" }] },
      response: { headers: { "x-request-id": "po-update-request" } },
    });
    const provider = new XeroControlledMutationProvider(managerFor({ getPurchaseOrder, updatePurchaseOrder }));
    await expect(provider.updatePurchaseOrderDraft(
      principal,
      purchaseOrderId,
      purchaseOrderUpdatedAt,
      purchaseOrder,
      "xmr_purchase_order_update",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).resolves.toMatchObject({
      objectId: purchaseOrderId,
      receipt: { operation: "UPDATE_PURCHASE_ORDER_DRAFT", purchaseOrderId },
    });
    expect(getPurchaseOrder).toHaveBeenCalledWith(tenantId, purchaseOrderId);
    expect(updatePurchaseOrder).toHaveBeenCalledWith(
      tenantId,
      purchaseOrderId,
      toXeroPurchaseOrderUpdatePayload(purchaseOrderId, purchaseOrder),
      "xmr_purchase_order_update",
    );
  });

  it("rejects a non-DRAFT target without calling update, and distinguishes transport uncertainty", async () => {
    const nonDraftGet = vi.fn().mockResolvedValue({ body: { quotes: [{ quoteID: quoteId, status: "SENT" }] } });
    const updateQuote = vi.fn();
    const rejectedProvider = new XeroControlledMutationProvider(managerFor({ getQuote: nonDraftGet, updateQuote }));
    await expect(rejectedProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_non_draft",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: expect.objectContaining({ writeOutcome: "DEFINITELY_REJECTED" }),
    });
    expect(updateQuote).not.toHaveBeenCalled();

    const missingVersionUpdate = vi.fn();
    const missingVersionProvider = new XeroControlledMutationProvider(managerFor({
      getQuote: vi.fn().mockResolvedValue({ body: { quotes: [{ quoteID: quoteId, status: "DRAFT" }] } }),
      updateQuote: missingVersionUpdate,
    }));
    await expect(missingVersionProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_missing_version",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      httpStatus: 409,
      details: expect.objectContaining({
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
        reasonCodes: ["UPDATED_AT_UNAVAILABLE"],
      }),
    });
    expect(missingVersionUpdate).not.toHaveBeenCalled();

    const staleVersionUpdate = vi.fn();
    const staleVersionProvider = new XeroControlledMutationProvider(managerFor({
      getQuote: vi.fn().mockResolvedValue({
        body: { quotes: [{ quoteID: quoteId, status: "DRAFT", updatedDateUTC: "2026-08-07T09:00:01.000Z" }] },
      }),
      updateQuote: staleVersionUpdate,
    }));
    await expect(staleVersionProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_stale_version",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      httpStatus: 409,
      details: expect.objectContaining({
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
        reasonCodes: ["STALE_UPDATED_AT"],
      }),
    });
    expect(staleVersionUpdate).not.toHaveBeenCalled();

    const timeout = Object.assign(new Error("read timeout"), { code: "ETIMEDOUT" });
    const uncertainGet = vi.fn().mockRejectedValue(timeout);
    const uncertainUpdate = vi.fn();
    const uncertainProvider = new XeroControlledMutationProvider(managerFor({ getQuote: uncertainGet, updateQuote: uncertainUpdate }));
    await expect(uncertainProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_preflight_unknown",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
      details: expect.objectContaining({
        providerMutationPossible: false,
        reasonCodes: ["EXACT_DRAFT_PRECONDITION_UNAVAILABLE"],
      }),
    });
    expect(uncertainUpdate).not.toHaveBeenCalled();
  });

  it("turns provider validation rejection into PROVIDER_ERROR but transport/update projection failures into UNKNOWN", async () => {
    const validation = Object.assign(new Error("invalid quote"), {
      response: { statusCode: 400, body: { validationErrors: [{ message: "invalid" }] } },
    });
    const updateRejected = vi.fn().mockRejectedValue(validation);
    const rejectedProvider = new XeroControlledMutationProvider(managerFor({
      getQuote: vi.fn().mockResolvedValue(quotePreflight()),
      updateQuote: updateRejected,
    }));
    await expect(rejectedProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_rejected",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: expect.objectContaining({ writeOutcome: "DEFINITELY_REJECTED" }),
    });

    const timeout = Object.assign(new Error("update timeout"), { code: "ETIMEDOUT" });
    const updateUnknown = vi.fn().mockRejectedValue(timeout);
    const unknownProvider = new XeroControlledMutationProvider(managerFor({
      getQuote: vi.fn().mockResolvedValue(quotePreflight()),
      updateQuote: updateUnknown,
    }));
    await expect(unknownProvider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_update_unknown",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
  });

  it("requires the permit at the provider boundary and verifies the full canonical readback", async () => {
    const getQuote = vi.fn().mockResolvedValue({
      body: {
        quotes: [{
          quoteID: quoteId,
          status: "DRAFT",
          contact: { contactID: contactId },
          date: "2026-08-07",
          expiryDate: "2026-08-21",
          currencyCode: "SGD",
          reference: "Q-UPDATE-001",
          lineAmountTypes: "EXCLUSIVE",
          lineItems: [{
            description: "Replacement advisory",
            quantity: 2,
            unitAmount: 125.5,
            lineAmount: 251,
            accountCode: "200",
            taxType: "OUTPUT",
          }],
          subTotal: 251,
          totalTax: 0,
          total: 251,
        }],
      },
    });
    const updateQuote = vi.fn();
    const provider = new XeroControlledMutationProvider(managerFor({ getQuote, updateQuote }));
    await expect(provider.updateQuoteDraft(
      principal,
      quoteId,
      "2026-08-07",
      quote,
      "xmr_quote_invalid_version",
      {} as NonNullable<XeroProviderWriteAuthorization["permit"]>,
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 422 });
    expect(getQuote).not.toHaveBeenCalled();

    await expect(provider.updateQuoteDraft(
      principal,
      quoteId,
      quoteUpdatedAt,
      quote,
      "xmr_quote_no_permit",
    )).rejects.toThrow("permit required");
    expect(getQuote).not.toHaveBeenCalled();
    expect(updateQuote).not.toHaveBeenCalled();

    await expect(provider.readAndVerifyQuoteDraft(principal, quoteId, quote)).resolves.toMatchObject({
      ok: true,
      snapshot: {
        objectType: "QUOTE",
        quoteId,
        providerTotalsVerified: true,
        providerTotalsEvidence: { subTotal: "251.0000", totalTax: "0.0000", total: "251.0000" },
      },
      readbackCanonicalPayload: quote,
    });
  });
});
