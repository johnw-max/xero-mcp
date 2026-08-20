import { describe, expect, it } from "vitest";
import {
  buildPurchaseOrderDraftPrimitive,
  buildQuoteDraftPrimitive,
  preparePurchaseOrderDraftInputSchema,
  prepareQuoteDraftInputSchema,
} from "../src/domain/xeroQuotePurchaseOrderDraft.js";
import {
  mapPurchaseOrderDraftReadback,
  mapQuoteDraftReadback,
  toXeroPurchaseOrderCreatePayload,
  toXeroQuoteCreatePayload,
  verifyPurchaseOrderDraftReadback,
  verifyQuoteDraftReadback,
} from "../src/providers/xeroQuotePurchaseOrderDraft.js";
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

const contactId = "11111111-1111-4111-8111-111111111111";
const trackingOptionId = "22222222-2222-4222-8222-222222222222";
const quoteId = "33333333-3333-4333-8333-333333333333";
const purchaseOrderId = "44444444-4444-4444-8444-444444444444";

const quoteInput = {
  source_ref: "agent2://material/quote-001",
  source_unit_key: "document:quote-001",
  source_sha256: "a".repeat(64),
  contact_id: contactId,
  quote_date: "2026-08-07",
  expiry_date: "2026-08-21",
  currency: "SGD",
  reference: "Q-CLIENT-001",
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Accounting advisory",
    quantity: 2,
    unit_amount: 125.5,
    account_code: "200",
    tax_type: "OUTPUT",
    item_code: "ADVISORY",
    tracking_option_ids: [trackingOptionId],
  }],
};

const purchaseOrderInput = {
  source_ref: "agent2://material/purchase-order-001",
  source_unit_key: "document:purchase-order-001",
  source_sha256: "b".repeat(64),
  contact_id: contactId,
  purchase_order_date: "2026-08-07",
  expected_arrival_date: "2026-08-14",
  delivery_date: "2026-08-21",
  currency: "SGD",
  reference: "PO-INTERNAL-001",
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Laptop stand",
    quantity: 3,
    unit_amount: 80,
    account_code: "453",
    tax_type: "INPUT",
    item_code: "STAND",
    tracking_option_ids: [trackingOptionId],
  }],
};

function quoteReadback() {
  return {
    quoteID: quoteId,
    status: "DRAFT",
    contact: { contactID: contactId, name: "Demo Customer" },
    date: "2026-08-07",
    expiryDate: "2026-08-21",
    currencyCode: "SGD",
    reference: "Q-CLIENT-001",
    lineAmountTypes: "EXCLUSIVE",
    lineItems: [{
      description: "Accounting advisory",
      quantity: 2,
      unitAmount: 125.5,
      lineAmount: 251,
      accountCode: "200",
      taxType: "OUTPUT",
      itemCode: "ADVISORY",
      tracking: [{
        trackingCategoryID: "55555555-5555-4555-8555-555555555555",
        trackingOptionID: trackingOptionId,
        name: "Region",
        option: "SG",
      }],
    }],
    subTotal: 251,
    totalTax: 0,
    total: 251,
  };
}

function purchaseOrderReadback() {
  return {
    purchaseOrderID: purchaseOrderId,
    status: "DRAFT",
    contact: { contactID: contactId },
    date: "2026-08-07",
    expectedArrivalDate: "2026-08-14",
    deliveryDate: "2026-08-21",
    currencyCode: "SGD",
    reference: "PO-INTERNAL-001",
    lineAmountTypes: "Exclusive",
    lineItems: [{
      description: "Laptop stand",
      quantity: 3,
      unitAmount: 80,
      lineAmount: 240,
      accountCode: "453",
      taxType: "INPUT",
      itemCode: "STAND",
      tracking: [{ trackingOptionID: trackingOptionId }],
    }],
    subTotal: 240,
    totalTax: 0,
    total: 240,
  };
}

describe("Quote and purchase-order draft schemas", () => {
  it("accepts one strict, accounting-ready Quote and Purchase Order draft", () => {
    expect(prepareQuoteDraftInputSchema.parse(quoteInput)).toEqual(quoteInput);
    expect(preparePurchaseOrderDraftInputSchema.parse(purchaseOrderInput)).toEqual(purchaseOrderInput);
  });

  it("rejects provider controls, transport escape hatches, and line identifiers", () => {
    const forbiddenTopLevel = [
      "tenant_id",
      "type",
      "status",
      "quote_number",
      "purchase_order_number",
      "currency_rate",
      "sent_to_contact",
      "branding_theme_id",
      "raw_where",
      "url",
      "path",
    ] as const;

    for (const key of forbiddenTopLevel) {
      expect(prepareQuoteDraftInputSchema.safeParse({ ...quoteInput, [key]: "unsafe" }).success).toBe(false);
      expect(preparePurchaseOrderDraftInputSchema.safeParse({ ...purchaseOrderInput, [key]: "unsafe" }).success).toBe(false);
    }

    expect(prepareQuoteDraftInputSchema.safeParse({
      ...quoteInput,
      lines: [{ ...quoteInput.lines[0], line_item_id: "33333333-3333-4333-8333-333333333333" }],
    }).success).toBe(false);
  });

  it("enforces real dates, ordered windows, bounded identifiers, lines, tracking, and decimal money", () => {
    const invalidQuotes = [
      { ...quoteInput, quote_date: "2026-02-30" },
      { ...quoteInput, expiry_date: "2026-08-06" },
      { ...quoteInput, currency: "ZZZ" },
      { ...quoteInput, lines: [] },
      { ...quoteInput, lines: Array.from({ length: 21 }, () => quoteInput.lines[0]) },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], quantity: 1.00001 }] },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], quantity: 0 }] },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], unit_amount: -0.01 }] },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], account_code: "200;DROP" }] },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], tax_type: "OUTPUT\nINJECT" }] },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], item_code: "../STAND" }] },
      {
        ...quoteInput,
        lines: [{
          ...quoteInput.lines[0],
          tracking_option_ids: [trackingOptionId, trackingOptionId],
        }],
      },
      {
        ...quoteInput,
        lines: [{
          ...quoteInput.lines[0],
          tracking_option_ids: [
            trackingOptionId,
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
          ],
        }],
      },
      { ...quoteInput, lines: [{ ...quoteInput.lines[0], quantity: 1_000_000, unit_amount: 1_000_000_000 }] },
    ];

    for (const candidate of invalidQuotes) {
      expect(prepareQuoteDraftInputSchema.safeParse(candidate).success).toBe(false);
    }

    expect(preparePurchaseOrderDraftInputSchema.safeParse({
      ...purchaseOrderInput,
      expected_arrival_date: "2026-08-22",
    }).success).toBe(true);
    expect(preparePurchaseOrderDraftInputSchema.safeParse({
      ...purchaseOrderInput,
      expected_arrival_date: undefined,
      delivery_date: undefined,
    }).success).toBe(true);
    expect(preparePurchaseOrderDraftInputSchema.safeParse({
      ...purchaseOrderInput,
      purchase_order_date: "2026-08-22",
    }).success).toBe(false);
  });

  it("builds stable server-bound DRAFT canonicals and exposes only a short human confirmation phrase", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);

    expect(quote.canonicalPayload).toMatchObject({
      schemaVersion: "xero-controlled-draft:v1",
      objectType: "QUOTE",
      operation: "CREATE_DRAFT",
      status: "DRAFT",
      contactId,
      quoteDate: "2026-08-07",
      expiryDate: "2026-08-21",
      currency: "SGD",
      reference: "Q-CLIENT-001",
      lineAmountType: "EXCLUSIVE",
      enteredLineSubtotal: "251.0000",
      lines: [{
        description: "Accounting advisory",
        quantity: "2.0000",
        unitAmount: "125.5000",
        enteredLineSubtotal: "251.0000",
        accountCode: "200",
        taxType: "OUTPUT",
        itemCode: "ADVISORY",
        trackingOptionIds: [trackingOptionId],
      }],
    });
    expect(purchaseOrder.canonicalPayload).toMatchObject({
      objectType: "PURCHASE_ORDER",
      status: "DRAFT",
      purchaseOrderDate: "2026-08-07",
      expectedArrivalDate: "2026-08-14",
      deliveryDate: "2026-08-21",
      enteredLineSubtotal: "240.0000",
    });
    expect(quote).not.toHaveProperty("confirmationSummary");
    expect(quote).not.toHaveProperty("confirmationDetails");
    expect(quote.confirmationPhrase).toMatch(
      /^确认创建 Quote 草稿｜联系人 11111111…｜日期 2026-08-07→2026-08-21｜录入行合计 SGD 251\.0000｜EXCLUSIVE｜来源 AAAAAAAA｜校验 [A-F0-9]{10}$/,
    );
    expect(purchaseOrder.confirmationPhrase).toMatch(
      /^确认创建 Purchase Order 草稿｜联系人 11111111…｜日期 2026-08-07→2026-08-21｜录入行合计 SGD 240\.0000｜EXCLUSIVE｜来源 BBBBBBBB｜校验 [A-F0-9]{10}$/,
    );
    expect(quote.canonicalPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(quote.confirmationSummaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildQuoteDraftPrimitive({
      currency: "SGD",
      lines: quoteInput.lines,
      source_ref: "agent2://material/quote-001",
      source_unit_key: "document:quote-001",
      source_sha256: "a".repeat(64),
      expiry_date: "2026-08-21",
      quote_date: "2026-08-07",
      line_amount_type: "Exclusive",
      reference: "Q-CLIENT-001",
      contact_id: contactId,
    }).canonicalPayloadHash).toBe(quote.canonicalPayloadHash);
  });

  it("labels source evidence honestly and fingerprints extracted canonicals when no asserted hash exists", () => {
    const asserted = buildQuoteDraftPrimitive(quoteInput);
    const { source_sha256: _omitted, ...withoutAssertedHash } = quoteInput;
    const fingerprinted = buildQuoteDraftPrimitive(withoutAssertedHash);
    const inclusive = buildQuoteDraftPrimitive({
      ...withoutAssertedHash,
      line_amount_type: "Inclusive",
    });

    expect(asserted).toMatchObject({
      sourceRef: "agent2://material/quote-001",
      sourceUnitKey: "document:quote-001",
      sourceSha256: "a".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
    });
    expect(fingerprinted).toMatchObject({
      sourceRef: "agent2://material/quote-001",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
    });
    expect(buildQuoteDraftPrimitive(withoutAssertedHash).sourceSha256).toBe(fingerprinted.sourceSha256);
    expect(buildQuoteDraftPrimitive({
      ...withoutAssertedHash,
      source_unit_key: "document:quote-002",
    }).sourceSha256).not.toBe(fingerprinted.sourceSha256);
    expect(inclusive.confirmationSummaryHash).not.toBe(fingerprinted.confirmationSummaryHash);
    expect(fingerprinted.confirmationPhrase).not.toMatch(/(?:金额|总额|file hash|文件哈希)/iu);
    expect(Object.keys(fingerprinted).filter((key) => key.toLowerCase().includes("confirmationphrase"))).toEqual([
      "confirmationPhrase",
    ]);
  });

  it("constructs object-specific xero-node create payloads with server-owned DRAFT controls", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);

    expect(toXeroQuoteCreatePayload(quote.canonicalPayload)).toEqual({
      quotes: [{
        status: "DRAFT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        expiryDate: "2026-08-21",
        currencyCode: "SGD",
        reference: "Q-CLIENT-001",
        lineAmountTypes: "EXCLUSIVE",
        lineItems: [{
          description: "Accounting advisory",
          quantity: 2,
          unitAmount: 125.5,
          accountCode: "200",
          taxType: "OUTPUT",
          itemCode: "ADVISORY",
          tracking: [{ trackingOptionID: trackingOptionId }],
        }],
      }],
    });
    expect(toXeroPurchaseOrderCreatePayload(purchaseOrder.canonicalPayload)).toEqual({
      purchaseOrders: [{
        status: "DRAFT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        expectedArrivalDate: "2026-08-14",
        deliveryDate: "2026-08-21",
        currencyCode: "SGD",
        reference: "PO-INTERNAL-001",
        lineAmountTypes: "Exclusive",
        lineItems: [{
          description: "Laptop stand",
          quantity: 3,
          unitAmount: 80,
          accountCode: "453",
          taxType: "INPUT",
          itemCode: "STAND",
          tracking: [{ trackingOptionID: trackingOptionId }],
        }],
      }],
    });

    const serialized = JSON.stringify({
      quote: toXeroQuoteCreatePayload(quote.canonicalPayload),
      purchaseOrder: toXeroPurchaseOrderCreatePayload(purchaseOrder.canonicalPayload),
    });
    for (const forbidden of [
      "quoteNumber",
      "purchaseOrderNumber",
      "currencyRate",
      "sentToContact",
      "brandingThemeID",
      "lineItemID",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("revalidates persisted canonicals before constructing any provider payload", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput).canonicalPayload;
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput).canonicalPayload;
    const invalidCanonicals = [
      { value: { ...quote, status: "SENT" }, mapper: toXeroQuoteCreatePayload },
      { value: { ...quote, objectType: "PURCHASE_ORDER" }, mapper: toXeroQuoteCreatePayload },
      { value: { ...quote, enteredLineSubtotal: "999.0000" }, mapper: toXeroQuoteCreatePayload },
      {
        value: {
          ...quote,
          lines: [{ ...quote.lines[0], quantity: "1000001.0000", enteredLineSubtotal: "125500125.5000" }],
          enteredLineSubtotal: "125500125.5000",
        },
        mapper: toXeroQuoteCreatePayload,
      },
      { value: { ...purchaseOrder, sentToContact: true }, mapper: toXeroPurchaseOrderCreatePayload },
      {
        value: { ...purchaseOrder, lines: [{ ...purchaseOrder.lines[0], lineItemID: quoteId }] },
        mapper: toXeroPurchaseOrderCreatePayload,
      },
    ];
    for (const candidate of invalidCanonicals) {
      expect(() => candidate.mapper(candidate.value)).toThrow();
    }
  });

  it("maps exact readback snapshots and verifies line economics plus provider total arithmetic", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);
    const rawQuote = quoteReadback();
    const rawPurchaseOrder = purchaseOrderReadback();

    expect(mapQuoteDraftReadback(rawQuote)).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "QUOTE",
        quoteId,
        canonicalPayload: { enteredLineSubtotal: "251.0000" },
        providerTotalsVerified: true,
        providerTotalsEvidence: {
          subTotal: "251.0000",
          totalTax: "0.0000",
          total: "251.0000",
          arithmeticVerified: true,
          lineBasisVerified: true,
        },
        providerLineAmountEvidence: {
          verificationRole: "NON_CANONICAL_EVIDENCE",
          values: ["251.0000"],
          observedCount: 1,
          missingCount: 0,
          amountsMatchEntered: true,
        },
      },
    });
    expect(mapPurchaseOrderDraftReadback(rawPurchaseOrder)).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "PURCHASE_ORDER",
        purchaseOrderId,
        canonicalPayload: { enteredLineSubtotal: "240.0000" },
        providerTotalsVerified: true,
        providerTotalsEvidence: {
          subTotal: "240.0000",
          totalTax: "0.0000",
          total: "240.0000",
          arithmeticVerified: true,
          lineBasisVerified: true,
        },
        providerLineAmountEvidence: {
          verificationRole: "NON_CANONICAL_EVIDENCE",
          values: ["240.0000"],
          observedCount: 1,
          missingCount: 0,
          amountsMatchEntered: true,
        },
      },
    });
    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, rawQuote)).toMatchObject({
      ok: true,
      readbackCanonicalPayloadHash: quote.canonicalPayloadHash,
    });
    expect(verifyPurchaseOrderDraftReadback(
      purchaseOrderId,
      purchaseOrder.canonicalPayload,
      rawPurchaseOrder,
    )).toMatchObject({
      ok: true,
      readbackCanonicalPayloadHash: purchaseOrder.canonicalPayloadHash,
    });
  });

  it("accepts a native Date object for date fields exactly like the equivalent plain string (live Xero returns Date, not string, for these fields)", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);

    const quoteDateVariants = [
      { ...quoteReadback(), date: new Date("2026-08-07T00:00:00.000Z") },
      { ...quoteReadback(), expiryDate: new Date("2026-08-21T00:00:00.000Z") },
      {
        ...quoteReadback(),
        date: new Date("2026-08-07T00:00:00.000Z"),
        expiryDate: new Date("2026-08-21T00:00:00.000Z"),
      },
    ];
    for (const candidate of quoteDateVariants) {
      expect(mapQuoteDraftReadback(candidate)).toMatchObject({
        ok: true,
        snapshot: {
          objectType: "QUOTE",
          quoteId,
          canonicalPayload: { quoteDate: "2026-08-07", expiryDate: "2026-08-21" },
        },
      });
      expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, candidate)).toMatchObject({
        ok: true,
        readbackCanonicalPayloadHash: quote.canonicalPayloadHash,
      });
    }

    const purchaseOrderDateVariants = [
      { ...purchaseOrderReadback(), date: new Date("2026-08-07T00:00:00.000Z") },
      { ...purchaseOrderReadback(), expectedArrivalDate: new Date("2026-08-14T00:00:00.000Z") },
      { ...purchaseOrderReadback(), deliveryDate: new Date("2026-08-21T00:00:00.000Z") },
      {
        ...purchaseOrderReadback(),
        date: new Date("2026-08-07T00:00:00.000Z"),
        expectedArrivalDate: new Date("2026-08-14T00:00:00.000Z"),
        deliveryDate: new Date("2026-08-21T00:00:00.000Z"),
      },
    ];
    for (const candidate of purchaseOrderDateVariants) {
      expect(mapPurchaseOrderDraftReadback(candidate)).toMatchObject({
        ok: true,
        snapshot: {
          objectType: "PURCHASE_ORDER",
          purchaseOrderId,
          canonicalPayload: {
            purchaseOrderDate: "2026-08-07",
            expectedArrivalDate: "2026-08-14",
            deliveryDate: "2026-08-21",
          },
        },
      });
      expect(verifyPurchaseOrderDraftReadback(purchaseOrderId, purchaseOrder.canonicalPayload, candidate))
        .toMatchObject({ ok: true, readbackCanonicalPayloadHash: purchaseOrder.canonicalPayloadHash });
    }
  });

  it("normalizes a Date instance the live Xero SDK actually produced, not only a hand-typed `new Date(...)`", () => {
    // proves: this module's own history is why xeroProviderDate.ts exists -
    // its doc comment names xeroQuotePurchaseOrderDraft.ts's date handling as
    // one of two call sites that "never learned the Date branch at all...
    // turning every live CreditNote / Quote / PurchaseOrder / ManualJournal
    // draft-write readback into MALFORMED_PROVIDER_READBACK." The test above
    // covers the mechanism with `new Date(...)` literals a test author typed
    // by hand; this one feeds in a Date object captured from a genuine Xero
    // response body (organisation.periodLockDate) instead, so it cannot pass
    // by coincidentally matching whatever shape a hand-typed Date happens to
    // have.
    const [organisation] = loadXeroResponse("organisation").organisations as Array<{ periodLockDate: unknown }>;
    const realDate = organisation.periodLockDate;
    expect(realDate).toBeInstanceOf(Date);

    expect(mapQuoteDraftReadback({ ...quoteReadback(), date: realDate })).toMatchObject({
      ok: true,
      snapshot: { objectType: "QUOTE", quoteId, canonicalPayload: { quoteDate: "2008-09-30" } },
    });
    expect(mapPurchaseOrderDraftReadback({ ...purchaseOrderReadback(), date: realDate })).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "PURCHASE_ORDER",
        purchaseOrderId,
        canonicalPayload: { purchaseOrderDate: "2008-09-30" },
      },
    });
  });

  it("requires provider lineAmount while tolerating normal currency rounding", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const raw = quoteReadback();
    const { lineAmount: _omitted, ...lineWithoutProviderAmount } = raw.lineItems[0]!;
    const missing = { ...raw, lineItems: [lineWithoutProviderAmount] };
    const currencyRounded = {
      ...raw,
      lineItems: [{ ...raw.lineItems[0], lineAmount: 250.99 }],
    };

    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, missing)).toEqual({
      ok: false,
      reasons: ["MALFORMED_PROVIDER_READBACK"],
    });
    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, currencyRounded)).toMatchObject({
      ok: true,
      snapshot: {
        providerLineAmountEvidence: {
          values: ["250.9900"],
          observedCount: 1,
          missingCount: 0,
        },
      },
    });
  });

  it("rejects discounts and inconsistent provider totals instead of accepting an economic mismatch", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const raw = quoteReadback();
    const discounted = {
      ...raw,
      lineItems: [{ ...raw.lineItems[0], lineAmount: 0, discountAmount: 251 }],
      subTotal: 0,
      total: 0,
    };
    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, discounted)).toEqual({
      ok: false,
      reasons: ["MALFORMED_PROVIDER_READBACK"],
    });
    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, {
      ...raw,
      total: 999,
    })).toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });
  });

  it("fails exact verification for IDs, object type, status, contacts, dates, currency, references, line mode, and every line field", () => {
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);
    const anotherId = "66666666-6666-4666-8666-666666666666";
    const anotherTrackingId = "77777777-7777-4777-8777-777777777777";
    const rawQuote = quoteReadback();
    const rawPurchaseOrder = purchaseOrderReadback();

    expect(verifyQuoteDraftReadback(anotherId, quote.canonicalPayload, rawQuote)).toEqual({
      ok: false,
      reasons: ["XERO_OBJECT_ID_MISMATCH"],
    });
    expect(verifyQuoteDraftReadback(quoteId, { ...quote.canonicalPayload, objectType: "PURCHASE_ORDER" }, rawQuote))
      .toEqual({ ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] });
    expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, { ...rawQuote, status: "SENT" }))
      .toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });

    const quoteHeaderMismatches = [
      { ...rawQuote, contact: { contactID: anotherId } },
      { ...rawQuote, date: "2026-08-08" },
      { ...rawQuote, expiryDate: "2026-08-22" },
      { ...rawQuote, currencyCode: "USD" },
      { ...rawQuote, reference: "Q-CLIENT-CHANGED" },
      { ...rawQuote, lineAmountTypes: "INCLUSIVE" },
    ];
    const baseQuoteLine = rawQuote.lineItems[0];
    const quoteLineMismatches = [
      { ...baseQuoteLine, description: "Changed description" },
      { ...baseQuoteLine, quantity: 3, lineAmount: 376.5 },
      { ...baseQuoteLine, unitAmount: 126, lineAmount: 252 },
      { ...baseQuoteLine, accountCode: "201" },
      { ...baseQuoteLine, taxType: "NONE" },
      { ...baseQuoteLine, itemCode: "OTHER" },
      {
        ...baseQuoteLine,
        tracking: [
          { trackingOptionID: trackingOptionId },
          { trackingOptionID: anotherTrackingId },
        ],
      },
    ];
    for (const candidate of [
      ...quoteHeaderMismatches,
      ...quoteLineMismatches.map((line) => ({
        ...rawQuote,
        lineItems: [line],
        subTotal: line.lineAmount,
        total: line.lineAmount,
      })),
    ]) {
      expect(verifyQuoteDraftReadback(quoteId, quote.canonicalPayload, candidate)).toMatchObject({
        ok: false,
        reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      });
    }

    const purchaseOrderMismatches = [
      { ...rawPurchaseOrder, contact: { contactID: anotherId } },
      { ...rawPurchaseOrder, date: "2026-08-08" },
      { ...rawPurchaseOrder, expectedArrivalDate: "2026-08-15" },
      { ...rawPurchaseOrder, deliveryDate: "2026-08-22" },
      { ...rawPurchaseOrder, currencyCode: "USD" },
      { ...rawPurchaseOrder, reference: "PO-CHANGED" },
      { ...rawPurchaseOrder, lineAmountTypes: "Inclusive" },
      {
        ...rawPurchaseOrder,
        lineItems: [{ ...rawPurchaseOrder.lineItems[0], accountCode: "454" }],
      },
    ];
    for (const candidate of purchaseOrderMismatches) {
      expect(verifyPurchaseOrderDraftReadback(
        purchaseOrderId,
        purchaseOrder.canonicalPayload,
        candidate,
      )).toMatchObject({ ok: false, reasons: ["CANONICAL_PAYLOAD_MISMATCH"] });
    }
    expect(verifyPurchaseOrderDraftReadback(
      purchaseOrderId,
      purchaseOrder.canonicalPayload,
      rawQuote,
    )).toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });
    expect(verifyQuoteDraftReadback(
      quoteId.toUpperCase(),
      quote.canonicalPayload,
      { ...rawQuote, quoteID: quoteId.toUpperCase() },
    )).toMatchObject({ ok: true });
  });

  it("names the exact canonical-payload field that disagreed, and never the disagreeing value, on CANONICAL_PAYLOAD_MISMATCH", () => {
    // proves: CANONICAL_PAYLOAD_MISMATCH used to be the entire report - no
    // field name, just the bucket. A single header-field change is now named
    // exactly ("reference"), a single line-field change carries the
    // array-index path shape the implementation plan specifies
    // ("lines[0].accountCode"), and a provider-controlled value injected into
    // that same field never appears inside mismatchFields - the only piece of
    // this result the MCP failure envelope actually projects to the agent.
    const quote = buildQuoteDraftPrimitive(quoteInput);
    const purchaseOrder = buildPurchaseOrderDraftPrimitive(purchaseOrderInput);
    const rawQuote = quoteReadback();
    const rawPurchaseOrder = purchaseOrderReadback();

    const quoteHeaderResult = verifyQuoteDraftReadback(
      quoteId,
      quote.canonicalPayload,
      { ...rawQuote, reference: "SECRET-LEAK-FROM-PROVIDER" },
    );
    expect(quoteHeaderResult).toMatchObject({
      ok: false,
      reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      mismatchFields: ["reference"],
    });
    if (quoteHeaderResult.ok) throw new Error("expected a mismatch");
    expect(JSON.stringify(quoteHeaderResult.mismatchFields)).not.toContain("SECRET-LEAK");

    const quoteLineResult = verifyQuoteDraftReadback(
      quoteId,
      quote.canonicalPayload,
      { ...rawQuote, lineItems: [{ ...rawQuote.lineItems[0], accountCode: "201" }] },
    );
    expect(quoteLineResult).toMatchObject({
      ok: false,
      reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      mismatchFields: ["lines[0].accountCode"],
    });

    const purchaseOrderHeaderResult = verifyPurchaseOrderDraftReadback(
      purchaseOrderId,
      purchaseOrder.canonicalPayload,
      { ...rawPurchaseOrder, reference: "SECRET-LEAK-FROM-PROVIDER" },
    );
    expect(purchaseOrderHeaderResult).toMatchObject({
      ok: false,
      reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      mismatchFields: ["reference"],
    });
    if (purchaseOrderHeaderResult.ok) throw new Error("expected a mismatch");
    expect(JSON.stringify(purchaseOrderHeaderResult.mismatchFields)).not.toContain("SECRET-LEAK");

    const purchaseOrderLineResult = verifyPurchaseOrderDraftReadback(
      purchaseOrderId,
      purchaseOrder.canonicalPayload,
      { ...rawPurchaseOrder, lineItems: [{ ...rawPurchaseOrder.lineItems[0], accountCode: "454" }] },
    );
    expect(purchaseOrderLineResult).toMatchObject({
      ok: false,
      reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      mismatchFields: ["lines[0].accountCode"],
    });
  });

  it("fails closed on missing, malformed, non-finite, over-precise, duplicate, or provider-error readbacks", () => {
    const rawQuote = quoteReadback();
    const baseLine = rawQuote.lineItems[0];
    const malformedQuotes: unknown[] = [
      null,
      {},
      { ...rawQuote, quoteID: "not-a-uuid" },
      { ...rawQuote, contact: undefined },
      { ...rawQuote, contact: { contactID: "not-a-uuid" } },
      { ...rawQuote, date: "2026-02-30" },
      { ...rawQuote, expiryDate: "2026-08-01" },
      { ...rawQuote, currencyCode: "ZZZ" },
      { ...rawQuote, reference: " Q-CLIENT-001" },
      { ...rawQuote, lineAmountTypes: "Exclusive" },
      { ...rawQuote, lineItems: undefined },
      { ...rawQuote, lineItems: [] },
      { ...rawQuote, lineItems: Array.from({ length: 21 }, () => baseLine) },
      { ...rawQuote, lineItems: [{ ...baseLine, description: " Accounting advisory" }] },
      { ...rawQuote, lineItems: [{ ...baseLine, quantity: "2" }] },
      { ...rawQuote, lineItems: [{ ...baseLine, quantity: Number.NaN }] },
      { ...rawQuote, lineItems: [{ ...baseLine, unitAmount: Number.POSITIVE_INFINITY }] },
      { ...rawQuote, lineItems: [{ ...baseLine, unitAmount: 1.00001 }] },
      { ...rawQuote, lineItems: [{ ...baseLine, lineAmount: Number.NaN }] },
      { ...rawQuote, lineItems: [{ ...baseLine, lineAmount: 1.00001 }] },
      { ...rawQuote, lineItems: [{ ...baseLine, accountCode: "200;DROP" }] },
      { ...rawQuote, lineItems: [{ ...baseLine, taxType: "OUTPUT\nINJECT" }] },
      { ...rawQuote, lineItems: [{ ...baseLine, itemCode: "../ITEM" }] },
      { ...rawQuote, lineItems: [{ ...baseLine, tracking: [{}] }] },
      {
        ...rawQuote,
        lineItems: [{
          ...baseLine,
          tracking: [{ trackingOptionID: trackingOptionId }, { trackingOptionID: trackingOptionId }],
        }],
      },
      {
        ...rawQuote,
        lineItems: [{
          ...baseLine,
          tracking: [
            { trackingOptionID: trackingOptionId },
            { trackingOptionID: "77777777-7777-4777-8777-777777777777" },
            { trackingOptionID: "88888888-8888-4888-8888-888888888888" },
          ],
        }],
      },
      { ...rawQuote, hasErrors: true },
      { ...rawQuote, validationErrors: [{ message: "Provider rejected data" }] },
      { ...rawQuote, validationErrors: "unexpected" },
    ];
    for (const candidate of malformedQuotes) {
      expect(mapQuoteDraftReadback(candidate)).toEqual({
        ok: false,
        reason: "MALFORMED_PROVIDER_READBACK",
      });
    }

    const rawPurchaseOrder = purchaseOrderReadback();
    const malformedPurchaseOrders: unknown[] = [
      { ...rawPurchaseOrder, purchaseOrderID: undefined },
      { ...rawPurchaseOrder, status: "AUTHORISED" },
      { ...rawPurchaseOrder, sentToContact: true },
      { ...rawPurchaseOrder, lineAmountTypes: "EXCLUSIVE" },
      { ...rawPurchaseOrder, deliveryDate: "2026-08-06" },
      { ...rawPurchaseOrder, lineItems: [{ ...rawPurchaseOrder.lineItems[0], quantity: 0 }] },
    ];
    for (const candidate of malformedPurchaseOrders) {
      expect(mapPurchaseOrderDraftReadback(candidate)).toEqual({
        ok: false,
        reason: "MALFORMED_PROVIDER_READBACK",
      });
    }
  });
});
