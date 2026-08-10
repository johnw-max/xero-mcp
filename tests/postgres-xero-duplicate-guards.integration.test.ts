import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import {
  hasExactXeroDuplicateIndexes,
  type XeroDuplicateIndexCatalogRow,
} from "../src/db/xeroDuplicateIndexReadiness.js";
import type { CreatePostingInput } from "../src/domain/models.js";
import { sha256 } from "../src/security/hash.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres Xero active posting duplicate guards", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const tenants = new Set<string>();

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    if (!repository) return;
    if (tenants.size > 0) {
      await repository.pool.query("DELETE FROM posting_requests WHERE tenant_id = ANY($1::text[])", [[...tenants]]);
    }
    await repository.close();
  });

  function posting(overrides: Partial<CreatePostingInput> = {}): CreatePostingInput {
    const suffix = randomUUID();
    const tenantId = overrides.tenantId ?? `tenant-xero-duplicate-${suffix}`;
    tenants.add(tenantId);
    const requestId = overrides.requestId ?? `request-xero-duplicate-${suffix}`;
    const sourceSha256 = overrides.sourceSha256 ?? sha256(`source-${suffix}`);
    const providerPayload = overrides.providerPayload ?? {
      contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef",
      reference: `SUPPLIER-INV-${suffix}`,
    };
    const requestPayloadHash = overrides.requestPayloadHash ?? sha256(JSON.stringify({ requestId, providerPayload }));
    return {
      postingRequestId: overrides.postingRequestId ?? `pr_xero_duplicate_${suffix}`,
      actorId: overrides.actorId ?? `workspace-xero-duplicate:user:${suffix}`,
      tenantId,
      sourceRef: overrides.sourceRef ?? `synthetic://xero-duplicate/${suffix}`,
      sourceSha256,
      sourceEvidenceType: overrides.sourceEvidenceType ?? "AGENT_ASSERTED_UNVERIFIED",
      providerPayload,
      requestPayloadHash,
      providerPayloadHash: overrides.providerPayloadHash ?? requestPayloadHash,
      requestId,
      createIdempotencyKey: overrides.createIdempotencyKey ?? `create-xero-duplicate-${suffix}`,
      ...(overrides.documentType ? { documentType: overrides.documentType } : {}),
    };
  }

  async function applyMigrationsThrough(
    client: PoolClient,
    finalVersion: string,
  ): Promise<string[]> {
    await client.query(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(resolve(process.cwd(), "migrations")))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      await client.query("BEGIN");
      try {
        await client.query(await readFile(resolve(process.cwd(), "migrations", file), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(file);
      if (file === finalVersion) return applied;
    }
    throw new Error(`Migration ${finalVersion} was not found`);
  }

  it("applies the fresh 001-020 sequence with exact legacy and v030 indexes", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const schemaName = `xero_migration_020_fresh_${randomUUID().replaceAll("-", "")}`;
    const client = await repository.pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      const applied = await applyMigrationsThrough(
        client,
        "020_xero_runtime_readiness_compatibility.sql",
      );
      expect(applied[0]).toBe("001_init.sql");
      expect(applied.at(-1)).toBe("020_xero_runtime_readiness_compatibility.sql");
      expect(applied).toContain("018_xero_invoice_draft_one_time_confirmation.sql");
      expect(applied).toContain("019_xero_mcp_refresh_family_lifecycle.sql");

      const indexes = await client.query<XeroDuplicateIndexCatalogRow>(
        `SELECT index_class.relname AS "indexName",
                access_method.amname AS "accessMethod",
                index_meta.indisunique AS "isUnique",
                index_meta.indisvalid AS "isValid",
                index_meta.indisready AS "isReady",
                ARRAY(
                  SELECT pg_get_indexdef(index_meta.indexrelid, key_position, true)
                  FROM generate_series(1, index_meta.indnatts) AS key_position
                  ORDER BY key_position
                ) AS "keyDefinitions",
                pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_index index_meta
         JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
         JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
         JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
         JOIN pg_am access_method ON access_method.oid = index_class.relam
         WHERE table_namespace.nspname = $1
           AND table_class.relname = 'posting_requests'
           AND index_class.relname = ANY($2::text[])
         ORDER BY index_class.relname`,
        [schemaName, [
          "posting_requests_actor_tenant_request_create_unique_idx",
          "posting_requests_actor_tenant_request_create_v030_unique_idx",
          "posting_requests_active_source_unique_idx",
          "posting_requests_active_source_v030_unique_idx",
          "posting_requests_active_supplier_reference_unique_idx",
          "posting_requests_active_supplier_ref_v030_unique_idx",
          "posting_requests_tenant_active_source_unique_idx",
          "posting_requests_tenant_active_source_v030_unique_idx",
          "posting_requests_tenant_active_supplier_reference_unique_idx",
          "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
        ]],
      );
      expect(indexes.rows).toHaveLength(10);
      expect(hasExactXeroDuplicateIndexes(indexes.rows)).toBe(true);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("rolls migration 020 back completely when an exact legacy key conflicts", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const schemaName = `xero_migration_020_conflict_${randomUUID().replaceAll("-", "")}`;
    const client = await repository.pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await applyMigrationsThrough(client, "019_xero_mcp_refresh_family_lifecycle.sql");
      await client.query(
        `INSERT INTO posting_requests(
           posting_request_id, actor_id, tenant_id, source_ref, source_sha256,
           source_evidence_type, provider_payload, request_payload_hash,
           provider_payload_hash, state, request_id, create_idempotency_key,
           document_type
         ) VALUES
           ('compat-ap', 'actor-a', 'tenant-a', 'synthetic://compat/ap', $1,
            'AGENT_ASSERTED_UNVERIFIED', $3, $4, $4, 'BLOCKED_VALIDATION',
            'same-request', 'compat-ap-key', 'ACCPAY'),
           ('compat-ar', 'actor-a', 'tenant-a', 'synthetic://compat/ar', $2,
            'AGENT_ASSERTED_UNVERIFIED', $5, $6, $6, 'BLOCKED_VALIDATION',
            'same-request', 'compat-ar-key', 'ACCREC')`,
        [
          "1".repeat(64),
          "2".repeat(64),
          { contactId: "contact-ap", reference: "reference-ap" },
          "3".repeat(64),
          { contactId: "contact-ar", reference: "reference-ar" },
          "4".repeat(64),
        ],
      );

      await client.query("BEGIN");
      let migrationError: unknown;
      try {
        await client.query(await readFile(
          resolve(process.cwd(), "migrations/020_xero_runtime_readiness_compatibility.sql"),
          "utf8",
        ));
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ('020_xero_runtime_readiness_compatibility.sql')",
        );
        await client.query("COMMIT");
      } catch (error) {
        migrationError = error;
        await client.query("ROLLBACK");
      }
      expect(migrationError).toMatchObject({ code: "23505" });

      const indexes = await client.query<{ indexName: string; definition: string }>(
        `SELECT indexname AS "indexName", indexdef AS definition
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname IN (
             'posting_requests_actor_tenant_request_create_unique_idx',
             'posting_requests_actor_tenant_request_create_v030_unique_idx',
             'posting_requests_tenant_active_source_v030_unique_idx',
             'posting_requests_tenant_active_supplier_ref_v030_unique_idx'
           )
         ORDER BY indexname`,
        [schemaName],
      );
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]).toMatchObject({
        indexName: "posting_requests_actor_tenant_request_create_unique_idx",
      });
      expect(indexes.rows[0]?.definition).toContain(
        "actor_id, tenant_id, document_type, request_id, create_operation",
      );
      await expect(client.query(
        "SELECT 1 FROM schema_migrations WHERE version = '020_xero_runtime_readiness_compatibility.sql'",
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("rejects source-index catalog drift before migration 020 renames anything", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const schemaName = `xero_migration_020_drift_${randomUUID().replaceAll("-", "")}`;
    const client = await repository.pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await applyMigrationsThrough(client, "019_xero_mcp_refresh_family_lifecycle.sql");
      await client.query("DROP INDEX posting_requests_active_source_unique_idx");
      await client.query(`CREATE UNIQUE INDEX posting_requests_active_source_unique_idx
        ON posting_requests (actor_id, tenant_id, source_sha256)
        WHERE state = 'VALIDATED'`);

      await client.query("BEGIN");
      let migrationError: unknown;
      try {
        await client.query(await readFile(
          resolve(process.cwd(), "migrations/020_xero_runtime_readiness_compatibility.sql"),
          "utf8",
        ));
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ('020_xero_runtime_readiness_compatibility.sql')",
        );
        await client.query("COMMIT");
      } catch (error) {
        migrationError = error;
        await client.query("ROLLBACK");
      }
      expect(migrationError).toMatchObject({
        code: "55000",
        message: "Xero migration 020 requires the exact migration 016 source indexes before compatibility expansion.",
      });

      const indexes = await client.query<{ indexName: string }>(
        `SELECT indexname AS "indexName"
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname LIKE 'posting_requests%v030%'
         ORDER BY indexname`,
        [schemaName],
      );
      expect(indexes.rows).toHaveLength(0);
      await expect(client.query(
        "SELECT 1 FROM schema_migrations WHERE version = '020_xero_runtime_readiness_compatibility.sql'",
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("keeps exact 0.2.13 indexes and exact v030 guards ready together", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const indexes = await repository.pool.query<XeroDuplicateIndexCatalogRow>(
      `SELECT index_class.relname AS "indexName",
              access_method.amname AS "accessMethod",
              index_meta.indisunique AS "isUnique",
              index_meta.indisvalid AS "isValid",
              index_meta.indisready AS "isReady",
              ARRAY(
                SELECT pg_get_indexdef(index_meta.indexrelid, key_position, true)
                FROM generate_series(1, index_meta.indnatts) AS key_position
                ORDER BY key_position
              ) AS "keyDefinitions",
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
       FROM pg_index index_meta
       JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
       JOIN pg_am access_method ON access_method.oid = index_class.relam
       WHERE index_class.relname = ANY($1::text[])
       ORDER BY index_class.relname`,
      [[
        "posting_requests_actor_tenant_request_create_unique_idx",
        "posting_requests_actor_tenant_request_create_v030_unique_idx",
        "posting_requests_active_source_unique_idx",
        "posting_requests_active_source_v030_unique_idx",
        "posting_requests_active_supplier_reference_unique_idx",
        "posting_requests_active_supplier_ref_v030_unique_idx",
        "posting_requests_tenant_active_source_unique_idx",
        "posting_requests_tenant_active_source_v030_unique_idx",
        "posting_requests_tenant_active_supplier_reference_unique_idx",
        "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
      ]],
    );
    expect(indexes.rows).toHaveLength(10);
    expect(hasExactXeroDuplicateIndexes(indexes.rows)).toBe(true);
    expect(indexes.rows.find((index) =>
      index.indexName === "posting_requests_actor_tenant_request_create_unique_idx"
    )?.keyDefinitions).toEqual(["actor_id", "tenant_id", "request_id", "create_operation"]);
    expect(indexes.rows.find((index) =>
      index.indexName === "posting_requests_actor_tenant_request_create_v030_unique_idx"
    )?.keyDefinitions).toEqual(["actor_id", "tenant_id", "document_type", "request_id", "create_operation"]);

    for (const index of indexes.rows.filter((candidate) =>
      candidate.indexName.includes("v030") && candidate.predicate !== null
    )) {
      for (const state of [
        "VALIDATED",
        "DRAFT_READBACK_VERIFIED",
        "APPROVAL_PENDING",
        "APPROVED",
        "AUTHORISING",
        "AUTHORISED_READBACK_VERIFIED",
        "WRITE_RESULT_UNKNOWN",
        "READBACK_MISMATCH",
        "REJECTED",
      ]) {
        expect(index.predicate).toContain(state);
      }
      expect(index.predicate).not.toContain("BLOCKED_VALIDATION");
    }
    for (const index of indexes.rows.filter((candidate) =>
      !candidate.indexName.includes("v030") && candidate.predicate !== null
    )) {
      expect(index.predicate).not.toContain("DRAFT_READBACK_VERIFIED");
      expect(index.predicate).not.toContain("BLOCKED_VALIDATION");
    }
    await expect(repository.readiness()).resolves.toBe(true);
  });

  it.each([
    "018_xero_invoice_draft_one_time_confirmation.sql",
    "020_xero_runtime_readiness_compatibility.sql",
  ])("fails readiness when required migration provenance %s is missing", async (version) => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    await repository.pool.query("DELETE FROM schema_migrations WHERE version = $1", [version]);
    try {
      await expect(repository.readiness()).resolves.toBe(false);
    } finally {
      await repository.pool.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    }
    await expect(repository.readiness()).resolves.toBe(true);
  });

  it.each([
    [
      "posting_requests_active_source_unique_idx",
      "posting_requests_active_source_legacy_tampered_idx",
    ],
    [
      "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
      "posting_requests_tenant_supplier_v030_tampered_idx",
    ],
  ] as const)("fails 0.3 readiness when required index %s is missing", async (indexName, temporaryName) => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    await repository.pool.query(`ALTER INDEX ${indexName} RENAME TO ${temporaryName}`);
    try {
      await expect(repository.readiness()).resolves.toBe(false);
    } finally {
      await repository.pool.query(`ALTER INDEX ${temporaryName} RENAME TO ${indexName}`);
    }
    await expect(repository.readiness()).resolves.toBe(true);
  });

  it.each(["source_sha256", "contact_reference"] as const)(
    "fails migration 014 before replacing indexes for a cross-actor %s conflict",
    async (identityType) => {
      if (!repository) throw new Error("TEST_DATABASE_URL is required");
      const schemaName = `xero_migration_014_${randomUUID().replaceAll("-", "")}`;
      const migration = await readFile(
        resolve(process.cwd(), "migrations/014_xero_tenant_duplicate_guards.sql"),
        "utf8",
      );
      const client = await repository.pool.connect();
      try {
        await client.query(`CREATE SCHEMA ${schemaName}`);
        await client.query(`SET search_path TO ${schemaName}, public`);
        await client.query(`CREATE TABLE posting_requests (
          posting_request_id text PRIMARY KEY,
          actor_id text NOT NULL,
          tenant_id text NOT NULL,
          source_sha256 text NOT NULL,
          provider_payload jsonb NOT NULL,
          state text NOT NULL
        )`);
        await client.query(`CREATE UNIQUE INDEX posting_requests_active_source_unique_idx
          ON posting_requests (actor_id, tenant_id, source_sha256)
          WHERE state = 'VALIDATED'`);
        await client.query(`CREATE UNIQUE INDEX posting_requests_active_supplier_reference_unique_idx
          ON posting_requests (
            actor_id,
            tenant_id,
            (lower(provider_payload->>'contactId')),
            (lower(provider_payload->>'reference'))
          )
          WHERE state = 'VALIDATED'`);
        const sourceA = sha256(identityType === "source_sha256" ? "same-source" : "source-a");
        const sourceB = sha256(identityType === "source_sha256" ? "same-source" : "source-b");
        const payloadA = identityType === "contact_reference"
          ? { contactId: "CONTACT-A", reference: " Supplier-Reference " }
          : { contactId: "contact-a", reference: "reference-a" };
        const payloadB = identityType === "contact_reference"
          ? { contact: { contactId: "contact-a" }, reference: "supplier-reference" }
          : { contactId: "contact-b", reference: "reference-b" };
        await client.query(`INSERT INTO posting_requests VALUES
          ('migration-014-a', 'actor-a', 'tenant-a', $1, $3, 'VALIDATED'),
          ('migration-014-b', 'actor-b', 'tenant-a', $2, $4, 'VALIDATED')`, [
          sourceA,
          sourceB,
          payloadA,
          payloadB,
        ]);

        await client.query("BEGIN");
        await client.query("SAVEPOINT before_migration_014");
        let migrationError: unknown;
        try {
          await client.query(migration);
        } catch (error) {
          migrationError = error;
        }
        await client.query("ROLLBACK TO SAVEPOINT before_migration_014");
        expect(migrationError).toMatchObject({ code: "23505" });
        const indexes = await client.query<{ definition: string }>(
          `SELECT indexdef AS definition
           FROM pg_indexes
           WHERE schemaname = $1
             AND indexname IN (
               'posting_requests_active_source_unique_idx',
               'posting_requests_active_supplier_reference_unique_idx'
             )
           ORDER BY indexname`,
          [schemaName],
        );
        expect(indexes.rows).toHaveLength(2);
        expect(indexes.rows.every((row) => row.definition.includes("actor_id"))).toBe(true);
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET search_path").catch(() => undefined);
        await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        client.release();
      }
    },
  );

  it("serializes concurrent new request IDs for the same actor, tenant, and source", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting();
    const second = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      sourceSha256: first.sourceSha256,
      providerPayload: {
        contactId: "11111111-1111-4111-8111-111111111111",
        reference: "ANOTHER-REFERENCE",
      },
    });

    const results = await Promise.all([
      repository.createOrGetPosting(first),
      repository.createOrGetPosting(second),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.posting.postingRequestId)).size).toBe(1);
  });

  it("serializes concurrent new request IDs for a normalized contact and supplier reference", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting({
      providerPayload: {
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: "  Supplier-INV-CONCURRENT  ",
      },
    });
    const second = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      providerPayload: {
        contact: { contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef" },
        reference: "supplier-inv-concurrent",
      },
    });

    const results = await Promise.all([
      repository.createOrGetPosting(first),
      repository.createOrGetPosting(second),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.posting.postingRequestId)).size).toBe(1);
  });

  it("reports the temporary legacy-compatibility conflict when ACCREC references are reused", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting({
      documentType: "ACCREC",
      providerPayload: {
        invoiceType: "ACCREC",
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: "CUSTOMER-PO-REUSABLE",
      },
    });
    const second = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      documentType: "ACCREC",
      providerPayload: {
        invoiceType: "ACCREC",
        contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef",
        reference: " customer-po-reusable ",
      },
    });

    await expect(repository.createOrGetPosting(first)).resolves.toMatchObject({ created: true });
    await expect(repository.findActivePostingDuplicate({
      tenantId: first.tenantId,
      sourceSha256: second.sourceSha256,
      documentType: "ACCREC",
      contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef",
      normalizedReference: "customer-po-reusable",
    })).resolves.toBeUndefined();
    await expect(repository.createOrGetPosting(second)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The request conflicts with a temporary legacy-runtime duplicate guard.",
    });
    await expect(repository.getPosting(second.postingRequestId)).resolves.toBeUndefined();
  });

  it("keeps one tenant-global source guard across ACCPAY and ACCREC", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting();
    const second = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      sourceSha256: first.sourceSha256,
      documentType: "ACCREC",
      providerPayload: {
        invoiceType: "ACCREC",
        contactId: "11111111-1111-4111-8111-111111111111",
        reference: "DISTINCT-AR-REFERENCE",
      },
    });

    const created = await repository.createOrGetPosting(first);
    await expect(repository.createOrGetPosting(second)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: created.posting.postingRequestId, documentType: "ACCPAY" },
    });
  });

  it("normalizes contact and reference across canonical-request and Xero-readback payload shapes", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting({
      providerPayload: {
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: "  Supplier-INV-001  ",
      },
    });
    const created = await repository.createOrGetPosting(first);
    await repository.markDraftCreated(created.posting.postingRequestId, {
      xeroInvoiceId: "11111111-1111-4111-8111-111111111111",
      providerPayload: {
        contact: { contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef" },
        reference: "Supplier-INV-001",
      },
      providerPayloadHash: sha256("xero-readback"),
      writeReceipt: { operation: "CREATE_DRAFT" },
      readbackSnapshot: { status: "DRAFT" },
    });
    const second = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      providerPayload: {
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: "supplier-inv-001",
      },
    });

    await expect(repository.createOrGetPosting(second)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.postingRequestId, state: "APPROVAL_PENDING" },
    });
  });

  it("keeps request idempotency actor-scoped while tenant-scoping business identities", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting();
    const second = posting({
      actorId: `${first.actorId}-other-user`,
      tenantId: first.tenantId,
      requestId: first.requestId,
      sourceSha256: first.sourceSha256,
      providerPayload: {
        contactId: "11111111-1111-4111-8111-111111111111",
        reference: "DIFFERENT-BUSINESS-REFERENCE",
      },
    });

    await expect(repository.createOrGetPosting(first)).resolves.toMatchObject({ created: true });
    await expect(repository.createOrGetPosting(second)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.postingRequestId },
    });

    const sameReferenceForAnotherActor = posting({
      actorId: `${first.actorId}-third-user`,
      tenantId: first.tenantId,
      sourceSha256: sha256("different-source-same-reference"),
      providerPayload: first.providerPayload,
    });
    await expect(repository.createOrGetPosting(sameReferenceForAnotherActor)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.postingRequestId },
    });

    const sameRequestForOtherActor = posting({
      actorId: second.actorId,
      tenantId: first.tenantId,
      requestId: first.requestId,
      sourceSha256: sha256("different-business-document"),
      providerPayload: {
        contactId: "11111111-1111-4111-8111-111111111111",
        reference: "DIFFERENT-BUSINESS-REFERENCE",
      },
    });
    await expect(repository.createOrGetPosting(sameRequestForOtherActor)).resolves.toMatchObject({ created: true });
  });

  it("releases both partial guards after a local validation block", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting();
    await repository.createOrGetPosting(first);
    await repository.markPostingState(first.postingRequestId, "BLOCKED_VALIDATION");
    const corrected = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      sourceSha256: first.sourceSha256,
      providerPayload: first.providerPayload,
    });

    await expect(repository.createOrGetPosting(corrected)).resolves.toMatchObject({ created: true });
  });

  it("keeps source and normalized supplier-reference identities reserved after DRAFT rejection", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const first = posting({
      providerPayload: {
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: " Supplier-INV-REJECTED ",
      },
    });
    await repository.createOrGetPosting(first);
    await repository.markDraftCreated(first.postingRequestId, {
      xeroInvoiceId: "11111111-1111-4111-8111-111111111111",
      providerPayload: {
        contact: { contactId: "abcdefab-abcd-4bcd-8bcd-abcdefabcdef" },
        reference: "Supplier-INV-REJECTED",
      },
      providerPayloadHash: sha256("xero-rejected-readback"),
      writeReceipt: { operation: "CREATE_DRAFT" },
      readbackSnapshot: { status: "DRAFT" },
    });
    await repository.rejectPosting(first.postingRequestId, "reviewer-xero-duplicate", new Date());

    const sameSource = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      sourceSha256: first.sourceSha256,
      providerPayload: {
        contactId: "11111111-1111-4111-8111-111111111111",
        reference: "UNRELATED-REFERENCE",
      },
    });
    await expect(repository.createOrGetPosting(sameSource)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.postingRequestId, state: "REJECTED" },
    });

    const sameReference = posting({
      actorId: first.actorId,
      tenantId: first.tenantId,
      providerPayload: {
        contactId: "ABCDEFAB-ABCD-4BCD-8BCD-ABCDEFABCDEF",
        reference: "  supplier-inv-rejected  ",
      },
    });
    await expect(repository.createOrGetPosting(sameReference)).resolves.toMatchObject({
      created: false,
      posting: { postingRequestId: first.postingRequestId, state: "REJECTED" },
    });
  });
});
