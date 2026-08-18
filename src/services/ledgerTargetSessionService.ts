import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import type { LedgerTargetSession } from "../domain/models.js";
import { AppError } from "../errors.js";
import {
  requireOAuthBoundRequestContext,
  type RequestContext,
} from "../security/requestContext.js";
import { hashObject } from "../security/hash.js";
import { safeLedgerTargetReference } from "../security/ledgerTargetReference.js";

const DEFAULT_TARGET_SESSION_TTL_MS = 30 * 60_000;
const TARGET_SESSION_PATTERN = /^xts_[A-Za-z0-9_-]{43}$/u;

export interface IssuedLedgerTargetSession {
  target_session_ref: string;
  target_ref_safe: string;
  binding_revision: number;
  organisation_name: string;
  expires_at: string;
}

export class LedgerTargetSessionService {
  readonly required: boolean;
  readonly #repository: AccountingRepository;
  readonly #secret: Buffer;
  readonly #clock: () => Date;
  readonly #referenceFactory: () => string;
  readonly #sessionIdFactory: () => string;
  readonly #ttlMs: number;

  constructor(options: {
    repository: AccountingRepository;
    secret: Buffer;
    required?: boolean;
    ttlMs?: number;
    clock?: () => Date;
    referenceFactory?: () => string;
    sessionIdFactory?: () => string;
  }) {
    if (options.secret.length < 32) throw new Error("Ledger target session secret must be at least 32 bytes.");
    const ttlMs = options.ttlMs ?? DEFAULT_TARGET_SESSION_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 4 * 60 * 60_000) {
      throw new Error("Ledger target session TTL must be between one minute and four hours.");
    }
    this.required = options.required ?? false;
    this.#repository = options.repository;
    this.#secret = Buffer.from(options.secret);
    this.#clock = options.clock ?? (() => new Date());
    this.#referenceFactory = options.referenceFactory ?? (() => `xts_${randomBytes(32).toString("base64url")}`);
    this.#sessionIdFactory = options.sessionIdFactory ?? (() => `target_${randomUUID()}`);
    this.#ttlMs = ttlMs;
  }

  async issue(context: RequestContext): Promise<IssuedLedgerTargetSession> {
    const principal = requireOAuthBoundRequestContext(context);
    const binding = await this.#repository.resolveAgentConnectionBinding({
      installationId: principal.oauthInstallationId,
      bindingId: principal.bindingId,
      workspaceId: principal.workspaceId,
      subjectType: principal.subjectType,
      subjectId: principal.subjectId,
      agentId: principal.agentId,
      connectionId: principal.connectionId,
    });
    if (!binding || binding.bindingRevision !== principal.bindingRevision) {
      throw new AppError("CONFLICT", "The current Xero organisation changed before it could be pinned.", {
        httpStatus: 409,
      });
    }

    const targetSessionRef = this.#referenceFactory();
    if (!TARGET_SESSION_PATTERN.test(targetSessionRef)) {
      throw new Error("Ledger target session reference factory returned an invalid capability.");
    }
    const now = this.#now();
    const session: LedgerTargetSession = {
      sessionId: this.#sessionIdFactory(),
      sessionHash: this.#hash(targetSessionRef),
      installationId: binding.installationId,
      bindingId: binding.bindingId,
      connectionId: binding.connectionId,
      bindingRevision: binding.bindingRevision,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlMs),
    };
    await this.#repository.saveLedgerTargetSession(session);
    const targetRefSafe = safeLedgerTargetReference(session.sessionId);
    await this.#repository.appendGovernanceAuditEvent({
      eventId: `event_${randomUUID()}`,
      streamId: `installation:${binding.installationId}`,
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.ledger_target_session.issued",
      source: "MCP",
      action: "xero.ledger_target_session.issue",
      actorId: principal.actorId,
      workspaceId: binding.workspaceId,
      agentId: binding.agentId,
      installationId: binding.installationId,
      bindingId: binding.bindingId,
      connectionId: binding.connectionId,
      tenantId: binding.tenantId,
      policyId: binding.policyId,
      correlationId: `target-session:${session.sessionId}`,
      disposition: "OBSERVE",
      outcome: "SUCCEEDED",
      inputHash: hashObject({
        installationId: binding.installationId,
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        bindingRevision: binding.bindingRevision,
      }),
      outputHash: hashObject({
        targetRefSafe,
        bindingRevision: binding.bindingRevision,
        expiresAt: session.expiresAt.toISOString(),
      }),
      evidence: {
        targetSessionRefSafe: targetRefSafe,
        bindingRevision: binding.bindingRevision,
        expiresAt: session.expiresAt.toISOString(),
        rawCapabilityPersisted: false,
      },
      occurredAt: now,
    });
    return {
      target_session_ref: targetSessionRef,
      target_ref_safe: targetRefSafe,
      binding_revision: session.bindingRevision,
      organisation_name: binding.tenantName,
      expires_at: session.expiresAt.toISOString(),
    };
  }

  async resolve(context: RequestContext, targetSessionRef: string | undefined): Promise<RequestContext> {
    if (context.legacyDemo) {
      if (this.required) {
        throw new AppError("TARGET_SESSION_REQUIRED", "Ledger target sessions require an isolated MCP OAuth installation.", {
          httpStatus: 403,
          details: {
            failureLayer: "TARGET_BINDING",
            reasonCodes: ["OAUTH_INSTALLATION_REQUIRED_FOR_TARGET"],
            recoveryAction: "REAUTHENTICATE_MCP",
            providerMutationPossible: false,
          },
        });
      }
      return context;
    }
    const principal = requireOAuthBoundRequestContext(context);
    if (!targetSessionRef) {
      if (this.required) {
        throw new AppError(
          "TARGET_SESSION_REQUIRED",
          "Pin the current Xero organisation first and pass its target_session_ref to this ledger tool.",
          {
            httpStatus: 403,
            details: {
              failureLayer: "TARGET_BINDING",
              reasonCodes: ["TARGET_SESSION_REQUIRED"],
              recoveryAction: "PIN_LEDGER_TARGET",
              providerMutationPossible: false,
            },
          },
        );
      }
      return context;
    }
    if (!TARGET_SESSION_PATTERN.test(targetSessionRef)) {
      throw new AppError("TARGET_SESSION_INVALID", "The Xero ledger target session is invalid.", {
        httpStatus: 403,
        details: {
          failureLayer: "TARGET_BINDING",
          reasonCodes: ["TARGET_SESSION_REFERENCE_INVALID"],
          recoveryAction: "PIN_LEDGER_TARGET",
          providerMutationPossible: false,
        },
      });
    }
    const now = this.#now();
    const resolved = await this.#repository.resolveLedgerTargetSession({
      sessionHash: this.#hash(targetSessionRef),
      installationId: principal.oauthInstallationId,
      workspaceId: principal.workspaceId,
      subjectType: principal.subjectType,
      subjectId: principal.subjectId,
      agentId: principal.agentId,
      now,
    });
    if (!resolved) {
      throw new AppError(
        "TARGET_SESSION_INVALID",
        "The Xero ledger target session is expired, revoked, or belongs to another MCP installation.",
        {
          httpStatus: 403,
          details: {
            failureLayer: "TARGET_BINDING",
            reasonCodes: ["TARGET_SESSION_EXPIRED_REVOKED_OR_WRONG_INSTALLATION"],
            recoveryAction: "PIN_LEDGER_TARGET",
            providerMutationPossible: false,
          },
        },
      );
    }
    return Object.freeze({
      ...context,
      bindingId: resolved.binding.bindingId,
      connectionId: resolved.binding.connectionId,
      bindingRevision: resolved.session.bindingRevision,
      targetSessionId: resolved.session.sessionId,
      targetSessionHash: resolved.session.sessionHash,
      targetSessionExpiresAt: new Date(resolved.session.expiresAt),
    });
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Ledger target session clock returned an invalid date.");
    return new Date(now);
  }

  #hash(reference: string): string {
    return createHmac("sha256", this.#secret)
      .update("xero-ledger-target-session\0", "utf8")
      .update(reference, "utf8")
      .digest("hex");
  }

}
