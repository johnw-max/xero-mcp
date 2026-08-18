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
import {
  createXeroSingaporeAccountingPolicy,
  XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS,
  XERO_SINGAPORE_TAX_CLASS_KEYS,
} from "../src/policy/xeroSingaporeAccountingPolicy.js";
import { testXeroTenantCoaBinding } from "./helpers/xeroTenantCoaProfile.js";

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
      tenantId: "11111111-1111-4111-8111-111111111111",
      environment: "TEST",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      organisationStatus: "ACTIVE",
    },
    sources: normalized.sources,
    facts: normalized.facts,
  }, createXeroSingaporeAccountingPolicy({ paysTax: true }), createXeroAccountingCaseProviderContract(
    bindings,
    testXeroTenantCoaBinding(),
  ));
  return { normalized, compiled };
}

describe("Xero Accounting Case business intake", () => {
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
        tenantId: "11111111-1111-4111-8111-111111111111",
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        organisationStatus: "ACTIVE",
      },
      sources: normalized.sources,
      facts: normalized.facts,
    }, createXeroSingaporeAccountingPolicy({ paysTax: true }), createXeroAccountingCaseProviderContract(
      new Map(),
      testXeroTenantCoaBinding(),
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

  it("uses a real mode-discriminated contract and round-trips PER_LINE continuation without document placeholders", () => {
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
        line_accounting_mode: "PER_LINE" as const,
        transition_review_required: false,
        lines: [{
          description: "Office supplies",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
          accounting_category: "OFFICE_SUPPLIES" as const,
          tax_class: "SG_STANDARD_RATED" as const,
          effective_tax_rate_percent: "9.00",
        }, {
          description: "Cloud subscription",
          quantity: "1",
          unit_amount_excluding_tax: "50.00",
          source_tax_amount: "0.00",
          accounting_category: "CLOUD_SUBSCRIPTIONS" as const,
          tax_class: "NO_TAX" as const,
          effective_tax_rate_percent: "0",
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
      lineAccountingMode: "PER_LINE",
      lines: [
        { accountingCategory: "OFFICE_SUPPLIES", taxClass: "SG_STANDARD_RATED", effectiveTaxRateBps: 900 },
        { accountingCategory: "CLOUD_SUBSCRIPTIONS", taxClass: "NO_TAX", effectiveTaxRateBps: 0 },
      ],
    });
    const continuation = accountingCaseBusinessContinuationTemplate({
      caseId: normalized.case_id,
      expectedVersion: 1,
      sources: normalized.sources,
      facts: normalized.facts,
    });
    expect(continuation.documents[0]).toMatchObject({
      line_accounting_mode: "PER_LINE",
      lines: [
        expect.objectContaining({ accounting_category: "OFFICE_SUPPLIES" }),
        expect.objectContaining({ accounting_category: "CLOUD_SUBSCRIPTIONS" }),
      ],
    });
    expect(continuation.documents[0]).not.toHaveProperty("accounting_category");
    expect(() => xeroAccountingCaseBusinessIntakeSchema.parse(continuation)).not.toThrow();

    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...perLine,
      documents: [{ ...perLine.documents[0], accounting_category: "OFFICE_SUPPLIES" }],
    }).success).toBe(false);
    const missingLineCategory = structuredClone(perLine);
    delete (missingLineCategory.documents[0]!.lines[0] as Partial<{
      accounting_category: string;
    }>).accounting_category;
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse(missingLineCategory).success).toBe(false);
  });

  it("normalizes every published document/category/tax enum combination into the shared public Case schema", () => {
    let checked = 0;
    for (const documentType of XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES) {
      for (const category of XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS) {
        for (const taxClass of XERO_SINGAPORE_TAX_CLASS_KEYS) {
          const credit = documentType.endsWith("CREDIT_NOTE");
          const customer = documentType.startsWith("CUSTOMER_");
          const standard = taxClass === "SG_STANDARD_RATED";
          const originalReference = `ORIGINAL-${checked + 1}`;
          const common = {
            reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
            currency: "SGD",
            contact: { name: customer ? "Exact Customer" : "Exact Supplier" },
            line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
            accounting_category: category,
            tax_class: taxClass,
            effective_tax_rate_percent: standard ? "9.00" : "0.00",
            ...(taxClass === "EXEMPT" && customer ? { exempt_classification: "REGULATION_33" } : {}),
            transition_review_required: false,
            lines: [{
              description: "Source line",
              quantity: "1",
              unit_amount_excluding_tax: "100.00",
              source_tax_amount: standard ? "9.00" : "0.00",
            }],
            declared_net: "100.00",
            declared_tax: standard ? "9.00" : "0.00",
            declared_gross: standard ? "109.00" : "100.00",
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
            case_id: `case-${documentType}-${category}-${taxClass}`.toLowerCase(),
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
      }
    }
    expect(checked).toBe(
      XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES.length *
      XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS.length *
      XERO_SINGAPORE_TAX_CLASS_KEYS.length,
    );
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
        line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
        accounting_category: "CONSULTING_REVENUE" as const,
        tax_class: "SG_STANDARD_RATED" as const,
        effective_tax_rate_percent: "9.00",
        transition_review_required: false,
        lines: [{
          description: "Consulting service",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
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
    const { transition_review_required: _transition, ...withoutTransitionReview } = input.documents[0];
    expect(xeroAccountingCaseBusinessIntakeSchema.safeParse({
      ...input,
      documents: [withoutTransitionReview],
    }).success).toBe(false);
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
        line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
        accounting_category: "OFFICE_SUPPLIES" as const,
        tax_class: "NO_TAX" as const,
        effective_tax_rate_percent: "0",
        transition_review_required: false,
        lines: [{
          description: "Source line",
          quantity: "1",
          unit_amount_excluding_tax: "10.00",
          source_tax_amount: "0.00",
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
      line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
      accounting_category: "CONSULTING_REVENUE" as const,
      tax_class: "SG_STANDARD_RATED" as const,
      effective_tax_rate_percent: "9.00",
      transition_review_required: false,
      lines: [{
        description: "Original service",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
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
      line_accounting_mode: "DOCUMENT_DEFAULT_FOR_ALL_LINES" as const,
      accounting_category: "CONSULTING_REVENUE" as const,
      tax_class: "NO_TAX" as const,
      effective_tax_rate_percent: "0",
      transition_review_required: false,
      lines: [{
        description: "Source line",
        quantity: "1",
        unit_amount_excluding_tax: "1.00",
        source_tax_amount: "0.00",
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
        fixture: "transition-review.json",
        events: [{
          disposition: "BLOCKED_VALIDATION",
          reasonCodes: ["SG_GST_TRANSITION_REVIEW_REQUIRED"],
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
