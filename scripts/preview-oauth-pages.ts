import { createServer } from "node:http";
import {
  renderOrganisationSwitchPage,
  renderOrganisationSwitchResultPage,
  renderXeroOrganisationSelectionPage,
} from "../src/oauth/brokerPages.js";

const port = 4_187;

createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "POST") {
    response.end(renderOrganisationSwitchResultPage({ status: "SWITCHED", tenantName: "zcloak" }));
    return;
  }
  if (request.url === "/select") {
    response.end(renderXeroOrganisationSelectionPage({
      organisations: [
        { connectionId: "demo", tenantId: "demo-id", tenantName: "Demo Company (Global)", tenantType: "ORGANISATION" },
        { connectionId: "zcloak", tenantId: "zcloak-id", tenantName: "zcloak", tenantType: "ORGANISATION" },
      ],
      csrfToken: "preview-only",
      requestedScopes: ["xero.read", "xero.draft.write"],
      personalPocOnly: false,
    }));
    return;
  }
  response.end(renderOrganisationSwitchPage({
    ticket: "preview-ticket",
    csrfToken: "preview-only",
    currentOrganisation: { connectionId: "demo", tenantId: "demo-id", tenantName: "Demo Company (Global)", current: true },
    organisations: [
      { connectionId: "demo", tenantId: "demo-id", tenantName: "Demo Company (Global)", current: true },
      { connectionId: "zcloak", tenantId: "zcloak-id", tenantName: "zcloak", current: false },
    ],
    expiresAt: new Date(Date.now() + 10 * 60_000),
  }));
}).listen(port, "127.0.0.1", () => {
  console.log(`OAuth page preview: http://127.0.0.1:${port}/select`);
});
