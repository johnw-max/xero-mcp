import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AccountingService } from "../services/accountingService.js";
import type { ResolvedMcpAccessToken } from "../domain/models.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
} from "../security/requestContext.js";
import { safeLedgerTargetReference } from "../security/ledgerTargetReference.js";
import { createAccountingMcpServer } from "./createServer.js";
import { TOOL_ALLOWLIST } from "./toolNames.js";

function testContext() {
  return createLegacySharedBearerRequestContext({
    actorId: "test-actor",
    audience: "https://xero-mcp.example.test/mcp",
  });
}

describe("MCP tool surface", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  it("returns a user-confirmed organisation switch link without treating chat text as authority", async () => {
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-switch",
      audience: "https://mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const service = { withAudit } as unknown as AccountingService;
    const start = vi.fn().mockResolvedValue({
      status: "USER_CONFIRMATION_REQUIRED",
      switchUrl: "https://xero-mcp.example.test/xero/organisation-switch?ticket=opaque",
    });
    const server = createAccountingMcpServer(service, context, { start } as never);
    const client = new Client({ name: "organisation-switch-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "xero_start_organisation_switch", arguments: {} });

    expect(result.structuredContent).toEqual({
      result: {
        status: "USER_CONFIRMATION_REQUIRED",
        switchUrl: "https://xero-mcp.example.test/xero/organisation-switch?ticket=opaque",
      },
    });
    expect(start).toHaveBeenCalledWith(context);
    expect(withAudit).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "xero_start_organisation_switch",
      principal: context,
    }));
  });

  it("advertises only the reviewed read and Accounting Case tools", async () => {
    const service = {} as AccountingService;
    const server = createAccountingMcpServer(service, testContext());
    const client = new Client({ name: "contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_ALLOWLIST].sort());
    expect(tools.tools).toHaveLength(29);
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "xero_prepare_manual_journal_draft",
      "xero_create_manual_journal_draft",
      "xero_prepare_supplier_bill_draft",
      "xero_create_draft_supplier_bill",
    ]));
  });

  it("pins one immutable organisation target and keeps the raw capability out of business audit input", async () => {
    const targetSessionRef = `xts_${Buffer.alloc(32, 5).toString("base64url")}`;
    const resolvedToken: ResolvedMcpAccessToken = {
      tokenId: "target-token",
      clientId: "target-client",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: ["xero.read"],
      issuedAt: new Date("2026-08-12T08:00:00.000Z"),
      expiresAt: new Date("2026-08-12T09:00:00.000Z"),
      installationId: "target-installation",
      bindingId: "target-binding-current",
      bindingRevision: 2,
      workspaceId: "target-workspace",
      subjectType: "USER",
      subjectId: "target-user",
      agentId: "target-agent",
      connectionId: "target-connection-current",
      authorizationId: "target-authorization",
      tenantId: "11111111-1111-4111-8111-111111111111",
      policyId: "target-policy",
    };
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    });
    const effectiveContext = Object.freeze({
      ...context,
      bindingId: "target-binding-pinned",
      connectionId: "target-connection-pinned",
      bindingRevision: 1,
      targetSessionId: "target-session-safe-id",
      targetSessionHash: "a".repeat(64),
      targetSessionExpiresAt: new Date("2026-08-12T08:30:00.000Z"),
    });
    const targetRefSafe = safeLedgerTargetReference(effectiveContext.targetSessionId);
    const issue = vi.fn().mockResolvedValue({
      target_session_ref: targetSessionRef,
      target_ref_safe: targetRefSafe,
      binding_revision: 1,
      organisation_name: "Pinned Company",
      expires_at: "2026-08-12T08:30:00.000Z",
    });
    const start = vi.fn().mockResolvedValue({
      status: "USER_CONFIRMATION_REQUIRED",
      switchUrl: "https://xero-mcp.example.test/xero/organisation-switch?ticket=opaque",
    });
    const resolve = vi.fn().mockResolvedValue(effectiveContext);
    const getOrganisation = vi.fn().mockResolvedValue({
      organisationId: "22222222-2222-4222-8222-222222222222",
      name: "Pinned Company",
      baseCurrency: "SGD",
      countryCode: "SG",
    });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: Record<string, unknown>) => void;
    }) => {
      onResolvedContext?.({
        actorId: effectiveContext.actorId,
        tenantId: "22222222-2222-4222-8222-222222222222",
        tenantName: "Pinned Company",
      });
      return action();
    });
    const service = { withAudit, getOrganisation } as unknown as AccountingService;
    const server = createAccountingMcpServer(service, context, { start } as never, {
      issue,
      resolve,
      required: true,
    } as never);
    const client = new Client({ name: "target-session-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const missingTarget = await client.callTool({ name: "xero_get_organisation", arguments: {} });
    expect(missingTarget.isError).toBe(true);

    const pinned = await client.callTool({ name: "xero_pin_current_organisation", arguments: {} });
    expect(pinned.structuredContent).toMatchObject({ result: { target_session_ref: targetSessionRef } });
    const response = await client.callTool({
      name: "xero_get_organisation",
      arguments: { target_session_ref: targetSessionRef },
    });

    expect(issue).toHaveBeenCalledWith(context);
    expect(resolve).toHaveBeenCalledWith(context, targetSessionRef);
    expect(getOrganisation).toHaveBeenCalledWith(effectiveContext);
    const ledgerAudit = withAudit.mock.calls.find(([call]) => call.toolName === "xero_get_organisation")?.[0];
    expect(ledgerAudit).toMatchObject({ principal: effectiveContext, input: {} });
    expect(JSON.stringify(ledgerAudit)).not.toContain(targetSessionRef);
    expect(JSON.stringify(response.structuredContent)).not.toContain(targetSessionRef);
    expect(response.structuredContent).toMatchObject({
      result: { name: "Pinned Company", baseCurrency: "SGD" },
      target_session_ref_safe: targetRefSafe,
    });
    expect((pinned.structuredContent as { result?: { target_ref_safe?: string } }).result?.target_ref_safe)
      .toBe((response.structuredContent as Record<string, unknown>).target_session_ref_safe);
    expect((response.structuredContent as Record<string, unknown>).binding_revision)
      .toMatch(/^xero-binding-revision:[a-f0-9]{32}$/u);

    const switchResult = await client.callTool({
      name: "xero_start_organisation_switch",
      arguments: { target_session_ref: targetSessionRef },
    });
    expect(switchResult.isError).not.toBe(true);
    expect(start).toHaveBeenCalledWith(effectiveContext);
  });

  it("advertises connection status as a read-only idempotent production tool", async () => {
    const service = {} as AccountingService;
    const server = createAccountingMcpServer(service, testContext());
    const client = new Client({ name: "status-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const statusTool = tools.tools.find((tool) => tool.name === "xero_connection_status");

    expect(statusTool).toMatchObject({
      description: "Returns connector control-plane health and the current compatibility selection. It does not prove a ledger target; first call xero_pin_current_organisation, then verify with xero_get_organisation using that target_session_ref. Organisation changes require a separate short-lived user confirmation page and never happen silently from chat text.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      },
    });
  });

  it("routes bounded contact listing and exact contact reads through xero.read audit", async () => {
    const contactId = "22222222-2222-4222-8222-222222222222";
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const listContacts = vi.fn().mockResolvedValue({
      contacts: [],
      pagination: {
        page: 1,
        pageSize: 25,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    });
    const getContact = vi.fn().mockResolvedValue({ contactId, name: "Exact Supplier" });
    const auditProjections: unknown[] = [];
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
      auditOutput,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (context: { actorId: string; tenantId: string; tenantName: string }) => void;
      auditOutput?: (result: unknown) => unknown;
    }) => {
      onResolvedContext?.({ actorId: "test-actor", tenantId, tenantName: "Bound Demo Company" });
      const result = await action();
      auditProjections.push(auditOutput?.(result));
      return result;
    });
    const service = { listContacts, getContact, withAudit } as unknown as AccountingService;
    const context = testContext();
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "contact-read-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const name of ["xero_list_contacts", "xero_get_contact"]) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    }
    const listed = await client.callTool({
      name: "xero_list_contacts",
      arguments: { is_supplier: true },
    });
    const exact = await client.callTool({
      name: "xero_get_contact",
      arguments: { contact_id: contactId },
    });

    expect(listContacts).toHaveBeenCalledWith(context, {
      status: "ACTIVE",
      is_supplier: true,
      page: 1,
      limit: 25,
    });
    expect(getContact).toHaveBeenCalledWith(context, { contact_id: contactId });
    expect(listed.structuredContent).toMatchObject({
      result: { contacts: [] },
      result_class: "succeeded",
      fact_origin: "MCP_READ",
      capability_id: "ledger.reference.counterparty.read",
      query_bounds: {
        target_scope: "active_server_bound_xero_organisation",
        requested: { status: "ACTIVE", is_supplier: true, page: 1, limit: 25 },
      },
      completeness: {
        status: "bounded_query_result",
        within_declared_query_bounds: "not_independently_verified",
        declared_page_complete: true,
        whole_ledger_complete: false,
        pagination: { page: 1, pageSize: 25, returned: 0 },
      },
    });
    expect(exact.structuredContent).toMatchObject({
      result: { contactId, name: "Exact Supplier" },
      result_class: "succeeded",
      fact_origin: "MCP_READ",
      source_system: "xero",
      destination_role: "ledger_sor",
      capability_id: "ledger.reference.counterparty.read",
      organisation_display_name: "Bound Demo Company",
      completeness: {
        status: "exact_object_identity",
        provider_field_completeness: "not_independently_verified",
      },
      fact_paths: ["/result/contactId", "/result/name"],
    });
    const exactEvidence = exact.structuredContent as Record<string, unknown>;
    expect(exactEvidence.tool_call_or_audit_ref).toBe(withAudit.mock.calls[1]?.[0]?.callId);
    expect(exactEvidence.bound_target_ref_safe).toMatch(/^xero-target:[a-f0-9]{32}$/);
    expect(exactEvidence.binding_revision).toMatch(/^xero-legacy-binding:[a-f0-9]{32}$/);
    expect(exactEvidence.output_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(exact.structuredContent)).not.toContain(tenantId);
    expect(withAudit.mock.calls.map(([call]) => call.toolName)).toEqual([
      "xero_list_contacts",
      "xero_get_contact",
    ]);
    expect(withAudit.mock.calls.every(([call]) => call.principal === context)).toBe(true);
    expect(withAudit.mock.calls.every(([call]) => call.revalidateContextAfterAction === true)).toBe(true);
    expect(auditProjections).toEqual([listed.structuredContent, exact.structuredContent]);
    expect(withAudit.mock.calls[1]?.[0]?.recordId?.({ contactId })).toBe(contactId);
  });

  it("returns ledger.target.resolve evidence without exposing the raw Xero tenant locator", async () => {
    const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const organisation = {
      organisationId: tenantId,
      name: "Bound Demo Company",
      baseCurrency: "USD",
      countryCode: "US",
    };
    const getOrganisation = vi.fn().mockResolvedValue(organisation);
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (context: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({ actorId: "test-actor", tenantId, tenantName: organisation.name });
      return action();
    });
    const context = testContext();
    const service = { getOrganisation, withAudit } as unknown as AccountingService;
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "target-evidence-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "xero_get_organisation", arguments: {} });

    expect(response.structuredContent).toMatchObject({
      result: {
        name: organisation.name,
        baseCurrency: organisation.baseCurrency,
        countryCode: organisation.countryCode,
      },
      result_class: "succeeded",
      fact_origin: "MCP_READ",
      source_system: "xero",
      destination_role: "ledger_sor",
      capability_id: "ledger.target.resolve",
      organisation_display_name: organisation.name,
      base_currency: organisation.baseCurrency,
      completeness: { status: "complete" },
      fact_paths: ["/result/name", "/result/baseCurrency"],
    });
    const evidence = response.structuredContent as Record<string, unknown>;
    expect(evidence.tool_call_or_audit_ref).toBe(withAudit.mock.calls[0]?.[0]?.callId);
    expect(evidence.bound_target_ref_safe).toMatch(/^xero-target:[a-f0-9]{32}$/);
    expect(evidence.binding_revision).toMatch(/^xero-legacy-binding:[a-f0-9]{32}$/);
    expect(JSON.stringify(response.structuredContent)).not.toContain(tenantId);
    expect((response.structuredContent as { result?: Record<string, unknown> }).result)
      .not.toHaveProperty("organisationId");
  });

  it("withholds ordinary ledger reads when the server cannot resolve a bound tenant", async () => {
    const getContact = vi.fn().mockResolvedValue({ name: "Must Not Be Returned" });
    const connectionStatus = vi.fn().mockResolvedValue({ connected: false, reason: "not_connected" });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: undefined) => void;
    }) => {
      onResolvedContext?.(undefined);
      return action();
    });
    const service = { connectionStatus, getContact, withAudit } as unknown as AccountingService;
    const context = testContext();
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "unbound-read-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const ledgerRead = await client.callTool({
      name: "xero_get_contact",
      arguments: { contact_id: "22222222-2222-4222-8222-222222222222" },
    });
    const statusRead = await client.callTool({ name: "xero_connection_status", arguments: {} });

    expect(ledgerRead.isError).toBe(true);
    expect(ledgerRead.structuredContent).toMatchObject({
      error: { code: "CONFIGURATION_ERROR", retryable: false },
    });
    expect(getContact).not.toHaveBeenCalled();
    expect(statusRead.isError).not.toBe(true);
    expect(statusRead.structuredContent).toMatchObject({
      result: { connected: false, reason: "not_connected" },
      capability_id: "connector.connection.status.read",
      destination_role: "connector_control_plane",
      bound_target_ref_safe: null,
      organisation_display_name: null,
      binding_revision: null,
      connection_ref_safe: null,
      connection_state: "disconnected",
      query_bounds: {
        target_scope: "connection_binding_resolution",
        requested: {},
      },
      completeness: {
        status: "connection_status_observation",
        scope: "connection_binding_resolution",
        ledger_data_completeness: "not_applicable",
      },
    });
    expect(connectionStatus).toHaveBeenCalledWith(context);
  });

  it("keeps connected status in the connector control plane without leaking or proving a ledger target", async () => {
    const tenantId = "tenant-status-private";
    const bindingId = "binding-status-private";
    const connectionId = "connection-status-private";
    const resolvedToken: ResolvedMcpAccessToken = {
      tokenId: "token-status-private",
      clientId: "agent2-accounting-mcp",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: ["xero.read"],
      issuedAt: new Date("2026-08-10T04:00:00.000Z"),
      expiresAt: new Date("2026-08-10T05:00:00.000Z"),
      installationId: "installation-status-private",
      bindingId,
      connectionId,
      bindingRevision: 4,
      authorizationId: "authorization-status-private",
      workspaceId: "workspace-status-private",
      subjectType: "USER",
      subjectId: "subject-status-private",
      agentId: "agent-status-private",
      policyId: "policy-status-private",
      tenantId,
    };
    const context = createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    });
    const connectionStatus = vi.fn().mockResolvedValue({
      connected: true,
      connectionId,
      bindingId,
      tenant: { id: tenantId, name: "Private Bound Company" },
    });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({ actorId: context.actorId, tenantId, tenantName: "Private Bound Company" });
      return action();
    });
    const service = { connectionStatus, withAudit } as unknown as AccountingService;
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "connected-status-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "xero_connection_status", arguments: {} });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      destination_role: "connector_control_plane",
      capability_id: "connector.connection.status.read",
      bound_target_ref_safe: null,
      organisation_display_name: null,
      binding_revision: null,
      connection_ref_safe: expect.stringMatching(/^xero-connection:[a-f0-9]{32}$/),
      connection_state: "connected",
      completeness: { status: "connection_status_observation" },
    });
    const serialized = JSON.stringify(response.structuredContent);
    expect(serialized).not.toContain(tenantId);
    expect(serialized).not.toContain(bindingId);
    expect(serialized).not.toContain(connectionId);
  });

  it("changes the opaque evidence revision when the active binding revision changes without exposing locators", async () => {
    const tenantId = "tenant-private-same";
    const bindingId = "binding-private-same";
    const connectionId = "connection-private-same";
    const installationId = "installation-private-same";
    const callWithRevision = async (bindingRevision: number) => {
      const resolvedToken: ResolvedMcpAccessToken = {
        tokenId: `token-${bindingRevision}`,
        clientId: "agent2-accounting-mcp",
        resource: "https://xero-mcp.example.test/mcp",
        audience: "https://xero-mcp.example.test/mcp",
        grantedScopes: ["xero.read"],
        issuedAt: new Date("2026-08-10T04:00:00.000Z"),
        expiresAt: new Date("2026-08-10T05:00:00.000Z"),
        installationId,
        bindingId,
        connectionId,
        bindingRevision,
        authorizationId: "authorization-private-same",
        workspaceId: "workspace-private-same",
        subjectType: "USER",
        subjectId: "subject-private-same",
        agentId: "agent-private-same",
        policyId: "policy-private-same",
        tenantId,
      };
      const context = createOAuthRequestContext({
        issuer: "https://xero-mcp.example.test",
        resolvedToken,
      });
      const getContact = vi.fn().mockResolvedValue({ name: "Safe Supplier" });
      const withAudit = vi.fn().mockImplementation(async ({
        action,
        onResolvedContext,
      }: {
        action: () => Promise<unknown>;
        onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
      }) => {
        onResolvedContext?.({ actorId: context.actorId, tenantId, tenantName: "Bound Company" });
        return action();
      });
      const service = { getContact, withAudit } as unknown as AccountingService;
      const server = createAccountingMcpServer(service, context);
      const client = new Client({ name: `binding-revision-${bindingRevision}`, version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      closeables.push(client, server);
      await server.connect(serverTransport as unknown as Transport);
      await client.connect(clientTransport);
      return client.callTool({
        name: "xero_get_contact",
        arguments: { contact_id: "22222222-2222-4222-8222-222222222222" },
      });
    };

    const first = await callWithRevision(7);
    const second = await callWithRevision(8);
    const firstRevision = (first.structuredContent as Record<string, unknown>).binding_revision;
    const secondRevision = (second.structuredContent as Record<string, unknown>).binding_revision;

    expect(firstRevision).toMatch(/^xero-binding-revision:[a-f0-9]{32}$/);
    expect(secondRevision).toMatch(/^xero-binding-revision:[a-f0-9]{32}$/);
    expect(secondRevision).not.toBe(firstRevision);
    for (const payload of [first.structuredContent, second.structuredContent]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(tenantId);
      expect(serialized).not.toContain(bindingId);
      expect(serialized).not.toContain(connectionId);
      expect(serialized).not.toContain(installationId);
      expect(serialized).not.toContain("bindingRevision");
    }
  });

  it("routes supplier bill preparation through the read scope and audit without calling a write", async () => {
    const prepareSupplierBillDraft = vi.fn().mockResolvedValue({ proposal: null, evidence: {}, blockers: [] });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({ actorId: "test-actor", tenantId: "tenant-history", tenantName: "History Company" });
      return action();
    });
    const service = { prepareSupplierBillDraft, withAudit } as unknown as AccountingService;
    const context = testContext();
    const server = createAccountingMcpServer(service, context, undefined, undefined, undefined, {
      unsafeExposeLegacyObjectMutationToolsForTests: true,
    });
    const client = new Client({ name: "prepare-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "xero_prepare_supplier_bill_draft",
      arguments: { supplier_name: "Acme Limited", lines: [{}] },
    });

    expect(result.isError).not.toBe(true);
    expect(prepareSupplierBillDraft).toHaveBeenCalledWith(context, {
      supplier_name: "Acme Limited",
      lines: [{}],
    });
    expect(withAudit).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "xero_prepare_supplier_bill_draft",
      principal: context,
    }));
  });

  it("returns the durable audit call ID with a successful draft-write receipt", async () => {
    const serviceResult = {
      postingRequestId: "pr_test",
      invoiceId: "11111111-1111-4111-8111-111111111111",
      status: "DRAFT",
      approvedPayloadHash: "b".repeat(64),
      providerReceipt: {
        operation: "CREATE_DRAFT",
        invoiceId: "11111111-1111-4111-8111-111111111111",
      },
      readbackVerified: true,
      reviewUrl: "https://xero-mcp.example.test/review/pr_test",
      bill: { invoiceId: "11111111-1111-4111-8111-111111111111", status: "DRAFT" },
      idempotentReplay: false,
    };
    const executePreparedSupplierBillDraft = vi.fn().mockResolvedValue(serviceResult);
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({ actorId: "read-only-actor", tenantId: "tenant-history", tenantName: "History Company" });
      return action();
    });
    const service = { executePreparedSupplierBillDraft, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "write-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read", "xero.draft.write"],
    });
    const server = createAccountingMcpServer(service, context, undefined, undefined, undefined, {
      unsafeExposeLegacyObjectMutationToolsForTests: true,
    });
    const client = new Client({ name: "write-receipt-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "xero_create_draft_supplier_bill",
      arguments: {
        preparation_id: `xmp_${"a".repeat(32)}`,
        request_id: "11111111-1111-4111-8111-111111111111",
      },
    });

    const auditCallId = withAudit.mock.calls[0]?.[0]?.callId;
    expect(auditCallId).toMatch(/^call_[0-9a-f-]{36}$/);
    expect(result.structuredContent).toEqual({
      result: { ...serviceResult, auditCallId },
    });
  });

  it("returns only whitelisted audit recovery fields when a create-draft write has unknown audit completion", async () => {
    const executePreparedSupplierBillDraft = vi.fn().mockRejectedValue(new AppError(
      "WRITE_RESULT_UNKNOWN",
      "The Xero draft-write result is unknown.",
      {
        httpStatus: 503,
        retryable: false,
        details: {
          providerSecret: "must-not-leak",
          invoiceId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ));
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      callId,
    }: {
      action: () => Promise<unknown>;
      callId: string;
    }) => {
      try {
        return await action();
      } catch (error) {
        const original = error as AppError;
        throw new AppError(original.code, original.message, {
          httpStatus: original.httpStatus,
          retryable: original.retryable,
          details: {
            ...(original.details ?? {}),
            auditCallId: callId,
            auditCompletionStatus: "UNKNOWN",
          },
        });
      }
    });
    const service = { executePreparedSupplierBillDraft, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "write-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read", "xero.draft.write"],
    });
    const server = createAccountingMcpServer(service, context, undefined, undefined, undefined, {
      unsafeExposeLegacyObjectMutationToolsForTests: true,
    });
    const client = new Client({ name: "write-audit-recovery-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "xero_create_draft_supplier_bill",
      arguments: {
        preparation_id: `xmp_${"b".repeat(32)}`,
        request_id: "11111111-1111-4111-8111-111111111111",
      },
    });

    const auditCallId = withAudit.mock.calls[0]?.[0]?.callId;
    expect(auditCallId).toMatch(/^call_[0-9a-f-]{36}$/);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "WRITE_RESULT_UNKNOWN",
        message: "The Xero draft-write result is unknown.",
        retryable: false,
        failure_layer: "PROVIDER_WRITE_OUTCOME",
        provider_mutation_possible: true,
        recovery_action: "READBACK_RECOVERY_ONLY",
        auditCallId,
        auditCompletionStatus: "UNKNOWN",
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("must-not-leak");
    expect(JSON.stringify(result.structuredContent)).not.toContain("invoiceId");
    expect(executePreparedSupplierBillDraft).toHaveBeenCalledOnce();
  });

  it("routes parsed history filters and exact generic invoice reads through audit", async () => {
    const listInvoices = vi.fn().mockResolvedValue({ invoices: [], pagination: {} });
    const getInvoice = vi.fn().mockResolvedValue({
      invoiceId: "11111111-1111-4111-8111-111111111111",
      type: "ACCREC",
    });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({
        actorId: "extended-read-actor",
        tenantId: "tenant-extended",
        tenantName: "Extended Read Company",
      });
      return action();
    });
    const service = { listInvoices, getInvoice, withAudit } as unknown as AccountingService;
    const context = testContext();
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "history-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    await client.callTool({
      name: "xero_list_invoices",
      arguments: { type: "ACCREC", statuses: ["AUTHORISED"], page_size: 20 },
    });
    await client.callTool({
      name: "xero_get_invoice",
      arguments: {
        invoice_id: "11111111-1111-4111-8111-111111111111",
        type: "ACCREC",
      },
    });

    expect(listInvoices).toHaveBeenCalledWith(context, {
      type: "ACCREC",
      statuses: ["AUTHORISED"],
      page: 1,
      page_size: 20,
      include_archived: false,
      order: "DATE_DESC",
    });
    expect(getInvoice).toHaveBeenCalledWith(context, {
      invoice_id: "11111111-1111-4111-8111-111111111111",
      type: "ACCREC",
    });
    expect(withAudit).toHaveBeenCalledTimes(2);
    expect(withAudit.mock.calls.map(([call]) => call.toolName)).toEqual([
      "xero_list_invoices",
      "xero_get_invoice",
    ]);
    expect(withAudit.mock.calls.map(([call]) => call.actorId)).toEqual([
      "test-actor",
      "test-actor",
    ]);
    expect(withAudit.mock.calls.map(([call]) => call.principal)).toEqual([
      context,
      context,
    ]);
  });

  it("routes credit-note and payment history through xero.read and audit", async () => {
    const listCreditNotes = vi.fn().mockResolvedValue({ creditNotes: [], pagination: {} });
    const listPayments = vi.fn().mockResolvedValue({ payments: [], pagination: {} });
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({ actorId: "read-only-actor", tenantId: "tenant-history", tenantName: "History Company" });
      return action();
    });
    const service = { listCreditNotes, listPayments, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "read-only-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "credit-payment-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    await client.callTool({
      name: "xero_list_credit_notes",
      arguments: { type: "ACCPAYCREDIT", status: "PAID", page_size: 20 },
    });
    await client.callTool({
      name: "xero_list_payments",
      arguments: { type: "ACCPAYPAYMENT", status: "AUTHORISED", page_size: 20 },
    });

    expect(listCreditNotes).toHaveBeenCalledWith(context, {
      type: "ACCPAYCREDIT",
      status: "PAID",
      page: 1,
      page_size: 20,
    });
    expect(listPayments).toHaveBeenCalledWith(context, {
      type: "ACCPAYPAYMENT",
      status: "AUTHORISED",
      page: 1,
      page_size: 20,
    });
    expect(withAudit.mock.calls.map(([call]) => call.toolName)).toEqual([
      "xero_list_credit_notes",
      "xero_list_payments",
    ]);
  });

  it("routes all ten extended reads through xero.read audit with read-only idempotent annotations", async () => {
    const ids = {
      quote: "11111111-1111-4111-8111-111111111111",
      purchaseOrder: "22222222-2222-4222-8222-222222222222",
      manualJournal: "33333333-3333-4333-8333-333333333333",
      item: "44444444-4444-4444-8444-444444444444",
      bankTransaction: "55555555-5555-4555-8555-555555555555",
    };
    const methods = {
      listQuotes: vi.fn().mockResolvedValue({ quotes: [], pagination: {} }),
      getQuote: vi.fn().mockResolvedValue({ quoteId: ids.quote }),
      listPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [], pagination: {} }),
      getPurchaseOrder: vi.fn().mockResolvedValue({ purchaseOrderId: ids.purchaseOrder }),
      listManualJournals: vi.fn().mockResolvedValue({ manualJournals: [], pagination: {} }),
      getManualJournal: vi.fn().mockResolvedValue({ manualJournalId: ids.manualJournal }),
      listItems: vi.fn().mockResolvedValue({ items: [], pagination: {} }),
      getItem: vi.fn().mockResolvedValue({ itemId: ids.item }),
      listBankTransactions: vi.fn().mockResolvedValue({ bankTransactions: [], pagination: {} }),
      getBankTransaction: vi.fn().mockResolvedValue({ bankTransactionId: ids.bankTransaction }),
    };
    const withAudit = vi.fn().mockImplementation(async ({
      action,
      onResolvedContext,
    }: {
      action: () => Promise<unknown>;
      onResolvedContext?: (resolved: { actorId: string; tenantId: string; tenantName: string }) => void;
    }) => {
      onResolvedContext?.({
        actorId: "extended-read-actor",
        tenantId: "tenant-extended",
        tenantName: "Extended Read Company",
      });
      return action();
    });
    const service = { ...methods, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "extended-read-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "extended-read-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const names = [
      "xero_list_quotes",
      "xero_get_quote",
      "xero_list_purchase_orders",
      "xero_get_purchase_order",
      "xero_list_manual_journals",
      "xero_get_manual_journal",
      "xero_list_items",
      "xero_get_item",
      "xero_list_bank_transactions",
      "xero_get_bank_transaction",
    ];
    const advertised = await client.listTools();
    for (const name of names) {
      expect(advertised.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    }

    await client.callTool({ name: "xero_list_quotes", arguments: {} });
    await client.callTool({ name: "xero_get_quote", arguments: { quote_id: ids.quote } });
    await client.callTool({ name: "xero_list_purchase_orders", arguments: {} });
    await client.callTool({
      name: "xero_get_purchase_order",
      arguments: { purchase_order_id: ids.purchaseOrder },
    });
    await client.callTool({ name: "xero_list_manual_journals", arguments: {} });
    await client.callTool({
      name: "xero_get_manual_journal",
      arguments: { manual_journal_id: ids.manualJournal },
    });
    await client.callTool({ name: "xero_list_items", arguments: {} });
    await client.callTool({ name: "xero_get_item", arguments: { item_id: ids.item } });
    await client.callTool({ name: "xero_list_bank_transactions", arguments: {} });
    await client.callTool({
      name: "xero_get_bank_transaction",
      arguments: { bank_transaction_id: ids.bankTransaction },
    });

    expect(withAudit.mock.calls.map(([call]) => call.toolName)).toEqual(names);
    expect(withAudit.mock.calls.every(([call]) => call.principal === context)).toBe(true);
    expect(withAudit.mock.calls[1]?.[0]?.recordId?.({ quoteId: ids.quote })).toBe(ids.quote);
    expect(withAudit.mock.calls[3]?.[0]?.recordId?.({ purchaseOrderId: ids.purchaseOrder })).toBe(ids.purchaseOrder);
    expect(withAudit.mock.calls[5]?.[0]?.recordId?.({ manualJournalId: ids.manualJournal })).toBe(ids.manualJournal);
    expect(withAudit.mock.calls[7]?.[0]?.recordId?.({ itemId: ids.item })).toBe(ids.item);
    expect(withAudit.mock.calls[9]?.[0]?.recordId?.({ bankTransactionId: ids.bankTransaction })).toBe(ids.bankTransaction);
    expect(methods.listQuotes).toHaveBeenCalledWith(context, { page: 1, page_size: 50, sort: "DATE_DESC" });
    expect(methods.listItems).toHaveBeenCalledWith(context, { page: 1, page_size: 50, sort: "CODE_ASC" });
    expect(methods.getBankTransaction).toHaveBeenCalledWith(context, { bank_transaction_id: ids.bankTransaction });
  });

  it("routes all twelve controlled extension tools through reviewed stateful-prepare and execute boundaries", async () => {
    const ids = {
      contact: "11111111-1111-4111-8111-111111111111",
      item: "22222222-2222-4222-8222-222222222222",
      creditNote: "33333333-3333-4333-8333-333333333333",
      manualJournal: "44444444-4444-4444-8444-444444444444",
      accountDebit: "55555555-5555-4555-8555-555555555555",
      accountCredit: "66666666-6666-4666-8666-666666666666",
    };
    const prepareResult = { state: "PREPARED", preparation_id: `xmp_${"a".repeat(32)}` };
    const methods = {
      prepareCreditNoteDraft: vi.fn().mockResolvedValue(prepareResult),
      createCreditNoteDraft: vi.fn().mockResolvedValue({
        state: "DRAFT_READBACK_VERIFIED",
        xero_object_id: ids.creditNote,
      }),
      prepareManualJournalDraft: vi.fn().mockResolvedValue(prepareResult),
      createManualJournalDraft: vi.fn().mockResolvedValue({
        state: "DRAFT_READBACK_VERIFIED",
        xero_object_id: ids.manualJournal,
      }),
      prepareContactCreate: vi.fn().mockResolvedValue(prepareResult),
      createContact: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED", xero_object_id: ids.contact }),
      prepareContactUpdate: vi.fn().mockResolvedValue(prepareResult),
      updateContact: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED", xero_object_id: ids.contact }),
      prepareItemCreate: vi.fn().mockResolvedValue(prepareResult),
      createItem: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED", xero_object_id: ids.item }),
      prepareItemUpdate: vi.fn().mockResolvedValue(prepareResult),
      updateItem: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED", xero_object_id: ids.item }),
    };
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const service = { ...methods, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "controlled-extension-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read", "xero.draft.write"],
    });
    const server = createAccountingMcpServer(service, context, undefined, undefined, undefined, {
      unsafeExposeLegacyObjectMutationToolsForTests: true,
    });
    const client = new Client({ name: "controlled-extension-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const prepareTools = [
      "xero_prepare_credit_note_draft",
      "xero_prepare_manual_journal_draft",
      "xero_prepare_contact_create",
      "xero_prepare_contact_update",
      "xero_prepare_item_create",
      "xero_prepare_item_update",
    ];
    const executeTools = [
      "xero_create_credit_note_draft",
      "xero_create_manual_journal_draft",
      "xero_create_contact",
      "xero_update_contact",
      "xero_create_item",
      "xero_update_item",
    ];
    const advertised = await client.listTools();
    for (const name of prepareTools) {
      expect(advertised.tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    for (const name of executeTools) {
      expect(advertised.tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
      });
    }

    const source = { source_ref: "work-material:controlled-extension", source_unit_key: "page:1" };
    const execution = {
      preparation_id: `xmp_${"a".repeat(32)}`,
      request_id: "request-controlled-001",
    };
    const calls = [
      client.callTool({
        name: "xero_prepare_credit_note_draft",
        arguments: {
          ...source,
          reason: "Customer pricing correction",
          credit_note_type: "ACCRECCREDIT",
          contact_id: ids.contact,
          credit_note_date: "2026-08-07",
          currency: "SGD",
          reference: "CN-DEMO-001",
          authoritative_provider_field: "REFERENCE",
          line_amount_type: "Exclusive",
          lines: [{
            description: "Controlled correction",
            quantity: 1,
            unit_amount: 10,
            account_id: ids.accountDebit,
            account_code: "200",
            tax_type: "NONE",
          }],
        },
      }),
      client.callTool({ name: "xero_create_credit_note_draft", arguments: execution }),
      client.callTool({
        name: "xero_prepare_manual_journal_draft",
        arguments: {
          ...source,
          journal_date: "2026-08-07",
          narration: "Controlled reclassification",
          lines: [
            { account_id: ids.accountDebit, account_code: "400", description: "Debit", line_amount: 10 },
            { account_id: ids.accountCredit, account_code: "500", description: "Credit", line_amount: -10 },
          ],
        },
      }),
      client.callTool({ name: "xero_create_manual_journal_draft", arguments: execution }),
      client.callTool({
        name: "xero_prepare_contact_create",
        arguments: { ...source, name: "Northwind Singapore", email: "accounts@northwind.example" },
      }),
      client.callTool({ name: "xero_create_contact", arguments: execution }),
      client.callTool({
        name: "xero_prepare_contact_update",
        arguments: { ...source, contact_id: ids.contact, patch: { name: "Northwind Singapore Pte Ltd" } },
      }),
      client.callTool({ name: "xero_update_contact", arguments: execution }),
      client.callTool({
        name: "xero_prepare_item_create",
        arguments: { ...source, code: "CONSULT-01", name: "Consulting service" },
      }),
      client.callTool({ name: "xero_create_item", arguments: execution }),
      client.callTool({
        name: "xero_prepare_item_update",
        arguments: { ...source, item_id: ids.item, patch: { name: "Consulting services" } },
      }),
      client.callTool({ name: "xero_update_item", arguments: execution }),
    ];
    const results = await Promise.all(calls);

    expect(
      results.every((result) => result.isError !== true),
      JSON.stringify(results, null, 2),
    ).toBe(true);
    expect(withAudit.mock.calls.map(([call]) => call.toolName).sort()).toEqual([
      "xero_prepare_credit_note_draft",
      "xero_create_credit_note_draft",
      "xero_prepare_manual_journal_draft",
      "xero_create_manual_journal_draft",
      "xero_prepare_contact_create",
      "xero_create_contact",
      "xero_prepare_contact_update",
      "xero_update_contact",
      "xero_prepare_item_create",
      "xero_create_item",
      "xero_prepare_item_update",
      "xero_update_item",
    ].sort());
    expect(Object.values(methods).every((method) => method.mock.calls.length === 1)).toBe(true);
  });

  it("denies extended reads when xero.read is absent", async () => {
    const listQuotes = vi.fn().mockResolvedValue({ quotes: [], pagination: {} });
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const service = { listQuotes, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "no-read-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: [],
    });
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "extended-read-scope-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "xero_list_quotes", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCOPE_MISSING",
        failure_layer: "MCP_SCOPE",
        recovery_action: "REAUTHORISE_MCP_SCOPE",
        reason_codes: ["MISSING_MCP_SCOPE"],
      },
    });
    expect(listQuotes).not.toHaveBeenCalled();
  });

  it("denies draft writes when the resolved installation has only xero.read", async () => {
    const executePreparedSupplierBillDraft = vi.fn().mockResolvedValue({ invoiceId: "should-not-run" });
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const service = { executePreparedSupplierBillDraft, withAudit } as unknown as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "read-only-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes: ["xero.read"],
    });
    const server = createAccountingMcpServer(service, context, undefined, undefined, undefined, {
      unsafeExposeLegacyObjectMutationToolsForTests: true,
    });
    const client = new Client({ name: "scope-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "xero_create_draft_supplier_bill",
      arguments: {
        preparation_id: `xmp_${"c".repeat(32)}`,
        request_id: "11111111-1111-4111-8111-111111111111",
      },
    });

    expect(result.isError).toBe(true);
    const firstContent = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(firstContent?.type).toBe("text");
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCOPE_MISSING",
        failure_layer: "MCP_SCOPE",
        recovery_action: "REAUTHORISE_MCP_SCOPE",
        reason_codes: ["MISSING_MCP_SCOPE"],
      },
    });
    expect(withAudit).toHaveBeenCalledOnce();
    expect(executePreparedSupplierBillDraft).not.toHaveBeenCalled();
  });
});
