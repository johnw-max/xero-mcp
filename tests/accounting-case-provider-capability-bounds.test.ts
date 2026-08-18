import { describe, expect, it } from "vitest";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import {
  XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS,
  createXeroAccountingCaseProviderContractFromProjection,
  projectXeroAccountingCaseCompilerInput,
} from "../src/policy/xeroAccountingCaseProviderContract.js";
import { createXeroDeclaredLedgerPolicy } from "../src/policy/xeroDeclaredLedgerPolicy.js";
import { compileTestXeroAccountingCase, testXeroTenantCoaBinding } from "./helpers/xeroTenantCoaProfile.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";

function invoiceCase(lines: Array<{ quantity: string; unitAmount: string }>) {
  const net = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitAmount), 0);
  const decimal = Number.isInteger(net) ? String(net) : net.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
  return {
    caseId: `provider-bounds-${lines.length}-${lines[0]?.quantity}-${lines[0]?.unitAmount}`,
    expectedVersion: 0,
    target: {
      tenantId,
      environment: "TEST",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      paysTax: true,
      organisationStatus: "ACTIVE",
    },
    sources: [{
      artifactId: "bounds-source",
      label: "Provider bounds source",
      units: [{ unitId: "bounds-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [{
      factId: "bounds-document",
      lineageKey: "bounds-document-lineage",
      eventKey: "bounds-document-event",
      sourceUnitIds: ["bounds-unit"],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "NATIVE_DOCUMENT",
      documentKind: "INVOICE",
      counterpartyRole: "CUSTOMER",
      reference: "BOUNDS-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
      currency: "SGD",
      contactName: "Exact Customer",
      xeroContactId: contactId,
      taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
      lineAmountType: "NO_TAX",
      lines: lines.map((line, index) => ({
        lineId: `line-${index + 1}`,
        description: `Line ${index + 1}`,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        sourceTax: "0",
        accountCode: "200",
        taxType: "NONE",
      })),
      declaredNet: decimal,
      declaredTax: "0",
      declaredGross: decimal,
      documentValidity: "TEST_OR_NOT_VALID",
    }],
  };
}

function contactCase(input: {
  number: string;
  email: string;
  identityKind?: "LEGAL_REGISTRY" | "PROVIDER_TENANT_ACCOUNT";
}) {
  const identityKind = input.identityKind ?? "LEGAL_REGISTRY";
  return {
    caseId: `provider-contact-bounds-${identityKind}-${input.number.length}-${input.email.length}`,
    expectedVersion: 0,
    target: {
      tenantId,
      environment: "TEST",
      baseCurrency: "SGD",
      taxJurisdiction: "SG",
      paysTax: true,
      organisationStatus: "ACTIVE",
    },
    sources: [{
      artifactId: "contact-bounds-source",
      label: "Contact bounds source",
      units: [{ unitId: "contact-bounds-unit", expectedFactKinds: ["CONTACT_CANDIDATE"] }],
    }],
    facts: [{
      factId: "contact-bounds-fact",
      lineageKey: "contact-bounds-lineage",
      eventKey: "contact-bounds-event",
      sourceUnitIds: ["contact-bounds-unit"],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "CONTACT_CANDIDATE",
      usageRoles: ["SUPPLIER"],
      name: "N".repeat(255),
      email: input.email,
      durableIdentity: identityKind === "LEGAL_REGISTRY"
        ? {
            kind: "LEGAL_REGISTRY",
            jurisdiction: "SG",
            registryScheme: "ACRA_UEN",
            number: input.number,
          }
        : {
            kind: "PROVIDER_TENANT_ACCOUNT",
            providerId: "xero",
            namespace: "CONTACT_ACCOUNT_NUMBER",
            number: input.number,
          },
      ...(identityKind === "LEGAL_REGISTRY"
        ? { companyNumber: input.number }
        : { accountNumber: input.number }),
    }],
  };
}

function reasonCodes(raw: unknown): string[] {
  return compileTestXeroAccountingCase(raw).events.flatMap((event) => event.reasonCodes);
}

describe("provider-neutral capability bounds sealed by the Xero adapter", () => {
  it("accepts 20 lines and rejects 21 before persistence or provider preflight", () => {
    expect(compileTestXeroAccountingCase(invoiceCase(Array.from({ length: 20 }, () => ({
      quantity: "1", unitAmount: "1",
    })))).operations).toHaveLength(1);
    const rejected = compileTestXeroAccountingCase(invoiceCase(Array.from({ length: 21 }, () => ({
      quantity: "1", unitAmount: "1",
    }))));
    expect(rejected.operations).toEqual([]);
    expect(rejected.events.flatMap((event) => event.reasonCodes))
      .toContain("PROVIDER_NATIVE_LINE_COUNT_LIMIT_EXCEEDED");
  });

  it.each([
    ["quantity", { quantity: "1000000", unitAmount: "1" }, { quantity: "1000000.0001", unitAmount: "1" }, "PROVIDER_NATIVE_QUANTITY_LIMIT_EXCEEDED"],
    ["unit amount", { quantity: "0.9000", unitAmount: "1000000000" }, { quantity: "0.9000", unitAmount: "1000000000.0001" }, "PROVIDER_NATIVE_UNIT_AMOUNT_LIMIT_EXCEEDED"],
    ["entered line amount", { quantity: "900", unitAmount: "1000000000" }, { quantity: "900.0001", unitAmount: "1000000000" }, "PROVIDER_NATIVE_ENTERED_LINE_AMOUNT_LIMIT_EXCEEDED"],
  ])("accepts the exact %s bound and rejects the smallest representable excess", (_label, accepted, rejected, reason) => {
    expect(compileTestXeroAccountingCase(invoiceCase([accepted])).operations).toHaveLength(1);
    const rejectedPlan = compileTestXeroAccountingCase(invoiceCase([rejected]));
    expect(rejectedPlan.operations).toEqual([]);
    expect(rejectedPlan.events.flatMap((event) => event.reasonCodes)).toContain(reason);
  });

  it("accepts contact name 255, each typed number at 50, and email 255", () => {
    const email255 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`;
    expect(email255).toHaveLength(255);
    expect(compileTestXeroAccountingCase(contactCase({
      number: "N".repeat(50), email: email255,
    })).operations).toHaveLength(1);
    expect(compileTestXeroAccountingCase(contactCase({
      number: "N".repeat(50), email: email255, identityKind: "PROVIDER_TENANT_ACCOUNT",
    })).operations).toHaveLength(1);
  });

  it("rejects company, account, and typed durable numbers at 51 with no operation", () => {
    const email = "bounds@example.test";
    const legalRegistry = compileTestXeroAccountingCase(contactCase({
      number: "N".repeat(51), email,
    }));
    expect(legalRegistry.operations).toEqual([]);
    expect(legalRegistry.events.flatMap((event) => event.reasonCodes)).toEqual(expect.arrayContaining([
      "PROVIDER_CONTACT_COMPANY_NUMBER_LIMIT_EXCEEDED",
      "PROVIDER_CONTACT_DURABLE_IDENTITY_NUMBER_LIMIT_EXCEEDED",
    ]));

    const providerAccount = compileTestXeroAccountingCase(contactCase({
      number: "N".repeat(51), email, identityKind: "PROVIDER_TENANT_ACCOUNT",
    }));
    expect(providerAccount.operations).toEqual([]);
    expect(providerAccount.events.flatMap((event) => event.reasonCodes)).toEqual(expect.arrayContaining([
      "PROVIDER_CONTACT_ACCOUNT_NUMBER_LIMIT_EXCEEDED",
      "PROVIDER_CONTACT_DURABLE_IDENTITY_NUMBER_LIMIT_EXCEEDED",
    ]));
  });

  it("rejects email 256 through the provider contract with no operation", () => {
    const email256 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`;
    expect(email256).toHaveLength(256);
    const rejected = compileTestXeroAccountingCase(contactCase({
      number: "N".repeat(50), email: email256,
    }));
    expect(rejected.operations).toEqual([]);
    expect(rejected.events.flatMap((event) => event.reasonCodes))
      .toContain("PROVIDER_CONTACT_EMAIL_LIMIT_EXCEEDED");
  });

  it("rehydrates the sealed provider bounds from projection and reproduces the exact plan", () => {
    const raw = invoiceCase([{ quantity: "1000000", unitAmount: "1" }]);
    const original = compileTestXeroAccountingCase(raw);
    const projected = projectXeroAccountingCaseCompilerInput(raw);
    const replayedProvider = createXeroAccountingCaseProviderContractFromProjection(
      original.providerProjection,
    );

    expect(replayedProvider.capabilityBounds).toEqual(XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS);
    expect(replayedProvider.planProjection).toEqual(original.providerProjection);
    expect(compileAccountingCase(
      projected.input,
      createXeroDeclaredLedgerPolicy({
        jurisdiction: projected.input.target.taxJurisdiction,
        paysTax: projected.paysTax,
        ledgerBinding: testXeroTenantCoaBinding(),
      }),
      replayedProvider,
    )).toEqual(original);
  });
});
