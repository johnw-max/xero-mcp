SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Organisation switching retains prior bindings as immutable authorization
-- history while oauth_installation_active_bindings selects exactly one runtime
-- binding. The Phase 2a single-row uniqueness is therefore replaced by a
-- non-unique lookup index; tuple uniqueness remains enforced separately.
ALTER TABLE agent_connection_bindings
  DROP CONSTRAINT IF EXISTS agent_connection_bindings_oauth_installation_id_key;

CREATE INDEX IF NOT EXISTS agent_connection_bindings_installation_status_idx
  ON agent_connection_bindings(oauth_installation_id, binding_status, updated_at DESC);
