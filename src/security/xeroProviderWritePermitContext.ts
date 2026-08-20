import type { XeroAutonomousWriteAction } from "../policy/xeroAutonomousActions.js";
import type { AccountingPrincipal } from "../providers/types.js";
import type { XeroActionConnection } from "../providers/xeroClientManager.js";
import { AppError } from "../errors.js";
import { hashObject } from "./hash.js";
import {
  consumeXeroProviderWritePermit,
  type LedgerProviderWritePermit,
  type XeroProviderWritePermitClaims,
  type XeroProviderWriteAdapterOperation,
} from "./xeroProviderWritePermit.js";
import { requireOAuthBoundRequestContext } from "./requestContext.js";

const CONNECTION_CONTEXT_MISMATCH = "__CONNECTION_CONTEXT_MISMATCH__";
const MISSING_TARGET_SESSION = "__MISSING_TARGET_SESSION__";

/**
 * Consumes a provider permit against the trusted HTTP-edge identity and the
 * exact connection selected by XeroClientManager. The manager calls this
 * synchronously after all pure payload mapping/validation and connection
 * metadata resolution, but before client initialization, token decrypt,
 * refresh, or any Provider network access. The canonical payload is the
 * persisted mutation proposal, not an upstream chat object or Provider reply.
 */
export function consumeXeroProviderWritePermitAtMutationBoundary(input: Readonly<{
  permit: LedgerProviderWritePermit | undefined;
  principal: AccountingPrincipal;
  connection: XeroActionConnection;
  adapterOperation: XeroProviderWriteAdapterOperation;
  actionId: XeroAutonomousWriteAction;
  mutationRequestId: string;
  providerIdempotencyKey: string;
  canonicalPayload: unknown;
}>): Readonly<XeroProviderWritePermitClaims> {
  if (
    typeof input.providerIdempotencyKey !== "string" ||
    input.providerIdempotencyKey.length === 0 ||
    input.providerIdempotencyKey !== input.mutationRequestId
  ) {
    throw new AppError(
      "FORBIDDEN",
      "The provider idempotency key must be a non-empty exact match for the mutation request.",
      {
        httpStatus: 403,
        retryable: false,
        details: {
          providerMutationPossible: false,
          writeOutcome: "DEFINITELY_REJECTED",
          reasonCodes: ["PROVIDER_IDEMPOTENCY_KEY_MISMATCH"],
        },
      },
    );
  }
  if (typeof input.principal === "string") {
    // A raw provider writer is never authorised by the legacy string
    // principal. No synthetic identity may be invented at this boundary.
    return consumeXeroProviderWritePermit(input.permit, {
      providerId: "xero",
      adapterOperation: input.adapterOperation,
      actionId: input.actionId,
      mutationRequestId: input.mutationRequestId,
      canonicalPayloadHash: hashObject(input.canonicalPayload),
      tenantId: input.connection.tenantId,
      actorId: input.principal,
      workspaceId: "__LEGACY_PRINCIPAL__",
      agentId: "__LEGACY_PRINCIPAL__",
      installationId: "__LEGACY_PRINCIPAL__",
      bindingId: "__LEGACY_PRINCIPAL__",
      bindingRevision: -1,
      connectionId: CONNECTION_CONTEXT_MISMATCH,
      targetSessionId: MISSING_TARGET_SESSION,
    });
  }

  const context = requireOAuthBoundRequestContext(input.principal);
  const connectionId = context.connectionId === input.connection.connectionId
    ? input.connection.connectionId
    : CONNECTION_CONTEXT_MISMATCH;
  const targetSessionId = context.targetSessionId ?? MISSING_TARGET_SESSION;

  return consumeXeroProviderWritePermit(input.permit, {
    providerId: "xero",
    adapterOperation: input.adapterOperation,
    actionId: input.actionId,
    mutationRequestId: input.mutationRequestId,
    canonicalPayloadHash: hashObject(input.canonicalPayload),
    tenantId: input.connection.tenantId,
    actorId: context.actorId,
    workspaceId: context.workspaceId,
    agentId: context.agentId,
    installationId: context.oauthInstallationId,
    bindingId: context.bindingId,
    bindingRevision: context.bindingRevision,
    connectionId,
    targetSessionId,
  });
}
