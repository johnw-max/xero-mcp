import { describe, expect, it } from "vitest";
import { Quote } from "xero-node";
import { listBankTransactionsSchema } from "../src/domain/extendedReadSchemas.js";
import {
  capturedDateFields,
  loadXeroResponse,
} from "./fixtures/xero-provider-responses/index.js";
import {
  buildBankTransactionReadQuery,
  buildItemReadQuery,
  buildManualJournalReadQuery,
  buildPurchaseOrderReadQuery,
  buildQuoteReadQuery,
  mapBankTransactionSnapshot,
  mapBoundedExtendedReadPage,
  mapItemSummary,
  mapManualJournalSnapshot,
  mapPurchaseOrderSummary,
  mapPurchaseOrderSnapshot,
  mapQuoteSnapshot,
  mapQuoteSummary,
} from "../src/providers/xeroExtendedReadMapper.js";

const quoteId = "11111111-1111-4111-8111-111111111111";
const purchaseOrderId = "22222222-2222-4222-8222-222222222222";
const manualJournalId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const bankTransactionId = "55555555-5555-4555-8555-555555555555";
const contactId = "66666666-6666-4666-8666-666666666666";
const bankAccountId = "77777777-7777-4777-8777-777777777777";

describe("extended Xero read query builders", () => {
  it("translates quote and purchase-order filters into reviewed SDK arguments", () => {
    expect(buildQuoteReadQuery({
      status: "ACCEPTED",
      contact_id: contactId,
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      expiry_date_from: "2026-08-08",
      expiry_date_to: "2026-12-31",
      quote_number: "QU-42",
      page: 2,
      page_size: 25,
      sort: "EXPIRY_DATE_ASC",
    })).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-08-07",
      expiryDateFrom: "2026-08-08",
      expiryDateTo: "2026-12-31",
      contactID: contactId,
      status: "ACCEPTED",
      providerPage: 1,
      inPageOffset: 25,
      fetchNextProviderPage: false,
      order: "ExpiryDate ASC",
      quoteNumber: "QU-42",
      resultLimit: 25,
    });

    expect(buildQuoteReadQuery({
      page: 4,
      page_size: 30,
      sort: "DATE_DESC",
    })).toMatchObject({
      providerPage: 1,
      inPageOffset: 90,
      fetchNextProviderPage: true,
      resultLimit: 30,
    });

    expect(buildPurchaseOrderReadQuery({
      status: "SUBMITTED",
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      page: 3,
      page_size: 40,
      sort: "UPDATED_AT_DESC",
    })).toEqual({
      status: "SUBMITTED",
      dateFrom: "2026-01-01",
      dateTo: "2026-08-07",
      order: "UpdatedDateUTC DESC",
      page: 3,
      pageSize: 40,
    });
  });

  it("constructs manual-journal, item, and bank-transaction where clauses on the server", () => {
    expect(buildManualJournalReadQuery({
      status: "POSTED",
      date_from: "2026-01-01",
      date_to: "2026-08-07",
      search_term: "month-end accrual",
      page: 4,
      page_size: 25,
      sort: "DATE_ASC",
    })).toEqual({
      where: 'Status=="POSTED" AND Date>=DateTime(2026,1,1) AND Date<=DateTime(2026,8,7) AND Narration.Contains("month-end accrual")',
      order: "Date ASC",
      page: 4,
      pageSize: 25,
    });

    expect(buildItemReadQuery({
      is_sold: true,
      is_purchased: false,
      is_tracked_as_inventory: true,
      search_term: "consulting",
      page: 2,
      page_size: 20,
      sort: "NAME_DESC",
    })).toEqual({
      where: 'IsSold==true AND IsPurchased==false AND IsTrackedAsInventory==true AND (Code.Contains("consulting") OR Name.Contains("consulting"))',
      order: "Name DESC",
      localPage: 2,
      localPageSize: 20,
    });

    expect(buildBankTransactionReadQuery({
      type: "SPEND",
      status: "AUTHORISED",
      is_reconciled: false,
      contact_id: contactId,
      bank_account_id: bankAccountId,
      invoice_number: "PP-0042",
      date_from: "2026-08-01",
      date_to: "2026-08-07",
      search_term: "CARD-42",
      page: 5,
      page_size: 100,
      sort: "UPDATED_AT_DESC",
    })).toEqual({
      where: `Type=="SPEND" AND Status=="AUTHORISED" AND IsReconciled==false AND Contact.ContactID==Guid("${contactId}") AND BankAccount.AccountID==Guid("${bankAccountId}") AND Date>=DateTime(2026,8,1) AND Date<=DateTime(2026,8,7) AND InvoiceNumber=="PP-0042" AND Reference.Contains("CARD-42")`,
      order: "UpdatedDateUTC DESC",
      page: 5,
      pageSize: 100,
      unitdp: 4,
    });

    expect(buildBankTransactionReadQuery({
      type: "RECEIVE-PREPAYMENT",
      search_term: "PP-0042",
      page: 1,
      page_size: 50,
      sort: "DATE_DESC",
    }).where).toBe('Type=="RECEIVE-PREPAYMENT" AND InvoiceNumber.Contains("PP-0042")');
  });

  it("escapes provider-query literals and rejects raw caller query controls", () => {
    const query = buildManualJournalReadQuery({
      search_term: 'close") OR Status!="DRAFT',
      page: 1,
      page_size: 50,
      sort: "DATE_DESC",
    });

    expect(query.where).toBe('Narration.Contains("close\\\") OR Status!=\\"DRAFT")');
    expect(() => buildQuoteReadQuery({
      page: 1,
      page_size: 50,
      sort: "DATE_DESC",
      where: 'Status!="DELETED"',
    } as never)).toThrow();
    expect(() => listBankTransactionsSchema.parse({ status: "VOIDED" })).toThrow();
  });
});

describe("extended Xero safe projections", () => {
  it("maps an official Quote model instance and bounds exact-read line output", () => {
    const quote = Object.assign(new Quote(), {
      quoteID: quoteId,
      quoteNumber: "QU-42",
      status: "ACCEPTED",
      reference: "REF-42",
      terms: "must-not-leak",
      contact: { contactID: contactId, name: "Acme Customer", bankAccountDetails: "must-not-leak" },
      date: "2026-08-01T00:00:00.000Z",
      expiryDate: "/Date(1788134400000+0000)/",
      currencyCode: "HKD",
      currencyRate: "1.234567891",
      lineAmountTypes: "EXCLUSIVE",
      subTotal: 100,
      totalTax: 8.25,
      total: 108.25,
      totalDiscount: 2,
      hasAttachments: true,
      updatedDateUTC: new Date("2026-08-02T03:04:05.000Z"),
      lineItems: Array.from({ length: 102 }, (_, index) => ({
        lineItemID: `line-${index}`,
        description: index === 0 ? "x".repeat(600) : `Line ${index}`,
        quantity: 1,
        unitAmount: index + 0.5,
        lineAmount: index + 0.5,
        taxAmount: 0,
        accountID: bankAccountId,
        accountCode: "200",
        itemCode: "CONSULT",
        taxType: "NONE",
        discountRate: 1.25,
        tracking: index === 0 ? [
          { trackingCategoryID: "tracking-category-1", trackingOptionID: "tracking-option-1", name: "Region", option: "APAC" },
          { trackingCategoryID: "tracking-category-2", trackingOptionID: "tracking-option-2", name: "Team", option: "Advisory" },
          { trackingCategoryID: "tracking-category-3", trackingOptionID: "tracking-option-3", name: "Extra", option: "Omitted" },
        ] : [],
      })),
    });

    const summary = mapQuoteSummary(quote);
    const snapshot = mapQuoteSnapshot(quote);

    expect(summary).toEqual({
      quoteId,
      status: "ACCEPTED",
      contact: { contactId, name: "Acme Customer" },
      quoteNumber: "QU-42",
      reference: "REF-42",
      quoteDate: "2026-08-01",
      expiryDate: "2026-08-31",
      currency: "HKD",
      currencyRate: "1.234567891",
      lineAmountType: "EXCLUSIVE",
      subTotal: "100.0000",
      totalTax: "8.2500",
      total: "108.2500",
      totalDiscount: "2.0000",
      attachmentsKnown: true,
      hasAttachments: true,
      projectionIncomplete: true,
      omittedFields: ["lineItems", "terms"],
      updatedAt: "2026-08-02T03:04:05.000Z",
    });
    expect(snapshot).toMatchObject({
      quoteId,
      status: "ACCEPTED",
      projectionIncomplete: true,
      omittedFields: ["terms"],
      lineItemCount: 102,
      linesTruncated: true,
      omittedInvalidLines: 0,
    });
    expect(snapshot?.lines).toHaveLength(100);
    expect(snapshot?.lines[0]).toMatchObject({
      lineItemId: "line-0",
      description: "x".repeat(512),
      descriptionTruncated: true,
      quantity: "1.0000",
      unitAmount: "0.5000",
      accountId: bankAccountId,
      accountCode: "200",
      trackingCount: 3,
      trackingTruncated: true,
      omittedInvalidTracking: 0,
      tracking: [
        { trackingCategoryId: "tracking-category-1", trackingOptionId: "tracking-option-1", name: "Region", option: "APAC" },
        { trackingCategoryId: "tracking-category-2", trackingOptionId: "tracking-option-2", name: "Team", option: "Advisory" },
      ],
    });
    expect(summary).not.toHaveProperty("lines");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
  });

  it("maps purchase-order summary and snapshot without leaking delivery contact details", () => {
    const purchaseOrder = {
      purchaseOrderID: purchaseOrderId,
      purchaseOrderNumber: "PO-42",
      status: "AUTHORISED",
      contact: { contactID: contactId, name: "Acme Supplier", emailAddress: "must-not-leak" },
      date: "2026-08-01",
      deliveryDate: "2026-08-15",
      expectedArrivalDate: "2026-08-16",
      currencyCode: "SGD",
      currencyRate: 0.123456789,
      lineAmountTypes: "Exclusive",
      reference: "REQ-42",
      sentToContact: true,
      subTotal: 20,
      totalTax: 1.8,
      total: 21.8,
      totalDiscount: 0,
      attachments: [],
      attentionTo: "must-not-leak",
      telephone: "must-not-leak",
      deliveryAddress: "must-not-leak",
      lineItems: [{ description: "Equipment", quantity: 2, unitAmount: 10, lineAmount: 20 }],
    };

    expect(mapPurchaseOrderSummary(purchaseOrder)).toEqual({
      purchaseOrderId,
      status: "AUTHORISED",
      contact: { contactId, name: "Acme Supplier" },
      purchaseOrderNumber: "PO-42",
      reference: "REQ-42",
      purchaseOrderDate: "2026-08-01",
      deliveryDate: "2026-08-15",
      expectedArrivalDate: "2026-08-16",
      currency: "SGD",
      currencyRate: "0.123456789",
      lineAmountType: "Exclusive",
      sentToContact: true,
      subTotal: "20.0000",
      totalTax: "1.8000",
      total: "21.8000",
      totalDiscount: "0.0000",
      attachmentsKnown: true,
      hasAttachments: false,
      projectionIncomplete: true,
      omittedFields: ["lineItems", "attentionTo", "telephone", "deliveryAddress"],
    });
    expect(mapPurchaseOrderSnapshot(purchaseOrder)?.lines).toEqual([{
      description: "Equipment",
      quantity: "2.0000",
      unitAmount: "10.0000",
      lineAmount: "20.0000",
      tracking: [],
      trackingCount: 0,
      trackingTruncated: false,
      omittedInvalidTracking: 0,
    }]);
    expect(JSON.stringify(mapPurchaseOrderSnapshot(purchaseOrder))).not.toContain("must-not-leak");
  });

  it("maps a balanced manual journal as decimal strings and omits provider URLs", () => {
    const snapshot = mapManualJournalSnapshot({
      manualJournalID: manualJournalId,
      narration: "Month-end accrual",
      status: "POSTED",
      date: "2026-07-31",
      lineAmountTypes: "NoTax",
      showOnCashBasisReports: false,
      url: "https://secret.example/source",
      hasAttachments: false,
      journalLines: [
        {
          accountID: bankAccountId,
          accountCode: "400",
          description: "Accrual",
          lineAmount: 200,
          taxAmount: 0,
          tracking: [
            { name: "Region", option: "APAC" },
            { name: "Team", option: "Advisory" },
            { name: "Extra", option: "Omitted" },
          ],
        },
        { accountCode: "800", description: "Offset", lineAmount: -200, taxAmount: 0 },
      ],
    });
    expect(snapshot?.lines[0]).toMatchObject({
      tracking: [{ name: "Region", option: "APAC" }, { name: "Team", option: "Advisory" }],
      trackingCount: 3,
      trackingTruncated: true,
    });

    expect(snapshot).toMatchObject({
      manualJournalId,
      status: "POSTED",
      narration: "Month-end accrual",
      journalDate: "2026-07-31",
      lineAmountType: "NoTax",
      showOnCashBasisReports: false,
      attachmentsKnown: true,
      hasAttachments: false,
      lineItemCount: 2,
      linesTruncated: false,
      omittedInvalidLines: 0,
      lines: [
        { accountId: bankAccountId, accountCode: "400", description: "Accrual", lineAmount: "200.0000", taxAmount: "0.0000" },
        { accountCode: "800", description: "Offset", lineAmount: "-200.0000", taxAmount: "0.0000" },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret.example");
  });

  it("maps item accounting defaults while omitting validation payloads", () => {
    const summary = mapItemSummary({
      itemID: itemId,
      code: "CONSULT",
      name: "Consulting",
      description: "Sales description",
      purchaseDescription: "Purchase description",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      inventoryAssetAccountCode: "630",
      quantityOnHand: 3.5,
      totalCostPool: 700,
      salesDetails: { unitPrice: 250, accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: 150, accountCode: "400", cOGSAccountCode: "500", taxType: "INPUT" },
      statusAttributeString: "OK",
      validationErrors: [{ message: "must-not-leak" }],
      updatedDateUTC: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(summary).toEqual({
      itemId,
      code: "CONSULT",
      name: "Consulting",
      providerResultStatus: "OK",
      description: "Sales description",
      purchaseDescription: "Purchase description",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      inventoryAssetAccountCode: "630",
      quantityOnHand: "3.5000",
      totalCostPool: "700.0000",
      salesDetails: { unitPrice: "250.0000", accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: "150.0000", accountCode: "400", cogsAccountCode: "500", taxType: "INPUT" },
      projectionIncomplete: true,
      omittedFields: ["validationErrors"],
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-leak");
  });

  it("maps every real captured Xero item with no projection gaps, unlike the hand-built validationErrors case above", () => {
    // proves: capturedDateFields pins the one field (updatedDateUTC) the real
    // API sends as a Date; if a re-capture adds another, this assertion
    // breaks and forces a check of mapItemSummary's handling of it.
    expect(capturedDateFields("items")).toEqual(["items[].updatedDateUTC"]);

    const { items } = loadXeroResponse("items") as { items: Array<Record<string, unknown>> };
    const mapped = items.map((item) => mapItemSummary(item));
    expect(mapped.every((item) => item !== undefined)).toBe(true);
    // Unlike the hand-built case above (which asserts validationErrors), no
    // real captured item carries that key at all, so projectionEvidence must
    // report a clean projection rather than inheriting the hand-built case's
    // projectionIncomplete: true.
    expect(mapped.every((item) => item?.projectionIncomplete === false && item.omittedFields.length === 0))
      .toBe(true);

    const book = mapped.find((item) => item?.code === "BOOK");
    expect(book).toMatchObject({
      itemId: "8bbaf73c-5a32-4458-addf-bd30a36c8551",
      salesDetails: { accountCode: "200", taxType: "TAX001", unitPrice: "19.9500" },
    });
    // purchaseDetails: {} on the wire (an empty object, not a missing key or
    // null) must resolve to "no defaults", not an empty-object leak.
    expect(book).not.toHaveProperty("purchaseDetails");
  });

  it("returns reconciliation evidence without exposing a bank account number", () => {
    const snapshot = mapBankTransactionSnapshot({
      bankTransactionID: bankTransactionId,
      type: "SPEND",
      status: "AUTHORISED",
      contact: { contactID: contactId, name: "Card Vendor", bankAccountDetails: "must-not-leak" },
      bankAccount: {
        accountID: bankAccountId,
        code: "090",
        name: "Business Bank",
        currencyCode: "HKD",
        bankAccountNumber: "must-not-leak",
      },
      isReconciled: false,
      date: "2026-08-01",
      reference: "CARD-42",
      invoiceNumber: "PP-0042",
      currencyCode: "USD",
      currencyRate: 7.8,
      lineAmountTypes: "Inclusive",
      subTotal: 100,
      totalTax: 8,
      total: 108,
      prepaymentID: "88888888-8888-4888-8888-888888888888",
      hasAttachments: true,
      url: "https://secret.example/source",
      lineItems: [{
        lineItemID: "bank-line-1",
        description: "Cloud hosting",
        quantity: 1,
        unitAmount: 108,
        lineAmount: 100,
        taxAmount: 8,
        accountID: "99999999-9999-4999-8999-999999999999",
        accountCode: "429",
        taxType: "INPUT",
      }],
    });

    expect(snapshot).toMatchObject({
      bankTransactionId,
      type: "SPEND",
      status: "AUTHORISED",
      contact: { contactId, name: "Card Vendor" },
      bankAccount: { accountId: bankAccountId, code: "090", name: "Business Bank", currency: "HKD" },
      isReconciled: false,
      transactionDate: "2026-08-01",
      reference: "CARD-42",
      invoiceNumber: "PP-0042",
      currency: "USD",
      currencyRate: "7.800000",
      lineAmountType: "Inclusive",
      subTotal: "100.0000",
      totalTax: "8.0000",
      total: "108.0000",
      prepaymentId: "88888888-8888-4888-8888-888888888888",
      attachmentsKnown: true,
      hasAttachments: true,
      lineItemCount: 1,
      linesTruncated: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(JSON.stringify(snapshot)).not.toContain("secret.example");
  });

  it("omits invalid provider records and keeps explicit pagination completeness evidence", () => {
    const mapped = mapBoundedExtendedReadPage(
      [
        { quoteID: quoteId, status: "DRAFT" },
        { status: "DRAFT" },
        { quoteID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "SENT" },
      ],
      { page: 2, page_size: 2 },
      mapQuoteSummary,
      { page: 2, pageSize: 2, pageCount: 4, itemCount: 7 },
    );

    expect(mapped.records).toEqual([{
      quoteId,
      status: "DRAFT",
      attachmentsKnown: false,
      projectionIncomplete: false,
      omittedFields: [],
    }]);
    expect(mapped.pagination).toEqual({
      page: 2,
      pageSize: 2,
      returned: 1,
      providerPageCount: 4,
      providerItemCount: 7,
      hasNextPage: true,
      hasNextPageIsEstimated: false,
      omittedInvalid: 1,
      omittedOverflow: 1,
    });
  });
});
