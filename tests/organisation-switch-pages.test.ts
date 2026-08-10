import { describe, expect, it } from "vitest";
import {
  renderOrganisationSwitchPage,
  renderOrganisationSwitchResultPage,
} from "../src/oauth/brokerPages.js";

describe("Xero organisation switch browser pages", () => {
  it("renders a script-free exact-choice form without exposing internal tenant IDs", () => {
    const html = renderOrganisationSwitchPage({
      ticket: "t".repeat(43),
      csrfToken: "c".repeat(43),
      currentOrganisation: {
        connectionId: "connection-a",
        tenantId: "tenant-a",
        tenantName: "Company <A>",
        current: true,
      },
      organisations: [
        {
          connectionId: "connection-a",
          tenantId: "tenant-a",
          tenantName: "Company <A>",
          current: true,
        },
        {
          connectionId: "connection-b",
          tenantId: "tenant-b",
          tenantName: "Company B",
          current: false,
        },
      ],
      expiresAt: new Date("2026-08-10T04:10:00.000Z"),
    });
    expect(html).toContain('action="/xero/organisation-switch"');
    expect(html).toContain('name="connection_id" value="connection-b"');
    expect(html).toContain("Company &lt;A&gt;");
    expect(html).toContain("Currently connected");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tenant-b</code>");
  });

  it("renders the confirmed organisation and instructs the user to return to the Agent", () => {
    const html = renderOrganisationSwitchResultPage({
      status: "SWITCHED",
      tenantName: "Company B",
    });
    expect(html).toContain("Company B");
    expect(html).toContain("return to the Agent");
  });
});
