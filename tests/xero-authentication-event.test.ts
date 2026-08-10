import { describe, expect, it, vi } from "vitest";
import {
  xeroTenantsForAuthenticationEvent,
} from "../src/oauth/xeroAuthenticationEvent.js";

function accessToken(authenticationEventId: string): string {
  const payload = Buffer.from(JSON.stringify({
    authentication_event_id: authenticationEventId,
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function clientFor(connections: Array<Record<string, unknown>>) {
  const getOrganisations = vi.fn(async (tenantId: string) => ({
    body: {
      organisations: [{ organisationID: tenantId, name: `Organisation ${tenantId}` }],
    },
  }));
  return {
    client: {
      updateTenants: vi.fn(async () => connections),
      accountingApi: { getOrganisations },
    },
    getOrganisations,
  };
}

describe("xeroTenantsForAuthenticationEvent", () => {
  it("keeps only connections tagged with the current authentication event", async () => {
    const { client, getOrganisations } = clientFor([
      { id: "old-connection", tenantId: "old-tenant", authEventId: "old-event" },
      { id: "new-connection", tenantId: "new-tenant", authEventId: "current-event" },
    ]);

    const tenants = await xeroTenantsForAuthenticationEvent(
      client as never,
      accessToken("current-event"),
    );

    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ id: "new-connection", tenantId: "new-tenant" });
    expect(getOrganisations).toHaveBeenCalledTimes(1);
    expect(getOrganisations).toHaveBeenCalledWith("new-tenant");
  });

  it("accepts the sole token-visible connection during an existing-organisation re-authorisation", async () => {
    const { client, getOrganisations } = clientFor([
      { id: "existing-connection", tenantId: "existing-tenant", authEventId: "older-event" },
    ]);

    const tenants = await xeroTenantsForAuthenticationEvent(
      client as never,
      accessToken("current-event"),
    );

    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      id: "existing-connection",
      tenantId: "existing-tenant",
      orgData: { name: "Organisation existing-tenant" },
    });
    expect(getOrganisations).toHaveBeenCalledTimes(1);
  });

  it("returns every fresh-token-visible connection for explicit selection when Xero retains older event tags", async () => {
    const { client, getOrganisations } = clientFor([
      { id: "connection-a", tenantId: "tenant-a", authEventId: "older-event-a" },
      { id: "connection-b", tenantId: "tenant-b", authEventId: "older-event-b" },
    ]);

    const tenants = await xeroTenantsForAuthenticationEvent(
      client as never,
      accessToken("current-event"),
    );

    expect(tenants).toHaveLength(2);
    expect(tenants).toEqual([
      expect.objectContaining({ id: "connection-a", tenantId: "tenant-a" }),
      expect.objectContaining({ id: "connection-b", tenantId: "tenant-b" }),
    ]);
    expect(getOrganisations).toHaveBeenCalledTimes(2);
  });

  it("fails closed before tenant reads when Xero returns an unbounded connection set", async () => {
    const { client, getOrganisations } = clientFor(Array.from({ length: 101 }, (_, index) => ({
      id: `connection-${index}`,
      tenantId: `tenant-${index}`,
      authEventId: `older-event-${index}`,
    })));

    await expect(xeroTenantsForAuthenticationEvent(
      client as never,
      accessToken("current-event"),
    )).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(getOrganisations).not.toHaveBeenCalled();
  });
});
