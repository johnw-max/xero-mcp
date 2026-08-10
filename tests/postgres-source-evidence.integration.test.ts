import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import type { SourceEvidenceType } from "../src/domain/models.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const evidenceTypes: SourceEvidenceType[] = [
  "LEGACY_UNVERIFIED",
  "AGENT_ASSERTED_UNVERIFIED",
  "SERVER_FINGERPRINTED_EXTRACTION",
];

describeWithPostgres("Postgres posting source evidence storage", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    await repository?.close();
  });

  it("backfills legacy rows, enforces the enum, and leaves new writes without a legacy default", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const client = await repository.pool.connect();
    const schema = `source_evidence_${randomUUID().replaceAll("-", "")}`;
    const migrationSql = await readFile(resolve(process.cwd(), "migrations/008_xero_source_evidence_type.sql"), "utf8");

    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`CREATE TABLE posting_requests (
        posting_request_id text PRIMARY KEY,
        source_sha256 text NOT NULL
      )`);
      await client.query(
        "INSERT INTO posting_requests(posting_request_id, source_sha256) VALUES ($1, $2)",
        ["legacy-row", "1".repeat(64)],
      );

      await client.query(migrationSql);
      await client.query(migrationSql);

      await expect(client.query(
        "SELECT source_sha256, source_evidence_type FROM posting_requests WHERE posting_request_id = $1",
        ["legacy-row"],
      )).resolves.toMatchObject({
        rows: [{ source_sha256: "1".repeat(64), source_evidence_type: "LEGACY_UNVERIFIED" }],
      });
      await expect(client.query(
        `SELECT is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'posting_requests' AND column_name = 'source_evidence_type'`,
        [schema],
      )).resolves.toMatchObject({
        rows: [{ is_nullable: "NO", column_default: null }],
      });
      await expect(client.query(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = $1 AND table_name = 'posting_requests'
           AND constraint_name = 'posting_requests_source_evidence_type_check'`,
        [schema],
      )).resolves.toMatchObject({ rowCount: 1 });

      await client.query("SAVEPOINT invalid_evidence_type");
      await expect(client.query(
        `INSERT INTO posting_requests(posting_request_id, source_sha256, source_evidence_type)
         VALUES ($1, $2, $3)`,
        ["invalid-row", "2".repeat(64), "HOST_SIGNED_FILE_RECEIPT"],
      )).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_evidence_type");

      await client.query("SAVEPOINT missing_evidence_type");
      await expect(client.query(
        "INSERT INTO posting_requests(posting_request_id, source_sha256) VALUES ($1, $2)",
        ["missing-row", "3".repeat(64)],
      )).rejects.toMatchObject({ code: "23502" });
      await client.query("ROLLBACK TO SAVEPOINT missing_evidence_type");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("round-trips every evidence type through create, idempotent read, and mapping", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    await expect(repository.readiness()).resolves.toBe(true);
    const suffix = randomUUID();
    const postingRequestIds: string[] = [];

    try {
      for (const [index, sourceEvidenceType] of evidenceTypes.entries()) {
        const postingRequestId = `pr_source_evidence_${suffix}_${index}`;
        postingRequestIds.push(postingRequestId);
        const sourceSha256 = String(index + 4).repeat(64);
        const input = {
          postingRequestId,
          actorId: `actor-source-evidence-${suffix}`,
          tenantId: `tenant-source-evidence-${suffix}`,
          sourceRef: `synthetic://source-evidence/${suffix}/${index}`,
          sourceSha256,
          sourceEvidenceType,
          providerPayload: { sourceEvidenceType },
          requestPayloadHash: "7".repeat(64),
          providerPayloadHash: "8".repeat(64),
          requestId: `request-source-evidence-${suffix}-${index}`,
          createIdempotencyKey: `create-source-evidence-${suffix}-${index}`,
        };

        await expect(repository.createOrGetPosting(input)).resolves.toMatchObject({
          created: true,
          posting: { sourceEvidenceType, sourceSha256 },
        });
        await expect(repository.createOrGetPosting(input)).resolves.toMatchObject({
          created: false,
          posting: { sourceEvidenceType, sourceSha256 },
        });
        await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
          sourceEvidenceType,
          sourceSha256,
        });
      }
    } finally {
      await repository.pool.query("DELETE FROM posting_requests WHERE posting_request_id = ANY($1::text[])", [
        postingRequestIds,
      ]);
    }
  });
});
