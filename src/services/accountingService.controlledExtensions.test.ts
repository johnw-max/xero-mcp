import { describe, expect, it, vi } from "vitest";
import type { AccountingRepository } from "../db/repository.js";
import type { Logger } from "../logging.js";
import type { AccountingProvider } from "../providers/types.js";
import { createLegacySharedBearerRequestContext } from "../security/requestContext.js";
import { AccountingService } from "./accountingService.js";
import type { ConnectionTicketService } from "./connectionTicketService.js";
import type { XeroContactItemMutationService } from "./xeroContactItemMutationService.js";
import type { XeroCreditNoteManualJournalService } from "./xeroCreditNoteManualJournalService.js";

describe("AccountingService controlled extension routing", () => {
  it("delegates all twelve ledger-adjustment and master-data operations with the bound request context", async () => {
    const ledgerAdjustments = {
      prepareCreditNoteDraft: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      createCreditNoteDraft: vi.fn().mockResolvedValue({ state: "DRAFT_READBACK_VERIFIED" }),
      prepareManualJournalDraft: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      createManualJournalDraft: vi.fn().mockResolvedValue({ state: "DRAFT_READBACK_VERIFIED" }),
    };
    const masterData = {
      prepareContactCreate: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      createContact: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED" }),
      prepareContactUpdate: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      updateContact: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED" }),
      prepareItemCreate: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      createItem: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED" }),
      prepareItemUpdate: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      updateItem: vi.fn().mockResolvedValue({ state: "READBACK_VERIFIED" }),
    };
    const service = new AccountingService({
      repository: {} as AccountingRepository,
      provider: {} as AccountingProvider,
      config: { publicBaseUrl: "https://xero-mcp.example.test", xeroWriteEnabled: false },
      logger: {} as Logger,
      connectionTickets: {} as ConnectionTicketService,
      creditNoteManualJournalMutations:
        ledgerAdjustments as unknown as XeroCreditNoteManualJournalService,
      contactItemMutations: masterData as unknown as XeroContactItemMutationService,
    });
    const context = createLegacySharedBearerRequestContext({
      actorId: "accounting-service-extension-actor",
      audience: "https://xero-mcp.example.test/mcp",
    });
    const ids = {
      contact: "11111111-1111-4111-8111-111111111111",
      item: "22222222-2222-4222-8222-222222222222",
      debit: "33333333-3333-4333-8333-333333333333",
      credit: "44444444-4444-4444-8444-444444444444",
    };
    const source = { source_ref: "work-material:controlled-extension", source_unit_key: "page:1" };
    const execution = {
      preparation_id: `xmp_${"a".repeat(32)}`,
      request_id: "request-controlled-001",
      confirmation_phrase: "确认执行受控 Xero 操作",
    };

    await service.prepareCreditNoteDraft(context, {
      ...source,
      reason: "Customer pricing correction",
      credit_note_type: "ACCRECCREDIT",
      contact_id: ids.contact,
      credit_note_date: "2026-08-07",
      currency: "SGD",
      reference: "CN-DEMO-001",
      line_amount_type: "Exclusive",
      lines: [{
        description: "Controlled correction",
        quantity: 1,
        unit_amount: 10,
        account_id: ids.debit,
        account_code: "200",
        tax_type: "NONE",
      }],
    });
    await service.createCreditNoteDraft(context, execution);
    await service.prepareManualJournalDraft(context, {
      ...source,
      journal_date: "2026-08-07",
      narration: "Controlled reclassification",
      lines: [
        { account_id: ids.debit, account_code: "400", description: "Debit", line_amount: 10 },
        { account_id: ids.credit, account_code: "500", description: "Credit", line_amount: -10 },
      ],
    });
    await service.createManualJournalDraft(context, execution);
    await service.prepareContactCreate(context, {
      ...source,
      name: "Northwind Singapore",
      email: "accounts@northwind.example",
    });
    await service.createContact(context, execution);
    await service.prepareContactUpdate(context, {
      ...source,
      contact_id: ids.contact,
      patch: { name: "Northwind Singapore Pte Ltd" },
    });
    await service.updateContact(context, execution);
    await service.prepareItemCreate(context, {
      ...source,
      code: "CONSULT-01",
      name: "Consulting service",
      is_sold: true,
      is_purchased: true,
    });
    await service.createItem(context, execution);
    await service.prepareItemUpdate(context, {
      ...source,
      item_id: ids.item,
      patch: { name: "Consulting services" },
    });
    await service.updateItem(context, execution);

    for (const method of [...Object.values(ledgerAdjustments), ...Object.values(masterData)]) {
      expect(method).toHaveBeenCalledOnce();
      expect(method.mock.calls[0]?.[0]).toBe(context);
    }
  });

  it("fails closed when a controlled extension service was not configured", () => {
    const service = new AccountingService({
      repository: {} as AccountingRepository,
      provider: {} as AccountingProvider,
      config: { publicBaseUrl: "https://xero-mcp.example.test", xeroWriteEnabled: false },
      logger: {} as Logger,
      connectionTickets: {} as ConnectionTicketService,
    });
    const context = createLegacySharedBearerRequestContext({
      actorId: "accounting-service-extension-actor",
      audience: "https://xero-mcp.example.test/mcp",
    });

    expect(() => service.createCreditNoteDraft(context, {
      preparation_id: `xmp_${"a".repeat(32)}`,
      request_id: "request-controlled-001",
      confirmation_phrase: "确认执行受控 Xero 操作",
    })).toThrow(/ledger-adjustment service is unavailable/i);
    expect(() => service.createContact(context, {
      preparation_id: `xmp_${"a".repeat(32)}`,
      request_id: "request-controlled-001",
      confirmation_phrase: "确认执行受控 Xero 操作",
    })).toThrow(/Contact\/Item service is unavailable/i);
  });
});
