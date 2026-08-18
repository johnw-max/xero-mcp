import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerProviderWritePermit } from "../src/control-kernel/ledgerProviderWritePermit.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { RepositoryLedgerAuthoritySnapshotResolver } from "../src/domain/ledgerAuthority.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { CreateDraftSupplierBillInput } from "../src/domain/schemas.js";
import type { CanonicalCreditNoteDraftPayload } from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import type { Logger } from "../src/logging.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import {
  verifyXeroExternalGovernanceAuthority,
  xeroStandingDelegationsWithExternalGovernance,
} from "../src/policy/xeroExternalGovernanceAuthority.js";
import type {
  AccountingProvider,
  InvoiceSnapshot,
  ProviderDraftWriteEvidence,
  SupplierBillSnapshot,
} from "../src/providers/types.js";
import type {
  CreditNoteManualJournalWriteProvider,
} from "../src/providers/xeroCreditNoteManualJournalProvider.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from
  "../src/security/xeroProviderWritePermitContext.js";
import { hashObject } from "../src/security/hash.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { XeroAccountingCaseService } from "../src/services/xeroAccountingCaseService.js";
import { XeroCreditNoteManualJournalService } from "../src/services/xeroCreditNoteManualJournalService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";
import { createTestXeroGovernanceArtifacts } from "./helpers/xeroGovernanceAuthority.js";
import { testXeroAccounts } from "./helpers/xeroTenantCoaProfile.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "23232323-2323-4232-8232-232323232323";
const supplierBillId = "34343434-3434-4434-8434-343434343434";
const supplierCreditId = "45454545-4545-4454-8454-454545454545";
const historicalBillId = "56565656-5656-4565-8565-565656565656";
const fixedNow = new Date("2026-08-14T00:30:00.000Z");

type ApCaseKind = "SUPPLIER_BILL" | "SUPPLIER_CREDIT";

function supplierBillCase() {
  return {
    case_id: "case-kernel-e2e-supplier-bill",
    expected_version: 0,
    source_label: "Kernel E2E supplier bill",
    source_set_complete: true,
    documents: [{
      document_type: "SUPPLIER_BILL",
      reference: "BILL-KERNEL-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER",
      document_date: "2026-07-20",
      due_date: "2026-08-20",
      currency: "SGD",
      contact: { name: "Historical Supplier" },
      lines: [{
        description: "Office supplies",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
        account_code: "453",
        tax_type: "INPUTY24",
      }, {
        description: "Cloud subscription",
        quantity: "1",
        unit_amount_excluding_tax: "50.00",
        source_tax_amount: "0.00",
        account_code: "485",
        tax_type: "NONE",
      }],
      declared_net: "150.00",
      declared_tax: "9.00",
      declared_gross: "159.00",
      document_validity: "TEST_OR_NOT_VALID",
    }],
  };
}

function supplierCreditCase() {
  return {
    case_id: "case-kernel-e2e-supplier-credit",
    expected_version: 0,
    source_label: "Kernel E2E supplier credit",
    source_set_complete: true,
    documents: [{
      document_type: "SUPPLIER_CREDIT_NOTE",
      reference: "SCN-KERNEL-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER",
      document_date: "2026-08-01",
      currency: "SGD",
      contact: { name: "Historical Supplier" },
      lines: [{
        description: "Partial historical credit",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
        account_code: "453",
        tax_type: "INPUTY24",
      }],
      declared_net: "100.00",
      declared_tax: "9.00",
      declared_gross: "109.00",
      document_validity: "VALID_FOR_LIVE_BOOKS",
      original_document: {
        reference: "BILL-HIST-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER",
        document_date: "2026-07-01",
      },
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

function pagination(page: number, returned: number) {
  return {
    page,
    pageSize: 100,
    returned,
    providerPageCount: 1,
    providerItemCount: returned,
    hasNextPage: false,
    hasNextPageIsEstimated: false,
    omittedInvalid: 0,
    omittedOverflow: 0,
  };
}

async function apKernelHarness(kind: ApCaseKind) {
  const repository = new InMemoryAccountingRepository({ now: () => new Date(fixedNow) });
  const createOrGetPosting = vi.spyOn(repository, "createOrGetPosting");
  const resolvedToken: ResolvedMcpAccessToken = {
    tokenId: `case-ap-e2e-token-${kind.toLowerCase()}`,
    clientId: "case-ap-e2e-client",
    resource: "https://xero-mcp.example.test/mcp",
    audience: "https://xero-mcp.example.test/mcp",
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: fixedNow,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "case-ap-e2e-installation",
    bindingId: "case-ap-e2e-binding",
    bindingRevision: 1,
    workspaceId: "case-ap-e2e-workspace",
    subjectType: "USER",
    subjectId: "case-ap-e2e-user",
    agentId: "case-ap-e2e-agent",
    connectionId: "case-ap-e2e-connection",
    authorizationId: "case-ap-e2e-authorization",
    tenantId,
    policyId: "case-ap-e2e-policy",
  };
  const context = Object.freeze({
    ...createOAuthRequestContext({
      issuer: "https://xero-mcp.example.test",
      resolvedToken,
    }),
    targetSessionId: `case-ap-e2e-target-${kind.toLowerCase()}`,
    targetSessionHash: kind === "SUPPLIER_BILL" ? "a".repeat(64) : "b".repeat(64),
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
    name: "Historical Supplier",
    status: "ACTIVE",
    isSupplier: true,
  };
  const accounts = testXeroAccounts();
  const taxes = [{
    taxType: "INPUTY24",
    name: "GST on Expenses",
    status: "ACTIVE",
    displayTaxRate: "9.0000",
    effectiveRate: "9.0000",
    canApplyToExpenses: true,
  }, {
    taxType: "NONE",
    name: "No Tax",
    status: "ACTIVE",
    displayTaxRate: "0.0000",
    effectiveRate: "0.0000",
    canApplyToExpenses: true,
  }];
  const historicalOriginal: InvoiceSnapshot = {
    invoiceId: historicalBillId,
    tenantId,
    type: "ACCPAY",
    status: "AUTHORISED",
    contact: { contactId, name: contact.name },
    invoiceDate: "2026-07-01",
    currency: "SGD",
    invoiceNumber: "BILL-HIST-001",
    reference: "supplementary-reference-is-not-the-provider-identifier",
    subTotal: "200.0000",
    totalTax: "18.0000",
    total: "218.0000",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Original two-unit transaction",
      quantity: "2.0000",
      unitAmount: "100.0000",
      lineAmount: "200.0000",
      taxAmount: "18.0000",
      accountId: "33333333-3333-4333-8333-333333333353",
      accountCode: "453",
      taxType: "INPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
  };
  let supplierBillReadback: SupplierBillSnapshot | undefined;
  let supplierBillCreateCount = 0;
  let supplierBillProviderIdempotencyKey: string | undefined;
  let supplierBillMutationRequestId: string | undefined;
  const createDraftSupplierBill = vi.fn(async (
    principal: unknown,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
    recordWriteEvidence?: (evidence: ProviderDraftWriteEvidence) => Promise<void>,
    providerWritePermit?: LedgerProviderWritePermit,
    mutationRequestId?: string,
  ) => {
    supplierBillProviderIdempotencyKey = idempotencyKey;
    supplierBillMutationRequestId = mutationRequestId;
    const { user_confirmation: _confirmation, ...canonicalPayload } = input;
    consumeXeroProviderWritePermitAtMutationBoundary({
      permit: providerWritePermit,
      principal: principal as never,
      connection: { connectionId: resolvedToken.connectionId, tenantId } as never,
      adapterOperation: "XeroAccountingProvider.createDraftSupplierBill",
      actionId: "supplier_bill.create_draft",
      mutationRequestId: mutationRequestId ?? "",
      providerIdempotencyKey: mutationRequestId ?? "",
      canonicalPayload,
    });
    supplierBillCreateCount += 1;
    const lineValues = input.lines.map((line) => {
      const lineAmount = line.quantity * line.unit_amount;
      const taxAmount = line.tax_type === "INPUTY24" ? lineAmount * 0.09 : 0;
      return { line, lineAmount, taxAmount };
    });
    const subTotal = lineValues.reduce((sum, value) => sum + value.lineAmount, 0);
    const totalTax = lineValues.reduce((sum, value) => sum + value.taxAmount, 0);
    const receipt = {
      operation: "CREATE_ACCPAY_DRAFT",
      invoiceId: supplierBillId,
      providerRequestId: "provider-case-ap-e2e-bill",
    };
    supplierBillReadback = {
      tenantId,
      invoiceId: supplierBillId,
      type: "ACCPAY",
      status: "DRAFT",
      contact: { contactId, name: contact.name },
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      currency: input.currency,
      invoiceNumber: input.reference,
      lineAmountType: input.line_amount_type,
      lineItemCount: input.lines.length,
      linesTruncated: false,
      lines: lineValues.map(({ line, lineAmount, taxAmount }) => ({
        description: line.description,
        quantity: fixedFour(line.quantity),
        unitAmount: fixedFour(line.unit_amount),
        lineAmount: fixedFour(lineAmount),
        taxAmount: fixedFour(taxAmount),
        ...(line.account_id ? { accountId: line.account_id } : {}),
        accountCode: line.account_code,
        taxType: line.tax_type,
      })),
      subTotal: fixedFour(subTotal),
      totalTax: fixedFour(totalTax),
      total: fixedFour(subTotal + totalTax),
    };
    await recordWriteEvidence?.({ invoiceId: supplierBillId, receipt });
    return { bill: supplierBillReadback, receipt };
  });

  let supplierCreditCreateCount = 0;
  let supplierCreditReadback: CanonicalCreditNoteDraftPayload | undefined;
  const creditWriteProvider = {
    getItemByCode: vi.fn(async () => undefined),
    resolveTrackingOptionIds: vi.fn(async (_principal, requestedIds: readonly string[]) => ({
      requestedIds: [...requestedIds],
      matchedIds: [...requestedIds],
      complete: true,
    })),
    createCreditNoteDraft: vi.fn(async (
      principal,
      payload: CanonicalCreditNoteDraftPayload,
      idempotencyKey: string,
      providerWritePermit?: LedgerProviderWritePermit,
    ) => {
      consumeXeroProviderWritePermitAtMutationBoundary({
        permit: providerWritePermit,
        principal,
        connection: { connectionId: resolvedToken.connectionId, tenantId } as never,
        adapterOperation: "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
        actionId: "credit_note.create_draft",
        mutationRequestId: idempotencyKey,
        providerIdempotencyKey: idempotencyKey,
        canonicalPayload: payload,
      });
      supplierCreditCreateCount += 1;
      supplierCreditReadback = payload;
      return {
        objectId: supplierCreditId,
        receipt: {
          operation: "CREATE_CREDIT_NOTE_DRAFT",
          creditNoteId: supplierCreditId,
          providerRequestId: "provider-case-ap-e2e-credit",
        },
      };
    }),
    readAndVerifyCreditNoteDraft: vi.fn(async (_principal, objectId: string, expected: CanonicalCreditNoteDraftPayload) => ({
      ok: true as const,
      snapshot: {
        objectType: "CREDIT_NOTE" as const,
        creditNoteId: objectId,
        canonicalPayload: expected,
        providerEconomicsEvidence: {
          lineAmounts: expected.lines.map((line) => fixedFour(line.quantity * line.unitAmount)),
          taxAmounts: expected.lines.map((line) => fixedFour(line.quantity * line.unitAmount * 0.09)),
          accountIds: expected.lines.map((line) => line.accountId),
          accountCodes: expected.lines.map((line) => line.accountCode),
          taxTypes: expected.lines.map((line) => line.taxType),
          subTotal: expected.enteredLineSubtotal,
          totalTax: "9.0000",
          total: "109.0000",
          noDiscountsVerified: true as const,
        },
      },
      readbackCanonicalPayload: expected,
      readbackCanonicalPayloadHash: hashObject(expected),
    })),
    createManualJournalDraft: vi.fn(async () => {
      throw new Error("manual journal is out of scope for this AP Case E2E");
    }),
    readAndVerifyManualJournalDraft: vi.fn(async () => {
      throw new Error("manual journal is out of scope for this AP Case E2E");
    }),
  } as unknown as CreditNoteManualJournalWriteProvider;

  const provider = {
    connectionStatus: vi.fn(async () => ({
      connected: true,
      tenant: { id: tenantId, name: "Kernel E2E Test Company" },
      scopes: ["accounting.invoices", "accounting.settings.read", "accounting.contacts.read"],
    })),
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
      accounts,
      taxRates: taxes,
    })),
    listAccounts: vi.fn(async () => accounts),
    listTaxRates: vi.fn(async () => taxes),
    listInvoices: vi.fn(async (_principal, input: { page: number }) => ({
      invoices: kind === "SUPPLIER_CREDIT" ? [historicalOriginal] : [],
      pagination: pagination(input.page, kind === "SUPPLIER_CREDIT" ? 1 : 0),
    })),
    listCreditNotes: vi.fn(async (_principal, input: { page: number }) => ({
      creditNotes: [],
      pagination: pagination(input.page, 0),
    })),
    getContact: vi.fn(async (_principal, requestedContactId: string) =>
      requestedContactId === contactId ? contact : undefined),
    getInvoice: vi.fn(async (_principal, requestedInvoiceId: string) => {
      if (kind === "SUPPLIER_CREDIT" && requestedInvoiceId === historicalBillId) return historicalOriginal;
      throw new Error("unexpected invoice history readback target");
    }),
    getSupplierBill: vi.fn(async (_principal, requestedInvoiceId: string) =>
      requestedInvoiceId === supplierBillId ? supplierBillReadback : undefined),
    createDraftSupplierBill,
  } as unknown as AccountingProvider;

  const artifacts = createTestXeroGovernanceArtifacts(tenantId, {
    now: fixedNow,
    workspaceId: resolvedToken.workspaceId,
    agentId: resolvedToken.agentId,
    installationId: resolvedToken.installationId,
    writerId: "case-ap-e2e-writer",
    coordinationDomainId: "case-ap-e2e-coordination-domain",
  });
  const externalAuthority = verifyXeroExternalGovernanceAuthority({
    trustBundle: artifacts.trustBundle,
    receipts: artifacts.receipts,
    status: artifacts.status,
    expectedTrustBundleSha256: artifacts.expectedTrustBundleSha256,
    expectedReceiptsSha256: artifacts.expectedReceiptsSha256,
    expectedStatusSha256: artifacts.expectedStatusSha256,
    now: fixedNow,
  });
  const governedDelegations = xeroStandingDelegationsWithExternalGovernance(externalAuthority, [{
    delegationId: `case-ap-e2e-${kind.toLowerCase()}-delegation`,
    revision: 1,
    status: "ACTIVE",
    providerId: "xero",
    workspaceId: resolvedToken.workspaceId,
    agentId: resolvedToken.agentId,
    installationId: resolvedToken.installationId,
    tenantIds: [tenantId],
    actionIds: [kind === "SUPPLIER_BILL" ? "supplier_bill.create_draft" : "credit_note.create_draft"],
    expiresAt: new Date("2026-08-14T00:40:00.000Z"),
    firmGovernanceRequired: true,
  }]);
  await repository.publishLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 1,
    writeKillSwitchEnabled: true,
    standingDelegations: governedDelegations,
    publishedAt: fixedNow,
  });
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "case-ap-e2e-confirmation-secret-at-least-32-bytes",
    authoritySnapshotResolver: new RepositoryLedgerAuthoritySnapshotResolver(repository),
    now: () => new Date(fixedNow),
    providerCapabilityEvaluator: {
      evaluate: async () => ({ allowed: true, denyReasons: [], receiptHash: "e".repeat(64) }),
    },
  });
  const authoriseAutonomous = vi.spyOn(mutations, "authoriseAutonomous");
  const creditMutations = new XeroCreditNoteManualJournalService(
    provider,
    creditWriteProvider,
    mutations,
    { xeroWriteEnabled: true, xeroAllowedTenantId: tenantId },
  );
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
      xeroWriteEnabled: true,
      xeroAllowedTenantId: tenantId,
    },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    mutationFoundation: mutations,
    creditNoteManualJournalMutations: creditMutations,
  });
  const accountingCases = new XeroAccountingCaseService(
    repository,
    provider,
    accounting,
    mutations,
    {
      continuationSecret: Buffer.alloc(32, 9),
      testTenantIds: [tenantId],
      businessAuthorityProfiles: externalAuthority.authorityProfiles,
      clock: () => new Date(fixedNow),
    },
  );
  const server = createAccountingMcpServer(accounting, context, undefined, undefined, accountingCases);
  const client = new Client({ name: `accounting-case-ap-kernel-e2e-${kind.toLowerCase()}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    authoriseAutonomous,
    supplierBillCreateCount: () => supplierBillCreateCount,
    supplierBillProviderIdempotencyKey: () => supplierBillProviderIdempotencyKey,
    supplierBillMutationRequestId: () => supplierBillMutationRequestId,
    createOrGetPosting,
    supplierBillReadback: () => supplierBillReadback,
    supplierCreditCreateCount: () => supplierCreditCreateCount,
    supplierCreditReadback: () => supplierCreditReadback,
  };
}

describe("public Accounting Case AP kernel E2E", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  it("passes the sealed AP-bill governance coordinate to the lower service and creates exactly once", async () => {
    const harness = await apKernelHarness("SUPPLIER_BILL");
    closeables.push(harness.client, harness.server);
    const preparedResponse = await harness.client.callTool({
      name: "xero_prepare_accounting_case",
      arguments: supplierBillCase(),
    });
    expect(preparedResponse.isError).not.toBe(true);
    const prepared = resultOf<{ case_id: string; case_version: number; operations: Array<{ action_id: string }> }>(
      preparedResponse,
    );
    expect(prepared.operations).toEqual([expect.objectContaining({ action_id: "supplier_bill.create_draft" })]);

    const execution = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "case-ap-e2e-supplier-bill-execute",
    };
    const executedResponse = await harness.client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(executedResponse.isError).not.toBe(true);
    expect(harness.supplierBillCreateCount()).toBe(1);
    expect(harness.supplierBillProviderIdempotencyKey()).toBe(harness.supplierBillMutationRequestId());
    expect(harness.createOrGetPosting.mock.calls[0]?.[0].createIdempotencyKey)
      .toBe(harness.supplierBillMutationRequestId());
    expect(harness.supplierBillReadback()).toMatchObject({
      invoiceId: supplierBillId,
      type: "ACCPAY",
      status: "DRAFT",
      invoiceNumber: "BILL-KERNEL-001",
      total: "159.0000",
    });
    expect(harness.authoriseAutonomous.mock.calls[0]?.[5]).toEqual({
      route: "SUPPLIER_BILL",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      authoritativeProviderField: "INVOICE_NUMBER",
      contactId,
      reference: "BILL-KERNEL-001",
    });
    expect(resultOf(executedResponse)).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", xero_object_id: supplierBillId }],
    });

    const replayResponse = await harness.client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(replayResponse.isError).not.toBe(true);
    expect(resultOf(replayResponse)).toMatchObject(resultOf(executedResponse));
    expect(harness.supplierBillCreateCount()).toBe(1);
    expect(harness.authoriseAutonomous).toHaveBeenCalledTimes(1);
  });

  it("passes the sealed supplier-credit governance coordinate to the credit service and creates exactly once", async () => {
    const harness = await apKernelHarness("SUPPLIER_CREDIT");
    closeables.push(harness.client, harness.server);
    const preparedResponse = await harness.client.callTool({
      name: "xero_prepare_accounting_case",
      arguments: supplierCreditCase(),
    });
    expect(preparedResponse.isError).not.toBe(true);
    const prepared = resultOf<{ case_id: string; case_version: number; operations: Array<{ action_id: string }> }>(
      preparedResponse,
    );
    expect(prepared.operations).toEqual([expect.objectContaining({ action_id: "credit_note.create_draft" })]);

    const execution = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "case-ap-e2e-supplier-credit-execute",
    };
    const executedResponse = await harness.client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(executedResponse.isError).not.toBe(true);
    expect(harness.supplierCreditCreateCount()).toBe(1);
    expect(harness.supplierCreditReadback()).toMatchObject({
      objectType: "CREDIT_NOTE",
      creditNoteType: "ACCPAYCREDIT",
      contactId,
      reference: "SCN-KERNEL-001",
      authoritativeProviderField: "CREDIT_NOTE_NUMBER",
      enteredLineSubtotal: "100.0000",
    });
    expect(harness.authoriseAutonomous.mock.calls[0]?.[5]).toEqual({
      route: "SUPPLIER_CREDIT",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      authoritativeProviderField: "CREDIT_NOTE_NUMBER",
      contactId,
      reference: "SCN-KERNEL-001",
    });
    expect(resultOf(executedResponse)).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED", xero_object_id: supplierCreditId }],
    });

    const replayResponse = await harness.client.callTool({
      name: "xero_execute_accounting_case",
      arguments: execution,
    });
    expect(replayResponse.isError).not.toBe(true);
    expect(resultOf(replayResponse)).toMatchObject(resultOf(executedResponse));
    expect(harness.supplierCreditCreateCount()).toBe(1);
    expect(harness.authoriseAutonomous).toHaveBeenCalledTimes(1);
  });
});
