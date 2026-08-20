import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/039_accounting_case_expired_target_residual_continuation.sql", import.meta.url),
  "utf8",
);

describe("migration 039 expired-target residual continuation", () => {
  it("closes the old operation as zero-write and reserves one target-bound successor", () => {
    expect(migration).toContain("NOT_EXECUTED_AFTER_TARGET_EXPIRY");
    expect(migration).toContain("accounting_case_recovery_residual_grants");
    expect(migration).toContain("state IN ('ISSUED', 'CONSUMED')");
    expect(migration).toContain("source_case_id, source_case_version");
    expect(migration).toContain("target_session_hash");
    expect(migration).toContain("target_session.expires_at > statement_timestamp()");
    expect(migration).toContain("preparation_row.state <> 'EXPIRED'");
    expect(migration).toContain("mutationRequestAbsent");
    expect(migration).toContain("providerCallAbsentByPermitInvariant");
    expect(migration).toContain("Recovery residual grants are append-only");
  });

  it("keeps the business reservation active until its exact successor acquires a fresh claim", () => {
    expect(migration).toContain("accounting_case_recovery_residual_claim_active");
    expect(migration).toContain("accounting_case_recovery_successor_owns_residual");
    expect(migration).toContain("existing.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'");
    expect(migration).toContain("existing.operation_id, NEW.case_id");
  });

  it("reserves live native-document PENDING coordinates before preflight without weakening successor ownership", () => {
    expect(migration).toContain("PENDING business-coordinate claim has no live current-version target lease");
    expect(migration).toMatch(/existing\.state = 'PENDING'[\s\S]*existing_head\.current_version = existing\.case_version[\s\S]*existing_head\.target_session_expires_at > statement_timestamp\(\)/u);
    expect(migration).toMatch(/existing\.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'[\s\S]*accounting_case_recovery_successor_owns_residual\([\s\S]*existing\.operation_id, NEW\.case_id/u);
    expect(migration).toMatch(/NEW\.state = 'PENDING'[\s\S]*existing\.state = 'PENDING'[\s\S]*NEW\.case_version = existing\.case_version \+ 1/u);
    expect(migration).toContain("CONSTRAINT = 'accounting_case_active_business_reservation_overlap'");
  });

  it("accepts native no-write only through the action-bound exact-history envelope", () => {
    expect(migration).toContain("xero-accounting-case-existing-document-evidence:v1");
    expect(migration).toContain("NEW.readback_snapshot -> 'businessReservation' IS DISTINCT FROM NEW.business_reservation");
    expect(migration).toContain("NEW.readback_snapshot #>> '{providerHistory,state}' IS DISTINCT FROM 'EXACT_ONE'");
    expect(migration).toContain("NEW.readback_snapshot #> '{providerHistory,mismatchReasons}' IS DISTINCT FROM '[]'::jsonb");
    expect(migration).toContain("Accounting Case native no-write evidence lines are not exact");
  });

  it("retains mutation-projection convergence while extending the operation guard", () => {
    expect(migration).toContain("mutation_projection_error_convergence");
    expect(migration).toContain("OLD.state = 'WRITE_UNCERTAIN'");
    expect(migration).toContain("NEW.state = 'READBACK_MISMATCH'");
    expect(migration).toContain("expected_error_receipt IS DISTINCT FROM NEW.error_receipt");
  });
});
