import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/025_xero_ledger_target_sessions.sql", import.meta.url),
  "utf8",
);

describe("migration 025 ledger target safety", () => {
  it("fails the upgrade while a pre-target mutation still requires recovery", () => {
    expect(migration).toContain("migration 025 blocked: recover or close active pre-0.4 Xero mutation requests first");
    for (const state of ["CONFIRMED", "WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"]) {
      expect(migration).toContain(`'${state}'`);
    }
  });

  it("expires unconsumed legacy preparations instead of silently rebinding them", () => {
    expect(migration).toMatch(/UPDATE xero_mutation_preparations[\s\S]*SET state = 'EXPIRED'/u);
    expect(migration).toContain("binding_revision IS NULL OR target_session_id IS NULL");
  });
});
