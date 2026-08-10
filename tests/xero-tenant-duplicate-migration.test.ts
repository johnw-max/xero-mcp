import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/014_xero_tenant_duplicate_guards.sql"),
  "utf8",
);
const preflight = readFileSync(
  resolve(process.cwd(), "scripts/preflight_xero_duplicate_guards.sql"),
  "utf8",
);

describe("Xero tenant duplicate migration contract", () => {
  it("detects cross-actor source and supplier-reference conflicts before adding either tenant index", () => {
    const guardPosition = migration.indexOf("count(DISTINCT actor_id) > 1");
    const firstTenantIndexPosition = migration.indexOf(
      "CREATE UNIQUE INDEX posting_requests_tenant_active_source_unique_idx",
    );

    expect(guardPosition).toBeGreaterThanOrEqual(0);
    expect(migration.match(/count\(DISTINCT actor_id\) > 1/g)).toHaveLength(2);
    expect(guardPosition).toBeLessThan(firstTenantIndexPosition);
    expect(migration).toContain("GROUP BY tenant_id, source_sha256");
    expect(migration).not.toMatch(/GROUP BY actor_id, tenant_id, source_sha256/);
  });

  it("expands with tenant-scoped business indexes while preserving rollback-compatible actor indexes", () => {
    expect(migration).toMatch(
      /posting_requests_tenant_active_source_unique_idx\s+ON posting_requests \(tenant_id, source_sha256\)/,
    );
    expect(migration).toMatch(
      /posting_requests_tenant_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*tenant_id,/,
    );
    expect(migration).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(migration).toContain("SET LOCAL lock_timeout");
  });

  it("keeps migration and preflight non-destructive and aligned on cross-actor tenant scope", () => {
    for (const sql of [migration, preflight]) {
      expect(sql).not.toMatch(/\bDELETE\s+FROM\s+posting_requests\b/i);
      expect(sql).not.toMatch(/\bUPDATE\s+posting_requests\b/i);
      expect(sql.match(/count\(DISTINCT actor_id\) > 1/g)?.length).toBeGreaterThanOrEqual(2);
      expect(sql).toContain("GROUP BY tenant_id, source_sha256");
    }
    expect(preflight).toContain("Do not deploy migration 016");
  });

  it("gates migration 020 on every exact legacy uniqueness conflict, not only cross-actor rows", () => {
    const gateMarker = "Migration 020 exact-legacy-index preflight";
    expect(preflight).toContain(gateMarker);
    const migration020Gate = preflight.slice(preflight.indexOf(gateMarker));

    expect(migration020Gate).toContain(
      "GROUP BY actor_id, tenant_id, request_id, create_operation",
    );
    expect(migration020Gate).toContain("GROUP BY tenant_id, source_sha256");
    expect(migration020Gate).toContain(
      "GROUP BY tenant_id, contact_id, normalized_reference",
    );
    expect(migration020Gate).not.toContain("count(DISTINCT actor_id) > 1");
    expect(migration020Gate).toContain("document_types");
    expect(migration020Gate).toContain("xero_migration_020_preflight_safe");
    expect(migration020Gate).toContain("Do not deploy migration 020");
  });
});
