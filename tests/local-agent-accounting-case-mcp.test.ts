import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { executeLocalAgentTargetSessionNegativeSuite } from "../harness/runners/run-p0-accounting-case.js";

function resultPayload(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("MCP response is not an object");
  }
  const envelope = response as { isError?: unknown; structuredContent?: unknown };
  expect(envelope.isError).not.toBe(true);
  const structured = envelope.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured) ||
      !("result" in structured)) {
    throw new Error("MCP response has no structured result");
  }
  const result = (structured as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("MCP structured result is not an object");
  }
  return result as Record<string, unknown>;
}

async function withDeadline<T>(
  label: string,
  operation: Promise<T>,
  childStderr: string[],
  timeoutMs = 15_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Local Agent MCP ${label} exceeded ${timeoutMs}ms.${childStderr.length > 0
            ? ` Child stderr: ${childStderr.join("")}`
            : " Child stderr was empty."}`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("local Agent Accounting Case MCP transport", () => {
  it("pins and verifies one server-issued target before prepare, execute, status over real STDIO", async () => {
    const temporaryDirectory = await mkdtemp(resolve(".xero-local-agent-mcp-"));
    const auditPath = join(temporaryDirectory, "server-audit.json");
    const serverBundlePath = join(temporaryDirectory, "serve-accounting-case-mcp.mjs");
    await build({
      entryPoints: [resolve("harness/local-agents/serve-accounting-case-mcp.ts")],
      outfile: serverBundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverBundlePath],
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment,
        LOCAL_AGENT_SERVER_AUDIT_PATH: auditPath,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "local-agent-target-session-regression", version: "1.0.0" });
    const childStderr: string[] = [];
    transport.stderr?.on("data", (chunk) => childStderr.push(String(chunk)));

    try {
      await withDeadline("connect", client.connect(transport), childStderr);
      const pinned = resultPayload(await client.callTool({
        name: "xero_pin_current_organisation",
        arguments: {},
      }));
      const targetSessionRef = pinned.target_session_ref;
      expect(targetSessionRef).toMatch(/^xts_[A-Za-z0-9_-]{43}$/u);
      expect(pinned).toMatchObject({
        organisation_name: "Synthetic Case Company",
        binding_revision: 1,
      });

      const organisation = resultPayload(await client.callTool({
        name: "xero_get_organisation",
        arguments: { target_session_ref: targetSessionRef },
      }));
      expect(organisation).toMatchObject({
        name: "Synthetic Case Company",
        baseCurrency: "SGD",
      });

      const prepared = resultPayload(await client.callTool({
        name: "xero_prepare_accounting_case",
        arguments: {
          target_session_ref: targetSessionRef,
          case_id: "local-agent-target-session-regression",
          expected_version: 0,
          source_label: "One bounded synthetic customer invoice",
          source_set_complete: true,
          documents: [{
            document_type: "CUSTOMER_INVOICE",
            reference: "INV-TARGET-SESSION-REGRESSION",
            reference_kind: "FORMAL_DOCUMENT_NUMBER",
            document_date: "2026-07-20",
            due_date: "2026-08-20",
            currency: "SGD",
            contact: { name: "Exact Customer" },
            lines: [{
              description: "Synthetic consulting service",
              quantity: "1",
              unit_amount_excluding_tax: "100.00",
              source_tax_amount: "9.00",
              account_code: "200",
              tax_type: "OUTPUTY24",
            }],
            declared_net: "100.00",
            declared_tax: "9.00",
            declared_gross: "109.00",
            document_validity: "TEST_OR_NOT_VALID",
          }],
        },
      }));
      expect(prepared.state).toBe("PLANNED_NEEDS_PREFLIGHT");
      expect((prepared.completion_claim as { ledger_write_claim?: unknown }).ledger_write_claim).toBe("NOT_WRITTEN");
      const expectedSourceClaim = {
        trust: "UNVERIFIED_SUBMITTED_FACTS",
        source_truth_claim: "NOT_VERIFIED",
        original_file_verified: false,
        fact_origins: ["MODEL_EXTRACTED"],
        document_validity_basis: "SUBMITTED_ASSERTION",
        // A sentence the caller can repeat verbatim, so a Xero readback is not
        // relayed to an accountant as if the original document had been checked.
        verification_scope_note: expect.stringContaining("does not check those figures against the original document"),
      };
      expect(prepared.source_claim).toEqual(expectedSourceClaim);

      const executed = resultPayload(await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: {
          target_session_ref: targetSessionRef,
          case_id: "local-agent-target-session-regression",
          case_version: 1,
          request_id: "local-agent-target-session-regression-execute",
        },
      }));
      expect(executed.state).toBe("TERMINAL");
      expect(executed.source_claim).toEqual(expectedSourceClaim);

      const status = resultPayload(await client.callTool({
        name: "xero_get_accounting_case_status",
        arguments: {
          target_session_ref: targetSessionRef,
          case_id: "local-agent-target-session-regression",
          case_version: 1,
        },
      }));
      expect(status.state).toBe("TERMINAL");
      expect(status.source_claim).toEqual(expectedSourceClaim);
      expect((status.operations as Array<Record<string, unknown>>)[0]).toMatchObject({
        state: "READBACK_VERIFIED",
        provider_receipt_recorded: true,
        exact_readback_recorded: true,
      });

      const audit = JSON.parse(await readFile(auditPath, "utf8")) as {
        target_session_evidence?: Record<string, unknown>;
        mcp_protocol_calls?: Array<Record<string, unknown>>;
        tool_calls?: Array<Record<string, unknown>>;
        provider_write_count?: unknown;
        durable_evidence?: Record<string, unknown>;
      };
      expect(audit.target_session_evidence).toMatchObject({
        status: "PASS",
        issuance_tool: "xero_pin_current_organisation",
        base_context_unpinned: true,
        raw_capability_persisted_in_server_audit: false,
      });
      expect(audit.mcp_protocol_calls?.map((call) => call.tool)).toEqual([
        "xero_pin_current_organisation",
        "xero_get_organisation",
        "xero_prepare_accounting_case",
        "xero_execute_accounting_case",
        "xero_get_accounting_case_status",
      ]);
      expect(audit.tool_calls?.map((call) => call.tool)).toEqual([
        "xero_pin_current_organisation",
        "xero_get_organisation",
        "xero_prepare_accounting_case",
        "xero_execute_accounting_case",
        "xero_get_accounting_case_status",
      ]);
      expect(audit.provider_write_count).toBe(1);
      expect(JSON.stringify(audit)).not.toContain(String(targetSessionRef));
      const targetHashes = audit.mcp_protocol_calls
        ?.map((call) => call.target_session_ref_hash)
        .filter((value): value is string => typeof value === "string");
      expect(targetHashes).toHaveLength(5);
      expect(new Set(targetHashes).size).toBe(1);
      expect(targetHashes?.every((hash) => /^[a-f0-9]{64}$/u.test(hash))).toBe(true);
      expect(audit.durable_evidence).toMatchObject({
        case_id: "local-agent-target-session-regression",
        case_version: 1,
        case_state: "TERMINAL",
        operation_state: "READBACK_VERIFIED",
      });
    } finally {
      await client.close().catch(() => undefined);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed at the direct MCP boundary for missing, expired, cross-principal and stale target refs", async () => {
    const result = await executeLocalAgentTargetSessionNegativeSuite();
    expect(result.providerWriteAttempts).toBe(0);
    expect(result.cases).toEqual([
      "MISSING_TARGET_SESSION_REF",
      "WRONG_ACTOR_TARGET_SESSION_REF",
      "WRONG_WORKSPACE_TARGET_SESSION_REF",
      "WRONG_INSTALLATION_TARGET_SESSION_REF",
      "STALE_BINDING_REVISION_PIN",
      "EXPIRED_TARGET_SESSION_REF",
      "ORGANISATION_SWITCH_STALE_TARGET_SESSION_REF",
    ].map((scenario) => ({ scenario, status: "PASS" })));
    expect(result.conversationBindingResidual).toBe("NO_TRUSTED_SERVER_CONVERSATION_ID_AVAILABLE");
  });
});
