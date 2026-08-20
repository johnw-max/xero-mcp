import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "migrations/033_accounting_case_business_write_reservations.sql",
), "utf8");

describe("migration 033 Accounting Case business write reservations", () => {
  it("reserves exact governed writes across Case IDs and versions", () => {
    expect(migration).toMatch(/accounting_case_active_business_write_unique_idx[\s\S]*tenant_id, action_id, business_identity_hash/u);
    expect(migration).toMatch(/accounting_case_active_exact_payload_write_unique_idx[\s\S]*tenant_id, action_id, canonical_payload_hash/u);
    expect(migration).toMatch(/WHERE state IN \([\s\S]*'PREPARED'[\s\S]*'WRITE_UNCERTAIN'[\s\S]*'READBACK_MISMATCH'/u);
    const legacyIndex = migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS accounting_case_active_business_write_unique_idx[\s\S]*?;/u)?.[0];
    expect(legacyIndex).toBeDefined();
    expect(legacyIndex).not.toContain("case_id");
  });

  it("adds a provider-kernel exact payload reservation without bare-number contact identities", () => {
    expect(migration).toContain("xero_mutation_requests_active_business_payload_unique_idx");
    expect(migration).toContain("DROP INDEX IF EXISTS xero_mutation_requests_active_contact_company_unique_idx");
    expect(migration).toContain("DROP INDEX IF EXISTS xero_mutation_requests_active_contact_account_unique_idx");
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_active_contact_(?:company|account)_unique_idx/u);
    expect(migration).toMatch(/canonical_payload - ARRAY\[[\s\S]*'source_ref'[\s\S]*'externalReference'/u);
  });

  it("removes free-form supplier-reference hard uniqueness", () => {
    for (const name of [
      "posting_requests_active_supplier_reference_unique_idx",
      "posting_requests_tenant_active_supplier_reference_unique_idx",
      "posting_requests_active_supplier_ref_v030_unique_idx",
      "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
    ]) expect(migration).toContain(`DROP INDEX IF EXISTS ${name}`);
  });

});
