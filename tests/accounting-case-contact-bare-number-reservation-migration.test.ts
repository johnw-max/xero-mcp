import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "migrations/036_accounting_case_contact_bare_number_reservations.sql",
), "utf8");

describe("migration 036 Accounting Case contact bare-number reservations", () => {
  it("derives provider coordinates without promoting typed namespace evidence into authority", () => {
    expect(migration).toContain("accounting_case_contact_bare_number_coordinate");
    expect(migration).toContain("LEGAL_REGISTRY_CONTACT");
    expect(migration).toContain("PROVIDER_TENANT_CONTACT_ACCOUNT");
    expect(migration).toContain("PROVIDER_CONTACT_BARE_NUMBER");
    expect(migration).toContain("COMPANY_NUMBER");
    expect(migration).toContain("ACCOUNT_NUMBER");
    expect(migration).toContain("RETURN NULL");
  });

  it("claims before provider work and permanently retains uncertain or verified outcomes", () => {
    expect(migration).toMatch(/state = 'PENDING'[\s\S]*target_session_expires_at/u);
    expect(migration).toContain("current_version = existing.case_version");
    expect(migration).toContain("WRITE_UNCERTAIN");
    expect(migration).toContain("READBACK_MISMATCH");
    expect(migration).toContain("READBACK_VERIFIED");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("accounting_case_contact_bare_number_reservation_overlap");
    expect(migration).toContain("ENABLE ALWAYS TRIGGER accounting_case_business_reservation_overlap_trigger");
  });

  it("makes abandoned pending claims lease-bound while allowing atomic same-Case version transfer", () => {
    expect(migration).toContain("target_session_expires_at > NEW.updated_at");
    expect(migration).toContain("NEW.case_version = existing.case_version + 1");
    expect(migration).toContain("accounting_case_contact_bare_number_reservation_lookup_idx");
  });
});
