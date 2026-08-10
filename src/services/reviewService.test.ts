import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../db/repository.js";
import { canonicalBillForApproval } from "../domain/canonical.js";
import type { PostingRequest, PostingState } from "../domain/models.js";
import type { SupplierBillSnapshot } from "../providers/types.js";
import { hashObject, sha256 } from "../security/hash.js";
import type { AccountingService } from "./accountingService.js";
import { ReviewService, type ReviewAction } from "./reviewService.js";

const actorId = "review-actor";
const tenantId = "11111111-1111-4111-8111-111111111111";
const postingRequestId = "pr_review_contract_1234";
const invoiceId = "22222222-2222-4222-8222-222222222222";
const reviewRequestId = `review:${postingRequestId}:authorise`;
const reviewIdempotencyKey = `zc:authorise:${sha256(`${tenantId}:${reviewRequestId}:${postingRequestId}`)}`;

const draftBill: SupplierBillSnapshot = {
  tenantId,
  invoiceId,
  type: "ACCPAY",
  status: "DRAFT",
  contact: { contactId: "33333333-3333-4333-8333-333333333333", name: "Synthetic supplier" },
  invoiceDate: "2026-08-03",
  dueDate: "2026-08-17",
  currency: "SGD",
  reference: "ZC-REVIEW-CONTRACT",
  lineAmountType: "NoTax",
  lines: [{
    description: "Synthetic service",
    quantity: "1.0000",
    unitAmount: "100.0000",
    lineAmount: "100.0000",
    accountCode: "404",
    taxType: "NONE",
  }],
  subTotal: "100.0000",
  totalTax: "0.0000",
  total: "100.0000",
};

function posting(state: PostingState, overrides: Partial<PostingRequest> = {}): PostingRequest {
  return {
    postingRequestId,
    actorId,
    tenantId,
    sourceRef: "synthetic://review-contract",
    sourceSha256: "1".repeat(64),
    sourceEvidenceType: "LEGACY_UNVERIFIED",
    documentType: "ACCPAY",
    providerPayload: {},
    requestPayloadHash: "2".repeat(64),
    providerPayloadHash: "3".repeat(64),
    state,
    requestId: "review-contract-create",
    createIdempotencyKey: "review-contract-create-key",
    createdAt: new Date("2026-08-03T23:00:00.000Z"),
    updatedAt: new Date("2026-08-03T23:00:00.000Z"),
    ...overrides,
  };
}

function pendingPosting(): PostingRequest {
  return posting("APPROVAL_PENDING", {
    xeroInvoiceId: invoiceId,
    readbackSnapshot: draftBill as unknown as Record<string, unknown>,
    providerPayloadHash: hashObject(canonicalBillForApproval(draftBill)),
  });
}

function approvedPosting(): PostingRequest {
  return posting("APPROVED", {
    xeroInvoiceId: invoiceId,
    readbackSnapshot: draftBill as unknown as Record<string, unknown>,
    providerPayloadHash: hashObject(canonicalBillForApproval(draftBill)),
    approvalRefHash: "4".repeat(64),
    approvedBy: actorId,
    approvedAt: new Date("2026-08-03T23:30:00.000Z"),
    approvalExpiresAt: new Date("2099-08-04T00:30:00.000Z"),
  });
}

function recoveryPosting(state: "AUTHORISING" | "WRITE_RESULT_UNKNOWN" | "AUTHORISED_READBACK_VERIFIED"): PostingRequest {
  const snapshot = state === "AUTHORISED_READBACK_VERIFIED"
    ? { ...draftBill, status: "AUTHORISED" }
    : draftBill;
  return posting(state, {
    xeroInvoiceId: invoiceId,
    readbackSnapshot: snapshot as unknown as Record<string, unknown>,
    providerPayloadHash: hashObject(canonicalBillForApproval(snapshot)),
    approvalRefHash: "4".repeat(64),
    approvedBy: actorId,
    approvedAt: new Date("2026-08-03T23:30:00.000Z"),
    approvalExpiresAt: new Date("2026-08-04T00:30:00.000Z"),
    approvalConsumedAt: new Date("2026-08-03T23:31:00.000Z"),
    authoriseRequestId: reviewRequestId,
    authoriseIdempotencyKey: reviewIdempotencyKey,
  });
}

function serviceFor(candidate: PostingRequest) {
  const saveReviewCsrf = vi.fn().mockResolvedValue(undefined);
  const repository = {
    getPosting: vi.fn().mockResolvedValue(candidate),
    getConnectionByActorTenant: vi.fn().mockResolvedValue({
      tenantName: "Synthetic Demo Organisation",
      tenantShortCode: "!Demo1",
    }),
    saveReviewCsrf,
  } as unknown as AccountingRepository;
  return { service: new ReviewService(repository), saveReviewCsrf };
}

describe("Review action contract", () => {
  it.each([
    ["approval pending", pendingPosting(), "APPROVE_OR_REJECT"],
    ["approved resume", approvedPosting(), "RESUME_AUTHORISE"],
    ["authorising recovery", recoveryPosting("AUTHORISING"), "RECOVER_AUTHORISE"],
    ["unknown authorise recovery", recoveryPosting("WRITE_RESULT_UNKNOWN"), "RECOVER_AUTHORISE"],
    ["verified terminal replay", recoveryPosting("AUTHORISED_READBACK_VERIFIED"), "VIEW_VERIFIED_RESULT"],
  ] as Array<[string, PostingRequest, ReviewAction]>) (
    "issues one CSRF only for a fully bound %s state",
    async (_label, candidate, expectedAction) => {
      const { service, saveReviewCsrf } = serviceFor(candidate);

      const review = await service.getReview(postingRequestId, actorId, "session-hash");

      expect(review).toMatchObject({
        action: expectedAction,
        tenantName: "Synthetic Demo Organisation",
        xeroBillUrl: expect.stringContaining("go.xero.com/organisationlogin/default.aspx"),
        csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(saveReviewCsrf).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["validated", posting("VALIDATED")],
    ["rejected", posting("REJECTED", {
      xeroInvoiceId: invoiceId,
      readbackSnapshot: draftBill as unknown as Record<string, unknown>,
    })],
    ["blocked validation", posting("BLOCKED_VALIDATION")],
    ["readback mismatch", posting("READBACK_MISMATCH")],
    ["draft write unknown", posting("WRITE_RESULT_UNKNOWN", { xeroInvoiceId: invoiceId })],
    ["snapshot hash mismatch", posting("APPROVAL_PENDING", {
      xeroInvoiceId: invoiceId,
      readbackSnapshot: draftBill as unknown as Record<string, unknown>,
      providerPayloadHash: "9".repeat(64),
    })],
    ["empty bill lines", posting("APPROVAL_PENDING", {
      xeroInvoiceId: invoiceId,
      readbackSnapshot: { ...draftBill, lines: [] } as unknown as Record<string, unknown>,
      providerPayloadHash: hashObject(canonicalBillForApproval({ ...draftBill, lines: [] })),
    })],
    ["expired approved", posting("APPROVED", {
      ...approvedPosting(),
      approvalExpiresAt: new Date("2000-08-03T23:59:59.000Z"),
    })],
    ["incomplete authorising", posting("AUTHORISING", {
      ...recoveryPosting("AUTHORISING"),
      authoriseIdempotencyKey: "",
    })],
    ["non-Review authorising", posting("AUTHORISING", {
      ...recoveryPosting("AUTHORISING"),
      authoriseRequestId: "mcp-direct-authorise-request",
    })],
  ] as Array<[string, PostingRequest]>) (
    "keeps %s read-only and does not persist CSRF",
    async (_label, candidate) => {
      const { service, saveReviewCsrf } = serviceFor(candidate);

      const review = await service.getReview(postingRequestId, actorId, "session-hash");

      expect(review.action).toBe("NONE");
      expect(review.csrfToken).toBeUndefined();
      expect(saveReviewCsrf).not.toHaveBeenCalled();
    },
  );

  it("rechecks the complete binding before accepting an old Review POST", async () => {
    const candidate = posting("WRITE_RESULT_UNKNOWN", { xeroInvoiceId: invoiceId });
    const { service } = serviceFor(candidate);
    const authoriseReviewedSupplierBill = vi.fn();

    await expect(service.approveAndAuthorise({
      postingRequestId,
      actorId,
      sessionHash: "session-hash",
      csrfToken: "previously-issued-token",
      accountingService: { authoriseReviewedSupplierBill } as unknown as AccountingService,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(authoriseReviewedSupplierBill).not.toHaveBeenCalled();
  });
});
