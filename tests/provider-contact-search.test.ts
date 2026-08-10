import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  SYNTHETIC_CONNECTION_ID,
  SyntheticXeroAccountingProvider,
} from "../harness/lib/syntheticXeroAccountingProvider.js";

const connection = {
  tenantId: "tenant-a",
  tenantName: "Tenant A",
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

describe("provider contact search evidence", () => {
  it("keeps synthetic list filtering and pagination faithful to the production contract", async () => {
    const provider = new SyntheticXeroAccountingProvider({
      synthetic: true,
      organisation: { organisationId: "tenant-a", name: "Tenant A" },
      contacts: [
        {
          contactId: "11111111-1111-4111-8111-111111111111",
          name: "Active Supplier",
          status: "ACTIVE",
          isSupplier: true,
          isCustomer: false,
        },
        {
          contactId: "22222222-2222-4222-8222-222222222222",
          name: "Active Customer",
          status: "ACTIVE",
          isSupplier: false,
          isCustomer: true,
        },
      ],
    });
    const principal = {
      actorId: "actor-a",
      workspaceId: "workspace-a",
      subjectType: "user",
      subjectId: "subject-a",
      agentId: "agent-a",
      oauthInstallationId: "installation-a",
      bindingId: "binding-a",
      connectionId: SYNTHETIC_CONNECTION_ID,
      scopes: ["xero.read"],
    } as const;

    const result = await provider.listContacts(principal, {
      status: "ACTIVE",
      is_supplier: true,
      page: 1,
      limit: 1,
    });

    expect(result.contacts.map((contact) => contact.name)).toEqual(["Active Supplier"]);
    expect(result.pagination).toMatchObject({
      page: 1,
      pageSize: 1,
      returned: 1,
      providerPageCount: 1,
      providerItemCount: 1,
      hasNextPage: false,
    });
  });

  it("lists one bounded Xero contact page with reviewed status and role filters", async () => {
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [{
          contactID: "11111111-1111-4111-8111-111111111111",
          name: "Archived Supplier",
          contactStatus: "ARCHIVED",
          isSupplier: true,
          isCustomer: false,
        }],
        pagination: { page: 3, pageSize: 25, pageCount: 4, itemCount: 76 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.listContacts("actor-a", {
      status: "ARCHIVED",
      is_supplier: true,
      is_customer: false,
      page: 3,
      limit: 25,
    });

    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      'ContactStatus=="ARCHIVED" AND IsSupplier==true AND IsCustomer==false',
      "Name ASC",
      undefined,
      3,
      true,
      false,
      undefined,
      25,
    );
    expect(result).toEqual({
      contacts: [{
        contactId: "11111111-1111-4111-8111-111111111111",
        name: "Archived Supplier",
        status: "ARCHIVED",
        isSupplier: true,
        isCustomer: false,
      }],
      pagination: {
        page: 3,
        pageSize: 25,
        returned: 1,
        providerPageCount: 4,
        providerItemCount: 76,
        hasNextPage: true,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    });
  });

  it("reads only the requested ContactID and returns the safe contact projection", async () => {
    const contactId = "11111111-1111-4111-8111-111111111111";
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [{
          contactID: contactId,
          name: "Exact Contact",
          contactStatus: "ACTIVE",
          isSupplier: true,
          isCustomer: true,
          bankAccountDetails: "must-not-be-returned",
          taxNumber: "must-not-be-returned",
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.getContact("actor-a", contactId);

    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      undefined,
      undefined,
      [contactId],
      1,
      true,
      false,
      undefined,
      1,
    );
    expect(result).toEqual({
      contactId,
      name: "Exact Contact",
      status: "ACTIVE",
      isSupplier: true,
      isCustomer: true,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("matches an exact ContactID case-insensitively while preserving the provider identifier", async () => {
    const providerContactId = "11111111-aaaa-4bbb-8ccc-222222222222";
    const requestedContactId = providerContactId.toUpperCase();
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [{
          contactID: providerContactId,
          name: "Exact Contact",
          contactStatus: "ACTIVE",
        }],
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.getContact("actor-a", requestedContactId);

    expect(result?.contactId).toBe(providerContactId);
    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      undefined,
      undefined,
      [requestedContactId],
      1,
      true,
      false,
      undefined,
      1,
    );
  });

  it("keeps the synthetic provider faithful to caller-selected contact pages", async () => {
    const provider = new SyntheticXeroAccountingProvider({
      synthetic: true,
      organisation: { organisationId: "tenant-a", name: "Tenant A" },
      contacts: [
        { contactId: "11111111-1111-4111-8111-111111111111", name: "Twin Supplier One" },
        { contactId: "22222222-2222-4222-8222-222222222222", name: "Twin Supplier Two" },
      ],
    });
    const principal = {
      actorId: "actor-a",
      workspaceId: "workspace-a",
      subjectType: "user",
      subjectId: "subject-a",
      agentId: "agent-a",
      oauthInstallationId: "installation-a",
      bindingId: "binding-a",
      connectionId: SYNTHETIC_CONNECTION_ID,
      scopes: ["xero.read"],
    } as const;

    const result = await provider.searchContacts(principal, "Twin Supplier", 1, 2);

    expect(result.contacts.map((contact) => contact.contactId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(result.pagination).toMatchObject({
      page: 2,
      pageSize: 1,
      returned: 1,
      providerPageCount: 2,
      providerItemCount: 2,
      hasNextPage: false,
    });
    expect(provider.calls.at(-1)?.input).toEqual({ query: "Twin Supplier", limit: 1, page: 2 });
  });

  it("passes the caller-selected page through to the Xero contacts API", async () => {
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [],
        pagination: { page: 3, pageSize: 25, pageCount: 4, itemCount: 76 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.searchContacts("actor-a", "Acme Supplies", 25, 3);

    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      undefined,
      "Name ASC",
      undefined,
      3,
      false,
      true,
      "Acme Supplies",
      25,
    );
    expect(result.pagination).toMatchObject({
      page: 3,
      pageSize: 25,
      providerPageCount: 4,
      providerItemCount: 76,
      hasNextPage: true,
    });
  });

  it("returns Xero pagination so an Agent cannot present the first page as an exhaustive match", async () => {
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "11111111-1111-4111-8111-111111111111",
            name: "Acme Supplies Limited",
            contactStatus: "ACTIVE",
            isSupplier: true,
          },
          { name: "Invalid result without a ContactID" },
        ],
        pagination: { page: 1, pageSize: 25, pageCount: 3, itemCount: 52 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.searchContacts("actor-a", "Acme Supplies", 25);

    expect(result).toEqual({
      contacts: [{
        contactId: "11111111-1111-4111-8111-111111111111",
        name: "Acme Supplies Limited",
        status: "ACTIVE",
        isSupplier: true,
      }],
      pagination: {
        page: 1,
        pageSize: 25,
        returned: 1,
        providerPageCount: 3,
        providerItemCount: 52,
        hasNextPage: true,
        hasNextPageIsEstimated: false,
        omittedInvalid: 1,
      },
    });
  });

  it("marks completeness as estimated when Xero omits pagination metadata", async () => {
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [
          { contactID: "11111111-1111-4111-8111-111111111111", name: "Acme One" },
          { contactID: "22222222-2222-4222-8222-222222222222", name: "Acme Two" },
        ],
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.searchContacts("actor-a", "Acme", 2);

    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 2,
      returned: 2,
      hasNextPage: true,
      hasNextPageIsEstimated: true,
      omittedInvalid: 0,
    });
  });
});
