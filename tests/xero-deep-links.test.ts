import { describe, expect, it } from "vitest";
import { safeXeroTenantShortCode, xeroBillDeepLink } from "../src/providers/xeroDeepLinks.js";

describe("Xero bill deep links", () => {
  it("binds a bill link to the exact organisation short code and InvoiceID", () => {
    const invoiceId = "22222222-2222-4222-8222-222222222222";
    const link = xeroBillDeepLink("!Demo1", invoiceId);
    const url = new URL(link ?? "");

    expect(url.origin).toBe("https://go.xero.com");
    expect(url.pathname).toBe("/organisationlogin/default.aspx");
    expect(url.searchParams.get("shortcode")).toBe("!Demo1");
    expect(url.searchParams.get("redirecturl")).toBe(`/AccountsPayable/Edit.aspx?InvoiceID=${invoiceId}`);
  });

  it.each([
    [undefined, "22222222-2222-4222-8222-222222222222"],
    ["bad code with spaces", "22222222-2222-4222-8222-222222222222"],
    ["!Demo1", "not-an-invoice-id"],
  ])("does not create a link from an invalid short code or InvoiceID", (shortCode, invoiceId) => {
    expect(xeroBillDeepLink(shortCode, invoiceId)).toBeUndefined();
  });

  it("accepts only the bounded Xero short-code character set", () => {
    expect(safeXeroTenantShortCode("!Demo_1-A")).toBe("!Demo_1-A");
    expect(safeXeroTenantShortCode("javascript:alert(1)")).toBeUndefined();
    expect(safeXeroTenantShortCode("x".repeat(65))).toBeUndefined();
  });
});
