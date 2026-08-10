import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppError, toSafeError } from "../errors.js";
import {
  getContactSchema,
  getInvoiceSchema,
  getSupplierBillSchema,
  listAccountsSchema,
  listContactsSchema,
  listCreditNotesSchema,
  listInvoicesSchema,
  listPaymentsSchema,
  noInputSchema,
  prepareSalesInvoiceDraftSchema,
  prepareSupplierBillDraftSchema,
  searchContactsSchema,
  trialBalanceSchema,
} from "../domain/schemas.js";
import {
  getBankTransactionSchema,
  getItemSchema,
  getManualJournalSchema,
  getPurchaseOrderSchema,
  getQuoteSchema,
  listBankTransactionsSchema,
  listItemsSchema,
  listManualJournalsSchema,
  listPurchaseOrdersSchema,
  listQuotesSchema,
} from "../domain/extendedReadSchemas.js";
import {
  preparePurchaseOrderDraftInputSchema,
  prepareQuoteDraftInputSchema,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import { executePreparedXeroMutationSchema } from "../domain/xeroControlledMutationSchemas.js";
import {
  prepareCreditNoteDraftInputSchema,
  prepareManualJournalDraftInputSchema,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import {
  prepareContactCreateMutationSchema,
  prepareContactUpdateMutationSchema,
  prepareItemCreateMutationSchema,
  prepareItemUpdateMutationSchema,
} from "../domain/xeroContactItemMutationSchemas.js";
import type { AccountingService } from "../services/accountingService.js";
import type { OrganisationSwitchService } from "../services/organisationSwitchService.js";
import { createXeroTrialBalanceCallToolResult } from "../services/xeroTrialBalanceBounds.js";
import type { RequestContext } from "../security/requestContext.js";
import { XERO_RELEASE_VERSION } from "../xeroRelease.js";

function success(value: unknown): CallToolResult {
  const payload = { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(error: unknown): CallToolResult {
  const safe = toSafeError(error);
  const auditCallId = typeof safe.details?.auditCallId === "string"
    ? safe.details.auditCallId
    : undefined;
  const auditCompletionStatus = safe.details?.auditCompletionStatus === "UNKNOWN"
    ? safe.details.auditCompletionStatus
    : undefined;
  const payload = {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      ...(auditCallId ? { auditCallId } : {}),
      ...(auditCompletionStatus ? { auditCompletionStatus } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function audited<T>(options: {
  service: AccountingService;
  context: RequestContext;
  requiredScope: "xero.read" | "xero.draft.write";
  actorId: string;
  toolName: string;
  input: unknown;
  action: () => Promise<T>;
  recordId?: (result: T) => string | undefined;
  formatSuccess?: (result: T, auditCallId: string) => CallToolResult;
}): Promise<CallToolResult> {
  const auditCallId = `call_${randomUUID()}`;
  try {
    const result = await options.service.withAudit({
      callId: auditCallId,
      actorId: options.actorId,
      principal: options.context,
      toolName: options.toolName,
      input: options.input,
      governanceDisposition: options.toolName === "xero_start_organisation_switch" || options.toolName.startsWith("xero_prepare_")
        ? "ESCALATE"
        : options.requiredScope === "xero.draft.write"
          ? "AUTO_EXECUTE"
          : "OBSERVE",
      action: () => {
        if (!options.context.scopes.includes(options.requiredScope)) {
          throw new AppError(
            "FORBIDDEN",
            `This MCP installation does not grant the required ${options.requiredScope} scope.`,
            { httpStatus: 403 },
          );
        }
        return options.action();
      },
      ...(options.recordId ? { recordId: options.recordId } : {}),
    });
    return options.formatSuccess ? options.formatSuccess(result, auditCallId) : success(result);
  } catch (error) {
    return failure(error);
  }
}

export function createAccountingMcpServer(
  service: AccountingService,
  context: RequestContext,
  organisationSwitch?: Pick<OrganisationSwitchService, "start">,
): McpServer {
  const actorId = context.actorId;
  const server = new McpServer(
    { name: "zcloak-xero-accounting-mcp-demo", version: XERO_RELEASE_VERSION },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "xero_connection_status",
    {
      title: "Xero connection status",
      description: "Returns the exact Xero organisation currently bound to this Agent. Organisation changes require a separate short-lived user confirmation page and never happen silently from chat text.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_connection_status",
      input,
      action: () => service.connectionStatus(context),
    }),
  );

  server.registerTool(
    "xero_start_organisation_switch",
    {
      title: "Switch Xero organisation",
      description: "Creates a short-lived one-time link where the user can explicitly choose another Xero organisation already covered by the current Xero authorization. This tool only starts the confirmation flow; it does not switch from chat text alone.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_start_organisation_switch",
      input,
      action: () => {
        if (!organisationSwitch) {
          throw new AppError("CONFIGURATION_ERROR", "Organisation switching is not configured.", {
            httpStatus: 503,
          });
        }
        return organisationSwitch.start(context);
      },
    }),
  );

  server.registerTool(
    "xero_get_organisation",
    {
      title: "Get Xero organisation",
      description: "Reads the exact organisation selected by the server-side Xero connection.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_organisation",
      input,
      action: () => service.getOrganisation(context),
    }),
  );

  server.registerTool(
    "xero_list_accounts",
    {
      title: "List Xero accounts",
      description: "Lists active Xero accounts and can filter them by account class.",
      inputSchema: listAccountsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_accounts",
      input,
      action: () => service.listAccounts(context, input),
    }),
  );

  server.registerTool(
    "xero_list_tax_rates",
    {
      title: "List Xero tax rates",
      description: "Lists active Xero tax types available to the connected organisation.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_tax_rates",
      input,
      action: () => service.listTaxRates(context),
    }),
  );

  server.registerTool(
    "xero_list_contacts",
    {
      title: "List Xero contacts",
      description: "Lists one bounded page of contacts from the server-bound Xero organisation without requiring guessed search terms. Defaults to ACTIVE contacts and supports reviewed supplier/customer filters.",
      inputSchema: listContactsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_contacts",
      input,
      action: () => service.listContacts(context, input),
    }),
  );

  server.registerTool(
    "xero_get_contact",
    {
      title: "Get exact Xero contact",
      description: "Reads one contact from the server-bound Xero organisation by its exact Xero ContactID.",
      inputSchema: getContactSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_contact",
      input,
      action: () => service.getContact(context, input),
      recordId: (result) => result.contactId,
    }),
  );

  server.registerTool(
    "xero_search_contacts",
    {
      title: "Search Xero contacts",
      description: "Searches one caller-selected bounded Xero contact page by text, returning safe supplier fields plus explicit pagination/completeness evidence.",
      inputSchema: searchContactsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_search_contacts",
      input,
      action: () => service.searchContacts(context, input),
    }),
  );

  server.registerTool(
    "xero_prepare_contact_create",
    {
      title: "Prepare a basic Xero contact creation",
      description: "Checks exact duplicates and returns one immutable, source-bound basic-contact proposal plus its confirmation phrase. It excludes tax identity, bank details, payment terms, merge/archive/delete, and does not write to Xero.",
      inputSchema: prepareContactCreateMutationSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_contact_create",
      input,
      action: () => service.prepareContactCreate(context, input),
    }),
  );

  server.registerTool(
    "xero_create_contact",
    {
      title: "Create a basic Xero contact",
      description: "Consumes one unexpired immutable preparation only after the user types its exact confirmation phrase. Creates only the constrained basic fields and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_contact",
      input,
      action: () => service.createContact(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_prepare_contact_update",
    {
      title: "Prepare a basic Xero contact update",
      description: "Reads the exact ContactID, applies only constrained basic-field changes, checks duplicates and stale-version evidence, then returns an immutable source-bound proposal. It does not write to Xero.",
      inputSchema: prepareContactUpdateMutationSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_contact_update",
      input,
      action: () => service.prepareContactUpdate(context, input),
    }),
  );

  server.registerTool(
    "xero_update_contact",
    {
      title: "Update basic Xero contact fields",
      description: "Consumes one unexpired immutable preparation only after exact user confirmation. Updates only the reviewed basic fields, fails on a stale or duplicate target, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_update_contact",
      input,
      action: () => service.updateContact(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_invoices",
    {
      title: "List Xero invoices and bills",
      description: "Lists bounded ACCREC sales invoices and ACCPAY supplier bills using reviewed filters and pagination.",
      inputSchema: listInvoicesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_invoices",
      input,
      action: () => service.listInvoices(context, input),
    }),
  );

  server.registerTool(
    "xero_list_credit_notes",
    {
      title: "List Xero credit notes",
      description: "Reads a bounded page of customer or supplier credit-note history from the bound Xero organisation. Filters are fixed to contact, date, status, and type; this tool never creates, allocates, voids, or deletes a credit note.",
      inputSchema: listCreditNotesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_credit_notes",
      input,
      action: () => service.listCreditNotes(context, input),
    }),
  );

  server.registerTool(
    "xero_prepare_credit_note_draft",
    {
      title: "Prepare a Xero credit-note DRAFT",
      description: "Validates exact tenant-bound contact, account, tax, item and tracking references plus the adjustment reason and source, then returns one immutable DRAFT proposal and confirmation phrase. It does not write to Xero.",
      inputSchema: prepareCreditNoteDraftInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_credit_note_draft",
      input,
      action: () => service.prepareCreditNoteDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_credit_note_draft",
    {
      title: "Create a Xero credit-note DRAFT",
      description: "Consumes one unexpired immutable preparation only after exact user confirmation. Creates DRAFT only, never authorises, allocates, refunds, pays, voids or deletes it, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_credit_note_draft",
      input,
      action: () => service.createCreditNoteDraft(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_payments",
    {
      title: "List Xero payments",
      description: "Reads a bounded page of payment and receipt history from the bound Xero organisation, including exact linked invoice or credit-note IDs when Xero returns them. It never creates, reconciles, reverses, or deletes a payment.",
      inputSchema: listPaymentsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_payments",
      input,
      action: () => service.listPayments(context, input),
    }),
  );

  server.registerTool(
    "xero_list_quotes",
    {
      title: "List Xero quotes",
      description: "Reads a bounded logical page of Xero quotes using reviewed contact, date, expiry, status, and quote-number filters. Pagination evidence remains explicit because Xero serves Quotes in fixed provider pages; this tool never creates, sends, accepts, or invoices a quote.",
      inputSchema: listQuotesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_quotes",
      input,
      action: () => service.listQuotes(context, input),
    }),
  );

  server.registerTool(
    "xero_get_quote",
    {
      title: "Get exact Xero quote",
      description: "Reads one bounded quote snapshot by its exact Xero QuoteID, including safe line and tracking projections plus explicit omitted-field evidence.",
      inputSchema: getQuoteSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_quote",
      input,
      action: () => service.getQuote(context, input),
      recordId: (result) => result.quoteId,
    }),
  );

  server.registerTool(
    "xero_list_purchase_orders",
    {
      title: "List Xero purchase orders",
      description: "Reads one bounded Xero purchase-order page using reviewed status and date filters. It never creates, submits, authorises, bills, sends, or deletes a purchase order.",
      inputSchema: listPurchaseOrdersSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_purchase_orders",
      input,
      action: () => service.listPurchaseOrders(context, input),
    }),
  );

  server.registerTool(
    "xero_get_purchase_order",
    {
      title: "Get exact Xero purchase order",
      description: "Reads one bounded purchase-order snapshot by its exact Xero PurchaseOrderID, without exposing delivery contact details omitted by the reviewed projection.",
      inputSchema: getPurchaseOrderSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_purchase_order",
      input,
      action: () => service.getPurchaseOrder(context, input),
      recordId: (result) => result.purchaseOrderId,
    }),
  );

  server.registerTool(
    "xero_list_manual_journals",
    {
      title: "List Xero manual journals",
      description: "Reads one bounded Xero manual-journal page using reviewed date, status, narration, and sort controls. It never creates, posts, voids, archives, or deletes a journal.",
      inputSchema: listManualJournalsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_manual_journals",
      input,
      action: () => service.listManualJournals(context, input),
    }),
  );

  server.registerTool(
    "xero_get_manual_journal",
    {
      title: "Get exact Xero manual journal",
      description: "Reads one bounded manual-journal snapshot by its exact Xero ManualJournalID, including safe debit/credit line evidence.",
      inputSchema: getManualJournalSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_manual_journal",
      input,
      action: () => service.getManualJournal(context, input),
      recordId: (result) => result.manualJournalId,
    }),
  );

  server.registerTool(
    "xero_prepare_manual_journal_draft",
    {
      title: "Prepare a balanced Xero manual-journal DRAFT",
      description: "Validates exact unprotected accounts and tracking references, exact debit-credit balance and explicit NoTax/NONE treatment, then returns one immutable source-bound DRAFT proposal. It does not write to Xero.",
      inputSchema: prepareManualJournalDraftInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_manual_journal_draft",
      input,
      action: () => service.prepareManualJournalDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_manual_journal_draft",
    {
      title: "Create a balanced Xero manual-journal DRAFT",
      description: "Consumes one unexpired immutable preparation only after exact user confirmation. Creates a balanced DRAFT only, never posts, voids or deletes it, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_manual_journal_draft",
      input,
      action: () => service.createManualJournalDraft(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_items",
    {
      title: "List Xero items",
      description: "Reads a true local offset page from Xero's non-paginated Items response using reviewed sale, purchase, inventory, search, and sort filters. End-of-collection completeness remains conservative because Xero supplies no page metadata.",
      inputSchema: listItemsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_items",
      input,
      action: () => service.listItems(context, input),
    }),
  );

  server.registerTool(
    "xero_get_item",
    {
      title: "Get exact Xero item",
      description: "Reads one item and its safe sales, purchase, and inventory accounting defaults by the exact Xero ItemID.",
      inputSchema: getItemSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_item",
      input,
      action: () => service.getItem(context, input),
      recordId: (result) => result.itemId,
    }),
  );

  server.registerTool(
    "xero_prepare_item_create",
    {
      title: "Prepare a basic untracked Xero item creation",
      description: "Checks the exact item code and returns one immutable source-bound proposal for constrained descriptive fields. Prices, accounts, tax defaults, inventory tracking and stock values are excluded; this step does not write to Xero.",
      inputSchema: prepareItemCreateMutationSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_item_create",
      input,
      action: () => service.prepareItemCreate(context, input),
    }),
  );

  server.registerTool(
    "xero_create_item",
    {
      title: "Create a basic untracked Xero item",
      description: "Consumes one unexpired immutable preparation only after exact user confirmation. Creates only constrained untracked descriptive fields and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_item",
      input,
      action: () => service.createItem(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_prepare_item_update",
    {
      title: "Prepare a basic untracked Xero item update",
      description: "Reads the exact ItemID, applies only constrained descriptive or sale/purchase-usage changes, and returns an immutable source-bound proposal with stale-version evidence. It does not write to Xero.",
      inputSchema: prepareItemUpdateMutationSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_item_update",
      input,
      action: () => service.prepareItemUpdate(context, input),
    }),
  );

  server.registerTool(
    "xero_update_item",
    {
      title: "Update basic untracked Xero item fields",
      description: "Consumes one unexpired immutable preparation only after exact user confirmation. Fails on stale readback, never changes prices, accounts, tax, inventory tracking or stock values, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_update_item",
      input,
      action: () => service.updateItem(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_bank_transactions",
    {
      title: "List Xero bank transactions",
      description: "Reads one bounded page of spent/received-money transactions for reconciliation analysis, including Xero's IsReconciled evidence and exact IDs. RECEIVE-PREPAYMENT searches use InvoiceNumber as the primary business reference. It never creates, edits, reconciles, transfers, voids, or deletes money activity.",
      inputSchema: listBankTransactionsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_bank_transactions",
      input,
      action: () => service.listBankTransactions(context, input),
    }),
  );

  server.registerTool(
    "xero_get_bank_transaction",
    {
      title: "Get exact Xero bank transaction",
      description: "Reads one bounded bank-transaction snapshot by its exact Xero BankTransactionID for reconciliation analysis; bank-account numbers and provider URLs are never projected.",
      inputSchema: getBankTransactionSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_bank_transaction",
      input,
      action: () => service.getBankTransaction(context, input),
      recordId: (result) => result.bankTransactionId,
    }),
  );

  server.registerTool(
    "xero_get_invoice",
    {
      title: "Get exact Xero invoice or bill",
      description: "Reads one bounded ACCREC sales invoice or ACCPAY supplier bill by its exact Xero InvoiceID.",
      inputSchema: getInvoiceSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_invoice",
      input,
      action: () => service.getInvoice(context, input),
      recordId: (result) => result.invoiceId,
    }),
  );

  server.registerTool(
    "xero_get_supplier_bill",
    {
      title: "Get exact Xero supplier bill",
      description: "Reads one ACCPAY supplier bill by its exact Xero InvoiceID.",
      inputSchema: getSupplierBillSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_supplier_bill",
      input,
      action: () => service.getSupplierBill(context, input.invoice_id),
      recordId: (result) => result.invoiceId,
    }),
  );

  server.registerTool(
    "xero_prepare_supplier_bill_draft",
    {
      title: "Prepare a supplier bill draft proposal",
      description: "Reads the bound Xero organisation and deterministically matches extracted supplier-bill fields to exact contacts, accounts, and tax rates. A returned proposal is technically ready for user review only: executionAllowed remains false until the user explicitly instructs the Agent to create a DRAFT. It never writes to Xero or guesses an ID.",
      inputSchema: prepareSupplierBillDraftSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_supplier_bill_draft",
      input,
      action: () => service.prepareSupplierBillDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_draft_supplier_bill",
    {
      title: "Create a draft Xero supplier bill",
      description: "Consumes the exact unexpired one-time confirmation returned by xero_prepare_supplier_bill_draft, then creates one tenant-bound ACCPAY DRAFT with idempotency and exact readback. It never accepts accounting fields at execution time and never authorises or pays the bill.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_draft_supplier_bill",
      input,
      action: () => service.executePreparedSupplierBillDraft(context, input),
      recordId: (result) => result.invoiceId,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_prepare_sales_invoice_draft",
    {
      title: "Prepare a sales invoice draft proposal",
      description: "Reads the bound Xero organisation and deterministically matches customer-invoice fields to exact contacts, accounts, and tax rates. It never writes or guesses an ID; execution remains blocked until the user explicitly confirms DRAFT creation in the conversation.",
      inputSchema: prepareSalesInvoiceDraftSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_sales_invoice_draft",
      input,
      action: () => service.prepareSalesInvoiceDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_draft_sales_invoice",
    {
      title: "Create a draft Xero sales invoice",
      description: "Consumes the exact unexpired one-time confirmation returned by xero_prepare_sales_invoice_draft, then creates one tenant-bound ACCREC DRAFT with idempotency and exact readback. It never accepts invoice fields at execution time and never authorises, sends, or marks an invoice paid.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_draft_sales_invoice",
      input,
      action: () => service.executePreparedSalesInvoiceDraft(context, input),
      recordId: (result) => result.invoiceId,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_prepare_quote_draft",
    {
      title: "Prepare a Xero quote draft",
      description: "Validates exact tenant-bound contact, account, tax, item and tracking references, then returns one immutable DRAFT proposal and a source-bound confirmation phrase. This step never writes to Xero.",
      inputSchema: prepareQuoteDraftInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_quote_draft",
      input,
      action: () => service.prepareQuoteDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_quote_draft",
    {
      title: "Create a Xero quote DRAFT",
      description: "Consumes one unexpired immutable preparation only after the user types its exact confirmation phrase. Creates DRAFT only, never sends or accepts the quote, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_quote_draft",
      input,
      action: () => service.createQuoteDraft(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_prepare_purchase_order_draft",
    {
      title: "Prepare a Xero purchase-order draft",
      description: "Validates exact tenant-bound supplier, account, tax, item and tracking references, then returns one immutable DRAFT proposal and a source-bound confirmation phrase. This step never writes to Xero.",
      inputSchema: preparePurchaseOrderDraftInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_purchase_order_draft",
      input,
      action: () => service.preparePurchaseOrderDraft(context, input),
    }),
  );

  server.registerTool(
    "xero_create_purchase_order_draft",
    {
      title: "Create a Xero purchase-order DRAFT",
      description: "Consumes one unexpired immutable preparation only after the user types its exact confirmation phrase. Creates DRAFT only, never submits, authorises, sends or converts it, and withholds success until exact Xero readback passes.",
      inputSchema: executePreparedXeroMutationSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_purchase_order_draft",
      input,
      action: () => service.createPurchaseOrderDraft(context, input),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_get_trial_balance",
    {
      title: "Get Xero trial balance",
      description: "Reads a bounded Xero Trial Balance view for ledger evidence. The one canonical model output is content-only: result.pagination independently reports the model-text and complete CallToolResult byte limits, visited JSON-node counts, bounded source-inspection status, MCP truncation, and the explicit provider/audit completeness boundary.",
      inputSchema: trialBalanceSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_trial_balance",
      input,
      action: () => service.getTrialBalance(context, input),
      formatSuccess: createXeroTrialBalanceCallToolResult,
    }),
  );

  return server;
}

export function assertExpectedAppError(error: unknown): AppError {
  return toSafeError(error);
}
