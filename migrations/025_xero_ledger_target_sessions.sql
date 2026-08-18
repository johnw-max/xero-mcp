SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Short-lived, immutable per-conversation ledger targets. These coexist with
-- oauth_installation_active_bindings, which remains only the compatibility
-- pointer used by MCP clients that have not adopted target_session_ref yet.
CREATE TABLE IF NOT EXISTS ledger_target_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL UNIQUE,
  oauth_installation_id text NOT NULL,
  binding_id text NOT NULL,
  connection_id text NOT NULL,
  binding_revision bigint NOT NULL CHECK (binding_revision > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT ledger_target_session_binding_fk
    FOREIGN KEY (binding_id, oauth_installation_id, connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '4 hours'),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ledger_target_sessions_expiry_idx
  ON ledger_target_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ledger_target_sessions_installation_idx
  ON ledger_target_sessions(oauth_installation_id, created_at DESC);

-- A switch initiated from a pinned conversation carries only the keyed target
-- hash. Completing that one-time switch revokes exactly the initiating target;
-- targets held by other concurrent conversations remain valid.
ALTER TABLE organisation_switch_sessions
  ADD COLUMN IF NOT EXISTS source_target_session_hash text;

ALTER TABLE organisation_switch_sessions
  DROP CONSTRAINT IF EXISTS organisation_switch_source_target_fk;

ALTER TABLE organisation_switch_sessions
  ADD CONSTRAINT organisation_switch_source_target_fk
  FOREIGN KEY (source_target_session_hash)
  REFERENCES ledger_target_sessions(session_hash)
  ON DELETE RESTRICT;

ALTER TABLE organisation_switch_sessions
  DROP CONSTRAINT IF EXISTS organisation_switch_source_target_hash_check;

ALTER TABLE organisation_switch_sessions
  ADD CONSTRAINT organisation_switch_source_target_hash_check
  CHECK (source_target_session_hash IS NULL OR source_target_session_hash ~ '^[0-9a-f]{64}$');

-- Controlled mutations carry the binding epoch and internal target id captured
-- at prepare time. A later organisation switch/re-pin cannot reuse an earlier
-- preparation, even if it eventually returns to the same provider connection.
ALTER TABLE xero_mutation_preparations
  ADD COLUMN IF NOT EXISTS binding_revision bigint,
  ADD COLUMN IF NOT EXISTS target_session_id text;

ALTER TABLE xero_mutation_requests
  ADD COLUMN IF NOT EXISTS binding_revision bigint,
  ADD COLUMN IF NOT EXISTS target_session_id text;

-- Do not strand an already-started Provider write during an in-place upgrade.
-- A fresh/test database has no rows; an existing deployment must recover or
-- close every non-terminal controlled mutation before adopting target-bound
-- execution semantics. PREPARED proposals are safe to expire and recreate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM xero_mutation_requests
    WHERE state IN ('CONFIRMED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
      AND (binding_revision IS NULL OR target_session_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'migration 025 blocked: recover or close active pre-0.4 Xero mutation requests first';
  END IF;
END
$$;

UPDATE xero_mutation_preparations
SET state = 'EXPIRED', updated_at = GREATEST(updated_at, now())
WHERE state = 'PREPARED'
  AND (binding_revision IS NULL OR target_session_id IS NULL);

ALTER TABLE xero_mutation_preparations
  DROP CONSTRAINT IF EXISTS xero_mutation_preparations_binding_revision_check;
ALTER TABLE xero_mutation_preparations
  ADD CONSTRAINT xero_mutation_preparations_binding_revision_check
  CHECK (binding_revision IS NULL OR binding_revision > 0);

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_requests_binding_revision_check;
ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_requests_binding_revision_check
  CHECK (binding_revision IS NULL OR binding_revision > 0);
