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
});
