import { describe, expect, it } from "vitest";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import {
  allowedWriteTenantForRequest,
  actorIdForResolvedBinding,
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
  createOAuthRequestContextFromAuthInfo,
} from "../src/security/requestContext.js";

const resolvedToken: ResolvedMcpAccessToken = {
  tokenId: "token-id",
  clientId: "agent2-accounting-mcp",
  resource: "https://xero-mcp.example.test/mcp",
  audience: "https://xero-mcp.example.test/mcp",
  grantedScopes: ["xero.read"],
  issuedAt: new Date("2026-08-05T08:00:00.000Z"),
  expiresAt: new Date("2026-08-05T08:15:00.000Z"),
  installationId: "installation-id",
  bindingId: "binding-id",
  connectionId: "connection-id",
  bindingRevision: 7,
  authorizationId: "authorization-id",
  workspaceId: "workspace-id",
  subjectType: "USER",
  subjectId: "subject-id",
  agentId: "agent-id",
  policyId: "policy-id",
  tenantId: "tenant-id",
};

describe("OAuth RequestContext", () => {
  it("derives every identity and connection claim from the resolved server-side token", () => {
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    });

    expect(context).toMatchObject({
      actorId: "workspace-id:user:subject-id",
      workspaceId: "workspace-id",
      subjectType: "USER",
      subjectId: "subject-id",
      userId: "subject-id",
      agentId: "agent-id",
      oauthInstallationId: "installation-id",
      bindingId: "binding-id",
      connectionId: "connection-id",
      bindingRevision: 7,
      scopes: ["xero.read"],
      authn: {
        issuer: "https://xero-mcp.example.test",
        subject: "user:subject-id",
        audience: "https://xero-mcp.example.test/mcp",
        tokenId: "token-id",
      },
      legacyDemo: false,
    });
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.scopes)).toBe(true);
  });

  it("keeps same subject identifiers isolated by workspace and subject type", () => {
    expect(actorIdForResolvedBinding(resolvedToken)).not.toBe(actorIdForResolvedBinding({
      ...resolvedToken,
      workspaceId: "other-workspace",
    }));
    expect(actorIdForResolvedBinding(resolvedToken)).not.toBe(actorIdForResolvedBinding({
      ...resolvedToken,
      subjectType: "TEAM",
    }));
  });

  it("does not claim a user id for a team binding", () => {
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken: { ...resolvedToken, subjectType: "TEAM" },
    });
    expect(context.userId).toBeUndefined();
    expect(context.subjectType).toBe("TEAM");
    expect(context.subjectId).toBe("subject-id");
    expect(context.authn.subject).toBe("team:subject-id");
  });

  it("uses the exact Broker binding as the write tenant while preserving the legacy deploy allowlist", () => {
    const oauth = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    });
    expect(allowedWriteTenantForRequest(oauth, "tenant-from-active-binding")).toBe(
      "tenant-from-active-binding",
    );

    const legacy = createLegacySharedBearerRequestContext({
      actorId: "legacy-operator",
      audience: resolvedToken.audience,
    });
    expect(allowedWriteTenantForRequest(legacy, "tenant-from-provider")).toBeUndefined();
    expect(allowedWriteTenantForRequest(
      legacy,
      "tenant-from-provider",
      "legacy-explicit-allowlist",
    )).toBe("legacy-explicit-allowlist");

    expect(() => allowedWriteTenantForRequest(
      { ...oauth, bindingId: undefined } as unknown as typeof oauth,
      "tenant-from-provider",
    )).toThrowError(/trusted connection binding/u);
  });

  it("converts only verified AuthInfo claims and drops the raw bearer", () => {
    const context = createOAuthRequestContextFromAuthInfo({
      issuer: "https://xero-mcp.example.test",
      expectedAudience: resolvedToken.audience,
      authInfo: {
        token: "raw-secret-that-must-not-enter-context",
        clientId: resolvedToken.clientId,
        scopes: [...resolvedToken.grantedScopes],
        expiresAt: Math.floor(Date.now() / 1_000) + 900,
        resource: new URL(resolvedToken.resource),
        extra: {
          credentialId: resolvedToken.tokenId,
          installationId: resolvedToken.installationId,
          bindingId: resolvedToken.bindingId,
          connectionId: resolvedToken.connectionId,
          bindingRevision: resolvedToken.bindingRevision,
          authorizationId: resolvedToken.authorizationId,
          workspaceId: resolvedToken.workspaceId,
          subjectType: resolvedToken.subjectType,
          subjectId: resolvedToken.subjectId,
          agentId: resolvedToken.agentId,
          policyId: resolvedToken.policyId,
          tenantId: resolvedToken.tenantId,
        },
      },
    });

    expect(context.authn.tokenId).toBe(resolvedToken.tokenId);
    expect(context.bindingRevision).toBe(7);
    expect(JSON.stringify(context)).not.toContain("raw-secret-that-must-not-enter-context");
  });

  it("rejects missing or invalid active binding revisions from verified AuthInfo", () => {
    const authInfo = {
      token: "raw-secret-that-must-not-enter-context",
      clientId: resolvedToken.clientId,
      scopes: [...resolvedToken.grantedScopes],
      expiresAt: Math.floor(Date.now() / 1_000) + 900,
      resource: new URL(resolvedToken.resource),
      extra: {
        credentialId: resolvedToken.tokenId,
        installationId: resolvedToken.installationId,
        bindingId: resolvedToken.bindingId,
        connectionId: resolvedToken.connectionId,
        authorizationId: resolvedToken.authorizationId,
        workspaceId: resolvedToken.workspaceId,
        subjectType: resolvedToken.subjectType,
        subjectId: resolvedToken.subjectId,
        agentId: resolvedToken.agentId,
        policyId: resolvedToken.policyId,
        tenantId: resolvedToken.tenantId,
      },
    };

    expect(() => createOAuthRequestContextFromAuthInfo({
      issuer: "https://xero-mcp.example.test",
      expectedAudience: resolvedToken.audience,
      authInfo,
    })).toThrowError(/binding revision/u);
    expect(() => createOAuthRequestContextFromAuthInfo({
      issuer: "https://xero-mcp.example.test",
      expectedAudience: resolvedToken.audience,
      authInfo: {
        ...authInfo,
        extra: { ...authInfo.extra, bindingRevision: 0 },
      },
    })).toThrowError(/binding revision/u);
  });
});
