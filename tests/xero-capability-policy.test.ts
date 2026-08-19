import { describe, expect, it } from "vitest";
import {
  XERO_BUSINESS_OBJECTS,
  XERO_CAPABILITY_POLICIES,
  listAgentFacingXeroCapabilityPolicies,
  lookupAgentFacingXeroCapabilityDecision,
  type XeroCapabilityActionId,
} from "../src/policy/xeroCapabilityPolicy.js";

function policy(actionId: XeroCapabilityActionId) {
  const result = XERO_CAPABILITY_POLICIES.find((candidate) => candidate.actionId === actionId);
  expect(result, `missing policy for ${actionId}`).toBeDefined();
  return result!;
}

describe("Xero capability and risk policy", () => {
  it("covers every in-scope accounting business object", () => {
    expect(new Set(XERO_CAPABILITY_POLICIES.map((entry) => entry.object))).toEqual(
      new Set(XERO_BUSINESS_OBJECTS),
    );
  });

  it("separates current availability from the risk control required", () => {
    expect(policy("supplier_bill.create_draft")).toMatchObject({
      riskClass: "AUTONOMOUS_CONTROLLED_WRITE",
      releaseDecision: "AVAILABLE_NOW",
    });
    expect(policy("customer_invoice.create_draft")).toMatchObject({
      riskClass: "AUTONOMOUS_CONTROLLED_WRITE",
      releaseDecision: "AVAILABLE_NOW",
    });
    expect(policy("manual_journal.post")).toMatchObject({
      riskClass: "DUAL_APPROVAL",
      releaseDecision: "PREPARE_ONLY",
    });
    expect(policy("payment.create")).toMatchObject({
      riskClass: "DISABLED",
      releaseDecision: "NOT_EXPOSED",
    });
  });

  it("records official API and official MCP coverage without treating them as release approval", () => {
    expect(policy("customer_invoice.create_draft").officialSupport).toMatchObject({
      accountingApi: "READ_WRITE",
      officialMcp: "READ_WRITE",
    });
    expect(policy("purchase_order.create_draft").officialSupport).toMatchObject({
      accountingApi: "READ_WRITE",
      officialMcp: "NOT_LISTED",
    });
    expect(policy("attachment.upload_to_confirmed_draft").officialSupport).toMatchObject({
      accountingApi: "READ_WRITE",
      officialMcp: "NOT_LISTED",
    });
    expect(policy("reconciliation.finalise").officialSupport).toMatchObject({
      accountingApi: "NO_DIRECT_ACTION",
      officialMcp: "NO_DIRECT_ACTION",
    });
  });

  it("exposes an Agent-safe projection with explicit execution controls", () => {
    const agentPolicies = listAgentFacingXeroCapabilityPolicies();
    const supplierDraft = agentPolicies.find(
      (entry) => entry.actionId === "supplier_bill.create_draft",
    );
    const invoiceDraft = agentPolicies.find(
      (entry) => entry.actionId === "customer_invoice.create_draft",
    );
    const invoiceRead = agentPolicies.find(
      (entry) => entry.actionId === "customer_invoice.read_prepare",
    );
    const journalPost = agentPolicies.find((entry) => entry.actionId === "manual_journal.post");

    expect(supplierDraft).toMatchObject({
      knownAction: true,
      policyAllowsExecution: true,
      policyAllowsMutation: true,
      controlRequirement: "STANDING_DELEGATION",
      requiredScopes: ["xero.draft.write"],
      requiredPermissions: ["XERO_DRAFT_WRITE"],
    });
    expect(invoiceDraft).toMatchObject({
      policyAllowsExecution: true,
      policyAllowsMutation: true,
      controlRequirement: "STANDING_DELEGATION",
      requiredScopes: ["xero.draft.write"],
      requiredPermissions: ["XERO_DRAFT_WRITE"],
    });
    expect(invoiceRead).toMatchObject({
      policyAllowsExecution: true,
      policyAllowsMutation: false,
      controlRequirement: "NONE",
      requiredScopes: ["xero.read"],
      requiredPermissions: ["XERO_ACCOUNTING_READ"],
    });
    expect(journalPost).toMatchObject({
      policyAllowsExecution: false,
      policyAllowsMutation: false,
      controlRequirement: "DUAL_APPROVAL",
      requiredScopes: [],
      requiredPermissions: ["XERO_DUAL_APPROVAL"],
    });
    expect(supplierDraft).not.toHaveProperty("officialSupport");
    expect(agentPolicies).toHaveLength(XERO_CAPABILITY_POLICIES.length);
  });

  it("fails closed for unknown action identifiers", () => {
    expect(lookupAgentFacingXeroCapabilityDecision("invoice.raw_post_any_status")).toEqual({
      actionId: "invoice.raw_post_any_status",
      object: "UNKNOWN",
      label: "Unknown Xero action",
      knownAction: false,
      riskClass: "DISABLED",
      releaseDecision: "NOT_EXPOSED",
      controlRequirement: "NOT_PERMITTED",
      policyAllowsExecution: false,
      policyAllowsMutation: false,
      requiredScopes: [],
      requiredPermissions: [],
      instruction: "Unknown Xero action: do not execute or mutate Xero.",
    });
  });

  it("never marks a disabled, dual-approval, or unreleased action executable", () => {
    for (const entry of listAgentFacingXeroCapabilityPolicies()) {
      if (entry.riskClass === "DISABLED" || entry.riskClass === "DUAL_APPROVAL") {
        expect(entry.policyAllowsExecution, entry.actionId).toBe(false);
        expect(entry.policyAllowsMutation, entry.actionId).toBe(false);
      }
      if (entry.releaseDecision !== "AVAILABLE_NOW") {
        expect(entry.policyAllowsExecution, entry.actionId).toBe(false);
        expect(entry.policyAllowsMutation, entry.actionId).toBe(false);
      }
      if (entry.policyAllowsMutation) {
        expect(entry.riskClass, entry.actionId).toBe(
          "AUTONOMOUS_CONTROLLED_WRITE",
        );
      }
    }
  });

  it("separates mark-sent state from actual quote and purchase-order delivery", () => {
    expect(policy("quote.mark_sent")).toMatchObject({
      releaseDecision: "PREPARE_ONLY",
      label: "Mark a quote as SENT without delivering it",
    });
    expect(policy("quote.email_or_dispatch").officialSupport).toMatchObject({
      accountingApi: "NO_DIRECT_ACTION",
      officialMcp: "NO_DIRECT_ACTION",
    });
    expect(policy("purchase_order.mark_sent").label).toContain("without delivering");
    expect(policy("purchase_order.email_or_dispatch").officialSupport.accountingApi).toBe(
      "NO_DIRECT_ACTION",
    );
  });

  it("marks registered extended reads and controlled low-risk writes available while keeping unsafe writes closed", () => {
    for (const actionId of [
      "quote.read_prepare",
      "purchase_order.read_prepare",
      "manual_journal.read_prepare",
      "item.read_prepare",
      "bank_transaction.read_prepare",
    ] as const) {
      expect(policy(actionId)).toMatchObject({
        riskClass: "READ_PREPARE",
        releaseDecision: "AVAILABLE_NOW",
      });
    }

    for (const actionId of [
      "quote.create_draft",
      "purchase_order.create_draft",
      "manual_journal.create_draft",
      "item.create_basic_untracked",
      "contact.create_basic",
      "contact.update_basic",
      "item.update_basic_untracked",
      "credit_note.create_draft",
    ] as const) {
      expect(policy(actionId)).toMatchObject({
        riskClass: "AUTONOMOUS_CONTROLLED_WRITE",
        releaseDecision: "AVAILABLE_NOW",
      });
    }

    for (const actionId of [
      "bank_transaction.create",
    ] as const) {
      expect(policy(actionId).releaseDecision, actionId).not.toBe("AVAILABLE_NOW");
    }
  });

  it("classifies connection metadata, organisation, tax rates, and trial balance as safe reads", () => {
    for (const actionId of [
      "system.connection_status",
      "organisation.read_prepare",
      "tax_rate.read_prepare",
      "report.trial_balance_read",
    ] as const) {
      expect(policy(actionId)).toMatchObject({
        riskClass: "READ_PREPARE",
        releaseDecision: "AVAILABLE_NOW",
      });
    }
  });

  it("reports which write actions a tool can actually reach, separately from policy", () => {
    // proves: the catalog can no longer describe a capability as available while
    // nothing can call it. Six actions were marked AVAILABLE_NOW with rationales
    // describing a complete gated path, and the only exposed write tools bind to
    // the Accounting Case, whose executor dispatches four - so a reader deciding
    // what the agent can do was wrong about six of ten released write actions.
    for (const actionId of [
      "contact.create_basic",
      "credit_note.create_draft",
      "customer_invoice.create_draft",
      "supplier_bill.create_draft",
    ] as const) {
      expect(lookupAgentFacingXeroCapabilityDecision(actionId))
        .toMatchObject({ agentReachableWriteAction: true });
    }
    for (const actionId of [
      "quote.create_draft",
      "purchase_order.create_draft",
      "manual_journal.create_draft",
      "contact.update_basic",
      "item.create_basic_untracked",
      "item.update_basic_untracked",
    ] as const) {
      expect(lookupAgentFacingXeroCapabilityDecision(actionId))
        .toMatchObject({ agentReachableWriteAction: false });
    }
    // Policy permission is a different fact and is unchanged: these actions are
    // still permitted, they are simply not callable yet.
    expect(lookupAgentFacingXeroCapabilityDecision("quote.create_draft")).toMatchObject({
      releaseDecision: "AVAILABLE_NOW",
      policyAllowsMutation: true,
    });
    // Reads are not write actions, so the field does not apply to them.
    expect(lookupAgentFacingXeroCapabilityDecision("report.trial_balance_read"))
      .not.toHaveProperty("agentReachableWriteAction");
  });
});
