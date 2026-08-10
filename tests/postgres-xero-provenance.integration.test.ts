import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { sha256 } from "../src/security/hash.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres Xero posting provenance", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const postingIds = new Set<string>();

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  });

  afterAll(async () => {
    if (!repository) return;
    if (postingIds.size > 0) {
      await repository.pool.query(
        "DELETE FROM posting_requests WHERE posting_request_id = ANY($1::text[])",
        [[...postingIds]],
      );
    }
    await repository.close();
  });

  it("backfills each legacy phase without inventing a historical draft receipt", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const client = await repository.pool.connect();
    const schema = `xero_provenance_${randomUUID().replaceAll("-", "")}`;
    const migrationSql = await readFile(
      resolve(process.cwd(), "migrations/015_xero_posting_write_provenance.sql"),
      "utf8",
    );
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`CREATE TABLE posting_requests (
        posting_request_id text PRIMARY KEY,
        state text NOT NULL,
        write_receipt jsonb,
        readback_snapshot jsonb
      )`);
      await client.query(
        `INSERT INTO posting_requests(posting_request_id, state, write_receipt, readback_snapshot)
         VALUES
           ('legacy-draft', 'APPROVAL_PENDING', '{"operation":"CREATE_DRAFT"}', '{"status":"DRAFT"}'),
           ('legacy-authorised', 'AUTHORISED_READBACK_VERIFIED', '{"operation":"AUTHORISE"}', '{"status":"AUTHORISED"}')`,
      );

      await client.query(migrationSql);
      await client.query(migrationSql);
      const result = await client.query(
        `SELECT posting_request_id, draft_write_receipt, draft_readback_snapshot,
                authorise_write_receipt, authorise_readback_snapshot
         FROM posting_requests ORDER BY posting_request_id`,
      );
      expect(result.rows).toEqual([
        {
          posting_request_id: "legacy-authorised",
          draft_write_receipt: null,
          draft_readback_snapshot: null,
          authorise_write_receipt: { operation: "AUTHORISE" },
          authorise_readback_snapshot: { status: "AUTHORISED" },
        },
        {
          posting_request_id: "legacy-draft",
          draft_write_receipt: { operation: "CREATE_DRAFT" },
          draft_readback_snapshot: { status: "DRAFT" },
          authorise_write_receipt: null,
          authorise_readback_snapshot: null,
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("preserves a draft written by an older rollback binary when 0.2.13 later authorises it", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomUUID();
    const postingRequestId = `pr_xero_provenance_${suffix}`;
    const invoiceId = `invoice-xero-provenance-${suffix}`;
    postingIds.add(postingRequestId);
    await repository.createOrGetPosting({
      postingRequestId,
      actorId: `actor-xero-provenance-${suffix}`,
      tenantId: `tenant-xero-provenance-${suffix}`,
      sourceRef: `synthetic://xero-provenance/${suffix}`,
      sourceSha256: sha256(`source-${suffix}`),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      providerPayload: { reference: `PROVENANCE-${suffix}` },
      requestPayloadHash: sha256(`request-${suffix}`),
      providerPayloadHash: sha256(`provider-${suffix}`),
      requestId: `request-xero-provenance-${suffix}`,
      createIdempotencyKey: `create-xero-provenance-${suffix}`,
    });
    const draftReceipt = { operation: "CREATE_DRAFT", invoiceId };
    const draftSnapshot = { invoiceId, status: "DRAFT" };
    await repository.pool.query(
      `UPDATE posting_requests SET
         xero_invoice_id = $2,
         state = 'AUTHORISING',
         authorise_request_id = $3,
         authorise_idempotency_key = $4,
         write_receipt = $5,
         readback_snapshot = $6,
         draft_write_receipt = NULL,
         draft_readback_snapshot = NULL,
         authorise_write_receipt = NULL,
         authorise_readback_snapshot = NULL
       WHERE posting_request_id = $1`,
      [
        postingRequestId,
        invoiceId,
        `authorise-request-${suffix}`,
        `authorise-key-${suffix}`,
        draftReceipt,
        draftSnapshot,
      ],
    );

    const authoriseReceipt = { operation: "AUTHORISE", invoiceId };
    const authoriseSnapshot = { invoiceId, status: "AUTHORISED" };
    await expect(repository.completeAuthorise(
      postingRequestId,
      authoriseReceipt,
      authoriseSnapshot,
    )).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      writeReceipt: authoriseReceipt,
      readbackSnapshot: authoriseSnapshot,
      draftWriteReceipt: draftReceipt,
      draftReadbackSnapshot: draftSnapshot,
      authoriseWriteReceipt: authoriseReceipt,
      authoriseReadbackSnapshot: authoriseSnapshot,
    });
  });
});
