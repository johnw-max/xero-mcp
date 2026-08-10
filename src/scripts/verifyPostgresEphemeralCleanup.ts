import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { runMigrations } from "../db/migrate.js";
import { PostgresAccountingRepository } from "../db/postgresRepository.js";
import type {
  EphemeralCleanupBatchResult,
  EphemeralCleanupCounts,
} from "../db/repository.js";

const cleanupAdvisoryLockKey = "2026080401";
const batchSize = 1_000;
const expiredConnectTicketCount = 10_000;
const expiredOAuthStateCount = 12;
const expiredDirectCsrfCount = 12;
const expiredParentCsrfCount = 1_500;
const expectedExpiredSessionCount = 2;
const concurrentCalls = 8;
const maxDrainCalls = 32;
const maxLockedReturnMs = 2_000;
const { Pool } = pg;

function emptyCounts(): EphemeralCleanupCounts {
  return {
    mcpRefreshRetryResponses: 0,
    oauthBrokerFlows: 0,
    oauthStates: 0,
    connectTickets: 0,
    operatorSessions: 0,
    reviewCsrfTokens: 0,
  };
}

function addCounts(target: EphemeralCleanupCounts, source: EphemeralCleanupCounts): void {
  target.mcpRefreshRetryResponses += source.mcpRefreshRetryResponses;
  target.oauthBrokerFlows += source.oauthBrokerFlows;
  target.oauthStates += source.oauthStates;
  target.connectTickets += source.connectTickets;
  target.operatorSessions += source.operatorSessions;
  target.reviewCsrfTokens += source.reviewCsrfTokens;
}

function allZero(counts: EphemeralCleanupCounts): boolean {
  return Object.values(counts).every((count) => count === 0);
}

function assertBoundedBatch(result: EphemeralCleanupBatchResult): void {
  for (const count of Object.values(result.deleted)) {
    assert.equal(Number.isSafeInteger(count), true);
    assert.equal(count >= 0, true);
    assert.equal(count <= batchSize, true);
  }
  if (!result.lockAcquired) assert.deepEqual(result.deleted, emptyCounts());
}

async function dataTableCounts(repository: PostgresAccountingRepository): Promise<Record<string, number>> {
  const result = await repository.pool.query<{
    oauth_states: string;
    connect_tickets: string;
    operator_sessions: string;
    review_csrf_tokens: string;
    provider_connections: string;
    posting_requests: string;
    tool_audit_logs: string;
  }>(`
    SELECT
      (SELECT count(*) FROM oauth_states)::text AS oauth_states,
      (SELECT count(*) FROM connect_tickets)::text AS connect_tickets,
      (SELECT count(*) FROM operator_sessions)::text AS operator_sessions,
      (SELECT count(*) FROM review_csrf_tokens)::text AS review_csrf_tokens,
      (SELECT count(*) FROM provider_connections)::text AS provider_connections,
      (SELECT count(*) FROM posting_requests)::text AS posting_requests,
      (SELECT count(*) FROM tool_audit_logs)::text AS tool_audit_logs
  `);
  const row = result.rows[0];
  assert.ok(row);
  return Object.fromEntries(Object.entries(row).map(([name, count]) => [name, Number(count)]));
}

async function protectedTableSnapshot(repository: PostgresAccountingRepository): Promise<Record<string, string>> {
  const result = await repository.pool.query<{
    provider_connections: string;
    posting_requests: string;
    tool_audit_logs: string;
  }>(`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(provider) ORDER BY provider.connection_id)::text, '[]')
         FROM provider_connections provider) AS provider_connections,
      (SELECT COALESCE(jsonb_agg(to_jsonb(posting) ORDER BY posting.posting_request_id)::text, '[]')
         FROM posting_requests posting) AS posting_requests,
      (SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.call_id)::text, '[]')
         FROM tool_audit_logs audit) AS tool_audit_logs
  `);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function assertMigrationAndSchema(repository: PostgresAccountingRepository): Promise<void> {
  const migration = await repository.pool.query<{
    cleanup_applied: boolean;
    shortcode_applied: boolean;
    audit_intent_applied: boolean;
  }>(`
    SELECT EXISTS (
      SELECT 1 FROM schema_migrations
      WHERE version = '002_ephemeral_cleanup_index.sql'
    ) AS cleanup_applied,
    EXISTS (
      SELECT 1 FROM schema_migrations
      WHERE version = '003_provider_connection_tenant_shortcode.sql'
    ) AS shortcode_applied,
    EXISTS (
      SELECT 1 FROM schema_migrations
      WHERE version = '004_durable_audit_intent.sql'
    ) AS audit_intent_applied
  `);
  assert.equal(migration.rows[0]?.cleanup_applied, true);
  assert.equal(migration.rows[0]?.shortcode_applied, true);
  assert.equal(migration.rows[0]?.audit_intent_applied, true);

  const index = await repository.pool.query<{
    index_definition: string;
    is_valid: boolean;
    is_ready: boolean;
  }>(`
    SELECT
      pg_get_indexdef(indexes.indexrelid) AS index_definition,
      indexes.indisvalid AS is_valid,
      indexes.indisready AS is_ready
    FROM pg_index indexes
    JOIN pg_class index_class ON index_class.oid = indexes.indexrelid
    JOIN pg_class table_class ON table_class.oid = indexes.indrelid
    WHERE table_class.relname = 'review_csrf_tokens'
      AND index_class.relname = 'review_csrf_session_idx'
  `);
  assert.equal(index.rowCount, 1);
  assert.equal(index.rows[0]?.is_valid, true);
  assert.equal(index.rows[0]?.is_ready, true);
  assert.match(index.rows[0]?.index_definition ?? "", /USING btree \(session_hash\)/);

  const foreignKey = await repository.pool.query<{ delete_action: string }>(`
    SELECT constraint_definition.confdeltype AS delete_action
    FROM pg_constraint constraint_definition
    WHERE constraint_definition.contype = 'f'
      AND constraint_definition.conrelid = 'review_csrf_tokens'::regclass
      AND constraint_definition.confrelid = 'operator_sessions'::regclass
  `);
  assert.equal(foreignKey.rows.some((row) => row.delete_action === "c"), true);

  const tenantShortCode = await repository.pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'provider_connections'
        AND column_name = 'tenant_short_code'
    ) AS exists
  `);
  assert.equal(tenantShortCode.rows[0]?.exists, true);
}

async function seedSyntheticRecords(options: {
  repository: PostgresAccountingRepository;
  runId: string;
  cutoff: Date;
  now: Date;
}): Promise<void> {
  const { repository, runId, cutoff, now } = options;
  const actorId = `cleanup-verifier-actor-${runId}`;
  const tenantId = `cleanup-verifier-tenant-${runId}`;
  const prefix = `cleanup-verifier-${runId}`;
  const expiredAt = new Date(cutoff.getTime() - 60_000);
  const consumedAt = new Date(cutoff.getTime() - 30_000);
  const graceAt = new Date(cutoff.getTime() + 60_000);
  const activeAt = new Date(now.getTime() + 60 * 60_000);
  const expiredParentSession = `${prefix}-session-expired-parent`;
  const expiredEmptySession = `${prefix}-session-expired-empty`;
  const directCsrfParentSession = `${prefix}-session-direct-parent`;
  const graceSession = `${prefix}-session-grace`;
  const activeSession = `${prefix}-session-active`;
  const postingRequestId = `${prefix}-posting`;
  const client = await repository.pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO provider_connections(
         connection_id, actor_id, provider, tenant_id, tenant_name, granted_scopes,
         token_ciphertext, token_expires_at, connection_status
       ) VALUES ($1, $2, 'xero', $3, 'Synthetic cleanup verifier tenant',
         ARRAY['offline_access'], 'synthetic-ciphertext', $4, 'ACTIVE')`,
      [`${prefix}-connection`, actorId, tenantId, activeAt],
    );
    await client.query(
      `INSERT INTO posting_requests(
         posting_request_id, actor_id, tenant_id, source_ref, source_sha256,
         source_evidence_type, provider_payload, request_payload_hash, provider_payload_hash,
         state, request_id, create_idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, 'LEGACY_UNVERIFIED', $6, $7, $8, 'VALIDATED', $9, $10)`,
      [
        postingRequestId,
        actorId,
        tenantId,
        `synthetic://ephemeral-cleanup/${runId}`,
        "1".repeat(64),
        { classification: "SYNTHETIC_ONLY" },
        "2".repeat(64),
        "3".repeat(64),
        `${prefix}-create-request`,
        `${prefix}-create-key`,
      ],
    );
    await client.query(
      `INSERT INTO tool_audit_logs(
         call_id, actor_id, tenant_id, tool_name, request_hash, result_status,
         started_at, finished_at
       ) VALUES ($1, $2, $3, 'synthetic_cleanup_verifier_sentinel', $4, 'SUCCEEDED', $5, $5)`,
      [`${prefix}-audit`, actorId, tenantId, "4".repeat(64), now],
    );

    await client.query(
      `INSERT INTO connect_tickets(ticket_hash, actor_id, expires_at, consumed_at)
       SELECT $1::text || '-ticket-expired-' || series::text, $2, $3,
         CASE WHEN series % 2 = 0 THEN $4::timestamptz ELSE NULL END
       FROM generate_series(1, $5::integer) AS series`,
      [prefix, actorId, expiredAt, consumedAt, expiredConnectTicketCount],
    );
    await client.query(
      `INSERT INTO connect_tickets(ticket_hash, actor_id, expires_at)
       VALUES ($1, $3, $5), ($2, $3, $4)`,
      [`${prefix}-ticket-grace`, `${prefix}-ticket-active`, actorId, activeAt, graceAt],
    );

    await client.query(
      `INSERT INTO oauth_states(
         state_hash, browser_session_hash, actor_id, expires_at, consumed_at
       )
       SELECT $1::text || '-state-expired-' || series::text,
         $1::text || '-browser-' || series::text, $2, $3,
         CASE WHEN series % 2 = 0 THEN $4::timestamptz ELSE NULL END
       FROM generate_series(1, $5::integer) AS series`,
      [prefix, actorId, expiredAt, consumedAt, expiredOAuthStateCount],
    );
    await client.query(
      `INSERT INTO oauth_states(state_hash, browser_session_hash, actor_id, expires_at)
       VALUES ($1, $2, $5, $6), ($3, $4, $5, $7)`,
      [
        `${prefix}-state-grace`,
        `${prefix}-browser-grace`,
        `${prefix}-state-active`,
        `${prefix}-browser-active`,
        actorId,
        graceAt,
        activeAt,
      ],
    );

    await client.query(
      `INSERT INTO operator_sessions(session_hash, actor_id, expires_at)
       VALUES
         ($1, $6, $7),
         ($2, $6, $7),
         ($3, $6, $8),
         ($4, $6, $9),
         ($5, $6, $8)`,
      [
        expiredParentSession,
        expiredEmptySession,
        directCsrfParentSession,
        graceSession,
        activeSession,
        actorId,
        expiredAt,
        activeAt,
        graceAt,
      ],
    );
    await client.query(
      `INSERT INTO review_csrf_tokens(
         csrf_hash, session_hash, actor_id, posting_request_id, expires_at
       )
       SELECT $1::text || '-csrf-parent-expired-' || series::text,
         $2, $3, $4, $5
       FROM generate_series(1, $6::integer) AS series`,
      [prefix, expiredParentSession, actorId, postingRequestId, activeAt, expiredParentCsrfCount],
    );
    await client.query(
      `INSERT INTO review_csrf_tokens(
         csrf_hash, session_hash, actor_id, posting_request_id, expires_at, consumed_at
       )
       SELECT $1::text || '-csrf-direct-expired-' || series::text,
         $2, $3, $4, $5,
         CASE WHEN series % 2 = 0 THEN $6::timestamptz ELSE NULL END
       FROM generate_series(1, $7::integer) AS series`,
      [
        prefix,
        directCsrfParentSession,
        actorId,
        postingRequestId,
        expiredAt,
        consumedAt,
        expiredDirectCsrfCount,
      ],
    );
    await client.query(
      `INSERT INTO review_csrf_tokens(
         csrf_hash, session_hash, actor_id, posting_request_id, expires_at
       ) VALUES ($1, $2, $6, $7, $8), ($3, $4, $6, $7, $5)`,
      [
        `${prefix}-csrf-grace`,
        graceSession,
        `${prefix}-csrf-active`,
        activeSession,
        activeAt,
        actorId,
        postingRequestId,
        graceAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertRetainedAndDrained(
  repository: PostgresAccountingRepository,
  cutoff: Date,
): Promise<void> {
  const result = await repository.pool.query<{
    expired_oauth_states: string;
    expired_connect_tickets: string;
    expired_operator_sessions: string;
    eligible_review_csrf_tokens: string;
    retained_oauth_states: string;
    retained_connect_tickets: string;
    retained_operator_sessions: string;
    retained_review_csrf_tokens: string;
  }>(`
    SELECT
      (SELECT count(*) FROM oauth_states WHERE expires_at <= $1)::text AS expired_oauth_states,
      (SELECT count(*) FROM connect_tickets WHERE expires_at <= $1)::text AS expired_connect_tickets,
      (SELECT count(*) FROM operator_sessions WHERE expires_at <= $1)::text AS expired_operator_sessions,
      (SELECT count(*)
         FROM review_csrf_tokens csrf
         JOIN operator_sessions sessions ON sessions.session_hash = csrf.session_hash
         WHERE csrf.expires_at <= $1 OR sessions.expires_at <= $1)::text AS eligible_review_csrf_tokens,
      (SELECT count(*) FROM oauth_states)::text AS retained_oauth_states,
      (SELECT count(*) FROM connect_tickets)::text AS retained_connect_tickets,
      (SELECT count(*) FROM operator_sessions)::text AS retained_operator_sessions,
      (SELECT count(*) FROM review_csrf_tokens)::text AS retained_review_csrf_tokens
  `, [cutoff]);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(Number(row.expired_oauth_states), 0);
  assert.equal(Number(row.expired_connect_tickets), 0);
  assert.equal(Number(row.expired_operator_sessions), 0);
  assert.equal(Number(row.eligible_review_csrf_tokens), 0);
  assert.equal(Number(row.retained_oauth_states), 2);
  assert.equal(Number(row.retained_connect_tickets), 2);
  assert.equal(Number(row.retained_operator_sessions), 3);
  assert.equal(Number(row.retained_review_csrf_tokens), 2);
}

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

export async function verifyPostgresEphemeralCleanup(databaseUrl: string): Promise<void> {
  // Refuse a non-isolated database before migrations or cleanup can mutate it.
  await assertSafeVerifierDatabase(databaseUrl);
  await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  const repository = new PostgresAccountingRepository(databaseUrl);
  const runId = randomUUID().replaceAll("-", "");
  const now = new Date();
  const cutoff = new Date(now.getTime() - 60 * 60_000);

  try {
    await assertMigrationAndSchema(repository);
    const initialCounts = await dataTableCounts(repository);
    assert.equal(Object.values(initialCounts).every((count) => count === 0), true);

    await seedSyntheticRecords({ repository, runId, cutoff, now });
    const protectedBefore = await protectedTableSnapshot(repository);
    const seededCounts = await dataTableCounts(repository);
    assert.deepEqual(seededCounts, {
      oauth_states: expiredOAuthStateCount + 2,
      connect_tickets: expiredConnectTicketCount + 2,
      operator_sessions: 5,
      review_csrf_tokens: expiredParentCsrfCount + expiredDirectCsrfCount + 2,
      provider_connections: 1,
      posting_requests: 1,
      tool_audit_logs: 1,
    });

    const lockClient = await repository.pool.connect();
    let lockedReturnMs = 0;
    try {
      await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [cleanupAdvisoryLockKey]);
      const countsBeforeLockedCall = await dataTableCounts(repository);
      const lockedStartedAt = Date.now();
      const lockedResult = await repository.cleanupExpiredEphemeral(cutoff, batchSize);
      lockedReturnMs = Date.now() - lockedStartedAt;
      assert.equal(lockedResult.lockAcquired, false);
      assert.deepEqual(lockedResult.deleted, emptyCounts());
      assert.equal(lockedReturnMs < maxLockedReturnMs, true);
      assert.deepEqual(await dataTableCounts(repository), countsBeforeLockedCall);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [cleanupAdvisoryLockKey]);
      lockClient.release();
    }

    const batches: EphemeralCleanupBatchResult[] = await Promise.all(
      Array.from({ length: concurrentCalls }, () => repository.cleanupExpiredEphemeral(cutoff, batchSize)),
    );
    assert.equal(batches.some((result) => result.lockAcquired), true);
    for (const result of batches) assertBoundedBatch(result);

    let drained = false;
    for (let attempt = 0; attempt < maxDrainCalls; attempt += 1) {
      const result = await repository.cleanupExpiredEphemeral(cutoff, batchSize);
      assertBoundedBatch(result);
      batches.push(result);
      if (result.lockAcquired && allZero(result.deleted)) {
        drained = true;
        break;
      }
    }
    assert.equal(drained, true);

    const deleted = emptyCounts();
    for (const result of batches) addCounts(deleted, result.deleted);
    assert.deepEqual(deleted, {
      mcpRefreshRetryResponses: 0,
      oauthBrokerFlows: 0,
      oauthStates: expiredOAuthStateCount,
      connectTickets: expiredConnectTicketCount,
      operatorSessions: expectedExpiredSessionCount,
      reviewCsrfTokens: expiredParentCsrfCount + expiredDirectCsrfCount,
    });

    await assertRetainedAndDrained(repository, cutoff);
    assert.deepEqual(await protectedTableSnapshot(repository), protectedBefore);

    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      verifier: "postgres-ephemeral-cleanup",
      runId,
      engine: "PostgreSQL 17",
      batchSize,
      seededExpiredConnectTickets: expiredConnectTicketCount,
      cleanupCalls: batches.length,
      lockedReturnMs,
      checks: [
        "isolated-database-guard",
        "migration-002-review-csrf-session-index-valid",
        "migration-003-tenant-short-code-column",
        "review-csrf-operator-session-fk-cascade",
        "ten-thousand-expired-connect-tickets",
        "single-batch-per-table-at-most-one-thousand",
        "multi-batch-drain",
        "grace-and-active-records-retained",
        "expired-session-children-bounded-before-parent-delete",
        "advisory-lock-fast-skip-with-zero-delete",
        "concurrent-cleanup-safe",
        "provider-posting-audit-unchanged",
      ],
      sensitiveValuesIncluded: false,
    })}\n`);
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await verifyPostgresEphemeralCleanup(databaseUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      verifier: "postgres-ephemeral-cleanup",
      errorClass: error instanceof Error ? error.name : "CleanupVerifierError",
    })}\n`);
    process.exitCode = 1;
  });
}
