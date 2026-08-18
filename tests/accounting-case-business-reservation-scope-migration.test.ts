import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "migrations/035_accounting_case_business_reservation_scopes.sql",
), "utf8");

describe("migration 035 Accounting Case business reservation scopes", () => {
  it("upgrades already-applied 033 rows instead of rewriting migration history", () => {
    expect(migration).toContain("operation_json -> 'businessReservation'");
    expect(migration).toContain("canonical_payload -> 'xeroContactId'");
    expect(migration).toContain("business_reservation_coordinate");
    expect(migration).toContain("business_reservation_coordinate_hash");
    expect(migration).toContain("business_reservation_scope");
    expect(migration).toContain("business_reservation_occurrence_date");
  });

  it("serializes mixed all-occurrence and dated-occurrence claims on one canonical coordinate", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("NEW.business_reservation_coordinate::text");
    expect(migration).toContain("accounting_case_active_business_reservation_overlap");
    expect(migration).toMatch(
      /accounting_case_business_reservation_lookup_idx[\s\S]*tenant_id, action_id, business_reservation_coordinate,[\s\S]*business_reservation_scope, business_reservation_occurrence_date/u,
    );
    expect(migration).toMatch(/existing\.business_reservation_scope = 'ALL_OCCURRENCES'[\s\S]*NEW\.business_reservation_scope = 'ALL_OCCURRENCES'[\s\S]*existing\.business_reservation_occurrence_date = NEW\.business_reservation_occurrence_date/u);
  });
});
