import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import { prepareAccountingCasePublicSchema } from "../src/domain/accountingCaseSchemas.js";
import {
  accountingCaseBusinessContinuationTemplate,
} from "../src/domain/accountingCaseContinuation.js";
import {
  normalizeXeroAccountingCaseBusinessIntake,
  XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES,
  xeroAccountingCaseBusinessIntakeSchema,
} from "../src/mcp/xeroAccountingCaseBusinessIntake.js";
import {
  createXeroAccountingCaseProviderContract,
} from "../src/policy/xeroAccountingCaseProviderContract.js";
import { createXeroDeclaredLedgerPolicy } from "../src/policy/xeroDeclaredLedgerPolicy.js";
import { bindXeroDeclaredLedger, type XeroDeclaredLedgerBinding } from "../src/policy/xeroDeclaredLedgerBinding.js";
import type { AccountSummary, TaxRateSummary } from "../src/providers/types.js";

const TEST_TENANT_ID = "11111111-1111-4111-8111-111111111111";

// ADR-002: the caller declares the exact live Xero account/tax coordinate and
// the server verifies it against the tenant's own chart of accounts and tax
// rates. These fixtures stand in for that live tenant data; account codes
// 200/453/485 and tax types OUTPUTY24/INPUTY24/NONE mirror the synthetic
// provider used across the harness (see harness/runners/run-p0-accounting-case.ts).
const TEST_LEDGER_ACCOUNTS: readonly AccountSummary[] = [
  { accountId: "33333333-3333-4333-8333-333333333333", code: "200", name: "Consulting Revenue", status: "ACTIVE", type: "REVENUE", class: "REVENUE" },
  { accountId: "33333333-3333-4333-8333-333333333353", code: "453", name: "Office Supplies", status: "ACTIVE", type: "EXPENSE", class: "EXPENSE" },
  { accountId: "33333333-3333-4333-8333-333333333385", code: "485", name: "Cloud Subscriptions", status: "ACTIVE", type: "EXPENSE", class: "EXPENSE" },
];
const TEST_LEDGER_TAX_RATES: readonly TaxRateSummary[] = [
  { taxType: "OUTPUTY24", name: "GST on Income", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true },
  { taxType: "INPUTY24", name: "GST on Expenses", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToExpenses: true },
  {
    taxType: "NONE", name: "No Tax", status: "ACTIVE", displayTaxRate: "0.0000", effectiveRate: "0.0000",
    canApplyToRevenue: true, canApplyToExpenses: true, canApplyToAssets: true, canApplyToLiabilities: true, canApplyToEquity: true,
  },
];

function testLedgerBinding(tenantId = TEST_TENANT_ID): XeroDeclaredLedgerBinding {
  return bindXeroDeclaredLedger({
    tenantId,
    jurisdiction: "SG",
    accountCodes: TEST_LEDGER_ACCOUNTS.map((account) => account.code!),
    taxTypes: TEST_LEDGER_TAX_RATES.map((taxRate) => taxRate.taxType),
    accounts: TEST_LEDGER_ACCOUNTS,
    taxRates: TEST_LEDGER_TAX_RATES,
  });
}

function compileBusinessFixture(relativePath: string) {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
  const parsed = xeroAccountingCaseBusinessIntakeSchema.parse(fixture);
  const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
  const nativeFacts = normalized.facts.filter((fact) => fact.kind === "NATIVE_DOCUMENT");
  const bindings = new Map(nativeFacts.map((fact, index) => [fact.factId, {
    contactId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }]));
  const compiled = compileAccountingCase({
    caseId: normalized.case_id,
    expectedVersion: normalized.expected_version,
    target: {
      tenantId: TEST_TENANT_ID,
      environment: "TEST",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      organisationStatus: "ACTIVE",
    },
    sources: normalized.sources,
    facts: normalized.facts,
  }, createXeroDeclaredLedgerPolicy({
    jurisdiction: "SG",
    paysTax: true,
    ledgerBinding: testLedgerBinding(),
  }), createXeroAccountingCaseProviderContract(
    bindings,
    testLedgerBinding(),
  ));
  return { normalized, compiled };
}

describe("Xero Accounting Case business intake", () => {
  it("normalizes the five Payment/Bank actions into one closed Case route", () => {
    const common = { type: "SPEND", contact_id: "11111111-1111-4111-8111-111111111111",
      bank_account_id: "22222222-2222-4222-8222-222222222222", transaction_date: "2026-08-20",
      reference: "BANK-1", line_amount_type: "NO_TAX", lines: [{ description: "Fee", quantity: "1",
        unit_amount: "10", account_code: "453",
        tax_type: "NONE", tracking_option_ids: [] }] };
    const normalized = normalizeXeroAccountingCaseBusinessIntake(xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-payment-bank", expected_version: 0, source_label: "Payment Bank", source_set_complete: true, documents: [],
      payment_bank_ledger: [
        { action: "payment.create", invoice_id: "44444444-4444-4444-8444-444444444444", invoice_type: "ACCREC",
          bank_account_id: common.bank_account_id, payment_date: "2026-08-20", amount: "10" },
        { action: "payment.reverse", payment_id: "55555555-5555-4555-8555-555555555555" },
        { action: "bank_transaction.create", ...common },
        { action: "bank_transaction.update", bank_transaction_id: "66666666-6666-4666-8666-666666666666",
          expected_updated_at: "2026-08-20T10:00:00+08:00", ...common },
        { action: "bank_transaction.reverse", bank_transaction_id: "77777777-7777-4777-8777-777777777777" },
      ],
    }));
    const compiled = compileAccountingCase({ caseId: normalized.case_id, expectedVersion: 0,
      target: { tenantId: TEST_TENANT_ID, environment: "TEST", baseCurrency: "SGD", taxJurisdiction: "SG", organisationStatus: "ACTIVE" },
      sources: normalized.sources, facts: normalized.facts },
    createXeroDeclaredLedgerPolicy({ jurisdiction: "SG", paysTax: true, ledgerBinding: testLedgerBinding() }),
    createXeroAccountingCaseProviderContract(new Map(), testLedgerBinding()));
    const bankFact = normalized.facts.find((fact) => fact.kind === "PAYMENT_BANK_LEDGER" && fact.actionId === "bank_transaction.create");
    expect(bankFact && "lines" in bankFact.payload ? bankFact.payload.lines[0] : undefined).not.toHaveProperty("accountId");
    expect(compiled.operations).toHaveLength(5);
    expect(compiled.operations.every((operation) => operation.nativeRoute === "PAYMENT_BANK_LEDGER")).toBe(true);
  });

  it("normalizes all eight exact-target ledger adjustments into one closed Case route", () => {
    const adjustments = [
      { action: "customer_invoice.void", invoice_id: "11111111-1111-4111-8111-111111111111" },
      { action: "supplier_bill.void", invoice_id: "22222222-2222-4222-8222-222222222222" },
      { action: "credit_note.authorise", credit_note_id: "33333333-3333-4333-8333-333333333333", credit_note_type: "ACCRECCREDIT" },
      {
        action: "credit_note.allocate", credit_note_id: "44444444-4444-4444-8444-444444444444",
        credit_note_type: "ACCRECCREDIT", target_invoice_id: "55555555-5555-4555-8555-555555555555",
        target_invoice_type: "ACCREC", amount: "10.0000", allocation_date: "2026-08-20",
      },
      {
        action: "credit_note.unallocate", credit_note_id: "44444444-4444-4444-8444-444444444444",
        allocation_id: "55555555-5555-4555-8555-555555555555",
      },
      {
        action: "credit_note.refund", credit_note_id: "66666666-6666-4666-8666-666666666666",
        credit_note_type: "ACCPAYCREDIT", bank_account_id: "77777777-7777-4777-8777-777777777777",
        amount: "5.0000", refund_date: "2026-08-20",
      },
      { action: "credit_note.void", credit_note_id: "88888888-8888-4888-8888-888888888888", credit_note_type: "ACCPAYCREDIT" },
      { action: "manual_journal.void", manual_journal_id: "99999999-9999-4999-8999-999999999999" },
    ];
    const normalized = normalizeXeroAccountingCaseBusinessIntake(xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-ledger-adjustments",
      expected_version: 0,
      source_label: "Exact ledger adjustments",
      source_set_complete: true,
      documents: [],
      ledger_adjustments: adjustments,
    }));
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({ jurisdiction: "SG", paysTax: true, ledgerBinding: testLedgerBinding() }),
    createXeroAccountingCaseProviderContract(new Map(), testLedgerBinding()));
    expect(normalized.facts.every((fact) => fact.kind === "LEDGER_ADJUSTMENT")).toBe(true);
    expect(compiled.events.every((event) => event.route === "LEDGER_ADJUSTMENT")).toBe(true);
    expect(compiled.operations.map((operation) => operation.actionId).sort())
      .toEqual(adjustments.map((adjustment) => adjustment.action).sort());
    expect(compiled.operations.every((operation) => operation.nativeRoute === "LEDGER_ADJUSTMENT")).toBe(true);
  });

  it("normalizes all six exact-target full DRAFT replacements into one closed Case route", () => {
    const contact = { name: "Exact Counterparty" };
    const nativeReplacement = (document_type: "CUSTOMER_INVOICE" | "SUPPLIER_BILL") => ({
      document_type,
      status: "DRAFT",
      reference: `${document_type}-UPDATE-1`,
      reference_kind: "FORMAL_DOCUMENT_NUMBER",
      document_date: "2026-08-20",
      due_date: "2026-09-20",
      currency: "SGD",
      contact,
      declared_net: "100.00",
      declared_tax: "0",
      declared_gross: "100.00",
      lines: [{
        description: "Complete replacement line",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "0",
        account_code: document_type === "CUSTOMER_INVOICE" ? "200" : "453",
        tax_type: "NONE",
      }],
      document_validity: "TEST_OR_NOT_VALID",
    });
    const updates = [
      {
        action: "customer_invoice.update_draft",
        target_xero_object_id: "11111111-1111-4111-8111-111111111111",
        expected_updated_at: "2026-08-20T10:00:00+08:00",
        replacement: nativeReplacement("CUSTOMER_INVOICE"),
      },
      {
        action: "supplier_bill.update_draft",
        target_xero_object_id: "22222222-2222-4222-8222-222222222222",
        expected_updated_at: "2026-08-20T10:00:01+08:00",
        replacement: nativeReplacement("SUPPLIER_BILL"),
      },
      {
        action: "credit_note.update_draft",
        target_xero_object_id: "33333333-3333-4333-8333-333333333333",
        expected_updated_at: "2026-08-20T10:00:02+08:00",
        replacement: {
          ...nativeReplacement("CUSTOMER_INVOICE"),
          document_type: "CUSTOMER_CREDIT_NOTE",
          due_date: undefined,
          reference: "CN-UPDATE-1",
          original_document: {
            reference: "INV-ORIGINAL-1",
            reference_kind: "FORMAL_DOCUMENT_NUMBER",
            document_date: "2026-08-01",
          },
        },
      },
      {
        action: "quote.update_draft",
        target_xero_object_id: "44444444-4444-4444-8444-444444444444",
        expected_updated_at: "2026-08-20T10:00:03+08:00",
        replacement: {
          document_type: "QUOTE",
          status: "DRAFT",
          reference: "QUOTE-UPDATE-1",
          document_date: "2026-08-20",
          expiry_date: "2026-09-20",
          currency: "SGD",
          contact,
          line_amount_type: "EXCLUSIVE",
          lines: [{ description: "Quote replacement", quantity: "1", unit_amount: "10", account_code: "200", tax_type: "NONE" }],
          document_validity: "TEST_OR_NOT_VALID",
        },
      },
      {
        action: "purchase_order.update_draft",
        target_xero_object_id: "55555555-5555-4555-8555-555555555555",
        expected_updated_at: "2026-08-20T10:00:04+08:00",
        replacement: {
          document_type: "PURCHASE_ORDER",
          status: "DRAFT",
          reference: "PO-UPDATE-1",
          document_date: "2026-08-20",
          expected_arrival_date: "2026-08-25",
          currency: "SGD",
          contact,
          line_amount_type: "EXCLUSIVE",
          lines: [{ description: "PO replacement", quantity: "1", unit_amount: "10", account_code: "453", tax_type: "NONE" }],
          document_validity: "TEST_OR_NOT_VALID",
        },
      },
      {
        action: "manual_journal.update_draft",
        target_xero_object_id: "66666666-6666-4666-8666-666666666666",
        expected_updated_at: "2026-08-20T10:00:05+08:00",
        replacement: {
          status: "DRAFT",
          narration: "Updated accrual",
          journal_date: "2026-08-20",
          lines: [
            { description: "Debit", account_code: "453", tax_type: "NONE", debit: "10" },
            { description: "Credit", account_code: "485", tax_type: "NONE", credit: "10" },
          ],
          document_validity: "TEST_OR_NOT_VALID",
        },
      },
    ];
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-six-draft-updates",
      expected_version: 0,
      source_label: "Complete reviewed replacements",
      source_set_complete: true,
      documents: [],
      draft_document_updates: updates,
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
    expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
    const updateFacts = normalized.facts.filter((fact) => fact.kind === "DRAFT_DOCUMENT_UPDATE");
    expect(updateFacts).toHaveLength(6);
    expect(updateFacts.every((fact) => fact.replacement.provenance === fact.provenance)).toBe(true);
    const contactBindings = new Map(updateFacts.flatMap((fact, index) =>
      fact.replacement.kind === "BALANCED_JOURNAL" ? [] : [[fact.factId, {
        contactId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }] as const]));
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testLedgerBinding(),
    }), createXeroAccountingCaseProviderContract(contactBindings, testLedgerBinding()), contactBindings);
    // The service injects exact provider original-transaction evidence before
    // compiling a credit-note replacement. This pure compiler test has no
    // provider reader, so that one event remains correctly blocked here.
    expect(compiled.operations.map((operation) => operation.actionId).sort()).toEqual(
      updates.map((update) => update.action).filter((action) => action !== "credit_note.update_draft").sort(),
    );
    expect(compiled.operations).toHaveLength(5);
    expect(compiled.operations.every((operation) => operation.nativeRoute === "DRAFT_DOCUMENT_UPDATE")).toBe(true);
    for (const operation of compiled.operations) {
      expect(operation.canonicalPayload).toMatchObject({
        targetXeroObjectId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        expectedUpdatedAt: expect.stringMatching(/(?:Z|[+-]\d{2}:\d{2})$/u),
        replacement: expect.objectContaining({ status: "DRAFT" }),
      });
    }
    expect(compiled.events).toEqual(expect.arrayContaining([expect.objectContaining({
      route: "DRAFT_DOCUMENT_UPDATE",
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: expect.arrayContaining(["CREDIT_ORIGINAL_TRANSACTION_NOT_FOUND"]),
    })]));

    for (const invalid of [
      { ...updates[0], target_xero_object_id: "not-a-uuid" },
      { ...updates[0], expected_updated_at: "2026-08-20T10:00:00" },
      { ...updates[0], replacement: { ...updates[0]!.replacement, status: "AUTHORISED" } },
      { ...updates[0], replacement: { status: "DRAFT" } },
      { ...updates[0], patch: { reference: "PATCH-NOT-ALLOWED" } },
    ]) {
      expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
        case_id: "case-invalid-draft-update",
        expected_version: 0,
        source_label: "Invalid replacement",
        source_set_complete: true,
        documents: [],
        draft_document_updates: [invalid],
      }).success).toBe(false);
    }
  });

  it("normalizes only the three closed exact-UUID ledger-state transitions", () => {
    const transitions = [
      { action: "customer_invoice.authorise", invoice_id: "44444444-4444-4444-8444-444444444444" },
      { action: "supplier_bill.authorise", invoice_id: "55555555-5555-4555-8555-555555555555" },
      { action: "manual_journal.post", manual_journal_id: "66666666-6666-4666-8666-666666666666" },
    ] as const;
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-ledger-transitions",
      expected_version: 0,
      source_label: "Existing Xero drafts",
      source_set_complete: true,
      documents: [],
      ledger_state_transitions: transitions,
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
    expect(normalized.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "LEDGER_STATE_TRANSITION",
        actionId: "customer_invoice.authorise",
        targetXeroObjectId: transitions[0].invoice_id,
      }),
      expect.objectContaining({
        kind: "LEDGER_STATE_TRANSITION",
        actionId: "supplier_bill.authorise",
        targetXeroObjectId: transitions[1].invoice_id,
      }),
      expect.objectContaining({
        kind: "LEDGER_STATE_TRANSITION",
        actionId: "manual_journal.post",
        targetXeroObjectId: transitions[2].manual_journal_id,
      }),
    ]));
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testLedgerBinding(),
    }), createXeroAccountingCaseProviderContract(new Map(), testLedgerBinding()));
    expect(compiled.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: "customer_invoice.authorise",
        nativeRoute: "LEDGER_STATE_TRANSITION",
        canonicalPayload: {
          invoiceId: transitions[0].invoice_id,
          invoiceType: "ACCREC",
          expectedStatus: "DRAFT",
        },
      }),
      expect.objectContaining({
        actionId: "supplier_bill.authorise",
        nativeRoute: "LEDGER_STATE_TRANSITION",
        canonicalPayload: {
          invoiceId: transitions[1].invoice_id,
          invoiceType: "ACCPAY",
          expectedStatus: "DRAFT",
        },
      }),
      expect.objectContaining({
        actionId: "manual_journal.post",
        nativeRoute: "LEDGER_STATE_TRANSITION",
        canonicalPayload: {
          manualJournalId: transitions[2].manual_journal_id,
          expectedStatus: "DRAFT",
        },
      }),
    ]));

    for (const invalid of [
      { action: "customer_invoice.authorise", invoice_id: "not-a-uuid" },
      { action: "manual_journal.post", invoice_id: transitions[2].manual_journal_id },
      { action: "customer_invoice.void", invoice_id: transitions[0].invoice_id },
      { action: "supplier_bill.authorise", invoice_id: transitions[1].invoice_id, status: "AUTHORISED" },
      { action: "manual_journal.post", manual_journal_id: transitions[2].manual_journal_id, tenant_id: "injected" },
    ]) {
      expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
        case_id: "case-ledger-transition-invalid",
        expected_version: 0,
        source_label: "Existing Xero draft",
        source_set_complete: true,
        documents: [],
        ledger_state_transitions: [invalid],
      }).success).toBe(false);
    }
  });
  it("normalizes quote, purchase-order, and balanced manual-journal DRAFT inputs into executable Case actions", () => {
    const intake = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-public-commercial-and-journal-drafts",
      expected_version: 0,
      source_label: "Signed commercial source batch",
      source_set_complete: true,
      documents: [],
      commercial_documents: [{
        document_type: "QUOTE",
        reference: "QUOTE-2026-001",
        document_date: "2026-08-20",
        expiry_date: "2026-09-19",
        currency: "SGD",
        contact: { name: "Exact Customer" },
        line_amount_type: "EXCLUSIVE",
        lines: [{
          description: "Advisory services",
          quantity: "1",
          unit_amount: "100.00",
          account_code: "200",
          tax_type: "OUTPUTY24",
        }],
        document_validity: "TEST_OR_NOT_VALID",
      }, {
        document_type: "PURCHASE_ORDER",
        reference: "PO-2026-001",
        document_date: "2026-08-20",
        expected_arrival_date: "2026-08-25",
        currency: "SGD",
        contact: { name: "Exact Supplier" },
        line_amount_type: "EXCLUSIVE",
        lines: [{
          description: "Cloud service",
          quantity: "1",
          unit_amount: "100.00",
          account_code: "453",
          tax_type: "INPUTY24",
        }],
        document_validity: "TEST_OR_NOT_VALID",
      }],
      manual_journals: [{
        narration: "Month-end accrual",
        journal_date: "2026-08-20",
        lines: [{
          description: "Accrued expense",
          account_code: "453",
          tax_type: "NONE",
          debit: "100.00",
        }, {
          description: "Accrual liability",
          account_code: "485",
          tax_type: "NONE",
          credit: "100.00",
        }],
        document_validity: "TEST_OR_NOT_VALID",
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(intake);
    expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
    const commercialFacts = normalized.facts.filter((fact) => fact.kind === "COMMERCIAL_DOCUMENT");
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testLedgerBinding(),
    }), createXeroAccountingCaseProviderContract(new Map(), testLedgerBinding()), new Map(
      commercialFacts.map((fact, index) => [fact.factId, {
        contactId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }]),
    ));
    expect(compiled.operations.map((operation) => operation.actionId).sort()).toEqual([
      "manual_journal.create_draft",
      "purchase_order.create_draft",
      "quote.create_draft",
    ]);
  });

  it("normalizes the three safe Contact/Item maintenance actions into the same typed Case action union", () => {
    const intake = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-public-reference-data-actions",
      expected_version: 0,
      source_label: "Reviewed master-data source batch",
      source_set_complete: true,
      documents: [],
      contact_basic_updates: [{
        contact_id: "11111111-1111-4111-8111-111111111111",
        patch: { email: "updated@example.com" },
      }],
      item_basic_creates: [{
        code: "CONSULT-2026",
        name: "Consulting service",
        is_sold: true,
        is_purchased: false,
      }],
      item_basic_updates: [{
        item_id: "22222222-2222-4222-8222-222222222222",
        patch: { name: "Renamed consulting service" },
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(intake);
    expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testLedgerBinding(),
    }), createXeroAccountingCaseProviderContract(new Map(), testLedgerBinding()));
    expect(compiled.operations.map((operation) => operation.actionId).sort()).toEqual([
      "contact.update_basic",
      "item.create_basic_untracked",
      "item.update_basic_untracked",
    ]);
    expect(compiled.operations.every((operation) => operation.terminalState === "ELIGIBLE_FOR_PREFLIGHT")).toBe(true);
  });

  it("normalizes a contact-only recovery successor without manufacturing an empty document source", () => {
    const contactOnly = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: `recovery-${"c".repeat(64)}`,
      expected_version: 0,
      continuation_token: `acr_${"d".repeat(64)}`,
      source_label: "Recovery residual contact",
      source_set_complete: true,
      documents: [],
      new_contacts: [{
        usage_roles: ["SUPPLIER"],
        contact: {
          name: "Residual Supplier",
          durable_identity: {
            kind: "LEGAL_REGISTRY",
            jurisdiction: "SG",
            registry_scheme: "UEN",
            number: "202600001R",
          },
        },
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(contactOnly);
    expect(normalized.sources).toHaveLength(1);
    expect(normalized.sources[0]?.units).toHaveLength(1);
    expect(normalized.facts).toEqual([
      expect.objectContaining({ kind: "CONTACT_CANDIDATE", name: "Residual Supplier" }),
    ]);
    expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
    const compiled = compileAccountingCase({
      caseId: normalized.case_id,
      expectedVersion: normalized.expected_version,
      target: {
        tenantId: TEST_TENANT_ID,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testLedgerBinding(),
    }), createXeroAccountingCaseProviderContract(
      new Map(),
      testLedgerBinding(),
    ));
    expect(compiled.operations).toEqual([
      expect.objectContaining({ actionId: "contact.create_basic" }),
    ]);
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...contactOnly,
      new_contacts: [],
    }).success).toBe(false);
  });

  it("merges AR/AP usage candidates for one typed legal identity and rejects one name with different tuples", () => {
    const contact = {
      name: "Dual Usage Pte. Ltd.",
      durable_identity: {
        kind: "LEGAL_REGISTRY" as const,
        jurisdiction: "SG",
        registry_scheme: "ACRA_UEN",
        number: "202600088M",
      },
      company_number: "202600088M",
    };
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-dual-role-contact-normalization",
      expected_version: 0,
      source_label: "One legal contact, two usage directions",
      source_set_complete: true,
      documents: [],
      new_contacts: [{ usage_roles: ["SUPPLIER"], contact }, {
        usage_roles: ["CUSTOMER"],
        contact: structuredClone(contact),
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
    expect(normalized.sources).toHaveLength(1);
    expect(normalized.sources[0]?.units).toHaveLength(1);
    expect(normalized.facts).toEqual([
      expect.objectContaining({
        kind: "CONTACT_CANDIDATE",
        usageRoles: ["CUSTOMER", "SUPPLIER"],
      }),
    ]);
    expect(JSON.stringify(normalized)).not.toContain('"role"');

    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...parsed,
      new_contacts: [{ usage_roles: ["CUSTOMER"], contact }, {
        usage_roles: ["SUPPLIER"],
        contact: {
          ...contact,
          durable_identity: { ...contact.durable_identity, number: "202600089K" },
          company_number: "202600089K",
        },
      }],
    }).success).toBe(false);
  });

  it("normalizes same-Case credit originals to evidence-only facts with zero original or credit write authority", () => {
    const { normalized, compiled } = compileBusinessFixture(
      "../harness/fixtures/xero/accounting-case-business-documents.v1.json",
    );
    const submittedOriginals = normalized.facts.filter((fact) =>
      fact.kind === "EVIDENCE" && fact.evidenceRole === "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT");
    expect(submittedOriginals).toHaveLength(2);
    expect(submittedOriginals.every((fact) => !("amount" in fact))).toBe(true);
    expect(compiled.operations.some((operation) =>
      operation.canonicalPayload.reference === "INV-2026-0702" ||
      operation.canonicalPayload.reference === "OH-260701")).toBe(false);
    expect(compiled.operations.some((operation) =>
      operation.nativeRoute === "CUSTOMER_CREDIT" || operation.nativeRoute === "SUPPLIER_CREDIT")).toBe(false);
    expect(compiled.events.filter((event) => event.disposition === "EVIDENCE_ONLY")).toHaveLength(2);
    expect(compiled.events.filter((event) =>
      event.route === "CUSTOMER_CREDIT" || event.route === "SUPPLIER_CREDIT")).toEqual([
      expect.objectContaining({ disposition: "BLOCKED_VALIDATION" }),
      expect.objectContaining({ disposition: "BLOCKED_VALIDATION" }),
    ]);
  });

  it("uses a real per-line ledger declaration and round-trips through public continuation without document-level defaults", () => {
    const perLine = {
      case_id: "case-per-line-contract",
      expected_version: 0,
      source_label: "One mixed supplier bill",
      source_set_complete: true as const,
      documents: [{
        document_type: "SUPPLIER_BILL" as const,
        reference: "BILL-PER-LINE-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        document_date: "2026-07-20",
        due_date: "2026-08-20",
        currency: "SGD",
        contact: { name: "Exact Supplier" },
        lines: [{
          description: "Office supplies",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
          account_code: "453",
          tax_type: "INPUTY24",
        }, {
          description: "Cloud subscription",
          quantity: "1",
          unit_amount_excluding_tax: "50.00",
          source_tax_amount: "0.00",
          account_code: "485",
          tax_type: "NONE",
        }],
        declared_net: "150.00",
        declared_tax: "9.00",
        declared_gross: "159.00",
        document_validity: "TEST_OR_NOT_VALID" as const,
      }],
    };
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse(perLine);
    const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
    const fact = normalized.facts.find((candidate) => candidate.kind === "NATIVE_DOCUMENT");
    expect(fact).toMatchObject({
      lineAmountType: "EXCLUSIVE",
      lines: [
        { accountCode: "453", taxType: "INPUTY24" },
        { accountCode: "485", taxType: "NONE" },
      ],
    });
    const continuation = accountingCaseBusinessContinuationTemplate({
      caseId: normalized.case_id,
      expectedVersion: 1,
      sources: normalized.sources,
      facts: normalized.facts,
    });
    expect(continuation.documents[0]).toMatchObject({
      lines: [
        expect.objectContaining({ account_code: "453", tax_type: "INPUTY24" }),
        expect.objectContaining({ account_code: "485", tax_type: "NONE" }),
      ],
    });
    expect(continuation.documents[0]).not.toHaveProperty("line_accounting_mode");
    expect(continuation.documents[0]).not.toHaveProperty("accounting_category");
    expect(() => xeroAccountingCaseBusinessIntakeSchema.parse(continuation)).not.toThrow();

    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...perLine,
      documents: [{ ...perLine.documents[0], line_accounting_mode: "PER_LINE" }],
    }).success).toBe(false);
    const missingLineAccountCode = structuredClone(perLine);
    delete (missingLineAccountCode.documents[0]!.lines[0] as Partial<{
      account_code: string;
    }>).account_code;
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse(missingLineAccountCode).success).toBe(false);
  });

  it("normalizes every published document type into the shared public Case schema", () => {
    let checked = 0;
    for (const documentType of XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES) {
      const credit = documentType.endsWith("CREDIT_NOTE");
      const customer = documentType.startsWith("CUSTOMER_");
      const originalReference = `ORIGINAL-${checked + 1}`;
      // ADR-002: account_code/tax_type are open, provider-native strings the
      // server verifies against the tenant's live data; there is no longer a
      // small closed category/tax-class vocabulary to exhaustively cross with
      // document type, so one representative declared coordinate per
      // direction is what this normalizer-level test can meaningfully cover.
      const line = customer
        ? { account_code: "200", tax_type: "OUTPUTY24" }
        : { account_code: "453", tax_type: "INPUTY24" };
      const common = {
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        currency: "SGD",
        contact: { name: customer ? "Exact Customer" : "Exact Supplier" },
        lines: [{
          description: "Source line",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
          ...line,
        }],
        declared_net: "100.00",
        declared_tax: "9.00",
        declared_gross: "109.00",
        document_validity: "TEST_OR_NOT_VALID" as const,
      };
      const original = {
        ...common,
        document_type: customer ? "CUSTOMER_INVOICE" as const : "SUPPLIER_BILL" as const,
        reference: originalReference,
        document_date: "2026-07-01",
        due_date: "2026-07-15",
      };
      const subject = {
        ...common,
        document_type: documentType,
        reference: `REF-${checked + 1}`,
        document_date: "2026-07-20",
        ...(credit ? {
          original_document: {
            reference: originalReference,
            reference_kind: "FORMAL_DOCUMENT_NUMBER",
            document_date: "2026-07-01",
          },
        } : { due_date: "2026-08-20" }),
      };
      const parsed = xeroAccountingCaseBusinessIntakeSchema.parse({
        case_id: `case-${documentType}`.toLowerCase(),
        expected_version: 0,
        source_label: "Bounded submitted source set",
        source_set_complete: true,
        documents: credit ? [original, subject] : [subject],
      });
      const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
      expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
      if (credit) {
        const originalFact = normalized.facts.find((fact) =>
          fact.kind === "EVIDENCE" && fact.evidenceRole === "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT");
        const creditFact = normalized.facts.find((fact) =>
          fact.kind === "NATIVE_DOCUMENT" && fact.reference === subject.reference);
        expect(originalFact?.kind).toBe("EVIDENCE");
        expect(creditFact?.kind).toBe("NATIVE_DOCUMENT");
        if (originalFact?.kind === "EVIDENCE" && creditFact?.kind === "NATIVE_DOCUMENT") {
          expect(creditFact.originalDocumentEventKey).toBe(originalFact.eventKey);
          expect(originalFact).not.toHaveProperty("amount");
        }
      }
      checked += 1;
    }
    expect(checked).toBe(XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES.length);
  });

  it("derives stable internal identities and rejects zero declared net or gross at intake", () => {
    const input = {
      case_id: "case-intake-deterministic-001",
      expected_version: 0,
      source_label: "One submitted customer invoice",
      source_set_complete: true as const,
      documents: [{
        document_type: "CUSTOMER_INVOICE" as const,
        reference: "INV-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        document_date: "2026-07-20",
        due_date: "2026-08-20",
        currency: "SGD",
        contact: { name: "Exact Customer" },
        lines: [{
          description: "Consulting service",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
          account_code: "200",
          tax_type: "OUTPUTY24",
        }],
        declared_net: "100.00",
        declared_tax: "9.00",
        declared_gross: "109.00",
        document_validity: "TEST_OR_NOT_VALID" as const,
      }],
    };
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse(input);
    expect(normalizeXeroAccountingCaseBusinessIntake(parsed))
      .toEqual(normalizeXeroAccountingCaseBusinessIntake(parsed));
    const continuation = xeroAccountingCaseBusinessIntakeSchema.parse({
      ...input,
      expected_version: 1,
      continuation_token: `acc_${"a".repeat(64)}`,
    });
    expect(normalizeXeroAccountingCaseBusinessIntake(continuation)).toMatchObject({
      expected_version: 1,
      continuation_token: `acc_${"a".repeat(64)}`,
    });
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      expected_version: 1,
      continuation_token: "acc_caller_constructed",
    }).success).toBe(false);
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      documents: [{ ...input.documents[0], declared_net: "0" }],
    }).success).toBe(false);
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      documents: [{ ...input.documents[0], declared_gross: "0.00" }],
    }).success).toBe(false);
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      documents: [{ ...input.documents[0], invoice_exchange_rate: "0" }],
    }).success).toBe(false);
    // A mandatory per-line ledger declaration cannot be omitted (the released
    // equivalent of the retired transition_review_required omission check).
    const missingTaxType = structuredClone(input);
    delete (missingTaxType.documents[0]!.lines[0] as Partial<{ tax_type: string }>).tax_type;
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse(missingTaxType).success).toBe(false);
    const { reference_kind: _referenceKind, ...withoutReferenceKind } = input.documents[0];
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      documents: [withoutReferenceKind],
    }).success).toBe(false);
  });

  it("projects typed durable contact identities without inferring namespaces from bare numbers", () => {
    const base = {
      case_id: "case-contact-identity-intake",
      expected_version: 0,
      source_label: "Contact identity source",
      source_set_complete: true as const,
      documents: [{
        document_type: "SUPPLIER_BILL" as const,
        reference: "BILL-IDENTITY-1",
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        document_date: "2026-07-20",
        due_date: "2026-08-20",
        currency: "SGD",
        contact: {
          name: "US Supplier",
          company_number: "123",
          durable_identity: {
            kind: "LEGAL_REGISTRY" as const,
            jurisdiction: "US",
            registry_scheme: "IRS_EIN",
            number: "123",
          },
        },
        lines: [{
          description: "Source line",
          quantity: "1",
          unit_amount_excluding_tax: "10.00",
          source_tax_amount: "0.00",
          account_code: "453",
          tax_type: "NONE",
        }],
        declared_net: "10.00",
        declared_tax: "0.00",
        declared_gross: "10.00",
        document_validity: "TEST_OR_NOT_VALID" as const,
      }],
      new_contacts: [{
        usage_roles: ["SUPPLIER"] as const,
        contact: {
          name: "US Supplier",
          company_number: "123",
          durable_identity: {
            kind: "LEGAL_REGISTRY" as const,
            jurisdiction: "US",
            registry_scheme: "IRS_EIN",
            number: "123",
          },
        },
      }],
    };
    const normalized = normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(base),
    );
    expect(normalized.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "CONTACT_CANDIDATE",
        durableIdentity: {
          kind: "LEGAL_REGISTRY",
          jurisdiction: "US",
          registryScheme: "IRS_EIN",
          number: "123",
        },
      }),
      expect.objectContaining({
        kind: "NATIVE_DOCUMENT",
        contactDurableIdentity: {
          kind: "LEGAL_REGISTRY",
          jurisdiction: "US",
          registryScheme: "IRS_EIN",
          number: "123",
        },
      }),
    ]));
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...base,
      new_contacts: [{
        ...base.new_contacts[0],
        contact: { ...base.new_contacts[0].contact, company_number: "DIFFERENT" },
      }],
    }).success).toBe(false);
  });

  it("accepts a credit-only ordinary original coordinate but rejects ambiguous submitted support", () => {
    const original = {
      document_type: "CUSTOMER_INVOICE" as const,
      reference: "INV-ORIGINAL-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
      document_date: "2026-07-01",
      due_date: "2026-07-15",
      currency: "SGD",
      contact: { name: "Exact Customer" },
      lines: [{
        description: "Original service",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
        account_code: "200",
        tax_type: "OUTPUTY24",
      }],
      declared_net: "100.00",
      declared_tax: "9.00",
      declared_gross: "109.00",
      document_validity: "TEST_OR_NOT_VALID" as const,
    };
    const credit = {
      ...original,
      document_type: "CUSTOMER_CREDIT_NOTE" as const,
      reference: "CN-001",
      document_date: "2026-07-20",
      due_date: undefined,
      original_document: {
        reference: original.reference,
        reference_kind: original.reference_kind,
        document_date: original.document_date,
      },
    };
    const base = {
      case_id: "case-credit-linkage-001",
      expected_version: 0,
      source_label: "Credit linkage source set",
      source_set_complete: true as const,
    };
    const creditOnly = xeroAccountingCaseBusinessIntakeSchema.parse({ ...base, documents: [credit] });
    const normalizedCreditOnly = normalizeXeroAccountingCaseBusinessIntake(creditOnly);
    expect(normalizedCreditOnly.facts).toEqual([
      expect.objectContaining({
        kind: "NATIVE_DOCUMENT",
        documentKind: "CREDIT_NOTE",
        originalDocumentReference: "INV-ORIGINAL-001",
        originalDocumentReferenceKind: "FORMAL_DOCUMENT_NUMBER",
      }),
    ]);
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...base,
      documents: [original, { ...original }, credit],
    }).success).toBe(false);
  });

  it("normalizes the maximum document and new-contact cardinalities without crossing internal source-unit limits", () => {
    const documents = Array.from({ length: 256 }, (_, index) => ({
      document_type: "CUSTOMER_INVOICE" as const,
      reference: `INV-MAX-${index + 1}`,
      reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
      document_date: "2026-07-20",
      due_date: "2026-08-20",
      currency: "SGD",
      contact: { name: `Existing Customer ${index + 1}` },
      lines: [{
        description: "Source line",
        quantity: "1",
        unit_amount_excluding_tax: "1.00",
        source_tax_amount: "0.00",
        account_code: "200",
        tax_type: "NONE",
      }],
      declared_net: "1.00",
      declared_tax: "0.00",
      declared_gross: "1.00",
      document_validity: "TEST_OR_NOT_VALID" as const,
    }));
    const newContacts = Array.from({ length: 100 }, (_, index) => ({
      usage_roles: ["CUSTOMER"] as const,
      contact: { name: `New Customer ${index + 1}` },
    }));
    const parsed = xeroAccountingCaseBusinessIntakeSchema.parse({
      case_id: "case-intake-maximum-cardinality",
      expected_version: 0,
      source_label: "Maximum bounded submitted set",
      source_set_complete: true,
      documents,
      new_contacts: newContacts,
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(parsed);
    expect(() => prepareAccountingCasePublicSchema.parse(normalized)).not.toThrow();
    expect(normalized.sources).toHaveLength(2);
    expect(normalized.sources.map((source) => source.units.length).sort((left, right) => left - right))
      .toEqual([100, 256]);
    expect(normalized.facts).toHaveLength(356);
  });

  it("keeps same-Case originals evidence-only until server history injects exact original evidence", () => {
    const { normalized, compiled } = compileBusinessFixture(
      "../harness/fixtures/xero/accounting-case-business-documents.v1.json",
    );

    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.events).toHaveLength(5);
    expect(compiled.operations.map((operation) => operation.actionId)).toEqual(["supplier_bill.create_draft"]);
    expect(normalized.facts.filter((fact) =>
      fact.kind === "EVIDENCE" && fact.evidenceRole === "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT"))
      .toHaveLength(2);
    expect(compiled.events.filter((event) => event.disposition === "EVIDENCE_ONLY")).toHaveLength(2);
    expect(compiled.events.filter((event) => event.disposition === "BLOCKED_VALIDATION")).toHaveLength(2);
  });

  // ADR-002: the MCP holds no jurisdiction rate-period table any more, so
  // transition-review.json is no longer a rejection fixture -- it is now an
  // ordinary, eligible document carrying only a decision-inert review_note.
  it("compiles the historic transition-review fixture as an ordinary eligible document", () => {
    const { compiled } = compileBusinessFixture(
      "../harness/remote-agents/fixtures/v040rc-negative/transition-review.json",
    );
    expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(compiled.operations.map((operation) => operation.actionId)).toEqual(["customer_invoice.create_draft"]);
    expect(compiled.events.flatMap((event) => event.reasonCodes))
      .not.toContain("SG_GST_TRANSITION_REVIEW_REQUIRED");
  });

  it("pins current public negative fixtures through the production normalizer and compiler", () => {
    const cases = [
      {
        fixture: "wrong-amount.json",
        events: [{
          disposition: "BLOCKED_VALIDATION",
          reasonCodes: ["SOURCE_GROSS_MISMATCH", "SOURCE_NET_PLUS_TAX_MISMATCH"],
        }],
        actions: [],
      },
      {
        fixture: "tax-mismatch.json",
        events: [{
          disposition: "BLOCKED_VALIDATION",
          reasonCodes: ["SOURCE_GROSS_MISMATCH", "SOURCE_LINE_TAX_MISMATCH", "SOURCE_TAX_MISMATCH"],
        }],
        actions: [],
      },
      {
        fixture: "unsupported-route.json",
        events: [
          {
            disposition: "BLOCKED_VALIDATION",
            reasonCodes: [
              "CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED",
              "CREDIT_ORIGINAL_TRANSACTION_EVIDENCE_REQUIRED",
              "CREDIT_ORIGINAL_TRANSACTION_NOT_FOUND",
              "FOREIGN_CREDIT_NOTE_UNSUPPORTED",
            ],
          },
          { disposition: "EVIDENCE_ONLY", reasonCodes: [] },
        ],
        actions: [],
      },
    ] as const;

    for (const testCase of cases) {
      const { compiled } = compileBusinessFixture(
        `../harness/remote-agents/fixtures/v040rc-negative/${testCase.fixture}`,
      );
      expect(compiled.status, testCase.fixture).toBe("BLOCKED_VALIDATION");
      expect(
        compiled.events
          .map(({ disposition, reasonCodes }) => ({ disposition, reasonCodes }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        testCase.fixture,
      ).toEqual(
        [...testCase.events].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      );
      expect(compiled.operations.map((operation) => operation.actionId), testCase.fixture)
        .toEqual([...testCase.actions]);
    }
  });
});
