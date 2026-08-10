import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/015_xero_posting_write_provenance.sql"),
  "utf8",
);
const repositorySource = readFileSync(
  resolve(process.cwd(), "src/db/postgresRepository.ts"),
  "utf8",
);

describe("Xero posting provenance migration contract", () => {
  it("is expand-only and preserves all four phase-specific evidence columns", () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    for (const column of [
      "draft_write_receipt",
      "draft_readback_snapshot",
      "authorise_write_receipt",
      "authorise_readback_snapshot",
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column} jsonb`);
    }
    expect(migration).not.toMatch(/\bDROP\s+(?:COLUMN|TABLE)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+posting_requests\b/i);
  });

  it("backfills draft evidence only before terminal authorisation and never invents lost draft evidence", () => {
    expect(migration).toContain("WHERE state <> 'AUTHORISED_READBACK_VERIFIED'");
    expect(migration).toContain("WHERE state = 'AUTHORISED_READBACK_VERIFIED'");
    expect(migration).toMatch(
      /SET draft_write_receipt = COALESCE\(draft_write_receipt, write_receipt\)/,
    );
    expect(migration).toMatch(
      /SET authorise_write_receipt = COALESCE\(authorise_write_receipt, write_receipt\)/,
    );
  });

  it("preserves legacy draft evidence if an older rollback binary created it after migration 015", () => {
    expect(repositorySource).toContain(
      "draft_write_receipt = COALESCE(draft_write_receipt, write_receipt)",
    );
    expect(repositorySource).toContain(
      "draft_readback_snapshot = COALESCE(draft_readback_snapshot, readback_snapshot)",
    );
  });
});
