import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { SourceEvidenceType } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";

const now = new Date("2026-08-03T12:00:00.000Z");
const future = new Date("2026-08-03T12:10:00.000Z");
const past = new Date("2026-08-03T11:59:59.000Z");
const invoiceId = "11111111-1111-4111-8111-111111111111";

describe("posting source evidence persistence", () => {
  it.each<SourceEvidenceType>([
    "LEGACY_UNVERIFIED",
    "AGENT_ASSERTED_UNVERIFIED",
    "SERVER_FINGERPRINTED_EXTRACTION",
  ])("round-trips %s without changing the legacy source hash", async (sourceEvidenceType) => {
    const repository = new InMemoryAccountingRepository();
    const suffix = sourceEvidenceType.toLowerCase();
    const sourceSha256 = "a".repeat(64);
    const result = await repository.createOrGetPosting({
      postingRequestId: `pr_source_evidence_${suffix}`,
      actorId: "actor-source-evidence",
      tenantId: "tenant-source-evidence",
      sourceRef: `synthetic://source-evidence/${suffix}`,
      sourceSha256,
      sourceEvidenceType,
      providerPayload: { sourceEvidenceType },
      requestPayloadHash: "b".repeat(64),
      providerPayloadHash: "c".repeat(64),
      requestId: `request-source-evidence-${suffix}`,
      createIdempotencyKey: `create-source-evidence-${suffix}`,
    });

    expect(result).toMatchObject({
      created: true,
      posting: { sourceEvidenceType, sourceSha256 },
    });
    await expect(repository.getPosting(result.posting.postingRequestId)).resolves.toMatchObject({
      sourceEvidenceType,
      sourceSha256,
    });
  });
});

describe("Xero active posting duplicate contract", () => {
  const basePosting = {
    postingRequestId: "pr_duplicate_guard_a",
    actorId: "workspace-a:user:user-a",
    tenantId: "tenant-duplicate-guard",
    sourceRef: "synthetic://duplicate-guard/invoice-a",
    sourceSha256: "d".repeat(64),
    sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" as const,
    providerPayload: {
      contactId: "22222222-2222-4222-8222-222222222222",
      reference: "Supplier-INV-001",
    },
    requestPayloadHash: "e".repeat(64),
    providerPayloadHash: "e".repeat(64),
    requestId: "request-duplicate-guard-a",
    createIdempotencyKey: "create-duplicate-guard-a",
  };

  it("keeps exact request replay idempotent and returns the active row for a new request with the same source", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.createOrGetPosting(basePosting);

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_replay",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId, requestId: basePosting.requestId },
    });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_source",
      requestId: "request-duplicate-guard-source",
      createIdempotencyKey: "create-duplicate-guard-source",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId, requestId: basePosting.requestId },
    });
  });

  it("normalizes contact and supplier reference and preserves the identity after Xero readback replaces the payload", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.createOrGetPosting(basePosting);
    await repository.markDraftCreated(first.posting.postingRequestId, {
      xeroInvoiceId: invoiceId,
      providerPayload: {
        contact: { contactId: "22222222-2222-4222-8222-222222222222" },
        reference: " Supplier-INV-001 ",
      },
      providerPayloadHash: "f".repeat(64),
      writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackSnapshot: { invoiceId, status: "DRAFT" },
    });

    await expect(repository.findActivePostingDuplicate({
      tenantId: basePosting.tenantId,
      sourceSha256: "1".repeat(64),
      contactId: "22222222-2222-4222-8222-222222222222",
      normalizedReference: "supplier-inv-001",
    })).resolves.toMatchObject({ postingRequestId: first.posting.postingRequestId, state: "APPROVAL_PENDING" });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_reference",
      sourceSha256: "1".repeat(64),
      providerPayload: {
        contactId: "22222222-2222-4222-8222-222222222222".toUpperCase(),
        reference: "  SUPPLIER-inv-001  ",
      },
      requestId: "request-duplicate-guard-reference",
      createIdempotencyKey: "create-duplicate-guard-reference",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId },
    });
  });

  it("keeps request idempotency actor-scoped while tenant-scoping business duplicate protection", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.createOrGetPosting(basePosting);

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_other_actor",
      actorId: "workspace-a:user:user-b",
      providerPayload: {
        contactId: "33333333-3333-4333-8333-333333333333",
        reference: "DIFFERENT-REFERENCE",
      },
      createIdempotencyKey: "create-duplicate-guard-other-actor",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId },
    });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_other_actor_reference",
      actorId: "workspace-a:user:user-c",
      sourceSha256: "2".repeat(64),
      requestId: "request-duplicate-guard-other-actor-reference",
      createIdempotencyKey: "create-duplicate-guard-other-actor-reference",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId },
    });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_other_actor_same_request_new_document",
      actorId: "workspace-a:user:user-b",
      sourceSha256: "1".repeat(64),
      providerPayload: {
        contactId: "33333333-3333-4333-8333-333333333333",
        reference: "Supplier-INV-002",
      },
      requestPayloadHash: "1".repeat(64),
      providerPayloadHash: "1".repeat(64),
      createIdempotencyKey: "create-duplicate-guard-other-actor-new-document",
    })).resolves.toMatchObject({ created: true });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_other_tenant",
      tenantId: "tenant-duplicate-guard-b",
      createIdempotencyKey: "create-duplicate-guard-other-tenant",
    })).resolves.toMatchObject({ created: true });
  });

  it("allows a corrected new request after the prior local request is validation-blocked", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.createOrGetPosting(basePosting);
    await repository.markPostingState(basePosting.postingRequestId, "BLOCKED_VALIDATION");

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_corrected",
      requestId: "request-duplicate-guard-corrected",
      createIdempotencyKey: "create-duplicate-guard-corrected",
    })).resolves.toMatchObject({ created: true });
  });

  it("keeps both business identities reserved after an existing Xero DRAFT is rejected", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.createOrGetPosting(basePosting);
    await repository.markDraftCreated(first.posting.postingRequestId, {
      xeroInvoiceId: invoiceId,
      providerPayload: {
        contact: { contactId: "22222222-2222-4222-8222-222222222222" },
        reference: " Supplier-INV-001 ",
      },
      providerPayloadHash: "f".repeat(64),
      writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackSnapshot: { invoiceId, status: "DRAFT" },
    });
    await repository.rejectPosting(first.posting.postingRequestId, "reviewer-a", now);

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_rejected_source",
      providerPayload: {
        contactId: "33333333-3333-4333-8333-333333333333",
        reference: "DIFFERENT-REFERENCE",
      },
      requestId: "request-duplicate-guard-rejected-source",
      createIdempotencyKey: "create-duplicate-guard-rejected-source",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId, state: "REJECTED" },
    });

    await expect(repository.createOrGetPosting({
      ...basePosting,
      postingRequestId: "pr_duplicate_guard_rejected_reference",
      sourceSha256: "1".repeat(64),
      providerPayload: {
        contactId: "22222222-2222-4222-8222-222222222222",
        reference: "supplier-inv-001",
      },
      requestId: "request-duplicate-guard-rejected-reference",
      createIdempotencyKey: "create-duplicate-guard-rejected-reference",
    })).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId, state: "REJECTED" },
    });
  });
});

describe("OAuth and review browser capabilities", () => {
  it("persists an audit intent before terminal completion and refuses double completion", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.beginAudit({
      callId: "call-durable-intent",
      actorId: "actor-a",
      tenantId: "tenant-a",
      toolName: "xero_create_draft_supplier_bill",
      requestHash: "4".repeat(64),
      resultStatus: "IN_PROGRESS",
      startedAt: now,
    });

    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: "call-durable-intent", resultStatus: "IN_PROGRESS" }),
    ]);

    await repository.completeAudit("call-durable-intent", {
      resultStatus: "SUCCEEDED",
      recordId: invoiceId,
      finishedAt: future,
    });
    expect(repository.audits).toEqual([
      expect.objectContaining({
        callId: "call-durable-intent",
        resultStatus: "SUCCEEDED",
        recordId: invoiceId,
        finishedAt: future,
      }),
    ]);
    await expect(repository.completeAudit("call-durable-intent", {
      resultStatus: "FAILED",
      errorClass: "CONFIGURATION_ERROR",
      finishedAt: future,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("binds OAuth state to a browser session, TTL, and one-time consumption", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.saveOAuthState("state-a", "browser-a", "actor-a", future);
    await expect(repository.consumeOAuthState("state-a", "browser-b", now)).resolves.toBeUndefined();
    await expect(repository.consumeOAuthState("state-a", "browser-a", now)).resolves.toEqual({ actorId: "actor-a" });
    await expect(repository.consumeOAuthState("state-a", "browser-a", now)).resolves.toBeUndefined();

    await repository.saveOAuthState("state-expired", "browser-a", "actor-a", past);
    await expect(repository.consumeOAuthState("state-expired", "browser-a", now)).resolves.toBeUndefined();
  });

  it("binds CSRF to operator session, actor, posting, TTL, and one-time consumption", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.saveOperatorSession("session-a", "actor-a", future);
    await expect(repository.getOperatorSession("session-a", now)).resolves.toEqual({ actorId: "actor-a" });
    await repository.saveReviewCsrf("csrf-a", "session-a", "actor-a", "pr_a", future);

    await expect(repository.consumeReviewCsrf("csrf-a", "session-b", "actor-a", "pr_a", now)).resolves.toBe(false);
    await expect(repository.consumeReviewCsrf("csrf-a", "session-a", "actor-b", "pr_a", now)).resolves.toBe(false);
    await expect(repository.consumeReviewCsrf("csrf-a", "session-a", "actor-a", "pr_b", now)).resolves.toBe(false);
    await expect(repository.consumeReviewCsrf("csrf-a", "session-a", "actor-a", "pr_a", now)).resolves.toBe(true);
    await expect(repository.consumeReviewCsrf("csrf-a", "session-a", "actor-a", "pr_a", now)).resolves.toBe(false);
  });

  it("revokes every review session for one actor without affecting another actor", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.saveOperatorSession("session-a1", "actor-a", future);
    await repository.saveOperatorSession("session-a2", "actor-a", future);
    await repository.saveOperatorSession("session-b1", "actor-b", future);

    await expect(repository.revokeOperatorSessions("actor-a")).resolves.toBe(2);
    await expect(repository.getOperatorSession("session-a1", now)).resolves.toBeUndefined();
    await expect(repository.getOperatorSession("session-a2", now)).resolves.toBeUndefined();
    await expect(repository.getOperatorSession("session-b1", now)).resolves.toEqual({ actorId: "actor-b" });
  });

  it("cleans expired ephemeral capabilities in bounded batches without touching valid capabilities", async () => {
    const repository = new InMemoryAccountingRepository();
    const validUntil = new Date("2026-08-03T13:00:00.000Z");
    const expiredAt = new Date("2026-08-03T10:00:00.000Z");

    for (const ticket of ["ticket-old-a", "ticket-old-b", "ticket-old-c"]) {
      await repository.saveConnectTicket(ticket, "actor-a", expiredAt);
    }
    await repository.saveConnectTicket("ticket-valid", "actor-a", validUntil);
    await repository.saveOAuthState("state-old", "browser-a", "actor-a", expiredAt);
    await repository.saveOAuthState("state-valid", "browser-a", "actor-a", validUntil);

    const first = await repository.cleanupExpiredEphemeral(now, 2);
    expect(first).toEqual({
      lockAcquired: true,
      deleted: {
        mcpRefreshRetryResponses: 0,
        oauthBrokerFlows: 0,
        oauthStates: 1,
        connectTickets: 2,
        operatorSessions: 0,
        reviewCsrfTokens: 0,
      },
    });
    await expect(repository.consumeConnectTicket("ticket-valid", now)).resolves.toEqual({ actorId: "actor-a" });
    await expect(repository.consumeOAuthState("state-valid", "browser-a", now)).resolves.toEqual({
      actorId: "actor-a",
    });

    const second = await repository.cleanupExpiredEphemeral(now, 2);
    expect(second.deleted.connectTickets).toBe(1);
    const third = await repository.cleanupExpiredEphemeral(now, 2);
    expect(third.deleted).toEqual({
      mcpRefreshRetryResponses: 0,
      oauthBrokerFlows: 0,
      oauthStates: 0,
      connectTickets: 0,
      operatorSessions: 0,
      reviewCsrfTokens: 0,
    });
  });

  it("removes CSRF bound to an expired session while preserving business and audit records", async () => {
    const repository = new InMemoryAccountingRepository();
    const validUntil = new Date("2026-08-03T13:00:00.000Z");
    const expiredAt = new Date("2026-08-03T10:00:00.000Z");
    await repository.saveOperatorSession("session-expired", "actor-a", expiredAt);
    await repository.saveReviewCsrf("csrf-parent-expired", "session-expired", "actor-a", "pr_cleanup", validUntil);
    await repository.saveOperatorSession("session-valid", "actor-a", validUntil);
    await repository.saveReviewCsrf("csrf-valid", "session-valid", "actor-a", "pr_cleanup", validUntil);

    await repository.createOrGetPosting({
      postingRequestId: "pr_cleanup",
      actorId: "actor-a",
      tenantId: "tenant-a",
      sourceRef: "synthetic://cleanup-proof",
      sourceSha256: "1".repeat(64),
      sourceEvidenceType: "LEGACY_UNVERIFIED",
      providerPayload: { amount: "1.0000" },
      requestPayloadHash: "2".repeat(64),
      providerPayloadHash: "3".repeat(64),
      requestId: "request-cleanup-proof",
      createIdempotencyKey: "create-cleanup-proof",
    });
    await repository.appendAudit({
      callId: "call-cleanup-proof",
      actorId: "actor-a",
      tenantId: "tenant-a",
      toolName: "cleanup-proof",
      requestHash: "4".repeat(64),
      resultStatus: "SUCCEEDED",
      startedAt: now,
      finishedAt: now,
    });

    const result = await repository.cleanupExpiredEphemeral(now, 10);
    expect(result.deleted).toMatchObject({ operatorSessions: 1, reviewCsrfTokens: 1 });
    await expect(repository.getOperatorSession("session-expired", now)).resolves.toBeUndefined();
    await expect(
      repository.consumeReviewCsrf("csrf-parent-expired", "session-expired", "actor-a", "pr_cleanup", now),
    ).resolves.toBe(false);
    await expect(repository.getOperatorSession("session-valid", now)).resolves.toEqual({ actorId: "actor-a" });
    await expect(
      repository.consumeReviewCsrf("csrf-valid", "session-valid", "actor-a", "pr_cleanup", now),
    ).resolves.toBe(true);
    await expect(repository.getPosting("pr_cleanup")).resolves.toMatchObject({ state: "VALIDATED" });
    expect(repository.audits).toHaveLength(1);
  });

  it("rejects unsafe cleanup arguments", async () => {
    const repository = new InMemoryAccountingRepository();
    await expect(repository.cleanupExpiredEphemeral(new Date("invalid"), 1000)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(repository.cleanupExpiredEphemeral(now, 1000, new Date("invalid"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(repository.cleanupExpiredEphemeral(now, 0)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.cleanupExpiredEphemeral(now, 10_001)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("approval and authorisation state machine", () => {
  async function draftRepository() {
    const repository = new InMemoryAccountingRepository();
    await repository.createOrGetPosting({
      postingRequestId: "pr_abcdefghijklmnop",
      actorId: "actor-a",
      tenantId: "tenant-a",
      sourceRef: "synthetic://invoice-a",
      sourceSha256: "1".repeat(64),
      sourceEvidenceType: "LEGACY_UNVERIFIED",
      providerPayload: { amount: "109.0000", tenantId: "tenant-a", invoiceId },
      requestPayloadHash: "2".repeat(64),
      providerPayloadHash: "3".repeat(64),
      requestId: "request-create-a",
      createIdempotencyKey: "create-key-a",
    });
    await repository.markDraftCreated("pr_abcdefghijklmnop", {
      xeroInvoiceId: invoiceId,
      providerPayload: { amount: "109.0000", tenantId: "tenant-a", invoiceId },
      providerPayloadHash: "3".repeat(64),
      writeReceipt: { providerRequestId: "xero-create-a" },
      readbackSnapshot: { invoiceId, status: "DRAFT" },
    });
    return repository;
  }

  async function validatedRepository(postingRequestId: string) {
    const repository = new InMemoryAccountingRepository();
    await repository.createOrGetPosting({
      postingRequestId,
      actorId: "actor-a",
      tenantId: "tenant-a",
      sourceRef: `synthetic://${postingRequestId}`,
      sourceSha256: "1".repeat(64),
      sourceEvidenceType: "LEGACY_UNVERIFIED",
      providerPayload: { amount: "109.0000", tenantId: "tenant-a" },
      requestPayloadHash: "2".repeat(64),
      providerPayloadHash: "3".repeat(64),
      requestId: `request-${postingRequestId}`,
      createIdempotencyKey: `create-${postingRequestId}`,
    });
    return repository;
  }

  function beginInput(overrides: Record<string, unknown> = {}) {
    return {
      postingRequestId: "pr_abcdefghijklmnop",
      actorId: "actor-a",
      tenantId: "tenant-a",
      invoiceId,
      approvalRefHash: "4".repeat(64),
      approvedPayloadHash: "3".repeat(64),
      requestId: "request-authorise-a",
      idempotencyKey: "authorise-key-a",
      now,
      ...overrides,
    };
  }

  it("denies authorisation before approval without consuming state", async () => {
    const repository = await draftRepository();
    await expect(repository.beginAuthorise(beginInput())).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    const posting = await repository.getPosting("pr_abcdefghijklmnop");
    expect(posting?.state).toBe("APPROVAL_PENDING");
    expect(posting?.approvalConsumedAt).toBeUndefined();
  });

  it("rejects actor, tenant, invoice, ref, payload and expiry mismatches", async () => {
    for (const overrides of [
      { actorId: "actor-b" },
      { tenantId: "tenant-b" },
      { invoiceId: "22222222-2222-4222-8222-222222222222" },
    ]) {
      const repository = await draftRepository();
      await repository.approvePosting(
        "pr_abcdefghijklmnop",
        "actor-a",
        "4".repeat(64),
        future,
        now,
      );
      await expect(repository.beginAuthorise(beginInput(overrides))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    for (const overrides of [
      { approvalRefHash: "5".repeat(64) },
      { approvedPayloadHash: "6".repeat(64) },
      { now: future },
    ]) {
      const repository = await draftRepository();
      await repository.approvePosting(
        "pr_abcdefghijklmnop",
        "actor-a",
        "4".repeat(64),
        future,
        now,
      );
      await expect(repository.beginAuthorise(beginInput(overrides))).rejects.toMatchObject({
        code: "APPROVAL_INVALID",
      });
    }
  });

  it("renews an unconsumed approval without replacing its stored approval hash", async () => {
    const repository = await draftRepository();
    const firstExpiry = new Date("2026-08-03T12:05:00.000Z");
    const renewedExpiry = new Date("2026-08-03T12:20:00.000Z");
    const first = await repository.approvePosting(
      "pr_abcdefghijklmnop",
      "actor-a",
      "4".repeat(64),
      firstExpiry,
      now,
    );
    const renewed = await repository.approvePosting(
      "pr_abcdefghijklmnop",
      "actor-a",
      "9".repeat(64),
      renewedExpiry,
      new Date("2026-08-03T12:01:00.000Z"),
    );

    expect(first.approvalRefHash).toBe("4".repeat(64));
    expect(renewed).toMatchObject({
      state: "APPROVED",
      approvedBy: "actor-a",
      approvalRefHash: "4".repeat(64),
      approvalExpiresAt: renewedExpiry,
    });
    expect(renewed.approvalConsumedAt).toBeUndefined();
  });

  it("rechecks an existing Review approval expiry before consuming CSRF", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    const csrfExpiresAt = new Date("2026-08-03T13:00:00.000Z");
    await repository.saveOperatorSession("review-session", "actor-a", csrfExpiresAt);
    await repository.saveReviewCsrf(
      "review-csrf-expiry-race",
      "review-session",
      "actor-a",
      "pr_abcdefghijklmnop",
      csrfExpiresAt,
    );

    await expect(repository.beginReviewAuthorise({
      ...beginInput({ now: future }),
      sessionHash: "review-session",
      csrfHash: "review-csrf-expiry-race",
      approvalExpiresAt: csrfExpiresAt,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    await expect(repository.consumeReviewCsrf(
      "review-csrf-expiry-race",
      "review-session",
      "actor-a",
      "pr_abcdefghijklmnop",
      now,
    )).resolves.toBe(true);
    const unchanged = await repository.getPosting("pr_abcdefghijklmnop");
    expect(unchanged?.state).toBe("APPROVED");
    expect(unchanged?.approvalConsumedAt).toBeUndefined();
  });

  it("consumes approval once and only resumes readback for the same authorise request", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);

    await expect(repository.beginAuthorise(beginInput())).resolves.toMatchObject({ mode: "CALL_PROVIDER" });
    await expect(repository.beginAuthorise(beginInput())).resolves.toMatchObject({ mode: "RESUME_READBACK_ONLY" });
    await expect(
      repository.beginAuthorise(beginInput({ requestId: "request-authorise-b" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await repository.completeAuthorise(
      "pr_abcdefghijklmnop",
      { providerRequestId: "xero-authorise-a" },
      { invoiceId, status: "AUTHORISED" },
    );
    await expect(repository.completeAuthorise(
      "pr_abcdefghijklmnop",
      { providerRequestId: "must-not-overwrite-terminal" },
      { invoiceId, status: "MUTATED" },
    )).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      writeReceipt: { providerRequestId: "xero-authorise-a" },
      readbackSnapshot: { invoiceId, status: "AUTHORISED" },
      draftWriteReceipt: { providerRequestId: "xero-create-a" },
      draftReadbackSnapshot: { invoiceId, status: "DRAFT" },
      authoriseWriteReceipt: { providerRequestId: "xero-authorise-a" },
      authoriseReadbackSnapshot: { invoiceId, status: "AUTHORISED" },
    });
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "WRITE_RESULT_UNKNOWN");
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "READBACK_MISMATCH");
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "BLOCKED_VALIDATION");
    await repository.markPostingState("pr_abcdefghijklmnop", "BLOCKED_VALIDATION");
    await expect(repository.beginAuthorise(beginInput())).resolves.toMatchObject({ mode: "ALREADY_COMPLETE" });
    await expect(repository.getPosting("pr_abcdefghijklmnop")).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      approvalConsumedAt: now,
    });
  });

  it("rejects late draft uncertainty and keeps terminal invoice and evidence unchanged", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    await repository.beginAuthorise(beginInput());
    await repository.completeAuthorise(
      "pr_abcdefghijklmnop",
      { providerRequestId: "xero-authorise-a" },
      { invoiceId, status: "AUTHORISED" },
    );

    await expect(repository.markDraftWriteUnknown(
      "pr_abcdefghijklmnop",
      "99999999-9999-4999-8999-999999999999",
    )).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(repository.getPosting("pr_abcdefghijklmnop")).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
      writeReceipt: { providerRequestId: "xero-authorise-a" },
      readbackSnapshot: { invoiceId, status: "AUTHORISED" },
      draftWriteReceipt: { providerRequestId: "xero-create-a" },
      draftReadbackSnapshot: { invoiceId, status: "DRAFT" },
      authoriseWriteReceipt: { providerRequestId: "xero-authorise-a" },
      authoriseReadbackSnapshot: { invoiceId, status: "AUTHORISED" },
    });
  });

  it("rejects draft uncertainty after the posting reaches approval pending", async () => {
    const repository = await draftRepository();

    await expect(
      repository.markDraftWriteUnknown(
        "pr_abcdefghijklmnop",
        "99999999-9999-4999-8999-999999999999",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getPosting("pr_abcdefghijklmnop")).resolves.toMatchObject({
      state: "APPROVAL_PENDING",
      xeroInvoiceId: invoiceId,
      writeReceipt: { providerRequestId: "xero-create-a" },
      readbackSnapshot: { invoiceId, status: "DRAFT" },
    });
  });

  it("keeps unknown results out of a second provider write path", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    await repository.beginAuthorise(beginInput());
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "WRITE_RESULT_UNKNOWN");
    await expect(repository.beginAuthorise(beginInput())).resolves.toMatchObject({ mode: "RESUME_READBACK_ONLY" });
  });

  it("rejects reverse-interleaved draft pollution after an unknown authorisation", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    await repository.beginAuthorise(beginInput());
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "WRITE_RESULT_UNKNOWN");
    const beforePollution = await repository.getPosting("pr_abcdefghijklmnop");

    await expect(repository.markDraftWriteUnknown(
      "pr_abcdefghijklmnop",
      "99999999-9999-4999-8999-999999999999",
    )).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.recoverDraftCreated("pr_abcdefghijklmnop", {
      xeroInvoiceId: "99999999-9999-4999-8999-999999999999",
      providerPayload: { amount: "999.0000" },
      providerPayloadHash: "9".repeat(64),
      writeReceipt: { providerRequestId: "bogus-late-draft" },
      readbackSnapshot: { invoiceId: "99999999-9999-4999-8999-999999999999", status: "DRAFT" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.completeAuthorise(
      "pr_abcdefghijklmnop",
      { providerRequestId: "bogus-authorise" },
      { invoiceId: "99999999-9999-4999-8999-999999999999", status: "AUTHORISED" },
    )).rejects.toMatchObject({ code: "READBACK_MISMATCH" });

    await expect(repository.getPosting("pr_abcdefghijklmnop")).resolves.toEqual(beforePollution);
    const completed = await repository.completeAuthorise(
      "pr_abcdefghijklmnop",
      { providerRequestId: "xero-authorise-a", invoiceId },
      { invoiceId, status: "AUTHORISED" },
    );
    expect(completed).toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
      authoriseRequestId: "request-authorise-a",
      writeReceipt: { providerRequestId: "xero-authorise-a", invoiceId },
      readbackSnapshot: { invoiceId, status: "AUTHORISED" },
      draftWriteReceipt: { providerRequestId: "xero-create-a" },
      draftReadbackSnapshot: { invoiceId, status: "DRAFT" },
      authoriseWriteReceipt: { providerRequestId: "xero-authorise-a", invoiceId },
      authoriseReadbackSnapshot: { invoiceId, status: "AUTHORISED" },
    });
  });

  it("fills a draft-unknown InvoiceID only once and never replaces it", async () => {
    const repository = new InMemoryAccountingRepository();
    await repository.createOrGetPosting({
      postingRequestId: "pr_validated_abcdefgh",
      actorId: "actor-a",
      tenantId: "tenant-a",
      sourceRef: "synthetic://invoice-validated",
      sourceSha256: "1".repeat(64),
      sourceEvidenceType: "LEGACY_UNVERIFIED",
      providerPayload: { amount: "109.0000", tenantId: "tenant-a" },
      requestPayloadHash: "2".repeat(64),
      providerPayloadHash: "3".repeat(64),
      requestId: "request-create-validated",
      createIdempotencyKey: "create-key-validated",
    });

    await repository.markDraftWriteUnknown("pr_validated_abcdefgh", invoiceId);
    await repository.markDraftWriteUnknown("pr_validated_abcdefgh", invoiceId);
    await expect(repository.markDraftWriteUnknown(
      "pr_validated_abcdefgh",
      "99999999-9999-4999-8999-999999999999",
    )).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getPosting("pr_validated_abcdefgh")).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
      xeroInvoiceId: invoiceId,
    });
  });

  it("allows only draft-phase failure transitions and rejects late state clobbering", async () => {
    const approved = await draftRepository();
    await approved.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    const approvedBefore = await approved.getPosting("pr_abcdefghijklmnop");
    await expect(
      approved.markPostingState("pr_abcdefghijklmnop", "READBACK_MISMATCH"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approved.getPosting("pr_abcdefghijklmnop")).resolves.toEqual(approvedBefore);

    const authorising = await draftRepository();
    await authorising.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    await authorising.beginAuthorise(beginInput());
    const authorisingBefore = await authorising.getPosting("pr_abcdefghijklmnop");
    await expect(
      authorising.markPostingState("pr_abcdefghijklmnop", "BLOCKED_VALIDATION"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(authorising.getPosting("pr_abcdefghijklmnop")).resolves.toEqual(authorisingBefore);

    await authorising.markAuthoriseFailure("pr_abcdefghijklmnop", "WRITE_RESULT_UNKNOWN");
    const authoriseUnknownBefore = await authorising.getPosting("pr_abcdefghijklmnop");
    await expect(
      authorising.markPostingState("pr_abcdefghijklmnop", "READBACK_MISMATCH"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(authorising.getPosting("pr_abcdefghijklmnop")).resolves.toEqual(authoriseUnknownBefore);

    const validated = await validatedRepository("pr_validated_failure");
    await expect(
      validated.markPostingState("pr_validated_failure", "BLOCKED_VALIDATION"),
    ).resolves.toBeUndefined();
    await expect(validated.getPosting("pr_validated_failure")).resolves.toMatchObject({
      state: "BLOCKED_VALIDATION",
    });

    const draftUnknown = await validatedRepository("pr_draft_unknown_failure");
    await draftUnknown.markDraftWriteUnknown("pr_draft_unknown_failure", invoiceId);
    await expect(
      draftUnknown.markPostingState("pr_draft_unknown_failure", "READBACK_MISMATCH"),
    ).resolves.toBeUndefined();
    const draftUnknownFailed = await draftUnknown.getPosting("pr_draft_unknown_failure");
    expect(draftUnknownFailed).toMatchObject({
      state: "READBACK_MISMATCH",
      xeroInvoiceId: invoiceId,
    });
    expect(draftUnknownFailed?.authoriseRequestId).toBeUndefined();

    const invalidTarget = await validatedRepository("pr_invalid_failure_target");
    await expect(
      invalidTarget.markPostingState("pr_invalid_failure_target", "APPROVED"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(invalidTarget.getPosting("pr_invalid_failure_target")).resolves.toMatchObject({
      state: "VALIDATED",
    });
  });

  it("records a non-unknown authorise failure only from an in-flight state", async () => {
    const repository = await draftRepository();
    await repository.approvePosting("pr_abcdefghijklmnop", "actor-a", "4".repeat(64), future, now);
    await repository.beginAuthorise(beginInput());
    await repository.markAuthoriseFailure("pr_abcdefghijklmnop", "BLOCKED_VALIDATION");
    await expect(repository.getPosting("pr_abcdefghijklmnop")).resolves.toMatchObject({
      state: "BLOCKED_VALIDATION",
    });
    await expect(
      repository.markAuthoriseFailure("pr_abcdefghijklmnop", "WRITE_RESULT_UNKNOWN"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("uses typed application errors for state gate failures", async () => {
    const repository = await draftRepository();
    try {
      await repository.beginAuthorise(beginInput());
      throw new Error("expected beginAuthorise to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
    }
  });
});
