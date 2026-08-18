import { describe, expect, it } from "vitest";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import { createXeroAccountingCaseProviderContract } from "../src/policy/xeroAccountingCaseProviderContract.js";
import { createXeroSingaporeAccountingPolicy } from "../src/policy/xeroSingaporeAccountingPolicy.js";
import { testXeroTenantCoaBinding } from "./helpers/xeroTenantCoaProfile.js";

const target = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  environment: "TEST" as const,
  baseCurrency: "SGD",
  taxJurisdiction: "SG",
  organisationStatus: "ACTIVE",
};

function contactFact(overrides: Record<string, unknown> = {}) {
  return {
    factId: "contact-fact",
    lineageKey: "contact-lineage",
    eventKey: "contact-event",
    sourceUnitIds: ["contact-unit"],
    origin: "MODEL_EXTRACTED" as const,
    revision: 1,
    kind: "CONTACT_CANDIDATE" as const,
    usageRoles: ["SUPPLIER"] as const,
    name: "Example Supplier",
    ...overrides,
  };
}

function compileContact(overrides: Record<string, unknown> = {}, caseId = "contact-case") {
  return compileAccountingCase({
    caseId,
    expectedVersion: 0,
    target,
    sources: [{
      artifactId: "contact-source",
      label: "Contact evidence",
      units: [{ unitId: "contact-unit", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }],
    }],
    facts: [contactFact(overrides)],
  }, createXeroSingaporeAccountingPolicy({ paysTax: true }), createXeroAccountingCaseProviderContract(
    new Map(),
    testXeroTenantCoaBinding(),
  ));
}

describe("provider-neutral durable contact identity", () => {
  it("does not turn bare company/account/email fields into a durable create identity", () => {
    const compiled = compileContact({
      email: "shared@example.test",
      companyNumber: "123",
      accountNumber: "CUST-001",
    });
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]).toMatchObject({
      disposition: "REVIEW_REQUIRED",
      reasonCodes: ["CONTACT_DURABLE_IDENTITY_REQUIRED"],
    });
  });

  it("namespaces the same legal number by registration jurisdiction and registry scheme", () => {
    const sg = compileContact({ durableIdentity: {
      kind: "LEGAL_REGISTRY",
      jurisdiction: "SG",
      registryScheme: "ACRA_UEN",
      number: "123",
    } });
    const us = compileContact({ durableIdentity: {
      kind: "LEGAL_REGISTRY",
      jurisdiction: "US",
      registryScheme: "IRS_EIN",
      number: "123",
    } });
    expect(sg.operations[0]?.businessIdentity).toMatchObject({
      kind: "LEGAL_REGISTRY_CONTACT",
      canonicalFields: { jurisdiction: "SG", registryScheme: "ACRA_UEN", number: "123" },
    });
    expect(us.operations[0]?.businessIdentityHash).not.toBe(sg.operations[0]?.businessIdentityHash);
    expect(us.operations[0]?.businessReservation).toEqual(sg.operations[0]?.businessReservation);
    expect(sg.operations[0]?.businessReservation).toMatchObject({
      kind: "PROVIDER_CONTACT_BARE_NUMBER",
      canonicalFields: { fieldKind: "COMPANY_NUMBER", number: "123" },
      scope: "ALL_OCCURRENCES",
    });
    expect(compileContact({ durableIdentity: {
      kind: "LEGAL_REGISTRY",
      jurisdiction: "US",
      registryScheme: "IRS_EIN",
      number: "456",
    } }).operations[0]?.businessReservation.coordinateHash)
      .not.toBe(sg.operations[0]?.businessReservation.coordinateHash);
  });

  it("keeps customer/supplier usage out of the legal identity and reservation", () => {
    const durableIdentity = {
      kind: "LEGAL_REGISTRY" as const,
      jurisdiction: "SG",
      registryScheme: "ACRA_UEN",
      number: "202600088M",
    };
    const customer = compileContact({ usageRoles: ["CUSTOMER"], durableIdentity }, "contact-customer-usage");
    const supplier = compileContact({ usageRoles: ["SUPPLIER"], durableIdentity }, "contact-supplier-usage");
    expect(customer.operations[0]?.businessIdentity).toEqual(supplier.operations[0]?.businessIdentity);
    expect(customer.operations[0]?.businessReservation).toEqual(supplier.operations[0]?.businessReservation);
    expect(customer.operations[0]?.canonicalPayload).toMatchObject({
      schemaVersion: "accounting-case-contact:v4",
      usageRoles: ["CUSTOMER"],
    });
    expect(customer.operations[0]?.canonicalPayload).not.toHaveProperty("role");
  });

  it("namespaces provider account identities and rejects the wrong provider", () => {
    const ar = compileContact({ durableIdentity: {
      kind: "PROVIDER_TENANT_ACCOUNT",
      providerId: "xero",
      namespace: "AR_CUSTOMER",
      number: "CUST-001",
    } });
    const ap = compileContact({ durableIdentity: {
      kind: "PROVIDER_TENANT_ACCOUNT",
      providerId: "xero",
      namespace: "AP_SUPPLIER",
      number: "CUST-001",
    } });
    expect(ap.operations[0]?.businessIdentityHash).not.toBe(ar.operations[0]?.businessIdentityHash);
    expect(ap.operations[0]?.businessReservation).toEqual(ar.operations[0]?.businessReservation);
    expect(ar.operations[0]?.businessReservation).toMatchObject({
      kind: "PROVIDER_CONTACT_BARE_NUMBER",
      canonicalFields: { fieldKind: "ACCOUNT_NUMBER", number: "CUST-001" },
      scope: "ALL_OCCURRENCES",
    });
    expect(compileContact({ durableIdentity: {
      kind: "PROVIDER_TENANT_ACCOUNT",
      providerId: "fakebooks",
      namespace: "AP_SUPPLIER",
      number: "CUST-001",
    } }).events[0]).toMatchObject({
      disposition: "BLOCKED_VALIDATION",
      reasonCodes: ["CONTACT_ACCOUNT_IDENTITY_PROVIDER_MISMATCH"],
    });
  });
});
