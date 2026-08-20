import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OFFICIAL_CORE_COMMANDS, inspectCapabilityManifest } from "../scripts/validate-capability-manifest.mjs";
import { AGENT_REACHABLE_WRITE_ACTIONS, CASE_EXECUTOR_PENDING_ACTIONS } from "../src/domain/xeroWriteActions.js";
import { lookupAgentFacingXeroCapabilityDecision } from "../src/policy/xeroCapabilityPolicy.js";

describe("machine-readable Xero capability manifest", () => {
  it("covers the official baseline and tracks the final dynamic public surface", async () => {
    const result = await inspectCapabilityManifest();
    expect(result.status).toBe("PASS");
    expect(result.row_count).toBeGreaterThanOrEqual(OFFICIAL_CORE_COMMANDS.length);
    expect(result.tool_count).toBeGreaterThan(0);
    expect(result.toolset_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.release_gate).toBe(result.not_ready_count === 0 ? "GO" : "NO_GO");
  });

  it("fails the release gate when any SHIP row is marked NOT_READY", async () => {
    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8"));
    const ship = manifest.rows.find((row: { release_disposition?: string }) => row.release_disposition === "SHIP");
    expect(ship).toBeDefined();
    ship.readiness = "NOT_READY";
    ship.readiness_reason = "TEST_FIXTURE_NOT_READY";
    ship.live_uat_evidence = [];

    const result = await inspectCapabilityManifest({ requireReady: true, manifestOverride: manifest });
    expect(result.status).toBe("FAIL");
    expect(result.release_gate).toBe("NO_GO");
    expect(result.errors.some((finding) => finding.endsWith("_SHIP_NOT_READY"))).toBe(true);
  });

  it("describes each newly reachable Case write without claiming live readiness", async () => {
    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8")) as {
      rows: Array<{
        capability_id: string;
        readiness: string;
        public_tool_or_case_action: { tool: string; case_action: string } | null;
        service_dispatch: string | null;
        provider_method: string | null;
        receipt_and_readback: string;
        automated_tests: string[];
        live_uat_evidence: string[];
      }>;
    };
    const reachable = new Set<string>(AGENT_REACHABLE_WRITE_ACTIONS);
    const pending = new Set<string>(CASE_EXECUTOR_PENDING_ACTIONS);
    const rowsByAction = new Map(
      manifest.rows
        .filter((row) => row.public_tool_or_case_action?.tool === "xero_execute_accounting_case")
        .map((row) => [row.public_tool_or_case_action!.case_action, row]),
    );
    for (const actionId of [
      "customer_invoice.update_draft",
      "supplier_bill.update_draft",
      "quote.update_draft",
      "purchase_order.update_draft",
      "credit_note.update_draft",
      "manual_journal.update_draft",
      "tracking_category.create",
      "tracking_category.update",
      "tracking_option.create",
      "tracking_option.update",
      "customer_invoice.void",
      "supplier_bill.void",
      "credit_note.authorise",
      "credit_note.allocate",
      "credit_note.refund",
      "credit_note.unallocate",
      "credit_note.void",
      "manual_journal.void",
      "payment.create",
      "payment.reverse",
      "bank_transaction.create",
      "bank_transaction.update",
      "bank_transaction.reverse",
    ]) {
      const row = rowsByAction.get(actionId);
      expect(row, `missing manifest row for ${actionId}`).toBeDefined();
      expect(reachable.has(actionId), actionId).toBe(true);
      expect(pending.has(actionId), actionId).toBe(false);
      expect(lookupAgentFacingXeroCapabilityDecision(actionId).releaseDecision, actionId).toBe("AVAILABLE_NOW");
      expect(row).toMatchObject({
        readiness: "NOT_READY",
        public_tool_or_case_action: { tool: "xero_execute_accounting_case", case_action: actionId },
        receipt_and_readback: expect.stringContaining("exact_readback"),
        live_uat_evidence: [],
      });
      expect(row!.service_dispatch).not.toContain("PENDING");
      expect(row!.provider_method).not.toContain("NOT_IMPLEMENTED");
      expect(row!.automated_tests.length).toBeGreaterThan(0);
    }
  });

  it("keeps every Agent-reachable write as one independent SHIP row", async () => {
    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8")) as {
      rows: Array<{
        capability_id: string;
        release_disposition: string;
        public_tool_or_case_action: { tool: string; case_action: string } | null;
      }>;
    };
    for (const actionId of AGENT_REACHABLE_WRITE_ACTIONS) {
      const matches = manifest.rows.filter((row) => row.public_tool_or_case_action?.case_action === actionId);
      expect(matches, `manifest rows for ${actionId}`).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        release_disposition: "SHIP",
        public_tool_or_case_action: { tool: "xero_execute_accounting_case", case_action: actionId },
      });
    }
  });

  it("rejects a SHIP row that has no typed public route", async () => {
    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8"));
    const row = manifest.rows.find((candidate: { capability_id?: string }) => candidate.capability_id === "official.list_contact_groups");
    expect(row).toBeDefined();
    row.public_tool_or_case_action = null;

    const result = await inspectCapabilityManifest({ manifestOverride: manifest });
    expect(result.status).toBe("FAIL");
    expect(result.errors.some((finding) => finding.endsWith("_SHIP_WITHOUT_TYPED_ROUTE"))).toBe(true);
  });

  it("rejects aggregating multiple Agent-reachable writes into one row", async () => {
    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8"));
    const row = manifest.rows.find((candidate: { public_tool_or_case_action?: { case_action?: string | string[] } }) =>
      candidate.public_tool_or_case_action?.case_action === "payment.create");
    expect(row).toBeDefined();
    row.public_tool_or_case_action.case_action = ["payment.create", "payment.reverse"];

    const result = await inspectCapabilityManifest({ manifestOverride: manifest });
    expect(result.status).toBe("FAIL");
    expect(result.errors.some((finding) => finding.startsWith("REACHABLE_WRITE_ACTIONS_AGGREGATED:"))).toBe(true);
  });

  it("keeps unsupported payment allocation/refund explicit without fake implementation rows", async () => {
    const decision = lookupAgentFacingXeroCapabilityDecision("payment.allocate");
    expect(decision).toMatchObject({
      releaseDecision: "NOT_EXPOSED",
      policyAllowsExecution: false,
      policyAllowsMutation: false,
    });
    expect(decision.agentReachableWriteAction).toBeUndefined();

    const manifest = JSON.parse(await readFile(new URL("../config/xero-capability-manifest.json", import.meta.url), "utf8")) as {
      rows: Array<{
        capability_id: string;
        release_disposition: string;
        readiness: string;
        public_tool_or_case_action: unknown;
        service_dispatch: string | null;
        provider_method: string | null;
        automated_tests: string[];
        live_uat_evidence: string[];
      }>;
    };
    for (const capabilityId of ["zcloak.payment_allocate", "zcloak.payment_refund"]) {
      const row = manifest.rows.find((candidate) => candidate.capability_id === capabilityId);
      expect(row, `missing manifest row for ${capabilityId}`).toBeDefined();
      expect(row).toMatchObject({
        release_disposition: "LATER_NONCORE",
        readiness: "NOT_APPLICABLE",
        public_tool_or_case_action: null,
        service_dispatch: null,
        automated_tests: [],
        live_uat_evidence: [],
      });
      expect(row!.provider_method).toMatch(/NOT_(IMPLEMENTED|EXPOSED)/u);
    }
  });
});
