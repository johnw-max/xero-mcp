import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { AppError, toSafeError } from "../errors.js";
import {
  executeAccountingCaseSchema,
  getAccountingCaseStatusSchema,
} from "../domain/accountingCaseSchemas.js";
import {
  normalizeXeroAccountingCaseBusinessIntake,
  xeroAccountingCaseBusinessIntakeSchema,
} from "./xeroAccountingCaseBusinessIntake.js";
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
import type { LedgerTargetSessionService } from "../services/ledgerTargetSessionService.js";
import type { XeroAccountingCaseService } from "../services/xeroAccountingCaseService.js";
import {
  createXeroTrialBalanceCallToolResult,
  type XeroTrialBalanceAgentResult,
} from "../services/xeroTrialBalanceBounds.js";
import type { RequestContext } from "../security/requestContext.js";
import { XERO_RELEASE_VERSION } from "../xeroRelease.js";
import type { ActorTenantContext } from "../providers/types.js";
import {
  buildNormalizedXeroReadEvidence,
  getXeroReadEvidenceProfile,
  normalizedXeroReadPayload,
  safeXeroReadResult,
} from "./xeroReadEvidence.js";
import { xeroMcpFailureEnvelope } from "./xeroFailureEnvelope.js";

function success(value: unknown): CallToolResult {
  const payload = { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(error: unknown): CallToolResult {
  const payload = xeroMcpFailureEnvelope(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const targetSessionRefSchema = z.string()
  .regex(/^xts_[A-Za-z0-9_-]{43}$/u)
  .describe("Short-lived opaque reference returned by xero_pin_current_organisation for this OAuth installation principal and immutable ledger binding.");

function withTargetSessionInput<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  required: boolean,
): z.ZodObject<T & { target_session_ref: z.ZodOptional<typeof targetSessionRefSchema> }> {
  // safeExtend preserves each business schema's strictness, defaults and
  // cross-field refinements. Rebuilding from `.shape` would silently drop
  // reversed-date and unknown-key rejection.
  return schema.safeExtend({
    target_session_ref: required ? targetSessionRefSchema : targetSessionRefSchema.optional(),
  } as never) as unknown as z.ZodObject<T & {
    // The static type stays optional because strictness is a runtime deployment
    // choice; production schemas still require it when configured.
    target_session_ref: z.ZodOptional<typeof targetSessionRefSchema>;
  }>;
}

function splitTargetSessionInput<T extends Record<string, unknown>>(input: T): {
  targetSessionRef?: string;
  businessInput: Omit<T, "target_session_ref">;
} {
  const { target_session_ref: targetSessionRef, ...businessInput } = input;
  return {
    ...(typeof targetSessionRef === "string" ? { targetSessionRef } : {}),
    businessInput,
  };
}

type AuditedOptions<T, TInput extends Record<string, unknown>> = {
  service: AccountingService;
  context: RequestContext;
  targetSessions?: Pick<LedgerTargetSessionService, "resolve">;
  /** A single scope is required exactly; an array is an explicit any-of gate. */
  requiredScope:
    | "xero.read"
    | "xero.draft.write"
    | readonly ["xero.read" | "xero.draft.write", ...("xero.read" | "xero.draft.write")[]];
  actorId: string;
  toolName: string;
  input: TInput;
  action: (context: RequestContext, input: Omit<TInput, "target_session_ref">) => Promise<T>;
  recordId?: (result: T) => string | undefined;
  formatSuccess?: (result: T, auditCallId: string) => CallToolResult;
};

async function runAudited<T, TInput extends Record<string, unknown>>(
  options: AuditedOptions<T, TInput>,
): Promise<CallToolResult> {
  const auditCallId = `call_${randomUUID()}`;
  const requiredScopes = typeof options.requiredScope === "string"
    ? [options.requiredScope]
    : [...options.requiredScope];
  const { targetSessionRef, businessInput } = splitTargetSessionInput(options.input);
  let effectiveContext = options.context;
  let targetResolutionError: unknown;
  if (options.targetSessions) {
    try {
      effectiveContext = await options.targetSessions.resolve(options.context, targetSessionRef);
    } catch (error) {
      // Keep the base installation principal only so withAudit can persist a
      // fail-closed rejection. The ledger action itself is never run.
      targetResolutionError = error;
    }
  }
  const readEvidenceProfile = getXeroReadEvidenceProfile(options.toolName);
  let tenantContext: ActorTenantContext | undefined;
  let tenantResolutionObserved = false;
  let preparedReadResult: CallToolResult | undefined;
  const prepareReadResult = (result: T): unknown => {
    const safeResult = safeXeroReadResult(result);
    const evidence = buildNormalizedXeroReadEvidence({
      toolName: options.toolName,
      auditCallId,
      requestContext: effectiveContext,
      ...(tenantContext ? { tenantContext } : {}),
      // The raw target_session_ref is an ephemeral capability and must never
      // be echoed to the Agent-visible evidence envelope or durable audit.
      input: businessInput,
      safeResult,
    });
    if (!evidence) throw new Error(`Missing normalized read-evidence profile for ${options.toolName}.`);
    if (options.toolName === "xero_get_trial_balance") {
      preparedReadResult = createXeroTrialBalanceCallToolResult(
        safeResult as XeroTrialBalanceAgentResult,
        evidence,
      ) as CallToolResult;
      const text = preparedReadResult.content[0];
      if (text?.type !== "text") {
        throw new Error("Trial Balance read evidence did not produce canonical text content.");
      }
      return JSON.parse(text.text) as unknown;
    }
    const payload = normalizedXeroReadPayload(safeResult, evidence);
    preparedReadResult = {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
    return payload;
  };
  try {
    const result = await options.service.withAudit({
      callId: auditCallId,
      actorId: options.actorId,
      principal: effectiveContext,
      toolName: options.toolName,
      input: businessInput,
      governanceDisposition: options.toolName === "xero_start_organisation_switch" ||
          options.toolName === "xero_pin_current_organisation" ||
          options.toolName.startsWith("xero_prepare_")
        ? "ESCALATE"
        : requiredScopes.includes("xero.draft.write")
          ? "AUTO_EXECUTE"
          : "OBSERVE",
      allowUnresolvedTenant: Boolean(targetResolutionError) || options.toolName === "xero_connection_status",
      skipTenantResolution: Boolean(targetResolutionError),
      action: () => {
        if (targetResolutionError) throw targetResolutionError;
        if (!requiredScopes.some((scope) => effectiveContext.scopes.includes(scope))) {
          const scopeDescription = requiredScopes.join(" or ");
          throw new AppError(
            "SCOPE_MISSING",
            `This MCP installation does not grant the required ${scopeDescription} scope.`,
            {
              httpStatus: 403,
              details: {
                failureLayer: "MCP_SCOPE",
                reasonCodes: ["MISSING_MCP_SCOPE"],
                recoveryAction: "REAUTHORISE_MCP_SCOPE",
                providerMutationPossible: false,
                requiredScopes,
              },
            },
          );
        }
        if (options.toolName !== "xero_connection_status" && tenantResolutionObserved && tenantContext === undefined) {
          throw new AppError(
            "CONFIGURATION_ERROR",
            "The Xero ledger read could not be bound to a verified server-side organisation.",
            { httpStatus: 503 },
          );
        }
        return options.action(effectiveContext, businessInput);
      },
      onResolvedContext: (resolved) => {
        tenantResolutionObserved = true;
        tenantContext = resolved;
      },
      ...(readEvidenceProfile && options.toolName !== "xero_connection_status"
        ? { revalidateContextAfterAction: true }
        : {}),
      ...(readEvidenceProfile ? { auditOutput: prepareReadResult } : {}),
      ...(options.recordId ? { recordId: options.recordId } : {}),
    });
    if (readEvidenceProfile) {
      if (!preparedReadResult) prepareReadResult(result);
      if (!preparedReadResult) throw new Error(`Missing prepared read result for ${options.toolName}.`);
      return preparedReadResult;
    }
    return options.formatSuccess ? options.formatSuccess(result, auditCallId) : success(result);
  } catch (error) {
    return failure(error);
  }
}

function createAuditor(targetSessions?: Pick<LedgerTargetSessionService, "resolve">) {
  return <T, TInput extends Record<string, unknown>>(
    options: Omit<AuditedOptions<T, TInput>, "targetSessions">,
  ) => runAudited({
    ...options,
    ...(targetSessions ? { targetSessions } : {}),
  });
}

export function createAccountingMcpServer(
  service: AccountingService,
  context: RequestContext,
  organisationSwitch?: Pick<OrganisationSwitchService, "start">,
  targetSessions?: Pick<LedgerTargetSessionService, "issue" | "resolve" | "required">,
  accountingCases?: Pick<XeroAccountingCaseService, "prepare" | "execute" | "status">,
  options?: { unsafeExposeLegacyObjectMutationToolsForTests?: boolean },
): McpServer {
  const actorId = context.actorId;
  const server = new McpServer(
    { name: "zcloak-xero-accounting-mcp-demo", version: XERO_RELEASE_VERSION },
    { capabilities: { logging: {} } },
  );
  const targeted = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
    withTargetSessionInput(schema, targetSessions?.required ?? false);
  const audited = createAuditor(targetSessions);
  const controlAudited = createAuditor();
  // The Accounting Agent sees one case-level mutation surface. Object-level
  // writers remain internal adapters so the model cannot bypass coverage,
  // accounting policy, source bridges or whole-case preflight.
  const exposeLegacyObjectMutationTools = options?.unsafeExposeLegacyObjectMutationToolsForTests === true;
  if (exposeLegacyObjectMutationTools && process.env.NODE_ENV !== "test") {
    throw new AppError("CONFIGURATION_ERROR", "Legacy object mutation tools can be exposed only in tests.", {
      httpStatus: 500,
    });
  }
  const unavailableAccountingCase = async (): Promise<never> => {
    throw new AppError("CONFIGURATION_ERROR", "The governed Xero Accounting Case service is unavailable.", {
      httpStatus: 503,
    });
  };
  const caseRuntime = accountingCases ?? {
    prepare: unavailableAccountingCase,
    execute: unavailableAccountingCase,
    status: unavailableAccountingCase,
  };

  {
    server.registerTool(
      "xero_prepare_accounting_case",
      {
        title: "Prepare a governed Xero Accounting Case",
        description: "Accepts ordinary source-document fields plus an explicit ledger account code and tax code per line, and compiles them into one tenant-bound, versioned Accounting Case. The server deterministically derives internal fact, lineage, event, source-unit and line IDs. It verifies every declared account code and tax code against the target organisation's live chart of accounts and tax rates, and recomputes each line's tax from the organisation's real rate; it never selects, corrects or infers an accounting treatment. Provider object IDs, routes, computed ledger payloads and target identity remain server-side. First creation uses expected_version 0. This step performs no Xero write and always reports ledger_write as NOT_WRITTEN. Submitted/model-extracted facts remain source_truth_claim=NOT_VERIFIED and original_file_verified=false.",
        inputSchema: targeted(xeroAccountingCaseBusinessIntakeSchema),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input) => audited({
        service,
        context,
        requiredScope: "xero.read",
        actorId,
        toolName: "xero_prepare_accounting_case",
        input,
        action: (effectiveContext, businessInput) => caseRuntime.prepare(
          effectiveContext,
          normalizeXeroAccountingCaseBusinessIntake(businessInput),
        ),
      }),
    );

    server.registerTool(
      "xero_execute_accounting_case",
      {
        title: "Execute eligible Xero Accounting Case drafts",
        description: "Executes only the immutable eligible operations stored in the exact current Accounting Case version under standing delegation. It accepts no payload, tenant, action, account, tax, receipt or confirmation phrase, stops on uncertain writes, and reports ledger success only with provider receipt plus exact readback for each eligible write. Ledger readback never verifies the submitted source or original file; source_truth_claim remains NOT_VERIFIED.",
        inputSchema: targeted(executeAccountingCaseSchema),
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (input) => audited({
        service,
        context,
        requiredScope: ["xero.read", "xero.draft.write"],
        actorId,
        toolName: "xero_execute_accounting_case",
        input,
        action: (effectiveContext, businessInput) => caseRuntime.execute(effectiveContext, businessInput),
      }),
    );

    server.registerTool(
      "xero_get_accounting_case_status",
      {
        title: "Get governed Xero Accounting Case status",
        description: "Returns bounded case coverage, residual exceptions, source-truth status and per-operation receipt/readback status. It distinguishes unverified submitted-source truth, supplied-set coverage and verified ledger writes, and never claims original-file or whole-business completeness.",
        inputSchema: targeted(getAccountingCaseStatusSchema),
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (input) => audited({
        service,
        context,
        requiredScope: "xero.read",
        actorId,
        toolName: "xero_get_accounting_case_status",
        input,
        action: (effectiveContext, businessInput) => caseRuntime.status(effectiveContext, businessInput),
      }),
    );
  }

  server.registerTool(
    "xero_connection_status",
    {
      title: "Xero connection status",
      description: "Returns connector control-plane health and the current compatibility selection. It does not prove a ledger target; first call xero_pin_current_organisation, then verify with xero_get_organisation using that target_session_ref. Organisation changes require a separate short-lived user confirmation page and never happen silently from chat text.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => controlAudited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_connection_status",
      input,
      action: (effectiveContext) => service.connectionStatus(effectiveContext),
    }),
  );

  server.registerTool(
    "xero_start_organisation_switch",
    {
      title: "Switch Xero organisation",
      description: "Creates a short-lived one-time link where the user can explicitly choose another Xero organisation already covered by the current Xero authorization. This tool only starts the confirmation flow; it does not switch from chat text alone. After the page completes, call xero_pin_current_organisation before continuing ledger work.",
      inputSchema: targeted(noInputSchema),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_start_organisation_switch",
      input,
      action: (effectiveContext) => {
        if (!organisationSwitch) {
          throw new AppError("CONFIGURATION_ERROR", "Organisation switching is not configured.", {
            httpStatus: 503,
          });
        }
        return organisationSwitch.start(effectiveContext);
      },
    }),
  );

  server.registerTool(
    "xero_pin_current_organisation",
    {
      title: "Pin current Xero organisation",
      description: "Call this before ledger work and again after an organisation switch or target expiry. It pins the current Xero organisation into a short-lived opaque target_session_ref scoped to the verified OAuth installation principal and immutable ledger binding; pass that capability to every subsequent ledger tool. The server does not trust client-supplied conversation headers as identity.",
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => controlAudited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_pin_current_organisation",
      input,
      action: (effectiveContext) => {
        if (!targetSessions) {
          throw new AppError("CONFIGURATION_ERROR", "Ledger target sessions are not configured.", {
            httpStatus: 503,
          });
        }
        return targetSessions.issue(effectiveContext);
      },
    }),
  );

  server.registerTool(
    "xero_get_organisation",
    {
      title: "Get Xero organisation",
      description: "Reads and verifies the exact Xero organisation pinned by target_session_ref, including its base currency.",
      inputSchema: targeted(noInputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_organisation",
      input,
      action: (effectiveContext) => service.getOrganisation(effectiveContext),
    }),
  );

  server.registerTool(
    "xero_list_accounts",
    {
      title: "List Xero accounts",
      description: "Lists active Xero accounts and can filter them by account class.",
      inputSchema: targeted(listAccountsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_accounts",
      input,
      action: (effectiveContext, businessInput) => service.listAccounts(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_list_tax_rates",
    {
      title: "List Xero tax rates",
      description: "Lists active Xero tax types available to the connected organisation.",
      inputSchema: targeted(noInputSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_tax_rates",
      input,
      action: (effectiveContext) => service.listTaxRates(effectiveContext),
    }),
  );

  server.registerTool(
    "xero_list_contacts",
    {
      title: "List Xero contacts",
      description: "Lists one bounded page of contacts from the server-bound Xero organisation without requiring guessed search terms. Defaults to ACTIVE contacts and supports reviewed supplier/customer filters.",
      inputSchema: targeted(listContactsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_contacts",
      input,
      action: (effectiveContext, businessInput) => service.listContacts(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_contact",
    {
      title: "Get exact Xero contact",
      description: "Reads one contact from the server-bound Xero organisation by its exact Xero ContactID.",
      inputSchema: targeted(getContactSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_contact",
      input,
      action: (effectiveContext, businessInput) => service.getContact(effectiveContext, businessInput),
      recordId: (result) => result.contactId,
    }),
  );

  server.registerTool(
    "xero_search_contacts",
    {
      title: "Search Xero contacts",
      description: "Searches one caller-selected bounded Xero contact page by text, returning safe supplier fields plus explicit pagination/completeness evidence.",
      inputSchema: targeted(searchContactsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_search_contacts",
      input,
      action: (effectiveContext, businessInput) => service.searchContacts(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_contact_create",
    {
      title: "Prepare a basic Xero contact creation",
      description: "Checks exact duplicates and returns one immutable, source-bound basic-contact proposal for standing-delegation execution. It excludes tax identity, bank details, payment terms, merge/archive/delete, and does not write to Xero.",
      inputSchema: targeted(prepareContactCreateMutationSchema),
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
      action: (effectiveContext, businessInput) => service.prepareContactCreate(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_contact",
    {
      title: "Create a basic Xero contact",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It accepts no accounting payload or confirmation phrase, creates only constrained basic fields, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_contact",
      input,
      action: (effectiveContext, businessInput) => service.createContact(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_contact_update",
    {
      title: "Prepare a basic Xero contact update",
      description: "Reads the exact ContactID, applies only constrained basic-field changes, checks duplicates and stale-version evidence, then returns an immutable source-bound proposal. It does not write to Xero.",
      inputSchema: targeted(prepareContactUpdateMutationSchema),
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
      action: (effectiveContext, businessInput) => service.prepareContactUpdate(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_update_contact",
    {
      title: "Update basic Xero contact fields",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It updates only reviewed basic fields, fails on a stale or duplicate target, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_update_contact",
      input,
      action: (effectiveContext, businessInput) => service.updateContact(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_invoices",
    {
      title: "List Xero invoices and bills",
      description: "Lists bounded ACCREC sales invoices and ACCPAY supplier bills using reviewed filters and pagination.",
      inputSchema: targeted(listInvoicesSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_invoices",
      input,
      action: (effectiveContext, businessInput) => service.listInvoices(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_list_credit_notes",
    {
      title: "List Xero credit notes",
      description: "Reads a bounded page of customer or supplier credit-note history from the bound Xero organisation. Filters are fixed to contact, date, status, and type; this tool never creates, allocates, voids, or deletes a credit note.",
      inputSchema: targeted(listCreditNotesSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_credit_notes",
      input,
      action: (effectiveContext, businessInput) => service.listCreditNotes(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_credit_note_draft",
    {
      title: "Prepare a Xero credit-note DRAFT",
      description: "Validates exact tenant-bound contact, account, tax, item and tracking references plus the adjustment reason and source, then returns one immutable DRAFT proposal for standing-delegation execution. It does not write to Xero.",
      inputSchema: targeted(prepareCreditNoteDraftInputSchema),
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
      action: (effectiveContext, businessInput) => service.prepareCreditNoteDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_credit_note_draft",
    {
      title: "Create a Xero credit-note DRAFT",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It creates DRAFT only, never authorises, allocates, refunds, pays, voids or deletes it, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_credit_note_draft",
      input,
      action: (effectiveContext, businessInput) => service.createCreditNoteDraft(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_payments",
    {
      title: "List Xero payments",
      description: "Reads a bounded page of payment and receipt history from the bound Xero organisation, including exact linked invoice or credit-note IDs when Xero returns them. It never creates, reconciles, reverses, or deletes a payment.",
      inputSchema: targeted(listPaymentsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_payments",
      input,
      action: (effectiveContext, businessInput) => service.listPayments(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_list_quotes",
    {
      title: "List Xero quotes",
      description: "Reads a bounded logical page of Xero quotes using reviewed contact, date, expiry, status, and quote-number filters. Pagination evidence remains explicit because Xero serves Quotes in fixed provider pages; this tool never creates, sends, accepts, or invoices a quote.",
      inputSchema: targeted(listQuotesSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_quotes",
      input,
      action: (effectiveContext, businessInput) => service.listQuotes(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_quote",
    {
      title: "Get exact Xero quote",
      description: "Reads one bounded quote snapshot by its exact Xero QuoteID, including safe line and tracking projections plus explicit omitted-field evidence.",
      inputSchema: targeted(getQuoteSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_quote",
      input,
      action: (effectiveContext, businessInput) => service.getQuote(effectiveContext, businessInput),
      recordId: (result) => result.quoteId,
    }),
  );

  server.registerTool(
    "xero_list_purchase_orders",
    {
      title: "List Xero purchase orders",
      description: "Reads one bounded Xero purchase-order page using reviewed status and date filters. It never creates, submits, authorises, bills, sends, or deletes a purchase order.",
      inputSchema: targeted(listPurchaseOrdersSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_purchase_orders",
      input,
      action: (effectiveContext, businessInput) => service.listPurchaseOrders(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_purchase_order",
    {
      title: "Get exact Xero purchase order",
      description: "Reads one bounded purchase-order snapshot by its exact Xero PurchaseOrderID, without exposing delivery contact details omitted by the reviewed projection.",
      inputSchema: targeted(getPurchaseOrderSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_purchase_order",
      input,
      action: (effectiveContext, businessInput) => service.getPurchaseOrder(effectiveContext, businessInput),
      recordId: (result) => result.purchaseOrderId,
    }),
  );

  server.registerTool(
    "xero_list_manual_journals",
    {
      title: "List Xero manual journals",
      description: "Reads one bounded Xero manual-journal page using reviewed date, status, narration, and sort controls. It never creates, posts, voids, archives, or deletes a journal.",
      inputSchema: targeted(listManualJournalsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_manual_journals",
      input,
      action: (effectiveContext, businessInput) => service.listManualJournals(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_manual_journal",
    {
      title: "Get exact Xero manual journal",
      description: "Reads one bounded manual-journal snapshot by its exact Xero ManualJournalID, including safe debit/credit line evidence.",
      inputSchema: targeted(getManualJournalSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_manual_journal",
      input,
      action: (effectiveContext, businessInput) => service.getManualJournal(effectiveContext, businessInput),
      recordId: (result) => result.manualJournalId,
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_manual_journal_draft",
    {
      title: "Prepare a balanced Xero manual-journal DRAFT",
      description: "Validates exact unprotected accounts and tracking references, exact debit-credit balance and explicit NoTax/NONE treatment, then returns one immutable source-bound DRAFT proposal. It does not write to Xero.",
      inputSchema: targeted(prepareManualJournalDraftInputSchema),
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
      action: (effectiveContext, businessInput) => service.prepareManualJournalDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_manual_journal_draft",
    {
      title: "Create a balanced Xero manual-journal DRAFT",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It creates a balanced DRAFT only, never posts, voids or deletes it, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_manual_journal_draft",
      input,
      action: (effectiveContext, businessInput) => service.createManualJournalDraft(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_items",
    {
      title: "List Xero items",
      description: "Reads a true local offset page from Xero's non-paginated Items response using reviewed sale, purchase, inventory, search, and sort filters. End-of-collection completeness remains conservative because Xero supplies no page metadata.",
      inputSchema: targeted(listItemsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_items",
      input,
      action: (effectiveContext, businessInput) => service.listItems(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_item",
    {
      title: "Get exact Xero item",
      description: "Reads one item and its safe sales, purchase, and inventory accounting defaults by the exact Xero ItemID.",
      inputSchema: targeted(getItemSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_item",
      input,
      action: (effectiveContext, businessInput) => service.getItem(effectiveContext, businessInput),
      recordId: (result) => result.itemId,
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_item_create",
    {
      title: "Prepare a basic untracked Xero item creation",
      description: "Checks the exact item code and returns one immutable source-bound proposal for constrained descriptive fields. Prices, accounts, tax defaults, inventory tracking and stock values are excluded; this step does not write to Xero.",
      inputSchema: targeted(prepareItemCreateMutationSchema),
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
      action: (effectiveContext, businessInput) => service.prepareItemCreate(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_item",
    {
      title: "Create a basic untracked Xero item",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It creates only constrained untracked descriptive fields and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_item",
      input,
      action: (effectiveContext, businessInput) => service.createItem(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_item_update",
    {
      title: "Prepare a basic untracked Xero item update",
      description: "Reads the exact ItemID, applies only constrained descriptive or sale/purchase-usage changes, and returns an immutable source-bound proposal with stale-version evidence. It does not write to Xero.",
      inputSchema: targeted(prepareItemUpdateMutationSchema),
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
      action: (effectiveContext, businessInput) => service.prepareItemUpdate(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_update_item",
    {
      title: "Update basic untracked Xero item fields",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It fails on stale readback, never changes prices, accounts, tax, inventory tracking or stock values, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_update_item",
      input,
      action: (effectiveContext, businessInput) => service.updateItem(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_list_bank_transactions",
    {
      title: "List Xero bank transactions",
      description: "Reads one bounded page of spent/received-money transactions for reconciliation analysis, including Xero's IsReconciled evidence and exact IDs. RECEIVE-PREPAYMENT searches use InvoiceNumber as the primary business reference. It never creates, edits, reconciles, transfers, voids, or deletes money activity.",
      inputSchema: targeted(listBankTransactionsSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_list_bank_transactions",
      input,
      action: (effectiveContext, businessInput) => service.listBankTransactions(effectiveContext, businessInput),
    }),
  );

  server.registerTool(
    "xero_get_bank_transaction",
    {
      title: "Get exact Xero bank transaction",
      description: "Reads one bounded bank-transaction snapshot by its exact Xero BankTransactionID for reconciliation analysis; bank-account numbers and provider URLs are never projected.",
      inputSchema: targeted(getBankTransactionSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_bank_transaction",
      input,
      action: (effectiveContext, businessInput) => service.getBankTransaction(effectiveContext, businessInput),
      recordId: (result) => result.bankTransactionId,
    }),
  );

  server.registerTool(
    "xero_get_invoice",
    {
      title: "Get exact Xero invoice or bill",
      description: "Reads one bounded ACCREC sales invoice or ACCPAY supplier bill by its exact Xero InvoiceID.",
      inputSchema: targeted(getInvoiceSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_invoice",
      input,
      action: (effectiveContext, businessInput) => service.getInvoice(effectiveContext, businessInput),
      recordId: (result) => result.invoiceId,
    }),
  );

  server.registerTool(
    "xero_get_supplier_bill",
    {
      title: "Get exact Xero supplier bill",
      description: "Reads one ACCPAY supplier bill by its exact Xero InvoiceID.",
      inputSchema: targeted(getSupplierBillSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_supplier_bill",
      input,
      action: (effectiveContext, businessInput) => service.getSupplierBill(effectiveContext, businessInput.invoice_id),
      recordId: (result) => result.invoiceId,
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_supplier_bill_draft",
    {
      title: "Prepare a supplier bill draft proposal",
      description: "Reads the bound Xero organisation and deterministically matches extracted supplier-bill fields to exact contacts, accounts, and tax rates. A returned proposal is technically ready for user review only: executionAllowed remains false until the user explicitly instructs the Agent to create a DRAFT. It never writes to Xero or guesses an ID.",
      inputSchema: targeted(prepareSupplierBillDraftSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_supplier_bill_draft",
      input,
      action: (effectiveContext, businessInput) => service.prepareSupplierBillDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_draft_supplier_bill",
    {
      title: "Create a draft Xero supplier bill",
      description: "Executes the exact unexpired proposal returned by xero_prepare_supplier_bill_draft under the server-side standing delegation, then creates one tenant-bound ACCPAY DRAFT with idempotency and exact readback. It never accepts accounting fields at execution time and never authorises or pays the bill.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_draft_supplier_bill",
      input,
      action: (effectiveContext, businessInput) => service.executePreparedSupplierBillDraft(effectiveContext, businessInput),
      recordId: (result) => result.invoiceId,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_sales_invoice_draft",
    {
      title: "Prepare a sales invoice draft proposal",
      description: "Reads the bound Xero organisation and deterministically matches customer-invoice fields to exact contacts, accounts, and tax rates. It never writes or guesses an ID; a separate execute call revalidates standing authority before creating a DRAFT.",
      inputSchema: targeted(prepareSalesInvoiceDraftSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_prepare_sales_invoice_draft",
      input,
      action: (effectiveContext, businessInput) => service.prepareSalesInvoiceDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_draft_sales_invoice",
    {
      title: "Create a draft Xero sales invoice",
      description: "Executes the exact unexpired proposal returned by xero_prepare_sales_invoice_draft under the server-side standing delegation, then creates one tenant-bound ACCREC DRAFT with idempotency and exact readback. It never accepts invoice fields at execution time and never authorises, sends, or marks an invoice paid.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_draft_sales_invoice",
      input,
      action: (effectiveContext, businessInput) => service.executePreparedSalesInvoiceDraft(effectiveContext, businessInput),
      recordId: (result) => result.invoiceId,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_quote_draft",
    {
      title: "Prepare a Xero quote draft",
      description: "Validates exact tenant-bound contact, account, tax, item and tracking references, then returns one immutable DRAFT proposal for standing-delegation execution. This step never writes to Xero.",
      inputSchema: targeted(prepareQuoteDraftInputSchema),
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
      action: (effectiveContext, businessInput) => service.prepareQuoteDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_quote_draft",
    {
      title: "Create a Xero quote DRAFT",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It creates DRAFT only, never sends or accepts the quote, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_quote_draft",
      input,
      action: (effectiveContext, businessInput) => service.createQuoteDraft(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_prepare_purchase_order_draft",
    {
      title: "Prepare a Xero purchase-order draft",
      description: "Validates exact tenant-bound supplier, account, tax, item and tracking references, then returns one immutable DRAFT proposal for standing-delegation execution. This step never writes to Xero.",
      inputSchema: targeted(preparePurchaseOrderDraftInputSchema),
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
      action: (effectiveContext, businessInput) => service.preparePurchaseOrderDraft(effectiveContext, businessInput),
    }),
  );

  if (exposeLegacyObjectMutationTools) server.registerTool(
    "xero_create_purchase_order_draft",
    {
      title: "Create a Xero purchase-order DRAFT",
      description: "Executes one unexpired immutable preparation under the server-side standing delegation. It creates DRAFT only, never submits, authorises, sends or converts it, and withholds success until exact Xero readback passes.",
      inputSchema: targeted(executePreparedXeroMutationSchema),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.draft.write",
      actorId,
      toolName: "xero_create_purchase_order_draft",
      input,
      action: (effectiveContext, businessInput) => service.createPurchaseOrderDraft(effectiveContext, businessInput),
      recordId: (result) => result.xero_object_id,
      formatSuccess: (result, auditCallId) => success({ ...result, auditCallId }),
    }),
  );

  server.registerTool(
    "xero_get_trial_balance",
    {
      title: "Get Xero trial balance",
      description: "Reads a bounded Xero Trial Balance view for ledger evidence. The one canonical model output is content-only: result.pagination independently reports the model-text and complete CallToolResult byte limits, visited JSON-node counts, bounded source-inspection status, MCP truncation, and the explicit provider/audit completeness boundary.",
      inputSchema: targeted(trialBalanceSchema),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async (input) => audited({
      service,
      context,
      requiredScope: "xero.read",
      actorId,
      toolName: "xero_get_trial_balance",
      input,
      action: (effectiveContext, businessInput) => service.getTrialBalance(effectiveContext, businessInput),
    }),
  );

  return server;
}

export function assertExpectedAppError(error: unknown): AppError {
  return toSafeError(error);
}
