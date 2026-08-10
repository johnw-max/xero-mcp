import { describe, expect, it } from "vitest";
import {
  authoriseSupplierBillSchema,
  createDraftSupplierBillSchema,
  getContactSchema,
  listContactsSchema,
  getInvoiceSchema,
  getSupplierBillSchema,
  listCreditNotesSchema,
  listInvoicesSchema,
  listPaymentsSchema,
  prepareSupplierBillDraftSchema,
  searchContactsSchema,
} from "../src/domain/schemas.js";

const validDraft = {
  request_id: "request-create-a",
  source_ref: "synthetic://invoice-a",
  source_sha256: "1".repeat(64),
  source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
  user_confirmation: "CONFIRMED_FOR_DRAFT",
  contact_id: "22222222-2222-4222-8222-222222222222",
  invoice_date: "2026-08-03",
  due_date: "2026-08-17",
  currency: "SGD",
  reference: "ZC-XERO-DEMO-QA",
  line_amount_type: "Inclusive",
  lines: [
    {
      description: "Synthetic software subscription",
      quantity: 1,
      unit_amount: 109,
      account_code: "404",
      tax_type: "NONE",
    },
  ],
};

describe("strict accounting tool schemas", () => {
  it("lists active contacts with safe bounded defaults without requiring a search query", () => {
    expect(listContactsSchema.parse({})).toEqual({
      status: "ACTIVE",
      page: 1,
      limit: 25,
    });
  });

  it("accepts reviewed contact filters and rejects caller-controlled Xero query fields", () => {
    expect(listContactsSchema.parse({
      status: "ARCHIVED",
      is_supplier: true,
      is_customer: false,
      page: 1_000,
      limit: 100,
    })).toEqual({
      status: "ARCHIVED",
      is_supplier: true,
      is_customer: false,
      page: 1_000,
      limit: 100,
    });

    for (const input of [
      { tenant_id: "tenant-b" },
      { where: 'IsSupplier==true' },
      { query: "Acme" },
      { page: 1_001 },
      { limit: 101 },
    ]) {
      expect(listContactsSchema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts only an exact ContactID for a contact read", () => {
    const contact_id = "22222222-2222-4222-8222-222222222222";
    expect(getContactSchema.parse({ contact_id })).toEqual({ contact_id });
    expect(getContactSchema.safeParse({ contact_id: "not-a-uuid" }).success).toBe(false);
    expect(getContactSchema.safeParse({ contact_id, tenant_id: "tenant-b" }).success).toBe(false);
  });

  it("lets preparation report missing fields as blockers but rejects caller-controlled routing", () => {
    expect(prepareSupplierBillDraftSchema.safeParse({ supplier_name: "Acme", lines: [{}] }).success).toBe(true);
    expect(prepareSupplierBillDraftSchema.safeParse({
      supplier_name: "Acme",
      tenant_id: "caller-controlled",
    }).success).toBe(false);
  });

  it("accepts bounded invoice history filters and applies safe pagination defaults", () => {
    const parsed = listInvoicesSchema.parse({
      type: "ACCREC",
      contact_id: "33333333-3333-4333-8333-333333333333",
      statuses: ["AUTHORISED", "PAID"],
      date_from: "2026-01-01",
      date_to: "2026-08-05",
      search_term: "customer reference",
    });

    expect(parsed).toMatchObject({
      type: "ACCREC",
      page: 1,
      page_size: 50,
      include_archived: false,
      order: "DATE_DESC",
    });
  });

  it("accepts exact ACCPAY and ACCREC invoice reads", () => {
    for (const type of ["ACCPAY", "ACCREC"] as const) {
      expect(getInvoiceSchema.safeParse({
        invoice_id: "11111111-1111-4111-8111-111111111111",
        type,
      }).success).toBe(true);
    }
  });

  it("rejects raw Xero query, routing, and header controls from invoice list input", () => {
    for (const extra of [
      { where: 'Type=="ACCREC"' },
      { headers: { "xero-tenant-id": "tenant-b" } },
      { tenant_id: "tenant-b" },
      { xero_tenant_id: "tenant-b" },
      { order: "Total DESC" },
    ]) {
      expect(listInvoicesSchema.safeParse({ ...extra }).success).toBe(false);
    }
  });

  it("rejects unbounded or ambiguous invoice history filters", () => {
    expect(listInvoicesSchema.safeParse({ page_size: 101 }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ statuses: [] }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ statuses: ["PAID", "PAID"] }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ date_from: "2026-08-06", date_to: "2026-08-05" }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ type: "ACCRECCREDIT" }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ order: "DUE_DATE_DESC" }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ page: 1_001, page_size: 100 }).success).toBe(false);
    expect(listInvoicesSchema.safeParse({ page: 1_000, page_size: 100 }).success).toBe(true);
  });

  it("keeps credit-note and payment history inputs bounded and routing-free", () => {
    const contactId = "33333333-3333-4333-8333-333333333333";
    expect(listCreditNotesSchema.parse({
      contact_id: contactId,
      type: "ACCPAYCREDIT",
      status: "PAID",
      date_from: "2026-01-01",
      date_to: "2026-08-05",
    })).toMatchObject({ page: 1, page_size: 50 });
    expect(listPaymentsSchema.parse({
      contact_id: contactId,
      type: "ACCPAYPAYMENT",
      status: "AUTHORISED",
    })).toMatchObject({ page: 1, page_size: 50 });

    for (const schema of [listCreditNotesSchema, listPaymentsSchema]) {
      expect(schema.safeParse({ page_size: 101 }).success).toBe(false);
      expect(schema.safeParse({ date_from: "2026-08-06", date_to: "2026-08-05" }).success).toBe(false);
      expect(schema.safeParse({ tenant_id: "tenant-b" }).success).toBe(false);
      expect(schema.safeParse({ where: 'Status=="PAID"' }).success).toBe(false);
      expect(schema.safeParse({ endpoint: "/Payments" }).success).toBe(false);
    }
    expect(listPaymentsSchema.safeParse({ contact_id: contactId }).success).toBe(false);
  });

  it("keeps legacy contact-search input compatible by defaulting to the first page", () => {
    expect(searchContactsSchema.parse({ query: "Acme", limit: 10 })).toEqual({
      query: "Acme",
      limit: 10,
      page: 1,
    });
  });

  it("accepts only safely bounded positive contact-search page numbers", () => {
    expect(searchContactsSchema.safeParse({ query: "Acme", page: 1_000 }).success).toBe(true);
    expect(searchContactsSchema.safeParse({ query: "Acme", page: 0 }).success).toBe(false);
    expect(searchContactsSchema.safeParse({ query: "Acme", page: 1_001 }).success).toBe(false);
  });

  it("accepts a bounded four-decimal supplier bill", () => {
    expect(createDraftSupplierBillSchema.safeParse(validDraft).success).toBe(true);
    expect(
      createDraftSupplierBillSchema.safeParse({
        ...validDraft,
        lines: [{ ...validDraft.lines[0], quantity: 1.1234, unit_amount: 109.9876 }],
      }).success,
    ).toBe(true);
  });

  it("requires an explicit source evidence type and user confirmation for draft creation", () => {
    const { source_evidence_type: _sourceEvidenceType, ...withoutEvidenceType } = validDraft;
    const { user_confirmation: _userConfirmation, ...withoutConfirmation } = validDraft;

    expect(createDraftSupplierBillSchema.safeParse(withoutEvidenceType).success).toBe(false);
    expect(createDraftSupplierBillSchema.safeParse(withoutConfirmation).success).toBe(false);
    expect(createDraftSupplierBillSchema.safeParse({
      ...validDraft,
      source_evidence_type: "HOST_SIGNED_FILE_RECEIPT",
    }).success).toBe(false);
    expect(createDraftSupplierBillSchema.safeParse({
      ...validDraft,
      user_confirmation: "yes",
    }).success).toBe(false);
  });

  it.each([
    ["quantity", { quantity: 1.12345 }],
    ["unit amount", { unit_amount: 109.98765 }],
  ])("rejects more than four decimal places for %s", (_label, lineMutation) => {
    const parsed = createDraftSupplierBillSchema.safeParse({
      ...validDraft,
      lines: [{ ...validDraft.lines[0], ...lineMutation }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown tenant/provider/header fields instead of allowing caller-controlled routing", () => {
    for (const extra of [
      { tenant_id: "tenant-b" },
      { xero_tenant_id: "tenant-b" },
      { provider_url: "https://evil.invalid" },
      { provider_headers: { "xero-tenant-id": "tenant-b" } },
    ]) {
      expect(createDraftSupplierBillSchema.safeParse({ ...validDraft, ...extra }).success).toBe(false);
    }
  });

  it("requires exact UUID and raw 64-character approved payload hash formats", () => {
    expect(getSupplierBillSchema.safeParse({ invoice_id: "not-a-uuid" }).success).toBe(false);
    expect(
      authoriseSupplierBillSchema.safeParse({
        posting_request_id: "pr_abcdefghijklmnop",
        invoice_id: "11111111-1111-4111-8111-111111111111",
        expected_status: "DRAFT",
        approval_ref: "a".repeat(32),
        approved_payload_hash: "b".repeat(64),
        request_id: "request-authorise-a",
      }).success,
    ).toBe(true);
    expect(
      authoriseSupplierBillSchema.safeParse({
        posting_request_id: "pr_abcdefghijklmnop",
        invoice_id: "11111111-1111-4111-8111-111111111111",
        expected_status: "DRAFT",
        approval_ref: "a".repeat(32),
        approved_payload_hash: `sha256:${"b".repeat(64)}`,
        request_id: "request-authorise-a",
      }).success,
    ).toBe(false);
  });
});
