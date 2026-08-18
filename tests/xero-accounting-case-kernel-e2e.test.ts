import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { CreateDraftSalesInvoiceInput } from "../src/domain/schemas.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { Logger } from "../src/logging.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import type {
  AccountingProvider,
  ProviderDraftWriteEvidence,
  SalesInvoiceSnapshot,
} from "../src/providers/types.js";
import type { LedgerProviderWritePermit } from "../src/control-kernel/ledgerProviderWritePermit.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from "../src/security/xeroProviderWritePermitContext.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { XeroAccountingCaseService } from "../src/services/xeroAccountingCaseService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";
import {
  testXeroAccounts,
  testXeroBusinessAuthorityProfile,
} from "./helpers/xeroTenantCoaProfile.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "33333333-3333-4333-8333-333333333333";
const fixedNow = new Date("2026-08-13T04:00:00.000Z");

function singleExistingContactSalesInvoiceCase() {
  return {
    case_id: "case-kernel-e2e-sales-invoice",
    expected_version: 0,
    source_label: "Kernel E2E customer invoice",
    source_set_complete: true,
    documents: [{
      document_type: "CUSTOMER_INVOICE",
      reference: "INV-2026-0702",
      reference_kind: "FORMAL_DOCUMENT_NUMBER",
      document_date: "2026-07-02",
      due_date: "2026-08-01",
      currency: "SGD",
      contact: { name: "Lion City Digital Pte. Ltd." },
      lines: [{
        description: "Consulting services - July 2026",
        quantity: "20",
        unit_amount_excluding_tax: "200.00",
        source_tax_amount: "360.00",
        account_code: "200",
        tax_type: "OUTPUTY24",
      }],
      declared_net: "4000.00",
      declared_tax: "360.00",
      declared_gross: "4360.00",
      document_validity: "TEST_OR_NOT_VALID",
    }],
  };
}

function fixedFour(value: number): string {
  return value.toFixed(4);
}

function resultOf<T>(response: { structuredContent?: Record<string, unknown> }): T {
  const result = response.structuredContent?.result;
  if (!result || typeof result !== "object") throw new Error("MCP result payload is missing");
  return result as T;
}

describe("public Accounting Case kernel E2E", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  it("writes one existing-contact sales invoice through the governed kernel and replays without a second provider create", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => new Date(fixedNow) });
    const resolvedToken: ResolvedMcpAccessToken = {
      tokenId: "case-e2e-token",
      clientId: "case-e2e-client",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: ["xero.read", "xero.draft.write"],
      issuedAt: fixedNow,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      installationId: "case-e2e-installation",
      bindingId: "case-e2e-binding",
      bindingRevision: 1,
      workspaceId: "case-e2e-workspace",
      subjectType: "USER",
      subjectId: "case-e2e-user",
      agentId: "case-e2e-agent",
      connectionId: "case-e2e-connection",
      authorizationId: "case-e2e-authorization",
      tenantId,
      policyId: "case-e2e-policy",
    };
    const context = Object.freeze({
      ...createOAuthRequestContext({
        issuer: "https://xero-mcp.example.test",
        resolvedToken,
      }),
      targetSessionId: "case-e2e-target-session",
      targetSessionHash: "a".repeat(64),
      targetSessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const binding = {
      installationId: resolvedToken.installationId,
      bindingId: resolvedToken.bindingId,
      workspaceId: resolvedToken.workspaceId,
      subjectType: resolvedToken.subjectType,
      subjectId: resolvedToken.subjectId,
      agentId: resolvedToken.agentId,
      connectionId: resolvedToken.connectionId,
      bindingRevision: resolvedToken.bindingRevision,
      authorizationId: resolvedToken.authorizationId,
      tenantId,
      tenantName: "Kernel E2E Test Company",
      policyId: resolvedToken.policyId,
    };
    vi.spyOn(repository, "resolveAgentConnectionBinding").mockResolvedValue(binding);
    vi.spyOn(repository, "resolveLedgerTargetSession").mockResolvedValue({
      session: {
        sessionId: context.targetSessionId,
        sessionHash: context.targetSessionHash,
        installationId: resolvedToken.installationId,
        bindingId: resolvedToken.bindingId,
        connectionId: resolvedToken.connectionId,
        bindingRevision: resolvedToken.bindingRevision,
        createdAt: fixedNow,
        expiresAt: context.targetSessionExpiresAt,
      },
      binding,
    });

    const contact = {
      contactId,
      name: "Lion City Digital Pte. Ltd.",
      status: "ACTIVE",
      isCustomer: true,
    };
    const tax = {
      taxType: "OUTPUTY24",
      name: "GST on Income",
      status: "ACTIVE",
      displayTaxRate: "9.0000",
      effectiveRate: "9.0000",
      canApplyToRevenue: true,
    };
    const allAccounts = testXeroAccounts();
    let providerCreateCount = 0;
    let exactProviderReadback: SalesInvoiceSnapshot | undefined;
    const provider = {
      resolveContext: vi.fn(async () => ({
        actorId: context.actorId,
        tenantId,
        tenantName: "Kernel E2E Test Company",
      })),
      getOrganisation: vi.fn(async () => ({
        organisationId: tenantId,
        name: "Kernel E2E Test Company",
        countryCode: "SG",
        baseCurrency: "SGD",
        paysTax: true,
        organisationStatus: "ACTIVE",
      })),
      searchContacts: vi.fn(async () => ({
        contacts: [contact],
        pagination: {
          page: 1,
          pageSize: 100,
          returned: 1,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
        },
      })),
      getSupplierBillDraftReferenceData: vi.fn(async () => ({
        tenant: { id: tenantId, name: "Kernel E2E Test Company" },
        contacts: [contact],
        contactsComplete: true,
        accounts: allAccounts,
        taxRates: [tax],
      })),
      listAccounts: vi.fn(async () => allAccounts),
      listTaxRates: vi.fn(async () => [tax]),
      listInvoices: vi.fn(async (_principal: unknown, input: { page: number; page_size: number }) => ({
        invoices: [],
        pagination: {
          page: input.page,
          pageSize: input.page_size,
          returned: 0,
          providerPageCount: 1,
          providerItemCount: 0,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
          omittedOverflow: 0,
        },
      })),
      listCreditNotes: vi.fn(async (_principal: unknown, input: { page: number; page_size: number }) => ({
        creditNotes: [],
        pagination: {
          page: input.page,
          pageSize: input.page_size,
          returned: 0,
          providerPageCount: 1,
          providerItemCount: 0,
          hasNextPage: false,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
          omittedOverflow: 0,
        },
      })),
      getContact: vi.fn(async (_principal: unknown, requestedContactId: string) =>
        requestedContactId === contactId ? contact : undefined),
      createDraftSalesInvoice: async (
        principal: unknown,
        input: CreateDraftSalesInvoiceInput,
        idempotencyKey: string,
        recordWriteEvidence?: (evidence: ProviderDraftWriteEvidence) => Promise<void>,
        providerWritePermit?: LedgerProviderWritePermit,
        mutationRequestId?: string,
      ) => {
        // The observable provider-write count moves only after the raw boundary
        // has accepted and consumed the exact autonomous action capability.
        const { user_confirmation: _confirmation, ...canonicalPayload } = input;
        consumeXeroProviderWritePermitAtMutationBoundary({
          permit: providerWritePermit,
          principal: principal as never,
          connection: {
            connectionId: resolvedToken.connectionId,
            tenantId,
          } as never,
          adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
          actionId: "customer_invoice.create_draft",
          mutationRequestId: mutationRequestId ?? "",
          providerIdempotencyKey: idempotencyKey,
          canonicalPayload,
        });
        providerCreateCount += 1;
        const lineSubTotal = input.lines.reduce(
          (sum, line) => sum + line.quantity * line.unit_amount,
          0,
        );
        const totalTax = lineSubTotal * 0.09;
        const receipt = {
          operation: "CREATE_ACCREC_DRAFT",
          invoiceId,
          providerRequestId: "provider-case-e2e-001",
        };
        exactProviderReadback = {
          tenantId,
          invoiceId,
          type: "ACCREC",
          status: "DRAFT",
          contact: { contactId, name: contact.name },
          invoiceDate: input.invoice_date,
          dueDate: input.due_date,
          currency: input.currency,
          invoiceNumber: input.reference,
          lineAmountType: input.line_amount_type,
          lineItemCount: input.lines.length,
          linesTruncated: false,
          lines: input.lines.map((line) => ({
            description: line.description,
            quantity: fixedFour(line.quantity),
            unitAmount: fixedFour(line.unit_amount),
            lineAmount: fixedFour(line.quantity * line.unit_amount),
            taxAmount: fixedFour(line.quantity * line.unit_amount * 0.09),
            ...(line.account_id ? { accountId: line.account_id } : {}),
            accountCode: line.account_code,
            taxType: line.tax_type,
          })),
          subTotal: fixedFour(lineSubTotal),
          totalTax: fixedFour(totalTax),
          total: fixedFour(lineSubTotal + totalTax),
        };
        await recordWriteEvidence?.({ invoiceId, receipt });
        return { invoice: exactProviderReadback, receipt };
      },
    } as unknown as AccountingProvider;

    const mutations = new XeroMutationService(repository, {
      confirmationSecret: "case-e2e-confirmation-secret-at-least-32-bytes",
      writeKillSwitchEnabled: true,
      standingDelegations: [{
        delegationId: "case-e2e-standing-delegation",
        revision: 1,
        status: "ACTIVE",
        providerId: "xero",
        workspaceId: resolvedToken.workspaceId,
        agentId: resolvedToken.agentId,
        installationId: resolvedToken.installationId,
        tenantIds: [tenantId],
        actionIds: ["customer_invoice.create_draft"],
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }],
      now: () => new Date(fixedNow),
      providerCapabilityEvaluator: {
        evaluate: async () => ({ allowed: true, denyReasons: [], receiptHash: "e".repeat(64) }),
      },
    });
    const autonomousPreflight = vi.spyOn(mutations, "preflightAutonomousActions");
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const accounting = new AccountingService({
      repository,
      provider,
      config: { publicBaseUrl: "https://xero-mcp.example.test", xeroWriteEnabled: true },
      logger,
      connectionTickets: {} as ConnectionTicketService,
      mutationFoundation: mutations,
    });
    const accountingCases = new XeroAccountingCaseService(
      repository,
      provider,
      accounting,
      mutations,
      {
        continuationSecret: Buffer.alloc(32, 7),
        testTenantIds: [tenantId],
        businessAuthorityProfiles: [testXeroBusinessAuthorityProfile(tenantId)],
        clock: () => new Date(fixedNow),
      },
    );
    const server = createAccountingMcpServer(accounting, context, undefined, undefined, accountingCases);
    const client = new Client({ name: "accounting-case-kernel-e2e", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    // ADR-002: the MCP holds no jurisdiction rate-period table any more, so a
    // historic document is no longer blocked purely for needing "transition
    // review" -- SG_GST_TRANSITION_REVIEW_REQUIRED no longer exists. The
    // optional review_note is retained as a decision-inert audit record: it
    // must not change compilation eligibility.
    const transitionalCase = singleExistingContactSalesInvoiceCase();
    transitionalCase.case_id = "case-kernel-e2e-transition-review";
    transitionalCase.documents[0]!.reference = "INV-2024-TRANSITION-001";
    transitionalCase.documents[0]!.document_date = "2024-01-01";
    transitionalCase.documents[0]!.due_date = "2024-01-31";
    (transitionalCase.documents[0] as Record<string, unknown>).review_note =
      "2024 GST rate transition period: source-review confirmed 9% applies to this document date.";
    const transitionalResponse = await client.callTool({
      name: "xero_prepare_accounting_case",
      arguments: transitionalCase,
    });
    expect(transitionalResponse.isError).not.toBe(true);
    const transitional = resultOf<{
      case_id: string;
      case_version: number;
      state: string;
      operations: Array<{ action_id: string }>;
      events: Array<{ reason_codes: string[] }>;
    }>(transitionalResponse);
    expect(transitional).toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [expect.objectContaining({ action_id: "customer_invoice.create_draft" })],
    });
    expect(transitional.events.flatMap((event) => event.reason_codes))
      .not.toContain("SG_GST_TRANSITION_REVIEW_REQUIRED");
    expect(autonomousPreflight).not.toHaveBeenCalled();
    expect(providerCreateCount).toBe(0);

    const publicCase = singleExistingContactSalesInvoiceCase();
    const preparedResponse = await client.callTool({
      name: "xero_prepare_accounting_case",
      arguments: publicCase,
    });
    expect(preparedResponse.isError).not.toBe(true);
    expect(providerCreateCount).toBe(0);
    const prepared = resultOf<{
      case_id: string;
      case_version: number;
      operations: Array<{ state: string }>;
      completion_claim: { ledger_write_claim: string };
    }>(preparedResponse);
    expect(prepared).toMatchObject({
      case_id: publicCase.case_id,
      case_version: 1,
      operations: [{ state: "PENDING" }],
      completion_claim: { ledger_write_claim: "NOT_WRITTEN" },
    });

    const execution = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "case-kernel-e2e-execute-001",
    };
    const injected = await client.callTool({
      name: "xero_execute_accounting_case",
      arguments: { ...execution, tenant_id: tenantId },
    });
    expect(injected.isError).toBe(true);
    expect(providerCreateCount).toBe(0);

    const executedResponse = await client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(executedResponse.isError).not.toBe(true);
    expect(providerCreateCount).toBe(1);
    expect(exactProviderReadback).toMatchObject({
      tenantId,
      invoiceId,
      type: "ACCREC",
      status: "DRAFT",
      invoiceNumber: "INV-2026-0702",
      total: "4360.0000",
    });
    const executed = resultOf<{
      state: string;
      operations: Array<{
        state: string;
        xero_object_id?: string;
        provider_receipt_recorded: boolean;
        exact_readback_recorded: boolean;
      }>;
      completion_claim: { eligible_write_status: string; ledger_write_claim: string };
    }>(executedResponse);
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{
        state: "READBACK_VERIFIED",
        xero_object_id: invoiceId,
        provider_receipt_recorded: true,
        exact_readback_recorded: true,
      }],
      completion_claim: {
        eligible_write_status: "ALL_READBACK_VERIFIED",
        ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED",
      },
    });

    const statusResponse = await client.callTool({
      name: "xero_get_accounting_case_status",
      arguments: { case_id: prepared.case_id, case_version: prepared.case_version },
    });
    expect(statusResponse.isError).not.toBe(true);
    expect(resultOf(statusResponse)).toMatchObject(executed);

    const replayResponse = await client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(replayResponse.isError).not.toBe(true);
    expect(resultOf(replayResponse)).toMatchObject(executed);
    expect(providerCreateCount).toBe(1);
    expect(autonomousPreflight).toHaveBeenCalledTimes(1);
  });
});
