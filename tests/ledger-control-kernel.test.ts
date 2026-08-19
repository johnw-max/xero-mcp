import { describe, expect, it } from "vitest";
import {
  LEDGER_CONTROL_KERNEL_VERSION,
  evaluateAutonomousLedgerWrite,
  type EvaluateAutonomousLedgerWriteInput,
  type LedgerStandingDelegation,
} from "../src/control-kernel/ledgerControlKernel.js";

const now = new Date("2026-08-13T00:00:00.000Z");

const delegation: LedgerStandingDelegation = {
  delegationId: "delegation-agent-2-qbo-sandbox",
  revision: 7,
  status: "ACTIVE",
  providerId: "quickbooks",
  workspaceId: "workspace-1",
  agentId: "agent-2",
  installationId: "installation-1",
  tenantIds: ["qbo-sandbox-tenant"],
  actionIds: ["supplier_bill.create_draft"],
  expiresAt: new Date("2026-09-13T00:00:00.000Z"),
};

function validInput(overrides: Partial<EvaluateAutonomousLedgerWriteInput> = {}): EvaluateAutonomousLedgerWriteInput {
  return {
    actionId: "supplier_bill.create_draft",
    canonicalPayloadHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    caseVersion: 3,
    authoritySnapshotRevision: 11,
    authoritySnapshotHash: "e".repeat(64),
    principal: {
      actorId: "workspace-1:user:user-1",
      workspaceId: "workspace-1",
      agentId: "agent-2",
      installationId: "installation-1",
      bindingId: "binding-1",
      bindingRevision: 2,
      connectionId: "connection-1",
    },
    target: {
      providerId: "quickbooks",
      tenantId: "qbo-sandbox-tenant",
      targetSessionId: "target-session-1",
      targetSessionExpiresAt: new Date("2026-08-13T01:00:00.000Z"),
    },
    standingDelegations: [delegation],
    writeKillSwitchEnabled: true,
    staticActionReleased: true,
    transportScopeAllowed: true,
    providerAccessDenyReasons: [],
    providerCapabilityReceiptHash: "d".repeat(64),
    validation: { passed: true, receiptHash: "c".repeat(64) },
    now,
    ...overrides,
  };
}

describe("provider-neutral ledger control kernel", () => {
  it("keeps authorising after the user reconnects when the delegation is not pinned to an installation", () => {
    // Every Xero re-authorisation mints a new installation id. A grant keyed on
    // the installation therefore dies on the next reconnect. Unpinned grants
    // must survive that: the grantee is workspace + agent + tenant.
    const { installationId: _pinned, ...unpinned } = delegation;
    const reconnected = validInput({
      standingDelegations: [unpinned],
      principal: { ...validInput().principal, installationId: "installation-after-reconnect" },
    });
    expect(evaluateAutonomousLedgerWrite(reconnected).allowed).toBe(true);
  });

  it("still refuses a pinned delegation when the installation no longer matches", () => {
    const reconnected = validInput({
      principal: { ...validInput().principal, installationId: "installation-after-reconnect" },
    });
    const result = evaluateAutonomousLedgerWrite(reconnected);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("STANDING_DELEGATION_MISSING");
  });

  it("authorises an exact standing delegation without per-transaction confirmation", () => {
    const result = evaluateAutonomousLedgerWrite(validInput());
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("expected an allowed decision");
    expect(result.receipt).toMatchObject({
      receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION",
      kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
      providerId: "quickbooks",
      tenantId: "qbo-sandbox-tenant",
      delegationId: delegation.delegationId,
      delegationRevision: 7,
      authoritySnapshotRevision: 11,
      authoritySnapshotHash: "e".repeat(64),
    });
    expect(result.receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires a target session even when every other flag is enabled", () => {
    const result = evaluateAutonomousLedgerWrite(validInput({ target: undefined }));
    expect(result).toMatchObject({ allowed: false });
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("TARGET_SESSION_REQUIRED");
  });

  it("denies an expired target before provider execution", () => {
    const input = validInput();
    const result = evaluateAutonomousLedgerWrite(validInput({
      target: { ...input.target!, targetSessionExpiresAt: now },
    }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("TARGET_SESSION_EXPIRED");
  });

  it("does not treat transport scope as standing business authority", () => {
    const result = evaluateAutonomousLedgerWrite(validInput({ standingDelegations: [] }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("STANDING_DELEGATION_MISSING");
  });

  it("rejects the wrong tenant and the wrong action independently", () => {
    const wrongTenant = evaluateAutonomousLedgerWrite(validInput({
      target: { ...validInput().target!, tenantId: "other-tenant" },
    }));
    expect(wrongTenant.allowed).toBe(false);
    if (wrongTenant.allowed) throw new Error("expected a denied decision");
    expect(wrongTenant.denyReasons).toContain("STANDING_DELEGATION_TARGET_MISMATCH");

    const wrongAction = evaluateAutonomousLedgerWrite(validInput({ actionId: "payment.create" }));
    expect(wrongAction.allowed).toBe(false);
    if (wrongAction.allowed) throw new Error("expected a denied decision");
    expect(wrongAction.denyReasons).toContain("STANDING_DELEGATION_ACTION_MISMATCH");
  });

  it("fails closed for revoked or ambiguous delegations", () => {
    const revoked = evaluateAutonomousLedgerWrite(validInput({
      standingDelegations: [{ ...delegation, status: "REVOKED" }],
    }));
    expect(revoked.allowed).toBe(false);
    if (revoked.allowed) throw new Error("expected a denied decision");
    expect(revoked.denyReasons).toContain("STANDING_DELEGATION_REVOKED");

    const ambiguous = evaluateAutonomousLedgerWrite(validInput({
      standingDelegations: [delegation, { ...delegation, delegationId: "delegation-2" }],
    }));
    expect(ambiguous.allowed).toBe(false);
    if (ambiguous.allowed) throw new Error("expected a denied decision");
    expect(ambiguous.denyReasons).toContain("STANDING_DELEGATION_AMBIGUOUS");
  });

  it("selects standing authority by exact tenant and action before checking ambiguity", () => {
    const tenantB = {
      ...delegation,
      delegationId: "delegation-tenant-b",
      tenantIds: ["tenant-b"],
    } satisfies LedgerStandingDelegation;
    const actionB = {
      ...delegation,
      delegationId: "delegation-action-b",
      actionIds: ["customer_invoice.create_draft"],
    } satisfies LedgerStandingDelegation;

    const tenantAResult = evaluateAutonomousLedgerWrite(validInput({
      standingDelegations: [delegation, tenantB, actionB],
    }));
    expect(tenantAResult.allowed).toBe(true);
    if (!tenantAResult.allowed) throw new Error("expected tenant A authority");
    expect(tenantAResult.delegation.delegationId).toBe(delegation.delegationId);

    const tenantBResult = evaluateAutonomousLedgerWrite(validInput({
      target: { ...validInput().target!, tenantId: "tenant-b" },
      standingDelegations: [delegation, tenantB, actionB],
    }));
    expect(tenantBResult.allowed).toBe(true);
    if (!tenantBResult.allowed) throw new Error("expected tenant B authority");
    expect(tenantBResult.delegation.delegationId).toBe(tenantB.delegationId);

    const actionBResult = evaluateAutonomousLedgerWrite(validInput({
      actionId: "customer_invoice.create_draft",
      standingDelegations: [delegation, tenantB, actionB],
    }));
    expect(actionBResult.allowed).toBe(true);
    if (!actionBResult.allowed) throw new Error("expected action B authority");
    expect(actionBResult.delegation.delegationId).toBe(actionB.delegationId);
  });

  it("treats only duplicate exact-scope grants as ambiguous", () => {
    const exactDuplicate = { ...delegation, delegationId: "delegation-exact-duplicate" };
    const otherTenant = { ...delegation, delegationId: "delegation-other-tenant", tenantIds: ["tenant-b"] };
    const result = evaluateAutonomousLedgerWrite(validInput({
      standingDelegations: [delegation, otherTenant, exactDuplicate],
    }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected exact-scope ambiguity");
    expect(result.denyReasons).toContain("STANDING_DELEGATION_AMBIGUOUS");
  });

  it("preserves provider and deterministic validation failure detail", () => {
    const result = evaluateAutonomousLedgerWrite(validInput({
      providerAccessDenyReasons: ["MISSING_PROVIDER_OAUTH_SCOPE"],
      validation: { passed: false, reasonCodes: ["DEBITS_NOT_EQUAL_CREDITS"] },
    }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toEqual(expect.arrayContaining([
      "PROVIDER_ACCESS_DENIED",
      "DETERMINISTIC_VALIDATION_FAILED",
    ]));
    expect(result.providerAccessDenyReasons).toEqual(["MISSING_PROVIDER_OAUTH_SCOPE"]);
    expect(result.validationReasonCodes).toEqual(["DEBITS_NOT_EQUAL_CREDITS"]);
  });

  it("fails closed when the provider-specific live preflight receipt is absent", () => {
    const result = evaluateAutonomousLedgerWrite(validInput({
      providerCapabilityReceiptHash: undefined,
    }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("PROVIDER_CAPABILITY_RECEIPT_MISSING");
  });

  it("keeps the emergency kill switch independent of an active delegation", () => {
    const result = evaluateAutonomousLedgerWrite(validInput({ writeKillSwitchEnabled: false }));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected a denied decision");
    expect(result.denyReasons).toContain("WRITE_KILL_SWITCH_DISABLED");
  });
});
