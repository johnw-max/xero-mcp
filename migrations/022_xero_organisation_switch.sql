SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS oauth_installation_active_bindings (
  oauth_installation_id text PRIMARY KEY
    REFERENCES oauth_installations(installation_id) ON DELETE RESTRICT,
  binding_id text NOT NULL,
  connection_id text NOT NULL,
  binding_revision bigint NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
  changed_at timestamptz NOT NULL,
  CONSTRAINT oauth_installation_active_binding_tuple_fk
    FOREIGN KEY (binding_id, oauth_installation_id, connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT
);

INSERT INTO oauth_installation_active_bindings(
  oauth_installation_id, binding_id, connection_id, binding_revision, changed_at
)
SELECT DISTINCT ON (binding.oauth_installation_id)
  binding.oauth_installation_id,
  binding.binding_id,
  binding.connection_id,
  1,
  binding.updated_at
FROM agent_connection_bindings binding
JOIN oauth_installations installation
  ON installation.installation_id = binding.oauth_installation_id
WHERE binding.binding_status = 'ACTIVE'
  AND installation.installation_status = 'ACTIVE'
ORDER BY binding.oauth_installation_id, binding.updated_at DESC, binding.binding_id DESC
ON CONFLICT (oauth_installation_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS organisation_switch_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  oauth_installation_id text NOT NULL,
  workspace_id text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM')),
  subject_id text NOT NULL,
  agent_id text NOT NULL,
  authorization_id text NOT NULL REFERENCES provider_authorizations(authorization_id) ON DELETE RESTRICT,
  source_binding_id text NOT NULL,
  source_connection_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT organisation_switch_source_binding_fk
    FOREIGN KEY (source_binding_id, oauth_installation_id, source_connection_id)
    REFERENCES agent_connection_bindings(binding_id, oauth_installation_id, connection_id)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '15 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS organisation_switch_sessions_expiry_idx
  ON organisation_switch_sessions(expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS organisation_switch_sessions_installation_idx
  ON organisation_switch_sessions(oauth_installation_id, created_at DESC);
