import { describe, expect, it } from "vitest";
import { resolveXeroFirmGovernanceExpectation } from "../src/policy/xeroFirmGovernanceClaim.js";
import type { XeroMutationPreparation } from "../src/services/xeroMutationService.js";

function preparation(objectType: string, authoritativeProviderField: string): XeroMutationPreparation {
  return {
    objectType,
    canonicalPayload: { authoritative_provider_field: authoritativeProviderField },
  } as unknown as XeroMutationPreparation;
}

describe("firm-governance expectation after ADR-003", () => {
  // Production incident: supplier bills failed at execute with
  // XERO_FIRM_GOVERNANCE_AUTHORITY / "exact Xero standing delegation is
  // missing or ambiguous" because this resolver still demanded a signed
  // exclusive-writer authority for non-unique coordinates, and no delegation
  // carries firmGovernanceRequired any more. No route needs it.
  it.each([
    ["SUPPLIER_BILL", "INVOICE_NUMBER"],
    ["SALES_INVOICE", "REFERENCE"],
    ["SALES_INVOICE", "INVOICE_NUMBER"],
  ])("requires no external governance for %s / %s", (objectType, field) => {
    expect(resolveXeroFirmGovernanceExpectation(preparation(objectType, field))).toBeUndefined();
  });

  it("requires no external governance even when the case sealed a non-unique coordinate", () => {
    // The sealed path was the other half of the same production block: a
    // supplier bill seals a NON_UNIQUE_EXCLUSIVE_WRITER coordinate, which used
    // to be returned as a governance expectation and then failed delegation
    // lookup with APPROVAL_INVALID / STALE_AUTHORITY.
    expect(
      resolveXeroFirmGovernanceExpectation(preparation("SUPPLIER_BILL", "INVOICE_NUMBER"), {
        route: "SUPPLIER_BILL",
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        authoritativeProviderField: "INVOICE_NUMBER",
      } as never),
    ).toBeUndefined();
  });

  it("still refuses a sealed authority that contradicts the preparation", () => {
    expect(() =>
      resolveXeroFirmGovernanceExpectation(preparation("SUPPLIER_BILL", "INVOICE_NUMBER"), {
        route: "SALES_INVOICE",
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        authoritativeProviderField: "INVOICE_NUMBER",
      } as never),
    ).toThrow(/does not match the provider preparation/u);
  });
});
