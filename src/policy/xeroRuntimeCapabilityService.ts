import type { AppConfig } from "../config.js";
import type { AccountingProvider } from "../providers/types.js";
import {
  allowedWriteTenantForRequest,
  requireOAuthBoundRequestContext,
  type RequestContext,
} from "../security/requestContext.js";
import { hashObject } from "../security/hash.js";
import {
  evaluateEffectiveXeroCapability,
} from "./xeroEffectiveCapability.js";
import type { XeroCapabilityPermission } from "./xeroCapabilityPolicy.js";

export interface XeroRuntimeCapabilityReceipt {
  readonly allowed: boolean;
  readonly denyReasons: readonly string[];
  readonly receiptHash: string;
}

export interface XeroRuntimeCapabilityEvaluator {
  evaluate(context: RequestContext, actionId: string): Promise<XeroRuntimeCapabilityReceipt>;
}

function permissionsFor(context: RequestContext): XeroCapabilityPermission[] {
  const permissions: XeroCapabilityPermission[] = [];
  if (context.scopes.includes("xero.read")) permissions.push("XERO_ACCOUNTING_READ");
  if (context.scopes.includes("xero.draft.write")) permissions.push("XERO_DRAFT_WRITE");
  if (context.roles.includes("xero.dual_approval")) permissions.push("XERO_DUAL_APPROVAL");
  return permissions;
}

/**
 * Provider-specific live preflight used by the provider-neutral mutation
 * foundation. The receipt contains no token, raw target reference, or
 * model-supplied authority field.
 */
export class XeroRuntimeCapabilityService implements XeroRuntimeCapabilityEvaluator {
  constructor(
    private readonly provider: Pick<AccountingProvider, "connectionStatus" | "resolveContext">,
    private readonly config: Pick<AppConfig, "xeroWriteEnabled" | "xeroAllowedTenantId">,
  ) {}

  async evaluate(context: RequestContext, actionId: string): Promise<XeroRuntimeCapabilityReceipt> {
    const oauth = requireOAuthBoundRequestContext(context);
    const [status, tenant] = await Promise.all([
      this.provider.connectionStatus(context),
      this.provider.resolveContext(context),
    ]);
    const allowedWriteTenantId = allowedWriteTenantForRequest(
      context,
      tenant.tenantId,
      this.config.xeroAllowedTenantId,
    );
    const decision = evaluateEffectiveXeroCapability(actionId, {
      connectionConnected: status.connected,
      connectionId: oauth.connectionId,
      ...(status.tenant?.id ? { connectionTenantId: status.tenant.id } : {}),
      boundTenantId: tenant.tenantId,
      grantedMcpScopes: context.scopes,
      grantedPermissions: permissionsFor(context),
      grantedXeroOAuthScopes: status.scopes,
      writeGateEnabled: this.config.xeroWriteEnabled,
      ...(allowedWriteTenantId ? { allowedWriteTenantId } : {}),
    });
    const receiptHash = hashObject({
      receiptType: "XERO_RUNTIME_CAPABILITY",
      actionId,
      actorId: oauth.actorId,
      workspaceId: oauth.workspaceId,
      agentId: oauth.agentId,
      installationId: oauth.oauthInstallationId,
      bindingId: oauth.bindingId,
      bindingRevision: oauth.bindingRevision,
      connectionId: oauth.connectionId,
      targetSessionId: oauth.targetSessionId,
      tenantId: tenant.tenantId,
      connectionTenantId: status.tenant?.id ?? null,
      connectionConnected: status.connected,
      grantedMcpScopes: [...context.scopes].sort(),
      grantedXeroOAuthScopes: [...status.scopes].sort(),
      writeGateEnabled: this.config.xeroWriteEnabled,
      allowedWriteTenantId: allowedWriteTenantId ?? null,
      allowed: decision.allowed,
      denyReasons: decision.denyReasons,
    });
    return Object.freeze({
      allowed: decision.allowed,
      denyReasons: Object.freeze([...decision.denyReasons]),
      receiptHash,
    });
  }
}
