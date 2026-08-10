import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/016_xero_document_type_duplicate_guards.sql"),
  "utf8",
);

describe("Xero document-type duplicate migration", () => {
  it("defaults legacy postings to ACCPAY and constrains all future values", () => {
    expect(migration).toMatch(/ADD COLUMN document_type text NOT NULL DEFAULT 'ACCPAY'/);
    expect(migration).toContain("document_type IN ('ACCPAY', 'ACCREC')");
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+posting_requests\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+posting_requests\b/i);
    expect(migration).toContain("'DRAFT_READBACK_VERIFIED'");
  });

  it("type-scopes request idempotency but reserves contact-reference identity only for ACCPAY", () => {
    expect(migration).toMatch(
      /posting_requests_actor_tenant_request_create_unique_idx\s+ON posting_requests \(actor_id, tenant_id, document_type, request_id, create_operation\)/,
    );
    expect(migration).toMatch(
      /posting_requests_tenant_active_supplier_reference_unique_idx\s+ON posting_requests \(\s*tenant_id,\s*document_type,/,
    );
    expect(migration.match(/AND document_type = 'ACCPAY'/g)).toHaveLength(2);
  });

  it("deliberately leaves tenant source-hash uniqueness global across AP and AR", () => {
    expect(migration).toMatch(
      /posting_requests_tenant_active_source_unique_idx\s+ON posting_requests \(tenant_id, source_sha256\)/,
    );
    expect(migration).not.toMatch(
      /posting_requests_tenant_active_source_unique_idx\s+ON posting_requests \(tenant_id, document_type,/,
    );
  });
});
