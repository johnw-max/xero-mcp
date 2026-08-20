import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import type { AuthorizedProviderConnection, ResolvedAgentConnectionBinding } from "../domain/models.js";
import { AppError } from "../errors.js";
import {
  requireOAuthBoundRequestContext,
  type RequestContext,
} from "../security/requestContext.js";
import { hashObject } from "../security/hash.js";

const DEFAULT_SWITCH_TTL_MS = 10 * 60_000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export interface SafeOrganisationSummary {
  connectionId: string;
  tenantId: string;
  tenantName: string;
  current: boolean;
}

function summary(
  connection: Pick<AuthorizedProviderConnection, "connectionId" | "tenantId" | "tenantName">,
  currentConnectionId: string,
): SafeOrganisationSummary {
  return {
    connectionId: connection.connectionId,
    tenantId: connection.tenantId,
    tenantName: connection.tenantName,
    current: connection.connectionId === currentConnectionId,
  };
}

function bindingSummary(binding: ResolvedAgentConnectionBinding): SafeOrganisationSummary {
  return {
    connectionId: binding.connectionId,
    tenantId: binding.tenantId,
    tenantName: binding.tenantName,
    current: true,
  };
}

export class OrganisationSwitchService {
  readonly #repository: AccountingRepository;
  readonly #publicBaseUrl: string;
  readonly #secret: Buffer;
  readonly #clock: () => Date;
  readonly #ticketFactory: () => string;
  readonly #bindingIdFactory: () => string;
  readonly #ttlMs: number;

  constructor(options: {
    repository: AccountingRepository;
    publicBaseUrl: string;
    secret: Buffer;
    clock?: () => Date;
    ticketFactory?: () => string;
    bindingIdFactory?: () => string;
    ttlMs?: number;
  }) {
    const base = new URL(options.publicBaseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      throw new Error("Organisation switch links require a clean HTTPS public base URL.");
    }
    if (options.secret.length < 32) throw new Error("Organisation switch secret must be at least 32 bytes.");
    const ttlMs = options.ttlMs ?? DEFAULT_SWITCH_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) {
      throw new Error("Organisation switch TTL must be between one and fifteen minutes.");
    }
    this.#repository = options.repository;
    this.#publicBaseUrl = base.origin;
    this.#secret = Buffer.from(options.secret);
    this.#clock = options.clock ?? (() => new Date());
    this.#ticketFactory = options.ticketFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#bindingIdFactory = options.bindingIdFactory ?? (() => `binding_${randomUUID()}`);
    this.#ttlMs = ttlMs;
  }

  async start(context: RequestContext) {
    const principal = requireOAuthBoundRequestContext(context);
    const pinned = principal.targetSessionHash
      ? await this.#repository.resolveLedgerTargetSession({
          sessionHash: principal.targetSessionHash,
          installationId: principal.oauthInstallationId,
          workspaceId: principal.workspaceId,
          subjectType: principal.subjectType,
          subjectId: principal.subjectId,
          agentId: principal.agentId,
          now: this.#now(),
        })
      : undefined;
    const current = pinned?.binding ?? await this.#repository.resolveAgentConnectionBinding({
        installationId: principal.oauthInstallationId,
        bindingId: principal.bindingId,
        workspaceId: principal.workspaceId,
        subjectType: principal.subjectType,
        subjectId: principal.subjectId,
        agentId: principal.agentId,
        connectionId: principal.connectionId,
      });
    if (principal.targetSessionHash && (
      !pinned ||
      pinned.session.sessionId !== principal.targetSessionId ||
      pinned.session.bindingId !== principal.bindingId ||
      pinned.session.connectionId !== principal.connectionId ||
      pinned.session.bindingRevision !== principal.bindingRevision
    )) {
      throw new AppError("CONFLICT", "The pinned Xero organisation target is no longer active.", {
        httpStatus: 409,
      });
    }
    if (!current) {
      throw new AppError("CONFLICT", "The current Xero organisation binding is no longer active.", {
        httpStatus: 409,
      });
    }
    const ticket = this.#ticketFactory();
    if (!TICKET_PATTERN.test(ticket)) throw new Error("Organisation switch ticket factory returned an invalid secret.");
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + this.#ttlMs);
    const sessionHash = this.#hash("ticket", ticket);
    await this.#repository.saveOrganisationSwitchSession({
      sessionHash,
      installationId: current.installationId,
      workspaceId: current.workspaceId,
      subjectType: current.subjectType,
      subjectId: current.subjectId,
      agentId: current.agentId,
      authorizationId: current.authorizationId,
      sourceBindingId: current.bindingId,
      sourceConnectionId: current.connectionId,
      ...(principal.targetSessionHash ? { sourceTargetSessionHash: principal.targetSessionHash } : {}),
      createdAt,
      expiresAt,
    });
    await this.#repository.appendGovernanceAuditEvent({
      eventId: `event_${randomUUID()}`,
      streamId: `installation:${current.installationId}`,
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.requested",
      source: "MCP",
      action: "xero.organisation.switch",
      actorId: context.actorId,
      workspaceId: current.workspaceId,
      agentId: current.agentId,
      installationId: current.installationId,
      bindingId: current.bindingId,
      connectionId: current.connectionId,
      tenantId: current.tenantId,
      policyId: current.policyId,
      correlationId: `switch:${sessionHash}`,
      disposition: "ESCALATE",
      outcome: "PROPOSED",
      inputHash: hashObject({
        installationId: current.installationId,
        bindingId: current.bindingId,
        connectionId: current.connectionId,
      }),
      evidence: {
        confirmationMode: "MCP_HOSTED_ONE_TIME_LINK",
        expiresAt: expiresAt.toISOString(),
        providerMutation: false,
        sourceTargetPinned: Boolean(principal.targetSessionHash),
      },
      occurredAt: createdAt,
    });
    const url = new URL("/xero/organisation-switch", this.#publicBaseUrl);
    url.searchParams.set("ticket", ticket);
    return {
      status: "USER_CONFIRMATION_REQUIRED" as const,
      currentOrganisation: bindingSummary(current),
      switchUrl: url.href,
      expiresAt,
      message: "Open the secure link, choose one Xero organisation, and confirm. The Agent cannot switch ledgers from chat text alone.",
    };
  }

  async getPage(ticket: string) {
    this.#requireTicket(ticket);
    const context = await this.#repository.getOrganisationSwitchContext(
      this.#hash("ticket", ticket),
      this.#now(),
    );
    if (!context) {
      throw new AppError("CONFLICT", "This organisation switch link is invalid, expired, already used, or stale.", {
        httpStatus: 409,
      });
    }
    return {
      currentOrganisation: bindingSummary(context.currentBinding),
      organisations: context.connections.map((connection) =>
        summary(connection, context.currentBinding.connectionId)
      ),
      csrfToken: this.#csrf(ticket),
      expiresAt: new Date(context.session.expiresAt),
    };
  }

  async confirm(input: { ticket: string; csrfToken: string; selectedConnectionId: string }) {
    this.#requireTicket(input.ticket);
    if (!this.#safeEqual(input.csrfToken, this.#csrf(input.ticket))) {
      throw new AppError("FORBIDDEN", "Organisation switch confirmation is invalid.", { httpStatus: 403 });
    }
    if (
      typeof input.selectedConnectionId !== "string" ||
      input.selectedConnectionId.length === 0 ||
      input.selectedConnectionId !== input.selectedConnectionId.trim() ||
      input.selectedConnectionId.length > 200
    ) {
      throw new AppError("VALIDATION_FAILED", "The selected Xero organisation is invalid.", { httpStatus: 400 });
    }
    const sessionHash = this.#hash("ticket", input.ticket);
    const result = await this.#repository.completeOrganisationSwitch({
      sessionHash,
      selectedConnectionId: input.selectedConnectionId,
      newBindingId: this.#bindingIdFactory(),
      now: this.#now(),
    });
    if (!result) {
      throw new AppError("CONFLICT", "This organisation switch could not be completed safely.", { httpStatus: 409 });
    }
    await this.#repository.appendGovernanceAuditEvent({
      eventId: `event_${randomUUID()}`,
      streamId: `installation:${result.currentBinding.installationId}`,
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.completed",
      source: "USER_UI",
      action: "xero.organisation.switch",
      actorId: `${result.currentBinding.workspaceId}:${result.currentBinding.subjectType.toLowerCase()}:${result.currentBinding.subjectId}`,
      workspaceId: result.currentBinding.workspaceId,
      agentId: result.currentBinding.agentId,
      installationId: result.currentBinding.installationId,
      bindingId: result.currentBinding.bindingId,
      connectionId: result.currentBinding.connectionId,
      tenantId: result.currentBinding.tenantId,
      policyId: result.currentBinding.policyId,
      correlationId: `switch:${sessionHash}`,
      disposition: "AUTO_EXECUTE",
      outcome: "SUCCEEDED",
      inputHash: hashObject({
        selectedConnectionId: input.selectedConnectionId,
        sourceBindingId: result.previousBinding.bindingId,
      }),
      outputHash: hashObject({
        targetBindingId: result.currentBinding.bindingId,
        targetConnectionId: result.currentBinding.connectionId,
        changed: result.changed,
      }),
      evidence: {
        confirmationMode: "MCP_HOSTED_ONE_TIME_LINK",
        userConfirmed: true,
        selectionSource: "SERVER_AUTHORIZED_CONNECTION_LIST",
        providerMutation: false,
        previousTenantId: result.previousBinding.tenantId,
        sourceTargetRevoked: result.sourceTargetRevoked,
      },
      occurredAt: result.session.consumedAt ?? this.#now(),
    });
    return {
      status: result.changed ? "SWITCHED" as const : "UNCHANGED" as const,
      previousOrganisation: bindingSummary(result.previousBinding),
      currentOrganisation: bindingSummary(result.currentBinding),
      switchedAt: new Date(result.session.consumedAt ?? this.#now()),
      message: result.changed
        ? "The selected Xero organisation is active. The initiating ledger target was revoked; pin the organisation again before continuing."
        : result.sourceTargetRevoked
          ? "The selected organisation is unchanged, but the initiating ledger target was revoked; pin the organisation again before continuing."
          : "The Agent was already bound to the selected Xero organisation.",
    };
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Organisation switch clock returned an invalid date.");
    return new Date(now);
  }

  #hash(purpose: "ticket" | "csrf", value: string): string {
    return createHmac("sha256", this.#secret)
      .update(`xero-organisation-switch:${purpose}\0`, "utf8")
      .update(value, "utf8")
      .digest("hex");
  }

  #csrf(ticket: string): string {
    return createHmac("sha256", this.#secret)
      .update("xero-organisation-switch:csrf-token\0", "utf8")
      .update(ticket, "utf8")
      .digest("base64url");
  }

  #safeEqual(value: string, expected: string): boolean {
    if (typeof value !== "string") return false;
    const left = Buffer.from(value, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  #requireTicket(ticket: string): void {
    if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) {
      throw new AppError("VALIDATION_FAILED", "Organisation switch ticket is invalid.", { httpStatus: 400 });
    }
  }
}
