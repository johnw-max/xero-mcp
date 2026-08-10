CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  browser_session_hash text NOT NULL,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS connect_tickets (
  ticket_hash text PRIMARY KEY,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connect_tickets_expiry_idx ON connect_tickets (expires_at);

CREATE TABLE IF NOT EXISTS operator_sessions (
  session_hash text PRIMARY KEY,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_sessions_expiry_idx ON operator_sessions (expires_at);

CREATE TABLE IF NOT EXISTS review_csrf_tokens (
  csrf_hash text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES operator_sessions(session_hash) ON DELETE CASCADE,
  actor_id text NOT NULL,
  posting_request_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_csrf_expiry_idx ON review_csrf_tokens (expires_at);

CREATE TABLE IF NOT EXISTS provider_connections (
  connection_id text PRIMARY KEY,
  actor_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'xero'),
  tenant_id text NOT NULL,
  tenant_name text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  token_ciphertext text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  refresh_version integer NOT NULL DEFAULT 0,
  connection_status text NOT NULL CHECK (connection_status IN ('ACTIVE', 'TOKEN_REFRESH_FAILED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, provider, tenant_id)
);

CREATE INDEX IF NOT EXISTS provider_connections_actor_idx
  ON provider_connections (actor_id, connection_status);

CREATE TABLE IF NOT EXISTS posting_requests (
  posting_request_id text PRIMARY KEY,
  actor_id text NOT NULL,
  tenant_id text NOT NULL,
  source_ref text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  provider_payload jsonb NOT NULL,
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^[a-f0-9]{64}$'),
  provider_payload_hash text NOT NULL CHECK (provider_payload_hash ~ '^[a-f0-9]{64}$'),
  xero_invoice_id text,
  state text NOT NULL CHECK (state IN (
    'VALIDATED', 'APPROVAL_PENDING', 'APPROVED', 'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED', 'REJECTED', 'BLOCKED_VALIDATION',
    'WRITE_RESULT_UNKNOWN', 'READBACK_MISMATCH'
  )),
  request_id text NOT NULL,
  create_operation text NOT NULL DEFAULT 'CREATE_DRAFT' CHECK (create_operation = 'CREATE_DRAFT'),
  create_idempotency_key text NOT NULL,
  authorise_request_id text,
  authorise_operation text CHECK (authorise_operation IS NULL OR authorise_operation = 'AUTHORISE'),
  authorise_idempotency_key text,
  approval_ref_hash text,
  approved_by text,
  approved_at timestamptz,
  approval_expires_at timestamptz,
  approval_consumed_at timestamptz,
  write_receipt jsonb,
  readback_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id, create_operation),
  UNIQUE (tenant_id, authorise_request_id, authorise_operation)
);

CREATE INDEX IF NOT EXISTS posting_requests_invoice_idx
  ON posting_requests (tenant_id, xero_invoice_id);
CREATE INDEX IF NOT EXISTS posting_requests_state_idx
  ON posting_requests (tenant_id, state, updated_at);

CREATE TABLE IF NOT EXISTS tool_audit_logs (
  call_id text PRIMARY KEY,
  actor_id text NOT NULL,
  tenant_id text,
  tool_name text NOT NULL,
  request_hash text NOT NULL,
  result_status text NOT NULL CHECK (result_status IN ('SUCCEEDED', 'REJECTED', 'FAILED')),
  provider_request_id text,
  record_id text,
  error_class text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_audit_logs_actor_time_idx
  ON tool_audit_logs (actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS tool_audit_logs_record_idx
  ON tool_audit_logs (record_id, started_at DESC);
