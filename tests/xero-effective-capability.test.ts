import { describe, expect, it } from "vitest";
import {
  evaluateEffectiveXeroCapability,
  type XeroEffectiveCapabilityContext,
} from "../src/policy/xeroEffectiveCapability.js";

const BASE_READ_CONTEXT: XeroEffectiveCapabilityContext = {
  connectionConnected: true,
  connectionId: "connection-1",
  connectionTenantId: "tenant-1",
  boundTenantId: "tenant-1",
  grantedMcpScopes: ["xero.read"],
  grantedPermissions: ["XERO_ACCOUNTING_READ"],
  grantedXeroOAuthScopes: ["accounting.invoices.read"],
  writeGateEnabled: false,
};

const BASE_WRITE_CONTEXT: XeroEffectiveCapabilityContext = {
  ...BASE_READ_CONTEXT,
  grantedMcpScopes: ["xero.draft.write"],
  grantedPermissions: ["XERO_DRAFT_WRITE"],
  grantedXeroOAuthScopes: ["accounting.invoices"],
  writeGateEnabled: true,
  allowedWriteTenantId: "tenant-1",
};

describe("effective Xero capability evaluator", () => {
  it("allows connection-status diagnosis without a connection ID, tenant binding, or Xero accounting scope", () => {
    const disconnectedContext: XeroEffectiveCapabilityContext = {
      connectionConnected: false,
      grantedMcpScopes: ["xero.read"],
      grantedPermissions: ["XERO_ACCOUNTING_READ"],
      grantedXeroOAuthScopes: [],
      writeGateEnabled: false,
    };

    expect(
      evaluateEffectiveXeroCapability("system.connection_status", disconnectedContext),
    ).toMatchObject({
      allowed: true,
      mutation: false,
      denyReasons: [],
      requiredXeroOAuthScopeAnyOf: [],
    });

    const ordinaryRead = evaluateEffectiveXeroCapability(
      "customer_invoice.read_prepare",
      disconnectedContext,
    );
    expect(ordinaryRead.allowed).toBe(false);
    expect(ordinaryRead.denyReasons).toContain("CONNECTION_NOT_READY");
    expect(ordinaryRead.denyReasons).toContain("TENANT_BINDING_MISMATCH");

    expect(evaluateEffectiveXeroCapability("system.connection_status", {
      ...disconnectedContext,
      grantedMcpScopes: [],
    }).denyReasons).toContain("MISSING_MCP_SCOPE");
    expect(evaluateEffectiveXeroCapability("system.connection_status", {
      ...disconnectedContext,
      grantedPermissions: [],
    }).denyReasons).toContain("MISSING_PERMISSION");
  });

  it("allows an available read only when connection, binding, scope, permission, and Xero OAuth scope all pass", () => {
    expect(
      evaluateEffectiveXeroCapability("customer_invoice.read_prepare", BASE_READ_CONTEXT),
    ).toMatchObject({
      allowed: true,
      mutation: false,
      denyReasons: [],
      requiredXeroOAuthScopeAnyOf: [
        [
          "accounting.invoices.read",
          "accounting.invoices",
          "accounting.transactions.read",
          "accounting.transactions",
        ],
      ],
    });
  });

  it.each([
    [
      "connection",
      { ...BASE_READ_CONTEXT, connectionConnected: false },
      "CONNECTION_NOT_READY",
    ],
    [
      "tenant binding",
      { ...BASE_READ_CONTEXT, boundTenantId: "tenant-other" },
      "TENANT_BINDING_MISMATCH",
    ],
    [
      "MCP scope",
      { ...BASE_READ_CONTEXT, grantedMcpScopes: [] },
      "MISSING_MCP_SCOPE",
    ],
    [
      "permission",
      { ...BASE_READ_CONTEXT, grantedPermissions: [] },
      "MISSING_PERMISSION",
    ],
    [
      "Xero OAuth scope",
      { ...BASE_READ_CONTEXT, grantedXeroOAuthScopes: [] },
      "MISSING_XERO_OAUTH_SCOPE",
    ],
  ] as const)("fails closed when an available read lacks %s", (_name, context, reason) => {
    const result = evaluateEffectiveXeroCapability(
      "customer_invoice.read_prepare",
      context,
    );
    expect(result.allowed).toBe(false);
    expect(result.denyReasons).toContain(reason);
  });

  it("allows a controlled draft mutation only when every runtime write control passes", () => {
    expect(
      evaluateEffectiveXeroCapability("supplier_bill.create_draft", BASE_WRITE_CONTEXT),
    ).toMatchObject({
      allowed: true,
      mutation: true,
      denyReasons: [],
      requiredXeroOAuthScopeAnyOf: [["accounting.invoices", "accounting.transactions"]],
    });
  });

  it("accepts granular invoice scopes for quote and purchase-order reads and drafts", () => {
    expect(evaluateEffectiveXeroCapability("quote.read_prepare", {
      ...BASE_READ_CONTEXT,
      grantedXeroOAuthScopes: ["accounting.invoices.read"],
    })).toMatchObject({ allowed: true });
    expect(evaluateEffectiveXeroCapability("purchase_order.create_draft", {
      ...BASE_WRITE_CONTEXT,
      grantedXeroOAuthScopes: ["accounting.invoices"],
    })).toMatchObject({
      allowed: true,
      requiredXeroOAuthScopeAnyOf: [["accounting.invoices", "accounting.transactions"]],
    });
  });

  it.each([
    ["write gate", { ...BASE_WRITE_CONTEXT, writeGateEnabled: false }, "WRITE_GATE_CLOSED"],
    [
      "allowed tenant",
      { ...BASE_WRITE_CONTEXT, allowedWriteTenantId: "tenant-other" },
      "WRITE_TENANT_NOT_ALLOWED",
    ],
    [
      "MCP scope",
      { ...BASE_WRITE_CONTEXT, grantedMcpScopes: [] },
      "MISSING_MCP_SCOPE",
    ],
    [
      "permission",
      { ...BASE_WRITE_CONTEXT, grantedPermissions: [] },
      "MISSING_PERMISSION",
    ],
    [
      "Xero OAuth scope",
      { ...BASE_WRITE_CONTEXT, grantedXeroOAuthScopes: ["accounting.invoices.read"] },
      "MISSING_XERO_OAUTH_SCOPE",
    ],
  ] as const)("fails closed when a draft write lacks %s", (_name, context, reason) => {
    const result = evaluateEffectiveXeroCapability("supplier_bill.create_draft", context);
    expect(result.allowed).toBe(false);
    expect(result.denyReasons).toContain(reason);
  });

  it("allows a released manual-journal draft only with its exact OAuth scope", () => {
    const released = evaluateEffectiveXeroCapability(
      "manual_journal.create_draft",
      {
        ...BASE_WRITE_CONTEXT,
        grantedXeroOAuthScopes: ["accounting.manualjournals"],
      },
    );
    expect(released.allowed).toBe(true);
    expect(released.denyReasons).toEqual([]);
    expect(released.requiredXeroOAuthScopeAnyOf).toEqual([["accounting.manualjournals"]]);
    expect(evaluateEffectiveXeroCapability("manual_journal.create_draft", {
      ...BASE_WRITE_CONTEXT,
      grantedXeroOAuthScopes: ["accounting.transactions"],
    }).denyReasons).toContain("MISSING_XERO_OAUTH_SCOPE");
  });

  it("binds each released controlled-write object to its exact provider scope", () => {
    expect(evaluateEffectiveXeroCapability("credit_note.create_draft", {
      ...BASE_WRITE_CONTEXT,
      grantedXeroOAuthScopes: ["accounting.invoices"],
    })).toMatchObject({
      allowed: true,
      requiredXeroOAuthScopeAnyOf: [["accounting.invoices", "accounting.transactions"]],
    });

    for (const actionId of ["contact.create_basic", "contact.update_basic"]) {
      expect(evaluateEffectiveXeroCapability(actionId, {
        ...BASE_WRITE_CONTEXT,
        grantedXeroOAuthScopes: ["accounting.contacts"],
      })).toMatchObject({
        allowed: true,
        requiredXeroOAuthScopeAnyOf: [["accounting.contacts"]],
      });
      expect(evaluateEffectiveXeroCapability(actionId, {
        ...BASE_WRITE_CONTEXT,
        grantedXeroOAuthScopes: ["accounting.transactions"],
      }).denyReasons).toContain("MISSING_XERO_OAUTH_SCOPE");
    }

    for (const actionId of ["item.create_basic_untracked", "item.update_basic_untracked"]) {
      expect(evaluateEffectiveXeroCapability(actionId, {
        ...BASE_WRITE_CONTEXT,
        grantedXeroOAuthScopes: ["accounting.settings"],
      })).toMatchObject({
        allowed: true,
        requiredXeroOAuthScopeAnyOf: [["accounting.settings"]],
      });
      expect(evaluateEffectiveXeroCapability(actionId, {
        ...BASE_WRITE_CONTEXT,
        grantedXeroOAuthScopes: ["accounting.transactions"],
      }).denyReasons).toContain("MISSING_XERO_OAUTH_SCOPE");
    }
  });

  it("cannot elevate an unknown action with complete runtime grants", () => {
    const unknown = evaluateEffectiveXeroCapability("xero.raw_request", BASE_WRITE_CONTEXT);
    expect(unknown.allowed).toBe(false);
    expect(unknown.denyReasons).toContain("UNKNOWN_ACTION");
    expect(unknown.denyReasons).toContain("POLICY_NOT_AVAILABLE");
  });
});
