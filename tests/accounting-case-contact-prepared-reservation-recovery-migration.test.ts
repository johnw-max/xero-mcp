import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "migrations/037_accounting_case_contact_prepared_reservation_recovery.sql",
), "utf8");

describe("migration 037 Accounting Case PREPARED contact reservation recovery", () => {
  it("owns expiry and abandonment time in PostgreSQL", () => {
    expect(migration).toContain("statement_timestamp()");
    expect(migration).not.toMatch(/target_session_expires_at\s*>\s*NEW\.updated_at/u);
    expect(migration).toContain("ACCOUNTING_CASE_NO_WRITE_STARTED");
    expect(migration).toContain("ABANDONED");
    expect(migration).toContain("accounting_case_prepared_liveness_guard");
    expect(migration).toContain("target_session.revoked_at IS NULL");
  });

  it("requires durable proof that no mutation request or provider write evidence exists", () => {
    expect(migration).toContain("xero_mutation_requests");
    expect(migration).toContain("mutationRequestAbsent");
    expect(migration).toContain("providerCallAbsentByPermitInvariant");
    expect(migration).toContain("write_receipt IS NULL");
    expect(migration).toContain("readback_snapshot IS NULL");
    expect(migration).toContain("preparation.state NOT IN ('PREPARED', 'EXPIRED')");
  });

  it("serializes transfer with provider-write claim and keeps uncertain or verified states reserved", () => {
    const recovery = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION abandon_expired_accounting_case_contact_reservation"),
      migration.indexOf("-- Rebuild the overlap guard"),
    );
    const versionLock = recovery.indexOf("FOR UPDATE;");
    const coordinateLock = recovery.indexOf("pg_advisory_xact_lock");
    const preparationLocks = recovery.indexOf("FOR UPDATE OF preparation;");
    expect(versionLock).toBeGreaterThan(-1);
    expect(coordinateLock).toBeGreaterThan(versionLock);
    expect(preparationLocks).toBeGreaterThan(coordinateLock);
    expect(migration).toContain("WRITE_IN_FLIGHT");
    expect(migration).toContain("WRITE_UNCERTAIN");
    expect(migration).toContain("READBACK_MISMATCH");
    expect(migration).toContain("READBACK_VERIFIED");
  });
});
