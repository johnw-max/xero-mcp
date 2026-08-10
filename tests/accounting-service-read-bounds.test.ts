import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { AccountingRepository } from "../src/db/repository.js";
import type { Logger } from "../src/logging.js";
import type { AccountingProvider, SupplierBillSnapshot } from "../src/providers/types.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";

function serviceWithProvider(provider: Partial<AccountingProvider>): AccountingService {
  return new AccountingService({
    repository: {} as AccountingRepository,
    provider: provider as AccountingProvider,
    config: {
      publicBaseUrl: "https://mcp.example.test",
      xeroWriteEnabled: false,
    } as Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">,
    logger: {} as Logger,
    connectionTickets: {} as ConnectionTicketService,
  });
}

function largeBill(): SupplierBillSnapshot {
  return {
    tenantId: "tenant-a",
    invoiceId: "11111111-1111-4111-8111-111111111111",
    type: "ACCPAY",
    status: "DRAFT",
    contact: { contactId: "22222222-2222-4222-8222-222222222222" },
    attachmentsKnown: true,
    hasAttachments: false,
    lines: Array.from({ length: 101 }, (_, index) => ({
      lineItemId: `line-${index}`,
      description: "x".repeat(1_001),
      quantity: "1.0000",
      unitAmount: "1.0000",
      accountCode: "200",
      taxType: "NONE",
    })),
    lineItemCount: 101,
    linesTruncated: false,
  };
}

describe("Agent-facing invoice read bounds", () => {
  it("passes validated contact-list filters and pagination to the bound provider", async () => {
    const listContacts = vi.fn().mockResolvedValue({
      contacts: [],
      pagination: {
        page: 2,
        pageSize: 25,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    });
    const service = serviceWithProvider({ listContacts });
    const input = {
      status: "ACTIVE" as const,
      is_supplier: true,
      page: 2,
      limit: 25,
    };

    await service.listContacts("actor-a", input);

    expect(listContacts).toHaveBeenCalledWith("actor-a", input);
  });

  it("reads one contact by its exact ContactID through the bound provider", async () => {
    const contact_id = "22222222-2222-4222-8222-222222222222";
    const getContact = vi.fn().mockResolvedValue({
      contactId: contact_id,
      name: "Exact Supplier",
      status: "ACTIVE",
    });
    const service = serviceWithProvider({ getContact });

    await expect(service.getContact("actor-a", { contact_id })).resolves.toMatchObject({
      contactId: contact_id,
      name: "Exact Supplier",
    });
    expect(getContact).toHaveBeenCalledWith("actor-a", contact_id);
  });

  it("returns a stable NOT_FOUND error when the exact ContactID does not exist", async () => {
    const contact_id = "33333333-3333-4333-8333-333333333333";
    const service = serviceWithProvider({ getContact: vi.fn().mockResolvedValue(undefined) });

    await expect(service.getContact("actor-a", { contact_id })).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("passes the validated contact-search page to the provider", async () => {
    const searchContacts = vi.fn().mockResolvedValue({
      contacts: [],
      pagination: {
        page: 7,
        pageSize: 5,
        returned: 0,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      },
    });
    const service = serviceWithProvider({ searchContacts });

    await service.searchContacts("actor-a", { query: "Acme", limit: 5, page: 7 });

    expect(searchContacts).toHaveBeenCalledWith("actor-a", "Acme", 5, 7);
  });

  it("keeps the legacy supplier-bill tool bounded without changing provider readback", async () => {
    const providerBill = largeBill();
    const getSupplierBill = vi.fn().mockResolvedValue(providerBill);
    const service = serviceWithProvider({ getSupplierBill });

    const result = await service.getSupplierBill("actor-a", providerBill.invoiceId);

    expect(result.lines).toHaveLength(100);
    expect(result.lineItemCount).toBe(101);
    expect(result.linesTruncated).toBe(true);
    expect(result.lines[0]?.description).toHaveLength(1_000);
    expect(result.lines[0]?.descriptionTruncated).toBe(true);
    expect(providerBill.lines).toHaveLength(101);
  });

  it("also caps long descriptions returned by the generic invoice tool", async () => {
    const providerInvoice = { ...largeBill(), type: "ACCREC" as const, lines: largeBill().lines.slice(0, 1) };
    const getInvoice = vi.fn().mockResolvedValue(providerInvoice);
    const service = serviceWithProvider({ getInvoice });

    const result = await service.getInvoice("actor-a", {
      invoice_id: providerInvoice.invoiceId,
      type: "ACCREC",
    });

    expect(result.lines[0]?.description).toHaveLength(1_000);
    expect(result.lines[0]?.descriptionTruncated).toBe(true);
  });

  it("enforces a UTF-8 byte budget for multibyte Agent output", async () => {
    const providerInvoice = {
      ...largeBill(),
      type: "ACCREC" as const,
      lines: largeBill().lines.slice(0, 100).map((line) => ({
        ...line,
        description: "会".repeat(1_000),
      })),
      lineItemCount: 100,
    };
    const getInvoice = vi.fn().mockResolvedValue(providerInvoice);
    const service = serviceWithProvider({ getInvoice });

    const result = await service.getInvoice("actor-a", {
      invoice_id: providerInvoice.invoiceId,
      type: "ACCREC",
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(128 * 1_024);
    expect(result.lines.length).toBeLessThan(100);
    expect(result.linesTruncated).toBe(true);
    expect(providerInvoice.lines).toHaveLength(100);
  });
});
