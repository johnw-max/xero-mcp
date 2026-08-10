import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLegacySharedBearerRequestContext } from "../src/security/requestContext.js";
import {
  createQuickBooksMcpServer,
  QUICKBOOKS_TOOL_ALLOWLIST,
} from "../src/quickbooks/mcp.js";
import type { QuickBooksWorkflowService } from "../src/quickbooks/service.js";

describe("QuickBooks MCP surface", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  it("exposes reviewed read and prepare tools but no Agent approval/post tool", async () => {
    const service = {} as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "actor-a",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read", "quickbooks.bill.prepare"],
    });
    const server = createQuickBooksMcpServer(service, context);
    const client = new Client({ name: "qbo-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names.sort()).toEqual([...QUICKBOOKS_TOOL_ALLOWLIST].sort());
    expect(names).toHaveLength(15);
    expect(names.some((name) => /approve|post|create/.test(name))).toBe(false);
  });

  it("hashes uploaded source text without storing it", async () => {
    const hashSourceDocument = vi.fn().mockReturnValue({
      sourceRef: "invoice.txt",
      algorithm: "sha256",
      sha256: "a".repeat(64),
      utf8ByteLength: 7,
      evidenceType: "AGENT_SUPPLIED_TEXT_FINGERPRINT",
      originalFileVerified: false,
      storedByQuickBooksMcp: false,
    });
    const service = { hashSourceDocument } as unknown as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "prepare-actor",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.bill.prepare"],
    });
    const server = createQuickBooksMcpServer(service, context);
    const client = new Client({ name: "qbo-hash-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "quickbooks_hash_source_document",
      arguments: { source_ref: "invoice.txt", content: "USD 148" },
    });

    expect(result.isError).not.toBe(true);
    expect(hashSourceDocument).toHaveBeenCalledWith({ source_ref: "invoice.txt", content: "USD 148" });
    expect(JSON.stringify(result.content)).toContain("originalFileVerified");
  });

  it("routes a prepared bill only when the installation has prepare scope", async () => {
    const prepareSupplierBill = vi.fn().mockResolvedValue({ postingRequestId: "qbp_1", state: "PREPARED" });
    const service = { prepareSupplierBill } as unknown as QuickBooksWorkflowService;
    const context = createLegacySharedBearerRequestContext({
      actorId: "read-only-actor",
      audience: "https://agent2.zcloak.ai/quickbooks/mcp",
      scopes: ["quickbooks.read"],
    });
    const server = createQuickBooksMcpServer(service, context);
    const client = new Client({ name: "qbo-scope-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport as unknown as Transport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "quickbooks_prepare_supplier_bill",
      arguments: {
        request_id: "case-quickbooks-001",
        source_ref: "invoice.pdf",
        source_sha256: "a".repeat(64),
        vendor_id: "56",
        txn_date: "2026-08-05",
        doc_number: "INV-001",
        global_tax_calculation: "NotApplicable",
        invoice_total: "100.00",
        tax_total: "0.00",
        lines: [{ account_id: "7", amount: "100.00" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("quickbooks.bill.prepare");
    expect(prepareSupplierBill).not.toHaveBeenCalled();
  });
});
