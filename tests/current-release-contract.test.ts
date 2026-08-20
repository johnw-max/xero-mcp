import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_ALLOWLIST } from "../src/mcp/toolNames.js";
import { hashObject } from "../src/security/hash.js";
import { XERO_RELEASE_ATTESTATION } from "../src/xeroRelease.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function text(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

function json<T>(path: string): T {
  return JSON.parse(text(path)) as T;
}

const caseTools = [
  "xero_prepare_accounting_case",
  "xero_execute_accounting_case",
  "xero_get_accounting_case_status",
];

const legacyObjectMutationTools = [
  "xero_prepare_supplier_bill_draft",
  "xero_create_draft_supplier_bill",
  "xero_prepare_sales_invoice_draft",
  "xero_create_draft_sales_invoice",
  "xero_prepare_credit_note_draft",
  "xero_create_credit_note_draft",
  "xero_prepare_manual_journal_draft",
  "xero_create_manual_journal_draft",
  "xero_prepare_quote_draft",
  "xero_create_quote_draft",
  "xero_prepare_purchase_order_draft",
  "xero_create_purchase_order_draft",
  "xero_prepare_contact_create",
  "xero_create_contact",
  "xero_prepare_contact_update",
  "xero_update_contact",
  "xero_prepare_item_create",
  "xero_create_item",
  "xero_prepare_item_update",
  "xero_update_item",
];

describe("current 0.4.0-rc.1 release materials", () => {
  it("derives the current allowlist and Case authority model from current release sources", () => {
    const allowlist = json<{ tools: string[] }>("config/tool-allowlist.json").tools;
    const expected = json<string[]>("tests/contract/expected-tools.json");
    const contract = json<{
      releaseVersion: string;
      requiredMigration: string;
      authorityModel: string;
      expectedTools: string[];
      forbiddenPublicTools: string[];
    }>("harness/manifests/contract-v1.json");

    expect(allowlist).toEqual([...TOOL_ALLOWLIST]);
    expect(expected).toEqual(allowlist);
    expect(contract.releaseVersion).toBe("0.4.0-rc.1");
    expect(contract.requiredMigration).toBe("042_accounting_case_ledger_state_transitions.sql");
    expect(contract.requiredMigration).toBe(XERO_RELEASE_ATTESTATION.requiredMigration);
    expect(contract.authorityModel).toBe("OAUTH_TARGET_BOUND_WRITE_GATE");
    expect(contract.expectedTools).toEqual(allowlist);
    expect(allowlist).toEqual([...TOOL_ALLOWLIST]);
    expect(caseTools.every((tool) => allowlist.includes(tool))).toBe(true);
    expect(legacyObjectMutationTools.some((tool) => allowlist.includes(tool))).toBe(false);
    expect(contract.forbiddenPublicTools).toEqual(legacyObjectMutationTools);
    expect(hashObject(allowlist)).toBe(hashObject([...TOOL_ALLOWLIST]));
  });

  it("uses only the three current Accounting Case scenario manifests", () => {
    const suite = json<{
      scenario_manifests: string[];
      legacy_internal_manifests: string[];
    }>("harness/manifests/p0-suite.json");
    expect(suite.scenario_manifests).toEqual([
      "harness/scenarios/accounting-case-deterministic.p0.json",
      "harness/scenarios/accounting-case-agent2.p0.json",
      "harness/scenarios/accounting-case-browser.p0.json",
    ]);
    expect(suite.legacy_internal_manifests).toEqual(expect.arrayContaining([
      "harness/scenarios/deterministic-contract.p0.json",
      "harness/scenarios/agent2-behavior.p0.json",
      "harness/scenarios/final-browser-signatures.json",
    ]));
  });

  it("has no per-transaction confirmation key in any current release contract", () => {
    const currentFiles = [
      "README.md",
      "docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md",
      "harness/manifests/contract-v1.json",
      "harness/manifests/p0-suite.json",
      "harness/manifests/personas.json",
      "harness/manifests/oracle-policy.json",
      "harness/manifests/claim-guardrails.json",
      "harness/manifests/expected-reds.json",
      "harness/scenarios/accounting-case-deterministic.p0.json",
      "harness/scenarios/accounting-case-agent2.p0.json",
      "harness/scenarios/accounting-case-browser.p0.json",
      "harness/runners/run-contract.ts",
      "harness/runners/run-p0-accounting-case.ts",
      "harness/runners/run-p0-readonly.ts",
      "harness/remote-agents/manifests/live-readonly.template.json",
      "harness/remote-agents/manifests/mock-write-no-retry.json",
      "harness/remote-agents/manifests/agent2-xero-v040rc-accounting-case-uat.template.json",
    ];
    for (const path of currentFiles) {
      const current = text(path);
      expect(current, path).not.toContain("confirmation_phrase");
      expect(current, path).not.toContain("user_confirmation");
    }
  });

  it("keeps the current plain-language capability entry on the 0.4 Case contract", () => {
    const capability = text("docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md");
    expect(capability).toContain("候选版本：`0.4.0-rc.1`，尚未上线");
    expect(capability).toContain("`NO-GO`");
    expect(capability).toContain("provider receipt + exact read-back");
    expect(capability).toContain("只有切换 Xero Organisation 需要用户操作网页");
    expect(capability).not.toContain("用户输入当前提案的一次性确认句");
    expect(capability).not.toContain("10 组写入已统一为服务端一次性 Preparation");
    expect(capability).not.toContain("补齐 Host 级签名确认");
  });

  it("keeps the deployed Agent profile on typed Case tools and the R1 OAuth target/write-gate contract", () => {
    const configRoot = "agent-skills/accounting-double-entry-skills-2026-08-10/agent-config";
    const instructions = text(`${configRoot}/accounting-agent-instructions.md`);
    const profile = text(`${configRoot}/connector-profiles/xero.md`);
    const capabilityContract = text(`${configRoot}/capability-contract.md`);
    const deploymentAllowlist = text(`${configRoot}/mcp-tool-allowlist.md`);

    expect(instructions).toContain("typed Accounting Case");
    expect(instructions).toContain("OAuth binding, pinned target session, effective scope, released action policy and server write gate");
    expect(instructions).toContain("do not request or invent a per-transaction confirmation phrase");
    expect(instructions).not.toContain("explicitly requested, human-approved");

    for (const mapping of [
      "客户发票 / 销售发票 → `document_type=CUSTOMER_INVOICE`",
      "供应商账单 / 供应商发票 → `document_type=SUPPLIER_BILL`",
      "客户贷项通知单 → `document_type=CUSTOMER_CREDIT_NOTE`",
      "供应商贷项通知单 → `document_type=SUPPLIER_CREDIT_NOTE`",
      "所有行共享同一分类和税务处理 → `line_accounting_mode=DOCUMENT_DEFAULT_FOR_ALL_LINES`",
      "逐行分类或税务处理 → `line_accounting_mode=PER_LINE`",
      "单据日期 / 开票日期 → `document_date`",
    ]) expect(instructions).toContain(mapping);
    expect(instructions).toContain("adds no tools, permissions, contacts, or write authority");
    expect(instructions).toContain("Never send a business alias such as `INVOICE` as `document_type`");
    expect(instructions).toContain("never send the alias `issue_date`");

    for (const tool of caseTools) {
      expect(profile, tool).toContain(`\`${tool}\``);
      expect(deploymentAllowlist, tool).toContain(`\`${tool}\``);
    }
    for (const tool of legacyObjectMutationTools) expect(profile, tool).not.toContain(tool);
    expect(profile).toContain("never pin a numeric count");
    expect(profile).toContain("provider object ID/receipt");
    expect(profile).toContain("read back exactly");
    expect(profile).toContain("The only user confirmation flow");
    expect(deploymentAllowlist).toContain("current OAuth binding and pinned target session");

    for (const capability of [
      "ledger.accounting_case.prepare",
      "ledger.accounting_case.execute",
      "ledger.accounting_case.status.read",
    ]) expect(capabilityContract).toContain(capability);
  });

  it("keeps the R1 Xero authorization contract free of extra user confirmation and preserves recovery", () => {
    const configRoot = "agent-skills/accounting-double-entry-skills-2026-08-10/agent-config";
    const skill = text(`${configRoot}/../accounting-agent/skills/execute-approved-accounting-entry/SKILL.md`);
    const instructions = text(`${configRoot}/accounting-agent-instructions.md`);
    const capabilityContract = text(`${configRoot}/capability-contract.md`);
    const profile = text(`${configRoot}/connector-profiles/xero.md`);
    const authorizationFiles = [skill, instructions, capabilityContract, profile];

    for (const content of authorizationFiles) {
      expect(content).toContain("OAuth");
      expect(content).toContain("write gate");
      expect(content).not.toContain("standing delegation");
    }

    expect(skill).toContain("organisation-selection URL is the only user confirmation flow");
    expect(capabilityContract).toContain("organisation-selection URL is the only user confirmation flow");
    expect(profile).toContain("Do not add confirmation phrases");
    expect(instructions).toContain("The only user confirmation is the existing organisation-selection URL");
  });

  it("keeps 0.3.x and 44-tool records explicitly historical instead of rewriting them", () => {
    const oldRemote = json<{ lifecycle: string; supersededBy: string }>(
      "harness/remote-agents/manifests/agent2-production-current-readonly-2026-08-06.json",
    );
    const oldV030 = json<{ lifecycle: string; supersededBy: string }>(
      "harness/remote-agents/manifests/agent2-xero-v030-business-readonly-prepare-first-2026-08-08.json",
    );
    expect(oldRemote.lifecycle).toMatch(/^HISTORICAL_0_3/u);
    expect(oldV030.lifecycle).toMatch(/^HISTORICAL_0_3/u);
    expect(oldRemote.supersededBy).toBe("agent2-xero-v040rc-accounting-case-uat.template.json");
    expect(oldV030.supersededBy).toBe("agent2-xero-v040rc-accounting-case-uat.template.json");
    const script = text("scripts/agent2_uat_write_gate_vps.sh");
    expect(script).toContain("HISTORICAL 0.3.1 UAT SCRIPT ONLY");
    expect(script).toContain('readonly EXPECTED_TOOL_COUNT="44"');
  });
});
