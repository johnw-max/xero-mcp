import { describe, expect, it } from "vitest";
import { expectedAuthorityIdentityProven } from "../src/http/app.js";
import type { AppConfig } from "../src/config.js";
import type { RepositoryReadinessEvidence } from "../src/db/repository.js";

function config(): AppConfig {
  return {
    nodeEnv: "production",
  } as unknown as AppConfig;
}

function evidence(overrides: Partial<RepositoryReadinessEvidence> = {}): RepositoryReadinessEvidence {
  return {
    authoritySnapshotRevision: 1,
    authoritySnapshotHash: "5".repeat(64),
    firmGovernance: { status: "NOT_REQUIRED", authorityAggregateHash: null },
    ...overrides,
  } as unknown as RepositoryReadinessEvidence;
}

describe("internal authority snapshot readiness", () => {
  it("accepts an available internal snapshot without a deployment authority pin", () => {
    expect(expectedAuthorityIdentityProven(config(), evidence())).toBe(true);
  });

  it("refuses when the internal snapshot is unavailable", () => {
    expect(expectedAuthorityIdentityProven(config(), evidence({ authoritySnapshotRevision: null }))).toBe(false);
  });
});
