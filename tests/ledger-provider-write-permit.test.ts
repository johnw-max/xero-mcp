import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_CONTROL_KERNEL_VERSION,
  type LedgerAutonomousAuthorizationReceipt,
} from "../src/control-kernel/ledgerControlKernel.js";
import { hashObject } from "../src/security/hash.js";
import {
  consumeXeroProviderWritePermit,
  issueXeroProviderWritePermit,
  XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS,
  type XeroProviderWritePermitClaims,
  type XeroProviderWriteAdapterOperation,
} from "../src/security/xeroProviderWritePermit.js";
import { XERO_WRITE_ACTIONS } from "../src/domain/xeroWriteActions.js";

function typescriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) return typescriptFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function authorizationReceipt(
  overrides: Partial<LedgerAutonomousAuthorizationReceipt> = {},
): LedgerAutonomousAuthorizationReceipt {
  const unsigned = {
    receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
    kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
    actionId: "supplier_bill.create_draft",
    providerId: "xero",
    tenantId: "tenant-1",
    actorId: "workspace-1:user:user-1",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    installationId: "installation-1",
    bindingId: "binding-1",
    bindingRevision: 7,
    connectionId: "connection-1",
    targetSessionId: "target-session-1",
    delegationId: "delegation-1",
    delegationRevision: 3,
    canonicalPayloadHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    caseVersion: 2,
    authoritySnapshotRevision: 1,
    authoritySnapshotHash: "e".repeat(64),
    deterministicValidationReceiptHash: "c".repeat(64),
    providerCapabilityReceiptHash: "d".repeat(64),
    issuedAt: "2026-08-13T00:00:00.000Z",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "receiptHash"),
    ),
  };
  return Object.freeze({
    ...unsigned,
    receiptHash: overrides.receiptHash ?? hashObject(unsigned),
  }) as LedgerAutonomousAuthorizationReceipt;
}

function permitFixture(options: {
  adapterOperation?: XeroProviderWriteAdapterOperation;
  receipt?: LedgerAutonomousAuthorizationReceipt;
  mutationRequestId?: string;
  requestPayloadHash?: string;
} = {}) {
  const receipt = options.receipt ?? authorizationReceipt();
  const adapterOperation = options.adapterOperation ??
    "XeroAccountingProvider.createDraftSupplierBill";
  const request = Object.freeze({
    mutationRequestId: options.mutationRequestId ?? "xmr-1",
    canonicalPayloadHash: options.requestPayloadHash ?? receipt.canonicalPayloadHash,
    authorizationReceipt: receipt as unknown as Record<string, unknown>,
  });
  const claims = Object.freeze({
    providerId: "xero" as const,
    adapterOperation,
    actionId: receipt.actionId as XeroProviderWritePermitClaims["actionId"],
    mutationRequestId: request.mutationRequestId,
    canonicalPayloadHash: request.canonicalPayloadHash,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    workspaceId: receipt.workspaceId,
    agentId: receipt.agentId,
    installationId: receipt.installationId,
    bindingId: receipt.bindingId,
    bindingRevision: receipt.bindingRevision,
    connectionId: receipt.connectionId,
    targetSessionId: receipt.targetSessionId,
  }) satisfies Readonly<XeroProviderWritePermitClaims>;
  return {
    claims,
    permit: issueXeroProviderWritePermit({ adapterOperation, request }),
  };
}

describe("LedgerProviderWritePermit architecture", () => {
  it("allows only XeroMutationService to import the production permit issuer", () => {
    const sourceRoot = resolve(process.cwd(), "src");
    const issuerModule = resolve(sourceRoot, "security/xeroProviderWritePermit.ts");
    const importers = typescriptFiles(sourceRoot)
      .filter((path) => path !== issuerModule)
      .filter((path) => readFileSync(path, "utf8").includes("issueXeroProviderWritePermit"))
      .map((path) => path.slice(sourceRoot.length + 1));

    expect(importers).toEqual(["services/xeroMutationService.ts"]);
  });

  it("derives one unique raw adapter mutation for every registered write action", () => {
    const registeredOperations = Object.values(XERO_WRITE_ACTIONS)
      .map((definition) => definition.providerAdapterOperation);
    expect(new Set(XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS)).toEqual(new Set(registeredOperations));
    expect(new Set(XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS).size).toBe(registeredOperations.length);
  });
});

describe("LedgerProviderWritePermit issuer", () => {
  it("derives full claims from a persisted, hash-valid kernel receipt", () => {
    const { permit, claims } = permitFixture();
    expect(Object.keys(permit)).toEqual([]);

    const consumed = consumeXeroProviderWritePermit(permit, claims);
    expect(consumed).toEqual(claims);
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(() => {
      (consumed as { tenantId: string }).tenantId = "other-tenant";
    }).toThrow(TypeError);
  });

  it("accepts the non-case object validation lifecycle version zero", () => {
    const { permit, claims } = permitFixture({ receipt: authorizationReceipt({ caseVersion: 0 }) });
    expect(consumeXeroProviderWritePermit(permit, claims)).toMatchObject({ actionId: claims.actionId });
  });

  it("rejects a tampered receipt, a request-payload mismatch and an adapter/action mismatch", () => {
    const tampered = authorizationReceipt({ receiptHash: "f".repeat(64) });
    expect(() => permitFixture({ receipt: tampered })).toThrow(expect.objectContaining({
      code: "APPROVAL_INVALID",
      details: expect.objectContaining({ permitReason: "AUTHORIZATION_RECEIPT_INVALID" }),
    }));

    expect(() => permitFixture({ requestPayloadHash: "e".repeat(64) })).toThrow(expect.objectContaining({
      code: "APPROVAL_INVALID",
      details: expect.objectContaining({ permitReason: "REQUEST_RECEIPT_MISMATCH" }),
    }));

    expect(() => permitFixture({
      adapterOperation: "XeroControlledMutationProvider.createQuoteDraft",
    })).toThrow(expect.objectContaining({
      code: "APPROVAL_INVALID",
      details: expect.objectContaining({ permitReason: "ADAPTER_ACTION_MISMATCH" }),
    }));
  });
});

describe("LedgerProviderWritePermit one-shot consumption", () => {
  it.each([
    ["adapter operation", { adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice" }, "ADAPTER_OPERATION_MISMATCH"],
    ["payload", { canonicalPayloadHash: "e".repeat(64) }, "PAYLOAD_MISMATCH"],
    ["tenant", { tenantId: "tenant-2" }, "TENANT_MISMATCH"],
    ["connection", { connectionId: "connection-2" }, "CONNECTION_MISMATCH"],
    ["target session", { targetSessionId: "target-session-2" }, "TARGET_SESSION_MISMATCH"],
  ] as const)("poisons the permit after a wrong %s claim", (_label, override, reason) => {
    const { permit, claims } = permitFixture();
    const wrong = Object.freeze({ ...claims, ...override }) as XeroProviderWritePermitClaims;

    expect(() => consumeXeroProviderWritePermit(permit, wrong)).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: reason }),
    }));
    expect(() => consumeXeroProviderWritePermit(permit, claims)).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    }));
  });

  it("allows only one synchronous presentation", () => {
    const { permit, claims } = permitFixture();
    expect(() => consumeXeroProviderWritePermit(permit, claims)).not.toThrow();
    expect(() => consumeXeroProviderWritePermit(permit, claims)).toThrow(expect.objectContaining({
      code: "FORBIDDEN",
      details: expect.objectContaining({ permitReason: "CONSUMED" }),
    }));
  });

  it("allows only one consumer when two microtasks race", async () => {
    const { permit, claims } = permitFixture();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => consumeXeroProviderWritePermit(permit, claims)),
      Promise.resolve().then(() => consumeXeroProviderWritePermit(permit, claims)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toEqual(expect.objectContaining({
      status: "rejected",
      reason: expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({ permitReason: "CONSUMED" }),
      }),
    }));
  });

  it("rejects a reconstructed object without exposing any provider I/O authority", () => {
    const { claims } = permitFixture();
    expect(() => consumeXeroProviderWritePermit(Object.freeze({}) as never, claims)).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({
          providerMutationPossible: false,
          permitReason: "INVALID",
        }),
      }),
    );
  });
});
