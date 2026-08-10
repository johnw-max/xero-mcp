import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/020_xero_runtime_readiness_compatibility.sql"),
  "utf8",
);

describe("Xero runtime-readiness compatibility migration", () => {
  it("fails before any rename unless all five source indexes are the exact healthy 016 definitions", () => {
    const guardPosition = migration.indexOf("Xero migration 020 requires the exact migration 016 source indexes");
    const firstRenamePosition = migration.indexOf(
      "ALTER INDEX posting_requests_actor_tenant_request_create_unique_idx",
    );
    expect(guardPosition).toBeGreaterThanOrEqual(0);
    expect(guardPosition).toBeLessThan(firstRenamePosition);
    expect(migration).toContain("index_meta.indisunique");
    expect(migration).toContain("index_meta.indisvalid");
    expect(migration).toContain("index_meta.indisready");
    expect(migration).toContain("access_method.amname = 'btree'");
    expect(migration).toContain("posting_requests_active_supplier_reference_unique_idx");
    expect(migration).toContain("posting_requests_tenant_active_supplier_reference_unique_idx");
    expect(migration).toContain("'DRAFT_READBACK_VERIFIED'::text");
    expect(migration).toContain("document_type = 'ACCPAY'::text");
  });

  it("keeps the 0.3 duplicate guards under versioned names and restores the exact 0.2.13 readiness definitions", () => {
    expect(migration).toMatch(
      /ALTER INDEX posting_requests_actor_tenant_request_create_unique_idx\s+RENAME TO posting_requests_actor_tenant_request_create_v030_unique_idx/,
    );
    expect(migration).toMatch(
      /ALTER INDEX posting_requests_tenant_active_source_unique_idx\s+RENAME TO posting_requests_tenant_active_source_v030_unique_idx/,
    );
    expect(migration).toMatch(
      /ALTER INDEX posting_requests_tenant_active_supplier_reference_unique_idx\s+RENAME TO posting_requests_tenant_active_supplier_ref_v030_unique_idx/,
    );

    expect(migration).toMatch(
      /posting_requests_actor_tenant_request_create_unique_idx\s+ON posting_requests \(actor_id, tenant_id, request_id, create_operation\)/,
    );
    expect(migration).toMatch(
      /posting_requests_tenant_active_source_unique_idx\s+ON posting_requests \(tenant_id, source_sha256\)/,
    );
    expect(migration).toMatch(
      /posting_requests_tenant_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*tenant_id,\s*\(lower\(COALESCE/,
    );
    expect(migration).not.toMatch(
      /posting_requests_tenant_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*tenant_id,\s*document_type/,
    );

    const legacyDefinitions = migration.slice(
      migration.indexOf("CREATE UNIQUE INDEX posting_requests_actor_tenant_request_create_unique_idx"),
    );
    expect(legacyDefinitions).not.toContain("'DRAFT_READBACK_VERIFIED'");
    expect(legacyDefinitions).not.toContain("document_type = 'ACCPAY'");
    expect(migration).not.toMatch(/\b(?:DELETE|UPDATE)\s+posting_requests\b/i);
  });

  it("also restores the actor-scoped definitions checked by the QuickBooks 0.2.12 shared repository", () => {
    expect(migration).toMatch(
      /ALTER INDEX posting_requests_active_source_unique_idx\s+RENAME TO posting_requests_active_source_v030_unique_idx/,
    );
    expect(migration).toMatch(
      /ALTER INDEX posting_requests_active_supplier_reference_unique_idx\s+RENAME TO posting_requests_active_supplier_ref_v030_unique_idx/,
    );
    expect(migration).toMatch(
      /posting_requests_active_source_unique_idx\s+ON posting_requests \(actor_id, tenant_id, source_sha256\)/,
    );
    expect(migration).toMatch(
      /posting_requests_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*actor_id,\s*tenant_id,\s*\(lower\(COALESCE/,
    );
    expect(migration).not.toMatch(
      /posting_requests_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*actor_id,\s*tenant_id,\s*document_type/,
    );
  });
});
