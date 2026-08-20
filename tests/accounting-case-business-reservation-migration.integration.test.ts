import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashObject } from "../src/security/hash.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe.sequential : describe.skip;
const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const schema = `xero_case_033_${suffix}`;
const migrationsDirectory = resolve(process.cwd(), "migrations");
let pool: pg.Pool | undefined;

function quoted(value: string): string {
  if (!/^xero_case_033_[a-z0-9_]+$/u.test(value)) throw new Error("Refusing unsafe disposable schema name");
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

function operation(
  caseId: string,
  tenantId: string,
  hash: string,
  ordinal: number,
  businessIdentityHash = "f".repeat(64),
  reservation: {
    scope: "ALL_OCCURRENCES" | "DATED_OCCURRENCE";
    occurrenceDate?: string;
    reference?: string;
  } = {
    scope: "DATED_OCCURRENCE",
    occurrenceDate: "2026-08-01",
  },
) {
  const operationId = `op-${caseId}`;
  const eventId = `event-${caseId}`;
  const actionId = "customer_invoice.create_draft";
  const nativeRoute = "SALES_INVOICE";
  const sourceRevisionHash = "b".repeat(64);
  const canonicalPayload = {
    reference: "RECURRING-REF",
    documentDate: "2026-08-01",
    net: "100.0000",
    xeroContactId: "contact-a",
  };
  const businessIdentity = {
    schemaVersion: "accounting-case-business-identity:v2",
    providerId: "xero",
    kind: "LEDGER_RECURRING_REFERENCE_OCCURRENCE",
    canonicalFields: {
      route: nativeRoute,
      contactId: "contact-a",
      reference: "RECURRING-REF",
      documentDate: "2026-08-01",
      currency: "SGD",
    },
  };
  const businessReservation = {
    schemaVersion: "accounting-case-business-reservation:v1",
    providerId: "xero",
    kind: "LEDGER_DOCUMENT_OCCURRENCE",
    canonicalFields: {
      route: nativeRoute,
      contactId: "contact-a",
      reference: reservation.reference ?? "RECURRING-REF",
    },
    coordinateHash: "9".repeat(64),
    scope: reservation.scope,
    ...(reservation.scope === "DATED_OCCURRENCE"
      ? { occurrenceDate: reservation.occurrenceDate ?? "2026-08-01" }
      : {}),
  };
  return {
    caseId, tenantId, operationId, eventId, actionId, nativeRoute, sourceRevisionHash,
    canonicalPayload, canonicalPayloadHash: hash, businessIdentity, businessIdentityHash,
    businessReservation, ordinal,
    operationJson: {
      caseId, caseVersion: 1, operationId, eventId, actionId, nativeRoute,
      dependencyEventKeys: [], canonicalPayload, canonicalPayloadHash: hash,
      businessIdentity, businessIdentityHash, businessReservation, sourceRevisionHash,
    },
  };
}

async function insertPrepared(client: PoolClient, value: ReturnType<typeof operation>): Promise<void> {
  await client.query(
    `INSERT INTO accounting_case_operations(
       case_id, case_version, tenant_id, operation_id, ordinal, event_id, action_id, native_route,
       dependency_event_keys, operation_json, canonical_payload, canonical_payload_hash,
       business_identity, business_identity_hash, source_revision_hash,
       business_reservation, business_reservation_coordinate,
       business_reservation_coordinate_hash,
       business_reservation_scope, business_reservation_occurrence_date,
       state, preparation_id, original_preparation_id,
       preparation_canonical_payload_hash, operation_source_sha256, created_at, updated_at
     ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'{}',$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,
       $14::jsonb,$15::jsonb,$16,$17,$18,
       'PREPARED',$19,$19,$20,$21,now(),now())`,
    [
      value.caseId, value.tenantId, value.operationId, value.ordinal, value.eventId, value.actionId,
      value.nativeRoute, value.operationJson, value.canonicalPayload, value.canonicalPayloadHash,
      value.businessIdentity, value.businessIdentityHash, value.sourceRevisionHash,
      value.businessReservation,
      {
        schemaVersion: value.businessReservation.schemaVersion,
        providerId: value.businessReservation.providerId,
        kind: value.businessReservation.kind,
        canonicalFields: value.businessReservation.canonicalFields,
      },
      value.businessReservation.coordinateHash,
      value.businessReservation.scope,
      value.businessReservation.scope === "DATED_OCCURRENCE"
        ? value.businessReservation.occurrenceDate
        : null,
      `prep-${value.caseId}`, "c".repeat(64), "d".repeat(64),
    ],
  );
}

async function insertLegacyPending(client: PoolClient, value: ReturnType<typeof operation>): Promise<void> {
  const { businessReservation: _reservation, ...legacyOperationJson } = value.operationJson;
  await client.query(
    `INSERT INTO accounting_case_operations(
       case_id, case_version, tenant_id, operation_id, ordinal, event_id, action_id, native_route,
       dependency_event_keys, operation_json, canonical_payload, canonical_payload_hash,
       business_identity, business_identity_hash, source_revision_hash,
       state, created_at, updated_at
     ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'{}',$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,
       'PENDING',now(),now())`,
    [
      value.caseId, value.tenantId, value.operationId, value.ordinal, value.eventId, value.actionId,
      value.nativeRoute, legacyOperationJson, value.canonicalPayload, value.canonicalPayloadHash,
      value.businessIdentity, value.businessIdentityHash, value.sourceRevisionHash,
    ],
  );
}

function contactOperation(
  caseId: string,
  tenantId: string,
  identity: {
    kind: "LEGAL_REGISTRY";
    jurisdiction: string;
    registryScheme: string;
    number: string;
  } | {
    kind: "PROVIDER_TENANT_ACCOUNT";
    providerId: "xero";
    namespace: string;
    number: string;
  },
) {
  const businessIdentity = identity.kind === "LEGAL_REGISTRY"
    ? {
        schemaVersion: "accounting-case-business-identity:v2",
        providerId: "xero",
        kind: "LEGAL_REGISTRY_CONTACT",
        canonicalFields: {
          jurisdiction: identity.jurisdiction.toUpperCase(),
          registryScheme: identity.registryScheme.toUpperCase(),
          number: identity.number.toUpperCase(),
        },
      }
    : {
        schemaVersion: "accounting-case-business-identity:v2",
        providerId: "xero",
        kind: "PROVIDER_TENANT_CONTACT_ACCOUNT",
        canonicalFields: {
          providerId: identity.providerId,
          namespace: identity.namespace.toUpperCase(),
          number: identity.number.toUpperCase(),
        },
      };
  const reservationCoordinate = {
    schemaVersion: "accounting-case-business-reservation:v1",
    providerId: "xero",
    kind: "PROVIDER_CONTACT_BARE_NUMBER",
    canonicalFields: {
      fieldKind: identity.kind === "LEGAL_REGISTRY" ? "COMPANY_NUMBER" : "ACCOUNT_NUMBER",
      number: identity.number.toUpperCase(),
    },
  };
  const businessReservation = {
    ...reservationCoordinate,
    coordinateHash: hashObject(reservationCoordinate),
    scope: "ALL_OCCURRENCES" as const,
  };
  const canonicalPayload = {
    schemaVersion: "accounting-case-contact:v3",
    usageRoles: ["CUSTOMER"],
    name: `Contact ${caseId}`,
    durableIdentity: identity,
    ...(identity.kind === "LEGAL_REGISTRY"
      ? { companyNumber: identity.number }
      : { accountNumber: identity.number }),
  };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const businessIdentityHash = hashObject(businessIdentity);
  const operationId = `op-${caseId}`;
  const eventId = `event-${caseId}`;
  const sourceRevisionHash = hashObject({ caseId, source: "contact" });
  const operationJson = {
    caseId,
    caseVersion: 1,
    operationId,
    eventId,
    actionId: "contact.create_basic",
    nativeRoute: "CONTACT_CREATE",
    dependencyEventKeys: [],
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash,
    businessReservation,
    sourceRevisionHash,
  };
  return {
    caseId,
    tenantId,
    operationId,
    eventId,
    canonicalPayload,
    canonicalPayloadHash,
    businessIdentity,
    businessIdentityHash,
    businessReservation,
    reservationCoordinate,
    sourceRevisionHash,
    operationJson,
  };
}

async function insertPendingContact(
  client: PoolClient,
  value: ReturnType<typeof contactOperation>,
): Promise<void> {
  await client.query(
    `INSERT INTO accounting_case_operations(
       case_id, case_version, tenant_id, operation_id, ordinal, event_id, action_id, native_route,
       dependency_event_keys, operation_json, canonical_payload, canonical_payload_hash,
       business_identity, business_identity_hash, source_revision_hash,
       business_reservation, business_reservation_coordinate,
       business_reservation_coordinate_hash, business_reservation_scope,
       business_reservation_occurrence_date, state, created_at, updated_at
     ) VALUES ($1,1,$2,$3,0,$4,'contact.create_basic','CONTACT_CREATE','{}',$5::jsonb,$6::jsonb,$7,
       $8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,'ALL_OCCURRENCES',NULL,'PENDING',now(),now())`,
    [
      value.caseId,
      value.tenantId,
      value.operationId,
      value.eventId,
      value.operationJson,
      value.canonicalPayload,
      value.canonicalPayloadHash,
      value.businessIdentity,
      value.businessIdentityHash,
      value.sourceRevisionHash,
      value.businessReservation,
      value.reservationCoordinate,
      value.businessReservation.coordinateHash,
    ],
  );
}

describeWithPostgres("migration 035 real PostgreSQL business reservation scopes", () => {
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

  it("installs 001 through 035, is reentrant, and drops reference-only indexes", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      expect(await applyThrough(client, "035_accounting_case_business_reservation_scopes.sql"))
        .toContain("035_accounting_case_business_reservation_scopes.sql");
      await expect(applyThrough(client, "035_accounting_case_business_reservation_scopes.sql")).resolves.toEqual([]);
      const indexes = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class
         WHERE relnamespace = current_schema()::regnamespace
           AND relname = ANY($1::text[])`,
        [[
          "accounting_case_active_business_write_unique_idx",
          "accounting_case_active_exact_payload_write_unique_idx",
          "xero_mutation_requests_active_business_payload_unique_idx",
          "xero_mutation_requests_active_contact_company_unique_idx",
          "xero_mutation_requests_active_contact_account_unique_idx",
        ]],
      );
      expect(indexes.rows.map((row) => row.relname).sort()).toEqual([
        "accounting_case_active_business_write_unique_idx",
        "accounting_case_active_exact_payload_write_unique_idx",
        "xero_mutation_requests_active_business_payload_unique_idx",
      ]);
      const reservationIndex = await client.query<{ definition: string }>(
        `SELECT pg_get_indexdef(index_meta.indexrelid) AS definition
         FROM pg_index index_meta
         JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
         WHERE index_class.relnamespace = current_schema()::regnamespace
           AND index_class.relname = 'accounting_case_business_reservation_lookup_idx'
           AND index_meta.indisvalid AND index_meta.indisready`,
      );
      expect(reservationIndex.rows).toHaveLength(1);
      expect(reservationIndex.rows[0]?.definition).toContain(
        "tenant_id, action_id, business_reservation_coordinate, business_reservation_scope, business_reservation_occurrence_date",
      );
      const removed = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_class
         WHERE relnamespace = current_schema()::regnamespace
           AND relname = ANY($1::text[])`,
        [[
          "posting_requests_active_supplier_reference_unique_idx",
          "posting_requests_tenant_active_supplier_reference_unique_idx",
          "posting_requests_active_supplier_ref_v030_unique_idx",
          "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
          "xero_mutation_requests_active_contact_company_unique_idx",
          "xero_mutation_requests_active_contact_account_unique_idx",
        ]],
      );
      expect(removed.rows[0]?.count).toBe("0");
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);

  it("upgrades an already-applied 033 row and blocks a current classification flip", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      const upgradeSchema = `${schema}_upgrade`;
      await client.query(`CREATE SCHEMA ${quoted(upgradeSchema)}`);
      await client.query(`SET search_path TO ${quoted(upgradeSchema)}`);
      expect(await applyThrough(client, "034_accounting_case_continuation.sql"))
        .toContain("034_accounting_case_continuation.sql");
      await client.query("SET session_replication_role = replica");
      const legacy = operation(
        "business-case-legacy-formal", "tenant-upgrade", "0".repeat(64), 0, "1".repeat(64),
        { scope: "ALL_OCCURRENCES" },
      );
      legacy.businessIdentity.kind = "LEDGER_FORMAL_DOCUMENT_NUMBER";
      legacy.operationJson.businessIdentity.kind = "LEDGER_FORMAL_DOCUMENT_NUMBER";
      legacy.operationJson.canonicalPayload.referenceKind = "FORMAL_DOCUMENT_NUMBER";
      await insertLegacyPending(client, legacy);

      expect(await applyThrough(client, "035_accounting_case_business_reservation_scopes.sql"))
        .toEqual(["035_accounting_case_business_reservation_scopes.sql"]);
      await client.query("SET session_replication_role = origin");
      const backfilled = await client.query<{
        business_reservation_scope: string;
        business_reservation_coordinate: Record<string, unknown>;
      }>(`SELECT business_reservation_scope, business_reservation_coordinate
          FROM accounting_case_operations WHERE operation_id = $1`, [legacy.operationId]);
      expect(backfilled.rows[0]?.business_reservation_scope).toBe("ALL_OCCURRENCES");
      expect(backfilled.rows[0]?.business_reservation_coordinate).toMatchObject({
        kind: "LEDGER_DOCUMENT_OCCURRENCE",
        canonicalFields: { contactId: "contact-a", reference: "RECURRING-REF", route: "SALES_INVOICE" },
      });

      await client.query("SET session_replication_role = replica");
      await client.query(
        `UPDATE accounting_case_operations SET state = 'PREPARED',
           preparation_id = 'prep-legacy', original_preparation_id = 'prep-legacy',
           preparation_canonical_payload_hash = $2, operation_source_sha256 = $3
         WHERE operation_id = $1`,
        [legacy.operationId, "c".repeat(64), "d".repeat(64)],
      );
      const current = operation(
        "business-case-current-generic", "tenant-upgrade", "2".repeat(64), 0, "3".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-09-01" },
      );
      await expect(insertPrepared(client, current)).rejects.toMatchObject({ code: "23505" });
      await client.query("SET session_replication_role = origin");
      await client.query(`DROP SCHEMA ${quoted(upgradeSchema)} CASCADE`);
    } finally {
      await client.query("SET session_replication_role = origin").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);

  it("lets PostgreSQL serialize the same business payload across Case IDs", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      await client.query("SET session_replication_role = replica");
      const hash = "a".repeat(64);
      await insertPrepared(client, operation("business-case-a", "tenant-a", hash, 0));
      await expect(insertPrepared(client, operation("business-case-b", "tenant-a", hash, 0)))
        .rejects.toMatchObject({ code: "23505" });
      await expect(insertPrepared(client, operation("business-case-c", "tenant-b", hash, 0)))
        .resolves.toBeUndefined();
      await expect(insertPrepared(client, operation(
        "business-case-d",
        "tenant-a",
        "e".repeat(64),
        0,
        "1".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-08-01", reference: "OTHER-REF" },
      )))
        .resolves.toBeUndefined();
    } finally {
      await client.query("SET session_replication_role = origin").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);

  it("blocks a changed payload that retains the same durable business identity", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      await client.query("SET session_replication_role = replica");
      await insertPrepared(client, operation(
        "business-case-identity-a", "tenant-identity", "2".repeat(64), 0, "3".repeat(64),
      ));
      await expect(insertPrepared(client, operation(
        "business-case-identity-b", "tenant-identity", "4".repeat(64), 0, "3".repeat(64),
      ))).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("SET session_replication_role = origin").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);
  it("blocks formal-to-generic scope flips but allows periodic dates", async () => {
    if (!pool) throw new Error("TEST_DATABASE_URL is required");
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoted(schema)}`);
      await client.query("SET session_replication_role = replica");
      await insertPrepared(client, operation(
        "business-case-formal", "tenant-scope", "5".repeat(64), 0, "6".repeat(64),
        { scope: "ALL_OCCURRENCES" },
      ));
      await expect(insertPrepared(client, operation(
        "business-case-flipped", "tenant-scope", "7".repeat(64), 0, "8".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-09-01" },
      ))).rejects.toMatchObject({ code: "23505" });

      await insertPrepared(client, operation(
        "business-case-period-a", "tenant-periodic", "a".repeat(64), 0, "b".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-08-01" },
      ));
      await expect(insertPrepared(client, operation(
        "business-case-period-b", "tenant-periodic", "c".repeat(64), 0, "d".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-09-01" },
      ))).resolves.toBeUndefined();
    } finally {
      await client.query("SET session_replication_role = origin").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
  }, 120_000);

  it("serializes concurrent mixed-scope inserts on the canonical coordinate", async () => {
    if (!pool || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const first = new Pool({ connectionString: databaseUrl, max: 1 });
    const second = new Pool({ connectionString: databaseUrl, max: 1 });
    const firstClient = await first.connect();
    const secondClient = await second.connect();
    try {
      await firstClient.query(`SET search_path TO ${quoted(schema)}`);
      await secondClient.query(`SET search_path TO ${quoted(schema)}`);
      await firstClient.query("SET session_replication_role = replica");
      await secondClient.query("SET session_replication_role = replica");
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await insertPrepared(firstClient, operation(
        "business-case-race-formal", "tenant-race", "1".repeat(64), 0, "2".repeat(64),
        { scope: "ALL_OCCURRENCES" },
      ));

      let secondSettled = false;
      const blocked = insertPrepared(secondClient, operation(
        "business-case-race-generic", "tenant-race", "3".repeat(64), 0, "4".repeat(64),
        { scope: "DATED_OCCURRENCE", occurrenceDate: "2026-10-01" },
      )).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => { secondSettled = true; });

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(secondSettled).toBe(false);
      await firstClient.query("COMMIT");
      const outcome = await blocked;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "23505" });
      await secondClient.query("ROLLBACK");
    } finally {
      await firstClient.query("ROLLBACK").catch(() => undefined);
      await secondClient.query("ROLLBACK").catch(() => undefined);
      await firstClient.query("SET session_replication_role = origin").catch(() => undefined);
      await secondClient.query("SET session_replication_role = origin").catch(() => undefined);
      firstClient.release();
      secondClient.release();
      await first.end();
      await second.end();
    }
  }, 120_000);

  it("installs 036 and atomically serializes cross-namespace PENDING contact claims before provider work", async () => {
    if (!pool || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query(`SET search_path TO ${quoted(schema)}`);
      expect(await applyThrough(
        migrationClient,
        "036_accounting_case_contact_bare_number_reservations.sql",
      )).toEqual(["036_accounting_case_contact_bare_number_reservations.sql"]);
      const installed = await migrationClient.query<{ function_exists: boolean; index_exists: boolean }>(
        `SELECT
           to_regprocedure('accounting_case_contact_bare_number_coordinate(jsonb,jsonb)') IS NOT NULL
             AS function_exists,
           to_regclass('accounting_case_contact_bare_number_reservation_lookup_idx') IS NOT NULL
             AS index_exists`,
      );
      expect(installed.rows[0]).toEqual({ function_exists: true, index_exists: true });
    } finally {
      await migrationClient.query("RESET search_path").catch(() => undefined);
      migrationClient.release();
    }

    const first = new Pool({ connectionString: databaseUrl, max: 1 });
    const second = new Pool({ connectionString: databaseUrl, max: 1 });
    const firstClient = await first.connect();
    const secondClient = await second.connect();
    try {
      await firstClient.query(`SET search_path TO ${quoted(schema)}`);
      await secondClient.query(`SET search_path TO ${quoted(schema)}`);
      await firstClient.query("SET session_replication_role = replica");
      await secondClient.query("SET session_replication_role = replica");
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      await insertPendingContact(firstClient, contactOperation(
        "contact-race-sg", "tenant-contact-race",
        { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "123" },
      ));

      let secondSettled = false;
      const blocked = insertPendingContact(secondClient, contactOperation(
        "contact-race-us", "tenant-contact-race",
        { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "123" },
      )).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => { secondSettled = true; });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(secondSettled).toBe(false);
      await firstClient.query("COMMIT");
      const outcome = await blocked;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "23505" });
      await secondClient.query("ROLLBACK");

      await expect(insertPendingContact(secondClient, contactOperation(
        "contact-other-number", "tenant-contact-race",
        { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "456" },
      ))).resolves.toBeUndefined();
      await expect(insertPendingContact(secondClient, contactOperation(
        "contact-other-tenant", "tenant-contact-other",
        { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "123" },
      ))).resolves.toBeUndefined();

      await insertPendingContact(secondClient, contactOperation(
        "contact-account-ar", "tenant-account-race",
        { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AR", number: "CUST-123" },
      ));
      await expect(insertPendingContact(secondClient, contactOperation(
        "contact-account-ap", "tenant-account-race",
        { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AP", number: "CUST-123" },
      ))).rejects.toMatchObject({ code: "23505" });
    } finally {
      await firstClient.query("ROLLBACK").catch(() => undefined);
      await secondClient.query("ROLLBACK").catch(() => undefined);
      await firstClient.query("SET session_replication_role = origin").catch(() => undefined);
      await secondClient.query("SET session_replication_role = origin").catch(() => undefined);
      firstClient.release();
      secondClient.release();
      await first.end();
      await second.end();
    }
  }, 120_000);
});
