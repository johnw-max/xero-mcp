import { describe, expect, it } from "vitest";
import { leastPrivilegeXeroScopesForBroker } from "../src/providers/xeroScopes.js";

const configured = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.settings",
  "accounting.contacts.read",
  "accounting.contacts",
  "accounting.invoices.read",
  "accounting.invoices",
  "accounting.payments.read",
  "accounting.payments",
  "accounting.manualjournals.read",
  "accounting.manualjournals",
  "accounting.banktransactions.read",
  "accounting.banktransactions",
  "accounting.journals.read",
  "accounting.reports.trialbalance.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.aged.read",
];

describe("least-privilege Xero Broker scopes", () => {
  it("does not request invoice write for an outer read-only grant", () => {
    const scopes = leastPrivilegeXeroScopesForBroker(configured, ["xero.read"]);
    expect(scopes).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));
    expect(scopes).toContain("accounting.invoices.read");
    expect(scopes).toContain("accounting.payments.read");
    expect(scopes).toEqual(expect.arrayContaining([
      "accounting.reports.trialbalance.read",
      "accounting.reports.profitandloss.read",
      "accounting.reports.balancesheet.read",
      "accounting.reports.aged.read",
    ]));
    expect(scopes).not.toContain("accounting.invoices");
    expect(scopes).not.toContain("accounting.manualjournals");
    expect(scopes).not.toContain("accounting.contacts");
    expect(scopes).not.toContain("accounting.settings");
    expect(scopes).not.toContain("accounting.journals.read");
  });

  it("keeps read capabilities and requests the complete released controlled-write scope bundle", () => {
    const scopes = leastPrivilegeXeroScopesForBroker(configured, ["xero.read", "xero.draft.write"]);
    expect(scopes).toEqual(expect.arrayContaining([
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.settings.read",
      "accounting.contacts.read",
      "accounting.invoices.read",
      "accounting.payments.read",
      "accounting.manualjournals.read",
      "accounting.banktransactions.read",
      "accounting.reports.trialbalance.read",
      "accounting.reports.profitandloss.read",
      "accounting.reports.balancesheet.read",
      "accounting.reports.aged.read",
      "accounting.invoices",
      "accounting.contacts",
      "accounting.settings",
      "accounting.manualjournals",
      "accounting.payments",
      "accounting.banktransactions",
    ]));
    expect(scopes).not.toContain("accounting.journals.read");
    expect(scopes).not.toContain("accounting.transactions");
  });

  it("does not request read capabilities for a draft-write-only outer grant", () => {
    const scopes = leastPrivilegeXeroScopesForBroker(configured, ["xero.draft.write"]);
    expect(scopes).toEqual(expect.arrayContaining([
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.invoices",
      "accounting.contacts",
      "accounting.settings",
      "accounting.manualjournals",
      "accounting.payments",
      "accounting.banktransactions",
    ]));
    expect(scopes).not.toContain("accounting.reports.trialbalance.read");
    expect(scopes).not.toContain("accounting.payments.read");
    expect(scopes).not.toContain("accounting.banktransactions.read");
    expect(scopes).not.toContain("accounting.invoices.read");
    expect(scopes).not.toContain("accounting.manualjournals.read");
    expect(scopes).not.toContain("accounting.journals.read");
  });

  it.each([
    ["accounting.settings", /item create and update/i],
    ["accounting.manualjournals", /manual journal draft write/i],
    ["accounting.payments", /payment create.*reversal/i],
    ["accounting.banktransactions", /bank transaction create.*reversal/i],
  ])("fails closed when the released write bundle lacks %s", (missingScope, expectedMessage) => {
    expect(() => leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => scope !== missingScope),
      ["xero.draft.write"],
    )).toThrow(expectedMessage);
  });

  it("fails closed when configured Xero scopes cannot satisfy the grant", () => {
    expect(() => leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => scope !== "accounting.invoices"),
      ["xero.read", "xero.draft.write"],
    )).toThrow(/draft invoice.*purchase-order write/i);
  });

  it.each([
    ["accounting.invoices", /draft invoice.*purchase-order write/i],
    ["accounting.contacts", /contact create and update/i],
  ])("fails closed when draft write lacks %s", (missingScope, expectedMessage) => {
    expect(() => leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => scope !== missingScope),
      ["xero.read", "xero.draft.write"],
    )).toThrow(expectedMessage);
  });

  it("keeps legacy broad transaction compatibility without treating it as contact write", () => {
    const legacyConfigured = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.transactions",
      "accounting.journals.read",
      "accounting.settings.read",
      "accounting.contacts",
      "accounting.settings",
      "accounting.reports.read",
    ];
    const scopes = leastPrivilegeXeroScopesForBroker(
      legacyConfigured,
      ["xero.read", "xero.draft.write"],
    );
    expect(scopes).toEqual(expect.arrayContaining([
      "accounting.transactions",
      "accounting.contacts",
    ]));
    expect(scopes).toContain("accounting.settings");

    expect(() => leastPrivilegeXeroScopesForBroker(
      legacyConfigured.filter((scope) => scope !== "accounting.contacts"),
      ["xero.read", "xero.draft.write"],
    )).toThrow(/contact create and update/i);
    expect(() => leastPrivilegeXeroScopesForBroker(
      legacyConfigured.filter((scope) => scope !== "accounting.settings"),
      ["xero.read", "xero.draft.write"],
    )).toThrow(/item create and update/i);
  });

  it("fails closed when xero.read cannot obtain payment history read", () => {
    expect(() => leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => !["accounting.payments.read", "accounting.payments"].includes(scope)),
      ["xero.read"],
    )).toThrow(/payment history read/i);
  });
});
