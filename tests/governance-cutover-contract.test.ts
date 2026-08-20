import { describe, expect, it } from "vitest";
import { assertGovernanceCutoverIdentity } from "../deploy/scripts/governance-cutover-contract.mjs";

const a = Object.freeze({
  trust: "a".repeat(64),
  receipts: "b".repeat(64),
  status: "c".repeat(64),
});
const b = Object.freeze({
  trust: "d".repeat(64),
  receipts: "e".repeat(64),
  status: "f".repeat(64),
});

function ready(hashes: typeof a) {
  return {
    status: "ready",
    processWriteGateEnabled: true,
    authorityWriteKillSwitchEnabled: true,
    authoritySnapshotRevision: 7,
    authoritySnapshotHash: "8".repeat(64),
    standingDelegationsConfigSha256: "7".repeat(64),
    firmGovernance: {
      status: "CURRENT",
      authorityAggregateHash: "9".repeat(64),
      trustBundleFileSha256: hashes.trust,
      receiptsFileSha256: hashes.receipts,
      statusFileSha256: hashes.status,
      minEffectiveExpiresAt: "2026-08-14T01:00:00.000Z",
    },
  };
}

describe("governance cutover identity", () => {
  it("rejects a still-running A snapshot after host admission advances to replacement B", () => {
    expect(() => assertGovernanceCutoverIdentity({
      ready: ready(a),
      admittedTrustBundleSha256: b.trust,
      admittedReceiptsSha256: b.receipts,
      admittedStatusSha256: b.status,
      admittedAuthorityRevision: 7,
      admittedStandingDelegationsConfigSha256: "7".repeat(64),
      admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
      admittedExpectedFirmGovernanceAggregateSha256: "9".repeat(64),
      admittedWriteEnabled: true,
      admittedFirmGovernanceRequired: true,
    })).toThrow("GOVERNANCE_CUTOVER_RUNTIME_ADMISSION_MISMATCH");
  });

  it("accepts the restarted process only after durable B snapshot identity is current", () => {
    expect(assertGovernanceCutoverIdentity({
      ready: ready(b),
      admittedTrustBundleSha256: b.trust,
      admittedReceiptsSha256: b.receipts,
      admittedStatusSha256: b.status,
      admittedAuthorityRevision: 7,
      admittedStandingDelegationsConfigSha256: "7".repeat(64),
      admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
      admittedExpectedFirmGovernanceAggregateSha256: "9".repeat(64),
      admittedWriteEnabled: true,
      admittedFirmGovernanceRequired: true,
    })).toEqual({
      trustBundleFileSha256: b.trust,
      receiptsFileSha256: b.receipts,
      statusFileSha256: b.status,
      authorityAggregateHash: "9".repeat(64),
      minEffectiveExpiresAt: "2026-08-14T01:00:00.000Z",
      authoritySnapshotRevision: 7,
      authoritySnapshotHash: "8".repeat(64),
      standingDelegationsConfigSha256: "7".repeat(64),
    });
  });

  it("rejects a runtime started with a different delegation revision or configuration", () => {
    for (const runtime of [
      { ...ready(b), authoritySnapshotRevision: 6 },
      { ...ready(b), standingDelegationsConfigSha256: "6".repeat(64) },
      { ...ready(b), processWriteGateEnabled: false },
    ]) {
      expect(() => assertGovernanceCutoverIdentity({
        ready: runtime,
        admittedTrustBundleSha256: b.trust,
        admittedReceiptsSha256: b.receipts,
        admittedStatusSha256: b.status,
        admittedAuthorityRevision: 7,
        admittedStandingDelegationsConfigSha256: "7".repeat(64),
        admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
        admittedExpectedFirmGovernanceAggregateSha256: "9".repeat(64),
        admittedWriteEnabled: true,
        admittedFirmGovernanceRequired: true,
      })).toThrow("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_CONFIG_MISMATCH");
    }
  });

  it("rejects expired, missing, or identity-free governance evidence", () => {
    for (const firmGovernance of [
      { ...ready(b).firmGovernance, status: "EXPIRED" },
      { ...ready(b).firmGovernance, statusFileSha256: null },
      { ...ready(b).firmGovernance, authorityAggregateHash: null },
    ]) {
      expect(() => assertGovernanceCutoverIdentity({
        ready: { ...ready(b), firmGovernance },
        admittedTrustBundleSha256: b.trust,
        admittedReceiptsSha256: b.receipts,
        admittedStatusSha256: b.status,
        admittedAuthorityRevision: 7,
        admittedStandingDelegationsConfigSha256: "7".repeat(64),
        admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
        admittedExpectedFirmGovernanceAggregateSha256: "9".repeat(64),
        admittedWriteEnabled: true,
        admittedFirmGovernanceRequired: true,
      })).toThrow();
    }
  });

  it("allows an exact read-only snapshot to report governance not required", () => {
    const readOnly = {
      ...ready(b),
      processWriteGateEnabled: false,
      authorityWriteKillSwitchEnabled: false,
      firmGovernance: {
        status: "NOT_REQUIRED",
        requiredDelegationCount: 0,
        authorityCount: 0,
        authorityAggregateHash: null,
        trustBundleFileSha256: null,
        receiptsFileSha256: null,
        statusFileSha256: null,
        minEffectiveExpiresAt: null,
      },
    };
    expect(assertGovernanceCutoverIdentity({
      ready: readOnly,
      admittedTrustBundleSha256: b.trust,
      admittedReceiptsSha256: b.receipts,
      admittedStatusSha256: b.status,
      admittedAuthorityRevision: 7,
      admittedStandingDelegationsConfigSha256: "7".repeat(64),
      admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
      admittedExpectedFirmGovernanceAggregateSha256: "NOT_REQUIRED",
      admittedWriteEnabled: false,
      admittedFirmGovernanceRequired: false,
    })).toMatchObject({ firmGovernanceStatus: "NOT_REQUIRED" });
  });

  it("rejects a valid runtime whose snapshot or normalized governance aggregate differs from admission", () => {
    for (const expected of [
      {
        admittedExpectedAuthoritySnapshotSha256: "0".repeat(64),
        admittedExpectedFirmGovernanceAggregateSha256: "9".repeat(64),
      },
      {
        admittedExpectedAuthoritySnapshotSha256: "8".repeat(64),
        admittedExpectedFirmGovernanceAggregateSha256: "0".repeat(64),
      },
    ]) {
      expect(() => assertGovernanceCutoverIdentity({
        ready: ready(b),
        admittedTrustBundleSha256: b.trust,
        admittedReceiptsSha256: b.receipts,
        admittedStatusSha256: b.status,
        admittedAuthorityRevision: 7,
        admittedStandingDelegationsConfigSha256: "7".repeat(64),
        admittedWriteEnabled: true,
        admittedFirmGovernanceRequired: true,
        ...expected,
      })).toThrow("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_CONFIG_MISMATCH");
    }
  });
});
