import { randomBytes } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import type { QuickBooksPostingRepository } from "./repository.js";
import type { QuickBooksPostedResult, QuickBooksWorkflowService } from "./service.js";

type ReviewSecurityRepository = Pick<
  AccountingRepository,
  "saveOperatorSession" | "getOperatorSession" | "saveReviewCsrf" | "consumeReviewCsrf"
  | "revokeOperatorSessions"
>;

export class QuickBooksReviewService {
  readonly #postings: QuickBooksPostingRepository;
  readonly #security: ReviewSecurityRepository;

  constructor(options: {
    postings: QuickBooksPostingRepository;
    security: ReviewSecurityRepository;
  }) {
    this.#postings = options.postings;
    this.#security = options.security;
  }

  async createOperatorSession(actorId: string): Promise<{ session: string; expiresAt: Date }> {
    const session = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60_000);
    await this.#security.saveOperatorSession(sha256(`quickbooks:${session}`), actorId, expiresAt);
    return { session, expiresAt };
  }

  async authenticate(session: string): Promise<{ actorId: string; sessionHash: string }> {
    const sessionHash = sha256(`quickbooks:${session}`);
    const authenticated = await this.#security.getOperatorSession(sessionHash, new Date());
    if (!authenticated) {
      throw new AppError("AUTH_REQUIRED", "A valid QuickBooks review session is required.", { httpStatus: 401 });
    }
    return { actorId: authenticated.actorId, sessionHash };
  }

  async revokeActorSessions(actorId: string): Promise<number> {
    return this.#security.revokeOperatorSessions(actorId);
  }

  async getReview(postingRequestId: string, actorId: string, sessionHash: string) {
    const posting = await this.#ownedPosting(postingRequestId, actorId);
    if (!["PREPARED", "WRITE_RESULT_UNKNOWN", "POSTED_READBACK_VERIFIED", "REJECTED"].includes(posting.state)) {
      return { posting };
    }
    if (["POSTED_READBACK_VERIFIED", "REJECTED"].includes(posting.state)) return { posting };
    const csrfToken = randomBytes(32).toString("base64url");
    await this.#security.saveReviewCsrf(
      sha256(`quickbooks:${csrfToken}`),
      sessionHash,
      actorId,
      postingRequestId,
      new Date(Date.now() + 10 * 60_000),
    );
    return { posting, csrfToken };
  }

  async approve(options: {
    postingRequestId: string;
    actorId: string;
    sessionHash: string;
    csrfToken: string;
    approvedBy: string;
    service: QuickBooksWorkflowService;
  }): Promise<QuickBooksPostedResult> {
    const posting = await this.#ownedPosting(options.postingRequestId, options.actorId);
    if (!["PREPARED", "WRITE_RESULT_UNKNOWN", "POSTED_READBACK_VERIFIED"].includes(posting.state)) {
      throw new AppError("CONFLICT", `QuickBooks posting cannot be approved from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    if (posting.state !== "POSTED_READBACK_VERIFIED") {
      await this.#consumeCsrf(options);
    }
    return options.service.approveAndPost({
      actorId: options.actorId,
      postingRequestId: options.postingRequestId,
      approvedPayloadHash: posting.payloadHash,
      approvedBy: options.approvedBy,
    });
  }

  async reject(options: {
    postingRequestId: string;
    actorId: string;
    sessionHash: string;
    csrfToken: string;
    rejectedBy: string;
    service: QuickBooksWorkflowService;
  }) {
    const posting = await this.#ownedPosting(options.postingRequestId, options.actorId);
    if (posting.state !== "PREPARED") {
      throw new AppError("CONFLICT", `QuickBooks posting cannot be rejected from ${posting.state}.`, {
        httpStatus: 409,
      });
    }
    await this.#consumeCsrf(options);
    return options.service.reject({
      actorId: options.actorId,
      postingRequestId: options.postingRequestId,
      rejectedBy: options.rejectedBy,
    });
  }

  async #consumeCsrf(options: {
    postingRequestId: string;
    actorId: string;
    sessionHash: string;
    csrfToken: string;
  }): Promise<void> {
    const consumed = await this.#security.consumeReviewCsrf(
      sha256(`quickbooks:${options.csrfToken}`),
      options.sessionHash,
      options.actorId,
      options.postingRequestId,
      new Date(),
    );
    if (!consumed) {
      throw new AppError("FORBIDDEN", "QuickBooks review CSRF is invalid, expired, or already used.", {
        httpStatus: 403,
      });
    }
  }

  async #ownedPosting(postingRequestId: string, actorId: string) {
    const posting = await this.#postings.get(postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "QuickBooks posting request was not found.", { httpStatus: 404 });
    if (posting.actorId !== actorId) {
      throw new AppError("FORBIDDEN", "QuickBooks posting belongs to another actor.", { httpStatus: 403 });
    }
    return posting;
  }
}
