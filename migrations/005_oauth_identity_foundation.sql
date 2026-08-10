-- Phase 2a expand-only identity and OAuth broker control plane.
-- Legacy actor/token columns and tables remain available during backfill and
-- dual-write; new provider token sets live on provider_authorizations.

CREATE TABLE IF NOT EXISTS provider_authorizations (
  authorization_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  authorized_by_subject text NOT NULL,
  provider text NOT NULL CHECK (provider = 'xero'),
  provider_subject text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  token_ciphertext text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  refresh_version integer NOT NULL DEFAULT 0 CHECK (refresh_version >= 0),
  authorization_status text NOT NULL CHECK (
    authorization_status IN ('ACTIVE', 'TOKEN_REFRESH_FAILED', 'REVOKED')
  ),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (authorization_status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS provider_authorizations_workspace_subject_idx
  ON provider_authorizations (workspace_id, authorized_by_subject, authorization_status);

ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS authorization_id text;
ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS provider_connection_id text;
ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

-- New-model rows no longer duplicate provider credentials. Old rows keep
-- their actor/token values and continue to satisfy the legacy repositories.
ALTER TABLE provider_connections ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE provider_connections ALTER COLUMN token_ciphertext DROP NOT NULL;
ALTER TABLE provider_connections ALTER COLUMN token_expires_at DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_connections_authorization_fk'
      AND conrelid = 'provider_connections'::regclass
  ) THEN
    ALTER TABLE provider_connections
      ADD CONSTRAINT provider_connections_authorization_fk
      FOREIGN KEY (authorization_id)
      REFERENCES provider_authorizations(authorization_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Accept exactly three migration-safe shapes:
--   1. pure new model (Authorization set, all legacy credential fields absent),
--   2. complete legacy model, or
--   3. complete dual-write model.
-- A previous draft of this named constraint allowed partial legacy fields on a
-- new-model row, so replace it on every idempotent execution before validating.
ALTER TABLE provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_identity_shape_check;
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_identity_shape_check
  CHECK (
    (
      authorization_id IS NOT NULL
      AND actor_id IS NULL
      AND token_ciphertext IS NULL
      AND token_expires_at IS NULL
    )
    OR (
      actor_id IS NOT NULL
      AND token_ciphertext IS NOT NULL
      AND token_expires_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE provider_connections
  VALIDATE CONSTRAINT provider_connections_identity_shape_check;

CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_authorization_tenant_uq
  ON provider_connections (authorization_id, tenant_id)
  WHERE authorization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_authorization_provider_id_uq
  ON provider_connections (authorization_id, provider_connection_id)
  WHERE authorization_id IS NOT NULL AND provider_connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_connections_authorization_status_idx
  ON provider_connections (authorization_id, connection_status)
  WHERE authorization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_installations (
  installation_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM')),
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  oauth_client_id text NOT NULL,
  installation_status text NOT NULL CHECK (
    installation_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED')
  ),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, workspace_id, subject_type, subject_id, agent_id),
  CHECK (installation_status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS oauth_installations_identity_idx
  ON oauth_installations (
    workspace_id, subject_type, subject_id, agent_id, oauth_client_id, installation_status
  );

CREATE TABLE IF NOT EXISTS agent_connection_bindings (
  binding_id text PRIMARY KEY,
  oauth_installation_id text NOT NULL,
  workspace_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM')),
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  connection_id text NOT NULL REFERENCES provider_connections(connection_id) ON DELETE RESTRICT,
  policy_id text NOT NULL,
  binding_status text NOT NULL CHECK (binding_status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_connection_bindings_installation_identity_fk
    FOREIGN KEY (oauth_installation_id, workspace_id, subject_type, subject_id, agent_id)
    REFERENCES oauth_installations(
      installation_id, workspace_id, subject_type, subject_id, agent_id
    ) ON DELETE RESTRICT,
  UNIQUE (oauth_installation_id),
  UNIQUE (binding_id, oauth_installation_id, connection_id),
  CHECK (binding_status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS agent_connection_bindings_identity_idx
  ON agent_connection_bindings (
    workspace_id, subject_type, subject_id, agent_id, binding_status
  );
CREATE INDEX IF NOT EXISTS agent_connection_bindings_connection_idx
  ON agent_connection_bindings (connection_id, binding_status);

CREATE TABLE IF NOT EXISTS oauth_broker_flows (
  flow_hash text PRIMARY KEY,
  browser_session_hash text NOT NULL,
  oauth_client_id text NOT NULL,
  redirect_uri text NOT NULL,
  pkce_code_challenge text NOT NULL,
  pkce_code_challenge_method text NOT NULL CHECK (pkce_code_challenge_method = 'S256'),
  workspace_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM')),
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  requested_scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oauth_broker_flows_expiry_idx
  ON oauth_broker_flows (expires_at);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  flow_hash text NOT NULL,
  oauth_installation_id text NOT NULL,
  binding_id text NOT NULL,
  connection_id text NOT NULL,
  oauth_client_id text NOT NULL,
  redirect_uri text NOT NULL,
  pkce_code_challenge text NOT NULL,
  pkce_code_challenge_method text NOT NULL CHECK (pkce_code_challenge_method = 'S256'),
  resource text NOT NULL,
  audience text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_authorization_codes_binding_fk
    FOREIGN KEY (binding_id, oauth_installation_id, connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

-- Keep repeat execution safe for databases that first ran an earlier draft of
-- migration 005 before flow binding became mandatory.
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS flow_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_authorization_codes_flow_fk'
      AND conrelid = 'oauth_authorization_codes'::regclass
  ) THEN
    ALTER TABLE oauth_authorization_codes
      ADD CONSTRAINT oauth_authorization_codes_flow_fk
      FOREIGN KEY (flow_hash)
      REFERENCES oauth_broker_flows(flow_hash)
      ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE oauth_authorization_codes
  DROP CONSTRAINT IF EXISTS oauth_authorization_codes_flow_required_check;
ALTER TABLE oauth_authorization_codes
  ADD CONSTRAINT oauth_authorization_codes_flow_required_check
  CHECK (flow_hash IS NOT NULL) NOT VALID;
ALTER TABLE oauth_authorization_codes
  VALIDATE CONSTRAINT oauth_authorization_codes_flow_required_check;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_authorization_codes_flow_uq
  ON oauth_authorization_codes (flow_hash);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry_idx
  ON oauth_authorization_codes (expires_at);

CREATE TABLE IF NOT EXISTS mcp_refresh_token_families (
  family_id text PRIMARY KEY,
  oauth_installation_id text NOT NULL,
  binding_id text NOT NULL,
  connection_id text NOT NULL,
  oauth_client_id text NOT NULL,
  resource text NOT NULL,
  audience text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  family_status text NOT NULL CHECK (family_status IN ('ACTIVE', 'REVOKED')),
  replay_detected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_refresh_token_families_binding_fk
    FOREIGN KEY (binding_id, oauth_installation_id, connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT,
  UNIQUE (family_id, oauth_installation_id, binding_id, connection_id),
  CHECK (family_status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mcp_refresh_token_families_installation_idx
  ON mcp_refresh_token_families (oauth_installation_id, family_status);

CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
  token_hash text PRIMARY KEY,
  token_id text NOT NULL UNIQUE,
  family_id text NOT NULL REFERENCES mcp_refresh_token_families(family_id) ON DELETE RESTRICT,
  parent_token_hash text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  replaced_by_token_hash text,
  UNIQUE (token_hash, family_id),
  CONSTRAINT mcp_refresh_tokens_parent_family_fk
    FOREIGN KEY (parent_token_hash, family_id)
    REFERENCES mcp_refresh_tokens(token_hash, family_id)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_refresh_tokens_replacement_family_fk
    FOREIGN KEY (replaced_by_token_hash, family_id)
    REFERENCES mcp_refresh_tokens(token_hash, family_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_family_idx
  ON mcp_refresh_tokens (family_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_expiry_idx
  ON mcp_refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  token_hash text PRIMARY KEY,
  token_id text NOT NULL UNIQUE,
  oauth_installation_id text NOT NULL,
  binding_id text NOT NULL,
  connection_id text NOT NULL,
  refresh_family_id text,
  oauth_client_id text NOT NULL,
  resource text NOT NULL,
  audience text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT mcp_access_tokens_binding_fk
    FOREIGN KEY (binding_id, oauth_installation_id, connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_access_tokens_refresh_family_fk
    FOREIGN KEY (refresh_family_id, oauth_installation_id, binding_id, connection_id)
    REFERENCES mcp_refresh_token_families(
      family_id, oauth_installation_id, binding_id, connection_id
    ) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS mcp_access_tokens_expiry_idx
  ON mcp_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS mcp_access_tokens_installation_idx
  ON mcp_access_tokens (oauth_installation_id, revoked_at);
