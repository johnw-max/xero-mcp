import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/040_xero_native_idempotency_recovery_claim.sql", import.meta.url),
  "utf8",
);

describe("migration 040 native Xero idempotency recovery claim", () => {
  it("persists a separate bounded recovery claim with an independent shape guard", () => {
    expect(migration).toContain("native_recovery_claim jsonb");
    expect(migration).toContain("XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM");
    expect(migration).toContain("native_recovery_claim_independent_check");
    expect(migration).toContain("write_receipt");
    expect(migration).toContain("nativeRecoveryClaim");
  });

  it("keeps one claim slot per mutation request", () => {
    expect(migration).toContain("xero_mutation_requests_native_recovery_claim_uq");
    expect(migration).toContain("WHERE native_recovery_claim IS NOT NULL");
  });
});
