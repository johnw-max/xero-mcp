import { randomBytes } from "node:crypto";
import { canonicalBillForApproval } from "../domain/canonical.js";
import type { PostingRequest } from "../domain/models.js";
import type { AccountingRepository } from "../db/repository.js";
import { AppError } from "../errors.js";
import { hashObject, sha256 } from "../security/hash.js";
import { xeroBillDeepLink } from "../providers/xeroDeepLinks.js";
import type { SupplierBillSnapshot } from "../providers/types.js";
import type { AccountingService, AuthoriseSupplierBillResult } from "./accountingService.js";

export type ReviewAction =
  | "APPROVE_OR_REJECT"
  | "RESUME_AUTHORISE"
  | "RECOVER_AUTHORISE"
  | "VIEW_VERIFIED_RESULT"
  | "NONE";

export interface ReviewDetails {
  posting: PostingRequest;
  action: ReviewAction;
  tenantName?: string;
  xeroBillUrl?: string;
  csrfToken?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasInvoiceBoundSnapshot(posting: PostingRequest, expectedStatus?: string): boolean {
  const snapshot = record(posting.readbackSnapshot);
  const contact = record(snapshot?.contact);
  const lines = snapshot?.lines;
  if (
    !posting.xeroInvoiceId ||
    !snapshot ||
    !contact ||
    !Array.isArray(lines) ||
    lines.length === 0 ||
    snapshot.tenantId !== posting.tenantId ||
    snapshot.invoiceId !== posting.xeroInvoiceId ||
    snapshot.type !== "ACCPAY" ||
    typeof snapshot.status !== "string" ||
    typeof contact.contactId !== "string" ||
    !lines.every((line) => {
      const item = record(line);
      return item !== undefined &&
        typeof item.description === "string" &&
        typeof item.quantity === "string" &&
        typeof item.unitAmount === "string" &&
        typeof item.accountCode === "string" &&
        typeof item.taxType === "string";
    })
  ) {
    return false;
  }
  if (expectedStatus !== undefined && snapshot.status !== expectedStatus) return false;
  return hashObject(canonicalBillForApproval(snapshot as unknown as SupplierBillSnapshot)) === posting.providerPayloadHash;
}

function hasReviewRecoveryBinding(posting: PostingRequest, actorId: string): boolean {
  const requestId = `review:${posting.postingRequestId}:authorise`;
  const idempotencyKey = `zc:authorise:${sha256(`${posting.tenantId}:${requestId}:${posting.postingRequestId}`)}`;
  return Boolean(
    posting.xeroInvoiceId &&
    posting.approvalRefHash &&
    posting.approvedBy === actorId &&
    posting.approvedAt &&
    posting.approvalExpiresAt &&
    posting.approvalConsumedAt &&
    posting.authoriseRequestId === requestId &&
    posting.authoriseIdempotencyKey === idempotencyKey &&
    hasInvoiceBoundSnapshot(posting),
  );
}

export function reviewActionForPosting(
  posting: PostingRequest,
  actorId: string,
  now: Date = new Date(),
): ReviewAction {
  if (posting.actorId !== actorId) return "NONE";
  if (posting.documentType !== "ACCPAY") return "NONE";

  if (posting.state === "APPROVAL_PENDING") {
    const hasNoStaleApproval = !posting.approvalRefHash &&
      !posting.approvedBy &&
      !posting.approvedAt &&
      !posting.approvalExpiresAt &&
      !posting.approvalConsumedAt &&
      !posting.authoriseRequestId &&
      !posting.authoriseIdempotencyKey;
    return hasNoStaleApproval && hasInvoiceBoundSnapshot(posting, "DRAFT")
      ? "APPROVE_OR_REJECT"
      : "NONE";
  }

  if (posting.state === "APPROVED") {
    const resumableApproval = Boolean(
      posting.xeroInvoiceId &&
      posting.approvalRefHash &&
      posting.approvedBy === actorId &&
      posting.approvedAt &&
      posting.approvalExpiresAt &&
      posting.approvalExpiresAt > now &&
      !posting.approvalConsumedAt &&
      !posting.authoriseRequestId &&
      !posting.authoriseIdempotencyKey &&
      hasInvoiceBoundSnapshot(posting, "DRAFT"),
    );
    return resumableApproval ? "RESUME_AUTHORISE" : "NONE";
  }

  if (posting.state === "AUTHORISING" || posting.state === "WRITE_RESULT_UNKNOWN") {
    return hasReviewRecoveryBinding(posting, actorId) ? "RECOVER_AUTHORISE" : "NONE";
  }

  if (posting.state === "AUTHORISED_READBACK_VERIFIED") {
    return hasReviewRecoveryBinding(posting, actorId) && hasInvoiceBoundSnapshot(posting, "AUTHORISED")
      ? "VIEW_VERIFIED_RESULT"
      : "NONE";
  }

  return "NONE";
}

export class ReviewService {
  readonly #repository: AccountingRepository;

  constructor(repository: AccountingRepository) {
    this.#repository = repository;
  }

  async createOperatorSession(actorId: string): Promise<{ session: string; expiresAt: Date }> {
    const session = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60_000);
    await this.#repository.saveOperatorSession(sha256(session), actorId, expiresAt);
    return { session, expiresAt };
  }

  async authenticate(session: string): Promise<{ actorId: string; sessionHash: string }> {
    const sessionHash = sha256(session);
    const authenticated = await this.#repository.getOperatorSession(sessionHash, new Date());
    if (!authenticated) {
      throw new AppError("AUTH_REQUIRED", "A valid operator review session is required.", { httpStatus: 401 });
    }
    return { actorId: authenticated.actorId, sessionHash };
  }

  async getReview(
    postingRequestId: string,
    actorId: string,
    sessionHash: string,
  ): Promise<ReviewDetails> {
    const posting = await this.#requireOwnedPosting(postingRequestId, actorId);
    const connection = await this.#repository.getConnectionByActorTenant(actorId, posting.tenantId);
    const action = reviewActionForPosting(posting, actorId);
    const xeroBillUrl = xeroBillDeepLink(connection?.tenantShortCode, posting.xeroInvoiceId);
    const details: ReviewDetails = {
      posting,
      action,
      ...(connection?.tenantName ? { tenantName: connection.tenantName } : {}),
      ...(xeroBillUrl ? { xeroBillUrl } : {}),
    };
    if (action === "NONE") return details;

    const csrfToken = randomBytes(32).toString("base64url");
    await this.#repository.saveReviewCsrf(
      sha256(csrfToken),
      sessionHash,
      actorId,
      postingRequestId,
      new Date(Date.now() + 10 * 60_000),
    );
    return { ...details, csrfToken };
  }

  async approveAndAuthorise(options: {
    postingRequestId: string;
    actorId: string;
    sessionHash: string;
    csrfToken: string;
    accountingService: AccountingService;
  }): Promise<AuthoriseSupplierBillResult> {
    const posting = await this.#requireOwnedPosting(options.postingRequestId, options.actorId);
    if (reviewActionForPosting(posting, options.actorId) === "NONE") {
      throw new AppError("CONFLICT", `Posting request cannot be approved from ${posting.state}.`, { httpStatus: 409 });
    }
    return options.accountingService.authoriseReviewedSupplierBill(options.actorId, {
      postingRequestId: posting.postingRequestId,
      sessionHash: options.sessionHash,
      csrfToken: options.csrfToken,
    });
  }

  async reject(options: {
    postingRequestId: string;
    actorId: string;
    sessionHash: string;
    csrfToken: string;
  }): Promise<{ postingRequestId: string; state: "REJECTED" }> {
    const posting = await this.#requireOwnedPosting(options.postingRequestId, options.actorId);
    if (reviewActionForPosting(posting, options.actorId) !== "APPROVE_OR_REJECT") {
      throw new AppError("CONFLICT", `Posting request cannot be rejected from ${posting.state}.`, { httpStatus: 409 });
    }
    const rejected = await this.#repository.rejectPostingFromReview({
      postingRequestId: options.postingRequestId,
      actorId: options.actorId,
      sessionHash: options.sessionHash,
      csrfHash: sha256(options.csrfToken),
      now: new Date(),
    });
    return { postingRequestId: rejected.postingRequestId, state: "REJECTED" };
  }

  async #requireOwnedPosting(postingRequestId: string, actorId: string): Promise<PostingRequest> {
    const posting = await this.#repository.getPosting(postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
    if (posting.actorId !== actorId) {
      throw new AppError("FORBIDDEN", "Posting request belongs to another actor.", { httpStatus: 403 });
    }
    return posting;
  }
}
