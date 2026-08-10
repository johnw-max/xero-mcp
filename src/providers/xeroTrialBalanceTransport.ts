import { request as requestHttp, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ObjectSerializer } from "xero-node";
import { AppError } from "../errors.js";

export const XERO_TRIAL_BALANCE_REQUEST_DEADLINE_MS = 15_000;
export const XERO_TRIAL_BALANCE_MAX_RAW_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const XERO_TRIAL_BALANCE_MAX_DECOMPRESSED_RESPONSE_BYTES = 8 * 1_024 * 1_024;

export type XeroTrialBalanceTransportFailureReason =
  | "UPSTREAM_DEADLINE_EXCEEDED"
  | "UPSTREAM_REQUEST_CANCELLED"
  | "RAW_RESPONSE_TOO_LARGE"
  | "DECOMPRESSED_RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_JSON_RESPONSE"
  | "INVALID_REPORT_RESPONSE"
  | "UPSTREAM_HTTP_ERROR"
  | "UPSTREAM_NETWORK_ERROR";

export interface XeroTrialBalanceTransportInput {
  tenantId: string;
  accessToken: string;
  date?: string;
  signal?: AbortSignal;
}

export interface XeroTrialBalanceTransport {
  getTrialBalance(input: XeroTrialBalanceTransportInput): Promise<Record<string, unknown>>;
}

export interface NodeXeroTrialBalanceTransportOptions {
  baseUrl?: string;
  deadlineMs?: number;
  maxRawResponseBytes?: number;
  maxDecompressedResponseBytes?: number;
}

class ResponseBoundaryError extends Error {
  readonly reason: XeroTrialBalanceTransportFailureReason;
  readonly limit: number | undefined;

  constructor(reason: XeroTrialBalanceTransportFailureReason, limit?: number) {
    super(reason);
    this.name = "ResponseBoundaryError";
    this.reason = reason;
    this.limit = limit;
  }
}

class ByteLimitTransform extends Transform {
  readonly #limit: number;
  readonly #reason: XeroTrialBalanceTransportFailureReason;
  #bytes = 0;

  constructor(limit: number, reason: XeroTrialBalanceTransportFailureReason) {
    super();
    this.#limit = limit;
    this.#reason = reason;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += buffer.byteLength;
    if (this.#bytes > this.#limit) {
      callback(new ResponseBoundaryError(this.#reason, this.#limit));
      return;
    }
    callback(null, buffer);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requestUrl(baseUrl: string, date?: string): URL {
  const root = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (!new Set(["http:", "https:"]).has(root.protocol) || root.username || root.password) {
    throw new Error("Xero Trial Balance base URL must be an HTTP(S) URL without credentials.");
  }
  const url = new URL("Reports/TrialBalance", root);
  if (date) url.searchParams.set("date", date);
  url.searchParams.set("paymentsOnly", "false");
  return url;
}

function strictContentLength(response: IncomingMessage): number | undefined {
  const value = response.headers["content-length"];
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new ResponseBoundaryError("INVALID_CONTENT_LENGTH");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ResponseBoundaryError("INVALID_CONTENT_LENGTH");
  return parsed;
}

function contentDecoder(response: IncomingMessage): PassThrough | Transform {
  const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return new PassThrough();
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new ResponseBoundaryError("UNSUPPORTED_CONTENT_ENCODING");
}

function safeTransportError(
  reason: XeroTrialBalanceTransportFailureReason,
  options: { limit?: number; upstreamStatus?: number } = {},
): AppError {
  const retryable = reason === "UPSTREAM_DEADLINE_EXCEEDED" ||
    reason === "UPSTREAM_NETWORK_ERROR" ||
    (reason === "UPSTREAM_HTTP_ERROR" && (options.upstreamStatus === 429 || (options.upstreamStatus ?? 0) >= 500));
  return new AppError("PROVIDER_ERROR", "The Xero Trial Balance response could not be accepted safely.", {
    httpStatus: 502,
    retryable,
    details: {
      reason,
      ...(options.limit === undefined ? {} : { limitBytes: options.limit }),
      ...(options.upstreamStatus === undefined ? {} : { upstreamStatus: options.upstreamStatus }),
    },
  });
}

function parseBoundedReport(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw safeTransportError("INVALID_JSON_RESPONSE");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw safeTransportError("INVALID_REPORT_RESPONSE");
  }
  const report = ObjectSerializer.deserialize(parsed, "ReportWithRows") as unknown;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw safeTransportError("INVALID_REPORT_RESPONSE");
  }
  return report as Record<string, unknown>;
}

/**
 * Dedicated streaming transport for the one SDK endpoint whose response must
 * be bounded before axios decompresses and deserializes it. The production URL
 * is fixed; baseUrl is injectable only so the same boundary can be exercised
 * against a real local HTTP server in tests.
 */
export class NodeXeroTrialBalanceTransport implements XeroTrialBalanceTransport {
  readonly #baseUrl: string;
  readonly #deadlineMs: number;
  readonly #maxRawResponseBytes: number;
  readonly #maxDecompressedResponseBytes: number;

  constructor(options: NodeXeroTrialBalanceTransportOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "https://api.xero.com/api.xro/2.0/";
    this.#deadlineMs = positiveInteger(
      options.deadlineMs ?? XERO_TRIAL_BALANCE_REQUEST_DEADLINE_MS,
      "deadlineMs",
    );
    this.#maxRawResponseBytes = positiveInteger(
      options.maxRawResponseBytes ?? XERO_TRIAL_BALANCE_MAX_RAW_RESPONSE_BYTES,
      "maxRawResponseBytes",
    );
    this.#maxDecompressedResponseBytes = positiveInteger(
      options.maxDecompressedResponseBytes ?? XERO_TRIAL_BALANCE_MAX_DECOMPRESSED_RESPONSE_BYTES,
      "maxDecompressedResponseBytes",
    );
    requestUrl(this.#baseUrl);
  }

  async getTrialBalance(input: XeroTrialBalanceTransportInput): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let response: IncomingMessage | undefined;
    let abortSource: "DEADLINE" | "CALLER" | undefined;
    const deadline = setTimeout(() => {
      if (controller.signal.aborted) return;
      abortSource = "DEADLINE";
      controller.abort();
    }, this.#deadlineMs);
    deadline.unref();
    const cancelFromCaller = () => {
      if (controller.signal.aborted) return;
      abortSource = "CALLER";
      controller.abort();
    };
    if (input.signal?.aborted) cancelFromCaller();
    else input.signal?.addEventListener("abort", cancelFromCaller, { once: true });

    try {
      response = await this.#openResponse(requestUrl(this.#baseUrl, input.date), input, controller.signal);
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 299) {
        response.destroy();
        throw safeTransportError("UPSTREAM_HTTP_ERROR", { upstreamStatus: status });
      }
      const contentType = response.headers["content-type"];
      if (contentType && !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(contentType)) {
        response.destroy();
        throw safeTransportError("INVALID_REPORT_RESPONSE");
      }
      const announcedLength = strictContentLength(response);
      if (announcedLength !== undefined && announcedLength > this.#maxRawResponseBytes) {
        response.destroy();
        throw safeTransportError("RAW_RESPONSE_TOO_LARGE", { limit: this.#maxRawResponseBytes });
      }

      const chunks: Buffer[] = [];
      const collector = new Writable({
        write(chunk: Buffer | string, encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
          callback();
        },
      });
      await pipeline(
        response,
        new ByteLimitTransform(this.#maxRawResponseBytes, "RAW_RESPONSE_TOO_LARGE"),
        contentDecoder(response),
        new ByteLimitTransform(this.#maxDecompressedResponseBytes, "DECOMPRESSED_RESPONSE_TOO_LARGE"),
        collector,
        { signal: controller.signal },
      );
      return parseBoundedReport(Buffer.concat(chunks));
    } catch (error) {
      if (response && !response.complete) response.destroy();
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) {
        throw safeTransportError(abortSource === "DEADLINE"
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_REQUEST_CANCELLED");
      }
      if (error instanceof ResponseBoundaryError) {
        throw safeTransportError(error.reason, error.limit === undefined ? {} : { limit: error.limit });
      }
      throw safeTransportError("UPSTREAM_NETWORK_ERROR");
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  #openResponse(
    url: URL,
    input: XeroTrialBalanceTransportInput,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const onResponse = (response: IncomingMessage) => resolve(response);
      const options = {
        method: "GET",
        signal,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate, br",
          Authorization: `Bearer ${input.accessToken}`,
          "xero-tenant-id": input.tenantId,
          "User-Agent": "zcloak-xero-accounting-mcp/limited-trial-balance-transport",
        },
      };
      const request = url.protocol === "https:"
        ? requestHttps(url, options, onResponse)
        : requestHttp(url, options, onResponse);
      request.once("error", reject);
      request.end();
    });
  }
}
