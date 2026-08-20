import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe.sequential : describe.skip;
const migrationsDirectory = resolve(process.cwd(), "migrations");
const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const schemas = {
  clean: `xero_authority_032_clean_${suffix}`,
  upgrade: `xero_authority_032_upgrade_${suffix}`,
};
let pool: pg.Pool | undefined;

function quoted(schema: string): string {
  if (!/^xero_authority_032_(?:clean|upgrade)_[a-z0-9_]+$/u.test(schema)) {
    throw new Error("Refusing unsafe disposable PostgreSQL schema name");
  }
  return `"${schema}"`;
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

async function assertContract(client: PoolClient, schema: string): Promise<void> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'ledger_authority_snapshots'`,
    [schema],
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
    "provider_id", "revision", "snapshot_hash", "write_kill_switch_enabled",
    "standing_delegations", "published_at", "updated_at",
  ]));
}

describeWithPostgres("migration 032 real PostgreSQL upgrade paths", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    if (!/(?:test|ci|sandbox|dev)/iu.test(basename(parsed.pathname))) {
      throw new Error("TEST_DATABASE_URL must identify a disposable test database");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    for (const schema of Object.values(schemas)) await pool.query(`CREATE SCHEMA ${quoted(schema)}`);
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    for (const schema of Object.values(schemas)) await pool.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
    await pool.end();
  }, 120_000);

  it.each([
    [schemas.clean, undefined],
    [schemas.upgrade, "031_accounting_case_economic_readback_convergence.sql"],
  ] as const)("installs 032 clean or from 031 and is reentrant in %s", async (schema, priorHead) => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      if (priorHead) expect((await applyThrough(client, priorHead)).at(-1)).toBe(priorHead);
      expect(await applyThrough(client, "032_ledger_authority_snapshots.sql"))
        .toContain("032_ledger_authority_snapshots.sql");
      await assertContract(client, schema);
      await expect(applyThrough(client, "032_ledger_authority_snapshots.sql")).resolves.toEqual([]);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);
});
