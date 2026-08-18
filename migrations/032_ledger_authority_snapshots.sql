-- Shared MCP control-store snapshot for dynamically revocable ledger writes.
-- A provider write claim locks and verifies this row before it consumes the
-- immutable mutation preparation. The transaction ends before network I/O;
-- an already claimed provider call is therefore the explicit revocation edge.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS ledger_authority_snapshots (
  provider_id text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  write_kill_switch_enabled boolean NOT NULL,
  standing_delegations jsonb NOT NULL CHECK (
    jsonb_typeof(standing_delegations) = 'array'
  ),
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (provider_id <> '' AND provider_id = btrim(provider_id)),
  CHECK (updated_at >= published_at)
);

REVOKE ALL ON TABLE ledger_authority_snapshots FROM PUBLIC;

