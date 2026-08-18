import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/032_ledger_authority_snapshots.sql"),
  "utf8",
);

describe("migration 032 durable ledger authority snapshots", () => {
  it("creates one exact provider row with monotonic-compatible revision and hash constraints", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ledger_authority_snapshots");
    expect(sql).toContain("provider_id text PRIMARY KEY");
    expect(sql).toContain("revision bigint NOT NULL CHECK (revision > 0)");
    expect(sql).toContain("snapshot_hash text NOT NULL CHECK");
    expect(sql).toContain("write_kill_switch_enabled boolean NOT NULL");
    expect(sql).toContain("standing_delegations jsonb NOT NULL");
    expect(sql).toContain("REVOKE ALL ON TABLE ledger_authority_snapshots FROM PUBLIC");
  });
});
