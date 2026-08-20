import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_CASE_AGENT_ENABLED_TOOLS,
  AGENT_BUNDLE_SOURCES,
  AGENT_INSTRUCTION_SOURCES,
  AGENT_PROJECT_DOC_BYTE_LIMIT,
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

  // The Codex-era generator could legally read the mounted Skill docs off
  // disk via a bounded set of shell commands before its first business MCP
  // call, and assertRawAgentCommandEvents used to police exactly which files
  // and workspace root those reads were allowed to touch (see the removed
  // "permits only pre-business read commands..." and "unwraps only the exact
  // Codex zsh wrapper..." tests this replaces). The current generator is a
  // deterministic MCP client: it has no instructions document to read at run
  // time and never shells out, so the only thing left to assert is that no
  // such event exists in the transcript at all, in either shape this module
  // accepts a transcript in - a plain array of events, or the `{ line, event
  // }` tuples `parseJsonLines` produces.
  it("rejects any command_execution event in the transcript, in either accepted shape", () => {
    const mcpCallEvent = {
      type: "item.completed",
      item: { type: "mcp_tool_call", id: "pin", tool: "xero_pin_current_organisation", arguments: {}, result: {} },
    };
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", id: "shell-1", command: "cat SKILL.md", status: "completed", exit_code: 0 },
    };
    expect(assertRawAgentCommandEvents([mcpCallEvent])).toBe(true);
    expect(assertRawAgentCommandEvents([{ line: 1, event: mcpCallEvent }])).toBe(true);
    expect(() => assertRawAgentCommandEvents([mcpCallEvent, commandEvent]))
      .toThrow("LOCAL_AGENT_UNEXPECTED_COMMAND_EXECUTION");
    expect(() => assertRawAgentCommandEvents([{ line: 1, event: commandEvent }]))
      .toThrow("LOCAL_AGENT_UNEXPECTED_COMMAND_EXECUTION");
    expect(() => assertRawAgentCommandEvents("not-an-array" as never))
      .toThrow("LOCAL_AGENT_TRANSCRIPT_INVALID");
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
      expect(toolContract.tool_count).toBe(30);
      expect(toolContract.tools).toHaveLength(30);
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

  it("keeps 30 backend tools but exposes only the typed Case profile to Luna", async () => {
    const contract = await buildToolContractEvidence(repoRoot);
    expect(contract.tool_count).toBe(30);
    expect(contract.agent_profile).toEqual({
      profile_id: "xero-accounting-case-write-v1",
      enabled_tools: [...ACCOUNTING_CASE_AGENT_ENABLED_TOOLS],
      backend_tool_count: 30,
    });
  });

  it("uses the Luna/xhigh deployment-equivalent defaults and records overrides", () => {
    expect(runtimeConfiguration({})).toEqual({ model: "gpt-5.6-luna", effort: "xhigh" });
    expect(runtimeConfiguration({ LOCAL_AGENT_MODEL: "test-model", LOCAL_AGENT_EFFORT: "medium" }))
      .toEqual({ model: "test-model", effort: "medium" });
  });
});
