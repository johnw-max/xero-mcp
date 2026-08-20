import type { AccountingService } from "../../src/services/accountingService.js";
import { boundXeroTrialBalanceForAgent } from "../../src/services/xeroTrialBalanceBounds.js";

export interface ServiceCall {
  method: string;
  arguments: unknown[];
}

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";

/**
 * Deterministic, network-free service double behind the production MCP server.
 * The create method is deliberately observable and throws if the MCP write
 * gate ever lets a call reach it.
 */
export function createDeterministicAccountingService(): {
  service: AccountingService;
  calls: ServiceCall[];
  writeAttempts: () => number;
} {
  const calls: ServiceCall[] = [];
  let writeAttemptCount = 0;

  const record = <T>(method: string, result: T) => (...args: unknown[]): T => {
    calls.push({ method, arguments: args });
    return result;
  };

  const service = {
    withAudit: async (options: { action: () => Promise<unknown>; toolName: string }) => {
      calls.push({ method: "withAudit", arguments: [{ toolName: options.toolName }] });
      return options.action();
    },
    connectionStatus: record("connectionStatus", {
      connected: true,
      tenant: { id: tenantId, name: "Contract Harness Organisation" },
      scopes: ["accounting.settings.read", "accounting.transactions.read"],
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    getOrganisation: record("getOrganisation", {
      organisationId: tenantId,
      name: "Contract Harness Organisation",
      countryCode: "SG",
      baseCurrency: "SGD",
    }),
    listAccounts: record("listAccounts", [{
      accountId: "33333333-3333-4333-8333-333333333333",
      code: "404",
      name: "Software Subscriptions",
      type: "EXPENSE",
      class: "EXPENSE",
      status: "ACTIVE",
      taxType: "NONE",
    }]),
    listTaxRates: record("listTaxRates", [{
      name: "No Tax",
      taxType: "NONE",
      status: "ACTIVE",
      displayTaxRate: "0.0000",
      effectiveRate: "0.0000",
      canApplyToExpenses: true,
    }]),
    listContacts: record("listContacts", {
      contacts: [{
        contactId,
        name: "Synthetic Supplier Limited",
        status: "ACTIVE",
        isSupplier: true,
        isCustomer: false,
      }],
      pagination: {
        page: 1,
        pageSize: 25,
        returned: 1,
        providerPageCount: 1,
        providerItemCount: 1,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    }),
    getContact: record("getContact", {
      contactId,
      name: "Synthetic Supplier Limited",
      status: "ACTIVE",
      isSupplier: true,
      isCustomer: false,
    }),
    searchContacts: record("searchContacts", [{
      contactId,
      name: "Synthetic Supplier Limited",
      status: "ACTIVE",
      isSupplier: true,
      defaultCurrency: "SGD",
    }]),
    listInvoices: record("listInvoices", {
      invoices: [],
      pagination: {
        page: 1,
        pageSize: 25,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    }),
    listCreditNotes: record("listCreditNotes", {
      creditNotes: [],
      pagination: {
        page: 1,
        pageSize: 20,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    }),
    listPayments: record("listPayments", {
      payments: [],
      pagination: {
        page: 1,
        pageSize: 20,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    }),
    getInvoice: record("getInvoice", {
      tenantId,
      invoiceId,
      type: "ACCPAY",
      status: "DRAFT",
      contact: { contactId, name: "Synthetic Supplier Limited" },
      currency: "SGD",
      lines: [],
    }),
    getSupplierBill: record("getSupplierBill", {
      tenantId,
      invoiceId,
      type: "ACCPAY",
      status: "DRAFT",
      contact: { contactId, name: "Synthetic Supplier Limited" },
      currency: "SGD",
      lines: [],
    }),
    prepareSupplierBillDraft: record("prepareSupplierBillDraft", {
      technicallyReady: true,
      readyForUserConfirmation: true,
      requiresUserConfirmation: true,
      executionAllowed: false,
      proposal: {
        request_id: "contract-harness-write-001",
        source_ref: "synthetic://contract-harness/invoice-001",
        source_sha256: "a".repeat(64),
        source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
        contact_id: contactId,
        invoice_date: "2026-08-01",
        due_date: "2026-08-15",
        currency: "SGD",
        reference: "CONTRACT-HARNESS-001",
        line_amount_type: "Exclusive",
        lines: [{
          description: "Synthetic software subscription",
          quantity: 1,
          unit_amount: 100,
          account_code: "404",
          tax_type: "NONE",
        }],
      },
      evidence: {
        tenant: { id: tenantId, name: "Contract Harness Organisation" },
        source: {
          ref: "synthetic://contract-harness/invoice-001",
          sha256: "a".repeat(64),
          trust: "AGENT_ASSERTED_UNVERIFIED",
        },
        supplier: { exactMatches: [] },
        lines: [],
        sourceCounts: { contacts: 1, contactsComplete: true, accounts: 1, taxRates: 1 },
      },
      blockers: [],
      warnings: [],
    }),
    createDraftSupplierBill: async (...args: unknown[]) => {
      writeAttemptCount += 1;
      calls.push({ method: "createDraftSupplierBill", arguments: args });
      throw new Error("CONTRACT_HARNESS_WRITE_ESCAPE: a provider write path was reached");
    },
    getTrialBalance: record("getTrialBalance", boundXeroTrialBalanceForAgent({
      reportName: "Trial Balance",
      reportDate: "2026-08-06",
      rows: [],
    })),
  } as unknown as AccountingService;

  return {
    service,
    calls,
    writeAttempts: () => writeAttemptCount,
  };
}
