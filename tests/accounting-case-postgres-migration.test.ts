import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/027_accounting_case_foundation.sql", import.meta.url),
  "utf8",
);
const evidenceMigration = readFileSync(
  new URL("../migrations/029_accounting_case_evidence_linkage.sql", import.meta.url),
  "utf8",
);
const resealMigration = readFileSync(
  new URL("../migrations/030_accounting_case_preflight_reseal.sql", import.meta.url),
  "utf8",
);

describe("migration 027 Accounting Case durable safety contract", () => {
  it("binds every Case to the exact OAuth, tenant and target-session tuple", () => {
    for (const field of [
      "workspace_id",
      "subject_type",
      "subject_id",
      "agent_id",
      "oauth_installation_id",
      "binding_id",
      "binding_revision",
      "connection_id",
      "tenant_id",
      "target_session_id",
      "target_session_hash",
      "target_session_expires_at",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain("accounting_cases_binding_fk");
    expect(migration).toContain("accounting_cases_connection_tenant_fk");
    expect(migration).toContain("accounting_cases_target_fk");
    expect(migration).toContain("Accounting Case binding identity is immutable");
  });

  it("makes compiled plans and operation payloads immutable and advances the head one version at a time", () => {
    expect(migration).toContain("Accounting Case compiled plan is immutable");
    expect(migration).toContain("Accounting Case operation plan and payload are immutable");
    expect(migration).toContain("Accounting Case current version must advance exactly once");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("Accounting Case cannot advance after preflight or while execution/recovery is active");
  });

  it("seals one complete preflight receipt and operation set before execution", () => {
    for (const field of [
      "preflight_request_id",
      "preflight_receipt",
      "preflight_receipt_hash",
      "preflighted_at",
    ]) expect(migration).toContain(field);
    expect(migration).toMatch(/'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS'\) AND NEW\.state = 'PREFLIGHTED'/u);
    expect(migration).toMatch(/OLD\.state = 'PREFLIGHTED' AND NEW\.state = 'EXECUTING'/u);
    expect(migration).toContain("Accounting Case preflight receipt is immutable");
    expect(migration).toContain("Accounting Case preflight requires complete prepared or no-write operation evidence");
    expect(migration).toContain("Accounting Case preflight operation set is sealed until execution claim");
    expect(migration).toMatch(/state = 'PREFLIGHTED'[\s\S]*preflight_request_id IS NOT NULL[\s\S]*preflight_receipt IS NOT NULL[\s\S]*preflight_receipt_hash IS NOT NULL/u);
  });

  it("enforces the operation transition graph and evidence-bearing terminal shapes", () => {
    expect(migration).toMatch(/OLD\.state = 'PENDING'[\s\S]*'PREPARED'[\s\S]*'NO_WRITE_REQUIRED'[\s\S]*'BLOCKED_VALIDATION'/u);
    expect(migration).not.toMatch(/OLD\.state = 'PENDING'[^\n]*READBACK_VERIFIED/u);
    expect(migration).toMatch(/OLD\.state = 'PREPARED'[\s\S]*'READBACK_VERIFIED'/u);
    expect(migration).toMatch(/state = 'READBACK_VERIFIED'[\s\S]*xero_object_id IS NOT NULL[\s\S]*write_receipt IS NOT NULL[\s\S]*readback_snapshot IS NOT NULL/u);
    expect(migration).toContain("Accounting Case terminal operation evidence is immutable");
  });

  it("blocks terminal completion while any operation still needs execution or recovery", () => {
    expect(migration).toMatch(/NEW\.state = 'TERMINAL'[\s\S]*'PENDING'[\s\S]*'PREPARED'[\s\S]*'WRITE_IN_FLIGHT'[\s\S]*'WRITE_UNCERTAIN'[\s\S]*'READBACK_MISMATCH'/u);
    expect(migration).toMatch(/NEW\.state = 'RECOVERY_REQUIRED'[\s\S]*'WRITE_UNCERTAIN'[\s\S]*'READBACK_MISMATCH'/u);
    expect(migration).toContain("Accounting Case terminal evidence is immutable");
    expect(migration).toContain("Partially committed Accounting Case requires completed and definitely failed operations");
    expect(migration).toContain("Mixed completed and failed Accounting Case must be partially committed");
  });
});

describe("migration 029 Accounting Case evidence-linkage upgrade contract", () => {
  it("is additive, timeout-bounded, and rerunnable without destructive data operations", () => {
    expect(evidenceMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(evidenceMigration).toContain("SET LOCAL statement_timeout = '30s'");
    expect(evidenceMigration).toContain("ADD COLUMN IF NOT EXISTS last_execution_error_receipt");
    expect(evidenceMigration).toContain("ADD COLUMN IF NOT EXISTS preparation_canonical_payload_hash");
    expect(evidenceMigration).toContain("ADD COLUMN IF NOT EXISTS operation_source_sha256");
    expect(evidenceMigration).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE)\b/iu);
  });

  it("fails an upgrade closed on swapped preparation or caller-authored mutation evidence", () => {
    expect(evidenceMigration).toContain("existing Accounting Case preparation linkage is invalid");
    expect(evidenceMigration).toContain("existing Accounting Case mutation projection is invalid");
    for (const identity of [
      "actor_id", "workspace_id", "tenant_id", "oauth_installation_id", "binding_id",
      "binding_revision", "connection_id", "target_session_id", "source_ref", "source_unit_key",
      "source_sha256", "canonical_payload_hash", "object_type", "operation",
    ]) expect(evidenceMigration).toContain(identity);
    expect(evidenceMigration).toContain("request_row.xero_object_id IS DISTINCT FROM operation_row.xero_object_id");
    expect(evidenceMigration).toContain("request_row.write_receipt IS DISTINCT FROM operation_row.write_receipt");
    expect(evidenceMigration).toContain("request_row.readback_snapshot IS DISTINCT FROM operation_row.readback_snapshot");
  });

  it("adds resumable execution, residual, recovery, and deterministic summary invariants", () => {
    expect(evidenceMigration).toContain("READY_TO_RESUME");
    expect(evidenceMigration).toContain("NOT_EXECUTED_AFTER_PRIOR_FAILURE");
    expect(evidenceMigration).toContain("residual operation requires an earlier definite failure");
    expect(evidenceMigration).toMatch(/RECOVERY_REQUIRED[\s\S]*WRITE_IN_FLIGHT[\s\S]*WRITE_UNCERTAIN[\s\S]*READBACK_MISMATCH/u);
    expect(evidenceMigration).toContain("accounting_case_terminal_state_projection");
    expect(evidenceMigration).toContain("terminal summary must be the deterministic operation projection");
    expect(evidenceMigration).toMatch(/state = 'READBACK_VERIFIED'[\s\S]*error_receipt IS NULL/u);
    expect(evidenceMigration).toContain("SET error_receipt = NULL");
  });

  it("reinstalls both lifecycle triggers only after evidence and summaries are upgraded", () => {
    const summaryBackfill = evidenceMigration.indexOf("UPDATE accounting_case_versions version_row");
    const versionTrigger = evidenceMigration.lastIndexOf("CREATE TRIGGER accounting_case_version_lifecycle");
    const operationTrigger = evidenceMigration.lastIndexOf("CREATE TRIGGER accounting_case_operation_lifecycle");
    expect(summaryBackfill).toBeGreaterThan(-1);
    expect(versionTrigger).toBeGreaterThan(summaryBackfill);
    expect(operationTrigger).toBeGreaterThan(versionTrigger);
  });
});

describe("migration 030 Accounting Case preflight-reseal contract", () => {
  it("is additive, timeout-bounded, and safely backfills original/effective identities", () => {
    expect(resealMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(resealMigration).toContain("SET LOCAL statement_timeout = '30s'");
    expect(resealMigration).toContain("ADD COLUMN IF NOT EXISTS original_preflight_receipt_hash");
    expect(resealMigration).toContain("ADD COLUMN IF NOT EXISTS effective_preflight_seal_hash");
    expect(resealMigration).toContain("ADD COLUMN IF NOT EXISTS effective_preflight_sealed_at");
    expect(resealMigration).toContain("ADD COLUMN IF NOT EXISTS preflight_reseal_revision");
    expect(resealMigration).toContain("ADD COLUMN IF NOT EXISTS original_preparation_id");
    expect(resealMigration).toMatch(/original_preflight_receipt_hash[\s\S]*preflight_receipt_hash/u);
    expect(resealMigration).toMatch(/effective_preflight_seal_hash[\s\S]*preflight_receipt_hash/u);
    expect(resealMigration).toMatch(/original_preparation_id = preparation_id/u);
    expect(resealMigration).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/iu);
  });

  it("preserves the original receipt while projecting one hash-chained effective seal", () => {
    expect(resealMigration).toContain("Accounting Case original preflight receipt hash is immutable");
    expect(resealMigration).toContain("Accounting Case original preparation is immutable");
    expect(resealMigration).toContain("previous_effective_seal_hash");
    expect(resealMigration).toContain("reseal_receipt_hash");
    expect(resealMigration).toContain("preflight_reseal_revision + 1");
    expect(resealMigration).toContain("preflight reseal revisions must be complete and hash-chained");
    expect(resealMigration).toContain("original Accounting Case preflight receipt linkage is invalid");
    expect(resealMigration).toMatch(/evidence ->> 'preparationId' = operation_row\.original_preparation_id/u);
  });

  it("keeps header and operation history append-only with exact receipt projection", () => {
    expect(resealMigration).toContain("CREATE TABLE IF NOT EXISTS accounting_case_preflight_reseals");
    expect(resealMigration).toContain("CREATE TABLE IF NOT EXISTS accounting_case_preflight_reseal_operations");
    expect(resealMigration).toContain("Accounting Case preflight reseal evidence is append-only");
    expect(resealMigration).toContain("BEFORE UPDATE OR DELETE ON accounting_case_preflight_reseals");
    expect(resealMigration).toContain("BEFORE TRUNCATE ON accounting_case_preflight_reseals");
    expect(resealMigration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(resealMigration).toContain("reseal receipt must exactly project its append-only operations");
  });

  it("permits only line-backed prepared replacements with at least 30 seconds runway", () => {
    expect(resealMigration).toContain("minimum_preparation_expires_at");
    expect(resealMigration).toContain("new_preparation_expires_at");
    expect(resealMigration).toContain("interval '30 seconds'");
    expect(resealMigration).toMatch(/operation_row\.state <> 'PREPARED'[\s\S]*operation_row\.mutation_request_id IS NOT NULL/u);
    expect(resealMigration).toContain("accounting_case_operation_is_reseal_update");
    expect(resealMigration).toContain("operation reseal update lacks exact append-only evidence");
    expect(resealMigration).toContain("replacement preparation is invalid or lacks required runway");
    expect(resealMigration).toContain("old_preparation_row.state NOT IN ('PREPARED', 'EXPIRED')");
    expect(resealMigration).toMatch(/old_preparation_row\.state = 'EXPIRED'[\s\S]*old_preparation_row\.expires_at > header_row\.checked_at/u);
    expect(resealMigration).toMatch(/xero_mutation_requests request_row[\s\S]*request_row\.preparation_id = NEW\.old_preparation_id/u);
    expect(resealMigration).toMatch(/prepared_operation\.state = 'PREPARED'[\s\S]*NOT EXISTS/u);
    expect(resealMigration).toMatch(/old_preparation\.expires_at < reseal_row\.minimum_preparation_expires_at/u);
  });

  it("serializes competing reseals and advances the seal only with the execution claim", () => {
    expect(resealMigration).toMatch(/FROM accounting_case_versions[\s\S]*FOR UPDATE/u);
    expect(resealMigration).toContain("PRIMARY KEY (case_id, case_version, reseal_revision)");
    expect(resealMigration).toContain("must append exactly once to the effective preflight seal");
    expect(resealMigration).toContain("effective preflight seal may advance only with an atomic reseal claim");
    expect(resealMigration).toMatch(/NEW\.state <> 'EXECUTING'[\s\S]*NEW\.execution_request_id/u);
  });
});
