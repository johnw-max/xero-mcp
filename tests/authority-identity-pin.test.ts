import { describe, expect, it } from "vitest";
import { expectedAuthorityIdentityProven } from "../src/http/app.js";
import type { AppConfig } from "../src/config.js";
import type { RepositoryReadinessEvidence } from "../src/db/repository.js";

const CONTENT = "c".repeat(64);
const SNAPSHOT = "5".repeat(64);

function config(expectedSnapshot: string | undefined): AppConfig {
  return {
    nodeEnv: "production",
    xeroExpectedAuthoritySnapshotSha256: expectedSnapshot,
    xeroExpectedFirmGovernanceAggregateSha256: "NOT_REQUIRED",
  } as unknown as AppConfig;
}

function evidence(overrides: Partial<RepositoryReadinessEvidence> = {}): RepositoryReadinessEvidence {
  return {
    authoritySnapshotHash: SNAPSHOT,
    authorityContentHash: CONTENT,
    firmGovernance: { status: "NOT_REQUIRED", authorityAggregateHash: null },
    ...overrides,
  } as unknown as RepositoryReadinessEvidence;
}

describe("authority pin that decides whether a build may write", () => {
  it("accepts a pin naming the revision-independent content hash", () => {
    expect(expectedAuthorityIdentityProven(config(CONTENT), evidence())).toBe(true);
  });

  it("keeps accepting that pin after the same authority is republished at a higher revision", () => {
    // A rollback republishes the older authority under a HIGHER revision, since
    // the revision may never decrease. The snapshot hash therefore changes while
    // the authority itself does not — which used to leave the rolled-back build
    // silently READ_ONLY.
    const republished = evidence({ authoritySnapshotHash: "9".repeat(64) });
    expect(expectedAuthorityIdentityProven(config(CONTENT), republished)).toBe(true);
  });

  it("still accepts an older pin that names the snapshot hash", () => {
    expect(expectedAuthorityIdentityProven(config(SNAPSHOT), evidence())).toBe(true);
  });

  it("refuses when the published authority is not the one this build pins", () => {
    const different = evidence({ authorityContentHash: "d".repeat(64), authoritySnapshotHash: "e".repeat(64) });
    expect(expectedAuthorityIdentityProven(config(CONTENT), different)).toBe(false);
  });

  it("refuses when governance is expected but the live authority does not carry it", () => {
    const governed = { ...config(CONTENT), xeroExpectedFirmGovernanceAggregateSha256: "f".repeat(64) } as AppConfig;
    expect(expectedAuthorityIdentityProven(governed, evidence())).toBe(false);
  });
});
