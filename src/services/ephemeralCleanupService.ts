import type {
  AccountingRepository,
  EphemeralCleanupCounts,
} from "../db/repository.js";
import type { Logger } from "../logging.js";

export const EPHEMERAL_CLEANUP_DEFAULTS = {
  graceMs: 60 * 60_000,
  batchSize: 1_000,
  maxBatches: 20,
  intervalMs: 15 * 60_000,
} as const;

export type EphemeralCleanupRunResult =
  | { status: "COMPLETED"; batches: number; deleted: EphemeralCleanupCounts }
  | { status: "SKIPPED_LOCKED" | "SKIPPED_RUNNING" | "SKIPPED_STOPPED" }
  | { status: "FAILED"; errorClass: string };

interface IntervalHandle {
  unref(): unknown;
}

interface CleanupScheduler {
  setInterval(callback: () => void, intervalMs: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

const systemScheduler: CleanupScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class EphemeralCleanupService {
  readonly #repository: Pick<AccountingRepository, "cleanupExpiredEphemeral">;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #scheduler: CleanupScheduler;
  readonly #graceMs: number;
  readonly #batchSize: number;
  readonly #maxBatches: number;
  readonly #intervalMs: number;
  #timer: IntervalHandle | undefined;
  #inFlight: Promise<EphemeralCleanupRunResult> | undefined;
  #started = false;
  #stopped = false;

  constructor(options: {
    repository: Pick<AccountingRepository, "cleanupExpiredEphemeral">;
    logger: Logger;
    now?: () => Date;
    scheduler?: CleanupScheduler;
    graceMs?: number;
    batchSize?: number;
    maxBatches?: number;
    intervalMs?: number;
  }) {
    this.#repository = options.repository;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#graceMs = safeInteger(options.graceMs ?? EPHEMERAL_CLEANUP_DEFAULTS.graceMs, "graceMs", true);
    this.#batchSize = safeInteger(options.batchSize ?? EPHEMERAL_CLEANUP_DEFAULTS.batchSize, "batchSize");
    this.#maxBatches = safeInteger(options.maxBatches ?? EPHEMERAL_CLEANUP_DEFAULTS.maxBatches, "maxBatches");
    this.#intervalMs = safeInteger(options.intervalMs ?? EPHEMERAL_CLEANUP_DEFAULTS.intervalMs, "intervalMs");
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    void this.runOnce();
    this.#timer = this.#scheduler.setInterval(() => {
      void this.runOnce();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const inFlight = this.#inFlight;
    if (inFlight) await inFlight;
  }

  async runOnce(): Promise<EphemeralCleanupRunResult> {
    if (this.#stopped) return { status: "SKIPPED_STOPPED" };
    if (this.#inFlight) return { status: "SKIPPED_RUNNING" };

    const run = this.#executeSafely();
    this.#inFlight = run;
    try {
      return await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }

  async #executeSafely(): Promise<EphemeralCleanupRunResult> {
    const startedAt = Date.now();
    try {
      const result = await this.#execute();
      if (result.status === "COMPLETED") {
        const context = {
          cleanupStatus: result.status,
          batches: result.batches,
          scrubbedOAuthBrokerFlows: result.deleted.oauthBrokerFlows,
          deletedOAuthStates: result.deleted.oauthStates,
          deletedConnectTickets: result.deleted.connectTickets,
          deletedOperatorSessions: result.deleted.operatorSessions,
          deletedReviewCsrfTokens: result.deleted.reviewCsrfTokens,
          durationMs: Date.now() - startedAt,
        };
        if (Object.values(result.deleted).some((count) => count > 0)) {
          this.#logger.info("Expired ephemeral authorization records cleaned.", context);
        } else {
          this.#logger.debug("No expired ephemeral authorization records required cleanup.", context);
        }
      } else {
        this.#logger.debug("Ephemeral authorization cleanup skipped because another worker holds the lock.", {
          cleanupStatus: result.status,
          durationMs: Date.now() - startedAt,
        });
      }
      return result;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : "CleanupError";
      this.#logger.warn("Ephemeral authorization cleanup failed; the server will continue.", {
        errorClass,
        durationMs: Date.now() - startedAt,
      });
      return { status: "FAILED", errorClass };
    }
  }

  async #execute(): Promise<EphemeralCleanupRunResult> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - this.#graceMs);
    const deleted = emptyCounts();
    let batches = 0;

    for (; batches < this.#maxBatches; batches += 1) {
      const batch = await this.#repository.cleanupExpiredEphemeral(cutoff, this.#batchSize, now);
      if (!batch.lockAcquired) {
        if (batches === 0) return { status: "SKIPPED_LOCKED" };
        break;
      }
      deleted.mcpRefreshRetryResponses += batch.deleted.mcpRefreshRetryResponses;
      deleted.oauthBrokerFlows += batch.deleted.oauthBrokerFlows;
      deleted.oauthStates += batch.deleted.oauthStates;
      deleted.connectTickets += batch.deleted.connectTickets;
      deleted.operatorSessions += batch.deleted.operatorSessions;
      deleted.reviewCsrfTokens += batch.deleted.reviewCsrfTokens;
      if (Object.values(batch.deleted).every((count) => count < this.#batchSize)) {
        batches += 1;
        break;
      }
    }

    return { status: "COMPLETED", batches, deleted };
  }
}

function emptyCounts(): EphemeralCleanupCounts {
  return {
    mcpRefreshRetryResponses: 0,
    oauthBrokerFlows: 0,
    oauthStates: 0,
    connectTickets: 0,
    operatorSessions: 0,
    reviewCsrfTokens: 0,
  };
}

function safeInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}
