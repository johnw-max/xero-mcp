import { describe, expect, it } from "vitest";
import {
  contactCreateSchema,
  contactUpdateSchema,
  itemCreateSchema,
  itemUpdateSchema,
  prepareContactCreate,
  prepareContactUpdate,
  prepareItemCreate,
  prepareItemUpdate,
  verifyContactCurrentVersion,
  verifyItemCurrentVersion,
} from "../src/domain/xeroContactItemPrimitives.js";
import {
  mapContactCreateToXero,
  mapContactUpdateToXero,
  mapItemCreateToXero,
  mapItemUpdateToXero,
  mapSafeItemReadback,
  mapSafeContactReadback,
  verifyContactReadback,
  verifyItemReadback,
} from "../src/providers/xeroContactItemMapper.js";
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

describe("safe Xero contact primitives", () => {
  it("prepares only reviewed contact fields and a server-owned external reference", () => {
    const input = {
      name: "  Northwind   Limited  ",
      first_name: "Alice",
      last_name: "Ng",
      email: "ACCOUNTS@Northwind.example",
      company_number: "  HK 12345 ",
      account_number: " CUST-42 ",
      phones: [{ phone_type: "OFFICE", phone_number: "5550100", country_code: "852" }],
      addresses: [{
        address_type: "STREET",
        line_1: "1 Finance Street",
        city: "Hong Kong",
        country: "Hong Kong",
      }],
    };

    expect(contactCreateSchema.safeParse(input).success).toBe(true);
    const prepared = prepareContactCreate(input, {
      externalKey: "crm/customer/42",
      namespace: "acctdemo",
      confirmationToken: "A1B2C3D4E5F60708",
    });

    expect(prepared).toMatchObject({
      objectType: "CONTACT",
      operation: "CREATE",
      normalizedBusinessKey: {
        kind: "COMPANY_NUMBER",
        value: "hk12345",
      },
      confirmationPhrase: "CONFIRM-CONTACT-CREATE-A1B2C3D4E5F60708",
      target: {
        name: "Northwind Limited",
        firstName: "Alice",
        lastName: "Ng",
        email: "accounts@northwind.example",
        companyNumber: "HK 12345",
        accountNumber: "CUST-42",
      },
    });
    expect(prepared.externalReference).toMatch(/^ZC:acctdemo:[a-f0-9]{32}$/);
    expect(prepared.canonicalPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.canonicalPayload).toMatchObject({
      schemaVersion: "xero-contact-safe-v1",
      objectType: "CONTACT",
      operation: "CREATE",
      externalReference: prepared.externalReference,
      target: prepared.target,
    });
  });

  it.each([
    ["raw contact number", { contact_number: "agent-controlled" }],
    ["bank details", { bank_account_details: "123456" }],
    ["tax identity", { tax_number: "TAX-42" }],
    ["payment terms", { payment_terms: { bills: { day: 20 } } }],
    ["default sales account", { sales_default_account_code: "200" }],
    ["default purchases account", { purchases_default_account_code: "400" }],
    ["default currency", { default_currency: "HKD" }],
    ["tracking defaults", { sales_tracking_categories: [] }],
    ["status mutation", { contact_status: "ARCHIVED" }],
    ["merge target", { merged_to_contact_id: "11111111-1111-4111-8111-111111111111" }],
    ["batch payments", { batch_payments: { bankAccountNumber: "1" } }],
  ])("rejects %s rather than forwarding an unreviewed Contact field", (_label, extra) => {
    expect(contactCreateSchema.safeParse({ name: "Northwind", ...extra }).success).toBe(false);
  });

  it("maps a fixed SDK allowlist and verifies a sanitized exact readback", () => {
    const prepared = prepareContactCreate({
      name: "Northwind Limited",
      email: "accounts@northwind.example",
      phones: [{ phone_type: "OFFICE", phone_number: "5550100" }],
      addresses: [{
        address_type: "STREET",
        line_1: "1 Finance Street",
        line_2: "Tower A",
        line_3: "Floor 8",
        line_4: "Suite 801",
      }],
    }, {
      externalKey: "crm/customer/42",
      namespace: "acctdemo",
      confirmationToken: "0011223344556677",
    });

    expect(mapContactCreateToXero(prepared)).toEqual({
      name: "Northwind Limited",
      emailAddress: "accounts@northwind.example",
      contactNumber: prepared.externalReference,
      phones: [{ phoneType: "OFFICE", phoneNumber: "5550100" }],
      addresses: [{
        addressType: "STREET",
        addressLine1: "1 Finance Street",
        addressLine2: "Tower A",
        addressLine3: "Floor 8",
        addressLine4: "Suite 801",
      }],
    });

    const raw = {
      contactID: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      emailAddress: "accounts@northwind.example",
      contactNumber: prepared.externalReference,
      phones: [{ phoneType: "OFFICE", phoneNumber: "5550100" }],
      addresses: [{
        addressType: "STREET",
        addressLine1: "1 Finance Street",
        addressLine2: "Tower A",
        addressLine3: "Floor 8",
        addressLine4: "Suite 801",
      }],
      updatedDateUTC: new Date("2026-08-07T09:00:00.000Z"),
      bankAccountDetails: "must-not-leak",
      taxNumber: "must-not-leak",
      paymentTerms: { bills: { day: 20 } },
      salesDefaultAccountCode: "200",
      validationErrors: [{ message: "provider-internal" }],
    };
    const snapshot = mapSafeContactReadback(raw, { namespace: "acctdemo" });
    expect(snapshot).toEqual({
      contactId: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      email: "accounts@northwind.example",
      externalReference: prepared.externalReference,
      contactNumberEvidence: { kind: "OWNED_NAMESPACE" },
      phones: [{ phoneType: "OFFICE", phoneNumber: "5550100" }],
      addresses: [{
        addressType: "STREET",
        line1: "1 Finance Street",
        line2: "Tower A",
        line3: "Floor 8",
        line4: "Suite 801",
      }],
      updatedAt: "2026-08-07T09:00:00.000Z",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/must-not-leak|provider-internal/);
    expect(verifyContactReadback(prepared, raw, {
      namespace: "acctdemo",
      expectedCreatedId: raw.contactID,
    })).toEqual({
      verified: true,
      snapshot,
      mismatches: [],
    });
    expect(verifyContactReadback(prepared, raw, {
      namespace: "acctdemo",
      expectedCreatedId: "22222222-2222-4222-8222-222222222222",
    })).toMatchObject({
      verified: false,
      mismatches: ["contactId"],
    });
    const unsafeContactVerifier = verifyContactReadback as unknown as (
      primitive: typeof prepared,
      providerReadback: unknown,
      options: { namespace: string },
    ) => { verified: boolean; mismatches: string[] };
    expect(unsafeContactVerifier(prepared, raw, { namespace: "acctdemo" })).toMatchObject({
      verified: false,
      mismatches: ["expectedCreatedId"],
    });
  });

  it("updates an exact contact version while preserving arrays omitted from the patch", () => {
    const existing = {
      contactId: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      email: "old@northwind.example",
      companyNumber: "HK 12345",
      phones: [{ phoneType: "OFFICE" as const, phoneNumber: "5550100" }],
      addresses: [{ addressType: "STREET" as const, line1: "1 Finance Street" }],
      externalReference: "ZC:acctdemo:0123456789abcdef0123456789abcdef",
      contactNumberEvidence: { kind: "OWNED_NAMESPACE" as const },
      updatedAt: "2026-08-07T09:00:00.000Z",
    };
    const input = {
      contact_id: existing.contactId,
      expected_updated_at: existing.updatedAt,
      patch: {
        email: "new@northwind.example",
        account_number: "CUST-42",
      },
    };

    expect(contactUpdateSchema.safeParse(input).success).toBe(true);
    const prepared = prepareContactUpdate(input, existing, {
      confirmationToken: "89ABCDEF01234567",
    });

    expect(prepared).toMatchObject({
      objectType: "CONTACT",
      operation: "UPDATE",
      contactId: existing.contactId,
      expectedUpdatedAt: existing.updatedAt,
      before: existing,
      target: {
        name: "Northwind Limited",
        email: "new@northwind.example",
        companyNumber: "HK 12345",
        accountNumber: "CUST-42",
        phones: existing.phones,
        addresses: existing.addresses,
      },
      diff: [
        { path: "accountNumber", before: null, after: "CUST-42" },
        { path: "email", before: "old@northwind.example", after: "new@northwind.example" },
      ],
      confirmationPhrase: "CONFIRM-CONTACT-UPDATE-89ABCDEF01234567",
    });
    expect(mapContactUpdateToXero(prepared)).toEqual({
      contactID: existing.contactId,
      emailAddress: "new@northwind.example",
      accountNumber: "CUST-42",
    });
    expect(mapContactUpdateToXero(prepared)).not.toHaveProperty("phones");
    expect(mapContactUpdateToXero(prepared)).not.toHaveProperty("addresses");
    expect(mapContactUpdateToXero(prepared)).not.toHaveProperty("contactNumber");

    const rawReadback = {
      contactID: existing.contactId,
      name: "Northwind Limited",
      emailAddress: "new@northwind.example",
      companyNumber: "HK 12345",
      accountNumber: "CUST-42",
      contactNumber: existing.externalReference,
      phones: [{ phoneType: "OFFICE", phoneNumber: "5550100" }],
      addresses: [{ addressType: "STREET", addressLine1: "1 Finance Street" }],
      updatedDateUTC: "2026-08-07T09:05:00.000Z",
    };
    expect(verifyContactReadback(prepared, rawReadback, { namespace: "acctdemo" })).toMatchObject({
      verified: true,
      mismatches: [],
      snapshot: { contactId: existing.contactId, updatedAt: "2026-08-07T09:05:00.000Z" },
    });
  });

  it("fails closed on stale, mismatched, no-op, or unreviewed contact updates", () => {
    const existing = {
      contactId: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      phones: [{ phoneType: "OFFICE" as const, phoneNumber: "5550100" }],
      contactNumberEvidence: { kind: "ABSENT" as const },
      updatedAt: "2026-08-07T09:00:00.000Z",
    };
    const base = {
      contact_id: existing.contactId,
      expected_updated_at: existing.updatedAt,
      patch: { name: "Northwind Limited (HK)" },
    };

    expect(() => prepareContactUpdate({ ...base, expected_updated_at: "2026-08-07T08:59:00.000Z" }, existing))
      .toThrow(/changed after it was reviewed/);
    expect(() => prepareContactUpdate({ ...base, contact_id: "22222222-2222-4222-8222-222222222222" }, existing))
      .toThrow(/ContactID does not match/);
    expect(() => prepareContactUpdate({ ...base, patch: { name: existing.name } }, existing))
      .toThrow(/does not change/);
    expect(contactUpdateSchema.safeParse({ ...base, patch: { tax_number: "TAX-42" } }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ ...base, patch: { contact_number: "raw" } }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ ...base, patch: { contact_status: "ARCHIVED" } }).success).toBe(false);

    expect(contactUpdateSchema.safeParse({ ...base, patch: { phones: [] } }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({
      ...base,
      patch: {
        phones: [
          { phone_type: "MOBILE", phone_number: "1" },
          { phone_type: "MOBILE", phone_number: "2" },
        ],
      },
    }).success).toBe(false);
  });

  it("merges a submitted phone type and exposes a fresh-GET version guard for execution", () => {
    const existing = {
      contactId: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      phones: [{ phoneType: "OFFICE" as const, phoneNumber: "5550100" }],
      addresses: [{ addressType: "STREET" as const, line1: "1 Finance Street" }],
      contactNumberEvidence: { kind: "ABSENT" as const },
      updatedAt: "2026-08-07T09:00:00.000Z",
    };
    const prepared = prepareContactUpdate({
      contact_id: existing.contactId,
      expected_updated_at: existing.updatedAt,
      patch: { phones: [{ phone_type: "MOBILE", phone_number: "5550199" }] },
    }, existing, { confirmationToken: "0123456789ABCDEF" });

    expect(prepared.target).toMatchObject({
      phones: [
        { phoneType: "MOBILE", phoneNumber: "5550199" },
        { phoneType: "OFFICE", phoneNumber: "5550100" },
      ],
      addresses: existing.addresses,
    });
    expect(mapContactUpdateToXero(prepared)).toEqual({
      contactID: existing.contactId,
      phones: [
        { phoneType: "MOBILE", phoneNumber: "5550199" },
        { phoneType: "OFFICE", phoneNumber: "5550100" },
      ],
    });
    expect(mapContactUpdateToXero(prepared)).not.toHaveProperty("addresses");
    expect(verifyContactCurrentVersion(prepared, existing)).toEqual({ verified: true, mismatches: [] });
    expect(verifyContactCurrentVersion(prepared, {
      ...existing,
      updatedAt: "2026-08-07T09:00:01.000Z",
    })).toEqual({ verified: false, mismatches: ["UPDATED_AT"] });
    expect(verifyContactCurrentVersion(prepared, {
      ...existing,
      name: "Changed without a timestamp bump",
    })).toEqual({ verified: false, mismatches: ["CONTENT"] });

    const addressPrepared = prepareContactUpdate({
      contact_id: existing.contactId,
      expected_updated_at: existing.updatedAt,
      patch: { addresses: [{ address_type: "POBOX", line_1: "PO Box 42" }] },
    }, existing, { confirmationToken: "1122334455667788" });
    expect(mapContactUpdateToXero(addressPrepared)).toEqual({
      contactID: existing.contactId,
      addresses: [
        { addressType: "POBOX", addressLine1: "PO Box 42" },
        { addressType: "STREET", addressLine1: "1 Finance Street" },
      ],
    });
  });

  it("merges reviewed subfields into the same phone and address types without erasing omitted fields", () => {
    const existing = {
      contactId: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      phones: [{
        phoneType: "OFFICE" as const,
        phoneNumber: "5550100",
        areaCode: "2",
        countryCode: "852",
      }],
      addresses: [{
        addressType: "STREET" as const,
        line1: "1 Finance Street",
        city: "Hong Kong",
        country: "Hong Kong",
        attentionTo: "Accounts Payable",
      }],
      contactNumberEvidence: { kind: "ABSENT" as const },
      updatedAt: "2026-08-07T09:00:00.000Z",
    };
    const prepared = prepareContactUpdate({
      contact_id: existing.contactId,
      expected_updated_at: existing.updatedAt,
      patch: {
        phones: [{ phone_type: "OFFICE", phone_number: "5550199" }],
        addresses: [{ address_type: "STREET", line_1: "2 Finance Street" }],
      },
    }, existing, { confirmationToken: "A1A2A3A4A5A6A7A8" });

    expect(prepared.target).toMatchObject({
      phones: [{
        phoneType: "OFFICE",
        phoneNumber: "5550199",
        areaCode: "2",
        countryCode: "852",
      }],
      addresses: [{
        addressType: "STREET",
        line1: "2 Finance Street",
        city: "Hong Kong",
        country: "Hong Kong",
        attentionTo: "Accounts Payable",
      }],
    });
    expect(mapContactUpdateToXero(prepared)).toEqual({
      contactID: existing.contactId,
      phones: [{
        phoneType: "OFFICE",
        phoneNumber: "5550199",
        phoneAreaCode: "2",
        phoneCountryCode: "852",
      }],
      addresses: [{
        addressType: "STREET",
        addressLine1: "2 Finance Street",
        city: "Hong Kong",
        country: "Hong Kong",
        attentionTo: "Accounts Payable",
      }],
    });
  });

  it("proves preservation of a non-owned ContactNumber without exposing or overwriting it", () => {
    const rawExisting = {
      contactID: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      emailAddress: "old@northwind.example",
      contactNumber: "ERP-CONTACT-7788",
      phones: [],
      addresses: [],
      updatedDateUTC: "2026-08-07T09:00:00.000Z",
    };
    const existing = mapSafeContactReadback(rawExisting, { namespace: "acctdemo" });
    expect(existing).toMatchObject({
      contactNumberEvidence: {
        kind: "EXTERNAL_FINGERPRINT",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(existing).not.toHaveProperty("externalReference");
    expect(JSON.stringify(existing)).not.toContain("ERP-CONTACT-7788");

    const prepared = prepareContactUpdate({
      contact_id: rawExisting.contactID,
      expected_updated_at: "2026-08-07T09:00:00.000Z",
      patch: { email: "new@northwind.example" },
    }, existing, { confirmationToken: "B1B2B3B4B5B6B7B8" });
    expect(mapContactUpdateToXero(prepared)).toEqual({
      contactID: rawExisting.contactID,
      emailAddress: "new@northwind.example",
    });

    const freshSameVersion = mapSafeContactReadback(rawExisting, { namespace: "acctdemo" });
    const freshChangedContactNumber = mapSafeContactReadback({
      ...rawExisting,
      contactNumber: "ERP-CONTACT-CHANGED",
    }, { namespace: "acctdemo" });
    expect(verifyContactCurrentVersion(prepared, freshSameVersion)).toEqual({ verified: true, mismatches: [] });
    expect(verifyContactCurrentVersion(prepared, freshChangedContactNumber)).toEqual({
      verified: false,
      mismatches: ["CONTENT"],
    });

    const unchangedReadback = {
      ...rawExisting,
      emailAddress: "new@northwind.example",
      updatedDateUTC: "2026-08-07T09:05:00.000Z",
    };
    expect(verifyContactReadback(prepared, unchangedReadback, { namespace: "acctdemo" })).toMatchObject({
      verified: true,
      mismatches: [],
    });
    expect(verifyContactReadback(prepared, {
      ...unchangedReadback,
      contactNumber: "ERP-CONTACT-CHANGED",
    }, { namespace: "acctdemo" })).toMatchObject({
      verified: false,
      mismatches: ["contactNumber"],
    });

    expect(() => prepareContactUpdate({
      contact_id: rawExisting.contactID,
      expected_updated_at: "2026-08-07T09:00:00.000Z",
      patch: { email: "new@northwind.example" },
    }, {
      contactId: rawExisting.contactID,
      name: "Northwind Limited",
      email: "old@northwind.example",
      updatedAt: "2026-08-07T09:00:00.000Z",
    })).toThrow(/contactNumberEvidence/);
  });

  it("rejects incomplete provider projections and reports exact contact readback mismatches", () => {
    const raw = {
      contactID: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Limited",
      phones: [{ phoneType: "SATELLITE", phoneNumber: "1" }],
      updatedDateUTC: "2026-08-07T09:00:00.000Z",
    };
    expect(mapSafeContactReadback(raw, { namespace: "acctdemo" })).toBeUndefined();

    const prepared = prepareContactCreate({ name: "Northwind Limited" }, {
      externalKey: "crm/customer/42",
      namespace: "acctdemo",
      confirmationToken: "8877665544332211",
    });
    expect(verifyContactReadback(prepared, {
      contactID: "11111111-1111-4111-8111-111111111111",
      name: "Northwind Changed",
      contactNumber: prepared.externalReference,
      phones: [],
      addresses: [],
      updatedDateUTC: "2026-08-07T09:00:00.000Z",
    }, {
      namespace: "acctdemo",
      expectedCreatedId: "11111111-1111-4111-8111-111111111111",
    })).toMatchObject({
      verified: false,
      mismatches: ["target.name"],
    });
  });

  it("verifies a real Xero contact readback carrying the default empty phone and address blocks", () => {
    // Xero returns four empty phone blocks and two empty address blocks on every
    // contact, whatever was sent. Test doubles that echo the request never show
    // this, so every contact write was scored WRITE_UNCERTAIN in production while
    // the stored object was exactly correct.
    const providerDefaults = {
      phones: [
        { phoneType: "DDI", phoneNumber: "", phoneAreaCode: "", phoneCountryCode: "" },
        { phoneType: "DEFAULT", phoneNumber: "", phoneAreaCode: "", phoneCountryCode: "" },
        { phoneType: "FAX", phoneNumber: "", phoneAreaCode: "", phoneCountryCode: "" },
        { phoneType: "MOBILE", phoneNumber: "", phoneAreaCode: "", phoneCountryCode: "" },
      ],
      addresses: [
        { addressType: "STREET", city: "", region: "", postalCode: "", country: "" },
        { addressType: "POBOX", city: "", region: "", postalCode: "", country: "" },
      ],
    };
    const prepared = prepareContactCreate({ name: "Westbrook Facilities" }, {
      externalKey: "crm/supplier/77",
      namespace: "acctdemo",
      confirmationToken: "1122334455667788",
    });
    const raw = {
      contactID: "278fd2b0-c2a7-4e1b-88d1-047253f74501",
      name: "Westbrook Facilities",
      contactNumber: prepared.externalReference,
      updatedDateUTC: "2026-08-19T09:00:00.000Z",
      ...providerDefaults,
    };
    const options = {
      namespace: "acctdemo",
      expectedCreatedId: "278fd2b0-c2a7-4e1b-88d1-047253f74501",
    };
    const snapshot = mapSafeContactReadback(raw, { namespace: "acctdemo" });
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty("phones");
    expect(snapshot).not.toHaveProperty("addresses");
    expect(verifyContactReadback(prepared, raw, options)).toMatchObject({
      verified: true,
      mismatches: [],
    });

    // The protection this check exists for must still fire: a field we asserted
    // coming back altered, and a provider entry we cannot parse at all.
    expect(verifyContactReadback(prepared, { ...raw, name: "Westbrook Holdings" }, options))
      .toMatchObject({ verified: false, mismatches: ["target.name"] });
    expect(verifyContactReadback(prepared, {
      ...raw,
      phones: [{ phoneType: "SATELLITE", phoneNumber: "1" }],
    }, options)).toMatchObject({ verified: false, mismatches: ["readback.invalid"] });

    // A phone we did assert must not be silently dropped by the provider.
    const withPhone = prepareContactCreate({
      name: "Westbrook Facilities",
      phones: [{ phone_type: "DEFAULT", phone_number: "65551234" }],
    }, {
      externalKey: "crm/supplier/77",
      namespace: "acctdemo",
      confirmationToken: "1122334455667788",
    });
    expect(verifyContactReadback(withPhone, raw, options))
      .toMatchObject({ verified: false, mismatches: ["target.phones"] });
  });

  it("maps a real captured Xero contact readback, filtering its four empty phone and two empty address blocks", () => {
    // proves: the hand-built "providerDefaults" stand-in above was never checked
    // against a real capture. If safePhone/safeAddress ever stop recognizing a
    // genuine Xero all-blank block as EMPTY (e.g. because a real block carries a
    // field the hand-built stand-in never included), every contact write in
    // production starts failing verification - the exact defect this repo
    // already shipped once, this time against the actual wire shape.
    const [contact] = loadXeroResponse("contact_single").contacts as unknown[];

    const snapshot = mapSafeContactReadback(contact, { namespace: "zcacct" });

    expect(snapshot).not.toHaveProperty("phones");
    expect(snapshot).not.toHaveProperty("addresses");
    expect(snapshot).toEqual({
      contactId: "e2497490-6310-471d-b391-75293a0426ae",
      name: "Halstead Cleaning Services",
      accountNumber: "HALSTEAD_CLEANING_001",
      externalReference: "ZC:zcacct:51ba1cf9d7d125581bc5f5e468b1b4f3",
      contactNumberEvidence: { kind: "OWNED_NAMESPACE" },
      updatedAt: "2026-08-19T08:50:58.300Z",
    });
    // Real Xero sends emailAddress/bankAccountDetails as "" rather than
    // omitting them; boundedString must treat that as absent, not leak it.
    expect(JSON.stringify(snapshot)).not.toContain("bankAccountDetails");
    expect(snapshot).not.toHaveProperty("email");
  });
});

describe("safe untracked Xero item primitives", () => {
  it("creates only an untracked item with reviewed sales and purchase defaults", () => {
    const input = {
      code: " SVC-001 ",
      name: "Accounting advisory",
      description: "Monthly accounting advisory service",
      purchase_description: "Subcontracted accounting advisory",
      is_sold: true,
      is_purchased: true,
      sales_details: { unit_price: 1250.5, account_code: "200", tax_type: "OUTPUT" },
      purchase_details: { unit_price: 700, account_code: "400", tax_type: "INPUT" },
    };
    expect(itemCreateSchema.safeParse(input).success).toBe(true);

    const prepared = prepareItemCreate(input, { confirmationToken: "FEDCBA9876543210" });
    expect(prepared).toMatchObject({
      objectType: "ITEM",
      operation: "CREATE",
      normalizedBusinessKey: { kind: "ITEM_CODE", value: "svc-001" },
      target: {
        code: "SVC-001",
        name: "Accounting advisory",
        isSold: true,
        isPurchased: true,
        isTrackedAsInventory: false,
        salesDetails: { unitPrice: "1250.5000", accountCode: "200", taxType: "OUTPUT" },
        purchaseDetails: { unitPrice: "700.0000", accountCode: "400", taxType: "INPUT" },
      },
      confirmationPhrase: "CONFIRM-ITEM-CREATE-FEDCBA9876543210",
    });
    expect(prepared.canonicalPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mapItemCreateToXero(prepared)).toEqual({
      code: "SVC-001",
      name: "Accounting advisory",
      description: "Monthly accounting advisory service",
      purchaseDescription: "Subcontracted accounting advisory",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      salesDetails: { unitPrice: 1250.5, accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: 700, accountCode: "400", taxType: "INPUT" },
    });

    const raw = {
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      name: "Accounting advisory",
      description: "Monthly accounting advisory service",
      purchaseDescription: "Subcontracted accounting advisory",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      salesDetails: { unitPrice: 1250.5, accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: 700, accountCode: "400", taxType: "INPUT" },
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
      inventoryAssetAccountCode: "must-not-leak",
      quantityOnHand: 99,
      totalCostPool: 99999,
      validationErrors: [{ message: "must-not-leak" }],
    };
    const snapshot = mapSafeItemReadback(raw);
    expect(snapshot).toMatchObject({
      itemId: "33333333-3333-4333-8333-333333333333",
      ...prepared.target,
      updatedAt: "2026-08-07T10:00:00.000Z",
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
    expect(verifyItemReadback(prepared, raw, { expectedCreatedId: raw.itemID })).toEqual({
      verified: true,
      snapshot,
      mismatches: [],
    });
    expect(verifyItemReadback(prepared, raw, {
      expectedCreatedId: "44444444-4444-4444-8444-444444444444",
    })).toMatchObject({ verified: false, mismatches: ["itemId"] });
    const unsafeItemVerifier = verifyItemReadback as unknown as (
      primitive: typeof prepared,
      providerReadback: unknown,
    ) => { verified: boolean; mismatches: string[] };
    expect(unsafeItemVerifier(prepared, raw)).toMatchObject({
      verified: false,
      mismatches: ["expectedCreatedId"],
    });
  });

  it.each([
    ["tracked inventory flag", { is_tracked_as_inventory: true }],
    ["inventory asset account", { inventory_asset_account_code: "630" }],
    ["COGS account", { purchase_details: { cogs_account_code: "500" } }],
    ["quantity on hand", { quantity_on_hand: 10 }],
    ["cost pool", { total_cost_pool: 200 }],
    ["delete control", { delete: true }],
    ["status control", { status: "DELETED" }],
  ])("rejects %s instead of creating or converting inventory", (_label, extra) => {
    expect(itemCreateSchema.safeParse({ code: "SVC-001", ...extra }).success).toBe(false);
  });

  it("rejects sales or purchase defaults that would be nulled by their own flags", () => {
    expect(itemCreateSchema.safeParse({
      code: "SVC-001",
      is_sold: false,
      is_purchased: true,
      sales_details: { account_code: "200" },
    }).success).toBe(false);
    expect(itemCreateSchema.safeParse({
      code: "SVC-001",
      is_sold: true,
      is_purchased: false,
      purchase_description: "not safe",
    }).success).toBe(false);
    expect(itemCreateSchema.safeParse({
      code: "SVC-001",
      is_sold: false,
      is_purchased: false,
    }).success).toBe(false);
  });

  it("updates an exact untracked item without changing its code or erasing nested defaults", () => {
    const existing = {
      itemId: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      name: "Accounting advisory",
      description: "Monthly service",
      isSold: true,
      isPurchased: false,
      isTrackedAsInventory: false,
      salesDetails: { unitPrice: "1250.0000", accountCode: "200", taxType: "OUTPUT" },
      updatedAt: "2026-08-07T10:00:00.000Z",
    };
    const input = {
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: {
        name: "Accounting advisory plus",
        is_purchased: true,
        sales_details: { unit_price: 1350.25 },
        purchase_details: { unit_price: 700, account_code: "400", tax_type: "INPUT" },
      },
    };
    expect(itemUpdateSchema.safeParse(input).success).toBe(true);

    const prepared = prepareItemUpdate(input, existing, { confirmationToken: "1020304050607080" });
    expect(prepared).toMatchObject({
      objectType: "ITEM",
      operation: "UPDATE",
      itemId: existing.itemId,
      expectedUpdatedAt: existing.updatedAt,
      normalizedBusinessKey: { kind: "ITEM_CODE", value: "svc-001" },
      target: {
        code: "SVC-001",
        name: "Accounting advisory plus",
        isSold: true,
        isPurchased: true,
        isTrackedAsInventory: false,
        salesDetails: { unitPrice: "1350.2500", accountCode: "200", taxType: "OUTPUT" },
        purchaseDetails: { unitPrice: "700.0000", accountCode: "400", taxType: "INPUT" },
      },
      confirmationPhrase: "CONFIRM-ITEM-UPDATE-1020304050607080",
    });
    expect(mapItemUpdateToXero(prepared)).toEqual({
      itemID: existing.itemId,
      code: "SVC-001",
      isTrackedAsInventory: false,
      name: "Accounting advisory plus",
      isPurchased: true,
      salesDetails: { unitPrice: 1350.25, accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: 700, accountCode: "400", taxType: "INPUT" },
    });
    expect(mapItemUpdateToXero(prepared)).not.toHaveProperty("inventoryAssetAccountCode");

    const raw = {
      itemID: existing.itemId,
      code: "SVC-001",
      name: "Accounting advisory plus",
      description: "Monthly service",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      salesDetails: { unitPrice: 1350.25, accountCode: "200", taxType: "OUTPUT" },
      purchaseDetails: { unitPrice: 700, accountCode: "400", taxType: "INPUT" },
      updatedDateUTC: "2026-08-07T10:05:00.000Z",
    };
    expect(verifyItemReadback(prepared, raw)).toMatchObject({
      verified: true,
      mismatches: [],
      snapshot: { itemId: existing.itemId, updatedAt: "2026-08-07T10:05:00.000Z" },
    });
    expect(verifyItemCurrentVersion(prepared, existing)).toEqual({ verified: true, mismatches: [] });
  });

  it("fails closed on tracked, stale, code-changing, disabling, and no-op item updates", () => {
    const existing = {
      itemId: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      name: "Accounting advisory",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      updatedAt: "2026-08-07T10:00:00.000Z",
    };
    const base = {
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: { name: "Accounting advisory plus" },
    };

    expect(itemUpdateSchema.safeParse({ ...base, patch: { code: "CHANGED" } }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ ...base, patch: { inventory_asset_account_code: "630" } }).success).toBe(false);
    expect(itemUpdateSchema.safeParse({ ...base, patch: { quantity_on_hand: 10 } }).success).toBe(false);
    expect(() => prepareItemUpdate(base, { ...existing, isTrackedAsInventory: true }))
      .toThrow(/Tracked inventory items cannot be updated/);
    expect(() => prepareItemUpdate({ ...base, patch: { is_sold: false } }, existing))
      .toThrow(/cannot disable an item that is currently sold/);
    expect(() => prepareItemUpdate({ ...base, patch: { is_purchased: false } }, existing))
      .toThrow(/cannot disable an item that is currently purchased/);
    expect(() => prepareItemUpdate({ ...base, patch: { name: existing.name } }, existing)).toThrow(/does not change/);
    expect(() => prepareItemUpdate({ ...base, expected_updated_at: "2026-08-07T09:59:59.000Z" }, existing))
      .toThrow(/changed after it was reviewed/);
    expect(() => prepareItemUpdate({ ...base, item_id: "44444444-4444-4444-8444-444444444444" }, existing))
      .toThrow(/ItemID does not match/);

    const prepared = prepareItemUpdate(base, existing, { confirmationToken: "AABBCCDDEEFF0011" });
    expect(verifyItemCurrentVersion(prepared, { ...existing, updatedAt: "2026-08-07T10:00:01.000Z" }))
      .toEqual({ verified: false, mismatches: ["UPDATED_AT"] });
    expect(verifyItemCurrentVersion(prepared, { ...existing, name: "Changed without a timestamp bump" }))
      .toEqual({ verified: false, mismatches: ["CONTENT"] });
  });

  it("requires the item to be enabled before adding details for a disabled side", () => {
    const existing = {
      itemId: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      isSold: true,
      isPurchased: false,
      isTrackedAsInventory: false,
      updatedAt: "2026-08-07T10:00:00.000Z",
    };
    expect(() => prepareItemUpdate({
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: { purchase_details: { account_code: "400" } },
    }, existing)).toThrow(/enabled for purchase/);

    expect(() => prepareItemUpdate({
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: { purchase_description: "Subcontracted service" },
    }, existing)).toThrow(/description.*enabled for purchase/i);

    expect(() => prepareItemUpdate({
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: { description: "Customer-facing service" },
    }, {
      ...existing,
      isSold: false,
      isPurchased: true,
    })).toThrow(/description.*enabled for sale/i);

    expect(() => prepareItemUpdate({
      item_id: existing.itemId,
      expected_updated_at: existing.updatedAt,
      patch: { is_purchased: true, purchase_details: { account_code: "400" } },
    }, existing, { confirmationToken: "ABCDEF0123456789" })).not.toThrow();
  });

  it("does not treat a tracked or changed provider readback as verified", () => {
    const prepared = prepareItemCreate({ code: "SVC-001" }, {
      confirmationToken: "0102030405060708",
    });
    expect(verifyItemReadback(prepared, {
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: true,
      inventoryAssetAccountCode: "630",
      quantityOnHand: 10,
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
    }, {
      expectedCreatedId: "33333333-3333-4333-8333-333333333333",
    // proves: a single disagreeing target field (isTrackedAsInventory: false
    // vs the provider's true) is now named as "target.isTrackedAsInventory",
    // not collapsed to the bare, unactionable "target" it used to report.
    })).toMatchObject({ verified: false, mismatches: ["target.isTrackedAsInventory"] });
    expect(mapSafeItemReadback({
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      salesDetails: { unitPrice: -1 },
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
    })).toBeUndefined();
    expect(mapSafeItemReadback({
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      description: "must not survive a disabled sales side",
      isSold: false,
      isPurchased: true,
      isTrackedAsInventory: false,
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
    })).toBeUndefined();
    expect(mapSafeItemReadback({
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      purchaseDescription: "must not survive a disabled purchase side",
      isSold: true,
      isPurchased: false,
      isTrackedAsInventory: false,
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
    })).toBeUndefined();
  });

  it("names the exact target field that disagreed and never leaks the disagreeing value through that name", () => {
    // proves: (1) a single changed target field is now named "target.name",
    // aligned with verifyContactReadback's existing target.name shape,
    // instead of the previous bare "target" that told the caller nothing it
    // could act on; (2) the field NAME is safe to return because it is a
    // fixed schema key, but the field VALUE never appears anywhere in the
    // result - mirroring xeroFailureEnvelope.test.ts's "SECRET-LEAK" guarantee
    // one layer further upstream, at the primitive that feeds it.
    const prepared = prepareItemCreate({
      code: "SVC-001",
      name: "Accounting advisory",
    }, { confirmationToken: "0102030405060708" });
    const raw = {
      itemID: "33333333-3333-4333-8333-333333333333",
      code: "SVC-001",
      name: "SECRET-LEAK-PROVIDER-VALUE",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      updatedDateUTC: "2026-08-07T10:00:00.000Z",
    };
    const result = verifyItemReadback(prepared, raw, { expectedCreatedId: raw.itemID });
    expect(result).toMatchObject({ verified: false, mismatches: ["target.name"] });
    expect(JSON.stringify(result.mismatches)).not.toContain("SECRET-LEAK");
  });
});
