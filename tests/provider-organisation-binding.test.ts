import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

const connection = {
  connectionId: "conn-a",
  actorId: "actor-a",
  provider: "xero" as const,
  tenantId: "tenant-bound",
  tenantName: "Bound organisation",
  grantedScopes: ["accounting.settings.read"],
  tokenCiphertext: "test-only",
  tokenExpiresAt: new Date("2026-08-05T13:00:00Z"),
  refreshVersion: 0,
  status: "ACTIVE" as const,
  createdAt: new Date("2026-08-05T12:00:00Z"),
  updatedAt: new Date("2026-08-05T12:00:00Z"),
};

function providerWithClient(client: unknown): XeroAccountingProvider {
  const manager = {
    withClient: async <T>(
      _actorId: string,
      action: (clientValue: unknown, connectionValue: typeof connection) => Promise<T>,
    ): Promise<T> => action(client, connection),
  } as unknown as XeroClientManager;
  return new XeroAccountingProvider({} as AccountingRepository, manager);
}

describe("provider organisation binding", () => {
  it("rejects a response that does not contain the exact bound tenant", async () => {
    const getOrganisations = vi.fn().mockResolvedValue({
      body: {
        organisations: [{
          organisationID: "tenant-other",
          name: "Another organisation",
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getOrganisations } });

    await expect(provider.getOrganisation("actor-a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(getOrganisations).toHaveBeenCalledWith("tenant-bound");
  });

  it("returns direct tax, financial-year and lock settings without inferring them from tax rates", async () => {
    const getOrganisations = vi.fn().mockResolvedValue({
      body: {
        organisations: [{
          organisationID: "tenant-bound",
          name: "Bound organisation",
          countryCode: "SG",
          baseCurrency: "SGD",
          paysTax: false,
          financialYearEndDay: 31,
          financialYearEndMonth: 12,
          salesTaxBasis: "INVOICE",
          salesTaxPeriod: "QUARTERLY",
          defaultSalesTax: "OUTPUTY24",
          defaultPurchasesTax: "INPUTY24",
          periodLockDate: "2026-06-30",
          endOfYearLockDate: "2025-12-31",
          isDemoCompany: true,
          organisationStatus: "ACTIVE",
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getOrganisations } });

    await expect(provider.getOrganisation("actor-a")).resolves.toMatchObject({
      organisationId: "tenant-bound",
      paysTax: false,
      financialYearEndDay: 31,
      financialYearEndMonth: 12,
      salesTaxBasis: "INVOICE",
      salesTaxPeriod: "QUARTERLY",
      defaultSalesTax: "OUTPUTY24",
      defaultPurchasesTax: "INPUTY24",
      periodLockDate: "2026-06-30",
      endOfYearLockDate: "2025-12-31",
      isDemoCompany: true,
      organisationStatus: "ACTIVE",
    });
    expect(getOrganisations).toHaveBeenCalledWith("tenant-bound");
  });

  it("normalises the lock dates Xero actually returns into calendar strings", async () => {
    // The Xero SDK deserialises these two into Date objects. Every consumer
    // downstream treats them as YYYY-MM-DD strings: the case target schema
    // rejects anything else outright, and the period-lock guard compares them
    // with <=, which on a Date silently compares against "Tue Jun 30 2026...".
    const getOrganisations = vi.fn().mockResolvedValue({
      body: {
        organisations: [{
          organisationID: "tenant-bound",
          name: "Bound organisation",
          periodLockDate: new Date("2026-06-30T00:00:00.000Z"),
          endOfYearLockDate: new Date("2025-12-31T00:00:00.000Z"),
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getOrganisations } });

    const organisation = await provider.getOrganisation("actor-a");

    expect(organisation.periodLockDate).toBe("2026-06-30");
    expect(organisation.endOfYearLockDate).toBe("2025-12-31");
  });

  it("drops a lock date it cannot read rather than passing an unusable value on", async () => {
    const getOrganisations = vi.fn().mockResolvedValue({
      body: {
        organisations: [{
          organisationID: "tenant-bound",
          name: "Bound organisation",
          periodLockDate: "not a date at all",
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getOrganisations } });

    const organisation = await provider.getOrganisation("actor-a");

    expect(organisation.periodLockDate).toBeUndefined();
  });

  it("normalises the real captured Xero organisation, including its live Date-typed lock date", async () => {
    // proves: the hand-built Date/string cases above cover the mechanism, but
    // never ran against a real capture. The live periodLockDate is a genuine
    // xero-node Date instance (see runtime-types.json), and endOfYearLockDate
    // is entirely absent (not null, not ""), which a hand-built fixture would
    // rarely think to omit rather than set.
    const [organisation] = loadXeroResponse("organisation").organisations as Array<Record<string, unknown>>;
    const getOrganisations = vi.fn().mockResolvedValue({
      body: { organisations: [{ ...organisation, organisationID: "tenant-bound" }] },
    });
    const provider = providerWithClient({ accountingApi: { getOrganisations } });

    const result = await provider.getOrganisation("actor-a");

    expect(result).toEqual({
      organisationId: "tenant-bound",
      name: "Demo Company (Global)",
      legalName: "Demo Company (Global)",
      countryCode: "CA",
      baseCurrency: "USD",
      organisationType: "COMPANY",
      version: "GLOBAL",
      paysTax: true,
      financialYearEndDay: 31,
      financialYearEndMonth: 12,
      salesTaxBasis: "ACCRUALS",
      salesTaxPeriod: "3MONTHLY",
      defaultSalesTax: "Remember previous",
      defaultPurchasesTax: "Remember previous",
      periodLockDate: "2008-09-30",
      isDemoCompany: true,
      organisationStatus: "ACTIVE",
    });
    expect(result).not.toHaveProperty("endOfYearLockDate");
  });
});

describe("provider account and tax-rate settings reads", () => {
  it("lists every real captured Xero account without leaking a bank account number", async () => {
    // proves: listAccounts must keep ignoring bankAccountNumber/systemAccount
    // even though the real payload carries them on every row. A hand-built
    // fixture that never included a bank account number could not catch a
    // future field-spread regression that started forwarding it.
    const { accounts } = loadXeroResponse("accounts") as { accounts: Array<Record<string, unknown>> };
    const getAccounts = vi.fn().mockResolvedValue({ body: { accounts } });
    const provider = providerWithClient({ accountingApi: { getAccounts } });

    const result = await provider.listAccounts("actor-a");

    expect(result).toHaveLength(accounts.length);
    expect(result.find((account) => account.code === "090")).toEqual({
      accountId: "562555f2-8cde-4ce9-8203-0363922537a4",
      code: "090",
      name: "Business Bank Account",
      type: "BANK",
      class: "ASSET",
      status: "ACTIVE",
      taxType: "NONE",
    });
    expect(JSON.stringify(result)).not.toContain("9999999999999");
  });

  it("keeps a real zero-rate tax entry's displayTaxRate instead of dropping it as falsy", async () => {
    // proves: listTaxRates renders the rate through decimal(), which turns 0
    // into the truthy string "0.0000" before the `? :` include check. A
    // hand-built fixture using a non-zero rate would never exercise the
    // exact falsy-zero pitfall a naive `tax.displayTaxRate ? ... : ...` on the
    // raw number would fall into.
    const { taxRates } = loadXeroResponse("tax_rates") as { taxRates: Array<Record<string, unknown>> };
    const getTaxRates = vi.fn().mockResolvedValue({ body: { taxRates } });
    const provider = providerWithClient({ accountingApi: { getTaxRates } });

    const result = await provider.listTaxRates("actor-a");

    expect(result).toHaveLength(taxRates.length);
    expect(result.find((rate) => rate.taxType === "CAN030")).toEqual({
      name: "Exempt Sales",
      taxType: "CAN030",
      status: "ACTIVE",
      displayTaxRate: "0.0000",
      effectiveRate: "0.0000",
      canApplyToExpenses: false,
      canApplyToAssets: true,
      canApplyToLiabilities: true,
      canApplyToRevenue: true,
      canApplyToEquity: true,
    });
    expect(JSON.stringify(result)).not.toContain("taxComponents");
  });
});
