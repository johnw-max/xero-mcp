import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppError, toSafeError } from "../errors.js";
import type { RequestContext } from "../security/requestContext.js";
import type { QuickBooksWorkflowService } from "./service.js";
import {
  quickBooksGetBillSchema,
  quickBooksHashSourceDocumentSchema,
  quickBooksGetTransactionSchema,
  quickBooksListItemsSchema,
  quickBooksListBillsSchema,
  quickBooksListTransactionsSchema,
  quickBooksNoInputSchema,
  quickBooksPrepareSupplierBillSchema,
  quickBooksSearchVendorsSchema,
  quickBooksSearchCustomersSchema,
  quickBooksRunReportSchema,
  quickBooksTrialBalanceSchema,
} from "./schemas.js";

export const QUICKBOOKS_RELEASE_VERSION = "0.2.12";

export const QUICKBOOKS_TOOL_ALLOWLIST = [
  "quickbooks_connection_status",
  "quickbooks_get_company",
  "quickbooks_list_accounts",
  "quickbooks_list_tax_codes",
  "quickbooks_search_vendors",
  "quickbooks_search_customers",
  "quickbooks_list_items",
  "quickbooks_list_bills",
  "quickbooks_get_bill",
  "quickbooks_list_transactions",
  "quickbooks_get_transaction",
  "quickbooks_run_report",
  "quickbooks_hash_source_document",
  "quickbooks_prepare_supplier_bill",
  "quickbooks_get_trial_balance",
] as const;

function success(value: unknown): CallToolResult {
  const payload = { result: value };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function failure(error: unknown): CallToolResult {
  const safe = toSafeError(error);
  const payload = {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function scoped<T>(options: {
  context: RequestContext;
  requiredScope: "quickbooks.read" | "quickbooks.bill.prepare";
  action: () => Promise<T>;
}): Promise<CallToolResult> {
  try {
    if (!options.context.scopes.includes(options.requiredScope)) {
      throw new AppError("FORBIDDEN", `This MCP installation does not grant ${options.requiredScope}.`, {
        httpStatus: 403,
      });
    }
    return success(await options.action());
  } catch (error) {
    return failure(error);
  }
}

export function createQuickBooksMcpServer(
  service: QuickBooksWorkflowService,
  context: RequestContext,
): McpServer {
  const actorId = context.actorId;
  const server = new McpServer(
    { name: "zcloak-quickbooks-accounting-mcp", version: QUICKBOOKS_RELEASE_VERSION },
    { capabilities: { logging: {} } },
  );

  server.registerTool("quickbooks_connection_status", {
    title: "QuickBooks connection status",
    description: "Returns the server-bound QuickBooks company without exposing OAuth credentials. It also returns a short-lived, one-time Intuit authorization link. When already connected, completing that link replaces this MCP installation's current company instead of adding a second company.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  }, async () => scoped({ context, requiredScope: "quickbooks.read", action: () => service.connectionStatus(actorId) }));

  server.registerTool("quickbooks_get_company", {
    title: "Get QuickBooks company",
    description: "Reads the exact QuickBooks company bound to this Agent installation.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async () => scoped({ context, requiredScope: "quickbooks.read", action: () => service.getCompany(actorId) }));

  server.registerTool("quickbooks_list_accounts", {
    title: "List QuickBooks accounts",
    description: "Lists active accounts from the bound QuickBooks company.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async () => scoped({ context, requiredScope: "quickbooks.read", action: () => service.listAccounts(actorId) }));

  server.registerTool("quickbooks_list_tax_codes", {
    title: "List QuickBooks tax codes",
    description: "Lists active tax codes available in the bound QuickBooks company.",
    inputSchema: quickBooksNoInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async () => scoped({ context, requiredScope: "quickbooks.read", action: () => service.listTaxCodes(actorId) }));

  server.registerTool("quickbooks_search_vendors", {
    title: "Search QuickBooks vendors",
    description: "Searches active vendors using a bounded text query and returns searchWindow evidence. If complete=false, disclose the requested-limit or 10,000-record scan boundary instead of claiming exhaustive results.",
    inputSchema: quickBooksSearchVendorsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.searchVendors(actorId, input),
  }));

  server.registerTool("quickbooks_search_customers", {
    title: "Search QuickBooks customers",
    description: "Searches active customers in the bound QuickBooks company by name or email and returns searchWindow evidence. If complete=false, do not claim exhaustive results.",
    inputSchema: quickBooksSearchCustomersSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.searchCustomers(actorId, input),
  }));

  server.registerTool("quickbooks_list_items", {
    title: "List QuickBooks products and services",
    description: "Lists active products and services used for sales and purchasing analysis. It pages through QuickBooks instead of silently returning only the first 1,000 records.",
    inputSchema: quickBooksListItemsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async () => scoped({ context, requiredScope: "quickbooks.read", action: () => service.listItems(actorId) }));

  server.registerTool("quickbooks_list_bills", {
    title: "List QuickBooks bills",
    description: "Lists bounded historical supplier Bills for accounting analysis.",
    inputSchema: quickBooksListBillsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.listBills(actorId, input),
  }));

  server.registerTool("quickbooks_get_bill", {
    title: "Get exact QuickBooks bill",
    description: "Reads one supplier Bill by its exact QuickBooks Id.",
    inputSchema: quickBooksGetBillSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.getBill(actorId, input),
  }));

  server.registerTool("quickbooks_list_transactions", {
    title: "List QuickBooks accounting transactions",
    description: "Lists bounded invoices, payments, purchases, bill payments, journal entries, credits, or sales receipts. Supports customer/vendor filtering for compatible transaction types and open_only for invoices.",
    inputSchema: quickBooksListTransactionsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.listTransactions(actorId, input),
  }));

  server.registerTool("quickbooks_get_transaction", {
    title: "Get an exact QuickBooks accounting transaction",
    description: "Reads one exact transaction by supported entity type and QuickBooks Id.",
    inputSchema: quickBooksGetTransactionSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.getTransaction(actorId, input),
  }));

  server.registerTool("quickbooks_run_report", {
    title: "Run a QuickBooks financial report",
    description: "Runs a bounded standard report such as Profit and Loss, Balance Sheet, cash flow, aging, balances, expenses, general ledger, or trial balance. Use either as_of_date or a start/end period, never both. Customer and vendor filters are accepted only by compatible reports. Inspect zcloakReportWindow before claiming completeness.",
    inputSchema: quickBooksRunReportSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.runReport(actorId, input),
  }));

  server.registerTool("quickbooks_hash_source_document", {
    title: "Hash supplied accounting source text",
    description: "Computes a SHA-256 text fingerprint from the exact UTF-8 text supplied by the Agent. This does not read or verify original PDF/image bytes, and it does not prove the identity of the uploaded file. Copy the returned 64-character sha256 and evidenceType exactly into quickbooks_prepare_supplier_bill. The text is limited to 256 KiB and is not stored by this QuickBooks MCP service; upstream host retention is outside this tool's control.",
    inputSchema: quickBooksHashSourceDocumentSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.bill.prepare",
    action: async () => service.hashSourceDocument(input),
  }));

  server.registerTool("quickbooks_prepare_supplier_bill", {
    title: "Prepare a QuickBooks supplier bill for review",
    description: "Validates references and totals, checks both local pending requests and existing QuickBooks Bills for the same vendor document number, then creates a local review request only. It does not write to QuickBooks until a human approves outside Agent tools. First call quickbooks_hash_source_document with the exact supplied source text; copy its 64-character sha256 into source_sha256 and its evidenceType into source_digest_provenance. Never invent, manually calculate, or truncate a digest. QuickBooks doc_number is limited to 21 characters: never silently truncate it; for a longer number omit doc_number, explain it in missing_doc_number_reason, and preserve the full original in memo. For NON/no-tax bills, use global_tax_calculation=NotApplicable, tax_total=0, and omit line tax_code_id; tax_code_id otherwise must be the numeric Id returned by quickbooks_list_tax_codes.",
    inputSchema: quickBooksPrepareSupplierBillSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.bill.prepare",
    action: () => service.prepareSupplierBill(actorId, input),
  }));

  server.registerTool("quickbooks_get_trial_balance", {
    title: "Get QuickBooks Trial Balance",
    description: "Reads the QuickBooks Trial Balance for post-write ledger evidence.",
    inputSchema: quickBooksTrialBalanceSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  }, async (input) => scoped({
    context,
    requiredScope: "quickbooks.read",
    action: () => service.getTrialBalance(actorId, input),
  }));

  return server;
}
