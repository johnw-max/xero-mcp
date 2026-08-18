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
  "accounting.manualjournals.read",
  "accounting.manualjournals",
  "accounting.banktransactions.read",
  "accounting.reports.trialbalance.read",
];

describe("least-privilege Xero Broker scopes", () => {
  it("does not request invoice write for an outer read-only grant", () => {
    const scopes = leastPrivilegeXeroScopesForBroker(configured, ["xero.read"]);
    expect(scopes).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));
    expect(scopes).toContain("accounting.invoices.read");
    expect(scopes).toContain("accounting.payments.read");
    expect(scopes).not.toContain("accounting.invoices");
    expect(scopes).not.toContain("accounting.manualjournals");
    expect(scopes).not.toContain("accounting.contacts");
    expect(scopes).not.toContain("accounting.settings");
  });

  it("keeps read capabilities and requests only invoice/contact writes for draft write", () => {
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
      "accounting.invoices",
      "accounting.contacts",
    ]));
    expect(scopes).not.toContain("accounting.manualjournals");
    expect(scopes).not.toContain("accounting.settings");
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
    ]));
    expect(scopes).not.toContain("accounting.reports.trialbalance.read");
    expect(scopes).not.toContain("accounting.payments.read");
    expect(scopes).not.toContain("accounting.banktransactions.read");
    expect(scopes).not.toContain("accounting.invoices.read");
    expect(scopes).not.toContain("accounting.manualjournals.read");
    expect(scopes).not.toContain("accounting.manualjournals");
    expect(scopes).not.toContain("accounting.settings");
  });

  it("accepts draft write without manual-journal or settings write scopes", () => {
    const scopes = leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => scope !== "accounting.manualjournals" && scope !== "accounting.settings"),
      ["xero.draft.write"],
    );
    expect(scopes).toEqual(expect.arrayContaining([
      "accounting.invoices",
      "accounting.contacts",
    ]));
    expect(scopes).not.toContain("accounting.manualjournals");
    expect(scopes).not.toContain("accounting.settings");
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

  it("keeps legacy broad transaction compatibility without treating it as contact or settings write", () => {
    const legacyConfigured = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.transactions",
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
    expect(scopes).not.toContain("accounting.settings");

    expect(() => leastPrivilegeXeroScopesForBroker(
      legacyConfigured.filter((scope) => scope !== "accounting.contacts"),
      ["xero.read", "xero.draft.write"],
    )).toThrow(/contact create and update/i);
    expect(leastPrivilegeXeroScopesForBroker(
      legacyConfigured.filter((scope) => scope !== "accounting.settings"),
      ["xero.read", "xero.draft.write"],
    )).toEqual(expect.arrayContaining(["accounting.transactions", "accounting.contacts"]));
  });

  it("fails closed when xero.read cannot obtain payment history read", () => {
    expect(() => leastPrivilegeXeroScopesForBroker(
      configured.filter((scope) => scope !== "accounting.payments.read"),
      ["xero.read"],
    )).toThrow(/payment history read/i);
  });
});
