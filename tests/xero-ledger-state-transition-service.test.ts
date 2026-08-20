import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { XeroLedgerStateTransitionService } from "../src/services/xeroLedgerStateTransitionService.js";
import type { AccountingProvider } from "../src/providers/types.js";
import type { XeroControlledLedgerTransitionProvider } from "../src/providers/xeroControlledLedgerTransitionProvider.js";
import type { XeroMutationService } from "../src/services/xeroMutationService.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";

const invoiceId = "44444444-4444-4444-8444-444444444444";
const canonicalPayload = { invoiceId, invoiceType: "ACCREC", expectedStatus: "DRAFT" };
const preparation = {
  preparationId: "xmp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  actorId: "workspace:user:user",
  workspaceId: "workspace",
  tenantId: "11111111-1111-4111-8111-111111111111",
  installationId: "installation",
  bindingId: "binding",
  bindingRevision: 1,
  connectionId: "connection",
  targetSessionId: "target-session",
  objectType: "SALES_INVOICE" as const,
  operation: "AUTHORISE" as const,
  targetXeroObjectId: invoiceId,
  canonicalPayload,
  canonicalPayloadHash: hashObject(canonicalPayload),
  sourceRef: "case:transition",
  sourceUnitKey: "op-transition",
  sourceSha256: "a".repeat(64),
  sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" as const,
  confirmationSummaryHash: "b".repeat(64),
  confirmationPhraseHash: "c".repeat(64),
  state: "PREPARED" as const,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-20T00:00:00.000Z"),
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
};

function fixture(statuses: string[] = ["DRAFT", "DRAFT", "AUTHORISED"]) {
  const getInvoice = vi.fn(async () => ({
    invoiceId,
    tenantId: preparation.tenantId,
    type: "ACCREC" as const,
    status: statuses.shift() ?? "AUTHORISED",
    contact: { contactId: "22222222-2222-4222-8222-222222222222" },
    lines: [],
  }));
  const provider = { getInvoice } as unknown as AccountingProvider;
  const authoriseSalesInvoice = vi.fn(async () => ({
    objectId: invoiceId,
    status: "AUTHORISED" as const,
    receipt: { operation: "AUTHORISE_SALES_INVOICE", invoiceId },
  }));
  const writer = { authoriseSalesInvoice } as unknown as XeroControlledLedgerTransitionProvider;
  const mutationRequest = {
    ...preparation,
    mutationRequestId: "xmr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    requestId: "request-transition-1",
    state: "WRITE_IN_FLIGHT" as const,
    authorizationReceipt: {},
    confirmedAt: new Date("2026-08-20T00:00:00.000Z"),
  };
  const mutations = {
    prepare: vi.fn(async () => preparation),
    resumeAutonomousRecovery: vi.fn(async () => undefined),
    loadAutonomousPreparation: vi.fn(async () => preparation),
    authoriseAutonomous: vi.fn(async (...args: unknown[]) => {
      await (args[4] as () => Promise<void>)();
      return {
        request: mutationRequest,
        mode: "CALL_PROVIDER" as const,
        providerWritePermit: {} as never,
      };
    }),
    recordWriteEvidence: vi.fn(async () => ({
      ...mutationRequest,
      xeroObjectId: invoiceId,
      writeReceipt: { operation: "AUTHORISE_SALES_INVOICE", invoiceId },
    })),
    markReadbackVerified: vi.fn(async () => ({
      ...mutationRequest,
      state: "READBACK_VERIFIED" as const,
      xeroObjectId: invoiceId,
      writeReceipt: { operation: "AUTHORISE_SALES_INVOICE", invoiceId },
      readbackStatus: "AUTHORISED",
      readbackSnapshot: { xeroObjectId: invoiceId, status: "AUTHORISED", canonicalPayload },
    })),
    recover: vi.fn(),
    markUnknown: vi.fn(),
    rejectProvider: vi.fn(),
  } as unknown as XeroMutationService;
  const service = new XeroLedgerStateTransitionService(provider, writer, mutations);
  return { service, getInvoice, authoriseSalesInvoice, mutations, mutationRequest };
}

describe("XeroLedgerStateTransitionService", () => {
  it("claims and executes one exact customer-invoice authorisation with same-ID final readback", async () => {
    const { service, getInvoice, authoriseSalesInvoice, mutations } = fixture();
    const result = await service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-transition-1",
      actionId: "customer_invoice.authorise",
    });
    expect(getInvoice).toHaveBeenCalledTimes(3);
    expect(authoriseSalesInvoice).toHaveBeenCalledOnce();
    expect(authoriseSalesInvoice).toHaveBeenCalledWith(
      expect.anything(),
      canonicalPayload,
      "xmr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expect.anything(),
    );
    expect(mutations.recordWriteEvidence).toHaveBeenCalledOnce();
    expect(mutations.markReadbackVerified).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      verifiedReadback: expect.objectContaining({
        xeroObjectId: invoiceId,
        status: "AUTHORISED",
        canonicalPayload,
      }),
    }));
    expect(result).toMatchObject({ xero_object_id: invoiceId, status: "AUTHORISED" });
  });

  it("fails closed before preparation when the exact target is not DRAFT", async () => {
    const { service, authoriseSalesInvoice, mutations } = fixture(["AUTHORISED"]);
    await expect(service.prepare({} as RequestContext, {
      actionId: "customer_invoice.authorise",
      targetXeroObjectId: invoiceId,
      sourceRef: "case:transition",
      sourceUnitKey: "op-transition",
      sourceSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "STALE_PREFLIGHT" });
    expect(mutations.prepare).not.toHaveBeenCalled();
    expect(authoriseSalesInvoice).not.toHaveBeenCalled();
  });

  it("marks a mismatched provider object as unknown and never verifies readback", async () => {
    const { service, authoriseSalesInvoice, mutations } = fixture(["DRAFT", "DRAFT"]);
    authoriseSalesInvoice.mockResolvedValueOnce({
      objectId: "55555555-5555-4555-8555-555555555555",
      status: "AUTHORISED",
      receipt: { operation: "AUTHORISE_SALES_INVOICE" },
    });
    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-transition-1",
      actionId: "customer_invoice.authorise",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" } satisfies Partial<AppError>);
    expect(mutations.markUnknown).toHaveBeenCalledOnce();
    expect(mutations.markReadbackVerified).not.toHaveBeenCalled();
  });

  it("recovers an unknown write only from a durable provider receipt and same-ID final readback", async () => {
    const { service, getInvoice, authoriseSalesInvoice, mutations, mutationRequest } = fixture(["AUTHORISED"]);
    const recoveredRequest = {
      ...mutationRequest,
      state: "READBACK_VERIFIED" as const,
      xeroObjectId: invoiceId,
      writeReceipt: { operation: "AUTHORISE_SALES_INVOICE", invoiceId },
      readbackStatus: "AUTHORISED",
      readbackSnapshot: { xeroObjectId: invoiceId, status: "AUTHORISED", canonicalPayload },
    };
    vi.mocked(mutations.resumeAutonomousRecovery).mockResolvedValueOnce({
      preparation,
      claim: {
        request: { ...mutationRequest, writeReceipt: recoveredRequest.writeReceipt },
        mode: "RECOVER_ONLY" as const,
      },
    });
    vi.mocked(mutations.recover).mockResolvedValueOnce({
      outcome: "READBACK_VERIFIED" as const,
      request: recoveredRequest,
    });

    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-transition-1",
      actionId: "customer_invoice.authorise",
    })).resolves.toMatchObject({ xero_object_id: invoiceId, status: "AUTHORISED" });
    expect(getInvoice).toHaveBeenCalledOnce();
    expect(authoriseSalesInvoice).not.toHaveBeenCalled();
    expect(mutations.recover).toHaveBeenCalledOnce();
  });

  it("never accepts a native replay claim for an existing-target transition", async () => {
    const { service, authoriseSalesInvoice, mutations, mutationRequest } = fixture();
    vi.mocked(mutations.resumeAutonomousRecovery).mockResolvedValueOnce({
      preparation,
      claim: {
        request: { ...mutationRequest, state: "WRITE_UNCERTAIN" as const },
        mode: "CALL_PROVIDER" as const,
        providerWritePermit: {} as never,
      },
    });

    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-transition-1",
      actionId: "customer_invoice.authorise",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(authoriseSalesInvoice).not.toHaveBeenCalled();
    expect(mutations.markUnknown).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      xeroObjectId: invoiceId,
    }));
  });

  it("replays already-verified evidence without another provider read or write", async () => {
    const { service, getInvoice, authoriseSalesInvoice, mutations, mutationRequest } = fixture();
    const verifiedRequest = {
      ...mutationRequest,
      state: "READBACK_VERIFIED" as const,
      xeroObjectId: invoiceId,
      writeReceipt: { operation: "AUTHORISE_SALES_INVOICE", invoiceId },
      readbackStatus: "AUTHORISED",
      readbackSnapshot: { xeroObjectId: invoiceId, status: "AUTHORISED", canonicalPayload },
    };
    vi.mocked(mutations.resumeAutonomousRecovery).mockResolvedValueOnce({
      preparation,
      claim: { request: verifiedRequest, mode: "ALREADY_VERIFIED" as const },
    });

    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-transition-1",
      actionId: "customer_invoice.authorise",
    })).resolves.toMatchObject({ xero_object_id: invoiceId, status: "AUTHORISED" });
    expect(getInvoice).not.toHaveBeenCalled();
    expect(authoriseSalesInvoice).not.toHaveBeenCalled();
    expect(mutations.recover).not.toHaveBeenCalled();
  });
});
