import { describe, expect, it } from "vitest";
import type { AccountSummary, TaxRateSummary } from "../src/providers/types.js";
import { resolveStableXeroTaxRate } from "../src/policy/xeroTaxRateResolver.js";

const revenue: AccountSummary = {
  accountId: "account-revenue",
  code: "200",
  status: "ACTIVE",
  type: "REVENUE",
  class: "REVENUE",
};

const output9: TaxRateSummary = {
  name: "Output tax",
  taxType: "OUTPUTY24",
  status: "ACTIVE",
  displayTaxRate: "9.0000",
  effectiveRate: "9.0000",
  canApplyToRevenue: true,
};

describe("deterministic Xero stable TaxType resolution", () => {
  it("selects exactly one active TaxRate only when both rates and account applicability match policy", () => {
    expect(resolveStableXeroTaxRate({
      taxRates: [output9],
      taxType: "OUTPUTY24",
      direction: "OUTPUT",
      account: revenue,
    })).toEqual({
      ok: true,
      taxRate: output9,
      accountClass: "REVENUE",
      expectedRate: "9.0000",
    });
  });

  it.each([
    ["missing DisplayTaxRate", { ...output9, displayTaxRate: undefined }, "MISSING_TAX_RATE_EVIDENCE"],
    ["missing EffectiveRate", { ...output9, effectiveRate: undefined }, "MISSING_TAX_RATE_EVIDENCE"],
    ["wrong DisplayTaxRate", { ...output9, displayTaxRate: "8.0000" }, "TAX_RATE_MISMATCH"],
    ["wrong EffectiveRate", { ...output9, effectiveRate: "8.0000" }, "TAX_RATE_MISMATCH"],
    ["missing active status", { ...output9, status: undefined }, "NO_UNIQUE_ACTIVE_TAX_RATE"],
    ["inactive TaxRate", { ...output9, status: "DELETED" }, "NO_UNIQUE_ACTIVE_TAX_RATE"],
    ["missing applicability", { ...output9, canApplyToRevenue: undefined }, "TAX_NOT_APPLICABLE_TO_ACCOUNT_CLASS"],
  ])("fails closed for %s", (_label, taxRate, code) => {
    expect(resolveStableXeroTaxRate({
      taxRates: [taxRate],
      taxType: "OUTPUTY24",
      direction: "OUTPUT",
      account: revenue,
    })).toMatchObject({ ok: false, code });
  });

  it("rejects duplicate active rows even when both rows otherwise match", () => {
    expect(resolveStableXeroTaxRate({
      taxRates: [output9, { ...output9, name: "Tenant duplicate" }],
      taxType: "OUTPUTY24",
      direction: "OUTPUT",
      account: revenue,
    })).toMatchObject({ ok: false, code: "NO_UNIQUE_ACTIVE_TAX_RATE" });
  });

  it("rejects an input TaxType on an output document before Provider mutation", () => {
    expect(resolveStableXeroTaxRate({
      taxRates: [{
        ...output9,
        taxType: "INPUTY24",
        canApplyToRevenue: undefined,
        canApplyToExpenses: true,
      }],
      taxType: "INPUTY24",
      direction: "OUTPUT",
      account: revenue,
    })).toMatchObject({ ok: false, code: "TAX_DIRECTION_MISMATCH" });
  });

  it("rejects accounts whose Xero class is absent or unknown", () => {
    expect(resolveStableXeroTaxRate({
      taxRates: [output9],
      taxType: "OUTPUTY24",
      direction: "OUTPUT",
      account: { ...revenue, class: undefined },
    })).toMatchObject({ ok: false, code: "UNKNOWN_ACCOUNT_CLASS" });
  });

  it("accepts the exact zero-rate NONE policy without treating its display label as authority", () => {
    const none: TaxRateSummary = {
      name: "Tenant renamed no-tax label",
      taxType: "NONE",
      status: "ACTIVE",
      displayTaxRate: "0",
      effectiveRate: "0.0000",
      canApplyToRevenue: true,
    };
    expect(resolveStableXeroTaxRate({
      taxRates: [none],
      taxType: "NONE",
      direction: "OUTPUT",
      account: revenue,
    })).toMatchObject({ ok: true, expectedRate: "0.0000", taxRate: none });
  });
});
