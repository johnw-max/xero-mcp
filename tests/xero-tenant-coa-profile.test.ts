import { describe, expect, it } from "vitest";
import type { AccountSummary } from "../src/providers/types.js";
import { accountingCasePlanHash, type AccountingCaseBinding } from "../src/domain/accountingCasePersistence.js";
import { compileXeroAccountingCase } from "../src/policy/xeroAccountingCaseProviderContract.js";
import {
  XeroTenantCoaProfileError,
  bindXeroTenantCoaProfile,
  createXeroTenantCoaProfileRegistry,
  parseXeroTenantCoaProfiles,
} from "../src/policy/xeroTenantCoaProfile.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function profile(tenantId = tenantA, revision = 7) {
  return {
    profile_id: `sg-coa-${tenantId}`,
    revision,
    tenant_id: tenantId,
    jurisdiction: "SG" as const,
    categories: {
      CONSULTING_REVENUE: {
        account_id: "20000000-0000-4000-8000-000000000001",
        account_code: tenantId === tenantA ? "REV-A" : "4100",
        expected_type: "REVENUE" as const,
        expected_class: "REVENUE" as const,
      },
      OFFICE_SUPPLIES: {
        account_id: "20000000-0000-4000-8000-000000000002",
        account_code: tenantId === tenantA ? "OFC-A" : "6105",
        expected_type: "EXPENSE" as const,
        expected_class: "EXPENSE" as const,
      },
      CLOUD_SUBSCRIPTIONS: {
        account_id: "20000000-0000-4000-8000-000000000003",
        account_code: tenantId === tenantA ? "CLD-A" : "6420",
        expected_type: "EXPENSE" as const,
        expected_class: "EXPENSE" as const,
      },
    },
  };
}

function accounts(raw = profile()): AccountSummary[] {
  return Object.values(raw.categories).map((binding) => ({
    accountId: binding.account_id,
    code: binding.account_code,
    status: "ACTIVE",
    type: binding.expected_type,
    class: binding.expected_class,
  }));
}

function reason(error: unknown): string | undefined {
  return error instanceof XeroTenantCoaProfileError ? error.reasonCode : undefined;
}

function invoiceCase(tenantId: string) {
  return {
    caseId: `tenant-plan-${tenantId}`,
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
      artifactId: "tenant-plan-source",
      label: "Tenant plan source",
      units: [{ unitId: "tenant-plan-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [{
      factId: "tenant-plan-document",
      lineageKey: "tenant-plan-lineage",
      eventKey: "tenant-plan-event",
      sourceUnitIds: ["tenant-plan-unit"],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "NATIVE_DOCUMENT",
      documentKind: "INVOICE",
      counterpartyRole: "CUSTOMER",
      reference: "TENANT-PLAN-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
      currency: "SGD",
      contactName: "Exact Customer",
      xeroContactId: "22222222-2222-4222-8222-222222222222",
      accountingCategory: "CONSULTING_REVENUE",
      taxClass: "NO_TAX",
      taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
      effectiveTaxRateBps: 0,
      lineAmountType: "NO_TAX",
      lines: [{
        lineId: "tenant-plan-line",
        description: "Consulting",
        quantity: "1",
        unitAmount: "100",
        sourceTax: "0",
      }],
      declaredNet: "100",
      declaredTax: "0",
      declaredGross: "100",
      documentValidity: "TEST_OR_NOT_VALID",
    }],
  };
}

function caseBinding(tenantId: string): AccountingCaseBinding {
  return {
    actorId: "tenant-plan-actor",
    workspaceId: "tenant-plan-workspace",
    subjectType: "USER",
    subjectId: "tenant-plan-user",
    agentId: "tenant-plan-agent",
    installationId: "tenant-plan-installation",
    bindingId: "tenant-plan-binding",
    bindingRevision: 1,
    connectionId: "tenant-plan-connection",
    tenantId,
    targetSessionId: "tenant-plan-session",
    targetSessionHash: "a".repeat(64),
    targetSessionExpiresAt: new Date("2026-08-20T00:00:00.000Z"),
  };
}

describe("server-owned Xero tenant chart-of-accounts profile", () => {
  it("binds one exact tenant/jurisdiction profile to AccountID+code+type+class and seals its revision/hash", () => {
    const parsed = parseXeroTenantCoaProfiles([profile()]);
    const selected = createXeroTenantCoaProfileRegistry(parsed).resolve(tenantA, "SG");
    const binding = bindXeroTenantCoaProfile(selected, accounts());

    expect(binding).toMatchObject({
      tenantId: tenantA,
      jurisdiction: "SG",
      revision: 7,
      profileHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      categories: {
        CONSULTING_REVENUE: {
          accountId: "20000000-0000-4000-8000-000000000001",
          accountCode: "REV-A",
          expectedType: "REVENUE",
          expectedClass: "REVENUE",
        },
      },
    });
  });

  it.each([
    ["missing exact ID", (rows: AccountSummary[]) => rows.slice(1), "XERO_COA_ACCOUNT_ID_MISSING"],
    ["same code on another AccountID", (rows: AccountSummary[]) => [...rows, {
      ...rows[0], accountId: "20000000-0000-4000-8000-000000000099",
    }], "XERO_COA_ACCOUNT_CODE_AMBIGUOUS"],
    ["same AccountID under another code", (rows: AccountSummary[]) => [{
      ...rows[0], code: "CHANGED",
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_BINDING_MISMATCH"],
    ["case-variant code rather than exact configured spelling", (rows: AccountSummary[]) => [{
      ...rows[0], code: rows[0]!.code?.toLocaleLowerCase("en"),
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_BINDING_MISMATCH"],
    ["wrong type", (rows: AccountSummary[]) => [{
      ...rows[0], type: "SALES",
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_TYPE_MISMATCH"],
    ["wrong class", (rows: AccountSummary[]) => [{
      ...rows[0], class: "EXPENSE",
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_CLASS_MISMATCH"],
    ["archived", (rows: AccountSummary[]) => [{
      ...rows[0], status: "ARCHIVED",
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_INACTIVE"],
    ["protected", (rows: AccountSummary[]) => [{
      ...rows[0], systemAccount: "DEBTORS",
    }, ...rows.slice(1)], "XERO_COA_ACCOUNT_PROTECTED"],
  ])("rejects %s rather than guessing a semantic account", (_label, mutate, expectedReason) => {
    const selected = createXeroTenantCoaProfileRegistry(parseXeroTenantCoaProfiles([profile()]))
      .resolve(tenantA, "SG");
    expect(() => bindXeroTenantCoaProfile(selected, mutate(accounts())))
      .toThrow(XeroTenantCoaProfileError);
    try {
      bindXeroTenantCoaProfile(selected, mutate(accounts()));
    } catch (error) {
      expect(reason(error)).toBe(expectedReason);
    }
  });

  it("rejects duplicate tenant/jurisdiction profiles and category mappings that reuse a code or AccountID", () => {
    expect(() => parseXeroTenantCoaProfiles([profile(), profile()])).toThrow(/unique tenant.*jurisdiction/i);

    const reusedCode = structuredClone(profile());
    reusedCode.categories.CLOUD_SUBSCRIPTIONS.account_code = reusedCode.categories.OFFICE_SUPPLIES.account_code;
    expect(() => parseXeroTenantCoaProfiles([reusedCode])).toThrow(/account_code.*unique/i);

    const reusedId = structuredClone(profile());
    reusedId.categories.CLOUD_SUBSCRIPTIONS.account_id = reusedId.categories.OFFICE_SUPPLIES.account_id;
    expect(() => parseXeroTenantCoaProfiles([reusedId])).toThrow(/account_id.*unique/i);
  });

  it("makes plan identity differ across tenant mappings and profile revisions", () => {
    const parsed = parseXeroTenantCoaProfiles([profile(tenantA, 7), profile(tenantB, 7)]);
    const registry = createXeroTenantCoaProfileRegistry(parsed);
    const a = bindXeroTenantCoaProfile(registry.resolve(tenantA, "SG"), accounts(profile(tenantA, 7)));
    const b = bindXeroTenantCoaProfile(registry.resolve(tenantB, "SG"), accounts(profile(tenantB, 7)));
    const revised = bindXeroTenantCoaProfile(
      createXeroTenantCoaProfileRegistry(parseXeroTenantCoaProfiles([profile(tenantA, 8)])).resolve(tenantA, "SG"),
      accounts(profile(tenantA, 8)),
    );

    expect(a.profileHash).not.toBe(b.profileHash);
    expect(a.profileHash).not.toBe(revised.profileHash);

    const compiledA = compileXeroAccountingCase(invoiceCase(tenantA), a);
    const compiledB = compileXeroAccountingCase(invoiceCase(tenantB), b);
    expect(accountingCasePlanHash(caseBinding(tenantA), compiledA))
      .not.toBe(accountingCasePlanHash(caseBinding(tenantB), compiledB));
    expect(compiledA.operations[0]?.canonicalPayload.lines)
      .not.toEqual(compiledB.operations[0]?.canonicalPayload.lines);
  });
});
