import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";

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
});
