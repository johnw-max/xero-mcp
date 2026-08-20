import { describe, expect, it, vi } from "vitest";
import { canonicalBillForApproval } from "../src/domain/canonical.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import type { AccountingProvider, SupplierBillSnapshot } from "../src/providers/types.js";
import { hashObject, sha256 } from "../src/security/hash.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { ReviewService } from "../src/services/reviewService.js";

const actorId = "actor-a";
const tenantId = "tenant-a";
const postingRequestId = "pr_abcdefghijklmnop";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const reviewRequestId = `review:${postingRequestId}:authorise`;

const draftBill: SupplierBillSnapshot = {
  tenantId,
  invoiceId,
  type: "ACCPAY",
  status: "DRAFT",
  contact: { contactId, name: "Synthetic supplier" },
  invoiceDate: "2026-08-03",
  dueDate: "2026-08-17",
  currency: "SGD",
  reference: "ZC-XERO-DEMO-QA",
  lineAmountType: "Inclusive",
  lines: [{
    description: "Synthetic software subscription",
    quantity: "1.0000",
    unitAmount: "109.0000",
    lineAmount: "109.0000",
    taxAmount: "0.0000",
    accountCode: "404",
    taxType: "NONE",
  }],
  subTotal: "109.0000",
  totalTax: "0.0000",
  total: "109.0000",
};
const authorisedBill: SupplierBillSnapshot = { ...draftBill, status: "AUTHORISED" };
const approvedPayloadHash = hashObject(canonicalBillForApproval(draftBill));

function requireCsrfToken(review: { csrfToken?: string }): string {
  if (!review.csrfToken) throw new Error("Expected an actionable Review state to issue CSRF");
  return review.csrfToken;
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function pendingReview() {
  const repository = new InMemoryAccountingRepository();
  await repository.createOrGetPosting({
    postingRequestId,
    actorId,
    tenantId,
    sourceRef: "synthetic://invoice-a",
    sourceSha256: "1".repeat(64),
    sourceEvidenceType: "LEGACY_UNVERIFIED",
    providerPayload: draftBill as unknown as Record<string, unknown>,
    requestPayloadHash: "2".repeat(64),
    providerPayloadHash: approvedPayloadHash,
    requestId: "request-create-a",
    createIdempotencyKey: "create-key-a",
  });
  await repository.markDraftCreated(postingRequestId, {
    xeroInvoiceId: invoiceId,
    providerPayload: draftBill as unknown as Record<string, unknown>,
    providerPayloadHash: approvedPayloadHash,
    writeReceipt: { providerRequestId: "xero-create-a" },
    readbackSnapshot: draftBill as unknown as Record<string, unknown>,
  });
  const reviewService = new ReviewService(repository);
  const operator = await reviewService.createOperatorSession(actorId);
  const authenticated = await reviewService.authenticate(operator.session);
  const review = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
  return { repository, reviewService, authenticated, csrfToken: requireCsrfToken(review) };
}

function accountingService(
  repository: InMemoryAccountingRepository,
  provider: Pick<AccountingProvider, "resolveContext" | "getSupplierBill" | "authoriseSupplierBill">,
  policy: { enabled?: boolean; allowedTenantId?: string } = {},
): AccountingService {
  return new AccountingService({
    repository,
    provider: provider as AccountingProvider,
    config: {
      publicBaseUrl: "https://xero-mcp.example.test",
      xeroWriteEnabled: policy.enabled ?? true,
      xeroAllowedTenantId: policy.allowedTenantId ?? tenantId,
    },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    unsafeAllowDirectMutationForTests: true,
  });
}

function providerWith(options: {
  getSupplierBill?: () => Promise<SupplierBillSnapshot>;
  authoriseSupplierBill?: () => Promise<{ bill: SupplierBillSnapshot; receipt: Record<string, unknown> }>;
  connectedTenantId?: string;
} = {}) {
  return {
    resolveContext: vi.fn().mockResolvedValue({
      actorId,
      tenantId: options.connectedTenantId ?? tenantId,
      tenantName: "Tenant A",
    }),
    getSupplierBill: vi.fn(options.getSupplierBill ?? (async () => draftBill)),
    authoriseSupplierBill: vi.fn(options.authoriseSupplierBill ?? (async () => ({
      bill: authorisedBill,
      receipt: { operation: "AUTHORISE", invoiceId, providerRequestId: "xero-authorise-a" },
    }))),
  };
}

async function approveThroughReview(options: {
  reviewService: ReviewService;
  authenticated: { actorId: string; sessionHash: string };
  csrfToken: string;
  accounting: AccountingService;
}) {
  return options.reviewService.approveAndAuthorise({
    postingRequestId,
    actorId: options.authenticated.actorId,
    sessionHash: options.authenticated.sessionHash,
    csrfToken: options.csrfToken,
    accountingService: options.accounting,
  });
}

describe("human Review Gate authorisation flow", () => {
  it("atomically consumes Review CSRF, persists only the approval hash, and authorises", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);

    const result = await approveThroughReview({ reviewService, authenticated, csrfToken, accounting });

    expect(result).toMatchObject({ invoiceId, status: "AUTHORISED", verified: true });
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(1);
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      authoriseRequestId: reviewRequestId,
      approvalRefHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvalConsumedAt: expect.any(Date),
      xeroInvoiceId: invoiceId,
      readbackSnapshot: { invoiceId, status: "AUTHORISED" },
    });
    await expect(repository.consumeReviewCsrf(
      sha256(csrfToken),
      authenticated.sessionHash,
      authenticated.actorId,
      postingRequestId,
      new Date(),
    )).resolves.toBe(false);
  });

  it("cannot replay the same Review CSRF", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);
    await approveThroughReview({ reviewService, authenticated, csrfToken, accounting });
    const readsBeforeReplay = provider.getSupplierBill.mock.calls.length;

    await expect(
      approveThroughReview({ reviewService, authenticated, csrfToken, accounting }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.getSupplierBill).toHaveBeenCalledTimes(readsBeforeReplay);
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["writes are disabled", false, tenantId, tenantId, "WRITE_GATE_DISABLED"],
    ["the connected tenant is not allowlisted", true, "tenant-b", tenantId, "STANDING_DELEGATION_REQUIRED"],
    ["the posting belongs to another tenant", true, "tenant-b", "tenant-b", "FORBIDDEN"],
  ] as const)(
    "does not consume CSRF or change state when %s",
    async (_label, enabled, allowedTenantId, connectedTenantId, expectedCode) => {
      const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
      const provider = providerWith({ connectedTenantId });
      const accounting = accountingService(repository, provider, { enabled, allowedTenantId });

      await expect(
        approveThroughReview({ reviewService, authenticated, csrfToken, accounting }),
      ).rejects.toMatchObject({
        code: expectedCode,
      });

      await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({ state: "APPROVAL_PENDING" });
      await expect(repository.consumeReviewCsrf(
        sha256(csrfToken),
        authenticated.sessionHash,
        authenticated.actorId,
        postingRequestId,
        new Date(),
      )).resolves.toBe(true);
      expect(provider.getSupplierBill).not.toHaveBeenCalled();
      expect(provider.authoriseSupplierBill).not.toHaveBeenCalled();
    },
  );

  it("rejects a payload binding mismatch before consuming Review CSRF", async () => {
    const { repository, authenticated, csrfToken } = await pendingReview();
    const idempotencyKey = `zc:authorise:${sha256(`${tenantId}:${reviewRequestId}:${postingRequestId}`)}`;

    await expect(repository.beginReviewAuthorise({
      postingRequestId,
      actorId,
      tenantId,
      invoiceId,
      approvalRefHash: "4".repeat(64),
      approvedPayloadHash: "9".repeat(64),
      requestId: reviewRequestId,
      idempotencyKey,
      sessionHash: authenticated.sessionHash,
      csrfHash: sha256(csrfToken),
      approvalExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({ state: "APPROVAL_PENDING" });
    await expect(repository.consumeReviewCsrf(
      sha256(csrfToken),
      authenticated.sessionHash,
      authenticated.actorId,
      postingRequestId,
      new Date(),
    )).resolves.toBe(true);
  });

  it("leaves CSRF and approval pending after pre-read failure, then succeeds with a new human click", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const getSupplierBill = vi.fn()
      .mockRejectedValueOnce(new Error("temporary pre-read failure"))
      .mockResolvedValue(draftBill);
    const provider = providerWith({ getSupplierBill });
    const accounting = accountingService(repository, provider);

    await expect(
      approveThroughReview({ reviewService, authenticated, csrfToken, accounting }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({ state: "APPROVAL_PENDING" });
    await expect(repository.consumeReviewCsrf(
      sha256(csrfToken),
      authenticated.sessionHash,
      authenticated.actorId,
      postingRequestId,
      new Date(),
    )).resolves.toBe(true);

    const retry = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
    const result = await approveThroughReview({
      reviewService,
      authenticated,
      csrfToken: requireCsrfToken(retry),
      accounting,
    });
    expect(result.verified).toBe(true);
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(1);
  });

  it("resumes an ambiguous AUTHORISING claim by fresh readback without another Provider write", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const idempotencyKey = `zc:authorise:${sha256(`${tenantId}:${reviewRequestId}:${postingRequestId}`)}`;
    await repository.beginReviewAuthorise({
      postingRequestId,
      actorId,
      tenantId,
      invoiceId,
      approvalRefHash: "4".repeat(64),
      approvedPayloadHash,
      requestId: reviewRequestId,
      idempotencyKey,
      sessionHash: authenticated.sessionHash,
      csrfHash: sha256(csrfToken),
      approvalExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const retry = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
    const provider = providerWith({ getSupplierBill: async () => authorisedBill });
    const accounting = accountingService(repository, provider);

    const result = await approveThroughReview({
      reviewService,
      authenticated,
      csrfToken: requireCsrfToken(retry),
      accounting,
    });

    expect(result).toMatchObject({ verified: true, idempotentReplay: true });
    expect(provider.getSupplierBill).toHaveBeenCalledTimes(1);
    expect(provider.authoriseSupplierBill).not.toHaveBeenCalled();
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
    });
  });

  it("returns the persisted terminal result after HTTP loss without any Provider call", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);
    await approveThroughReview({ reviewService, authenticated, csrfToken, accounting });
    const retry = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
    provider.resolveContext.mockRejectedValue(new Error("Xero connection must not be required for terminal replay"));
    provider.getSupplierBill.mockRejectedValue(new Error("Provider must not be called"));
    provider.authoriseSupplierBill.mockRejectedValue(new Error("Provider must not be called"));
    const contextsBeforeRetry = provider.resolveContext.mock.calls.length;
    const readsBeforeRetry = provider.getSupplierBill.mock.calls.length;
    const writesBeforeRetry = provider.authoriseSupplierBill.mock.calls.length;

    const result = await approveThroughReview({
      reviewService,
      authenticated,
      csrfToken: requireCsrfToken(retry),
      accounting,
    });

    expect(result).toMatchObject({ verified: true, idempotentReplay: true });
    expect(provider.resolveContext).toHaveBeenCalledTimes(contextsBeforeRetry);
    expect(provider.getSupplierBill).toHaveBeenCalledTimes(readsBeforeRetry);
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(writesBeforeRetry);
  });

  it("does not misclassify a terminal success when success-audit persistence fails", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);
    const beginAudit = vi.spyOn(repository, "beginAudit");
    const completeAudit = vi.spyOn(repository, "completeAudit")
      .mockRejectedValueOnce(new Error("audit database unavailable"));

    await expect(accounting.withAudit({
      actorId,
      toolName: "review.approve_and_authorise",
      input: { postingRequestId },
      action: () => approveThroughReview({ reviewService, authenticated, csrfToken, accounting }),
      recordId: (result) => result.invoiceId,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });

    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
    });
    expect(beginAudit).toHaveBeenCalledTimes(1);
    expect(completeAudit).toHaveBeenCalledTimes(1);
    expect(repository.audits).toEqual([
      expect.objectContaining({
        resultStatus: "IN_PROGRESS",
        toolName: "review.approve_and_authorise",
      }),
    ]);
    const originalCallId = repository.audits[0]?.callId;
    expect(originalCallId).toMatch(/^call_/);
    const readsBeforeRetry = provider.getSupplierBill.mock.calls.length;
    const writesBeforeRetry = provider.authoriseSupplierBill.mock.calls.length;

    const retry = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
    const result = await accounting.withAudit({
      actorId,
      toolName: "review.approve_and_authorise",
      input: { postingRequestId },
      action: () => approveThroughReview({
        reviewService,
        authenticated,
        csrfToken: requireCsrfToken(retry),
        accounting,
      }),
      recordId: (authorised) => authorised.invoiceId,
    });

    expect(result).toMatchObject({ verified: true, idempotentReplay: true });
    expect(provider.getSupplierBill).toHaveBeenCalledTimes(readsBeforeRetry);
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(writesBeforeRetry);
    expect(beginAudit).toHaveBeenCalledTimes(2);
    expect(completeAudit).toHaveBeenCalledTimes(2);
    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: originalCallId, resultStatus: "IN_PROGRESS" }),
      expect.objectContaining({ resultStatus: "SUCCEEDED", recordId: invoiceId }),
    ]);
  });

  it("does not run the tool when its durable audit intent cannot be recorded", async () => {
    const { repository } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);
    vi.spyOn(repository, "beginAudit").mockRejectedValueOnce(new Error("audit database unavailable"));
    const action = vi.fn(async () => ({ ok: true }));

    await expect(accounting.withAudit({
      actorId,
      toolName: "review.approve_and_authorise",
      input: { postingRequestId },
      action,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });

    expect(action).not.toHaveBeenCalled();
    expect(provider.authoriseSupplierBill).not.toHaveBeenCalled();
    expect(repository.audits).toHaveLength(0);
  });

  it("preserves the original action error when audit completion is also uncertain", async () => {
    const { repository } = await pendingReview();
    const provider = providerWith();
    const accounting = accountingService(repository, provider);
    vi.spyOn(repository, "completeAudit").mockRejectedValueOnce(new Error("audit completion response lost"));
    const action = vi.fn(async () => {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero write result is unknown.", {
        httpStatus: 503,
        retryable: false,
        details: { invoiceId },
      });
    });

    const failure = await accounting.withAudit({
      actorId,
      toolName: "review.approve_and_authorise",
      input: { postingRequestId },
      action,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      message: "The Xero write result is unknown.",
      httpStatus: 503,
      retryable: false,
      details: {
        invoiceId,
        auditCompletionStatus: "UNKNOWN",
      },
    });
    expect((failure as AppError).details?.auditCallId).toMatch(/^call_/);
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: { invoiceId },
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(repository.audits).toEqual([
      expect.objectContaining({ resultStatus: "IN_PROGRESS" }),
    ]);
  });

  it("keeps concurrent Review recovery to one Provider write", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    const secondReview = await reviewService.getReview(postingRequestId, authenticated.actorId, authenticated.sessionHash);
    let providerStatus: "DRAFT" | "AUTHORISED" = "DRAFT";
    let releaseProvider!: () => void;
    let signalProviderStarted!: () => void;
    const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    const provider = providerWith({
      getSupplierBill: async () => providerStatus === "DRAFT" ? draftBill : authorisedBill,
      authoriseSupplierBill: async () => {
        providerStatus = "AUTHORISED";
        signalProviderStarted();
        await providerReleased;
        return {
          bill: authorisedBill,
          receipt: { operation: "AUTHORISE", invoiceId, providerRequestId: "xero-authorise-a" },
        };
      },
    });
    const accounting = accountingService(repository, provider);

    const first = approveThroughReview({ reviewService, authenticated, csrfToken, accounting });
    await providerStarted;
    const second = approveThroughReview({
      reviewService,
      authenticated,
      csrfToken: requireCsrfToken(secondReview),
      accounting,
    });
    const secondResult = await second;
    releaseProvider();
    const firstResult = await first;

    expect(firstResult.verified).toBe(true);
    expect(secondResult.verified).toBe(true);
    expect(provider.authoriseSupplierBill).toHaveBeenCalledTimes(1);
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
    });
  });

  it("checks reject state before consuming CSRF and rejects atomically when pending", async () => {
    const { repository, reviewService, authenticated, csrfToken } = await pendingReview();
    await repository.approvePosting(
      postingRequestId,
      actorId,
      "4".repeat(64),
      new Date(Date.now() + 60_000),
      new Date(),
    );
    await expect(reviewService.reject({
      postingRequestId,
      actorId,
      sessionHash: authenticated.sessionHash,
      csrfToken,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.consumeReviewCsrf(
      sha256(csrfToken),
      authenticated.sessionHash,
      authenticated.actorId,
      postingRequestId,
      new Date(),
    )).resolves.toBe(true);

    const pending = await pendingReview();
    await expect(pending.reviewService.reject({
      postingRequestId,
      actorId,
      sessionHash: pending.authenticated.sessionHash,
      csrfToken: pending.csrfToken,
    })).resolves.toEqual({ postingRequestId, state: "REJECTED" });
    await expect(pending.repository.getPosting(postingRequestId)).resolves.toMatchObject({ state: "REJECTED" });
  });
});
