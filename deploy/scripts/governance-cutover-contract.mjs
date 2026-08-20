#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/u;

export function assertGovernanceCutoverIdentity({
  ready,
  admittedTrustBundleSha256,
  admittedReceiptsSha256,
  admittedStatusSha256,
  admittedAuthorityRevision,
  admittedStandingDelegationsConfigSha256,
  admittedExpectedAuthoritySnapshotSha256,
  admittedExpectedFirmGovernanceAggregateSha256,
  admittedWriteEnabled,
  admittedFirmGovernanceRequired = admittedWriteEnabled,
}) {
  if (!ready || typeof ready !== "object" || Array.isArray(ready) || ready.status !== "ready") {
    throw new Error("GOVERNANCE_CUTOVER_READY_INVALID");
  }
  const admitted = [admittedTrustBundleSha256, admittedReceiptsSha256, admittedStatusSha256];
  if (!admitted.every((value) => typeof value === "string" && SHA256.test(value))) {
    throw new Error("GOVERNANCE_CUTOVER_ADMITTED_HASH_INVALID");
  }
  if (!Number.isSafeInteger(admittedAuthorityRevision) || admittedAuthorityRevision < 1 ||
      typeof admittedStandingDelegationsConfigSha256 !== "string" ||
      !SHA256.test(admittedStandingDelegationsConfigSha256) ||
      typeof admittedExpectedAuthoritySnapshotSha256 !== "string" ||
      !SHA256.test(admittedExpectedAuthoritySnapshotSha256) ||
      !(admittedExpectedFirmGovernanceAggregateSha256 === "NOT_REQUIRED" ||
        (typeof admittedExpectedFirmGovernanceAggregateSha256 === "string" &&
          SHA256.test(admittedExpectedFirmGovernanceAggregateSha256))) ||
      typeof admittedWriteEnabled !== "boolean" || typeof admittedFirmGovernanceRequired !== "boolean") {
    throw new Error("GOVERNANCE_CUTOVER_ADMITTED_AUTHORITY_CONFIG_INVALID");
  }
  if (ready.processWriteGateEnabled !== admittedWriteEnabled ||
      ready.authorityWriteKillSwitchEnabled !== admittedWriteEnabled ||
      ready.authoritySnapshotRevision !== admittedAuthorityRevision ||
      ready.authoritySnapshotHash !== admittedExpectedAuthoritySnapshotSha256 ||
      ready.standingDelegationsConfigSha256 !== admittedStandingDelegationsConfigSha256) {
    throw new Error("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_CONFIG_MISMATCH");
  }
  const governance = ready.firmGovernance;
  if (!governance || typeof governance !== "object" || Array.isArray(governance) ||
      !["CURRENT", "NOT_REQUIRED"].includes(governance.status) ||
      (admittedFirmGovernanceRequired && governance.status !== "CURRENT")) {
    throw new Error("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_NOT_CURRENT");
  }
  if ((governance.status === "NOT_REQUIRED" &&
      admittedExpectedFirmGovernanceAggregateSha256 !== "NOT_REQUIRED") ||
      (governance.status === "CURRENT" &&
        governance.authorityAggregateHash !== admittedExpectedFirmGovernanceAggregateSha256)) {
    throw new Error("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_CONFIG_MISMATCH");
  }
  if (governance.status === "NOT_REQUIRED") {
    if (governance.requiredDelegationCount !== 0 || governance.authorityCount !== 0 ||
        governance.authorityAggregateHash !== null || governance.trustBundleFileSha256 !== null ||
        governance.receiptsFileSha256 !== null || governance.statusFileSha256 !== null ||
        governance.minEffectiveExpiresAt !== null) {
      throw new Error("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_NOT_CURRENT");
    }
    return Object.freeze({
      authoritySnapshotRevision: ready.authoritySnapshotRevision,
      authoritySnapshotHash: ready.authoritySnapshotHash,
      standingDelegationsConfigSha256: ready.standingDelegationsConfigSha256,
      firmGovernanceStatus: "NOT_REQUIRED",
    });
  }
  if (!SHA256.test(governance.authorityAggregateHash ?? "") ||
      typeof governance.minEffectiveExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(governance.minEffectiveExpiresAt))) {
    throw new Error("GOVERNANCE_CUTOVER_RUNTIME_AUTHORITY_NOT_CURRENT");
  }
  const runtime = [
    governance.trustBundleFileSha256,
    governance.receiptsFileSha256,
    governance.statusFileSha256,
  ];
  if (runtime.some((value, index) => value !== admitted[index])) {
    throw new Error("GOVERNANCE_CUTOVER_RUNTIME_ADMISSION_MISMATCH");
  }
  return Object.freeze({
    trustBundleFileSha256: runtime[0],
    receiptsFileSha256: runtime[1],
    statusFileSha256: runtime[2],
    authorityAggregateHash: governance.authorityAggregateHash,
    minEffectiveExpiresAt: governance.minEffectiveExpiresAt,
    authoritySnapshotRevision: ready.authoritySnapshotRevision,
    authoritySnapshotHash: ready.authoritySnapshotHash,
    standingDelegationsConfigSha256: ready.standingDelegationsConfigSha256,
  });
}

async function main() {
  if (process.argv.length !== 11) {
    throw new Error("usage: governance-cutover-contract.mjs TRUST_SHA RECEIPTS_SHA STATUS_SHA AUTHORITY_REVISION DELEGATIONS_SHA WRITE_ENABLED GOVERNANCE_REQUIRED EXPECTED_SNAPSHOT_SHA EXPECTED_GOVERNANCE_AGGREGATE");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let ready;
  try {
    ready = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("GOVERNANCE_CUTOVER_READY_JSON_INVALID");
  }
  assertGovernanceCutoverIdentity({
    ready,
    admittedTrustBundleSha256: process.argv[2],
    admittedReceiptsSha256: process.argv[3],
    admittedStatusSha256: process.argv[4],
    admittedAuthorityRevision: Number(process.argv[5]),
    admittedStandingDelegationsConfigSha256: process.argv[6],
    admittedWriteEnabled: process.argv[7] === "true",
    admittedFirmGovernanceRequired: process.argv[8] === "true",
    admittedExpectedAuthoritySnapshotSha256: process.argv[9],
    admittedExpectedFirmGovernanceAggregateSha256: process.argv[10],
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
