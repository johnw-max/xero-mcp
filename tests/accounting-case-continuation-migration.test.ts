import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "migrations/034_accounting_case_continuation.sql",
), "utf8");

describe("migration 034 Accounting Case continuation", () => {
  it("is timeout-bounded, reentrant DDL and does not mutate migration 033 identity storage", () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'");
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS accounting_case_versions_state_check");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION accounting_case_version_guard()");
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/imu);
    expect(migration).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE)\b/iu);
    expect(migration).not.toContain("xero_mutation_requests_active_contact");
  });

  it("persists continuation as a non-terminal state with no terminal summary", () => {
    expect(migration).toMatch(/accounting_case_versions_state_check[\s\S]*'AWAITING_CONTINUATION'/u);
    expect(migration).toMatch(/state = 'AWAITING_CONTINUATION'[\s\S]*terminal_summary IS NULL/u);
    expect(migration).toMatch(/OLD\.state = 'EXECUTING'[\s\S]*'AWAITING_CONTINUATION'/u);
    expect(migration).not.toMatch(/state IN \('RECOVERY_REQUIRED', 'AWAITING_CONTINUATION'/u);
  });

  it("requires completed provider evidence and an explicit dependent residual event", () => {
    expect(migration).toContain("Accounting Case continuation requires verified writes and an explicit dependent residual event");
    expect(migration).toMatch(/state IN \('READBACK_VERIFIED', 'NO_WRITE_REQUIRED'\)/u);
    expect(migration).toMatch(/state NOT IN \('READBACK_VERIFIED', 'NO_WRITE_REQUIRED'\)/u);
    expect(migration).toContain("PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION");
  });
});
