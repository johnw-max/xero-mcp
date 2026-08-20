import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { XeroLedgerAdjustmentService } from "../src/services/xeroLedgerAdjustmentService.js";
import type { AccountingProvider } from "../src/providers/types.js";
import type { XeroLedgerAdjustmentProvider } from "../src/providers/xeroLedgerAdjustmentProvider.js";
import type { XeroMutationService } from "../src/services/xeroMutationService.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";

const creditNoteId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const allocationId = "44444444-4444-4444-8444-444444444444";
const payload = {
  creditNoteId,
  creditNoteType: "ACCRECCREDIT" as const,
  targetInvoiceId: invoiceId,
  targetInvoiceType: "ACCREC" as const,
  amount: "10.0000",
  allocationDate: "2026-08-20",
  expectedCreditStatus: "AUTHORISED" as const,
  expectedTargetStatus: "AUTHORISED" as const,
};
const receipt = {
  operation: "ALLOCATE_CREDIT_NOTE",
  creditNoteId,
  targetInvoiceId: invoiceId,
  allocationId,
};
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
  objectType: "CREDIT_NOTE" as const,
  operation: "ALLOCATE" as const,
  targetXeroObjectId: creditNoteId,
  canonicalPayload: payload,
  canonicalPayloadHash: hashObject(payload),
  sourceRef: "case:adjustment",
  sourceUnitKey: "adjustment-1",
  sourceSha256: "a".repeat(64),
  sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" as const,
  confirmationSummaryHash: "b".repeat(64),
  confirmationPhraseHash: "c".repeat(64),
  state: "PREPARED" as const,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-20T00:00:00.000Z"),
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
};

function fixture() {
  const getCreditNote = vi.fn(async () => ({
    creditNoteId,
    tenantId: preparation.tenantId,
    type: "ACCRECCREDIT" as const,
    status: "AUTHORISED",
    contact: { contactId: "55555555-5555-4555-8555-555555555555" },
    currency: "USD",
    remainingCredit: "100.0000",
    appliedAmount: "0.0000",
    associatedInvoiceIds: [],
    associatedInvoiceIdCount: 0,
    associatedInvoiceIdsTruncated: false,
    attachmentsKnown: true,
    lines: [],
  }));
  const getInvoice = vi.fn(async () => ({
    invoiceId,
    tenantId: preparation.tenantId,
    type: "ACCREC" as const,
    status: "AUTHORISED",
    contact: { contactId: "55555555-5555-4555-8555-555555555555" },
    currency: "USD",
    amountDue: "100.0000",
    lines: [],
  }));
  const reader = { getCreditNote, getInvoice } as unknown as AccountingProvider;
  const allocateCreditNote = vi.fn(async () => ({ objectId: creditNoteId, status: "AUTHORISED" as const, receipt }));
  const readAndVerifyAdjustment = vi.fn();
  const writer = { allocateCreditNote, readAndVerifyAdjustment } as unknown as XeroLedgerAdjustmentProvider;
  const mutationRequest = {
    ...preparation,
    mutationRequestId: "xmr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    requestId: "request-adjustment-1",
    state: "WRITE_IN_FLIGHT" as const,
    authorizationReceipt: {},
    confirmedAt: new Date("2026-08-20T00:00:00.000Z"),
  };
  const mutations = {
    resumeAutonomousRecovery: vi.fn(async () => undefined),
    loadAutonomousPreparation: vi.fn(async () => preparation),
    authoriseAutonomous: vi.fn(async (...args: unknown[]) => {
      await (args[4] as () => Promise<void>)();
      return { request: mutationRequest, mode: "CALL_PROVIDER" as const, providerWritePermit: {} as never };
    }),
    recordWriteEvidence: vi.fn(async () => ({ ...mutationRequest, xeroObjectId: creditNoteId, writeReceipt: receipt })),
    markUnknown: vi.fn(async () => ({ ...mutationRequest, state: "WRITE_UNCERTAIN" as const, xeroObjectId: creditNoteId, writeReceipt: receipt })),
    recover: vi.fn(),
    markReadbackVerified: vi.fn(),
    rejectProvider: vi.fn(),
  } as unknown as XeroMutationService;
  return {
    service: new XeroLedgerAdjustmentService(reader, writer, mutations),
    allocateCreditNote,
    readAndVerifyAdjustment,
    mutations,
    mutationRequest,
  };
}

describe("XeroLedgerAdjustmentService", () => {
  it("durably records the allocation receipt before an unreadable GET, then recovery is GET-only and never replays the write", async () => {
    const { service, allocateCreditNote, readAndVerifyAdjustment, mutations, mutationRequest } = fixture();
    readAndVerifyAdjustment.mockRejectedValueOnce(new AppError("PROVIDER_UNAVAILABLE", "readback down", { httpStatus: 503 }));

    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-adjustment-1",
      actionId: "credit_note.allocate",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    expect(allocateCreditNote).toHaveBeenCalledOnce();
    expect(mutations.recordWriteEvidence).toHaveBeenCalledOnce();
    expect(readAndVerifyAdjustment).toHaveBeenCalledWith(expect.anything(), "credit_note.allocate", payload, receipt);
    expect(mutations.markUnknown).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      xeroObjectId: creditNoteId,
      writeReceipt: receipt,
    }));

    vi.mocked(mutations.resumeAutonomousRecovery).mockResolvedValueOnce({
      preparation,
      claim: { request: { ...mutationRequest, writeReceipt: receipt }, mode: "RECOVER_ONLY" as const },
    });
    readAndVerifyAdjustment.mockResolvedValueOnce({
      objectId: creditNoteId,
      status: "AUTHORISED",
      snapshot: { allocationId, creditNoteId, targetInvoiceId: invoiceId },
    });
    const verifiedRequest = {
      ...mutationRequest,
      state: "READBACK_VERIFIED" as const,
      xeroObjectId: creditNoteId,
      writeReceipt: receipt,
      readbackStatus: "AUTHORISED",
      readbackSnapshot: { xeroObjectId: creditNoteId, status: "AUTHORISED", canonicalPayload: payload },
    };
    vi.mocked(mutations.recover).mockResolvedValueOnce({ outcome: "READBACK_VERIFIED", request: verifiedRequest });

    await expect(service.execute({} as RequestContext, {
      preparation_id: preparation.preparationId,
      request_id: "request-adjustment-1",
      actionId: "credit_note.allocate",
    })).resolves.toMatchObject({ xero_object_id: creditNoteId, status: "AUTHORISED" });
    expect(allocateCreditNote).toHaveBeenCalledOnce();
    expect(mutations.recover).toHaveBeenCalledOnce();
  });

  it("rejects a native replay claim and preserves the sealed existing target", async () => {
    const { service, allocateCreditNote, mutations, mutationRequest } = fixture();
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
      request_id: "request-adjustment-1",
      actionId: "credit_note.allocate",
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(allocateCreditNote).not.toHaveBeenCalled();
    expect(mutations.markUnknown).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      xeroObjectId: creditNoteId,
    }));
  });
});
