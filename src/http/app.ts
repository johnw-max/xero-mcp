import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_OAUTH_SCOPES, type AppConfig } from "../config.js";
import type { AccountingRepository, RepositoryReadinessEvidence } from "../db/repository.js";
import {
  isActiveAccountingCaseRecoveryProjectionEvidence,
  unknownActiveAccountingCaseRecoveryProjectionEvidence,
} from "../db/accountingCaseRecoveryProjectionReadiness.js";
import { AppError, toSafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { createAccountingMcpServer } from "../mcp/createServer.js";
import { TOOL_ALLOWLIST } from "../mcp/toolNames.js";
import type { XeroOAuthService } from "../oauth/xeroOAuthService.js";
import { createMcpOAuthRouter } from "../oauth/mcpOAuthRouter.js";
import {
  classifyBrokerBrowserOrigin,
  classifyBrokerFetchMetadata,
  type McpOAuthBrokerProvider,
} from "../oauth/mcpOAuthBrokerProvider.js";
import {
  renderOrganisationSwitchPage,
  renderOrganisationSwitchResultPage,
} from "../oauth/brokerPages.js";
import { hashObject, safeEqual } from "../security/hash.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContextFromAuthInfo,
  type RequestContext,
} from "../security/requestContext.js";
import type { AccountingService } from "../services/accountingService.js";
import type { ConnectionTicketService } from "../services/connectionTicketService.js";
import type { OrganisationSwitchService } from "../services/organisationSwitchService.js";
import type { LedgerTargetSessionService } from "../services/ledgerTargetSessionService.js";
import type { XeroAccountingCaseService } from "../services/xeroAccountingCaseService.js";
import type { ReviewAction, ReviewService } from "../services/reviewService.js";
import type { SupplierBillSnapshot } from "../providers/types.js";
import {
  ledgerFirmGovernanceReadinessEvidence,
} from "../domain/ledgerAuthority.js";
import {
  createXeroRuntimeAttestation,
  XERO_RELEASE_ATTESTATION,
  XERO_RELEASE_VERSION,
  xeroBuildIdentityHash,
  type XeroRuntimeWriteMode,
} from "../xeroRelease.js";

const OAUTH_COOKIE = "zc_xero_oauth_session";
const REVIEW_COOKIE = "zc_review_session";

function runtimeWriteMode(enabled: boolean): XeroRuntimeWriteMode {
  return enabled ? "WRITE_ENABLED" : "READ_ONLY";
}

function expectedAuthorityIdentityProven(
  config: AppConfig,
  evidence: RepositoryReadinessEvidence,
): boolean {
  const expectedSnapshot = config.xeroExpectedAuthoritySnapshotSha256;
  const expectedGovernance = config.xeroExpectedFirmGovernanceAggregateSha256;
  if (expectedSnapshot === undefined || expectedGovernance === undefined) {
    return config.nodeEnv !== "production";
  }
  if (evidence.authoritySnapshotHash !== expectedSnapshot) return false;
  return expectedGovernance === "NOT_REQUIRED"
    ? evidence.firmGovernance.status === "NOT_REQUIRED" &&
      evidence.firmGovernance.authorityAggregateHash === null
    : evidence.firmGovernance.status === "CURRENT" &&
      evidence.firmGovernance.authorityAggregateHash === expectedGovernance;
}

function unknownReadinessEvidence(requiredMigration: string): RepositoryReadinessEvidence {
  return {
    ready: false,
    storageMode: "UNKNOWN",
    requiredMigration,
    requiredMigrationStatus: "UNKNOWN",
    migrationHead: null,
    activeAccountingCaseRecoveryProjection:
      unknownActiveAccountingCaseRecoveryProjectionEvidence(),
    authoritySnapshotRevision: null,
    authoritySnapshotHash: null,
    authorityWriteKillSwitchEnabled: null,
    firmGovernance: ledgerFirmGovernanceReadinessEvidence(undefined, new Date(Number.NaN)),
  };
}

async function repositoryReadinessEvidence(
  repository: AccountingRepository,
  requiredMigration: string,
): Promise<RepositoryReadinessEvidence> {
  if (!repository.readinessEvidence) return unknownReadinessEvidence(requiredMigration);
  try {
    const evidence = await repository.readinessEvidence(requiredMigration);
    if (
      evidence.requiredMigration !== requiredMigration ||
      !isActiveAccountingCaseRecoveryProjectionEvidence(
        evidence.activeAccountingCaseRecoveryProjection,
      ) ||
      !evidence.firmGovernance ||
      !["CURRENT", "NOT_REQUIRED", "MISSING_OR_INVALID", "EXPIRED", "UNKNOWN"]
        .includes(evidence.firmGovernance.status) ||
      ((evidence.authoritySnapshotRevision === null) !== (evidence.authoritySnapshotHash === null)) ||
      (evidence.authoritySnapshotRevision !== null &&
        (!Number.isSafeInteger(evidence.authoritySnapshotRevision) || evidence.authoritySnapshotRevision < 1 ||
          typeof evidence.authoritySnapshotHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(evidence.authoritySnapshotHash) ||
          typeof evidence.authorityWriteKillSwitchEnabled !== "boolean"))
    ) return unknownReadinessEvidence(requiredMigration);
    return evidence;
  } catch {
    return unknownReadinessEvidence(requiredMigration);
  }
}

export function reviewCookieOptions(config: Pick<AppConfig, "nodeEnv">, expires: Date) {
  return {
    httpOnly: true as const,
    secure: config.nodeEnv === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

export function safeLogPath(request: Pick<Request, "path" | "originalUrl">): string {
  return request.path.startsWith("/connect/xero") ? "/connect/xero" : request.path;
}

export function rejectReviewWithAudit(options: {
  accountingService: AccountingService;
  reviewService: ReviewService;
  actorId: string;
  sessionHash: string;
  csrfToken: string;
  postingRequestId: string;
}) {
  return options.accountingService.withAudit({
    actorId: options.actorId,
    toolName: "review_reject_supplier_bill",
    input: { postingRequestId: options.postingRequestId },
    action: () => options.reviewService.reject({
      postingRequestId: options.postingRequestId,
      actorId: options.actorId,
      sessionHash: options.sessionHash,
      csrfToken: options.csrfToken,
    }),
    recordId: (value) => value.postingRequestId,
  });
}

function parseCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function bearerFrom(request: Request): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length);
}

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

/**
 * The HTTP edge authenticates the token, while each MCP tool enforces its own
 * exact capability. Requiring one fixed scope here would make the other
 * documented capability unusable (for example, a draft-write-only token).
 */
export function requireAnyVerifiedMcpScope(options: {
  supportedScopes: readonly string[];
  resourceMetadataUrl: string;
}) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.auth) {
      next(new AppError("AUTH_REQUIRED", "A verified OAuth access token is required.", {
        httpStatus: 401,
      }));
      return;
    }
    if (options.supportedScopes.some((scope) => request.auth?.scopes.includes(scope))) {
      next();
      return;
    }
    response.set(
      "WWW-Authenticate",
      `Bearer error="insufficient_scope", error_description="At least one supported Xero MCP scope is required", resource_metadata="${options.resourceMetadataUrl}"`,
    );
    response.status(403).json({
      error: "insufficient_scope",
      error_description: "At least one supported Xero MCP scope is required.",
    });
  };
}

const CORS_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "MCP-Protocol-Version",
  "Mcp-Session-Id",
  "Last-Event-ID",
] as const;
const CORS_REQUEST_HEADER_SET = new Set(CORS_REQUEST_HEADERS.map((header) => header.toLowerCase()));

function corsMethodsForPath(path: string): readonly string[] | undefined {
  if (
    path === "/healthz" ||
    path === "/readyz" ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return ["GET", "HEAD"];
  }
  if (path === "/mcp") return ["GET", "HEAD", "POST", "DELETE"];
  return undefined;
}

function requestedCorsHeadersAllowed(value: string | undefined): boolean {
  if (!value) return true;
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
    .every((header) => CORS_REQUEST_HEADER_SET.has(header));
}

function rejectCors(response: Response, message: string): void {
  response.status(403).json({ error: { code: "FORBIDDEN", message } });
}

/**
 * Browser CORS is deliberately limited to the MCP/OAuth machine endpoints.
 * Human review mutations keep their separate same-origin + CSRF boundary.
 */
export function createExactOriginCors(config: Pick<AppConfig, "allowedOrigins">) {
  return (request: Request, response: Response, next: NextFunction) => {
    const allowedMethods = corsMethodsForPath(request.path);
    if (!allowedMethods) {
      next();
      return;
    }

    response.vary("Origin");
    if (request.method === "OPTIONS") {
      response.vary("Access-Control-Request-Method");
      response.vary("Access-Control-Request-Headers");
    }
    const origin = request.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (origin === "*" || !config.allowedOrigins.includes(origin)) {
      rejectCors(response, "Forbidden Origin");
      return;
    }

    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Retry-After");

    if (request.method !== "OPTIONS") {
      if (!allowedMethods.includes(request.method)) {
        rejectCors(response, "Forbidden CORS method");
        return;
      }
      next();
      return;
    }

    const requestedMethod = request.headers["access-control-request-method"]?.toUpperCase();
    if (!requestedMethod || !allowedMethods.includes(requestedMethod)) {
      rejectCors(response, "Forbidden CORS preflight method");
      return;
    }
    if (!requestedCorsHeadersAllowed(request.headers["access-control-request-headers"])) {
      rejectCors(response, "Forbidden CORS request header");
      return;
    }

    response.setHeader("Access-Control-Allow-Methods", allowedMethods.join(", "));
    response.setHeader("Access-Control-Allow-Headers", CORS_REQUEST_HEADERS.join(", "));
    response.setHeader("Access-Control-Max-Age", "600");
    response.status(204).end();
  };
}

export function requireLegacySharedBearer(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    const supplied = bearerFrom(request);
    if (!supplied || !safeEqual(supplied, config.mcpBearerToken)) {
      jsonRpcError(response, 401, "Unauthorized");
      return;
    }
    response.locals.requestContext = createLegacySharedBearerRequestContext({
      actorId: config.demoActorId,
      audience: `${config.publicBaseUrl}/mcp`,
    });
    next();
  };
}

export function isReviewOriginAllowed(config: Pick<AppConfig, "publicBaseUrl">, origin: string | undefined): boolean {
  const status = classifyBrokerBrowserOrigin(origin, config.publicBaseUrl);
  return status === "EXACT" || status === "CANONICAL_EQUIVALENT";
}

function requireReviewOrigin(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!isReviewOriginAllowed(config, request.headers.origin)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "Review POST must be same-origin." } });
      return;
    }
    next();
  };
}

export function isOrganisationSwitchOriginAllowed(
  config: { publicBaseUrl: string; personalPocOnly: boolean },
  origin: string | undefined,
  fetchMetadata: {
    site?: string | string[] | undefined;
    mode?: string | string[] | undefined;
    destination?: string | string[] | undefined;
    user?: string | string[] | undefined;
  },
): boolean {
  const originStatus = classifyBrokerBrowserOrigin(origin, config.publicBaseUrl);
  if (originStatus === "EXACT" || originStatus === "CANONICAL_EQUIVALENT") return true;
  if (originStatus !== "NULL" || !config.personalPocOnly) return false;
  return classifyBrokerFetchMetadata(fetchMetadata) !== "MISMATCH";
}

function requireOrganisationSwitchOrigin(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction) => {
    const allowed = isOrganisationSwitchOriginAllowed(
      {
        publicBaseUrl: config.publicBaseUrl,
        personalPocOnly: config.mcpOAuthBroker?.enabled === true && config.mcpOAuthBroker.personalPocOnly,
      },
      request.headers.origin,
      {
        site: request.headers["sec-fetch-site"],
        mode: request.headers["sec-fetch-mode"],
        destination: request.headers["sec-fetch-dest"],
        user: request.headers["sec-fetch-user"],
      },
    );
    if (!allowed) {
      response.status(403).json({
        error: { code: "FORBIDDEN", message: "Organisation switch POST must be same-origin." },
      });
      return;
    }
    next();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isSupplierBillSnapshot(value: unknown): value is SupplierBillSnapshot {
  if (!isRecord(value) || !isRecord(value.contact) || !Array.isArray(value.lines)) return false;
  return value.type === "ACCPAY" &&
    typeof value.tenantId === "string" &&
    typeof value.invoiceId === "string" &&
    typeof value.status === "string" &&
    typeof value.contact.contactId === "string" &&
    isOptionalString(value.contact.name) &&
    isOptionalString(value.invoiceDate) &&
    isOptionalString(value.dueDate) &&
    isOptionalString(value.currency) &&
    isOptionalString(value.reference) &&
    isOptionalString(value.lineAmountType) &&
    isOptionalString(value.subTotal) &&
    isOptionalString(value.totalTax) &&
    isOptionalString(value.total) &&
    value.lines.every((line) => isRecord(line) &&
      typeof line.description === "string" &&
      typeof line.quantity === "string" &&
      typeof line.unitAmount === "string" &&
      typeof line.accountCode === "string" &&
      typeof line.taxType === "string" &&
      isOptionalString(line.lineAmount));
}

function guidanceForReview(action: ReviewAction, workflowState: string): string {
  if (action === "VIEW_VERIFIED_RESULT") {
    return "This bill is already AUTHORISED and exact readback was verified. Continue to the stored result without another Xero call.";
  }
  if (action === "RECOVER_AUTHORISE") {
    return "A prior legacy authorisation attempt may have reached Xero. Browser authorisation is disabled; inspect the same InvoiceID directly in Xero.";
  }
  if (action === "RESUME_AUTHORISE") {
    return "A legacy approval is stored, but browser authorisation is disabled. Continue through the governed Accounting Case flow or Xero itself.";
  }
  if (action === "APPROVE_OR_REJECT") {
    return "Legacy browser approval is disabled. You may reject this pending request; any new ledger write must use the governed Accounting Case flow.";
  }
  if (workflowState === "REJECTED") return "This request was rejected. No further posting action is available.";
  if (workflowState === "WRITE_RESULT_UNKNOWN") {
    return "The draft write result is unresolved or has no complete human-authorisation binding. Automatic posting is blocked pending manual investigation.";
  }
  if (workflowState === "READBACK_MISMATCH") {
    return "The stored Xero readback does not match the expected bill. Automatic posting is blocked pending manual investigation.";
  }
  if (workflowState === "BLOCKED_VALIDATION") {
    return "This request is blocked by validation and cannot be approved.";
  }
  if (workflowState === "VALIDATED") {
    return "Draft creation has not been verified, so this request cannot be approved.";
  }
  return "This request has no safe Review action in its current state.";
}

export function renderReviewPage(options: {
  postingRequestId: string;
  csrfToken?: string;
  review: Record<string, unknown>;
}): string {
  const actionBase = `/review/${encodeURIComponent(options.postingRequestId)}`;
  const csrf = options.csrfToken ? escapeHtml(options.csrfToken) : undefined;
  const bill = isSupplierBillSnapshot(options.review.bill) ? options.review.bill : undefined;
  const workflowState = String(options.review.state ?? "");
  const action = [
    "APPROVE_OR_REJECT",
    "RESUME_AUTHORISE",
    "RECOVER_AUTHORISE",
    "VIEW_VERIFIED_RESULT",
    "NONE",
  ].includes(String(options.review.action))
    ? options.review.action as ReviewAction
    : "NONE";
  const tenantName = typeof options.review.tenantName === "string" ? options.review.tenantName : "Name unavailable";
  const tenantId = typeof options.review.tenantId === "string" ? options.review.tenantId : "Unavailable";
  const invoiceId = typeof options.review.invoiceId === "string" ? options.review.invoiceId : "Unavailable";
  const sourceEvidenceType = typeof options.review.sourceEvidenceType === "string"
    ? options.review.sourceEvidenceType
    : "LEGACY_UNVERIFIED";
  const guidance = guidanceForReview(action, workflowState);
  const rejectForm = action === "APPROVE_OR_REJECT" && csrf
    ? `<form method="post" action="${actionBase}/reject"><input type="hidden" name="csrf_token" value="${csrf}"><button type="submit">Reject</button></form>`
    : "";
  const actionArea = rejectForm || `<p data-review-action="none"><strong>No browser write action is available.</strong></p>`;
  const billDetails = bill ? (() => {
    const supplier = bill.contact.name ?? bill.contact.contactId;
    const rows = bill.lines.map((line) => `<tr>
<td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unitAmount)}</td>
<td>${escapeHtml(line.accountCode)}</td><td>${escapeHtml(line.taxType)}</td><td>${escapeHtml(line.lineAmount ?? "-")}</td>
</tr>`).join("\n");
    return `<dl><dt>Supplier</dt><dd>${escapeHtml(supplier)}</dd><dt>Invoice date</dt><dd>${escapeHtml(bill.invoiceDate ?? "-")}</dd>
<dt>Due date</dt><dd>${escapeHtml(bill.dueDate ?? "-")}</dd><dt>Reference</dt><dd>${escapeHtml(bill.reference ?? "-")}</dd>
<dt>Currency</dt><dd>${escapeHtml(bill.currency ?? "-")}</dd></dl>
<table><caption>Bill lines</caption><thead><tr><th>Description</th><th>Quantity</th><th>Unit amount</th><th>Account</th><th>Tax</th><th>Line amount</th></tr></thead><tbody>${rows}</tbody></table>
<dl><dt>Subtotal</dt><dd>${escapeHtml(bill.subTotal ?? "-")}</dd><dt>Tax</dt><dd>${escapeHtml(bill.totalTax ?? "-")}</dd><dt>Total</dt><dd><strong>${escapeHtml(bill.total ?? "-")}</strong></dd></dl>`;
  })() : `<p><strong>No verified Xero bill snapshot is available.</strong> Review actions remain blocked.</p>`;
  const xeroBillUrl = typeof options.review.xeroBillUrl === "string" ? options.review.xeroBillUrl : undefined;
  const xeroLink = xeroBillUrl
    ? `<p><a href="${escapeHtml(xeroBillUrl)}" rel="noopener noreferrer">View this bill in Xero</a></p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review Xero supplier bill</title></head><body>
<main><h1>Review Xero supplier bill</h1>
<p><strong>${bill ? `Stored Xero status: ${escapeHtml(bill.status)}` : `Workflow status: ${escapeHtml(workflowState || "UNKNOWN")}`}</strong>. ${escapeHtml(guidance)}</p>
<dl><dt>Xero organisation</dt><dd>${escapeHtml(tenantName)}</dd><dt>Tenant ID</dt><dd>${escapeHtml(tenantId)}</dd><dt>Xero Invoice ID</dt><dd>${escapeHtml(invoiceId)}</dd><dt>Source evidence</dt><dd>${escapeHtml(sourceEvidenceType)}</dd></dl>
${billDetails}
${xeroLink}
${actionArea}
<details><summary>Technical evidence</summary><pre>${escapeHtml(JSON.stringify({
    postingRequestId: options.review.postingRequestId,
    tenantId: options.review.tenantId,
    invoiceId: options.review.invoiceId,
    sourceRef: options.review.sourceRef,
    sourceSha256: options.review.sourceSha256,
    sourceEvidenceType: options.review.sourceEvidenceType,
    approvedPayloadHash: options.review.approvedPayloadHash,
  }, null, 2))}</pre></details>
</main></body></html>`;
}

export function renderResultPage(options: {
  title: string;
  message: string;
  postingRequestId: string;
  invoiceId?: string;
  status: string;
  tenantName?: string;
  tenantId?: string;
  reference?: string;
  currency?: string;
  total?: string;
  xeroBillUrl?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title></head>
<body><main><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p><dl><dt>Status</dt><dd>${escapeHtml(options.status)}</dd>
${options.tenantName ? `<dt>Xero organisation</dt><dd>${escapeHtml(options.tenantName)}</dd>` : ""}
${options.tenantId ? `<dt>Tenant ID</dt><dd>${escapeHtml(options.tenantId)}</dd>` : ""}
${options.invoiceId ? `<dt>Xero Invoice ID</dt><dd>${escapeHtml(options.invoiceId)}</dd>` : ""}
${options.reference ? `<dt>Reference</dt><dd>${escapeHtml(options.reference)}</dd>` : ""}
${options.currency ? `<dt>Currency</dt><dd>${escapeHtml(options.currency)}</dd>` : ""}
${options.total ? `<dt>Total</dt><dd>${escapeHtml(options.total)}</dd>` : ""}
<dt>Posting request</dt><dd>${escapeHtml(options.postingRequestId)}</dd></dl>
${options.xeroBillUrl ? `<p><a href="${escapeHtml(options.xeroBillUrl)}" rel="noopener noreferrer">View this bill in Xero</a></p>` : ""}
</main></body></html>`;
}

function renderConnectionPage(tenantName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Xero connected</title></head>
<body><main><h1>Xero connected</h1><p>Connected to <strong>${escapeHtml(tenantName)}</strong>. You can return to zCloak and continue the supplier-bill demo.</p></main></body></html>`;
}

function setPrivateHtmlHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

export async function beginTicketBoundXeroOAuth(options: {
  ticket: string;
  browserSession: string;
  connectionTickets: ConnectionTicketService;
  oauthService: XeroOAuthService;
}): Promise<{ consentUrl: string }> {
  const consumed = await options.connectionTickets.consume(options.ticket);
  const consentUrl = await options.oauthService.start(consumed.actorId, options.browserSession);
  return { consentUrl };
}

export async function completeTicketBoundXeroOAuth(options: {
  state: string;
  browserSession: string;
  queryString: string;
  oauthService: XeroOAuthService;
  reviewService: ReviewService;
}) {
  const connected = await options.oauthService.callback({
    state: options.state,
    browserSession: options.browserSession,
    queryString: options.queryString,
  });
  const reviewSession = await options.reviewService.createOperatorSession(connected.actorId);
  return { connected, reviewSession };
}

export function createHttpApp(options: {
  config: AppConfig;
  repository: AccountingRepository;
  accountingService: AccountingService;
  oauthService: XeroOAuthService;
  reviewService: ReviewService;
  connectionTickets: ConnectionTicketService;
  logger: Logger;
  mcpOAuthProvider?: McpOAuthBrokerProvider;
  organisationSwitchService?: OrganisationSwitchService;
  ledgerTargetSessionService?: LedgerTargetSessionService;
  accountingCaseService?: XeroAccountingCaseService;
}) {
  const {
    config,
    repository,
    accountingService,
    oauthService,
    reviewService,
    connectionTickets,
    logger,
    mcpOAuthProvider,
    organisationSwitchService,
    ledgerTargetSessionService,
    accountingCaseService,
  } = options;
  const brokerConfig = config.mcpOAuthBroker;
  if (brokerConfig?.enabled && !mcpOAuthProvider) {
    throw new Error("An enabled MCP OAuth Broker requires its provider at application startup.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(hostHeaderValidation([...new Set([...config.allowedHosts, "127.0.0.1", "localhost"])]));
  app.use((_, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(createExactOriginCors(config));
  app.use(express.json({ limit: config.requestBodyLimitBytes }));
  app.use(express.urlencoded({ extended: false, limit: config.requestBodyLimitBytes }));

  if (brokerConfig?.enabled && mcpOAuthProvider) {
    app.use(createMcpOAuthRouter({ config: brokerConfig, provider: mcpOAuthProvider }));
  }

  app.get("/healthz", async (_, response) => {
    const evidence = await repositoryReadinessEvidence(
      repository,
      XERO_RELEASE_ATTESTATION.requiredMigration,
    );
    const buildIdentity = config.xeroBuildIdentity;
    const firmGovernanceProven = evidence.firmGovernance.status === "CURRENT" ||
      evidence.firmGovernance.status === "NOT_REQUIRED";
    const authorityIdentityProven = expectedAuthorityIdentityProven(config, evidence);
    const writeMode = runtimeWriteMode(
      config.xeroWriteEnabled && evidence.authorityWriteKillSwitchEnabled === true && firmGovernanceProven &&
        authorityIdentityProven,
    );
    response.json({
      status: "ok",
      version: XERO_RELEASE_VERSION,
      writeMode,
      processWriteGateEnabled: config.xeroWriteEnabled,
      configuredAuthorityRevision: config.xeroAuthorityRevision,
      standingDelegationsConfigSha256: config.xeroStandingDelegationsConfigSha256 ?? null,
      authoritySnapshotRevision: evidence.authoritySnapshotRevision,
      authoritySnapshotHash: evidence.authoritySnapshotHash,
      authorityWriteKillSwitchEnabled: evidence.authorityWriteKillSwitchEnabled,
      firmGovernance: evidence.firmGovernance,
      buildIdentityHash: buildIdentity ? xeroBuildIdentityHash(buildIdentity) : null,
      acceptanceSourceSha256: buildIdentity?.acceptanceSourceSha256 ?? null,
      sourceArchiveSha256: buildIdentity?.sourceArchiveSha256 ?? null,
      approvedControlCatalogSha256: buildIdentity?.approvedControlCatalogSha256 ?? null,
      toolCount: TOOL_ALLOWLIST.length,
      toolsetHash: hashObject(TOOL_ALLOWLIST),
      attestation: XERO_RELEASE_ATTESTATION,
      attestationHash: hashObject(XERO_RELEASE_ATTESTATION),
    });
  });

  app.get("/readyz", async (_, response) => {
    const requiredMigration = XERO_RELEASE_ATTESTATION.requiredMigration;
    const buildIdentity = config.xeroBuildIdentity;
    const buildIdentityHash = buildIdentity ? xeroBuildIdentityHash(buildIdentity) : null;
    const evidence = await repositoryReadinessEvidence(repository, requiredMigration);
    const firmGovernanceRequired = config.xeroWriteEnabled &&
      evidence.authorityWriteKillSwitchEnabled === true;
    const firmGovernanceProven = !firmGovernanceRequired ||
      evidence.firmGovernance.status === "CURRENT" || evidence.firmGovernance.status === "NOT_REQUIRED";
    const authorityIdentityProven = expectedAuthorityIdentityProven(config, evidence);
    const writeMode = runtimeWriteMode(
      config.xeroWriteEnabled && evidence.authorityWriteKillSwitchEnabled === true && firmGovernanceProven &&
        authorityIdentityProven,
    );
    const runtimeAttestation = createXeroRuntimeAttestation({
      buildIdentityHash,
      acceptanceSourceSha256: buildIdentity?.acceptanceSourceSha256 ?? null,
      sourceArchiveSha256: buildIdentity?.sourceArchiveSha256 ?? null,
      approvedControlCatalogSha256: buildIdentity?.approvedControlCatalogSha256 ?? null,
      writeMode,
      processWriteGateEnabled: config.xeroWriteEnabled,
      configuredAuthorityRevision: config.xeroAuthorityRevision,
      standingDelegationsConfigSha256: config.xeroStandingDelegationsConfigSha256 ?? null,
      authoritySnapshotRevision: evidence.authoritySnapshotRevision,
      authoritySnapshotHash: evidence.authoritySnapshotHash,
      authorityWriteKillSwitchEnabled: evidence.authorityWriteKillSwitchEnabled,
      storageMode: evidence.storageMode,
      repositoryReady: evidence.ready,
      requiredMigration,
      requiredMigrationStatus: evidence.requiredMigrationStatus,
      migrationHead: evidence.migrationHead,
      activeAccountingCaseRecoveryProjection:
        evidence.activeAccountingCaseRecoveryProjection,
      firmGovernance: evidence.firmGovernance,
    });
    const migrationProven =
      (evidence.storageMode === "POSTGRES" && evidence.requiredMigrationStatus === "APPLIED" &&
        typeof evidence.migrationHead === "string" && evidence.migrationHead.length > 0) ||
      (evidence.storageMode === "IN_MEMORY" && evidence.requiredMigrationStatus === "NOT_APPLICABLE");
    const buildIdentityProven = config.nodeEnv !== "production" || buildIdentity !== undefined;
    const authorityConfigurationProven = config.nodeEnv !== "production" || (
      evidence.authoritySnapshotRevision === config.xeroAuthorityRevision &&
      typeof config.xeroStandingDelegationsConfigSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(config.xeroStandingDelegationsConfigSha256) && authorityIdentityProven
    );
    const ready = evidence.ready && migrationProven && evidence.authoritySnapshotRevision !== null &&
      evidence.authoritySnapshotHash !== null && buildIdentityProven && authorityConfigurationProven &&
      firmGovernanceProven;
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      version: XERO_RELEASE_VERSION,
      writeMode,
      processWriteGateEnabled: config.xeroWriteEnabled,
      configuredAuthorityRevision: config.xeroAuthorityRevision,
      standingDelegationsConfigSha256: config.xeroStandingDelegationsConfigSha256 ?? null,
      authoritySnapshotRevision: evidence.authoritySnapshotRevision,
      authoritySnapshotHash: evidence.authoritySnapshotHash,
      authorityWriteKillSwitchEnabled: evidence.authorityWriteKillSwitchEnabled,
      buildIdentityHash,
      acceptanceSourceSha256: buildIdentity?.acceptanceSourceSha256 ?? null,
      sourceArchiveSha256: buildIdentity?.sourceArchiveSha256 ?? null,
      approvedControlCatalogSha256: buildIdentity?.approvedControlCatalogSha256 ?? null,
      storageMode: evidence.storageMode,
      requiredMigration,
      requiredMigrationStatus: evidence.requiredMigrationStatus,
      migrationHead: evidence.migrationHead,
      activeAccountingCaseRecoveryProjection:
        evidence.activeAccountingCaseRecoveryProjection,
      firmGovernance: evidence.firmGovernance,
      toolsetHash: hashObject(TOOL_ALLOWLIST),
      attestationHash: hashObject(XERO_RELEASE_ATTESTATION),
      runtimeAttestation,
      runtimeAttestationHash: hashObject(runtimeAttestation),
    });
  });

  const reviewOrigin = requireReviewOrigin(config);
  const organisationSwitchOrigin = requireOrganisationSwitchOrigin(config);

  if (brokerConfig?.enabled && mcpOAuthProvider) {
    app.all(
      "/mcp",
      requireBearerAuth({
        verifier: mcpOAuthProvider,
        requiredScopes: [],
        resourceMetadataUrl: `${brokerConfig.issuer}/.well-known/oauth-protected-resource/mcp`,
      }),
      requireAnyVerifiedMcpScope({
        supportedScopes: MCP_OAUTH_SCOPES,
        resourceMetadataUrl: `${brokerConfig.issuer}/.well-known/oauth-protected-resource/mcp`,
      }),
      (request, response, next) => {
        try {
          if (!request.auth) {
            throw new AppError("AUTH_REQUIRED", "A verified OAuth access token is required.", {
              httpStatus: 401,
            });
          }
          response.locals.requestContext = createOAuthRequestContextFromAuthInfo({
            issuer: brokerConfig.issuer,
            expectedAudience: brokerConfig.resourceUri,
            authInfo: request.auth,
          });
          next();
        } catch (error) {
          next(error);
        }
      },
    );
  } else {
    app.all("/mcp", requireLegacySharedBearer(config));
  }
  app.post("/mcp", async (request, response) => {
    const server = createAccountingMcpServer(
      accountingService,
      response.locals.requestContext as RequestContext,
      organisationSwitchService,
      ledgerTargetSessionService,
      accountingCaseService,
    );
    const transport = new StreamableHTTPServerTransport();
    try {
      await server.connect(transport as unknown as Transport);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error("MCP request handling failed.", {
        method: request.method,
        path: safeLogPath(request),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      if (!response.headersSent) jsonRpcError(response, 500, "Internal server error");
    }
  });
  app.get("/mcp", (_, response) => jsonRpcError(response, 405, "Method not allowed"));
  app.delete("/mcp", (_, response) => jsonRpcError(response, 405, "Method not allowed"));

  if (brokerConfig?.enabled && mcpOAuthProvider) {
    app.get("/oauth/xero/callback", async (request, response) => {
      await mcpOAuthProvider.handleXeroCallback(request, response);
    });
    // Use the same neutral callback path for the first-party organisation
    // confirmation POST. Some Host browser profiles block top-level requests
    // whose path ends in `/select`, even after the request reaches the server,
    // and therefore discard the authorization-code redirect response.
    app.post("/oauth/xero/callback", async (request, response) => {
      await mcpOAuthProvider.handleOrganisationSelection(request, response);
    });
    // Compatibility for an already-rendered, short-lived selection page from
    // the previous release. New pages never emit this action.
    app.post("/oauth/xero/select", async (request, response) => {
      await mcpOAuthProvider.handleOrganisationSelection(request, response);
    });
  } else {
    app.get("/connect/xero", async (request, response) => {
    const ticket = request.query.ticket;
    if (typeof ticket !== "string") {
      throw new AppError("VALIDATION_FAILED", "Xero connect ticket is invalid.", { httpStatus: 400 });
    }
    const browserSession = randomBytes(32).toString("base64url");
    const { consentUrl } = await beginTicketBoundXeroOAuth({
      ticket,
      browserSession,
      connectionTickets,
      oauthService,
    });
    response.cookie(OAUTH_COOKIE, browserSession, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/oauth/xero",
      maxAge: 10 * 60_000,
    });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.redirect(302, consentUrl);
    });

    app.get("/oauth/xero/callback", async (request, response) => {
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    const browserSession = parseCookie(request, OAUTH_COOKIE);
    if (!state || !browserSession) {
      throw new AppError("FORBIDDEN", "OAuth callback is missing its state or browser session.", { httpStatus: 403 });
    }
    const queryString = request.originalUrl.includes("?") ? request.originalUrl.slice(request.originalUrl.indexOf("?") + 1) : "";
    const { connected, reviewSession } = await completeTicketBoundXeroOAuth({
      state,
      browserSession,
      queryString,
      oauthService,
      reviewService,
    });
    response.clearCookie(OAUTH_COOKIE, { path: "/oauth/xero" });
    response.cookie(REVIEW_COOKIE, reviewSession.session, reviewCookieOptions(config, reviewSession.expiresAt));
    setPrivateHtmlHeaders(response);
    const payload = { status: "connected", tenant: { id: connected.tenantId, name: connected.tenantName }, scopes: connected.scopes };
    if (request.accepts(["html", "json"]) === "html") {
      response.type("html").send(renderConnectionPage(connected.tenantName));
      return;
    }
    response.json(payload);
    });
  }

  if (organisationSwitchService) {
    app.get("/xero/organisation-switch", async (request, response) => {
      const ticket = typeof request.query.ticket === "string" ? request.query.ticket : undefined;
      if (!ticket) {
        throw new AppError("VALIDATION_FAILED", "Organisation switch ticket is required.", { httpStatus: 400 });
      }
      const page = await organisationSwitchService.getPage(ticket);
      setPrivateHtmlHeaders(response);
      response.type("html").send(renderOrganisationSwitchPage({
        ticket,
        csrfToken: page.csrfToken,
        currentOrganisation: page.currentOrganisation,
        organisations: page.organisations,
        expiresAt: page.expiresAt,
      }));
    });

    app.post("/xero/organisation-switch", organisationSwitchOrigin, async (request, response) => {
      const ticket = typeof request.body?.ticket === "string" ? request.body.ticket : undefined;
      const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
      const selectedConnectionId = typeof request.body?.connection_id === "string"
        ? request.body.connection_id
        : undefined;
      if (!ticket || !csrfToken || !selectedConnectionId) {
        throw new AppError("VALIDATION_FAILED", "Organisation switch confirmation is incomplete.", {
          httpStatus: 400,
        });
      }
      const result = await organisationSwitchService.confirm({ ticket, csrfToken, selectedConnectionId });
      setPrivateHtmlHeaders(response);
      response.type("html").send(renderOrganisationSwitchResultPage({
        status: result.status,
        tenantName: result.currentOrganisation.tenantName,
      }));
    });
  }

  app.get("/review/:postingRequestId", async (request, response) => {
    const postingRequestId = request.params.postingRequestId;
    if (typeof postingRequestId !== "string") {
      throw new AppError("VALIDATION_FAILED", "Posting request identifier is invalid.", { httpStatus: 400 });
    }
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    if (!rawSession) throw new AppError("AUTH_REQUIRED", "Operator review session is required.", { httpStatus: 401 });
    const session = await reviewService.authenticate(rawSession);
    const review = await reviewService.getReview(postingRequestId, session.actorId, session.sessionHash);
    const view = {
      postingRequestId: review.posting.postingRequestId,
      state: review.posting.state,
      action: review.action,
      tenantId: review.posting.tenantId,
      ...(review.tenantName ? { tenantName: review.tenantName } : {}),
      ...(review.xeroBillUrl ? { xeroBillUrl: review.xeroBillUrl } : {}),
      sourceRef: review.posting.sourceRef,
      sourceSha256: review.posting.sourceSha256,
      sourceEvidenceType: review.posting.sourceEvidenceType,
      invoiceId: review.posting.xeroInvoiceId,
      approvedPayloadHash: review.posting.providerPayloadHash,
      bill: review.posting.readbackSnapshot,
      transition: "DRAFT -> AUTHORISED",
    };
    setPrivateHtmlHeaders(response);
    if (request.accepts(["html", "json"]) === "json") {
      response.json({ review: view, ...(review.csrfToken ? { csrfToken: review.csrfToken } : {}) });
      return;
    }
    response.type("html").send(renderReviewPage({
      postingRequestId: review.posting.postingRequestId,
      ...(review.csrfToken ? { csrfToken: review.csrfToken } : {}),
      review: view,
    }));
  });

  app.post("/review/:postingRequestId/reject", reviewOrigin, async (request, response) => {
    const postingRequestId = request.params.postingRequestId;
    if (typeof postingRequestId !== "string") {
      throw new AppError("VALIDATION_FAILED", "Posting request identifier is invalid.", { httpStatus: 400 });
    }
    const rawSession = parseCookie(request, REVIEW_COOKIE);
    if (!rawSession) throw new AppError("AUTH_REQUIRED", "Operator review session is required.", { httpStatus: 401 });
    const session = await reviewService.authenticate(rawSession);
    const csrfToken = typeof request.body?.csrf_token === "string" ? request.body.csrf_token : undefined;
    if (!csrfToken) throw new AppError("FORBIDDEN", "Review CSRF token is required.", { httpStatus: 403 });
    const result = await rejectReviewWithAudit({
      accountingService,
      reviewService,
      actorId: session.actorId,
      sessionHash: session.sessionHash,
      csrfToken,
      postingRequestId,
    });
    setPrivateHtmlHeaders(response);
    if (request.accepts(["html", "json"]) === "html") {
      response.type("html").send(renderResultPage({
        title: "Bill rejected",
        message: "Nothing was posted to the Xero ledger.",
        postingRequestId: result.postingRequestId,
        status: result.state,
      }));
      return;
    }
    response.json(result);
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const httpError = error && typeof error === "object"
      ? error as { status?: number; statusCode?: number; type?: string }
      : undefined;
    const bodyTooLarge = httpError?.status === 413 || httpError?.statusCode === 413 || httpError?.type === "entity.too.large";
    if (bodyTooLarge) {
      logger.warn("HTTP request body rejected as too large.", {
        method: request.method,
        path: safeLogPath(request),
        errorCode: "REQUEST_TOO_LARGE",
      });
      response.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "Request body is too large." } });
      return;
    }
    const invalidJson = (httpError?.status === 400 || httpError?.statusCode === 400) &&
      httpError?.type === "entity.parse.failed";
    if (invalidJson) {
      logger.warn("HTTP request body rejected as invalid JSON.", {
        method: request.method,
        path: safeLogPath(request),
        errorCode: "VALIDATION_FAILED",
      });
      response.status(400).json({
        error: { code: "VALIDATION_FAILED", message: "Request body is not valid JSON." },
      });
      return;
    }
    const safe = toSafeError(error);
    const resultStatus = typeof safe.details?.resultStatus === "string"
      ? safe.details.resultStatus
      : undefined;
    logger.warn("HTTP request rejected.", {
      method: request.method,
      path: safeLogPath(request),
      errorCode: safe.code,
      ...(resultStatus ? { resultStatus } : {}),
    });
    if (response.headersSent) return;
    response.status(safe.httpStatus).json({ error: { code: safe.code, message: safe.message } });
  });

  return app;
}
