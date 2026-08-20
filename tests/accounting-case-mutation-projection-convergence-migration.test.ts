import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/038_accounting_case_mutation_projection_convergence.sql", import.meta.url),
  "utf8",
);

describe("migration 038 Accounting Case mutation projection convergence", () => {
  it("permits only the derived WRITE_UNCERTAIN to READBACK_MISMATCH receipt replacement", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION accounting_case_operation_guard()");
    expect(migration).toContain("OLD.state = 'WRITE_UNCERTAIN'");
    expect(migration).toContain("NEW.state = 'READBACK_MISMATCH'");
    expect(migration).toContain("mutation_projection_error_convergence");
    expect(migration).toContain("NEW.mutation_request_id IS NOT DISTINCT FROM OLD.mutation_request_id");
    expect(migration).toContain("'mutationState', 'WRITE_UNCERTAIN'");
    expect(migration).toContain("'mutationState', 'READBACK_MISMATCH'");
    expect(migration).toContain("AND NOT mutation_projection_error_convergence");
    expect(migration).toContain("request_row.readback_snapshot IS DISTINCT FROM NEW.readback_snapshot");
    expect(migration).toContain("expected_error_receipt IS DISTINCT FROM NEW.error_receipt");
    expect(migration).toContain("DETAIL = concat_ws");
  });
});
