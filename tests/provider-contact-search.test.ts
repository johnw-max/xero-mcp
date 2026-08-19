import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../src/db/repository.js";
import { XeroClientManager } from "../src/providers/xeroClientManager.js";
import { XeroAccountingProvider } from "../src/providers/xeroProvider.js";
import {
  SYNTHETIC_CONNECTION_ID,
  SyntheticXeroAccountingProvider,
} from "../harness/lib/syntheticXeroAccountingProvider.js";
import {
  capturedEmptyArrayFields,
  loadXeroResponse,
} from "./fixtures/xero-provider-responses/index.js";

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

  it("asks Xero to include inactive rows when scanning GDPRREQUEST contacts", async () => {
    const getContacts = vi.fn().mockResolvedValue({
      body: {
        contacts: [{
          contactID: "99999999-9999-4999-8999-999999999999",
          name: "Erasure Requested Contact",
          contactStatus: "GDPRREQUEST",
        }],
        pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 },
      },
    });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    await provider.listContacts("actor-a", {
      status: "GDPRREQUEST",
      page: 1,
      limit: 100,
    });

    expect(getContacts).toHaveBeenCalledWith(
      "tenant-a",
      undefined,
      'ContactStatus=="GDPRREQUEST"',
      "Name ASC",
      undefined,
      1,
      true,
      false,
      undefined,
      100,
    );
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

describe("provider contact reads against a captured Xero response", () => {
  it("reads back a real contact without leaking bank details or a false email", async () => {
    // proves: real Xero sends emailAddress/bankAccountDetails as "" rather than
    // omitting the key. mapContact's `if (contact.emailAddress)` must treat ""
    // as absent - a hand-built fixture that just omits the key would never
    // exercise that branch, and a fixture using `emailAddress: undefined` would
    // pass even if the guard used `!== undefined` instead of a truthiness check.
    const [contact] = loadXeroResponse("contact_single").contacts as Array<Record<string, unknown>>;
    const contactId = contact.contactID as string;
    const getContacts = vi.fn().mockResolvedValue({ body: { contacts: [contact] } });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.getContact("actor-a", contactId);

    expect(result).toEqual({
      contactId,
      name: "Halstead Cleaning Services",
      accountNumber: "HALSTEAD_CLEANING_001",
      contactNumber: "ZC:zcacct:51ba1cf9d7d125581bc5f5e468b1b4f3",
      status: "ACTIVE",
      isSupplier: true,
      isCustomer: false,
    });
    expect(JSON.stringify(result)).not.toContain("bankAccountDetails");
  });

  it("returns exact, non-estimated pagination for a real single-contact Xero page", async () => {
    // proves: the real contacts envelope carries itemCount/page/pageCount/
    // pageSize even for a one-row result; a regression that only special-cased
    // multi-page envelopes would slip past hand-built single-item fixtures that
    // never included a pagination block at all.
    const body = loadXeroResponse("contact_single") as {
      contacts: Array<Record<string, unknown>>;
      pagination: Record<string, number>;
    };
    const getContacts = vi.fn().mockResolvedValue({ body });
    const provider = providerWithClient({ accountingApi: { getContacts } });

    const result = await provider.listContacts("actor-a", {
      status: "ACTIVE",
      is_supplier: true,
      page: 1,
      limit: 100,
    });

    expect(result.contacts).toEqual([{
      contactId: body.contacts[0]?.contactID,
      name: "Halstead Cleaning Services",
      accountNumber: "HALSTEAD_CLEANING_001",
      contactNumber: "ZC:zcacct:51ba1cf9d7d125581bc5f5e468b1b4f3",
      status: "ACTIVE",
      isSupplier: true,
      isCustomer: false,
    }]);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 100,
      returned: 1,
      providerPageCount: 1,
      providerItemCount: 1,
      hasNextPage: false,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
    });
  });

  it("marks a genuinely empty Xero filter as estimated, not as an exact zero-page answer", async () => {
    // proves (and pins today's production behaviour for the src/ defect this
    // exposes - see the task report): the captured contacts_empty_filter body
    // is exactly `{ "contacts": [] }` - Xero drops the whole pagination
    // envelope rather than sending pageCount 0 / itemCount 0. xeroProvider.ts
    // reads `response.body.pagination?.pageCount`, which is undefined here, so
    // providerPageCount/providerItemCount end up absent and
    // hasNextPageIsEstimated is forced true even though zero rows is a
    // complete, certain answer. If this ever starts reporting
    // providerPageCount: 0 instead, xeroAccountingCaseService.ts's
    // emptyExactScan fast path (and xeroBusinessCoordinateHistory.ts's
    // emptyExactHistory) would finally see the shape their own comments assume.
    expect(capturedEmptyArrayFields("contacts_empty_filter")).toEqual(["contacts"]);
    const body = loadXeroResponse("contacts_empty_filter");
    expect(body).toEqual({ contacts: [] });

    const listGetContacts = vi.fn().mockResolvedValue({ body });
    const listProvider = providerWithClient({ accountingApi: { getContacts: listGetContacts } });
    const listed = await listProvider.listContacts("actor-a", { status: "ARCHIVED", page: 1, limit: 100 });
    expect(listed.contacts).toEqual([]);
    expect(listed.pagination).toEqual({
      page: 1,
      pageSize: 100,
      returned: 0,
      hasNextPage: false,
      hasNextPageIsEstimated: true,
      omittedInvalid: 0,
    });

    const searchGetContacts = vi.fn().mockResolvedValue({ body });
    const searchProvider = providerWithClient({ accountingApi: { getContacts: searchGetContacts } });
    const searched = await searchProvider.searchContacts("actor-a", "no-such-supplier", 100);
    expect(searched.contacts).toEqual([]);
    expect(searched.pagination).toEqual({
      page: 1,
      pageSize: 100,
      returned: 0,
      hasNextPage: false,
      hasNextPageIsEstimated: true,
      omittedInvalid: 0,
    });
  });

  it("gives a genuinely empty synthetic contact page an exact zero page count, not a floor of one", async () => {
    // proves: harness/lib/syntheticXeroAccountingProvider.ts's page() helper
    // used to force providerPageCount to Math.max(1, ...), so an empty
    // synthetic result claimed to be "page 1 of 1" instead of "0 pages" - the
    // same test-double-echoes-back shape the captured contacts_empty_filter
    // fixture shows real Xero avoids by omitting the count instead. This pins
    // the fixed behaviour: an empty synthetic page now reports 0/0, matching
    // what the emptyExactScan/emptyExactHistory fast paths in src/ expect.
    const provider = new SyntheticXeroAccountingProvider({
      synthetic: true,
      organisation: { organisationId: "tenant-a", name: "Tenant A" },
      contacts: [],
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
      page: 1,
      limit: 100,
    });

    expect(result.contacts).toEqual([]);
    expect(result.pagination).toMatchObject({
      providerPageCount: 0,
      providerItemCount: 0,
      hasNextPage: false,
    });
  });
});
