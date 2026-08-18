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
  clean: `xero_case_031_clean_${suffix}`,
  upgrade: `xero_case_031_upgrade_${suffix}`,
};
let pool: pg.Pool | undefined;

function quotedSchema(schema: string): string {
  if (!/^xero_case_031_(?:clean|upgrade)_[a-z0-9_]+$/u.test(schema)) {
    throw new Error("Refusing unsafe disposable PostgreSQL schema name");
  }
  return `"${schema}"`;
}

async function useSchema(client: PoolClient, schema: string): Promise<void> {
  await client.query(`SET search_path TO ${quotedSchema(schema)}`);
}

async function applyMigrationsThrough(
  client: PoolClient,
  finalVersion: "030_accounting_case_preflight_reseal.sql" | "031_accounting_case_economic_readback_convergence.sql",
): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+.*\.sql$/u.test(file))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (file > finalVersion) break;
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

async function seedPre031PayloadMismatch(client: PoolClient): Promise<{
  mutationRequestId: string;
  canonicalPayloadHash: string;
  readbackPayloadHash: string;
  readbackSnapshot: Record<string, unknown>;
  updatedAt: Date;
}> {
  const discriminator = randomBytes(16).toString("hex");
  const preparationId = `xmp_${discriminator}`;
  const mutationRequestId = `xmr_${discriminator}`;
  const actorId = `actor-${discriminator}`;
  const workspaceId = `workspace-${discriminator}`;
  const tenantId = `tenant-${discriminator}`;
  const installationId = `installation-${discriminator}`;
  const bindingId = `binding-${discriminator}`;
  const connectionId = `connection-${discriminator}`;
  const targetSessionId = `target-${discriminator}`;
  const canonicalPayload = {
    objectType: "QUOTE",
    reference: `legacy-${discriminator}`,
    status: "DRAFT",
  };
  const readbackCanonicalPayload = {
    ...canonicalPayload,
    reference: `provider-altered-${discriminator}`,
  };
  const xeroObjectId = `quote-${discriminator}`;
  const readbackSnapshot = {
    xeroObjectId,
    status: "DRAFT",
    canonicalPayload: readbackCanonicalPayload,
  };
  const canonicalPayloadHash = "a".repeat(64);
  const readbackPayloadHash = "b".repeat(64);
  const sourceSha256 = "c".repeat(64);
  const confirmationSummaryHash = "d".repeat(64);
  const confirmationPhraseHash = "e".repeat(64);
  const readbackSnapshotHash = "f".repeat(64);
  const createdAt = new Date("2026-08-12T01:00:00.000Z");
  const writeStartedAt = new Date("2026-08-12T01:01:00.000Z");
  const updatedAt = new Date("2026-08-12T01:02:00.000Z");

  await client.query(`INSERT INTO xero_mutation_preparations (
      preparation_id, actor_id, workspace_id, tenant_id, oauth_installation_id,
      binding_id, connection_id, binding_revision, target_session_id,
      object_type, operation, canonical_payload, canonical_payload_hash,
      source_ref, source_unit_key, source_sha256, source_evidence_type,
      confirmation_summary_hash, confirmation_phrase_hash,
      state, expires_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, 1, $8,
      'QUOTE', 'CREATE_DRAFT', $9::jsonb, $10,
      $11, $12, $13, 'AGENT_ASSERTED_UNVERIFIED',
      $14, $15,
      'PREPARED', $16, $17, $17
    )`, [
    preparationId,
    actorId,
    workspaceId,
    tenantId,
    installationId,
    bindingId,
    connectionId,
    targetSessionId,
    canonicalPayload,
    canonicalPayloadHash,
    `host-upload:legacy-${discriminator}`,
    `row:${discriminator}`,
    sourceSha256,
    confirmationSummaryHash,
    confirmationPhraseHash,
    new Date("2026-08-12T03:00:00.000Z"),
    createdAt,
  ]);

  await client.query(`INSERT INTO xero_mutation_requests (
      mutation_request_id, preparation_id, request_id,
      actor_id, workspace_id, tenant_id, oauth_installation_id,
      binding_id, connection_id, binding_revision, target_session_id,
      object_type, operation, canonical_payload, canonical_payload_hash,
      source_ref, source_unit_key, source_sha256, source_evidence_type,
      confirmation_summary_hash, authorization_receipt,
      state, xero_object_id, write_receipt,
      readback_snapshot, readback_snapshot_hash,
      readback_canonical_payload, readback_payload_hash, readback_status,
      confirmed_at, write_started_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6, $7,
      $8, $9, 1, $10,
      'QUOTE', 'CREATE_DRAFT', $11::jsonb, $12,
      $13, $14, $15, 'AGENT_ASSERTED_UNVERIFIED',
      $16, $17::jsonb,
      'READBACK_MISMATCH', $18, $19::jsonb,
      $20::jsonb, $21,
      $22::jsonb, $23, 'DRAFT',
      $24, $25, $24, $26
    )`, [
    mutationRequestId,
    preparationId,
    `upgrade-${discriminator}`,
    actorId,
    workspaceId,
    tenantId,
    installationId,
    bindingId,
    connectionId,
    targetSessionId,
    canonicalPayload,
    canonicalPayloadHash,
    `host-upload:legacy-${discriminator}`,
    `row:${discriminator}`,
    sourceSha256,
    confirmationSummaryHash,
    { receiptType: "LEGACY_CONFIRMATION_AUTHORITY" },
    xeroObjectId,
    { providerRequestId: `provider-${discriminator}` },
    readbackSnapshot,
    readbackSnapshotHash,
    readbackCanonicalPayload,
    readbackPayloadHash,
    createdAt,
    writeStartedAt,
    updatedAt,
  ]);

  return {
    mutationRequestId,
    canonicalPayloadHash,
    readbackPayloadHash,
    readbackSnapshot,
    updatedAt,
  };
}

async function assert031Contract(client: PoolClient, schema: string): Promise<void> {
  const result = await client.query<{
    migrationApplied: boolean;
    receiptColumnPresent: boolean;
    lifecycleSupportsEconomics: boolean;
    triggerSupportsDemotion: boolean;
  }>(`SELECT
    EXISTS (
      SELECT 1 FROM schema_migrations
      WHERE version = '031_accounting_case_economic_readback_convergence.sql'
    ) AS "migrationApplied",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'xero_mutation_requests'
        AND column_name = 'readback_mismatch_receipt'
        AND data_type = 'jsonb'
    ) AS "receiptColumnPresent",
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'xero_mutation_request_lifecycle_check'
        AND conrelid = format('%I.xero_mutation_requests', $1)::regclass
        AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%ACCOUNTING_CASE_ECONOMICS%'
    ) AS "lifecycleSupportsEconomics",
    EXISTS (
      SELECT 1
      FROM pg_proc function_meta
      JOIN pg_namespace namespace_meta ON namespace_meta.oid = function_meta.pronamespace
      WHERE namespace_meta.nspname = $1
        AND function_meta.proname = 'xero_mutation_request_immutable_guard'
        AND pg_get_functiondef(function_meta.oid) LIKE '%case_economics_demotion%'
    ) AS "triggerSupportsDemotion"`, [schema]);
  expect(result.rows[0]).toEqual({
    migrationApplied: true,
    receiptColumnPresent: true,
    lifecycleSupportsEconomics: true,
    triggerSupportsDemotion: true,
  });
}

describeWithPostgres("migration 031 real PostgreSQL upgrade paths", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    if (!/(?:test|ci|sandbox|dev)/iu.test(basename(parsed.pathname))) {
      throw new Error("TEST_DATABASE_URL must identify a disposable test database");
    }
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    for (const schema of Object.values(schemas)) {
      await pool.query(`CREATE SCHEMA ${quotedSchema(schema)}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    for (const schema of Object.values(schemas)) {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema(schema)} CASCADE`);
    }
    await pool.end();
  }, 120_000);

  it("applies a clean 001-through-031 schema and is reentrant", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await useSchema(client, schemas.clean);
      const applied = await applyMigrationsThrough(
        client,
        "031_accounting_case_economic_readback_convergence.sql",
      );
      expect(applied).toContain("031_accounting_case_economic_readback_convergence.sql");
      await assert031Contract(client, schemas.clean);
      await expect(applyMigrationsThrough(
        client,
        "031_accounting_case_economic_readback_convergence.sql",
      )).resolves.toEqual([]);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);

  it("upgrades an already-installed 030 schema without rewriting an old migration", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await useSchema(client, schemas.upgrade);
      const through030 = await applyMigrationsThrough(
        client,
        "030_accounting_case_preflight_reseal.sql",
      );
      expect(through030.at(-1)).toBe("030_accounting_case_preflight_reseal.sql");
      const legacyMismatch = await seedPre031PayloadMismatch(client);
      await expect(applyMigrationsThrough(
        client,
        "031_accounting_case_economic_readback_convergence.sql",
      )).resolves.toEqual(["031_accounting_case_economic_readback_convergence.sql"]);
      await assert031Contract(client, schemas.upgrade);
      const upgradedMismatch = await client.query<{
        state: string;
        canonicalPayloadHash: string;
        readbackPayloadHash: string;
        readbackSnapshot: Record<string, unknown>;
        readbackMismatchReceipt: Record<string, unknown>;
        updatedAt: Date;
      }>(`SELECT
        state,
        canonical_payload_hash AS "canonicalPayloadHash",
        readback_payload_hash AS "readbackPayloadHash",
        readback_snapshot AS "readbackSnapshot",
        readback_mismatch_receipt AS "readbackMismatchReceipt",
        updated_at AS "updatedAt"
      FROM xero_mutation_requests
      WHERE mutation_request_id = $1`, [legacyMismatch.mutationRequestId]);
      expect(upgradedMismatch.rows[0]).toEqual({
        state: "READBACK_MISMATCH",
        canonicalPayloadHash: legacyMismatch.canonicalPayloadHash,
        readbackPayloadHash: legacyMismatch.readbackPayloadHash,
        readbackSnapshot: legacyMismatch.readbackSnapshot,
        readbackMismatchReceipt: {
          receiptType: "XERO_READBACK_MISMATCH",
          mismatchType: "PAYLOAD_OR_STATUS",
          reasonCodes: ["CANONICAL_PAYLOAD_HASH_MISMATCH"],
        },
        updatedAt: legacyMismatch.updatedAt,
      });
      await expect(applyMigrationsThrough(
        client,
        "031_accounting_case_economic_readback_convergence.sql",
      )).resolves.toEqual([]);
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);
});
