import { describe, expect, it } from "vitest";
import { parseXeroTenantCoaProfiles } from "../src/policy/xeroTenantCoaProfile.js";

const tenantA = "11111111-1111-4111-8111-111111111111";

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

// ADR-002: account/tax coordinates are now declared by the caller and verified
// against the target tenant's live data (see xeroDeclaredLedgerBinding.ts).
// The semantic tenant/category binding and execution-constraint machinery this
// module used to expose (createXeroTenantCoaProfileRegistry, resolve(),
// bindXeroTenantCoaProfile, XeroTenantCoaProfileError, execution-constraint
// helpers) has no live caller left in src/ -- only parseXeroTenantCoaProfiles
// is still reachable, from config.ts's parsing of the retained (but no longer
// write-gating) XERO_TENANT_COA_PROFILES_JSON env var. The tests that only
// existed to exercise the now-dead binding path were deleted rather than
// patched onto the new contract.
describe("server-owned Xero tenant chart-of-accounts profile", () => {
  it("rejects duplicate tenant/jurisdiction profiles and category mappings that reuse a code or AccountID", () => {
    expect(() => parseXeroTenantCoaProfiles([profile(), profile()])).toThrow(/unique tenant.*jurisdiction/i);

    const reusedCode = structuredClone(profile());
    reusedCode.categories.CLOUD_SUBSCRIPTIONS.account_code = reusedCode.categories.OFFICE_SUPPLIES.account_code;
    expect(() => parseXeroTenantCoaProfiles([reusedCode])).toThrow(/account_code.*unique/i);

    const reusedId = structuredClone(profile());
    reusedId.categories.CLOUD_SUBSCRIPTIONS.account_id = reusedId.categories.OFFICE_SUPPLIES.account_id;
    expect(() => parseXeroTenantCoaProfiles([reusedId])).toThrow(/account_id.*unique/i);
  });

  it("parses a well-formed profile and freezes its normalized shape", () => {
    const [parsed] = parseXeroTenantCoaProfiles([profile()]);
    expect(parsed).toMatchObject({
      profile_id: `sg-coa-${tenantA}`,
      revision: 7,
      tenant_id: tenantA,
      jurisdiction: "SG",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
