import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountingService } from "../src/services/accountingService.js";
import type { XeroAccountingCaseService } from "../src/services/xeroAccountingCaseService.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import {
  normalizeXeroAccountingCaseBusinessIntake,
  type XeroAccountingCaseBusinessIntake,
} from "../src/mcp/xeroAccountingCaseBusinessIntake.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

describe("Agent-facing Xero Accounting Case MCP contract", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function setup(scopes: Array<"xero.read" | "xero.draft.write"> = ["xero.read", "xero.draft.write"]) {
    const context = createLegacySharedBearerRequestContext({
      actorId: "case-contract-actor",
      audience: "https://xero-mcp.example.test/mcp",
      scopes,
    });
    const withAudit = vi.fn().mockImplementation(async ({ action }: { action: () => Promise<unknown> }) => action());
    const accounting = { withAudit } as unknown as AccountingService;
    const cases = {
      prepare: vi.fn().mockResolvedValue({ completion_claim: { ledger_write_claim: "NOT_WRITTEN" } }),
      execute: vi.fn().mockResolvedValue({ completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" } }),
      status: vi.fn().mockResolvedValue({ completion_claim: { ledger_write_claim: "NOT_WRITTEN" } }),
    } as unknown as Pick<XeroAccountingCaseService, "prepare" | "execute" | "status">;
    const server = createAccountingMcpServer(accounting, context, undefined, undefined, cases);
    const client = new Client({ name: "case-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    return { client, cases, withAudit };
  }

  function businessIntake(): XeroAccountingCaseBusinessIntake {
    return {
      case_id: "case-business-intake-001",
      expected_version: 0,
      source_label: "Local Agent synthetic customer invoice",
      source_set_complete: true,
      documents: [{
        document_type: "CUSTOMER_INVOICE",
        reference: "INV-LOCAL-AGENT-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER",
        document_date: "2026-07-20",
        due_date: "2026-08-20",
        currency: "SGD",
        contact: { name: "Exact Customer" },
        line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
        accounting_category: "CONSULTING_REVENUE",
        tax_class: "SG_STANDARD_RATED",
        effective_tax_rate_percent: "9.00",
        transition_review_required: false,
        lines: [{
          description: "咨询服务",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
        }],
        declared_net: "100.00",
        declared_tax: "9.00",
        declared_gross: "109.00",
        document_validity: "TEST_OR_NOT_VALID",
      }],
    };
  }

  it("exposes only three case-level mutation tools and no raw object/manual-journal writer", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "xero_prepare_accounting_case",
      "xero_execute_accounting_case",
      "xero_get_accounting_case_status",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "xero_prepare_manual_journal_draft",
      "xero_create_manual_journal_draft",
      "xero_prepare_supplier_bill_draft",
      "xero_create_draft_supplier_bill",
      "xero_prepare_credit_note_draft",
      "xero_create_credit_note_draft",
      "xero_create_contact",
    ]));
    const prepareTool = tools.find((tool) => tool.name === "xero_prepare_accounting_case");
    const prepareSchema = JSON.stringify(prepareTool?.inputSchema);
    expect(prepareSchema).toContain("source_label");
    expect(prepareSchema).toContain("continuation_token");
    expect(prepareSchema).toContain("documents");
    expect(prepareSchema).toContain("reference_kind");
    expect(prepareSchema).toContain("FORMAL_DOCUMENT_NUMBER");
    expect(prepareSchema).toContain("GENERIC_RECURRING_REFERENCE");
    expect(prepareSchema).toContain("CUSTOMER_INVOICE");
    expect(prepareSchema).toContain("CONSULTING_REVENUE");
    expect(prepareSchema).toContain("SG_STANDARD_RATED");
    for (const forbidden of [
      "tenantId",
      "tenant_id",
      "provider_object_id",
      "xeroContactId",
      "account_id",
      "account_code",
      "accountId",
      "accountCode",
      "canonicalPayload",
      "receipt",
      "mutationRequestId",
    ]) expect(prepareSchema).not.toContain(forbidden);
  });

  it("accepts a simple business document and deterministically derives the internal typed Case", async () => {
    const { client, cases } = await setup();
    const publicInput = businessIntake();
    const accepted = await client.callTool({ name: "xero_prepare_accounting_case", arguments: publicInput });
    expect(accepted.isError).not.toBe(true);
    expect(cases.prepare).toHaveBeenCalledWith(expect.anything(), normalizeXeroAccountingCaseBusinessIntake(publicInput));
    const typed = vi.mocked(cases.prepare).mock.calls[0]![1];
    expect(typed).toMatchObject({
      case_id: publicInput.case_id,
      expected_version: 0,
      sources: [{ label: publicInput.source_label, units: [{ expectedFactKinds: ["NATIVE_DOCUMENT"] }] }],
      facts: [{
        kind: "NATIVE_DOCUMENT",
        documentKind: "INVOICE",
        counterpartyRole: "CUSTOMER",
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        accountingCategory: "CONSULTING_REVENUE",
        taxClass: "SG_STANDARD_RATED",
        effectiveTaxRateBps: 900,
      }],
    });

    for (const injected of [
      { ...publicInput, tenantId: fixture.target.tenantId },
      { ...publicInput, target: fixture.target },
      { ...publicInput, actionId: "manual_journal.create_draft" },
      { ...publicInput, account_id: "33333333-3333-4333-8333-333333333333" },
      { ...publicInput, account_code: "200" },
      { ...publicInput, canonicalPayload: { arbitrary: true } },
      { ...publicInput, receipt: { provider: "injected" } },
    ]) {
      const result = await client.callTool({ name: "xero_prepare_accounting_case", arguments: injected });
      expect(result.isError).toBe(true);
    }

    const withProviderId = structuredClone(publicInput) as XeroAccountingCaseBusinessIntake & {
      documents: Array<XeroAccountingCaseBusinessIntake["documents"][number] & { xero_contact_id?: string }>;
    };
    withProviderId.documents[0]!.xero_contact_id = "11111111-1111-4111-8111-111111111111";
    const rejectedId = await client.callTool({ name: "xero_prepare_accounting_case", arguments: withProviderId });
    expect(rejectedId.isError).toBe(true);

    const withoutReferenceKind = structuredClone(publicInput) as unknown as {
      documents: Array<Record<string, unknown>>;
    };
    delete withoutReferenceKind.documents[0]!.reference_kind;
    const rejectedOmission = await client.callTool({
      name: "xero_prepare_accounting_case",
      arguments: withoutReferenceKind,
    });
    expect(rejectedOmission.isError).toBe(true);
    expect(cases.prepare).toHaveBeenCalledTimes(1);
  });

  it("execute accepts only case, immutable version and idempotent request identity", async () => {
    const { client, cases } = await setup();
    const execution = { case_id: fixture.caseId, case_version: 1, request_id: "execute-case-001" };
    const accepted = await client.callTool({ name: "xero_execute_accounting_case", arguments: execution });
    expect(accepted.isError).not.toBe(true);
    expect(cases.execute).toHaveBeenCalledWith(expect.anything(), execution);

    for (const forbidden of [
      { payload: {} },
      { tenant_id: fixture.target.tenantId },
      { operation_id: "op-injected" },
      { action_id: "manual_journal.create_draft" },
      { confirmation_phrase: "CONFIRM" },
      { validation_receipt: "fake" },
    ]) {
      const result = await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: { ...execution, ...forbidden },
      });
      expect(result.isError).toBe(true);
    }
  });

  it("allows a read-only installation into state-dependent Case execute for GET-only recovery", async () => {
    const { client, cases } = await setup(["xero.read"]);
    const execution = { case_id: fixture.caseId, case_version: 1, request_id: "recover-case-read-only-001" };

    const result = await client.callTool({ name: "xero_execute_accounting_case", arguments: execution });

    expect(result.isError).not.toBe(true);
    expect(cases.execute).toHaveBeenCalledOnce();
    expect(cases.execute).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["xero.read"] }), execution);
  });

  it("rejects Case execute with no read or draft-write scope using the stable MCP scope taxonomy", async () => {
    const { client, cases } = await setup([]);

    const result = await client.callTool({
      name: "xero_execute_accounting_case",
      arguments: { case_id: fixture.caseId, case_version: 1, request_id: "execute-case-no-scope-001" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "SCOPE_MISSING",
        failure_layer: "MCP_SCOPE",
        recovery_action: "REAUTHORISE_MCP_SCOPE",
        reason_codes: ["MISSING_MCP_SCOPE"],
      },
    });
    expect(cases.execute).not.toHaveBeenCalled();
  });
});
