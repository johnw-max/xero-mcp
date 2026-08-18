import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertRequiredMigrationsPresent } from "./requiredMigrations.js";

const { Pool } = pg;

export async function runMigrations(databaseUrl: string, migrationsDirectory: string): Promise<string[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  assertRequiredMigrationsPresent(files);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [2_026_080_003]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1) AS exists",
        [file],
      );
      if (exists.rows[0]?.exists) continue;

      const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [2_026_080_003]);
    } finally {
      client.release();
      await pool.end();
    }
  }
  return applied;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const migrationsDirectory = resolve(process.cwd(), "migrations");
  const applied = await runMigrations(databaseUrl, migrationsDirectory);
  console.log(JSON.stringify({ status: "ok", applied }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.name : "MigrationError";
    console.error(JSON.stringify({ status: "failed", errorClass: message }));
    process.exitCode = 1;
  });
}
