-- Complete V2 OAuth Broker browser-flow lifecycle. Migration 005 flow rows
-- remain readable as flow_version=1, while every new atomic Broker API writes
-- a fully constrained flow_version=2 row.

ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS flow_version smallint NOT NULL DEFAULT 1;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS xero_state_hash text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS outer_state_hash text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS outer_state_ciphertext text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS resource text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS audience text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS oauth_installation_id text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS personal_poc boolean;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS flow_status text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS authorization_id text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS selection_csrf_hash text;
ALTER TABLE oauth_broker_flows
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_broker_flows_installation_fk'
      AND conrelid = 'oauth_broker_flows'::regclass
  ) THEN
    ALTER TABLE oauth_broker_flows
      ADD CONSTRAINT oauth_broker_flows_installation_fk
      FOREIGN KEY (oauth_installation_id)
      REFERENCES oauth_installations(installation_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

ALTER TABLE oauth_broker_flows
  VALIDATE CONSTRAINT oauth_broker_flows_installation_fk;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_broker_flows_authorization_fk'
      AND conrelid = 'oauth_broker_flows'::regclass
  ) THEN
    ALTER TABLE oauth_broker_flows
      ADD CONSTRAINT oauth_broker_flows_authorization_fk
      FOREIGN KEY (authorization_id)
      REFERENCES provider_authorizations(authorization_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

ALTER TABLE oauth_broker_flows
  VALIDATE CONSTRAINT oauth_broker_flows_authorization_fk;

-- Recreate the named constraint on raw reruns so an earlier draft cannot leave
-- a weaker lifecycle definition in place.
ALTER TABLE oauth_broker_flows
  DROP CONSTRAINT IF EXISTS oauth_broker_flows_v2_lifecycle_check;
ALTER TABLE oauth_broker_flows
  ADD CONSTRAINT oauth_broker_flows_v2_lifecycle_check
  CHECK (
    (
      flow_version = 1
      AND xero_state_hash IS NULL
      AND outer_state_hash IS NULL
      AND outer_state_ciphertext IS NULL
      AND resource IS NULL
      AND audience IS NULL
      AND oauth_installation_id IS NULL
      AND personal_poc IS NULL
      AND flow_status IS NULL
      AND authorization_id IS NULL
      AND selection_csrf_hash IS NULL
      AND updated_at IS NULL
    )
    OR (
      flow_version = 2
      AND xero_state_hash IS NOT NULL
      AND outer_state_hash IS NOT NULL
      AND resource IS NOT NULL
      AND audience IS NOT NULL
      AND oauth_installation_id IS NOT NULL
      AND personal_poc IS NOT NULL
      AND flow_status IN (
        'AUTHORIZING_XERO', 'EXCHANGING_XERO', 'AWAITING_SELECTION',
        'COMPLETED', 'DENIED', 'FAILED'
      )
      AND updated_at IS NOT NULL
      AND updated_at >= created_at
      AND cardinality(requested_scopes) > 0
      AND (
        (
          flow_status IN ('AUTHORIZING_XERO', 'EXCHANGING_XERO')
          AND outer_state_ciphertext IS NOT NULL
          AND authorization_id IS NULL
          AND selection_csrf_hash IS NULL
          AND consumed_at IS NULL
        )
        OR (
          flow_status = 'AWAITING_SELECTION'
          AND outer_state_ciphertext IS NOT NULL
          AND authorization_id IS NOT NULL
          AND selection_csrf_hash IS NOT NULL
          AND consumed_at IS NULL
        )
        OR (
          flow_status = 'COMPLETED'
          AND outer_state_ciphertext IS NULL
          AND authorization_id IS NOT NULL
          AND selection_csrf_hash IS NULL
          AND consumed_at IS NOT NULL
        )
        OR (
          flow_status IN ('DENIED', 'FAILED')
          AND outer_state_ciphertext IS NULL
          AND selection_csrf_hash IS NULL
          AND consumed_at IS NOT NULL
        )
      )
    )
  ) NOT VALID;

ALTER TABLE oauth_broker_flows
  VALIDATE CONSTRAINT oauth_broker_flows_v2_lifecycle_check;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_broker_flows_v2_xero_state_uq
  ON oauth_broker_flows (xero_state_hash)
  WHERE flow_version = 2;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_broker_flows_v2_outer_state_uq
  ON oauth_broker_flows (outer_state_hash)
  WHERE flow_version = 2;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_broker_flows_v2_installation_uq
  ON oauth_broker_flows (oauth_installation_id)
  WHERE flow_version = 2;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_broker_flows_v2_authorization_uq
  ON oauth_broker_flows (authorization_id)
  WHERE flow_version = 2 AND authorization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_broker_flows_v2_selection_csrf_uq
  ON oauth_broker_flows (selection_csrf_hash)
  WHERE flow_version = 2 AND selection_csrf_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_broker_flows_v2_status_expiry_idx
  ON oauth_broker_flows (flow_status, expires_at)
  WHERE flow_version = 2;
CREATE INDEX IF NOT EXISTS oauth_broker_flows_v2_browser_status_idx
  ON oauth_broker_flows (browser_session_hash, flow_status, expires_at)
  WHERE flow_version = 2;
