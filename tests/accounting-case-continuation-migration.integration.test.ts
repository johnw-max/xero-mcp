import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe.sequential : describe.skip;
const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const schema = `xero_case_034_${suffix}`;
const migrationsDirectory = resolve(process.cwd(), "migrations");
let pool: pg.Pool | undefined;

function quoted(value: string): string {
  if (!/^xero_case_034_[a-z0-9_]+$/u.test(value)) throw new Error("Refusing unsafe disposable schema name");
  return `"${value}"`;
}

async function applyThrough(client: PoolClient, head: string): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+.*\.sql$/u.test(file)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (file > head) break;
    const exists = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
      [file],
    );
    if (exists.rows[0]?.exists) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(resolve(migrationsDirectory, file), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return applied;
}

describeWithPostgres("migration 034 real PostgreSQL continuation state", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    if (!/(?:test|ci|sandbox|dev)/iu.test(basename(parsed.pathname))) {
      throw new Error("TEST_DATABASE_URL must identify a disposable test database");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${quoted(schema)}`);
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
    await pool.end();
  }, 120_000);

  it("rolls back 034 DDL when migration recording fails, then installs it reentrantly", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      expect(await applyThrough(client, "033_accounting_case_business_write_reservations.sql"))
        .toContain("033_accounting_case_business_write_reservations.sql");
      const migration034 = await readFile(
        resolve(migrationsDirectory, "034_accounting_case_continuation.sql"),
        "utf8",
      );
      await client.query("BEGIN");
      try {
        await client.query(migration034);
        // Simulate a runner failure after DDL but before schema_migrations is
        // recorded. The outer runner transaction must own and roll back both.
        await client.query("SELECT * FROM accounting_case_034_forced_recording_failure");
        throw new Error("forced migration-recording failure did not fail");
      } catch {
        await client.query("ROLLBACK");
      }
      const rolledBack = await client.query<{ stateCheck: string; recorded: boolean }>(`SELECT
        pg_get_constraintdef(constraint_row.oid) AS "stateCheck",
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE version = '034_accounting_case_continuation.sql'
        ) AS recorded
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = 'accounting_case_versions'::regclass
          AND constraint_row.conname = 'accounting_case_versions_state_check'`);
      expect(rolledBack.rows).toHaveLength(1);
      expect(rolledBack.rows[0]).toMatchObject({ recorded: false });
      expect(rolledBack.rows[0]!.stateCheck).not.toContain("AWAITING_CONTINUATION");

      expect(await applyThrough(client, "034_accounting_case_continuation.sql"))
        .toEqual(["034_accounting_case_continuation.sql"]);
      await expect(applyThrough(client, "034_accounting_case_continuation.sql")).resolves.toEqual([]);
      const contract = await client.query<{ stateCheck: string; guard: string }>(`SELECT
        pg_get_constraintdef(oid) AS "stateCheck",
        pg_get_functiondef('accounting_case_version_guard()'::regprocedure) AS guard
        FROM pg_constraint
        WHERE conrelid = 'accounting_case_versions'::regclass
          AND conname = 'accounting_case_versions_state_check'`);
      expect(contract.rows).toHaveLength(1);
      expect(contract.rows[0]!.stateCheck).toContain("AWAITING_CONTINUATION");
      expect(contract.rows[0]!.guard).toContain("EXECUTING");
      expect(contract.rows[0]!.guard).toContain("PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION");
      expect(contract.rows[0]!.guard).toContain("READBACK_VERIFIED");
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);
});
