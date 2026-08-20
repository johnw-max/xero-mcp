import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { AppError } from "../src/errors.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import {
  XeroAccountingProvider,
  type InvoiceDraftUpdateCanonicalPayload,
} from "../src/providers/xeroProvider.js";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const expectedUpdatedAt = "2026-08-19T10:00:00.000Z";
const connection = { tenantId, tenantName: "Provider test tenant", connectionId: "connection-draft-update" };

type WriteAuthorization = {
  permit?: unknown;
  adapterOperation?: string;
  actionId?: string;
  mutationRequestId?: string;
  providerIdempotencyKey?: string;
  canonicalPayload?: unknown;
};

function xeroInvoice(
  type: "ACCPAY" | "ACCREC",
  status: "DRAFT" | "AUTHORISED" = "DRAFT",
  overrides: Record<string, unknown> = {},
) {
  return {
    invoiceID: invoiceId,
    type,
    status,
    contact: { contactID: contactId, name: "Bound counterparty" },
    invoiceNumber: "DRAFT-UPDATE-001",
    date: "2026-08-19",
    dueDate: "2026-09-02",
    currencyCode: "HKD",
    currencyRate: 1,
    reference: "DRAFT-UPDATE-001",
    lineAmountTypes: "Exclusive",
    subTotal: 1200,
    totalTax: 0,
    total: 1200,
    amountDue: 1200,
    amountPaid: 0,
    amountCredited: 0,
    updatedDateUTCString: expectedUpdatedAt,
    lineItems: [{
      lineItemID: "33333333-3333-4333-8333-333333333333",
      description: "Updated accounting service",
      quantity: 1,
      unitAmount: 1200,
      lineAmount: 1200,
      taxAmount: 0,
      accountCode: "200",
      taxType: "NONE",
    }],
    ...overrides,
  };
}

function payload(type?: "ACCPAY" | "ACCREC"): InvoiceDraftUpdateCanonicalPayload {
  return {
    schemaVersion: "accounting-case-native-document:v11",
    type,
    xeroContactId: contactId,
    documentDate: "2026-08-19",
    dueDate: "2026-09-02",
    currency: "HKD",
    currencyRate: 1,
    reference: "DRAFT-UPDATE-001",
    authoritativeProviderField: "INVOICE_NUMBER",
    lineAmountType: "EXCLUSIVE",
    lines: [{
      description: "Updated accounting service",
      quantity: "1.0000",
      unitAmount: "1200.0000",
      accountCode: "200",
      taxType: "NONE",
    }],
    net: "1200.0000",
    tax: "0.0000",
    gross: "1200.0000",
    status: "DRAFT",
  };
}

function providerWithClient(
  accountingApi: Record<string, unknown>,
  options: {
    requirePermit?: boolean;
    onAuthorization?: (authorization: WriteAuthorization) => void;
  } = {},
) {
  const manager = {
    withWriteClient: async <T>(
      _principal: unknown,
      authorization: WriteAuthorization,
      action: (client: unknown, resolvedConnection: typeof connection) => Promise<T>,
    ): Promise<T> => {
      options.onAuthorization?.(authorization);
      if (options.requirePermit && !authorization.permit) {
        throw new AppError("FORBIDDEN", "provider permit required", { httpStatus: 403 });
      }
      return action({ accountingApi }, connection);
    },
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

function readSequence(type: "ACCPAY" | "ACCREC", ...readbacks: unknown[]) {
  const getInvoices = vi.fn();
  getInvoices.mockResolvedValueOnce({ body: { invoices: [xeroInvoice(type)] } });
  for (const readback of readbacks) {
    getInvoices.mockResolvedValueOnce({ body: { invoices: [readback] } });
  }
  return getInvoices;
}

describe("XeroAccountingProvider invoice/bill DRAFT replacement", () => {
  it("does a permit-bound full ACCPAY replacement with exact preflight and readback", async () => {
    const getInvoices = readSequence("ACCPAY", xeroInvoice("ACCPAY"));
    const updateInvoice = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, type: "ACCPAY", status: "DRAFT" }] },
      response: { headers: { "xero-correlation-id": "corr-bill-update" } },
    });
    const recordWriteEvidence = vi.fn(async () => undefined);
    const authorization: WriteAuthorization[] = [];
    const provider = providerWithClient({ getInvoices, updateInvoice }, {
      requirePermit: true,
      onAuthorization: (value) => authorization.push(value),
    });
    const input = payload("ACCPAY");
    const permit = { oneShot: true };

    const result = await provider.updateDraftSupplierBill(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      input,
      "idempotency-key",
      recordWriteEvidence,
      permit as never,
      "mutation-request-id",
    );

    expect(updateInvoice).toHaveBeenCalledWith(
      tenantId,
      invoiceId,
      {
        invoices: [{
          invoiceID: invoiceId,
          type: "ACCPAY",
          status: "DRAFT",
          contact: { contactID: contactId },
          date: "2026-08-19",
          dueDate: "2026-09-02",
          currencyCode: "HKD",
          currencyRate: 1,
          invoiceNumber: "DRAFT-UPDATE-001",
          lineAmountTypes: "Exclusive",
          lineItems: [{
            description: "Updated accounting service",
            quantity: 1,
            unitAmount: 1200,
            accountCode: "200",
            taxType: "NONE",
          }],
        }],
      },
      4,
      "mutation-request-id",
    );
    expect(getInvoices).toHaveBeenCalledTimes(2);
    expect(getInvoices.mock.calls[0]).toEqual([
      tenantId, undefined, undefined, undefined, [invoiceId], undefined, undefined, undefined,
      1, false, undefined, 4, false, 1,
    ]);
    expect(recordWriteEvidence).toHaveBeenCalledWith({
      invoiceId,
      receipt: {
        operation: "UPDATE_ACCPAY_DRAFT",
        invoiceId,
        providerRequestId: "corr-bill-update",
      },
    });
    expect(authorization[0]).toMatchObject({
      adapterOperation: "XeroAccountingProvider.updateDraftSupplierBill",
      actionId: "supplier_bill.update_draft",
      mutationRequestId: "mutation-request-id",
      providerIdempotencyKey: "mutation-request-id",
      canonicalPayload: {
        targetXeroObjectId: invoiceId,
        expectedUpdatedAt,
        replacement: input,
      },
      permit,
    });
    expect(result).toMatchObject({
      bill: { invoiceId, type: "ACCPAY", status: "DRAFT", total: "1200.0000" },
      receipt: {
        operation: "UPDATE_ACCPAY_DRAFT",
        invoiceId,
        status: "DRAFT",
        providerRequestId: "corr-bill-update",
      },
    });
  });

  it("pins the ACCREC route and uses the same idempotency key for the SDK update", async () => {
    const getInvoices = readSequence("ACCREC", xeroInvoice("ACCREC"));
    const updateInvoice = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, type: "ACCREC", status: "DRAFT" }] },
      response: { headers: {} },
    });
    const provider = providerWithClient({ getInvoices, updateInvoice });
    const input = payload("ACCREC");

    const result = await provider.updateDraftSalesInvoice(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      input,
      "idempotency-key",
      vi.fn(async () => undefined),
      { oneShot: true } as never,
      "same-mutation-key",
    );

    expect(updateInvoice).toHaveBeenCalledWith(
      tenantId,
      invoiceId,
      expect.objectContaining({
        invoices: [expect.objectContaining({
          invoiceID: invoiceId,
          type: "ACCREC",
          status: "DRAFT",
        })],
      }),
      4,
      "same-mutation-key",
    );
    expect(result).toMatchObject({ invoice: { invoiceId, type: "ACCREC", status: "DRAFT" } });
  });

  it("rejects incomplete or wrong-route canonical input before obtaining a write client", async () => {
    const withWriteClient = vi.fn();
    const manager = { withWriteClient } as unknown as XeroClientManager;
    const provider = new XeroAccountingProvider({} as AccountingRepository, manager);

    await expect(provider.updateDraftSalesInvoice(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      { ...payload("ACCREC"), lines: [] },
      "idempotency-key",
      vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(provider.updateDraftSalesInvoice(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      payload("ACCPAY"),
      "idempotency-key",
      vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(withWriteClient).not.toHaveBeenCalled();
  });

  it("allows a zero unit amount but rejects a non-positive currency rate", async () => {
    const zeroAmountInput = {
      ...payload("ACCPAY"),
      currencyRate: 1,
      lines: [{ ...payload("ACCPAY").lines![0], unitAmount: "0.0000" }],
      net: "0.0000",
      tax: "0.0000",
      gross: "0.0000",
    };
    const getInvoices = readSequence("ACCPAY", xeroInvoice("ACCPAY", "DRAFT", {
      subTotal: 0,
      totalTax: 0,
      total: 0,
      lineItems: [{
        description: "Updated accounting service",
        quantity: 1,
        unitAmount: 0,
        lineAmount: 0,
        taxAmount: 0,
        accountCode: "200",
        taxType: "NONE",
      }],
    }));
    const updateInvoice = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, type: "ACCPAY", status: "DRAFT" }] },
    });
    const provider = providerWithClient({ getInvoices, updateInvoice });
    await expect(provider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, zeroAmountInput, "key", vi.fn(async () => undefined),
    )).resolves.toMatchObject({ bill: { total: "0.0000" } });
    expect(updateInvoice).toHaveBeenCalledWith(
      tenantId,
      invoiceId,
      expect.objectContaining({
        invoices: [expect.objectContaining({
          lineItems: [expect.objectContaining({ unitAmount: 0 })],
        })],
      }),
      4,
      "key",
    );

    const invalidRateUpdate = vi.fn();
    const invalidRateProvider = providerWithClient({
      getInvoices: vi.fn(),
      updateInvoice: invalidRateUpdate,
    });
    await expect(invalidRateProvider.updateDraftSupplierBill(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      { ...payload("ACCPAY"), currencyRate: "0.0000" },
      "key",
      vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(invalidRateUpdate).not.toHaveBeenCalled();
  });

  it("does not call updateInvoice when the exact target is absent or no longer DRAFT", async () => {
    const missingGet = vi.fn().mockResolvedValue({ body: { invoices: [xeroInvoice("ACCPAY", "DRAFT", {
      invoiceID: "44444444-4444-4444-8444-444444444444",
    })] } });
    const missingUpdate = vi.fn();
    const missingProvider = providerWithClient({ getInvoices: missingGet, updateInvoice: missingUpdate });
    await expect(missingProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: {
        reasonCodes: ["EXACT_TARGET_NOT_FOUND"],
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
      },
    });
    expect(missingUpdate).not.toHaveBeenCalled();

    const authorisedGet = vi.fn().mockResolvedValue({
      body: { invoices: [xeroInvoice("ACCPAY", "AUTHORISED")] },
    });
    const authorisedUpdate = vi.fn();
    const authorisedProvider = providerWithClient({
      getInvoices: authorisedGet,
      updateInvoice: authorisedUpdate,
    });
    await expect(authorisedProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "CONFLICT" });
    expect(authorisedUpdate).not.toHaveBeenCalled();
  });

  it("requires an expectedUpdatedAt version and rejects a stale exact preflight", async () => {
    const missingVersionUpdate = vi.fn();
    const missingVersionProvider = providerWithClient({
      getInvoices: vi.fn(),
      updateInvoice: missingVersionUpdate,
    });
    await expect(missingVersionProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, "", payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 422,
      details: {
        providerMutationPossible: false,
        path: "expectedUpdatedAt",
      },
    });
    expect(missingVersionUpdate).not.toHaveBeenCalled();

    const staleGet = vi.fn().mockResolvedValue({
      body: { invoices: [xeroInvoice("ACCPAY", "DRAFT", {
        updatedDateUTCString: "2026-08-19T10:00:01.000Z",
      })] },
    });
    const staleUpdate = vi.fn();
    const staleProvider = providerWithClient({ getInvoices: staleGet, updateInvoice: staleUpdate });
    await expect(staleProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      httpStatus: 409,
      details: {
        reasonCodes: ["STALE_UPDATED_AT"],
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
        expectedUpdatedAt,
        actualUpdatedAt: "2026-08-19T10:00:01.000Z",
      },
    });
    expect(staleUpdate).not.toHaveBeenCalled();

    const unavailableGet = vi.fn().mockResolvedValue({
      body: { invoices: [xeroInvoice("ACCPAY", "DRAFT", { updatedDateUTCString: undefined })] },
    });
    const unavailableUpdate = vi.fn();
    const unavailableProvider = providerWithClient({ getInvoices: unavailableGet, updateInvoice: unavailableUpdate });
    await expect(unavailableProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      httpStatus: 409,
      details: {
        reasonCodes: ["UPDATED_AT_UNAVAILABLE"],
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
      },
    });
    expect(unavailableUpdate).not.toHaveBeenCalled();
  });

  it("classifies provider validation as definite rejection and transport as unknown", async () => {
    const preflightUpdate = vi.fn();
    const preflightProvider = providerWithClient({
      getInvoices: vi.fn().mockRejectedValue({ code: "ETIMEDOUT" }),
      updateInvoice: preflightUpdate,
    });
    await expect(preflightProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
      details: { providerMutationPossible: false },
    });
    expect(preflightUpdate).not.toHaveBeenCalled();

    const preflightValidationUpdate = vi.fn();
    const preflightValidationProvider = providerWithClient({
      getInvoices: vi.fn().mockRejectedValue({
        response: { statusCode: 400, body: { validationErrors: [{ message: "invalid target" }] } },
      }),
      updateInvoice: preflightValidationUpdate,
    });
    await expect(preflightValidationProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
      details: {
        reasonCodes: ["EXACT_TARGET_PREFLIGHT_REJECTED"],
        writeOutcome: "DEFINITELY_REJECTED",
        providerMutationPossible: false,
      },
    });
    expect(preflightValidationUpdate).not.toHaveBeenCalled();

    const validationGet = readSequence("ACCPAY");
    const validationUpdate = vi.fn().mockRejectedValue({
      response: { statusCode: 400, body: { validationErrors: [{ message: "invalid" }] } },
    });
    const validationProvider = providerWithClient({
      getInvoices: validationGet,
      updateInvoice: validationUpdate,
    });
    await expect(validationProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { writeOutcome: "DEFINITELY_REJECTED" },
    });

    const transportGet = readSequence("ACCPAY");
    const transportUpdate = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    const transportProvider = providerWithClient({
      getInvoices: transportGet,
      updateInvoice: transportUpdate,
    });
    await expect(transportProvider.updateDraftSupplierBill(
      "actor-a", invoiceId, expectedUpdatedAt, payload("ACCPAY"), "key", vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
  });

  it("classifies a mismatched exact readback as WRITE_RESULT_UNKNOWN", async () => {
    const getInvoices = readSequence("ACCPAY", xeroInvoice("ACCPAY", "DRAFT", {
      invoiceNumber: "different-after-write",
    }));
    const updateInvoice = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, type: "ACCPAY", status: "DRAFT" }] },
    });
    const provider = providerWithClient({ getInvoices, updateInvoice });

    await expect(provider.updateDraftSupplierBill(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      payload("ACCPAY"),
      "key",
      vi.fn(async () => undefined),
      { oneShot: true } as never,
    )).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: {
        reasonCodes: ["READBACK_MISMATCH"],
        mismatchFields: expect.arrayContaining(["invoiceNumber"]),
      },
    });
  });

  it("requires the provider permit at the write-client boundary", async () => {
    const getInvoices = readSequence("ACCPAY");
    const updateInvoice = vi.fn();
    const provider = providerWithClient({ getInvoices, updateInvoice }, { requirePermit: true });

    await expect(provider.updateDraftSupplierBill(
      "actor-a",
      invoiceId,
      expectedUpdatedAt,
      payload("ACCPAY"),
      "key",
      vi.fn(async () => undefined),
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateInvoice).not.toHaveBeenCalled();
  });
});
