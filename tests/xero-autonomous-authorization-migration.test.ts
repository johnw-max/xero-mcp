import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const correctedFoundationMigration = readFileSync(
  resolve(process.cwd(), "migrations/026_xero_autonomous_authorization_receipts.sql"),
  "utf8",
);
const upgradeMigration = readFileSync(
  resolve(process.cwd(), "migrations/028_xero_autonomous_validation_receipt_lifecycle.sql"),
  "utf8",
);

describe("autonomous Xero authorization receipt migration", () => {
  it.each([
    ["fresh database", correctedFoundationMigration],
    ["already-migrated database", upgradeMigration],
  ])("replaces the legacy lifecycle constraint for a %s", (_databaseKind, migration) => {
    expect(migration).toMatch(
      /DROP CONSTRAINT IF EXISTS xero_mutation_request_lifecycle_check[\s\S]*ADD CONSTRAINT xero_mutation_request_lifecycle_check CHECK/u,
    );

    const lifecycle = migration.slice(migration.indexOf("ADD CONSTRAINT xero_mutation_request_lifecycle_check CHECK"));
    for (const state of [
      "WRITE_IN_FLIGHT",
      "WRITE_UNCERTAIN",
      "READBACK_VERIFIED",
      "READBACK_MISMATCH",
      "PROVIDER_REJECTED",
    ]) {
      const start = lifecycle.indexOf(`state = '${state}'`);
      expect(start, `${state} must remain explicitly constrained`).toBeGreaterThanOrEqual(0);
      const nextState = lifecycle.indexOf("OR (state = '", start + 1);
      const branch = lifecycle.slice(start, nextState >= 0 ? nextState : undefined);
      expect(branch, `${state} must permit immutable successful validation evidence`).not.toContain(
        "validation_receipt IS NULL",
      );
    }

    const confirmedStart = lifecycle.indexOf("state = 'CONFIRMED'");
    const confirmedEnd = lifecycle.indexOf("OR (state = '", confirmedStart + 1);
    expect(lifecycle.slice(confirmedStart, confirmedEnd)).toContain("validation_receipt IS NULL");
  });
});
