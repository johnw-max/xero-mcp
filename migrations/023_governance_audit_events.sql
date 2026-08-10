SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS governance_audit_events (
  event_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  stream_id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'zcloak.governance-event.v1'),
  event_type text NOT NULL,
  event_source text NOT NULL CHECK (event_source IN ('MCP','USER_UI','OAUTH','SYSTEM')),
  action text NOT NULL,
  actor_id text NOT NULL,
  workspace_id text,
  agent_id text,
  oauth_installation_id text,
  binding_id text,
  connection_id text,
  tenant_id text,
  mandate_id text,
  policy_id text,
  correlation_id text NOT NULL,
  causation_id text,
  disposition text NOT NULL CHECK (disposition IN ('NOT_EVALUATED','OBSERVE','AUTO_EXECUTE','ESCALATE','DENY')),
  outcome text NOT NULL CHECK (outcome IN ('PROPOSED','SUCCEEDED','REJECTED','FAILED')),
  input_hash text CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$'),
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_event_hash text CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS governance_audit_events_stream_sequence_idx
  ON governance_audit_events(stream_id, event_sequence DESC);
CREATE INDEX IF NOT EXISTS governance_audit_events_correlation_idx
  ON governance_audit_events(correlation_id, event_sequence);
CREATE INDEX IF NOT EXISTS governance_audit_events_installation_idx
  ON governance_audit_events(oauth_installation_id, event_sequence DESC);

CREATE OR REPLACE FUNCTION reject_governance_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS governance_audit_events_append_only ON governance_audit_events;
CREATE TRIGGER governance_audit_events_append_only
BEFORE UPDATE OR DELETE ON governance_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_governance_audit_event_mutation();
