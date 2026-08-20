import { describe, expect, it } from "vitest";
import {
  evaluateAutonomousLedgerWrite,
  type EvaluateAutonomousLedgerWriteInput,
  type LedgerFirmGovernanceClaim,
} from "../src/control-kernel/ledgerControlKernel.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import {
  createLedgerAuthoritySnapshot,
  ledgerFirmGovernanceReadinessEvidence,
} from "../src/domain/ledgerAuthority.js";
import { selectXeroFirmGovernanceClaim } from "../src/policy/xeroFirmGovernanceClaim.js";
import {
  verifyXeroExternalGovernanceAuthority,
  xeroStandingDelegationsWithExternalGovernance,
} from
  "../src/policy/xeroExternalGovernanceAuthority.js";
import { createTestXeroGovernanceArtifacts } from "./helpers/xeroGovernanceAuthority.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const serviceNow = new Date("2026-08-14T00:30:00.000Z");

function fixture(delegationExpiresAt?: Date) {
  const governance = createTestXeroGovernanceArtifacts(tenantId);
  const authority = verifyXeroExternalGovernanceAuthority({
    trustBundle: governance.trustBundle,
    receipts: governance.receipts,
    status: governance.status,
    expectedTrustBundleSha256: governance.expectedTrustBundleSha256,
    expectedReceiptsSha256: governance.expectedReceiptsSha256,
    expectedStatusSha256: governance.expectedStatusSha256,
    now: new Date("2026-08-14T00:00:00.000Z"),
  });
  const delegations = xeroStandingDelegationsWithExternalGovernance(authority, [{
    delegationId: "governed-delegation",
    revision: 1,
    status: "ACTIVE",
    providerId: "xero",
    workspaceId: "workspace-test",
    agentId: "agent-test",
    installationId: "installation-test",
    tenantIds: [tenantId],
    actionIds: ["supplier_bill.create_draft"],
    ...(delegationExpiresAt ? { expiresAt: delegationExpiresAt } : {}),
    firmGovernanceRequired: true,
  }]);
  const snapshot = createLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 11,
    writeKillSwitchEnabled: true,
    standingDelegations: delegations,
    publishedAt: serviceNow,
  });
  const claim = selectXeroFirmGovernanceClaim(snapshot, {
    actionId: "supplier_bill.create_draft",
    tenantId,
    workspaceId: "workspace-test",
    agentId: "agent-test",
    installationId: "installation-test",
    expectation: {
      route: "SUPPLIER_BILL",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      authoritativeProviderField: "INVOICE_NUMBER",
    },
  });
  return { snapshot, claim };
}

function kernelInput(
  claim: LedgerFirmGovernanceClaim,
  snapshot: ReturnType<typeof fixture>["snapshot"],
): EvaluateAutonomousLedgerWriteInput {
  return {
    actionId: "supplier_bill.create_draft",
    canonicalPayloadHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64),
    caseVersion: 1,
    authoritySnapshotRevision: snapshot.revision,
    authoritySnapshotHash: snapshot.snapshotHash,
    principal: {
      actorId: "workspace-test:user:user-test",
      workspaceId: "workspace-test",
      agentId: "agent-test",
      installationId: "installation-test",
      bindingId: "binding-test",
      bindingRevision: 1,
      connectionId: "connection-test",
    },
    target: {
      providerId: "xero",
      tenantId,
      targetSessionId: "target-test",
      targetSessionExpiresAt: new Date("2026-08-14T01:00:00.000Z"),
    },
    standingDelegations: snapshot.standingDelegations,
    writeKillSwitchEnabled: true,
    staticActionReleased: true,
    transportScopeAllowed: true,
    providerAccessDenyReasons: [],
    providerCapabilityReceiptHash: "c".repeat(64),
    firmGovernanceClaim: claim,
    validation: { passed: true, receiptHash: "d".repeat(64) },
    now: serviceNow,
  };
}

function confirmationInput(claim: LedgerFirmGovernanceClaim, snapshot: ReturnType<typeof fixture>["snapshot"]) {
  return {
    mutationRequestId: "mutation-governed",
    preparationId: "preparation-governed",
    requestId: "request-governed",
    actorId: "workspace-test:user:user-test",
    workspaceId: "workspace-test",
    tenantId,
    installationId: "installation-test",
    bindingId: "binding-test",
    connectionId: "connection-test",
    objectType: "SUPPLIER_BILL" as const,
    operation: "CREATE_DRAFT" as const,
    canonicalPayload: { reference: "BILL-1" },
    canonicalPayloadHash: "a".repeat(64),
    sourceUnitKey: "source-unit",
    sourceSha256: "b".repeat(64),
    sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION" as const,
    confirmationSummaryHash: "c".repeat(64),
    confirmationPhraseHash: "d".repeat(64),
    authorizationReceipt: {
      receiptHash: "e".repeat(64),
      actionId: claim.actionId,
      delegationId: claim.delegationId,
      delegationRevision: claim.delegationRevision,
      authoritySnapshotRevision: snapshot.revision,
      authoritySnapshotHash: snapshot.snapshotHash,
      firmGovernanceClaim: claim,
    },
    claimForWrite: true,
    expectedAuthoritySnapshotRevision: snapshot.revision,
    expectedAuthoritySnapshotHash: snapshot.snapshotHash,
    expectedFirmGovernanceClaim: claim,
    now: serviceNow,
  };
}

describe("firm-governance final claim", () => {
  it("binds the exact route, field, writer, domain, status and trust hashes into the kernel receipt", () => {
    const { claim, snapshot } = fixture();
    const allowed = evaluateAutonomousLedgerWrite(kernelInput(claim, snapshot));
    expect(allowed).toMatchObject({ allowed: true });
    if (!allowed.allowed) throw new Error("expected exact governance claim to authorize");
    expect(allowed.receipt.firmGovernanceClaim).toEqual(claim);

    const mismatches: LedgerFirmGovernanceClaim[] = [
      { ...claim, route: "SALES_INVOICE" },
      { ...claim, referenceKind: "GENERIC_RECURRING_REFERENCE" },
      { ...claim, authoritativeProviderField: "REFERENCE" },
      { ...claim, writerId: "wrong-writer" },
      { ...claim, coordinationDomainId: "wrong-domain" },
      { ...claim, actionId: "credit_note.create_draft" },
      { ...claim, delegationId: "wrong-delegation" },
      { ...claim, delegationRevision: claim.delegationRevision + 1 },
      { ...claim, statusClaimsSha256: "0".repeat(64) },
      { ...claim, trustBundleFileSha256: "1".repeat(64) },
    ];
    for (const mismatch of mismatches) {
      const denied = evaluateAutonomousLedgerWrite(kernelInput(mismatch, snapshot));
      expect(denied).toMatchObject({ allowed: false });
      if (denied.allowed) throw new Error("expected mismatched governance claim to deny");
      expect(denied.denyReasons).toContain("FIRM_GOVERNANCE_AUTHORITY_INVALID");
    }
  });

  it("uses the repository clock and exact locked snapshot, not the service clock or caller expiry", async () => {
    const { snapshot, claim } = fixture();
    const repository = new InMemoryAccountingRepository({
      now: () => new Date(claim.effectiveExpiresAt),
    });
    await repository.publishLedgerAuthoritySnapshot({ ...snapshot, publishedAt: snapshot.publishedAt });
    await repository.createXeroMutationPreparation({
      ...confirmationInput(claim, snapshot),
      expiresAt: new Date("2026-08-14T02:00:00.000Z"),
    });
    await expect(repository.confirmXeroMutationPreparation(
      confirmationInput(claim, snapshot),
    )).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    const currentRepository = new InMemoryAccountingRepository({ now: () => serviceNow });
    await currentRepository.publishLedgerAuthoritySnapshot({ ...snapshot, publishedAt: snapshot.publishedAt });
    await currentRepository.createXeroMutationPreparation({
      ...confirmationInput(claim, snapshot),
      expiresAt: new Date("2026-08-14T02:00:00.000Z"),
    });
    await expect(currentRepository.confirmXeroMutationPreparation(
      confirmationInput({ ...claim, statusFileSha256: "f".repeat(64) }, snapshot),
    )).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(currentRepository.confirmXeroMutationPreparation(
      confirmationInput(claim, snapshot),
    )).resolves.toMatchObject({ created: true, request: { state: "WRITE_IN_FLIGHT" } });
  });

  it("atomically expires at the earlier standing-delegation boundary", async () => {
    const delegationExpiresAt = new Date("2026-08-14T00:35:00.000Z");
    const { snapshot, claim } = fixture(delegationExpiresAt);
    expect(claim).toMatchObject({
      actionId: "supplier_bill.create_draft",
      delegationId: "governed-delegation",
      delegationRevision: 1,
      delegationExpiresAt: delegationExpiresAt.toISOString(),
      effectiveExpiresAt: delegationExpiresAt.toISOString(),
    });
    expect(evaluateAutonomousLedgerWrite(kernelInput(claim, snapshot))).toMatchObject({ allowed: true });
    expect(ledgerFirmGovernanceReadinessEvidence(snapshot, delegationExpiresAt)).toMatchObject({
      status: "EXPIRED",
      minEffectiveExpiresAt: delegationExpiresAt.toISOString(),
    });

    const repository = new InMemoryAccountingRepository({ now: () => delegationExpiresAt });
    await repository.publishLedgerAuthoritySnapshot({ ...snapshot, publishedAt: snapshot.publishedAt });
    await repository.createXeroMutationPreparation({
      ...confirmationInput(claim, snapshot),
      expiresAt: new Date("2026-08-14T02:00:00.000Z"),
    });
    await expect(repository.confirmXeroMutationPreparation(
      confirmationInput(claim, snapshot),
    )).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(repository.getXeroMutationRequest("mutation-governed")).resolves.toBeUndefined();
  });
});
