import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import type { AccountingProvider } from "../src/providers/types.js";
import { hashObject } from "../src/security/hash.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
} from "../src/security/requestContext.js";
import {
  buildNormalizedXeroReadEvidence,
  normalizedXeroReadPayload,
  safeXeroReadResult,
  XERO_READ_METADATA_MAX_JSON_UTF8_BYTES,
  XERO_READ_METADATA_MAX_UTF8_BYTES,
} from "../src/mcp/xeroReadEvidence.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";

const noOpLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function accountingWith(
  repository: InMemoryAccountingRepository,
  provider: Pick<AccountingProvider, "resolveContext">,
): AccountingService {
  return new AccountingService({
    repository,
    provider: provider as AccountingProvider,
    config: {
      publicBaseUrl: "https://xero-mcp.example.test",
      xeroWriteEnabled: false,
    } as Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">,
    logger: noOpLogger,
    connectionTickets: {} as ConnectionTicketService,
  });
}

describe("portable governance audit envelope", () => {
  it("creates a versioned tamper-evident chain without storing prompts, OAuth tokens, or chain-of-thought", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.appendGovernanceAuditEvent({
      eventId: "event-switch-requested",
      streamId: "installation:installation-1",
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.requested",
      source: "MCP",
      action: "xero.organisation.switch",
      actorId: "workspace-1:user:user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      bindingId: "binding-a",
      connectionId: "connection-a",
      tenantId: "tenant-a",
      correlationId: "call-1",
      disposition: "ESCALATE",
      outcome: "PROPOSED",
      inputHash: "a".repeat(64),
      evidence: { confirmationMode: "MCP_HOSTED_ONE_TIME_LINK" },
      occurredAt: new Date("2026-08-10T04:00:00.000Z"),
    });
    const second = await repository.appendGovernanceAuditEvent({
      eventId: "event-switch-completed",
      streamId: "installation:installation-1",
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.completed",
      source: "USER_UI",
      action: "xero.organisation.switch",
      actorId: "workspace-1:user:user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      bindingId: "binding-b",
      connectionId: "connection-b",
      tenantId: "tenant-b",
      correlationId: "call-1",
      causationId: first.eventId,
      disposition: "AUTO_EXECUTE",
      outcome: "SUCCEEDED",
      inputHash: "b".repeat(64),
      evidence: { confirmationMode: "MCP_HOSTED_ONE_TIME_LINK" },
      occurredAt: new Date("2026-08-10T04:01:00.000Z"),
    });

    expect(first.previousEventHash).toBeUndefined();
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(second.eventHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(repository.governanceAuditEvents)).not.toMatch(/access_token|refresh_token|chain.?of.?thought|prompt/iu);
  });

  it("hashes the complete Agent-visible read envelope while preserving the result-content hash", async () => {
    const repository = new InMemoryAccountingRepository();
    const tenantContext = {
      actorId: "audit-output-actor",
      tenantId: "tenant-locator-must-not-enter-output",
      tenantName: "Bound Audit Company",
    };
    const provider = {
      resolveContext: vi.fn().mockResolvedValue(tenantContext),
    } as unknown as AccountingProvider;
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const accounting = new AccountingService({
      repository,
      provider,
      config: {
        publicBaseUrl: "https://xero-mcp.example.test",
        xeroWriteEnabled: false,
      } as Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">,
      logger,
      connectionTickets: {} as ConnectionTicketService,
    });
    const context = createLegacySharedBearerRequestContext({
      actorId: tenantContext.actorId,
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const callId = "call_audit-output-projection";
    const rawResult = {
      contactId: "22222222-2222-4222-8222-222222222222",
      name: "Safe Supplier",
      tenantId: tenantContext.tenantId,
      bindingId: "binding-locator-must-not-enter-output",
    };
    let resolvedContext: typeof tenantContext | undefined;

    let agentVisiblePayload: Record<string, unknown> | undefined;
    const result = await accounting.withAudit({
      callId,
      actorId: context.actorId,
      principal: context,
      toolName: "xero_get_contact",
      input: { contact_id: rawResult.contactId },
      action: async () => rawResult,
      auditOutput: (actionResult) => {
        const safeResult = safeXeroReadResult(actionResult);
        const evidence = buildNormalizedXeroReadEvidence({
          toolName: "xero_get_contact",
          auditCallId: callId,
          requestContext: context,
          tenantContext: resolvedContext,
          input: { contact_id: rawResult.contactId },
          safeResult,
          observedAt: new Date("2026-08-10T04:00:00.000Z"),
        });
        if (!evidence) throw new Error("read evidence profile was missing");
        agentVisiblePayload = normalizedXeroReadPayload(safeResult, evidence);
        return agentVisiblePayload;
      },
      onResolvedContext: (resolved) => {
        resolvedContext = resolved;
      },
    });
    const safeResult = safeXeroReadResult(result);
    const evidence = buildNormalizedXeroReadEvidence({
      toolName: "xero_get_contact",
      auditCallId: callId,
      requestContext: context,
      tenantContext: resolvedContext,
      input: { contact_id: rawResult.contactId },
      safeResult,
      observedAt: new Date("2026-08-10T04:00:00.000Z"),
    });
    if (!evidence) throw new Error("read evidence profile was missing");
    const completed = repository.governanceAuditEvents.find(
      (event) => event.eventId === `${callId}:completed`,
    );

    expect(result).toBe(rawResult);
    expect(safeResult).toEqual({ contactId: rawResult.contactId, name: rawResult.name });
    expect(evidence.output_hash).toBe(`sha256:${hashObject(safeResult)}`);
    expect(agentVisiblePayload).toBeDefined();
    expect(completed?.outputHash).toBe(hashObject(agentVisiblePayload));
    expect(completed?.outputHash).not.toBe(evidence.output_hash.replace(/^sha256:/u, ""));
    expect(completed?.outputHash).not.toContain(tenantContext.tenantId);
  });

  it("bounds Provider-controlled truncation and pagination field names without fake pointers", () => {
    const context = createLegacySharedBearerRequestContext({
      actorId: "metadata-bound-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const tenantContext = {
      actorId: context.actorId,
      tenantId: "tenant-metadata-bound",
      tenantName: "Metadata Bound Company",
    };
    const longTruncatedKey = `${"t".repeat(90_000)}Truncated`;
    const locatorBearingTruncatedKey = "tenant-private-markerTruncated";
    const exactResult = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(exactResult, "contactId", { value: "contact-1", enumerable: true });
    Object.defineProperty(exactResult, longTruncatedKey, { value: true, enumerable: true });
    Object.defineProperty(exactResult, locatorBearingTruncatedKey, { value: true, enumerable: true });

    const exactEvidence = buildNormalizedXeroReadEvidence({
      toolName: "xero_get_contact",
      auditCallId: "call_metadata-exact",
      requestContext: context,
      tenantContext,
      input: { contact_id: "contact-1" },
      safeResult: exactResult,
    });
    if (!exactEvidence) throw new Error("exact read evidence profile was missing");
    const omittedFields = exactEvidence.completeness.omitted_or_truncated_fields as string[];

    expect(exactEvidence.fact_paths).toEqual(["/result"]);
    expect(omittedFields).toHaveLength(2);
    expect(omittedFields).toEqual(expect.arrayContaining([
      expect.stringMatching(/^field_name_omitted_sha256_[a-f0-9]{32}$/u),
    ]));
    expect(omittedFields.every(
      (field) => Buffer.byteLength(field, "utf8") <= XERO_READ_METADATA_MAX_UTF8_BYTES,
    )).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(omittedFields), "utf8")).toBeLessThanOrEqual(
      XERO_READ_METADATA_MAX_JSON_UTF8_BYTES,
    );
    expect(JSON.stringify(exactEvidence)).not.toContain(longTruncatedKey);
    expect(JSON.stringify(exactEvidence)).not.toContain("tenant-private-marker");

    const longPaginationKey = `${"p".repeat(90_000)}Pagination`;
    const pagination = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(pagination, "page", { value: 1, enumerable: true });
    Object.defineProperty(pagination, longPaginationKey, { value: "provider-value", enumerable: true });
    Object.defineProperty(pagination, "tenant-private-pagination", {
      value: "raw-locator-value",
      enumerable: true,
    });
    const collectionEvidence = buildNormalizedXeroReadEvidence({
      toolName: "xero_list_contacts",
      auditCallId: "call_metadata-collection",
      requestContext: context,
      tenantContext,
      input: {},
      safeResult: { contacts: [], pagination },
    });
    if (!collectionEvidence) throw new Error("collection read evidence profile was missing");
    const safePagination = collectionEvidence.completeness.pagination as Record<string, unknown>;

    expect(safePagination).toMatchObject({ page: 1 });
    expect(Object.keys(safePagination)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^metadata_key_sha256_[a-f0-9]{32}$/u),
      expect.stringMatching(/^redacted_key_sha256_[a-f0-9]{32}$/u),
    ]));
    expect(Buffer.byteLength(JSON.stringify(safePagination), "utf8")).toBeLessThanOrEqual(
      XERO_READ_METADATA_MAX_JSON_UTF8_BYTES,
    );
    expect(JSON.stringify(collectionEvidence)).not.toContain(longPaginationKey);
    expect(JSON.stringify(collectionEvidence)).not.toContain("tenant-private-pagination");
    expect(JSON.stringify(collectionEvidence)).not.toContain("raw-locator-value");
  });

  it("bounds and de-cycles the Agent-visible Provider read projection", () => {
    const circular = {
      name: "Safe Supplier",
      tenantId: "tenant-locator-must-not-leak",
    } as Record<string, unknown>;
    circular.self = circular;
    const deepRoot: Record<string, unknown> = circular;
    let cursor = deepRoot;
    for (let index = 0; index < 100; index += 1) {
      const next: Record<string, unknown> = { label: `level-${index}` };
      cursor.next = next;
      cursor = next;
    }
    deepRoot.values = Array.from({ length: 25_000 }, (_, index) => ({ index }));

    const safe = safeXeroReadResult(deepRoot) as Record<string, unknown>;
    const serialized = JSON.stringify(safe);

    expect(safe).toMatchObject({
      name: "Safe Supplier",
      mcpProjectionTruncated: true,
    });
    expect(serialized).toContain("[MCP omitted circular provider value]");
    expect(serialized).toContain("[MCP read projection omitted by safety bound]");
    expect(serialized).not.toContain("tenant-locator-must-not-leak");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(2.2 * 1_024 * 1_024);
  });

  it("keeps an OAuth disconnected observation in the connector control plane", () => {
    const token = {
      tokenId: "token-control-plane-private",
      clientId: "agent2-accounting-mcp",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: ["xero.read"],
      issuedAt: new Date("2026-08-10T04:00:00.000Z"),
      expiresAt: new Date("2026-08-10T05:00:00.000Z"),
      installationId: "installation-control-plane-private",
      bindingId: "binding-control-plane-private",
      connectionId: "connection-control-plane-private",
      bindingRevision: 5,
      authorizationId: "authorization-control-plane-private",
      workspaceId: "workspace-control-plane-private",
      subjectType: "USER",
      subjectId: "subject-control-plane-private",
      agentId: "agent-control-plane-private",
      policyId: "policy-control-plane-private",
      tenantId: "tenant-control-plane-private",
    } satisfies ResolvedMcpAccessToken;
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken: token,
    });
    const evidence = buildNormalizedXeroReadEvidence({
      toolName: "xero_connection_status",
      auditCallId: "call_disconnected-control-plane",
      requestContext: context,
      input: {},
      safeResult: { connected: false, scopes: [] },
    });
    if (!evidence) throw new Error("connection status evidence profile was missing");

    expect(evidence).toMatchObject({
      destination_role: "connector_control_plane",
      bound_target_ref_safe: null,
      organisation_display_name: null,
      binding_revision: null,
      connection_ref_safe: expect.stringMatching(/^xero-connection:[a-f0-9]{32}$/u),
      connection_state: "disconnected",
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(token.tenantId);
    expect(serialized).not.toContain(token.bindingId);
    expect(serialized).not.toContain(token.connectionId);
  });

  it("fails before every non-status action when the initial tenant cannot be resolved", async () => {
    const repository = new InMemoryAccountingRepository();
    const accounting = accountingWith(repository, {
      resolveContext: vi.fn().mockRejectedValue(new Error("connection resolution unavailable")),
    });
    const action = vi.fn().mockResolvedValue({ shouldNotRun: true });

    await expect(accounting.withAudit({
      callId: "call_missing-initial-tenant",
      actorId: "legacy-audit-actor",
      toolName: "xero_prepare_supplier_bill_draft",
      input: {},
      action,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR", httpStatus: 503 });

    expect(action).not.toHaveBeenCalled();
    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: "call_missing-initial-tenant", resultStatus: "FAILED" }),
    ]);
    expect(repository.governanceAuditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: "call_missing-initial-tenant:completed", outcome: "FAILED" }),
    ]));
    expect(repository.governanceAuditEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: "call_missing-initial-tenant:completed", outcome: "SUCCEEDED" }),
    ]));
  });

  it("withholds a legacy result when the tenant changes during the action", async () => {
    const repository = new InMemoryAccountingRepository();
    const resolveContext = vi.fn()
      .mockResolvedValueOnce({ actorId: "legacy-audit-actor", tenantId: "tenant-a", tenantName: "Company A" })
      .mockResolvedValueOnce({ actorId: "legacy-audit-actor", tenantId: "tenant-b", tenantName: "Company B" });
    const accounting = accountingWith(repository, { resolveContext });
    const context = createLegacySharedBearerRequestContext({
      actorId: "legacy-audit-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });

    await expect(accounting.withAudit({
      callId: "call_legacy-tenant-race",
      actorId: context.actorId,
      principal: context,
      toolName: "xero_get_contact",
      input: {},
      action: async () => ({ name: "Withheld Supplier" }),
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR", httpStatus: 503 });

    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: "call_legacy-tenant-race", resultStatus: "FAILED" }),
    ]);
    expect(repository.governanceAuditEvents.find(
      (event) => event.eventId === "call_legacy-tenant-race:completed",
    )).toMatchObject({ outcome: "FAILED" });
  });

  it("withholds an OAuth read when the active organisation changes during the action", async () => {
    const repository = new InMemoryAccountingRepository();
    const resolveContext = vi.fn()
      .mockResolvedValueOnce({ actorId: "workspace-race:user:subject-race", tenantId: "tenant-a", tenantName: "Company A" })
      .mockResolvedValueOnce({ actorId: "workspace-race:user:subject-race", tenantId: "tenant-b", tenantName: "Company B" });
    const accounting = accountingWith(repository, { resolveContext });
    const token: ResolvedMcpAccessToken = {
      tokenId: "token-race",
      clientId: "agent2-accounting-mcp",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: ["xero.read"],
      issuedAt: new Date("2026-08-10T04:00:00.000Z"),
      expiresAt: new Date("2026-08-10T05:00:00.000Z"),
      installationId: "installation-race",
      bindingId: "binding-race",
      connectionId: "connection-race",
      bindingRevision: 7,
      authorizationId: "authorization-race",
      workspaceId: "workspace-race",
      subjectType: "USER",
      subjectId: "subject-race",
      agentId: "agent-race",
      policyId: "policy-race",
      tenantId: "tenant-a",
    };
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken: token,
    });

    await expect(accounting.withAudit({
      callId: "call_oauth-tenant-race",
      actorId: context.actorId,
      principal: context,
      toolName: "xero_get_contact",
      input: {},
      action: async () => ({ name: "Withheld Supplier" }),
      revalidateContextAfterAction: true,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR", httpStatus: 503 });

    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: "call_oauth-tenant-race", resultStatus: "FAILED" }),
    ]);
    expect(repository.governanceAuditEvents.find(
      (event) => event.eventId === "call_oauth-tenant-race:completed",
    )).toMatchObject({ outcome: "FAILED" });
  });

  it("records projection or serialization failure as FAILED rather than SUCCEEDED", async () => {
    const repository = new InMemoryAccountingRepository();
    const accounting = accountingWith(repository, {
      resolveContext: vi.fn().mockResolvedValue({
        actorId: "projection-failure-actor",
        tenantId: "tenant-projection",
        tenantName: "Projection Company",
      }),
    });

    await expect(accounting.withAudit({
      callId: "call_projection-failure",
      actorId: "projection-failure-actor",
      toolName: "xero_get_trial_balance",
      input: {},
      action: async () => ({ reports: [] }),
      auditOutput: () => {
        throw new AppError("CONFIGURATION_ERROR", "Synthetic serializer failure.", { httpStatus: 503 });
      },
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR", httpStatus: 503 });

    expect(repository.audits).toEqual([
      expect.objectContaining({ callId: "call_projection-failure", resultStatus: "FAILED" }),
    ]);
    const completed = repository.governanceAuditEvents.filter(
      (event) => event.eventId === "call_projection-failure:completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: "FAILED" });
  });
});
