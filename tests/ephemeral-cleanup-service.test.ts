import { describe, expect, it, vi } from "vitest";
import type {
  AccountingRepository,
  EphemeralCleanupBatchResult,
} from "../src/db/repository.js";
import type { Logger } from "../src/logging.js";
import {
  EPHEMERAL_CLEANUP_DEFAULTS,
  EphemeralCleanupService,
} from "../src/services/ephemeralCleanupService.js";

type CleanupRepository = Pick<AccountingRepository, "cleanupExpiredEphemeral">;

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
}

function batch(
  deleted: Partial<EphemeralCleanupBatchResult["deleted"]> = {},
  lockAcquired = true,
): EphemeralCleanupBatchResult {
  return {
    lockAcquired,
    deleted: {
      mcpRefreshRetryResponses: deleted.mcpRefreshRetryResponses ?? 0,
      oauthBrokerFlows: deleted.oauthBrokerFlows ?? 0,
      oauthStates: deleted.oauthStates ?? 0,
      connectTickets: deleted.connectTickets ?? 0,
      operatorSessions: deleted.operatorSessions ?? 0,
      reviewCsrfTokens: deleted.reviewCsrfTokens ?? 0,
    },
  };
}

function repository(
  implementation: CleanupRepository["cleanupExpiredEphemeral"],
): CleanupRepository {
  return { cleanupExpiredEphemeral: implementation };
}

describe("EphemeralCleanupService", () => {
  it("safely skips when the repository does not acquire its advisory lock", async () => {
    const cleanupExpiredEphemeral = vi.fn().mockResolvedValue(batch({}, false));
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: logger(),
    });

    await expect(service.runOnce()).resolves.toEqual({ status: "SKIPPED_LOCKED" });
    expect(cleanupExpiredEphemeral).toHaveBeenCalledOnce();
  });

  it("uses a one-hour grace and a 1000-row per-table batch until a partial batch", async () => {
    const fixedNow = new Date("2026-08-04T12:00:00.000Z");
    const cleanupExpiredEphemeral = vi.fn()
      .mockResolvedValueOnce(batch({
        oauthStates: 1_000,
        connectTickets: 1_000,
        operatorSessions: 1_000,
        reviewCsrfTokens: 1_000,
      }))
      .mockResolvedValueOnce(batch({
        oauthStates: 3,
        connectTickets: 2,
        operatorSessions: 1,
        reviewCsrfTokens: 4,
      }));
    const log = logger();
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: log,
      now: () => fixedNow,
    });

    await expect(service.runOnce()).resolves.toEqual({
      status: "COMPLETED",
      batches: 2,
      deleted: {
        mcpRefreshRetryResponses: 0,
        oauthBrokerFlows: 0,
        oauthStates: 1_003,
        connectTickets: 1_002,
        operatorSessions: 1_001,
        reviewCsrfTokens: 1_004,
      },
    });
    expect(cleanupExpiredEphemeral).toHaveBeenCalledTimes(2);
    for (const [cutoff, batchSize, brokerFlowCutoff] of cleanupExpiredEphemeral.mock.calls) {
      expect(cutoff).toEqual(new Date(fixedNow.getTime() - EPHEMERAL_CLEANUP_DEFAULTS.graceMs));
      expect(batchSize).toBe(EPHEMERAL_CLEANUP_DEFAULTS.batchSize);
      expect(brokerFlowCutoff).toEqual(fixedNow);
    }
    expect(log.info).toHaveBeenCalledWith(
      "Expired ephemeral authorization records cleaned.",
      expect.objectContaining({ batches: 2, deletedOAuthStates: 1_003 }),
    );
  });

  it("caps a continuously full cleanup run at twenty batches", async () => {
    const cleanupExpiredEphemeral = vi.fn().mockResolvedValue(batch({ oauthStates: 1_000 }));
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: logger(),
    });

    await expect(service.runOnce()).resolves.toMatchObject({
      status: "COMPLETED",
      batches: EPHEMERAL_CLEANUP_DEFAULTS.maxBatches,
      deleted: { oauthBrokerFlows: 0, oauthStates: 20_000 },
    });
    expect(cleanupExpiredEphemeral).toHaveBeenCalledTimes(EPHEMERAL_CLEANUP_DEFAULTS.maxBatches);
  });

  it("prevents overlapping runs", async () => {
    let resolveCleanup!: (value: EphemeralCleanupBatchResult) => void;
    const waiting = new Promise<EphemeralCleanupBatchResult>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanupExpiredEphemeral = vi.fn().mockImplementationOnce(() => waiting);
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: logger(),
    });

    const first = service.runOnce();
    await expect(service.runOnce()).resolves.toEqual({ status: "SKIPPED_RUNNING" });
    resolveCleanup(batch());
    await expect(first).resolves.toMatchObject({ status: "COMPLETED", batches: 1 });
    expect(cleanupExpiredEphemeral).toHaveBeenCalledOnce();
  });

  it("logs only a sanitized warning and resolves when cleanup fails", async () => {
    const log = logger();
    const cleanupExpiredEphemeral = vi.fn()
      .mockRejectedValue(new TypeError("Bearer qa-secret-must-not-be-logged"));
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: log,
    });

    await expect(service.runOnce()).resolves.toEqual({ status: "FAILED", errorClass: "TypeError" });
    expect(log.warn).toHaveBeenCalledWith(
      "Ephemeral authorization cleanup failed; the server will continue.",
      expect.objectContaining({ errorClass: "TypeError" }),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("qa-secret-must-not-be-logged");
  });

  it("starts immediately, unreferences the interval, and makes no query after stop resolves", async () => {
    let scheduled: (() => void) | undefined;
    let resolveCleanup!: (value: EphemeralCleanupBatchResult) => void;
    const waiting = new Promise<EphemeralCleanupBatchResult>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanupExpiredEphemeral = vi.fn().mockImplementationOnce(() => waiting);
    const unref = vi.fn();
    const clearInterval = vi.fn();
    const scheduler = {
      setInterval: vi.fn((callback: () => void, intervalMs: number) => {
        scheduled = callback;
        expect(intervalMs).toBe(EPHEMERAL_CLEANUP_DEFAULTS.intervalMs);
        return { unref };
      }),
      clearInterval,
    };
    const service = new EphemeralCleanupService({
      repository: repository(cleanupExpiredEphemeral),
      logger: logger(),
      scheduler,
    });

    service.start();
    expect(cleanupExpiredEphemeral).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    const stopping = service.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
    resolveCleanup(batch());
    await stopping;

    const callsAfterStop = cleanupExpiredEphemeral.mock.calls.length;
    scheduled?.();
    await Promise.resolve();
    expect(cleanupExpiredEphemeral).toHaveBeenCalledTimes(callsAfterStop);
    await expect(service.runOnce()).resolves.toEqual({ status: "SKIPPED_STOPPED" });
  });
});
