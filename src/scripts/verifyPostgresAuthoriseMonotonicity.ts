import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { PostgresAccountingRepository } from "../db/postgresRepository.js";

const actorId = "postgres-verifier-actor";
const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const payloadHash = "3".repeat(64);
const approvalRefHash = "4".repeat(64);

async function prepareValidated(
  repository: PostgresAccountingRepository,
  suffix: string,
): Promise<string> {
  const postingRequestId = `pr_pg_validated_${suffix}`;
  await repository.createOrGetPosting({
    postingRequestId,
    actorId,
    tenantId,
    sourceRef: `synthetic://postgres-verifier/validated/${suffix}`,
    sourceSha256: "1".repeat(64),
    sourceEvidenceType: "LEGACY_UNVERIFIED",
    providerPayload: { tenantId, invoiceId, total: "109.0000" },
    requestPayloadHash: "2".repeat(64),
    providerPayloadHash: payloadHash,
    requestId: `pg-validated-create-${suffix}`,
    createIdempotencyKey: `pg-validated-create-key-${suffix}`,
  });
  return postingRequestId;
}

async function prepareReviewPending(
  repository: PostgresAccountingRepository,
  suffix: string,
): Promise<string> {
  const postingRequestId = await prepareValidated(repository, `review_${suffix}`);
  await repository.markDraftCreated(postingRequestId, {
    xeroInvoiceId: invoiceId,
    providerPayload: { tenantId, invoiceId, status: "DRAFT", total: "109.0000" },
    providerPayloadHash: payloadHash,
    writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
    readbackSnapshot: { tenantId, invoiceId, status: "DRAFT", total: "109.0000" },
  });
  return postingRequestId;
}

async function prepareAuthorising(
  repository: PostgresAccountingRepository,
  suffix: string,
): Promise<string> {
  const postingRequestId = `pr_pg_${suffix}`;
  const requestId = `pg-create-${suffix}`;
  await repository.createOrGetPosting({
    postingRequestId,
    actorId,
    tenantId,
    sourceRef: `synthetic://postgres-verifier/${suffix}`,
    sourceSha256: "1".repeat(64),
    sourceEvidenceType: "LEGACY_UNVERIFIED",
    providerPayload: { tenantId, invoiceId, total: "109.0000" },
    requestPayloadHash: "2".repeat(64),
    providerPayloadHash: payloadHash,
    requestId,
    createIdempotencyKey: `pg-create-key-${suffix}`,
  });
  await repository.markDraftCreated(postingRequestId, {
    xeroInvoiceId: invoiceId,
    providerPayload: { tenantId, invoiceId, status: "DRAFT", total: "109.0000" },
    providerPayloadHash: payloadHash,
    writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
    readbackSnapshot: { tenantId, invoiceId, status: "DRAFT", total: "109.0000" },
  });
  const now = new Date();
  await repository.approvePosting(
    postingRequestId,
    actorId,
    approvalRefHash,
    new Date(now.getTime() + 60_000),
    now,
  );
  const begun = await repository.beginAuthorise({
    postingRequestId,
    actorId,
    tenantId,
    invoiceId,
    approvalRefHash,
    approvedPayloadHash: payloadHash,
    requestId: `pg-authorise-${suffix}`,
    idempotencyKey: `pg-authorise-key-${suffix}`,
    now,
  });
  assert.equal(begun.mode, "CALL_PROVIDER");
  return postingRequestId;
}

export async function verifyPostgresAuthoriseMonotonicity(databaseUrl: string): Promise<void> {
  await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  const repository = new PostgresAccountingRepository(databaseUrl);
  const runId = randomUUID().replaceAll("-", "");
  try {
    const reviewId = await prepareReviewPending(repository, `${runId}_atomic`);
    const reviewNow = new Date();
    const reviewExpiry = new Date(reviewNow.getTime() + 10 * 60_000);
    const sessionHash = `session-${runId}`;
    const csrfA = `csrf-a-${runId}`;
    const csrfB = `csrf-b-${runId}`;
    const csrfInvalidBinding = `csrf-invalid-binding-${runId}`;
    await repository.saveOperatorSession(sessionHash, actorId, reviewExpiry);
    await Promise.all([
      repository.saveReviewCsrf(csrfA, sessionHash, actorId, reviewId, reviewExpiry),
      repository.saveReviewCsrf(csrfB, sessionHash, actorId, reviewId, reviewExpiry),
      repository.saveReviewCsrf(csrfInvalidBinding, sessionHash, actorId, reviewId, reviewExpiry),
    ]);
    const reviewRequestId = `review:${reviewId}:authorise`;
    const reviewIdempotencyKey = `pg-review-authorise-key-${runId}`;
    const reviewInput = {
      postingRequestId: reviewId,
      actorId,
      tenantId,
      invoiceId,
      approvalRefHash,
      approvedPayloadHash: payloadHash,
      requestId: reviewRequestId,
      idempotencyKey: reviewIdempotencyKey,
      sessionHash,
      approvalExpiresAt: reviewExpiry,
      now: reviewNow,
    };
    const reviewClaims = await Promise.all([
      repository.beginReviewAuthorise({ ...reviewInput, csrfHash: csrfA }),
      repository.beginReviewAuthorise({ ...reviewInput, csrfHash: csrfB }),
    ]);
    assert.deepEqual(
      reviewClaims.map((claim) => claim.mode).sort(),
      ["CALL_PROVIDER", "RESUME_READBACK_ONLY"].sort(),
    );
    const claimedReview = await repository.getPosting(reviewId);
    assert.equal(claimedReview?.state, "AUTHORISING");
    assert.equal(claimedReview?.authoriseRequestId, reviewRequestId);
    assert.equal(claimedReview?.authoriseIdempotencyKey, reviewIdempotencyKey);
    assert.equal(claimedReview?.approvalRefHash, approvalRefHash);
    await assert.rejects(
      repository.beginReviewAuthorise({ ...reviewInput, csrfHash: csrfA }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      repository.beginReviewAuthorise({
        ...reviewInput,
        requestId: `${reviewRequestId}:different`,
        idempotencyKey: `${reviewIdempotencyKey}:different`,
        csrfHash: csrfInvalidBinding,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    assert.equal(
      await repository.consumeReviewCsrf(
        csrfInvalidBinding,
        sessionHash,
        actorId,
        reviewId,
        new Date(),
      ),
      true,
    );
    const afterInvalidReviewResume = await repository.getPosting(reviewId);
    assert.equal(afterInvalidReviewResume?.authoriseRequestId, reviewRequestId);
    assert.equal(afterInvalidReviewResume?.authoriseIdempotencyKey, reviewIdempotencyKey);
    await assert.rejects(
      repository.markPostingState(reviewId, "READBACK_MISMATCH"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    const afterLateAuthorisingDraftFailure = await repository.getPosting(reviewId);
    assert.equal(afterLateAuthorisingDraftFailure?.state, "AUTHORISING");
    assert.equal(afterLateAuthorisingDraftFailure?.authoriseRequestId, reviewRequestId);

    const approvedDraftId = await prepareReviewPending(repository, `${runId}_late_approved`);
    await repository.approvePosting(
      approvedDraftId,
      actorId,
      approvalRefHash,
      reviewExpiry,
      reviewNow,
    );
    await assert.rejects(
      repository.markPostingState(approvedDraftId, "BLOCKED_VALIDATION"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    assert.equal((await repository.getPosting(approvedDraftId))?.state, "APPROVED");
    const expiryRaceSession = `session-expiry-race-${runId}`;
    const expiryRaceCsrf = `csrf-expiry-race-${runId}`;
    const expiryRaceCapabilityExpires = new Date(reviewExpiry.getTime() + 10 * 60_000);
    await repository.saveOperatorSession(expiryRaceSession, actorId, expiryRaceCapabilityExpires);
    await repository.saveReviewCsrf(
      expiryRaceCsrf,
      expiryRaceSession,
      actorId,
      approvedDraftId,
      expiryRaceCapabilityExpires,
    );
    await assert.rejects(
      repository.beginReviewAuthorise({
        postingRequestId: approvedDraftId,
        actorId,
        tenantId,
        invoiceId,
        approvalRefHash,
        approvedPayloadHash: payloadHash,
        requestId: `review:${approvedDraftId}:authorise`,
        idempotencyKey: `pg-review-expiry-key-${runId}`,
        sessionHash: expiryRaceSession,
        csrfHash: expiryRaceCsrf,
        approvalExpiresAt: expiryRaceCapabilityExpires,
        now: reviewExpiry,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "APPROVAL_INVALID",
    );
    assert.equal(
      await repository.consumeReviewCsrf(
        expiryRaceCsrf,
        expiryRaceSession,
        actorId,
        approvedDraftId,
        reviewNow,
      ),
      true,
    );

    const validatedFailureId = await prepareValidated(repository, `${runId}_draft_failure`);
    await repository.markPostingState(validatedFailureId, "BLOCKED_VALIDATION");
    assert.equal((await repository.getPosting(validatedFailureId))?.state, "BLOCKED_VALIDATION");

    const draftUnknownFailureId = await prepareValidated(repository, `${runId}_draft_unknown_failure`);
    await repository.markDraftWriteUnknown(draftUnknownFailureId, invoiceId);
    await repository.markPostingState(draftUnknownFailureId, "READBACK_MISMATCH");
    const draftUnknownFailure = await repository.getPosting(draftUnknownFailureId);
    assert.equal(draftUnknownFailure?.state, "READBACK_MISMATCH");
    assert.equal(draftUnknownFailure?.authoriseRequestId, undefined);

    const invalidFailureTargetId = await prepareValidated(repository, `${runId}_invalid_failure_target`);
    await assert.rejects(
      repository.markPostingState(invalidFailureTargetId, "APPROVED"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    assert.equal((await repository.getPosting(invalidFailureTargetId))?.state, "VALIDATED");

    const concurrentId = await prepareAuthorising(repository, `${runId}_concurrent`);
    const readback = { tenantId, invoiceId, status: "AUTHORISED", total: "109.0000" };
    const completions = await Promise.all([
      repository.completeAuthorise(
        concurrentId,
        { operation: "AUTHORISE", candidate: "a", invoiceId },
        readback,
      ),
      repository.completeAuthorise(
        concurrentId,
        { operation: "AUTHORISE", candidate: "b", invoiceId },
        readback,
      ),
    ]);
    assert.ok(completions.every((posting) => posting.state === "AUTHORISED_READBACK_VERIFIED"));
    assert.deepEqual(completions[0]?.writeReceipt, completions[1]?.writeReceipt);

    await repository.markAuthoriseFailure(concurrentId, "WRITE_RESULT_UNKNOWN");
    await repository.markAuthoriseFailure(concurrentId, "READBACK_MISMATCH");
    await repository.markAuthoriseFailure(concurrentId, "BLOCKED_VALIDATION");
    await repository.markPostingState(concurrentId, "BLOCKED_VALIDATION");
    const terminal = await repository.getPosting(concurrentId);
    assert.equal(terminal?.state, "AUTHORISED_READBACK_VERIFIED");
    assert.equal(terminal?.readbackSnapshot?.status, "AUTHORISED");
    await assert.rejects(
      repository.markDraftWriteUnknown(
        concurrentId,
        "99999999-9999-4999-8999-999999999999",
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    const afterLateDraftUnknown = await repository.getPosting(concurrentId);
    assert.equal(afterLateDraftUnknown?.state, "AUTHORISED_READBACK_VERIFIED");
    assert.equal(afterLateDraftUnknown?.xeroInvoiceId, terminal?.xeroInvoiceId);
    assert.deepEqual(afterLateDraftUnknown?.writeReceipt, terminal?.writeReceipt);
    assert.deepEqual(afterLateDraftUnknown?.readbackSnapshot, terminal?.readbackSnapshot);

    const blockedId = await prepareAuthorising(repository, `${runId}_blocked`);
    await repository.markAuthoriseFailure(blockedId, "BLOCKED_VALIDATION");
    assert.equal((await repository.getPosting(blockedId))?.state, "BLOCKED_VALIDATION");
    await assert.rejects(
      repository.markAuthoriseFailure(blockedId, "WRITE_RESULT_UNKNOWN"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );

    const unknownId = await prepareAuthorising(repository, `${runId}_unknown`);
    await repository.markAuthoriseFailure(unknownId, "WRITE_RESULT_UNKNOWN");
    const unknownBeforePollution = await repository.getPosting(unknownId);
    await assert.rejects(
      repository.markPostingState(unknownId, "READBACK_MISMATCH"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    const bogusInvoiceId = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(
      repository.markDraftWriteUnknown(unknownId, bogusInvoiceId),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    await assert.rejects(
      repository.recoverDraftCreated(unknownId, {
        xeroInvoiceId: bogusInvoiceId,
        providerPayload: { tenantId, invoiceId: bogusInvoiceId, status: "DRAFT", total: "999.0000" },
        providerPayloadHash: "9".repeat(64),
        writeReceipt: { operation: "BOGUS_LATE_DRAFT", invoiceId: bogusInvoiceId },
        readbackSnapshot: { tenantId, invoiceId: bogusInvoiceId, status: "DRAFT", total: "999.0000" },
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    await assert.rejects(
      repository.completeAuthorise(
        unknownId,
        { operation: "BOGUS_AUTHORISE", invoiceId: bogusInvoiceId },
        { tenantId, invoiceId: bogusInvoiceId, status: "AUTHORISED", total: "109.0000" },
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "READBACK_MISMATCH",
    );
    const unknownAfterPollution = await repository.getPosting(unknownId);
    assert.equal(unknownAfterPollution?.state, "WRITE_RESULT_UNKNOWN");
    assert.equal(unknownAfterPollution?.xeroInvoiceId, invoiceId);
    assert.equal(unknownAfterPollution?.authoriseRequestId, unknownBeforePollution?.authoriseRequestId);
    assert.deepEqual(unknownAfterPollution?.writeReceipt, unknownBeforePollution?.writeReceipt);
    assert.deepEqual(unknownAfterPollution?.readbackSnapshot, unknownBeforePollution?.readbackSnapshot);
    const recovered = await repository.completeAuthorise(
      unknownId,
      { operation: "AUTHORISE_RECOVERED_BY_READBACK", invoiceId },
      readback,
    );
    assert.equal(recovered.state, "AUTHORISED_READBACK_VERIFIED");

    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      verifier: "postgres-authorise-monotonicity",
      runId,
      checks: [
        "atomic-review-claim-one-provider-one-resume",
        "atomic-review-csrf-replay-rejected",
        "atomic-review-binding-stable-before-csrf-consume",
        "approved-review-expiry-rechecked-before-csrf-consume",
        "draft-failure-cas-rejects-approved-authorising-authorise-unknown",
        "draft-failure-cas-allows-only-draft-phase-targets",
        "concurrent-complete-idempotent",
        "terminal-failure-no-op",
        "terminal-generic-transition-no-op",
        "terminal-draft-unknown-rejected",
        "conditional-blocked-validation",
        "authorise-unknown-rejects-late-draft-pollution",
        "complete-authorise-binds-readback-invoice",
        "unknown-readback-recovery",
      ],
    })}\n`);
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await verifyPostgresAuthoriseMonotonicity(databaseUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      verifier: "postgres-authorise-monotonicity",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    })}\n`);
    process.exitCode = 1;
  });
}
