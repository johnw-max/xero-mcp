import { describe, expect, it } from "vitest";
import {
  buildNormalizedXeroReadEvidence,
  getXeroReadEvidenceProfile,
} from "../src/mcp/xeroReadEvidence.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";

const context = createLegacySharedBearerRequestContext({
  actorId: "extended-read-evidence-actor",
  audience: "https://xero-mcp.example.test/mcp",
  scopes: ["xero.read"],
});

const tenantContext = {
  actorId: context.actorId,
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantName: "Extended Read Evidence Company",
};

describe("extended Xero read evidence profiles", () => {
  it("registers every newly public read with an observed-at, bound-target evidence profile", () => {
    const expected = {
      xero_list_journals: "ledger.journal.read",
      xero_get_payment: "ledger.object.read_exact",
      xero_list_tracking_categories: "ledger.reference.tracking.read",
      xero_list_contact_groups: "ledger.reference.contact_group.read",
      xero_get_profit_and_loss: "ledger.report.profit_and_loss.read",
      xero_get_balance_sheet: "ledger.report.balance_sheet.read",
      xero_get_aged_receivables: "ledger.report.aged_receivables.read",
      xero_get_aged_payables: "ledger.report.aged_payables.read",
    } as const;

    for (const [toolName, capabilityId] of Object.entries(expected)) {
      expect(getXeroReadEvidenceProfile(toolName), toolName).toBeDefined();
      const evidence = buildNormalizedXeroReadEvidence({
        toolName,
        auditCallId: `call-${toolName}`,
        requestContext: context,
        tenantContext,
        input: {},
        safeResult: { pagination: { page: 1, returned: 0, hasNextPage: false } },
        observedAt: new Date("2026-08-20T04:00:00.000Z"),
      });
      expect(evidence).toMatchObject({
        capability_id: capabilityId,
        destination_role: "ledger_sor",
        observed_at: "2026-08-20T04:00:00.000Z",
      });
      expect(evidence?.bound_target_ref_safe).toMatch(/^xero-target:/u);
    }
  });

  it("does not attach Trial-Balance-only defaults to other reports", () => {
    const evidence = buildNormalizedXeroReadEvidence({
      toolName: "xero_get_profit_and_loss",
      auditCallId: "call-profit-and-loss",
      requestContext: context,
      tenantContext,
      input: { date_from: "2026-01-01", date_to: "2026-01-31", periods: 1, timeframe: "MONTH" },
      safeResult: { reports: [{ reportName: "Profit and Loss" }] },
    });
    const effectiveQuery = evidence?.query_bounds.effective_provider_query as Record<string, unknown>;

    expect(effectiveQuery).toMatchObject({
      report_capability: "ledger.report.profit_and_loss.read",
      reviewed_parameters: { date_from: "2026-01-01", date_to: "2026-01-31", periods: 1, timeframe: "MONTH" },
    });
    expect(effectiveQuery).not.toHaveProperty("paymentsOnly");
  });
});
