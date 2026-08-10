import { gzipSync } from "node:zlib";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  NodeXeroTrialBalanceTransport,
  type XeroTrialBalanceTransport,
} from "../src/providers/xeroTrialBalanceTransport.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers = new Set<Server>();

async function listen(handler: Handler): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
  return { baseUrl: `http://127.0.0.1:${address.port}/`, server };
}

async function closeServer(server: Server): Promise<void> {
  servers.delete(server);
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transport(baseUrl: string, overrides: {
  deadlineMs?: number;
  maxRawResponseBytes?: number;
  maxDecompressedResponseBytes?: number;
} = {}): NodeXeroTrialBalanceTransport {
  return new NodeXeroTrialBalanceTransport({
    baseUrl,
    deadlineMs: overrides.deadlineMs ?? 1_000,
    maxRawResponseBytes: overrides.maxRawResponseBytes ?? 64 * 1_024,
    maxDecompressedResponseBytes: overrides.maxDecompressedResponseBytes ?? 256 * 1_024,
  });
}

const input = {
  tenantId: "tenant-test",
  accessToken: "test-access-token",
  date: "2026-08-06",
};

describe("Xero Trial Balance Provider transport boundary", () => {
  it("preserves a normal chunked Xero report and official SDK field mapping", async () => {
    let observedUrl = "";
    let observedTenant = "";
    let observedAuthorization = "";
    const body = JSON.stringify({
      Reports: [{
        ReportID: "TrialBalance",
        ReportName: "Trial Balance",
        ReportDate: "6 August 2026",
        Rows: [{ RowType: "Row", Cells: [{ Value: "100.00" }] }],
      }],
    });
    const { baseUrl, server } = await listen((request, response) => {
      observedUrl = request.url ?? "";
      observedTenant = String(request.headers["xero-tenant-id"] ?? "");
      observedAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(body.slice(0, 17));
      response.end(body.slice(17));
    });

    const result = await transport(baseUrl).getTrialBalance(input);

    expect(result).toMatchObject({
      reports: [{
        reportID: "TrialBalance",
        reportName: "Trial Balance",
        reportDate: "6 August 2026",
        rows: [{ rowType: "Row", cells: [{ value: "100.00" }] }],
      }],
    });
    expect(observedUrl).toBe("/Reports/TrialBalance?date=2026-08-06&paymentsOnly=false");
    expect(observedTenant).toBe("tenant-test");
    expect(observedAuthorization).toBe("Bearer test-access-token");
    await closeServer(server);
  });

  it("sends paymentsOnly=false and no invented date when the caller omits the as-of date", async () => {
    let observedUrl = "";
    const { baseUrl, server } = await listen((request, response) => {
      observedUrl = request.url ?? "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ Reports: [{ ReportID: "TrialBalance", Rows: [] }] }));
    });

    await expect(transport(baseUrl).getTrialBalance({
      tenantId: input.tenantId,
      accessToken: input.accessToken,
    })).resolves.toMatchObject({ reports: [{ reportID: "TrialBalance", rows: [] }] });

    expect(observedUrl).toBe("/Reports/TrialBalance?paymentsOnly=false");
    await closeServer(server);
  });

  it("preserves an ordinary gzip-compressed Xero report within both byte budgets", async () => {
    const compressed = gzipSync(JSON.stringify({
      Reports: [{ ReportID: "TrialBalance", ReportName: "Trial Balance", Rows: [] }],
    }));
    const { baseUrl, server } = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      response.end(compressed);
    });

    await expect(transport(baseUrl).getTrialBalance(input)).resolves.toMatchObject({
      reports: [{ reportID: "TrialBalance", reportName: "Trial Balance", rows: [] }],
    });
    await closeServer(server);
  });

  it("destroys an unbounded chunked response when raw bytes cross the limit", async () => {
    const closed = deferred();
    let responseRef: ServerResponse | undefined;
    const { baseUrl, server } = await listen((_request, response) => {
      responseRef = response;
      response.on("close", closed.resolve);
      response.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => response.write(Buffer.alloc(1_024, 0x61)), 1);
      interval.unref();
      response.on("close", () => clearInterval(interval));
    });

    await expect(transport(baseUrl, {
      maxRawResponseBytes: 4 * 1_024,
      maxDecompressedResponseBytes: 32 * 1_024,
    }).getTrialBalance(input)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      details: { reason: "RAW_RESPONSE_TOO_LARGE", limitBytes: 4 * 1_024 },
    });
    await closed.promise;
    expect(responseRef?.writableEnded).toBe(false);
    expect(responseRef?.destroyed).toBe(true);
    await closeServer(server);
  });

  it("rejects an oversized Content-Length before downloading the announced body", async () => {
    const closed = deferred();
    let responseRef: ServerResponse | undefined;
    const { baseUrl, server } = await listen((_request, response) => {
      responseRef = response;
      response.on("close", closed.resolve);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(64 * 1_024),
      });
      response.write("{");
    });

    await expect(transport(baseUrl, {
      maxRawResponseBytes: 1_024,
    }).getTrialBalance(input)).rejects.toMatchObject({
      details: { reason: "RAW_RESPONSE_TOO_LARGE", limitBytes: 1_024 },
    });
    await closed.promise;
    expect(responseRef?.writableEnded).toBe(false);
    expect(responseRef?.destroyed).toBe(true);
    await closeServer(server);
  });

  it("destroys a small gzip response when decompression expansion crosses its own limit", async () => {
    const expanded = JSON.stringify({
      Reports: [{ Rows: [{ Cells: [{ Value: "A".repeat(128 * 1_024) }] }] }],
    });
    const compressed = gzipSync(expanded);
    expect(compressed.byteLength).toBeLessThan(4 * 1_024);
    const closed = deferred();
    let responseRef: ServerResponse | undefined;
    const { baseUrl, server } = await listen((_request, response) => {
      responseRef = response;
      response.on("close", closed.resolve);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      });
      let offset = 0;
      const interval = setInterval(() => {
        const next = compressed.subarray(offset, offset + 32);
        if (next.byteLength > 0) response.write(next);
        offset += next.byteLength;
      }, 1);
      interval.unref();
      response.on("close", () => clearInterval(interval));
    });

    await expect(transport(baseUrl, {
      maxRawResponseBytes: 4 * 1_024,
      maxDecompressedResponseBytes: 8 * 1_024,
    }).getTrialBalance(input)).rejects.toMatchObject({
      details: { reason: "DECOMPRESSED_RESPONSE_TOO_LARGE", limitBytes: 8 * 1_024 },
    });
    await closed.promise;
    expect(responseRef?.writableEnded).toBe(false);
    expect(responseRef?.destroyed).toBe(true);
    await closeServer(server);
  });

  it("aborts the socket when the upstream does not answer before the request deadline", async () => {
    const started = deferred();
    const closed = deferred();
    const { baseUrl, server } = await listen((request) => {
      started.resolve();
      request.on("close", closed.resolve);
    });
    const startedAt = Date.now();
    const pending = transport(baseUrl, { deadlineMs: 50 }).getTrialBalance(input);
    await started.promise;

    await expect(pending).rejects.toMatchObject({
      details: { reason: "UPSTREAM_DEADLINE_EXCEEDED" },
      retryable: true,
    });
    await closed.promise;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await closeServer(server);
  });

  it("propagates caller cancellation to the real socket without waiting for the deadline", async () => {
    const started = deferred();
    const closed = deferred();
    const { baseUrl, server } = await listen((request) => {
      started.resolve();
      request.on("close", closed.resolve);
    });
    const controller = new AbortController();
    const pending = transport(baseUrl, { deadlineMs: 5_000 }).getTrialBalance({ ...input, signal: controller.signal });
    await started.promise;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      details: { reason: "UPSTREAM_REQUEST_CANCELLED" },
      retryable: false,
    });
    await closed.promise;
    await closeServer(server);
  });

  it("routes Provider reads through the bounded transport after manager token refresh/binding", async () => {
    const report = { reports: [{ reportName: "Trial Balance" }] };
    const getTrialBalance = vi.fn().mockResolvedValue(report);
    const boundedTransport = { getTrialBalance } satisfies XeroTrialBalanceTransport;
    const withAccessToken = vi.fn(async <T>(
      _principal: unknown,
      action: (accessToken: string, connection: { tenantId: string }) => Promise<T>,
    ): Promise<T> => action("test-refreshed-token", { tenantId: "tenant-bound" }));
    const manager = { withAccessToken } as unknown as XeroClientManager;
    const provider = new XeroAccountingProvider({} as AccountingRepository, manager, boundedTransport);

    await expect(provider.getTrialBalance("actor-a", "2026-08-06")).resolves.toEqual(report);
    expect(getTrialBalance).toHaveBeenCalledWith({
      tenantId: "tenant-bound",
      accessToken: "test-refreshed-token",
      date: "2026-08-06",
    });
    expect(withAccessToken).toHaveBeenCalledOnce();
  });
});
