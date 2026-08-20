import { describe, expect, it } from "vitest";
import {
  brokerErrorPageReason,
  personalPocHostReturnAction,
  renderBrokerErrorPage,
  renderPersonalPocHostReturnPage,
  renderXeroOrganisationSelectionPage,
  type BrokerErrorReason,
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
      selectionTicket: "selection-ticket",
      requestedScopes: ["xero.read"],
      personalPocOnly: true,
    });

    expect(html).toContain('type="radio"');
    expect(html).toContain('name="connection_id"');
    expect(html).toContain("required");
    expect(html).not.toMatch(/<input[^>]+\schecked(?:\s|>|=)/iu);
    expect(html).toContain("Test connection · Intended for one user.");
    expect(html).toContain('action="/oauth/xero/callback"');
    expect(html).not.toContain('action="/oauth/xero/select"');
    expect(html).toContain('name="selection_ticket" value="selection-ticket"');
    expect(html).toContain("You can switch organisations later from the conversation.");
    expect(html).toContain("Choose an organisation");
    expect(html).not.toContain("Your connection stays controlled");
    expect(html).not.toContain("content-grid");
  });

  it("renders every organisation without leaking unsafe markup", () => {
    const html = renderXeroOrganisationSelectionPage({
      organisations: [
        { connectionId: "conn-a", tenantName: "Alpha & Co", tenantId: "tenant-alpha" },
        { connectionId: 'conn-\"><script>alert(1)</script>', tenantName: "<Beta>", tenantId: "tenant-beta" },
      ],
      csrfToken: '"><img src=x onerror=alert(1)>',
      selectionTicket: '"><script>alert(2)</script>',
      requestedScopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: false,
    });

    expect(html).toContain("Alpha &amp; Co");
    expect(html).toContain("&lt;Beta&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain('data-connection-page="xero"');
    expect(html).toContain('alt="Xero"');
    expect(html.match(/name="connection_id"/g)).toHaveLength(2);
    expect(html.indexOf('class="product-brand"')).toBeLessThan(html.indexOf('class="card"'));
  });

  it("refuses to render an empty selection", () => {
    expect(() => renderXeroOrganisationSelectionPage({
      organisations: [],
      csrfToken: "csrf",
      selectionTicket: "selection-ticket",
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
    expect(html).toContain("Connection ready");
    expect(html.match(/id="return-to-host"/gu)).toHaveLength(1);
    expect(html.match(/type="submit"/gu)).toHaveLength(1);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/http-equiv=["']refresh/iu);
    expect(html).toContain("Do not share this page.");
  });

  it("renders the same strict user-activated return contract for an allowlisted Work Host", () => {
    const callback = new URL("https://work.zcloak.ai/api/mcp/zcloak-ledger-mcp-xero-demo/oauth/callback");
    callback.searchParams.set("code", "work-one-time-code");
    callback.searchParams.set("state", "work-outer-state");

    const html = renderPersonalPocHostReturnPage({
      returnUrl: callback.href,
      hostName: "Work",
      organisationName: "Demo Company (Global)",
    });

    expect(personalPocHostReturnAction(callback.href)).toBe(
      "https://work.zcloak.ai/api/mcp/zcloak-ledger-mcp-xero-demo/oauth/callback",
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('name="code" value="work-one-time-code"');
    expect(html).toContain('name="state" value="work-outer-state"');
    expect(html).toContain("Return to Work");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script>");
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

describe("Broker browser error page reason mapping", () => {
  it("maps FLOW_ALREADY_COMPLETED to the confident already-connected copy — the only code the Broker reports with actual proof of completion", () => {
    expect(brokerErrorPageReason("FLOW_ALREADY_COMPLETED")).toBe("ALREADY_CONNECTED");
  });

  it("maps FLOW_SELECTION_MISSING to the honest hedge, not a false completion claim", () => {
    // FLOW_SELECTION_MISSING fires whenever a selection is simply no longer
    // available — expired, never reached AWAITING_SELECTION, denied, or a
    // completion this process cannot see — which is not proof of anything.
    // Only FLOW_ALREADY_COMPLETED (above) may claim a completion.
    expect(brokerErrorPageReason("FLOW_SELECTION_MISSING")).toBe("RESTART_REQUIRED");
  });

  it("maps SELECTION_COMPLETE_REJECTED to retry-shortly, not a generic failure", () => {
    expect(brokerErrorPageReason("SELECTION_COMPLETE_REJECTED")).toBe("RETRY_SHORTLY");
  });

  it("maps CONNECTION_NOT_DISCOVERED to restart-required", () => {
    expect(brokerErrorPageReason("CONNECTION_NOT_DISCOVERED")).toBe("RESTART_REQUIRED");
  });

  it("maps HOST_STATE_MISMATCH to the vague unexpected-failure copy, never leaking why", () => {
    expect(brokerErrorPageReason("HOST_STATE_MISMATCH")).toBe("UNEXPECTED");
  });

  it("falls back to restart-required, never already-connected, for any unrecognised or missing resultStatus", () => {
    expect(brokerErrorPageReason(undefined)).toBe("RESTART_REQUIRED");
    expect(brokerErrorPageReason("")).toBe("RESTART_REQUIRED");
    expect(brokerErrorPageReason("SOME_UNKNOWN_FUTURE_CODE")).toBe("RESTART_REQUIRED");
    expect(brokerErrorPageReason("CSRF_OK_SELECTION_TICKET_MISSING_CONNECTION_OK")).toBe("RESTART_REQUIRED");
  });
});

describe("Broker browser error page rendering", () => {
  it("renders distinct, human-readable text a person would actually see for each reason", () => {
    const expectations: Record<BrokerErrorReason, { title: string; mustContain: string[] }> = {
      ALREADY_CONNECTED: {
        title: "Already connected",
        mustContain: ["already completed", "return to your AI assistant", "already be active"],
      },
      RETRY_SHORTLY: {
        title: "Still finishing up",
        mustContain: ["still wrapping up", "wait", "try connecting again"],
      },
      RESTART_REQUIRED: {
        title: "Let&#39;s try that again",
        mustContain: ["no longer valid", "may have expired", "restart the connection"],
      },
      UNEXPECTED: {
        title: "Something went wrong",
        mustContain: ["could not be completed", "restart the connection"],
      },
    };

    const bodies = new Set<string>();
    for (const [reason, expectation] of Object.entries(expectations) as [BrokerErrorReason, typeof expectations[BrokerErrorReason]][]) {
      const html = renderBrokerErrorPage(reason);
      expect(html).toContain(expectation.title);
      for (const phrase of expectation.mustContain) {
        expect(html.toLowerCase()).toContain(phrase.toLowerCase());
      }
      expect(html).toContain('data-page-status="attention"');
      expect(html).not.toContain("<script>");
      bodies.add(html);
    }
    // Four reasons, four textually distinct pages.
    expect(bodies.size).toBe(4);
  });

  it("never renders the internal resultStatus vocabulary into the page a customer sees", () => {
    const internalCodes = [
      "FLOW_ALREADY_COMPLETED",
      "FLOW_SELECTION_MISSING",
      "SELECTION_COMPLETE_REJECTED",
      "CONNECTION_NOT_DISCOVERED",
      "HOST_STATE_MISMATCH",
    ];
    for (const reason of ["ALREADY_CONNECTED", "RETRY_SHORTLY", "RESTART_REQUIRED", "UNEXPECTED"] as const) {
      const html = renderBrokerErrorPage(reason);
      for (const code of internalCodes) {
        expect(html).not.toContain(code);
      }
    }
  });
});
