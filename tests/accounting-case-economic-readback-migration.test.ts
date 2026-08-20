import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/031_accounting_case_economic_readback_convergence.sql", import.meta.url),
  "utf8",
);

describe("migration 031 Accounting Case economic-readback convergence", () => {
  it("allows only a Case-linked evidence-preserving verified-to-mismatch convergence", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS readback_mismatch_receipt jsonb");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS xero_mutation_request_lifecycle_check");
    expect(migration).toContain("ADD CONSTRAINT xero_mutation_request_lifecycle_check CHECK");
    expect(migration).toContain("ACCOUNTING_CASE_ECONOMICS");
    expect(migration).toContain("PAYLOAD_OR_STATUS");
    expect(migration).toContain("OLD.state = 'READBACK_VERIFIED'");
    expect(migration).toContain("NEW.state = 'READBACK_MISMATCH'");
    expect(migration).toContain("NEW.readback_snapshot IS NOT DISTINCT FROM OLD.readback_snapshot");
    expect(migration).toContain("NEW.readback_canonical_payload IS NOT DISTINCT FROM OLD.readback_canonical_payload");
    expect(migration).toContain("operation_row.action_id IN");
    expect(migration).toContain("version_row.state IN ('EXECUTING', 'RECOVERY_REQUIRED')");
    expect(migration).toContain("OR case_economics_demotion");
    expect(migration).toContain("AND NOT case_economics_demotion");
  });
});
