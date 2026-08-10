import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { runMigrations } from "../db/migrate.js";
import { PostgresAccountingRepository } from "../db/postgresRepository.js";

const { Pool } = pg;

async function assertSafeVerifierDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const environment = await pool.query<{
      database_name: string;
      server_version_num: string;
    }>(`
      SELECT current_database() AS database_name,
        current_setting('server_version_num') AS server_version_num
    `);
    const row = environment.rows[0];
    assert.ok(row);
    assert.match(row.database_name, /^xero_mcp_verify_[a-z0-9_]+$/i);
    assert.equal(Math.floor(Number(row.server_version_num) / 10_000), 17);
  } finally {
    await pool.end();
  }
}

async function expectConstraintFailure(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23514";
  });
}

export async function verifyPostgresAuditContinuity(databaseUrl: string): Promise<void> {
  await assertSafeVerifierDatabase(databaseUrl);
  await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  const repository = new PostgresAccountingRepository(databaseUrl);

  try {
    const initial = await repository.pool.query<{ audit_count: string }>(
      "SELECT count(*)::text AS audit_count FROM tool_audit_logs",
    );
    assert.equal(initial.rows[0]?.audit_count, "0");

    const schema = await repository.pool.query<{
      migration_applied: boolean;
      finished_at_nullable: boolean;
      partial_index_valid: boolean;
    }>(`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE version = '004_durable_audit_intent.sql'
        ) AS migration_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'tool_audit_logs'
            AND column_name = 'finished_at'
            AND is_nullable = 'YES'
        ) AS finished_at_nullable,
        EXISTS (
          SELECT 1
          FROM pg_index indexes
          JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
          WHERE index_class.relname = 'tool_audit_logs_in_progress_idx'
            AND indexes.indisvalid
            AND indexes.indisready
        ) AS partial_index_valid
    `);
    assert.deepEqual(schema.rows[0], {
      migration_applied: true,
      finished_at_nullable: true,
      partial_index_valid: true,
    });
    assert.equal(await repository.readiness(), true);

    await repository.pool.query(
      "DELETE FROM schema_migrations WHERE version = '004_durable_audit_intent.sql'",
    );
    assert.equal(await repository.readiness(), false);
    await repository.pool.query(
      "INSERT INTO schema_migrations(version) VALUES ('004_durable_audit_intent.sql')",
    );
    assert.equal(await repository.readiness(), true);

    const startedAt = new Date();
    await repository.beginAudit({
      callId: "call_audit_continuity_verifier",
      actorId: "synthetic-audit-verifier",
      tenantId: "synthetic-tenant",
      toolName: "synthetic_write_verifier",
      requestHash: "a".repeat(64),
      resultStatus: "IN_PROGRESS",
      startedAt,
    });

    const intent = await repository.pool.query<{
      result_status: string;
      finished_at: Date | null;
      record_id: string | null;
    }>(`
      SELECT result_status, finished_at, record_id
      FROM tool_audit_logs
      WHERE call_id = 'call_audit_continuity_verifier'
    `);
    assert.deepEqual(intent.rows[0], {
      result_status: "IN_PROGRESS",
      finished_at: null,
      record_id: null,
    });

    const finishedAt = new Date(startedAt.getTime() + 1_000);
    await repository.completeAudit("call_audit_continuity_verifier", {
      resultStatus: "SUCCEEDED",
      recordId: "synthetic-record-id",
      finishedAt,
    });
    const completed = await repository.pool.query<{
      result_status: string;
      finished_at: Date | null;
      record_id: string | null;
    }>(`
      SELECT result_status, finished_at, record_id
      FROM tool_audit_logs
      WHERE call_id = 'call_audit_continuity_verifier'
    `);
    assert.equal(completed.rows[0]?.result_status, "SUCCEEDED");
    assert.equal(completed.rows[0]?.record_id, "synthetic-record-id");
    assert.equal(completed.rows[0]?.finished_at?.toISOString(), finishedAt.toISOString());

    await assert.rejects(
      repository.completeAudit("call_audit_continuity_verifier", {
        resultStatus: "FAILED",
        errorClass: "MUST_NOT_OVERWRITE",
        finishedAt: new Date(),
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "CONFLICT",
    );

    await expectConstraintFailure(() => repository.pool.query(`
      INSERT INTO tool_audit_logs(
        call_id, actor_id, tool_name, request_hash, result_status, started_at, finished_at
      ) VALUES (
        'call_invalid_in_progress', 'synthetic-audit-verifier', 'synthetic_write_verifier',
        '${"b".repeat(64)}', 'IN_PROGRESS', now(), now()
      )
    `));
    await expectConstraintFailure(() => repository.pool.query(`
      INSERT INTO tool_audit_logs(
        call_id, actor_id, tool_name, request_hash, result_status, started_at, finished_at
      ) VALUES (
        'call_invalid_terminal', 'synthetic-audit-verifier', 'synthetic_write_verifier',
        '${"c".repeat(64)}', 'SUCCEEDED', now(), NULL
      )
    `));

    const terminal = await repository.pool.query<{ audit_count: string; in_progress_count: string }>(`
      SELECT
        count(*)::text AS audit_count,
        count(*) FILTER (WHERE result_status = 'IN_PROGRESS')::text AS in_progress_count
      FROM tool_audit_logs
    `);
    assert.deepEqual(terminal.rows[0], { audit_count: "1", in_progress_count: "0" });
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await verifyPostgresAuditContinuity(databaseUrl);
  console.log(JSON.stringify({
    status: "PASS",
    verifier: "postgres-audit-continuity",
    checks: [
      "postgres-17-isolated-database-guard",
      "migration-004-and-schema-shape",
      "readyz-requires-all-four-migrations",
      "durable-in-progress-intent",
      "single-terminal-transition",
      "completion-shape-constraints",
    ],
    sensitiveValuesIncluded: false,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const errorClass = error instanceof Error ? error.name : "AuditContinuityVerifierError";
    console.error(JSON.stringify({
      status: "FAIL",
      verifier: "postgres-audit-continuity",
      errorClass,
      sensitiveValuesIncluded: false,
    }));
    process.exitCode = 1;
  });
}
