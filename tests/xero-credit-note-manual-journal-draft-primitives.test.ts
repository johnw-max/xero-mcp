import { describe, expect, it } from "vitest";
import {
  buildCreditNoteDraftPrimitive,
  buildManualJournalDraftPrimitive,
  prepareCreditNoteDraftInputSchema,
  prepareManualJournalDraftInputSchema,
} from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import {
  mapCreditNoteDraftReadback,
  mapManualJournalDraftReadback,
  toXeroCreditNoteCreatePayload,
  toXeroManualJournalCreatePayload,
  verifyCreditNoteDraftReadback,
  verifyManualJournalDraftReadback,
} from "../src/providers/xeroCreditNoteManualJournalDraft.js";

const contactId = "11111111-1111-4111-8111-111111111111";
const revenueAccountId = "22222222-2222-4222-8222-222222222222";
const expenseAccountId = "33333333-3333-4333-8333-333333333333";
const trackingOptionId = "44444444-4444-4444-8444-444444444444";
const creditNoteId = "55555555-5555-4555-8555-555555555555";
const manualJournalId = "66666666-6666-4666-8666-666666666666";

const creditNoteInput = {
  source_ref: "agent2://material/customer-credit-001",
  source_sha256: "a".repeat(64),
  source_unit_key: "customer-return-20260807-001",
  reason: "Customer returned the unused advisory package",
  credit_note_type: "ACCRECCREDIT" as const,
  contact_id: contactId,
  credit_note_date: "2026-08-07",
  currency: "SGD",
  reference: "RETURN-20260807-001",
  authoritative_provider_field: "REFERENCE" as const,
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Unused advisory package",
    quantity: 2,
    unit_amount: 125.5,
    account_id: revenueAccountId,
    account_code: "200",
    tax_type: "OUTPUT",
    item_code: "ADVISORY",
    tracking_option_ids: [trackingOptionId],
  }],
};

const manualJournalInput = {
  source_ref: "agent2://material/accrual-001",
  source_sha256: "b".repeat(64),
  source_unit_key: "month-end-accrual-202607",
  journal_date: "2026-07-31",
  narration: "July accounting fee accrual",
  lines: [
    {
      account_id: expenseAccountId,
      account_code: "453",
      description: "Recognise July accounting expense",
      line_amount: 200,
      tracking_option_ids: [trackingOptionId],
    },
    {
      account_id: revenueAccountId,
      account_code: "800",
      description: "Accrued accounting fee liability",
      line_amount: -200,
    },
  ],
};

function creditNoteReadback() {
  return {
    creditNoteID: creditNoteId,
    type: "ACCRECCREDIT",
    status: "DRAFT",
    contact: { contactID: contactId, name: "Demo Customer" },
    date: "2026-08-07",
    currencyCode: "SGD",
    reference: "RETURN-20260807-001",
    lineAmountTypes: "Exclusive",
    sentToContact: false,
    lineItems: [{
      lineItemID: "77777777-7777-4777-8777-777777777777",
      description: "Unused advisory package",
      quantity: 2,
      unitAmount: 125.5,
      lineAmount: 251,
      taxAmount: 25.1,
      accountID: revenueAccountId,
      accountCode: "200",
      taxType: "OUTPUT",
      itemCode: "ADVISORY",
      tracking: [{ trackingOptionID: trackingOptionId }],
    }],
    subTotal: 251,
    totalTax: 25.1,
    total: 276.1,
    remainingCredit: 276.1,
    appliedAmount: 0,
    allocations: [],
    payments: [],
    hasErrors: false,
    validationErrors: [],
  };
}

function manualJournalReadback() {
  return {
    manualJournalID: manualJournalId,
    status: "DRAFT",
    date: "2026-07-31",
    narration: "July accounting fee accrual",
    lineAmountTypes: "NoTax",
    showOnCashBasisReports: false,
    hasAttachments: false,
    journalLines: [
      {
        accountID: expenseAccountId,
        accountCode: "453",
        description: "Recognise July accounting expense",
        lineAmount: 200,
        taxType: "NONE",
        taxAmount: 0,
        tracking: [{ trackingOptionID: trackingOptionId }],
      },
      {
        accountID: revenueAccountId,
        accountCode: "800",
        description: "Accrued accounting fee liability",
        lineAmount: -200,
        taxType: "NONE",
        taxAmount: 0,
      },
    ],
    validationErrors: [],
    attachments: [],
  };
}

describe("Credit Note and Manual Journal DRAFT primitives", () => {
  it("accepts strict accounting-ready inputs and fixes both operations to DRAFT", () => {
    expect(prepareCreditNoteDraftInputSchema.parse(creditNoteInput)).toEqual(creditNoteInput);
    expect(prepareManualJournalDraftInputSchema.parse(manualJournalInput)).toEqual(manualJournalInput);

    expect(buildCreditNoteDraftPrimitive(creditNoteInput).canonicalPayload).toMatchObject({
      objectType: "CREDIT_NOTE",
      operation: "CREATE_DRAFT",
      status: "DRAFT",
      creditNoteType: "ACCRECCREDIT",
      contactId,
      enteredLineSubtotal: "251.0000",
    });
    expect(buildManualJournalDraftPrimitive(manualJournalInput).canonicalPayload).toMatchObject({
      objectType: "MANUAL_JOURNAL",
      operation: "CREATE_DRAFT",
      status: "DRAFT",
      lineAmountType: "NO_TAX",
      showOnCashBasisReports: false,
      debitTotal: "200.0000",
      creditTotal: "200.0000",
      netAmount: "0.0000",
    });
  });

  it("rejects final-state controls, transport escape hatches, and unsupported accounting fields", () => {
    const forbiddenCreditFields = [
      "tenant_id",
      "status",
      "credit_note_id",
      "credit_note_number",
      "currency_rate",
      "sent_to_contact",
      "allocation",
      "allocations",
      "refund",
      "payment",
      "payments",
      "authorise",
      "delete",
      "void",
      "branding_theme_id",
      "raw_where",
      "url",
      "path",
    ] as const;
    for (const key of forbiddenCreditFields) {
      expect(prepareCreditNoteDraftInputSchema.safeParse({ ...creditNoteInput, [key]: "unsafe" }).success)
        .toBe(false);
    }
    expect(prepareCreditNoteDraftInputSchema.safeParse({
      ...creditNoteInput,
      lines: [{ ...creditNoteInput.lines[0], line_item_id: contactId }],
    }).success).toBe(false);

    const forbiddenJournalFields = [
      "tenant_id",
      "status",
      "manual_journal_id",
      "posted",
      "archived",
      "show_on_cash_basis_reports",
      "tax_type",
      "line_amount_type",
      "url",
      "path",
      "raw_where",
    ] as const;
    for (const key of forbiddenJournalFields) {
      expect(prepareManualJournalDraftInputSchema.safeParse({ ...manualJournalInput, [key]: "unsafe" }).success)
        .toBe(false);
    }
    expect(prepareManualJournalDraftInputSchema.safeParse({
      ...manualJournalInput,
      lines: [{ ...manualJournalInput.lines[0], account_type: "BANK" }, manualJournalInput.lines[1]],
    }).success).toBe(false);
  });

  it("enforces identifiers, real dates, line bounds, decimal precision, and an exact balanced journal", () => {
    const invalidCreditNotes: unknown[] = [
      { ...creditNoteInput, source_unit_key: "" },
      { ...creditNoteInput, reason: "" },
      { ...creditNoteInput, reference: "" },
      { ...creditNoteInput, contact_id: "not-a-uuid" },
      { ...creditNoteInput, credit_note_date: "2026-02-30" },
      { ...creditNoteInput, currency: "ZZZ" },
      { ...creditNoteInput, lines: [] },
      { ...creditNoteInput, lines: Array.from({ length: 21 }, () => creditNoteInput.lines[0]) },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], quantity: 0 }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], quantity: 1.00001 }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], unit_amount: -0.01 }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], unit_amount: Number.NaN }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], account_id: "not-a-uuid" }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], account_code: "200;DROP" }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], tax_type: "OUTPUT\nINJECT" }] },
      { ...creditNoteInput, lines: [{ ...creditNoteInput.lines[0], item_code: "../ITEM" }] },
      {
        ...creditNoteInput,
        lines: [{
          ...creditNoteInput.lines[0],
          tracking_option_ids: [trackingOptionId, trackingOptionId],
        }],
      },
      {
        ...creditNoteInput,
        lines: [{
          ...creditNoteInput.lines[0],
          tracking_option_ids: [
            trackingOptionId,
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
          ],
        }],
      },
    ];
    for (const candidate of invalidCreditNotes) {
      expect(prepareCreditNoteDraftInputSchema.safeParse(candidate).success).toBe(false);
    }

    const invalidJournals: unknown[] = [
      { ...manualJournalInput, journal_date: "2026-02-30" },
      { ...manualJournalInput, lines: [manualJournalInput.lines[0]] },
      { ...manualJournalInput, lines: Array.from({ length: 51 }, (_, index) => ({
        ...manualJournalInput.lines[index % 2],
        line_amount: index === 50 ? 0 : manualJournalInput.lines[index % 2]!.line_amount,
      })) },
      { ...manualJournalInput, lines: manualJournalInput.lines.map((line) => ({ ...line, line_amount: 200 })) },
      { ...manualJournalInput, lines: [{ ...manualJournalInput.lines[0], line_amount: 199.9999 }, manualJournalInput.lines[1]] },
      { ...manualJournalInput, lines: [{ ...manualJournalInput.lines[0], line_amount: 200.00001 }, manualJournalInput.lines[1]] },
      { ...manualJournalInput, lines: [{ ...manualJournalInput.lines[0], line_amount: 0 }, manualJournalInput.lines[1]] },
      { ...manualJournalInput, lines: [{ ...manualJournalInput.lines[0], line_amount: Number.POSITIVE_INFINITY }, manualJournalInput.lines[1]] },
      { ...manualJournalInput, lines: [{ ...manualJournalInput.lines[0], account_code: "453;DROP" }, manualJournalInput.lines[1]] },
    ];
    for (const candidate of invalidJournals) {
      expect(prepareManualJournalDraftInputSchema.safeParse(candidate).success).toBe(false);
    }

    expect(prepareManualJournalDraftInputSchema.safeParse({
      ...manualJournalInput,
      lines: [
        { ...manualJournalInput.lines[0], line_amount: 0.1 },
        { ...manualJournalInput.lines[1], line_amount: 0.2 },
        { ...manualJournalInput.lines[1], line_amount: -0.3 },
      ],
    }).success).toBe(true);
  });

  it("builds stable source-bound canonicals and dynamic human confirmation phrases", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const journal = buildManualJournalDraftPrimitive(manualJournalInput);

    expect(credit).toMatchObject({
      sourceRef: "agent2://material/customer-credit-001",
      sourceSha256: "a".repeat(64),
      sourceUnitKey: "customer-return-20260807-001",
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      reason: "Customer returned the unused advisory package",
      canonicalPayload: {
        creditNoteType: "ACCRECCREDIT",
        lineAmountType: "EXCLUSIVE",
        lines: [{
          quantity: "2.0000",
          unitAmount: "125.5000",
          enteredLineAmount: "251.0000",
          accountId: revenueAccountId,
          accountCode: "200",
          taxType: "OUTPUT",
          itemCode: "ADVISORY",
          trackingOptionIds: [trackingOptionId],
        }],
      },
      canonicalPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmationSummaryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(credit.confirmationPhrase).toMatch(
      /^确认创建 Customer Credit Note 草稿｜联系人 11111111…｜日期 2026-08-07｜录入行合计 SGD 251\.0000｜EXCLUSIVE｜原因 Customer returned the unused adv｜来源 AAAAAAAA｜校验 [A-F0-9]{10}$/,
    );
    expect(journal.confirmationPhrase).toMatch(
      /^确认创建 Manual Journal 草稿｜日期 2026-07-31｜借方 200\.0000｜贷方 200\.0000｜NoTax\/NONE｜来源 BBBBBBBB｜校验 [A-F0-9]{10}$/,
    );

    const { source_sha256: _omitted, ...withoutAssertedHash } = creditNoteInput;
    const fingerprinted = buildCreditNoteDraftPrimitive(withoutAssertedHash);
    expect(fingerprinted).toMatchObject({
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
    });
    expect(buildCreditNoteDraftPrimitive(withoutAssertedHash).sourceSha256).toBe(fingerprinted.sourceSha256);
    expect(buildCreditNoteDraftPrimitive({ ...withoutAssertedHash, reason: "Different reviewed reason" }).sourceSha256)
      .not.toBe(fingerprinted.sourceSha256);
    expect(buildCreditNoteDraftPrimitive({ ...withoutAssertedHash, source_unit_key: "different-unit" }).confirmationPhrase)
      .not.toBe(fingerprinted.confirmationPhrase);
    expect(buildManualJournalDraftPrimitive({
      ...manualJournalInput,
      source_sha256: undefined,
      lines: [manualJournalInput.lines[1], manualJournalInput.lines[0]],
    }).canonicalPayloadHash).not.toBe(journal.canonicalPayloadHash);
  });

  it("constructs object-specific SDK payloads with server-owned DRAFT and no final-state controls", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const journal = buildManualJournalDraftPrimitive(manualJournalInput);

    expect(toXeroCreditNoteCreatePayload(credit.canonicalPayload)).toEqual({
      creditNotes: [{
        type: "ACCRECCREDIT",
        contact: { contactID: contactId },
        date: "2026-08-07",
        status: "DRAFT",
        lineAmountTypes: "Exclusive",
        currencyCode: "SGD",
        reference: "RETURN-20260807-001",
        lineItems: [{
          description: "Unused advisory package",
          quantity: 2,
          unitAmount: 125.5,
          accountID: revenueAccountId,
          accountCode: "200",
          taxType: "OUTPUT",
          itemCode: "ADVISORY",
          tracking: [{ trackingOptionID: trackingOptionId }],
        }],
      }],
    });
    expect(toXeroManualJournalCreatePayload(journal.canonicalPayload)).toEqual({
      manualJournals: [{
        narration: "July accounting fee accrual",
        date: "2026-07-31",
        status: "DRAFT",
        lineAmountTypes: "NoTax",
        showOnCashBasisReports: false,
        journalLines: [
          {
            accountID: expenseAccountId,
            accountCode: "453",
            description: "Recognise July accounting expense",
            lineAmount: 200,
            taxType: "NONE",
            tracking: [{ trackingOptionID: trackingOptionId }],
          },
          {
            accountID: revenueAccountId,
            accountCode: "800",
            description: "Accrued accounting fee liability",
            lineAmount: -200,
            taxType: "NONE",
          },
        ],
      }],
    });

    const serialized = JSON.stringify({
      credit: toXeroCreditNoteCreatePayload(credit.canonicalPayload),
      journal: toXeroManualJournalCreatePayload(journal.canonicalPayload),
    });
    for (const forbidden of [
      "creditNoteID",
      "creditNoteNumber",
      "currencyRate",
      "sentToContact",
      "allocations",
      "payments",
      "showOnCashBasisReports\":true",
      "POSTED",
      "ARCHIVED",
      "url",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("revalidates persisted canonicals and refuses tampered state, economics, or unsafe numeric ranges", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput).canonicalPayload;
    const journal = buildManualJournalDraftPrimitive(manualJournalInput).canonicalPayload;
    const invalidCreditCanonicals = [
      { ...credit, status: "AUTHORISED" },
      { ...credit, objectType: "INVOICE" },
      { ...credit, enteredLineSubtotal: "999.0000" },
      { ...credit, reference: " RETURN-20260807-001" },
      { ...credit, lines: [{ ...credit.lines[0], quantity: "0.0000", enteredLineAmount: "0.0000" }], enteredLineSubtotal: "0.0000" },
      {
        ...credit,
        lines: [{
          ...credit.lines[0],
          quantity: "900000000000000000.0000",
          unitAmount: "1.0000",
          enteredLineAmount: "900000000000000000.0000",
        }],
        enteredLineSubtotal: "900000000000000000.0000",
      },
      { ...credit, allocations: [] },
    ];
    for (const candidate of invalidCreditCanonicals) {
      expect(() => toXeroCreditNoteCreatePayload(candidate)).toThrow();
    }

    const invalidJournalCanonicals = [
      { ...journal, status: "POSTED" },
      { ...journal, showOnCashBasisReports: true },
      { ...journal, lineAmountType: "EXCLUSIVE" },
      { ...journal, narration: " July accounting fee accrual" },
      { ...journal, lines: journal.lines.map((line) => ({ ...line, taxType: "OUTPUT" })) },
      { ...journal, lines: [{ ...journal.lines[0], lineAmount: "200.0000" }, { ...journal.lines[1], lineAmount: "-199.9999" }] },
      {
        ...journal,
        debitTotal: "900000000000000000.0000",
        creditTotal: "900000000000000000.0000",
        lines: [
          { ...journal.lines[0], lineAmount: "900000000000000000.0000" },
          { ...journal.lines[1], lineAmount: "-900000000000000000.0000" },
        ],
      },
      { ...journal, url: "https://unsafe.example" },
    ];
    for (const candidate of invalidJournalCanonicals) {
      expect(() => toXeroManualJournalCreatePayload(candidate)).toThrow();
    }
  });

  it("maps exact DRAFT readbacks and verifies provider economics, NoTax, and zero balance", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const journal = buildManualJournalDraftPrimitive(manualJournalInput);

    expect(mapCreditNoteDraftReadback(
      creditNoteReadback(),
      credit.canonicalPayload.authoritativeProviderField,
    )).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "CREDIT_NOTE",
        creditNoteId,
        canonicalPayload: { enteredLineSubtotal: "251.0000" },
        providerEconomicsEvidence: {
          lineAmounts: ["251.0000"],
          taxAmounts: ["25.1000"],
          subTotal: "251.0000",
          totalTax: "25.1000",
          total: "276.1000",
          noDiscountsVerified: true,
        },
      },
    });
    expect(mapManualJournalDraftReadback(manualJournalReadback())).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "MANUAL_JOURNAL",
        manualJournalId,
        canonicalPayload: {
          debitTotal: "200.0000",
          creditTotal: "200.0000",
          netAmount: "0.0000",
        },
        providerTaxEvidence: {
          taxTypes: ["NONE", "NONE"],
          taxAmounts: ["0.0000", "0.0000"],
          allNoneAndZero: true,
        },
        balanceVerified: true,
      },
    });
    expect(verifyCreditNoteDraftReadback(creditNoteId, credit.canonicalPayload, creditNoteReadback()))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: credit.canonicalPayloadHash });
    expect(verifyManualJournalDraftReadback(manualJournalId, journal.canonicalPayload, manualJournalReadback()))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: journal.canonicalPayloadHash });
  });

  it("accepts a native Date object for date fields exactly like the equivalent plain string (live Xero returns Date, not string, for CreditNote.date and ManualJournal.date)", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const journal = buildManualJournalDraftPrimitive(manualJournalInput);
    const creditNoteWithDateObject = {
      ...creditNoteReadback(),
      date: new Date("2026-08-07T00:00:00.000Z"),
    };
    const journalWithDateObject = {
      ...manualJournalReadback(),
      date: new Date("2026-07-31T00:00:00.000Z"),
    };

    expect(mapCreditNoteDraftReadback(
      creditNoteWithDateObject,
      credit.canonicalPayload.authoritativeProviderField,
    )).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "CREDIT_NOTE",
        creditNoteId,
        canonicalPayload: { creditNoteDate: "2026-08-07" },
      },
    });
    expect(mapManualJournalDraftReadback(journalWithDateObject)).toMatchObject({
      ok: true,
      snapshot: {
        objectType: "MANUAL_JOURNAL",
        manualJournalId,
        canonicalPayload: { journalDate: "2026-07-31" },
      },
    });
    expect(verifyCreditNoteDraftReadback(creditNoteId, credit.canonicalPayload, creditNoteWithDateObject))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: credit.canonicalPayloadHash });
    expect(verifyManualJournalDraftReadback(manualJournalId, journal.canonicalPayload, journalWithDateObject))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: journal.canonicalPayloadHash });
  });

  it("fails exact verification for object IDs, statuses, types, contacts, dates, currencies, references, and every line field", () => {
    const credit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const journal = buildManualJournalDraftPrimitive(manualJournalInput);
    const anotherId = "88888888-8888-4888-8888-888888888888";
    const anotherTrackingId = "99999999-9999-4999-8999-999999999999";
    const rawCredit = creditNoteReadback();
    const rawJournal = manualJournalReadback();

    expect(verifyCreditNoteDraftReadback(anotherId, credit.canonicalPayload, rawCredit)).toEqual({
      ok: false,
      reasons: ["XERO_OBJECT_ID_MISMATCH"],
    });
    expect(verifyCreditNoteDraftReadback(creditNoteId, { ...credit.canonicalPayload, status: "AUTHORISED" }, rawCredit))
      .toEqual({ ok: false, reasons: ["EXPECTED_CANONICAL_INVALID"] });
    expect(verifyCreditNoteDraftReadback(creditNoteId, credit.canonicalPayload, { ...rawCredit, status: "AUTHORISED" }))
      .toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });

    expect(verifyCreditNoteDraftReadback(
      creditNoteId,
      credit.canonicalPayload,
      { ...rawCredit, type: "ACCPAYCREDIT" },
    )).toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });
    const headerMismatches = [
      { ...rawCredit, contact: { contactID: anotherId } },
      { ...rawCredit, date: "2026-08-08" },
      { ...rawCredit, currencyCode: "USD" },
      { ...rawCredit, reference: "RETURN-CHANGED" },
      { ...rawCredit, lineAmountTypes: "NoTax", totalTax: 0, total: 251, remainingCredit: 251, lineItems: [{ ...rawCredit.lineItems[0], taxAmount: 0, taxType: "NONE" }] },
    ];
    const baseCreditLine = rawCredit.lineItems[0];
    const lineMismatches = [
      { ...baseCreditLine, description: "Changed credit reason line" },
      { ...baseCreditLine, quantity: 3, lineAmount: 376.5, taxAmount: 37.65 },
      { ...baseCreditLine, unitAmount: 126, lineAmount: 252, taxAmount: 25.2 },
      { ...baseCreditLine, accountID: anotherId },
      { ...baseCreditLine, accountCode: "201" },
      { ...baseCreditLine, taxType: "NONE" },
      { ...baseCreditLine, itemCode: "OTHER" },
      { ...baseCreditLine, tracking: [{ trackingOptionID: anotherTrackingId }] },
    ];
    for (const candidate of headerMismatches) {
      expect(verifyCreditNoteDraftReadback(creditNoteId, credit.canonicalPayload, candidate)).toMatchObject({
        ok: false,
        reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      });
    }
    for (const line of lineMismatches) {
      const lineAmount = line.lineAmount;
      const taxAmount = line.taxAmount;
      const candidate = {
        ...rawCredit,
        lineItems: [line],
        subTotal: lineAmount,
        totalTax: taxAmount,
        total: lineAmount + taxAmount,
        remainingCredit: lineAmount + taxAmount,
      };
      expect(verifyCreditNoteDraftReadback(creditNoteId, credit.canonicalPayload, candidate)).toMatchObject({
        ok: false,
        reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      });
    }

    expect(verifyManualJournalDraftReadback(anotherId, journal.canonicalPayload, rawJournal)).toEqual({
      ok: false,
      reasons: ["XERO_OBJECT_ID_MISMATCH"],
    });
    expect(verifyManualJournalDraftReadback(manualJournalId, journal.canonicalPayload, { ...rawJournal, status: "POSTED" }))
      .toEqual({ ok: false, reasons: ["MALFORMED_PROVIDER_READBACK"] });
    const journalHeaderMismatches = [
      { ...rawJournal, date: "2026-08-01" },
      { ...rawJournal, narration: "Changed narration" },
    ];
    for (const candidate of journalHeaderMismatches) {
      expect(verifyManualJournalDraftReadback(manualJournalId, journal.canonicalPayload, candidate)).toMatchObject({
        ok: false,
        reasons: ["CANONICAL_PAYLOAD_MISMATCH"],
      });
    }
    const journalLineMismatches = [
      [
        { ...rawJournal.journalLines[0], accountID: anotherId },
        rawJournal.journalLines[1],
      ],
      [
        { ...rawJournal.journalLines[0], accountCode: "454" },
        rawJournal.journalLines[1],
      ],
      [
        { ...rawJournal.journalLines[0], description: "Changed debit" },
        rawJournal.journalLines[1],
      ],
      [
        { ...rawJournal.journalLines[0], lineAmount: 250 },
        { ...rawJournal.journalLines[1], lineAmount: -250 },
      ],
      [
        { ...rawJournal.journalLines[0], tracking: [{ trackingOptionID: anotherTrackingId }] },
        rawJournal.journalLines[1],
      ],
    ];
    for (const lines of journalLineMismatches) {
      expect(verifyManualJournalDraftReadback(
        manualJournalId,
        journal.canonicalPayload,
        { ...rawJournal, journalLines: lines },
      )).toMatchObject({ ok: false, reasons: ["CANONICAL_PAYLOAD_MISMATCH"] });
    }
    expect(verifyCreditNoteDraftReadback(
      creditNoteId.toUpperCase(),
      credit.canonicalPayload,
      { ...rawCredit, creditNoteID: creditNoteId.toUpperCase() },
    )).toMatchObject({ ok: true });
    expect(verifyManualJournalDraftReadback(
      manualJournalId.toUpperCase(),
      journal.canonicalPayload,
      { ...rawJournal, manualJournalID: manualJournalId.toUpperCase() },
    )).toMatchObject({ ok: true });
  });

  it("fails closed on final-state evidence, discounts, allocations, malformed values, tax mismatches, and unbalanced journals", () => {
    const sealedCredit = buildCreditNoteDraftPrimitive(creditNoteInput);
    const rawCredit = creditNoteReadback();
    const baseCreditLine = rawCredit.lineItems[0];
    const malformedCredits: unknown[] = [
      null,
      {},
      { ...rawCredit, creditNoteID: "not-a-uuid" },
      { ...rawCredit, type: "ACCREC" },
      { ...rawCredit, status: "SUBMITTED" },
      { ...rawCredit, contact: undefined },
      { ...rawCredit, contact: { contactID: "not-a-uuid" } },
      { ...rawCredit, date: "2026-02-30" },
      { ...rawCredit, currencyCode: "ZZZ" },
      { ...rawCredit, reference: " RETURN-20260807-001" },
      { ...rawCredit, lineAmountTypes: "EXCLUSIVE" },
      { ...rawCredit, sentToContact: true },
      { ...rawCredit, appliedAmount: 1 },
      { ...rawCredit, remainingCredit: 1 },
      { ...rawCredit, fullyPaidOnDate: "2026-08-08" },
      { ...rawCredit, allocations: [{ allocationID: anotherProviderId() }] },
      { ...rawCredit, payments: [{ paymentID: anotherProviderId() }] },
      { ...rawCredit, hasErrors: true },
      { ...rawCredit, validationErrors: [{ message: "rejected" }] },
      { ...rawCredit, lineItems: undefined },
      { ...rawCredit, lineItems: [] },
      { ...rawCredit, lineItems: Array.from({ length: 21 }, () => baseCreditLine) },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, description: " Unused advisory package" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, quantity: "2" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, quantity: 0 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, quantity: Number.NaN }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, unitAmount: -1 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, unitAmount: 1.00001 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, lineAmount: undefined }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, lineAmount: 250 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, taxAmount: undefined }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, taxAmount: -1 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, accountID: "not-a-uuid" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, accountCode: "200;DROP" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, taxType: "OUTPUT\nINJECT" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, itemCode: "../ITEM" }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, tracking: [{}] }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, tracking: [{ trackingOptionID: trackingOptionId }, { trackingOptionID: trackingOptionId }] }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, discountRate: 1, lineAmount: 248.49 }] },
      { ...rawCredit, lineItems: [{ ...baseCreditLine, discountAmount: 1, lineAmount: 250 }] },
      { ...rawCredit, subTotal: 999, total: 1_024.1 },
      { ...rawCredit, totalTax: 99, total: 350 },
      { ...rawCredit, total: 999 },
    ];
    for (const candidate of malformedCredits) {
      expect(mapCreditNoteDraftReadback(
        candidate,
        sealedCredit.canonicalPayload.authoritativeProviderField,
      )).toEqual({
        ok: false,
        reason: "MALFORMED_PROVIDER_READBACK",
      });
    }

    const rawJournal = manualJournalReadback();
    const baseJournalLine = rawJournal.journalLines[0];
    const malformedJournals: unknown[] = [
      null,
      {},
      { ...rawJournal, manualJournalID: "not-a-uuid" },
      { ...rawJournal, status: "POSTED" },
      { ...rawJournal, status: "ARCHIVED" },
      { ...rawJournal, date: "2026-02-30" },
      { ...rawJournal, narration: " July accounting fee accrual" },
      { ...rawJournal, lineAmountTypes: "Exclusive" },
      { ...rawJournal, showOnCashBasisReports: true },
      { ...rawJournal, showOnCashBasisReports: undefined },
      { ...rawJournal, url: "https://unsafe.example/source" },
      { ...rawJournal, hasAttachments: true },
      { ...rawJournal, attachments: [{ attachmentID: anotherProviderId() }] },
      { ...rawJournal, validationErrors: [{ message: "rejected" }] },
      { ...rawJournal, journalLines: undefined },
      { ...rawJournal, journalLines: [baseJournalLine] },
      { ...rawJournal, journalLines: Array.from({ length: 51 }, (_, index) => ({
        ...rawJournal.journalLines[index % 2],
      })) },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, accountID: "not-a-uuid" }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, accountCode: "453;DROP" }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, description: " Recognise July accounting expense" }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, lineAmount: "200" }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, lineAmount: 200.00001 }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, lineAmount: 0 }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, taxType: "OUTPUT" }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, taxAmount: 0.01 }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, isBlank: true }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, tracking: [{}] }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, tracking: [{ trackingOptionID: trackingOptionId }, { trackingOptionID: trackingOptionId }] }, rawJournal.journalLines[1]] },
      { ...rawJournal, journalLines: [{ ...baseJournalLine, lineAmount: 199.9999 }, rawJournal.journalLines[1]] },
    ];
    for (const candidate of malformedJournals) {
      expect(mapManualJournalDraftReadback(candidate)).toEqual({
        ok: false,
        reason: "MALFORMED_PROVIDER_READBACK",
      });
    }
  });

  it("supports both credit-note types, provider currency rounding, and exact observed economics", () => {
    const supplierInput = {
      ...creditNoteInput,
      source_sha256: undefined,
      source_unit_key: "supplier-return-20260807-001",
      reason: "Supplier issued a credit for returned equipment",
      credit_note_type: "ACCPAYCREDIT" as const,
      reference: "SUPPLIER-CREDIT-001",
      authoritative_provider_field: "CREDIT_NOTE_NUMBER" as const,
      line_amount_type: "NoTax" as const,
      lines: [{ ...creditNoteInput.lines[0], tax_type: "NONE" }],
    };
    const supplier = buildCreditNoteDraftPrimitive(supplierInput);
    const supplierReadback = {
      ...creditNoteReadback(),
      type: "ACCPAYCREDIT",
      reference: undefined,
      creditNoteNumber: "SUPPLIER-CREDIT-001",
      lineAmountTypes: "NoTax",
      lineItems: [{ ...creditNoteReadback().lineItems[0], taxType: "NONE", taxAmount: 0 }],
      totalTax: 0,
      total: 251,
      remainingCredit: 251,
    };
    expect(supplier.confirmationPhrase).toMatch(/^确认创建 Supplier Credit Note 草稿/);
    const supplierCreate = toXeroCreditNoteCreatePayload(supplier.canonicalPayload).creditNotes?.[0];
    expect(supplierCreate).toMatchObject({
      type: "ACCPAYCREDIT",
      status: "DRAFT",
      creditNoteNumber: "SUPPLIER-CREDIT-001",
      lineAmountTypes: "NoTax",
    });
    expect(supplierCreate).not.toHaveProperty("reference");
    expect(verifyCreditNoteDraftReadback(creditNoteId, supplier.canonicalPayload, supplierReadback))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: supplier.canonicalPayloadHash });

    const roundedInput = {
      ...creditNoteInput,
      lines: [{ ...creditNoteInput.lines[0], unit_amount: 125.5025 }],
    };
    const rounded = buildCreditNoteDraftPrimitive(roundedInput);
    const roundedReadback = {
      ...creditNoteReadback(),
      lineItems: [{ ...creditNoteReadback().lineItems[0], unitAmount: 125.5025, lineAmount: 251.01 }],
      subTotal: 251.01,
      total: 276.11,
      remainingCredit: 276.11,
    };
    expect(rounded.canonicalPayload.enteredLineSubtotal).toBe("251.0050");
    expect(verifyCreditNoteDraftReadback(creditNoteId, rounded.canonicalPayload, roundedReadback))
      .toMatchObject({ ok: true, readbackCanonicalPayloadHash: rounded.canonicalPayloadHash });
    expect(mapCreditNoteDraftReadback(
      {
        ...roundedReadback,
        lineItems: [{ ...roundedReadback.lineItems[0], lineAmount: 251.0101 }],
        subTotal: 251.0101,
        total: 276.1101,
        remainingCredit: 276.1101,
      },
      rounded.canonicalPayload.authoritativeProviderField,
    )).toEqual({ ok: false, reason: "MALFORMED_PROVIDER_READBACK" });
  });

  it("fails closed when a runtime caller omits the sealed credit-note provider field", () => {
    expect(mapCreditNoteDraftReadback(creditNoteReadback(), undefined as never)).toEqual({
      ok: false,
      reason: "MALFORMED_PROVIDER_READBACK",
    });
  });
});

function anotherProviderId(): string {
  return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
}
