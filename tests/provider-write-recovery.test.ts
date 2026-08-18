import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { AppError } from "../src/errors.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const invoiceId = "11111111-1111-4111-8111-111111111111";
const connection = {
  connectionId: "conn-a",
  actorId: "actor-a",
  provider: "xero" as const,
  tenantId: "tenant-a",
  tenantName: "Tenant A",
  grantedScopes: ["accounting.invoices"],
  tokenCiphertext: "test-only",
  tokenExpiresAt: new Date("2026-08-03T13:00:00Z"),
  refreshVersion: 0,
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-03T12:00:00Z"),
  updatedAt: new Date("2026-08-03T12:00:00Z"),
};

const input = {
  request_id: "request-create-a",
  source_ref: "synthetic://invoice-a",
  source_sha256: "1".repeat(64),
  source_evidence_type: "AGENT_ASSERTED_UNVERIFIED" as const,
  user_confirmation: "CONFIRMED_FOR_DRAFT" as const,
  contact_id: "22222222-2222-4222-8222-222222222222",
  invoice_date: "2026-08-03",
  due_date: "2026-08-17",
  currency: "SGD",
  reference: "ZC-XERO-DEMO-QA",
  authoritative_provider_field: "INVOICE_NUMBER" as const,
  line_amount_type: "Inclusive" as const,
  lines: [
    {
      description: "Synthetic software subscription",
      quantity: 1,
      unit_amount: 109,
      account_code: "404",
      tax_type: "NONE",
    },
  ],
};
const { user_confirmation: _confirmation, ...canonicalInput } = input;
const principal = providerWriteTestContext(connection.connectionId);
const noOpWriteEvidence = async () => undefined;

function providerWithClient(client: unknown, onWriteClient?: () => void): XeroAccountingProvider {
  const manager = {
    withClient: async <T>(
      _actorId: string,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
    withWriteClient: async <T>(
      _principal: unknown,
      _authorization: unknown,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => {
      onWriteClient?.();
      return action(client, connection);
    },
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

function invoicePermit(side: "AP" | "AR") {
  return issueProviderWriteTestPermit({
    adapterOperation: side === "AP"
      ? "XeroAccountingProvider.createDraftSupplierBill"
      : "XeroAccountingProvider.createDraftSalesInvoice",
    mutationRequestId: `xmr-provider-test-${side}`,
    canonicalPayload: canonicalInput,
    tenantId: connection.tenantId,
    connectionId: connection.connectionId,
  });
}

function mutationRequestId(side: "AP" | "AR"): string {
  return `xmr-provider-test-${side}`;
}

describe("provider write recovery contract", () => {
  it.each(["AP", "AR"] as const)("rejects %s writes without a durable evidence recorder before entering the write boundary", async (side) => {
    const createInvoices = vi.fn();
    const getInvoices = vi.fn();
    const withWriteClient = vi.fn();
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } }, withWriteClient);

    const operation = side === "AP"
      ? provider.createDraftSupplierBill(
        principal,
        input,
        `idempotency-missing-evidence-${side}`,
        undefined,
        invoicePermit(side),
        mutationRequestId(side),
      )
      : provider.createDraftSalesInvoice(
        principal,
        input,
        `idempotency-missing-evidence-${side}`,
        undefined,
        invoicePermit(side),
        mutationRequestId(side),
      );

    await expect(operation).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      retryable: false,
      details: {
        providerMutationPossible: false,
        reasonCodes: ["WRITE_EVIDENCE_CALLBACK_REQUIRED"],
      },
    });
    expect(withWriteClient).not.toHaveBeenCalled();
    expect(createInvoices).not.toHaveBeenCalled();
    expect(getInvoices).not.toHaveBeenCalled();
  });

  it.each([
    ["AP", { response: { status: 408, body: {} } }],
    ["AP", { response: { status: 409, body: {} } }],
    ["AP", { response: { status: 425, body: {} } }],
    ["AP", { response: { status: 429, body: {} } }],
    ["AP", { response: { status: 400 } }],
    ["AP", { response: { status: 422, body: { message: "invalid" } } }],
    ["AP", {}],
    ["AR", { response: { status: 408, body: {} } }],
    ["AR", { response: { status: 409, body: {} } }],
    ["AR", { response: { status: 425, body: {} } }],
    ["AR", { response: { status: 429, body: {} } }],
    ["AR", { response: { status: 400 } }],
    ["AR", { response: { status: 422, body: { message: "invalid" } } }],
    ["AR", {}],
  ] as const)("keeps an ambiguous %s create exception as unknown and never attempts readback", async (side, error) => {
    const createInvoices = vi.fn().mockRejectedValue(error);
    const getInvoices = vi.fn();
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    const operation = side === "AP"
      ? provider.createDraftSupplierBill(principal, input, `idempotency-ambiguous-${side}`, noOpWriteEvidence, invoicePermit(side), mutationRequestId(side))
      : provider.createDraftSalesInvoice(principal, input, `idempotency-ambiguous-${side}`, noOpWriteEvidence, invoicePermit(side), mutationRequestId(side));
    await expect(operation).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN", retryable: false });
    expect(getInvoices).not.toHaveBeenCalled();
  });

  it.each(["AP", "AR"] as const)("releases only a structured Xero %s validation rejection", async (side) => {
    const createInvoices = vi.fn().mockRejectedValue({
      response: {
        status: 422,
        body: { Elements: [{ ValidationErrors: [{ Message: "Account code is invalid" }] }] },
      },
    });
    const provider = providerWithClient({ accountingApi: { createInvoices } });
    const operation = side === "AP"
      ? provider.createDraftSupplierBill(principal, input, `idempotency-rejected-${side}`, noOpWriteEvidence, invoicePermit(side), mutationRequestId(side))
      : provider.createDraftSalesInvoice(principal, input, `idempotency-rejected-${side}`, noOpWriteEvidence, invoicePermit(side), mutationRequestId(side));
    await expect(operation).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { writeOutcome: "DEFINITELY_REJECTED" },
    });
  });

  it("treats an AP create response without an invoice as unknown, not as a safe provider rejection", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: undefined,
      response: { headers: { "xero-correlation-id": "correlation-create-empty-ap" } },
    });
    const getInvoices = vi.fn();
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    await expect(
      provider.createDraftSupplierBill(principal, input, "idempotency-create-empty-ap", noOpWriteEvidence, invoicePermit("AP"), mutationRequestId("AP")),
    ).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
    });
    expect(createInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).not.toHaveBeenCalled();
  });

  it("classifies explicit AP validation errors as a known provider rejection", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [{
          hasErrors: true,
          validationErrors: [{ message: "Account code is invalid" }],
        }],
      },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { createInvoices } });

    await expect(
      provider.createDraftSupplierBill(principal, input, "idempotency-create-invalid-ap", noOpWriteEvidence, invoicePermit("AP"), mutationRequestId("AP")),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("treats an AR create response without an InvoiceID as unknown, not as a safe provider rejection", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ hasErrors: false }] },
      response: { headers: { "xero-correlation-id": "correlation-create-missing-id-ar" } },
    });
    const getInvoices = vi.fn();
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    await expect(
      provider.createDraftSalesInvoice(principal, input, "idempotency-create-missing-id-ar", noOpWriteEvidence, invoicePermit("AR"), mutationRequestId("AR")),
    ).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
    });
    expect(createInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).not.toHaveBeenCalled();
  });

  it("classifies explicit AR validation errors as a known provider rejection", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: {
        invoices: [{
          validationErrors: [{ message: "Revenue account is invalid" }],
        }],
      },
      response: { headers: {} },
    });
    const provider = providerWithClient({ accountingApi: { createInvoices } });

    await expect(
      provider.createDraftSalesInvoice(principal, input, "idempotency-create-invalid-ar", noOpWriteEvidence, invoicePermit("AR"), mutationRequestId("AR")),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("preserves the exact InvoiceID when create commits but readback times out", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, hasErrors: false }] },
      response: { headers: { "xero-correlation-id": "correlation-create-a" } },
    });
    const getInvoices = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    let caught: unknown;
    try {
      await provider.createDraftSupplierBill(principal, input, "idempotency-create-a", noOpWriteEvidence, invoicePermit("AP"), mutationRequestId("AP"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { invoiceId },
    });
    expect(createInvoices).toHaveBeenCalledTimes(1);
    const supplierCreate = createInvoices.mock.calls[0]?.[1] as {
      invoices?: Array<Record<string, unknown>>;
    };
    expect(supplierCreate.invoices?.[0]).toMatchObject({ invoiceNumber: input.reference });
    expect(supplierCreate.invoices?.[0]).not.toHaveProperty("reference");
    expect(getInvoices).toHaveBeenCalledTimes(1);
  });

  it.each(["AP", "AR"] as const)("persists the %s InvoiceID and receipt before starting exact readback", async (side) => {
    const order: string[] = [];
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, hasErrors: false }] },
      response: { headers: { "xero-correlation-id": `correlation-evidence-${side}` } },
    });
    const getInvoices = vi.fn(async () => {
      order.push("GET_STARTED");
      throw { code: "ETIMEDOUT" };
    });
    const recordWriteEvidence = vi.fn(async (evidence) => {
      order.push("EVIDENCE_PERSISTED");
      expect(evidence).toMatchObject({ invoiceId, receipt: { invoiceId } });
    });
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    const operation = side === "AP"
      ? provider.createDraftSupplierBill(principal, input, `idempotency-evidence-${side}`, recordWriteEvidence, invoicePermit(side), mutationRequestId(side))
      : provider.createDraftSalesInvoice(principal, input, `idempotency-evidence-${side}`, recordWriteEvidence, invoicePermit(side), mutationRequestId(side));
    await expect(operation).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: { invoiceId },
    });
    expect(order).toEqual(["EVIDENCE_PERSISTED", "GET_STARTED"]);
  });

  it("preserves the exact AR InvoiceID when create commits but readback times out", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, hasErrors: false }] },
      response: { headers: { "xero-correlation-id": "correlation-create-ar" } },
    });
    const getInvoices = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    await expect(
      provider.createDraftSalesInvoice(principal, input, "idempotency-create-ar", noOpWriteEvidence, invoicePermit("AR"), mutationRequestId("AR")),
    ).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { invoiceId },
    });
    expect(createInvoices).toHaveBeenCalledTimes(1);
    expect(getInvoices).toHaveBeenCalledTimes(1);
  });

  it("treats a missing immediate post-create readback as unknown, not safe failure", async () => {
    const createInvoices = vi.fn().mockResolvedValue({
      body: { invoices: [{ invoiceID: invoiceId, hasErrors: false }] },
      response: { headers: {} },
    });
    const getInvoices = vi.fn().mockResolvedValue({ body: { invoices: [] }, response: { headers: {} } });
    const provider = providerWithClient({ accountingApi: { createInvoices, getInvoices } });

    await expect(
      provider.createDraftSupplierBill(principal, input, "idempotency-create-a", noOpWriteEvidence, invoicePermit("AP"), mutationRequestId("AP")),
    ).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { invoiceId },
    });
    expect(createInvoices).toHaveBeenCalledTimes(1);
  });

  it("does not expose the legacy supplier-bill AUTHORISE writer from the production provider", () => {
    const updateInvoice = vi.fn();
    const provider = providerWithClient({ accountingApi: { updateInvoice } });
    expect((provider as unknown as { authoriseSupplierBill?: unknown }).authoriseSupplierBill).toBeUndefined();
    expect(updateInvoice).not.toHaveBeenCalled();
  });
});
