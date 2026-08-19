import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import { TOOL_ALLOWLIST } from "../src/mcp/toolNames.js";
import {
  XERO_TOOL_CAPABILITY_ACTION_IDS,
  XERO_TOOL_POLICY_BINDINGS,
} from "../src/mcp/xeroToolCapabilityContract.js";
import {
  lookupAgentFacingXeroCapabilityDecision,
} from "../src/policy/xeroCapabilityPolicy.js";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import type { AccountingService } from "../src/services/accountingService.js";

function registrationBlock(source: string, toolName: string): string {
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`server\\.registerTool\\(\\s*"${escapedToolName}"`, "m");
  const match = marker.exec(source);
  expect(match, `missing createServer registration for ${toolName}`).not.toBeNull();
  const start = match!.index;
  const next = source.indexOf("server.registerTool(", start + match![0].length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("Xero public tool capability release contract", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  it("maps every reviewed allowlist tool to one or more AVAILABLE_NOW actions", () => {
    const fileAllowlist = JSON.parse(
      readFileSync(new URL("../config/tool-allowlist.json", import.meta.url), "utf8"),
    ) as { tools: string[] };
    const codeTools = [...TOOL_ALLOWLIST].sort();

    expect(fileAllowlist.tools.sort()).toEqual(codeTools);
    expect(Object.keys(XERO_TOOL_CAPABILITY_ACTION_IDS).sort()).toEqual(codeTools);
    expect(Object.keys(XERO_TOOL_POLICY_BINDINGS).sort()).toEqual(codeTools);
    expect(codeTools).toHaveLength(29);

    for (const toolName of TOOL_ALLOWLIST) {
      const binding = XERO_TOOL_POLICY_BINDINGS[toolName];
      expect(binding.actionIds.length, toolName).toBeGreaterThan(0);
      for (const actionId of binding.actionIds) {
        expect(
          lookupAgentFacingXeroCapabilityDecision(actionId),
          `${toolName} -> ${actionId}`,
        ).toMatchObject({
          knownAction: true,
          releaseDecision: "AVAILABLE_NOW",
          policyAllowsExecution: true,
        });
      }
    }
  });

  it("allows mutation only through the governed idempotent Accounting Case execute tool", () => {
    const mutatingBindings = Object.values(XERO_TOOL_POLICY_BINDINGS)
      .filter((binding) => binding.mutating);

    expect(mutatingBindings.map((binding) => binding.toolName)).toEqual([
      "xero_execute_accounting_case",
    ]);

    for (const binding of mutatingBindings) {
      expect(binding).toMatchObject({
        riskClass: "AUTONOMOUS_CONTROLLED_WRITE",
        entryMcpScopesAnyOf: ["xero.read", "xero.draft.write"],
        requiredMcpScope: "xero.draft.write",
        requiredPermission: "XERO_DRAFT_WRITE",
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: false,
        },
      });
      for (const actionId of binding.actionIds) {
        expect(lookupAgentFacingXeroCapabilityDecision(actionId)).toMatchObject({
          releaseDecision: "AVAILABLE_NOW",
          riskClass: "AUTONOMOUS_CONTROLLED_WRITE",
          controlRequirement: "STANDING_DELEGATION",
          policyAllowsMutation: true,
        });
      }
    }
  });

  it("marks all persisted preparation tools as stateful and non-idempotent while retaining xero.read", () => {
    const statefulPreparationTools = ["xero_prepare_accounting_case"] as const;

    for (const toolName of statefulPreparationTools) {
      expect(XERO_TOOL_POLICY_BINDINGS[toolName], toolName).toMatchObject({
        riskClass: "READ_PREPARE",
        mutating: false,
        entryMcpScopesAnyOf: ["xero.read"],
        requiredMcpScope: "xero.read",
        requiredPermission: "XERO_ACCOUNTING_READ",
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      });
    }
  });

  it("does not register planned, dual-approval, disabled, payment, bank-write, or reconciliation-finalisation actions", () => {
    for (const binding of Object.values(XERO_TOOL_POLICY_BINDINGS)) {
      for (const actionId of binding.actionIds) {
        const decision = lookupAgentFacingXeroCapabilityDecision(actionId);
        expect(decision.releaseDecision, `${binding.toolName} -> ${actionId}`).toBe(
          "AVAILABLE_NOW",
        );
        expect(
          ["DUAL_APPROVAL", "DISABLED"],
          `${binding.toolName} -> ${actionId}`,
        ).not.toContain(decision.riskClass);
      }
    }

    const forbiddenToolNames = [
      "xero_create_payment",
      "xero_update_payment",
      "xero_delete_payment",
      "xero_create_bank_transaction",
      "xero_update_bank_transaction",
      "xero_delete_bank_transaction",
      "xero_reconcile",
      "xero_finalise_reconciliation",
      "xero_finalize_reconciliation",
      "xero_authorise_invoice",
      "xero_authorise_bill",
      "xero_post_manual_journal",
      "xero_void_invoice",
      "xero_raw_request",
    ];
    expect(TOOL_ALLOWLIST.filter((toolName) => forbiddenToolNames.includes(toolName))).toEqual([]);
  });

  it("keeps registered MCP annotations and entry scopes aligned with policy", async () => {
    const service = {} as AccountingService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "tool-policy-contract",
      audience: "https://xero-mcp.example.test/mcp",
    });
    const server = createAccountingMcpServer(service, context);
    const client = new Client({ name: "tool-policy-contract", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);
    const listedTools = await client.listTools();
    const listedByName = new Map(listedTools.tools.map((tool) => [tool.name, tool]));
    const createServerSource = readFileSync(
      new URL("../src/mcp/createServer.ts", import.meta.url),
      "utf8",
    );

    expect([...listedByName.keys()].sort()).toEqual([...TOOL_ALLOWLIST].sort());
    for (const toolName of TOOL_ALLOWLIST) {
      const binding = XERO_TOOL_POLICY_BINDINGS[toolName];
      expect(listedByName.get(toolName)?.annotations, toolName).toMatchObject(
        binding.annotations,
      );

      const block = registrationBlock(createServerSource, toolName);
      const implementedRequirement = /requiredScope:\s*(\[[^\]]+\]|"(?:xero\.read|xero\.draft\.write)")/u
        .exec(block)?.[1] ?? "";
      const implementedScopes = [...implementedRequirement.matchAll(
        /"(xero\.read|xero\.draft\.write)"/g,
      )].map((match) => match[1]);
      expect(implementedScopes, toolName).toEqual(binding.entryMcpScopesAnyOf);
    }
  });
});
