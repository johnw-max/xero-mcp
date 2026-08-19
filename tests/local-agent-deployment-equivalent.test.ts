import { access, readFile } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_CASE_AGENT_ENABLED_TOOLS,
  AGENT_BUNDLE_SOURCES,
  AGENT_INSTRUCTION_SOURCES,
  AGENT_PROJECT_DOC_BYTE_LIMIT,
  AGENT_SKILL_MOUNTS,
  buildToolContractEvidence,
  createAgentWorkspace,
  runtimeConfiguration,
  verifyAgentBundleEvidence,
} from "../harness/local-agents/agent-workspace.mjs";
import {
  assertRawAgentCommandEvents,
  assertNaturalBusinessPrompt,
  businessPrompt,
} from "../scripts/release/run-local-agent-evidence.mjs";

const repoRoot = process.cwd();

describe("local deployment-equivalent Agent harness", () => {
  it("keeps the user prompt natural and free of tool/internal-id instructions", () => {
    expect(assertNaturalBusinessPrompt()).toBe(true);
    expect(businessPrompt).not.toMatch(/xero_[a-z0-9_]+/iu);
    expect(businessPrompt).not.toMatch(/target_session_ref|provider[_ -]?object[_ -]?id|receipt|回执|Case ID|request ID|TERMINAL/iu);
    expect(businessPrompt).toMatch(/DRAFT/u);
    expect(businessPrompt).toMatch(/授权/u);
  });

  it("permits only pre-business read commands for mounted Skill/reference files", () => {
    const skillPath = `${AGENT_SKILL_MOUNTS[0].root}/${AGENT_SKILL_MOUNTS[0].files[0].path}`;
    const readEvent = (command: string, id = "skill-read") => ({
      type: "item.completed",
      item: { type: "command_execution", id, command, status: "completed", exit_code: 0 },
    });
    expect(assertRawAgentCommandEvents([readEvent(`sed -n '1,200p' ${skillPath}`)])).toEqual({
      command_count: 1,
      paths: [skillPath],
    });
    expect(() => assertRawAgentCommandEvents([readEvent("cat README.md")]))
      .toThrow("LOCAL_AGENT_SKILL_COMMAND_INVALID");
    expect(() => assertRawAgentCommandEvents([readEvent(`cat ${skillPath} > /tmp/skill-copy`)]))
      .toThrow("LOCAL_AGENT_SKILL_COMMAND_INVALID");
    expect(() => assertRawAgentCommandEvents([
      readEvent(`cat ${skillPath}`),
      { type: "item.completed", item: { type: "mcp_tool_call", id: "pin", tool: "xero_pin_current_organisation" } },
      readEvent(`cat ${skillPath}`, "late-read"),
    ])).toThrow("LOCAL_AGENT_SKILL_COMMAND_AFTER_BUSINESS");
  });

  it("unwraps only the exact Codex zsh wrapper and locks absolute reads to one temp workspace root", () => {
    const skillPath = `${AGENT_SKILL_MOUNTS[0].root}/${AGENT_SKILL_MOUNTS[0].files[0].path}`;
    const tempRoot = realpathSync(tmpdir());
    const rootA = join(tempRoot, "xero-local-agent-workspace-test-A");
    const rootB = join(tempRoot, "xero-local-agent-workspace-test-B");
    const commandEvent = (root: string, id: string) => ({
      type: "item.completed",
      item: {
        type: "command_execution",
        id,
        command: `/bin/zsh -lc "sed -n '1,240p' ${root}/${skillPath}"`,
        status: "completed",
        exit_code: 0,
      },
    });
    expect(assertRawAgentCommandEvents([{
      line: 1,
      event: commandEvent(rootA, "wrapped-read"),
    }])).toMatchObject({ command_count: 1, paths: [skillPath] });
    expect(() => assertRawAgentCommandEvents([
      commandEvent(rootA, "read-a"),
      commandEvent(rootB, "read-b"),
    ])).toThrow("LOCAL_AGENT_SKILL_COMMAND_ROOT_DRIFT");
    expect(() => assertRawAgentCommandEvents([{
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "wrong-wrapper",
        command: `/bin/bash -lc "cat ${rootA}/${skillPath}"`,
        status: "completed",
        exit_code: 0,
      },
    }])).toThrow("LOCAL_AGENT_SKILL_COMMAND_INVALID");
  });

  it("composes the final deployment sources and required Skill reference without rewriting their bytes", async () => {
    const workspace = await createAgentWorkspace(repoRoot);
    try {
      const agents = await readFile(workspace.agentsPath);
      const bundleText = agents.toString("utf8");
      expect(workspace.bundle.sources.map((source) => source.path)).toEqual([...AGENT_BUNDLE_SOURCES]);
      expect(workspace.bundle.sources.every((source) =>
        /^[a-f0-9]{64}$/u.test(source.sha256) && source.bytes > 0)).toBe(true);
      expect(agents.length).toBe(workspace.bundle.agents.bytes);
      expect(agents.length).toBeLessThanOrEqual(AGENT_PROJECT_DOC_BYTE_LIMIT);
      for (const mapping of [
        "客户发票 / 销售发票 → `document_type=CUSTOMER_INVOICE`",
        "供应商账单 / 供应商发票 → `document_type=SUPPLIER_BILL`",
        "客户贷项通知单 → `document_type=CUSTOMER_CREDIT_NOTE`",
        "供应商贷项通知单 → `document_type=SUPPLIER_CREDIT_NOTE`",
        "所有行共享同一分类和税务处理 → `line_accounting_mode=DOCUMENT_DEFAULT_FOR_ALL_LINES`",
        "逐行分类或税务处理 → `line_accounting_mode=PER_LINE`",
        "单据日期 / 开票日期 → `document_date`",
      ]) expect(bundleText).toContain(mapping);
      expect(bundleText).toContain("adds no tools, permissions, contacts, or write authority");
      for (const source of workspace.bundle.sources.filter((candidate) =>
        AGENT_INSTRUCTION_SOURCES.includes(candidate.path))) {
        const sourceBytes = await readFile(`${repoRoot}/${source.path}`);
        expect(sourceBytes.length).toBe(source.bytes);
        expect(agents.includes(sourceBytes.toString("utf8"))).toBe(true);
      }
      expect(workspace.bundle.skills.map((skill) => skill.root)).toEqual([
        ".agents/skills/execute-approved-accounting-entry",
        ".agents/skills/prepare-balanced-accounting-entry",
      ]);
      for (const skill of workspace.bundle.skills) {
        for (const mounted of skill.files) {
          const sourceBytes = await readFile(`${repoRoot}/${mounted.source_path}`);
          const mountedBytes = await readFile(`${workspace.root}/${skill.root}/${mounted.path}`);
          expect(mountedBytes.equals(sourceBytes)).toBe(true);
        }
      }
      await expect(verifyAgentBundleEvidence(repoRoot, {
        ...workspace.bundle,
        tool_contract: await buildToolContractEvidence(repoRoot),
      })).resolves.toBeDefined();
    } finally {
      await workspace.dispose();
    }
    await expect(access(workspace.root, fsConstants.F_OK)).rejects.toThrow();
  });

  it("recomputes bundle and tool contract hashes and rejects drift", async () => {
    const workspace = await createAgentWorkspace(repoRoot);
    try {
      const toolContract = await buildToolContractEvidence(repoRoot);
      expect(toolContract.tool_count).toBe(29);
      expect(toolContract.tools).toHaveLength(29);
      expect(toolContract.allowlist.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(toolContract.schema.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const evidence = {
        ...workspace.bundle,
        tool_contract: toolContract,
      };
      await expect(verifyAgentBundleEvidence(repoRoot, evidence)).resolves.toBeDefined();
      await expect(verifyAgentBundleEvidence(repoRoot, {
        ...evidence,
        sources: evidence.sources.map((source, index) => index === 0
          ? { ...source, sha256: "0".repeat(64) }
          : source),
      })).rejects.toThrow("AGENT_BUNDLE_SOURCE_DRIFT");
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps 29 backend tools but exposes only the typed Case profile to Luna", async () => {
    const contract = await buildToolContractEvidence(repoRoot);
    expect(contract.tool_count).toBe(29);
    expect(contract.agent_profile).toEqual({
      profile_id: "xero-accounting-case-write-v1",
      enabled_tools: [...ACCOUNTING_CASE_AGENT_ENABLED_TOOLS],
      backend_tool_count: 29,
    });
  });

  it("uses the Luna/xhigh deployment-equivalent defaults and records overrides", () => {
    expect(runtimeConfiguration({})).toEqual({ model: "gpt-5.6-luna", effort: "xhigh" });
    expect(runtimeConfiguration({ LOCAL_AGENT_MODEL: "test-model", LOCAL_AGENT_EFFORT: "medium" }))
      .toEqual({ model: "test-model", effort: "medium" });
  });
});
