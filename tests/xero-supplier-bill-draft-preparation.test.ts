import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import type { Logger } from "../src/logging.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import type { AccountingProvider, SupplierBillDraftReferenceData } from "../src/providers/types.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";

const contactId = "22222222-2222-4222-8222-222222222222";

function serviceWithReferenceData(referenceData: SupplierBillDraftReferenceData) {
  const getSupplierBillDraftReferenceData = vi.fn().mockResolvedValue(referenceData);
  const provider = {
    getSupplierBillDraftReferenceData,
    createDraftSupplierBill: vi.fn(),
    authoriseSupplierBill: vi.fn(),
  } as unknown as AccountingProvider;
  const service = new AccountingService({
    repository: {} as AccountingRepository,
    provider,
    config: { publicBaseUrl: "https://mcp.example.test", xeroWriteEnabled: false },
    logger: {} as Logger,
    connectionTickets: {} as ConnectionTicketService,
  });
  return { service, provider, getSupplierBillDraftReferenceData };
}

const referenceData: SupplierBillDraftReferenceData = {
  tenant: { id: "tenant-a", name: "Tenant A" },
  contacts: [{
    contactId,
    name: "Acme Limited",
    contactNumber: "SUP-001",
    status: "ACTIVE",
    isSupplier: true,
    purchasesDefaultAccountCode: "999",
    accountsPayableTaxType: "DEFAULT",
  }],
  contactsComplete: true,
  accounts: [{
    accountId: "account-404",
    code: "404",
    name: "Subscriptions",
    type: "EXPENSE",
    class: "EXPENSE",
    status: "ACTIVE",
  }],
  taxRates: [{
    name: "No Tax",
    taxType: "NONE",
    status: "ACTIVE",
    displayTaxRate: "0.0000",
    canApplyToExpenses: true,
  }],
};

const completeInput = {
  source_ref: "agent2://material/invoice-1",
  source_sha256: "a".repeat(64),
  supplier_name: "  ACME   LIMITED ",
  supplier_contact_number: "sup-001",
  invoice_date: "2026-08-01",
  due_date: "2026-08-31",
  currency: "HKD",
  reference: "INV-1001",
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Software subscription",
    quantity: 1,
    unit_amount: 100,
    account_name: "subscriptions",
    tax_name: "NO TAX",
  }],
};

describe("read-only supplier bill draft preparation", () => {
  it("builds a deterministic create proposal only from exact Xero matches", async () => {
    const { service, provider, getSupplierBillDraftReferenceData } = serviceWithReferenceData(referenceData);

    const first = await service.prepareSupplierBillDraft("actor-a", completeInput);
    const second = await service.prepareSupplierBillDraft("actor-a", completeInput);

    expect(first).toMatchObject({
      technicallyReady: true,
      readyForUserConfirmation: true,
      requiresUserConfirmation: true,
      executionAllowed: false,
    });
    expect(first.blockers).toEqual([]);
    expect(first.warnings).toContainEqual(expect.objectContaining({
      code: "SOURCE_HASH_AGENT_ASSERTED",
      path: "source_sha256",
    }));
    expect(first.proposal).toEqual({
      request_id: expect.stringMatching(/^xero-draft:[a-f0-9]{48}$/),
      source_ref: completeInput.source_ref,
      source_sha256: completeInput.source_sha256,
      source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
      contact_id: contactId,
      invoice_date: "2026-08-01",
      due_date: "2026-08-31",
      currency: "HKD",
      reference: "INV-1001",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Software subscription",
        quantity: 1,
        unit_amount: 100,
        account_code: "404",
        tax_type: "NONE",
      }],
    });
    expect(first.proposal).not.toHaveProperty("user_confirmation");
    expect(second.proposal?.request_id).toBe(first.proposal?.request_id);
    expect(first.evidence).toMatchObject({
      tenant: { id: "tenant-a", name: "Tenant A" },
      source: {
        ref: completeInput.source_ref,
        sha256: completeInput.source_sha256,
        trust: "AGENT_ASSERTED_UNVERIFIED",
      },
      supplier: { selected: { contactId } },
      lines: [{
        index: 0,
        account: { selected: { code: "404" } },
        taxRate: { selected: { taxType: "NONE" } },
      }],
    });
    expect(getSupplierBillDraftReferenceData).toHaveBeenCalledWith("actor-a", completeInput.supplier_name);
    expect(provider.createDraftSupplierBill).not.toHaveBeenCalled();
    expect(provider.authoriseSupplierBill).not.toHaveBeenCalled();
  });

  it("returns blockers and no proposal for missing fields or ambiguous contacts", async () => {
    const duplicateReferenceData: SupplierBillDraftReferenceData = {
      ...referenceData,
      contacts: [
        referenceData.contacts[0]!,
        { contactId: "33333333-3333-4333-8333-333333333333", name: "Acme Limited", status: "ACTIVE" },
      ],
    };
    const { service } = serviceWithReferenceData(duplicateReferenceData);

    const result = await service.prepareSupplierBillDraft("actor-a", {
      supplier_name: "Acme Limited",
      lines: [{}],
    });

    expect(result.proposal).toBeNull();
    expect(result).toMatchObject({
      technicallyReady: false,
      readyForUserConfirmation: false,
      requiresUserConfirmation: true,
      executionAllowed: false,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_FIELD", path: "source_ref" }),
      expect.objectContaining({ code: "MISSING_FIELD", path: "lines[0].description" }),
      expect.objectContaining({ code: "AMBIGUOUS_MATCH", path: "supplier_name" }),
    ]));
    const ambiguity = result.blockers.find((blocker) => blocker.code === "AMBIGUOUS_MATCH");
    expect(ambiguity?.candidates).toHaveLength(2);
  });

  it("creates a stable extraction fingerprint when Agent2 cannot supply a file hash", async () => {
    const { service } = serviceWithReferenceData(referenceData);
    const { source_sha256: _omittedHash, ...inputWithoutHash } = completeInput;

    const first = await service.prepareSupplierBillDraft("actor-a", inputWithoutHash);
    const second = await service.prepareSupplierBillDraft("actor-a", {
      ...inputWithoutHash,
      supplier_name: "acme limited",
      supplier_contact_number: "  SUP-001  ",
      lines: [{
        ...inputWithoutHash.lines[0]!,
        account_name: "  SUBSCRIPTIONS ",
        tax_name: "no tax",
      }],
    });

    expect(first).toMatchObject({
      technicallyReady: true,
      readyForUserConfirmation: true,
      requiresUserConfirmation: true,
      executionAllowed: false,
    });
    expect(first.blockers).toEqual([]);
    expect(first.proposal?.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.proposal?.source_evidence_type).toBe("SERVER_FINGERPRINTED_EXTRACTION");
    expect(first.proposal).not.toHaveProperty("user_confirmation");
    expect(first.proposal?.source_sha256).toBe(second.proposal?.source_sha256);
    expect(first.proposal?.request_id).toBe(second.proposal?.request_id);
    expect(first.evidence.source).toEqual({
      ref: completeInput.source_ref,
      sha256: first.proposal?.source_sha256,
      trust: "SERVER_FINGERPRINTED_EXTRACTION",
    });
    expect(first.warnings).toContainEqual(expect.objectContaining({
      code: "SOURCE_EXTRACTION_FINGERPRINT_ONLY",
      path: "source_sha256",
    }));
  });

  it("never turns a fuzzy Provider result into a guessed contact, account, or tax type", async () => {
    const { service } = serviceWithReferenceData({
      ...referenceData,
      contacts: [{ contactId, name: "Acme Holdings Limited", status: "ACTIVE" }],
      accounts: [{ code: "405", name: "Software subscriptions", status: "ACTIVE", class: "EXPENSE" }],
      taxRates: [{ taxType: "ZERORATED", name: "Zero Rated", status: "ACTIVE" }],
    });

    const result = await service.prepareSupplierBillDraft("actor-a", completeInput);

    expect(result.proposal).toBeNull();
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NO_EXACT_MATCH", path: "supplier_name" }),
      expect.objectContaining({ code: "NO_EXACT_MATCH", path: "lines[0].account" }),
      expect.objectContaining({ code: "NO_EXACT_MATCH", path: "lines[0].tax_rate" }),
    ]));
    expect(JSON.stringify(result)).not.toContain('"contact_id"');
    expect(JSON.stringify(result)).not.toContain('"account_code"');
  });

  it("blocks an exact tax match that Xero says cannot apply to the matched account", async () => {
    const { service } = serviceWithReferenceData({
      ...referenceData,
      taxRates: [{ ...referenceData.taxRates[0]!, canApplyToExpenses: false }],
    });

    const result = await service.prepareSupplierBillDraft("actor-a", completeInput);

    expect(result.proposal).toBeNull();
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "INELIGIBLE_MATCH",
      path: "lines[0].tax_rate",
    }));
  });

  it("fails closed when Xero contact pagination cannot prove a unique match", async () => {
    const { service } = serviceWithReferenceData({ ...referenceData, contactsComplete: false });

    const result = await service.prepareSupplierBillDraft("actor-a", completeInput);

    expect(result.proposal).toBeNull();
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "INCOMPLETE_EVIDENCE",
      path: "supplier_name",
    }));
    expect(result.evidence.supplier.selected).toBeUndefined();
  });
});

describe("Xero supplier bill preparation reference reads", () => {
  it("preserves revenue and equity applicability on the shared tax-rate read", async () => {
    const getTaxRates = vi.fn().mockResolvedValue({
      body: {
        taxRates: [{
          name: "Output Tax",
          taxType: "OUTPUT",
          status: "ACTIVE",
          canApplyToRevenue: true,
          canApplyToEquity: false,
        }],
      },
    });
    const client = { accountingApi: { getTaxRates } };
    const connection = { tenantId: "tenant-a", tenantName: "Tenant A" };
    const manager = {
      withClient: async <T>(
        _principal: unknown,
        action: (clientValue: typeof client, connectionValue: typeof connection) => Promise<T>,
      ): Promise<T> => action(client, connection),
    } as unknown as XeroClientManager;
    const provider = new XeroAccountingProvider({} as AccountingRepository, manager);

    await expect(provider.listTaxRates("actor-a")).resolves.toEqual([expect.objectContaining({
      taxType: "OUTPUT",
      canApplyToRevenue: true,
      canApplyToEquity: false,
    })]);
  });

  it("reads contacts, active accounts, and active tax rates from one bound Xero connection", async () => {
    const getAccounts = vi.fn().mockResolvedValue({
      body: { accounts: [{ accountID: "account-404", code: "404", name: "Subscriptions", status: "ACTIVE" }] },
    });
    const getTaxRates = vi.fn().mockResolvedValue({
      body: {
        taxRates: [{
          name: "No Tax",
          taxType: "NONE",
          status: "ACTIVE",
          displayTaxRate: 0,
          canApplyToRevenue: false,
          canApplyToEquity: true,
        }],
      },
    });
    const getContacts = vi.fn().mockResolvedValue({
      body: { contacts: [{ contactID: contactId, name: "Acme Limited", contactStatus: "ACTIVE" }] },
    });
    const client = { accountingApi: { getAccounts, getTaxRates, getContacts } };
    const connection = { tenantId: "tenant-a", tenantName: "Tenant A" };
    const manager = {
      withClient: async <T>(
        _principal: unknown,
        action: (clientValue: typeof client, connectionValue: typeof connection) => Promise<T>,
      ): Promise<T> => action(client, connection),
    } as unknown as XeroClientManager;
    const provider = new XeroAccountingProvider({} as AccountingRepository, manager);

    const result = await provider.getSupplierBillDraftReferenceData("actor-a", "Acme Limited");

    expect(getAccounts).toHaveBeenCalledWith("tenant-a", undefined, 'Status=="ACTIVE"', "Code ASC");
    expect(getTaxRates).toHaveBeenCalledWith("tenant-a", 'Status=="ACTIVE"', "Name ASC");
    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a", undefined, undefined, "Name ASC", undefined, 1, false, true, "Acme Limited", 100,
    );
    expect(result).toMatchObject({
      tenant: { id: "tenant-a", name: "Tenant A" },
      contacts: [{ contactId, name: "Acme Limited" }],
      accounts: [{ code: "404", name: "Subscriptions" }],
      taxRates: [{
        taxType: "NONE",
        name: "No Tax",
        displayTaxRate: "0.0000",
        canApplyToRevenue: false,
        canApplyToEquity: true,
      }],
    });
  });
});
