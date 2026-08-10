import { describe, expect, it } from "vitest";
import {
  personalPocHostReturnAction,
  renderPersonalPocHostReturnPage,
  renderXeroOrganisationSelectionPage,
} from "../src/oauth/brokerPages.js";

describe("Xero broker organisation selection page", () => {
  it("requires an explicit selection even when Xero returns one organisation", () => {
    const html = renderXeroOrganisationSelectionPage({
      organisations: [{
        connectionId: "connection-one",
        tenantName: "Synthetic Trial Co",
        tenantId: "11111111-1111-4111-8111-111111111111",
        tenantType: "ORGANISATION",
      }],
      csrfToken: "csrf-secret",
      requestedScopes: ["xero.read"],
      personalPocOnly: true,
    });

    expect(html).toContain('type="radio"');
    expect(html).toContain('name="connection_id"');
    expect(html).toContain("required");
    expect(html).not.toContain("checked");
    expect(html).toContain("PERSONAL POC — HOST IDENTITY UNVERIFIED");
    expect(html).toContain('action="/oauth/xero/select"');
    expect(html).toContain("ask the Agent to switch Xero organisation");
    expect(html).toContain("Reconnect through Xero OAuth only when the organisation is not in the authorised list");
  });

  it("renders every organisation without leaking unsafe markup", () => {
    const html = renderXeroOrganisationSelectionPage({
      organisations: [
        { connectionId: "conn-a", tenantName: "Alpha & Co", tenantId: "tenant-alpha" },
        { connectionId: 'conn-\"><script>alert(1)</script>', tenantName: "<Beta>", tenantId: "tenant-beta" },
      ],
      csrfToken: '"><img src=x onerror=alert(1)>',
      requestedScopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: false,
    });

    expect(html).toContain("Alpha &amp; Co");
    expect(html).toContain("&lt;Beta&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html.match(/name="connection_id"/g)).toHaveLength(2);
  });

  it("refuses to render an empty selection", () => {
    expect(() => renderXeroOrganisationSelectionPage({
      organisations: [],
      csrfToken: "csrf",
      requestedScopes: ["xero.read"],
      personalPocOnly: true,
    })).toThrow(/at least one/i);
  });
});

describe("Personal POC Host return page", () => {
  it("uses one user-activated GET form without exposing the one-time response in a link", () => {
    const callback = new URL("https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback");
    callback.searchParams.set("code", "one-time-code");
    callback.searchParams.set("state", 'state-\"><script>alert(1)</script>');

    const html = renderPersonalPocHostReturnPage({
      returnUrl: callback.href,
      hostName: "Agent2 <Finance>",
      organisationName: "Trial <Alpha & Co>",
    });

    expect(personalPocHostReturnAction(callback.href)).toBe(
      "https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback",
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('action="https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"');
    expect(html).toContain('name="code" value="one-time-code"');
    expect(html).toContain('name="state" value="state-&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain("Return to Agent2 &lt;Finance&gt;");
    expect(html).toContain("Trial &lt;Alpha &amp; Co&gt;");
    expect(html).toContain("read the connection status and confirm this same organisation");
    expect(html.match(/id="return-to-host"/gu)).toHaveLength(1);
    expect(html.match(/type="submit"/gu)).toHaveLength(1);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/http-equiv=["']refresh/iu);
    expect(html).toContain("Do not share this page.");
  });

  it.each([
    "http://agent2.example.test/callback?code=code&state=state",
    "javascript:alert(1)?code=code&state=state",
    "https://user:password@agent2.example.test/callback?code=code&state=state",
    "https://agent2.example.test/callback?code=code&state=state#fragment",
    "https://agent2.example.test/callback?state=state",
    "https://agent2.example.test/callback?code=code",
    "https://agent2.example.test/callback?code=one&code=two&state=state",
    "https://agent2.example.test/callback?code=code&state=one&state=two",
    "https://agent2.example.test/callback?existing=value&code=code&state=state",
    "https://agent2.example.test/callback;directive?code=code&state=state",
    "https://agent2.example.test/callback,other?code=code&state=state",
  ])("rejects an unsafe or incomplete Host return URL: %s", (returnUrl) => {
    expect(() => renderPersonalPocHostReturnPage({
      returnUrl,
      hostName: "Agent2",
      organisationName: "Synthetic Trial Co",
    }))
      .toThrow(/Host return URL/i);
  });
});
