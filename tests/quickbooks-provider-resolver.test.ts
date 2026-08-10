import { describe, expect, it, vi } from "vitest";
import type { QuickBooksClientManager } from "../src/quickbooks/clientManager.js";
import { ServerBoundQuickBooksProviderResolver } from "../src/quickbooks/providerResolver.js";

describe("QuickBooks provider resolver connection management", () => {
  it("returns a one-time Intuit link for replacing an already connected company", async () => {
    const manager = {
      resolveSingleConnection: vi.fn().mockResolvedValue({
        realmId: "934145",
        companyName: "Sandbox Company A",
        grantedScopes: ["com.intuit.quickbooks.accounting"],
      }),
    } as unknown as QuickBooksClientManager;
    const resolver = new ServerBoundQuickBooksProviderResolver({
      manager,
      connectUrl: vi.fn().mockResolvedValue({
        url: "https://quickbooks-mcp.example.test/connect/quickbooks?ticket=one-time",
        expiresAt: new Date("2026-08-06T02:30:00.000Z"),
      }),
    });

    await expect(resolver.connectionStatus("actor-a")).resolves.toEqual({
      connected: true,
      company: { realmId: "934145", name: "Sandbox Company A" },
      scopes: ["com.intuit.quickbooks.accounting"],
      connectUrl: "https://quickbooks-mcp.example.test/connect/quickbooks?ticket=one-time",
      connectUrlExpiresAt: "2026-08-06T02:30:00.000Z",
      connectAction: "REPLACE_CURRENT_COMPANY",
    });
  });
});
