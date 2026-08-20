import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ReportAttribute,
  ReportCell,
  ReportRows,
  ReportWithRow,
  ReportWithRows,
} from "xero-node";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../src/db/repository.js";
import type { Logger } from "../src/logging.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import type { AccountingProvider } from "../src/providers/types.js";
import { hashObject } from "../src/security/hash.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import type { ConnectionTicketService as ConnectionTicketServiceType } from "../src/services/connectionTicketService.js";
import {
  boundXeroTrialBalanceForAgent,
  createXeroTrialBalanceCallToolResult,
  XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES,
  XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES,
  XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES,
  XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
  XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES,
  XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES,
  type XeroTrialBalanceAgentResult,
} from "../src/services/xeroTrialBalanceBounds.js";
import {
  XERO_READ_FACT_PATH_MAX_UTF8_BYTES,
  XERO_READ_FACT_PATHS_MAX_JSON_UTF8_BYTES,
} from "../src/mcp/xeroReadEvidence.js";

const noOpLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function serviceWithProvider(provider: Partial<AccountingProvider>): AccountingService {
  return new AccountingService({
    repository: {} as AccountingRepository,
    provider: provider as AccountingProvider,
    config: {
      publicBaseUrl: "https://mcp.example.test",
      xeroWriteEnabled: false,
    } as Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">,
    logger: noOpLogger,
    connectionTickets: {} as ConnectionTicketServiceType,
  });
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function reportCell(value: string, accountName?: string): ReportCell {
  const cell = new ReportCell();
  cell.value = value;
  if (accountName) {
    const attribute = new ReportAttribute();
    attribute.id = "account";
    attribute.value = accountName;
    cell.attributes = [attribute];
  }
  return cell;
}

function xeroReport(rowCount = 2): ReportWithRows {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const row = new ReportRows();
    row.rowType = "Row" as never;
    row.cells = [
      reportCell(index % 2 === 0 ? "485" : "800", index % 2 === 0 ? "Subscriptions" : "Accounts Payable"),
      reportCell(index % 2 === 0 ? "100.00" : "0.00"),
      reportCell(index % 2 === 0 ? "0.00" : "100.00"),
    ];
    return row;
  });
  const report = new ReportWithRow();
  report.reportID = "TrialBalance";
  report.reportName = "Trial Balance";
  report.reportTitle = "Trial Balance";
  report.reportType = "TrialBalance";
  report.reportTitles = ["Trial Balance", "zcloak", "6 August 2026"];
  report.reportDate = "6 August 2026";
  report.updatedDateUTC = new Date("2026-08-06T00:00:00.000Z");
  report.rows = rows;
  const root = new ReportWithRows();
  root.reports = [report];
  return root;
}

function parsedModelResult(callToolResult: { content?: unknown }): XeroTrialBalanceAgentResult {
  const block = Array.isArray(callToolResult.content) ? callToolResult.content[0] : undefined;
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
    throw new Error("Expected one text content block.");
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Expected text MCP content.");
  return (JSON.parse(text) as { result: XeroTrialBalanceAgentResult }).result;
}

function parsedModelPayload(callToolResult: { content?: unknown }): Record<string, unknown> {
  const block = Array.isArray(callToolResult.content) ? callToolResult.content[0] : undefined;
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
    throw new Error("Expected one text content block.");
  }
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Expected text MCP content.");
  return JSON.parse(text) as Record<string, unknown>;
}

function expectTransportContract(result: XeroTrialBalanceAgentResult): void {
  const callToolResult = createXeroTrialBalanceCallToolResult(result);
  const text = callToolResult.content[0].text;
  expect(Object.hasOwn(callToolResult, "structuredContent")).toBe(false);
  expect(Buffer.byteLength(text, "utf8")).toBe(result.pagination.modelTextUtf8Bytes);
  expect(serializedBytes(callToolResult)).toBe(result.pagination.callToolResultUtf8Bytes);
  expect(result.pagination.modelTextUtf8Bytes).toBeLessThanOrEqual(XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES);
  expect(result.pagination.callToolResultUtf8Bytes).toBeLessThanOrEqual(
    XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES,
  );
}

async function invokeTrialBalanceOverMcp(
  providerReport: Record<string, unknown>,
  input: { date?: string } = { date: "2026-08-06" },
) {
  const repository = new InMemoryAccountingRepository();
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const getTrialBalance = vi.fn().mockResolvedValue(providerReport);
  const provider = {
    getTrialBalance,
    resolveContext: vi.fn().mockResolvedValue({
      actorId: "trial-balance-transport-test",
      tenantId,
      tenantName: "Bound Trial Balance Company",
    }),
  } as unknown as AccountingProvider;
  const service = new AccountingService({
    repository,
    provider,
    config: {
      publicBaseUrl: "https://mcp.transport.test",
      xeroWriteEnabled: false,
    } as Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">,
    logger: noOpLogger,
    connectionTickets: new ConnectionTicketService(repository, "https://mcp.transport.test"),
  });
  const context = createLegacySharedBearerRequestContext({
    actorId: "trial-balance-transport-test",
    audience: "https://mcp.transport.test/mcp",
    scopes: ["xero.read"],
  });
  const server = createAccountingMcpServer(service, context);
  const client = new Client({ name: "trial-balance-transport-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const callToolResult = await client.callTool({ name: "xero_get_trial_balance", arguments: input });
    return { callToolResult, repository, getTrialBalance };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("Xero Trial Balance Agent bounds", () => {
  it("preserves the real xero-node report shape and adds an honest deterministic contract", async () => {
    const providerReport = xeroReport();
    const originalJson = JSON.stringify(providerReport);
    const getTrialBalance = vi.fn().mockResolvedValue(providerReport);
    const service = serviceWithProvider({ getTrialBalance });

    const result = await service.getTrialBalance("actor-a", { date: "2026-08-06" });

    expect(getTrialBalance).toHaveBeenCalledWith("actor-a", "2026-08-06");
    expect(result.reports).toEqual(JSON.parse(originalJson).reports);
    expect(result.pagination).toMatchObject({
      contractVersion: "2.0",
      scope: "MCP_BOUNDED_TRIAL_BALANCE_VIEW",
      maxModelTextUtf8Bytes: 96 * 1_024,
      maxCallToolResultUtf8Bytes: 128 * 1_024,
      maxReturnedVisitedJsonNodes: 5_000,
      maxReturnedNestingDepth: 64,
      mcpTruncated: false,
      truncationReasons: [],
      sourceMeasurement: {
        status: "EXACT",
        serialization: "EXACT_JSON",
        utf8Bytes: { relation: "EXACT", value: serializedBytes(providerReport) },
        visitedJsonNodes: { relation: "EXACT" },
        stopReasons: [],
      },
      providerCompleteness: {
        status: "NOT_VERIFIED",
        scope: "SINGLE_XERO_PROVIDER_RESPONSE",
        auditCompleteness: "NOT_ESTABLISHED",
      },
    });
    expect(result.pagination.returnedVisitedJsonNodes).toBe(
      result.pagination.sourceMeasurement.visitedJsonNodes.value,
    );
    expect(JSON.stringify(providerReport)).toBe(originalJson);
    expectTransportContract(result);
  });

  it("caps a pressure report expressed in the real Xero rows/cells/attributes shape", () => {
    const providerReport = xeroReport(6_000);
    const originalRows = providerReport.reports?.[0]?.rows;

    const result = boundXeroTrialBalanceForAgent(providerReport as unknown as Record<string, unknown>);
    const returnedRows = (result.reports as Array<{ rows?: unknown[] }> | undefined)?.[0]?.rows ?? [];

    expect(originalRows).toHaveLength(6_000);
    expect(returnedRows.length).toBeGreaterThan(0);
    expect(returnedRows.length).toBeLessThan(6_000);
    expect(result.pagination.returnedVisitedJsonNodes).toBeLessThanOrEqual(
      XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
    );
    expect(result.pagination.mcpTruncated).toBe(true);
    expect(result.pagination.truncationReasons).toContain("MAX_RETURNED_VISITED_JSON_NODES");
    expect(result.pagination.sourceMeasurement.status).toBe("LOWER_BOUND");
    expect(result.pagination.sourceMeasurement.visitedJsonNodes.relation).toBe("AT_LEAST");
    expectTransportContract(result);
  });

  it("enforces text and complete CallToolResult budgets for multibyte and escape-heavy values", () => {
    const pressure = '会计📒借方贷方\\"'.repeat(1_500);
    const providerReport = xeroReport(250);
    for (const row of providerReport.reports?.[0]?.rows ?? []) {
      row.title = pressure;
    }

    const result = boundXeroTrialBalanceForAgent(providerReport as unknown as Record<string, unknown>);

    expect(result.pagination.mcpTruncated).toBe(true);
    expect(result.pagination.truncationReasons).toEqual(expect.arrayContaining([
      "MAX_MODEL_TEXT_UTF8_BYTES",
      "MAX_CALL_TOOL_RESULT_UTF8_BYTES",
    ]));
    expectTransportContract(result);
    expect(providerReport.reports?.[0]?.rows?.[0]?.title).toBe(pressure);
  });

  it("uses lazy bounded source inspection for a million-element sparse array", () => {
    const providerReport: Record<string, unknown> = { rows: new Array(1_000_000) };

    const result = boundXeroTrialBalanceForAgent(providerReport);

    expect(result.pagination.sourceMeasurement).toMatchObject({
      status: "LOWER_BOUND",
      serialization: "NOT_FULLY_INSPECTED",
      inspectedJsonNodes: XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_JSON_NODES,
      visitedJsonNodes: { relation: "AT_LEAST" },
      stopReasons: ["MAX_INSPECTED_JSON_NODES"],
    });
    expect(result.pagination.truncationReasons).toContain("SOURCE_INSPECTION_LIMIT");
    expect(result.pagination.returnedVisitedJsonNodes).toBeLessThanOrEqual(
      XERO_TRIAL_BALANCE_MAX_RETURNED_VISITED_JSON_NODES,
    );
    expectTransportContract(result);
  });

  it("stops source string measurement at a hard byte limit and reports AT_LEAST", () => {
    const providerReport = { note: "x".repeat(XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES * 2) };

    const result = boundXeroTrialBalanceForAgent(providerReport);

    expect(result.pagination.sourceMeasurement).toMatchObject({
      status: "LOWER_BOUND",
      serialization: "NOT_FULLY_INSPECTED",
      utf8Bytes: {
        relation: "AT_LEAST",
        value: XERO_TRIAL_BALANCE_MAX_SOURCE_INSPECTED_UTF8_BYTES,
      },
      stopReasons: ["MAX_INSPECTED_UTF8_BYTES"],
    });
    expectTransportContract(result);
  });

  it("projects an invalid Xero Date as JSON null and preserves an own __proto__ field", () => {
    const providerReport = xeroReport(1) as unknown as Record<string, unknown>;
    const reports = providerReport.reports as Array<Record<string, unknown>>;
    reports[0]!.updatedDateUTC = new Date("not-a-date");
    Object.defineProperty(providerReport, "__proto__", {
      value: { marker: "preserved" },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const result = boundXeroTrialBalanceForAgent(providerReport);

    expect((result.reports as Array<Record<string, unknown>>)[0]?.updatedDateUTC).toBeNull();
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ marker: "preserved" });
    expect(result.pagination.mcpTruncated).toBe(false);
    expectTransportContract(result);
  });

  it("handles deeply nested and circular adversarial values without unbounded inspection", () => {
    const providerReport: Record<string, unknown> = {};
    let cursor = providerReport;
    for (let depth = 0; depth < 10_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.loop = providerReport;

    const result = boundXeroTrialBalanceForAgent(providerReport);

    expect(result.pagination.mcpTruncated).toBe(true);
    expect(result.pagination.truncationReasons).toEqual(expect.arrayContaining([
      "MAX_RETURNED_NESTING_DEPTH",
      "SOURCE_INSPECTION_LIMIT",
    ]));
    expect(result.pagination.sourceMeasurement).toMatchObject({
      status: "LOWER_BOUND",
      serialization: "NOT_FULLY_INSPECTED",
      stopReasons: ["MAX_INSPECTED_NESTING_DEPTH"],
    });
    expect(cursor.loop).toBe(providerReport);
    expectTransportContract(result);
  });

  it("returns byte-for-byte deterministic output for the same Provider response", () => {
    const providerReport = xeroReport(400);

    const first = boundXeroTrialBalanceForAgent(providerReport as unknown as Record<string, unknown>);
    const second = boundXeroTrialBalanceForAgent(providerReport as unknown as Record<string, unknown>);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(createXeroTrialBalanceCallToolResult(second)).toEqual(createXeroTrialBalanceCallToolResult(first));
  });
});

describe("Xero Trial Balance real MCP transport", () => {
  it.each([
    ["ASCII", "plain trial balance"],
    ["quotes", 'supplier said "paid"'],
    ["backslash", "C:\\Xero\\TrialBalance"],
    ["CJK", "会计借方贷方"],
    ["emoji", "账本📒✅"],
    ["lone-surrogate", "before-\ud800-after"],
  ])("returns one content-only bounded model for %s", async (_label, specialValue) => {
    const providerReport = xeroReport(3);
    const report = providerReport.reports?.[0];
    if (!report) throw new Error("Missing synthetic Xero report.");
    report.reportTitle = specialValue;

    const { callToolResult, repository } = await invokeTrialBalanceOverMcp(
      providerReport as unknown as Record<string, unknown>,
    );
    const payload = parsedModelPayload(callToolResult);
    const result = parsedModelResult(callToolResult);

    expect(callToolResult.isError).not.toBe(true);
    expect(Object.hasOwn(callToolResult, "structuredContent")).toBe(false);
    expect(callToolResult.content).toHaveLength(1);
    expect((result.reports as Array<{ reportTitle?: string }>)[0]?.reportTitle).toBe(specialValue);
    expect(payload).toMatchObject({
      result_class: "succeeded",
      fact_origin: "MCP_READ",
      source_system: "xero",
      destination_role: "ledger_sor",
      capability_id: "ledger.report.trial_balance.read",
      organisation_display_name: "Bound Trial Balance Company",
      query_bounds: {
        target_scope: "active_server_bound_xero_organisation",
        requested: { date: "2026-08-06" },
        effective_provider_query: {
          paymentsOnly: false,
          date: "2026-08-06",
          date_resolution: "explicit_request_date",
          reproducible_as_of: true,
        },
      },
      completeness: {
        status: "bounded_provider_response",
        scope: "single_xero_provider_response",
      },
    });
    expect(payload.tool_call_or_audit_ref).toMatch(/^call_[0-9a-f-]{36}$/);
    expect(payload.bound_target_ref_safe).toMatch(/^xero-target:[a-f0-9]{32}$/);
    expect(payload.binding_revision).toMatch(/^xero-legacy-binding:[a-f0-9]{32}$/);
    expect(payload.output_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const completed = repository.governanceAuditEvents.find(
      (event) => event.eventId === `${String(payload.tool_call_or_audit_ref)}:completed`,
    );
    expect(completed).toMatchObject({ outcome: "SUCCEEDED" });
    expect(completed?.outputHash).toBe(hashObject(payload));
    expect(payload.output_hash).toBe(`sha256:${hashObject(result)}`);
    expect(payload.fact_paths).toEqual(expect.arrayContaining(["/result/reports", "/result/pagination"]));
    expect(JSON.stringify(payload)).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serializedBytes(callToolResult)).toBe(result.pagination.callToolResultUtf8Bytes);
    expect(result.pagination.callToolResultUtf8Bytes).toBeLessThanOrEqual(
      XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES,
    );
    expect(result.pagination.modelTextUtf8Bytes).toBeLessThanOrEqual(
      XERO_TRIAL_BALANCE_MAX_MODEL_TEXT_UTF8_BYTES,
    );
  });

  it("bounds a nested 90KB future Xero field name and its evidence before success is audited", async () => {
    const providerReport = xeroReport(3);
    const report = providerReport.reports?.[0] as unknown as Record<string, unknown>;
    const longKey = `future-${"k".repeat(90_000)}`;
    Object.defineProperty(report, longKey, {
      value: "future-value",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const { callToolResult, repository } = await invokeTrialBalanceOverMcp(
      providerReport as unknown as Record<string, unknown>,
    );
    const payload = parsedModelPayload(callToolResult);
    const result = parsedModelResult(callToolResult);

    expect(callToolResult.isError).not.toBe(true);
    expect(Object.hasOwn(callToolResult, "structuredContent")).toBe(false);
    expect(result.pagination.mcpTruncated).toBe(true);
    expect(result.pagination.truncationReasons).toContain("MAX_MODEL_TEXT_UTF8_BYTES");
    expect(serializedBytes(callToolResult)).toBe(result.pagination.callToolResultUtf8Bytes);
    expect(result.pagination.callToolResultUtf8Bytes).toBeLessThanOrEqual(
      XERO_TRIAL_BALANCE_MAX_CALL_TOOL_RESULT_UTF8_BYTES,
    );
    const factPaths = payload.fact_paths as string[];
    expect(factPaths.length).toBeGreaterThan(0);
    expect(factPaths.every(
      (path) => Buffer.byteLength(path, "utf8") <= XERO_READ_FACT_PATH_MAX_UTF8_BYTES,
    )).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(factPaths), "utf8")).toBeLessThanOrEqual(
      XERO_READ_FACT_PATHS_MAX_JSON_UTF8_BYTES,
    );
    const fullModelText = (callToolResult.content as Array<{ text: string }>)[0]!.text;
    const bareModelText = JSON.stringify({ result });
    expect(Buffer.byteLength(fullModelText, "utf8") - Buffer.byteLength(bareModelText, "utf8"))
      .toBeLessThanOrEqual(XERO_TRIAL_BALANCE_READ_EVIDENCE_RESERVE_UTF8_BYTES);
    const completed = repository.governanceAuditEvents.find(
      (event) => event.eventId === `${String(payload.tool_call_or_audit_ref)}:completed`,
    );
    expect(completed).toMatchObject({ outcome: "SUCCEEDED", outputHash: hashObject(payload) });
    expect(payload.output_hash).toBe(`sha256:${hashObject(result)}`);
  });

  it("falls back to the valid /result pointer for a 90KB root field name", async () => {
    const providerReport = xeroReport(3) as unknown as Record<string, unknown>;
    const longKey = `future-root-${"k".repeat(90_000)}`;
    Object.defineProperty(providerReport, longKey, {
      value: "future-root-value",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const { callToolResult, repository } = await invokeTrialBalanceOverMcp(providerReport);
    const payload = parsedModelPayload(callToolResult);
    const result = parsedModelResult(callToolResult);

    expect(callToolResult.isError).not.toBe(true);
    expect(payload.fact_paths).toEqual(["/result"]);
    expect((payload.fact_paths as string[]).every(
      (path) => Buffer.byteLength(path, "utf8") <= XERO_READ_FACT_PATH_MAX_UTF8_BYTES,
    )).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload.fact_paths), "utf8")).toBeLessThanOrEqual(
      XERO_READ_FACT_PATHS_MAX_JSON_UTF8_BYTES,
    );
    expect(Object.hasOwn(payload, "result")).toBe(true);
    expect(serializedBytes(callToolResult)).toBe(result.pagination.callToolResultUtf8Bytes);
    const completed = repository.governanceAuditEvents.find(
      (event) => event.eventId === `${String(payload.tool_call_or_audit_ref)}:completed`,
    );
    expect(completed).toMatchObject({ outcome: "SUCCEEDED", outputHash: hashObject(payload) });
    expect(payload.output_hash).toBe(`sha256:${hashObject(result)}`);
  });

  it("marks an omitted report date as an unresolved Provider default while retaining paymentsOnly=false", async () => {
    const { callToolResult, getTrialBalance } = await invokeTrialBalanceOverMcp(
      xeroReport(3) as unknown as Record<string, unknown>,
      {},
    );
    const payload = parsedModelPayload(callToolResult);

    expect(callToolResult.isError).not.toBe(true);
    expect(payload.query_bounds).toMatchObject({
      target_scope: "active_server_bound_xero_organisation",
      requested: {},
      effective_provider_query: {
        paymentsOnly: false,
        date: null,
        date_resolution: "provider_default_unresolved",
        reproducible_as_of: false,
      },
    });
    expect(getTrialBalance.mock.calls[0]?.[1]).toBeUndefined();
  });
});
