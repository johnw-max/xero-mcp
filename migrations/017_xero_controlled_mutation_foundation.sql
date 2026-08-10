-- Generic, provider-neutral control plane for future Xero mutations. This
-- migration does not enable any MCP write tool or execute any Xero operation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS xero_mutation_preparations (
  preparation_id text PRIMARY KEY CHECK (preparation_id ~ '^xmp_[a-f0-9]{32}$'),
  actor_id text NOT NULL CHECK (actor_id = btrim(actor_id) AND actor_id <> ''),
  workspace_id text NOT NULL CHECK (workspace_id = btrim(workspace_id) AND workspace_id <> ''),
  tenant_id text NOT NULL CHECK (tenant_id = btrim(tenant_id) AND tenant_id <> ''),
  oauth_installation_id text NOT NULL CHECK (
    oauth_installation_id = btrim(oauth_installation_id) AND oauth_installation_id <> ''
  ),
  binding_id text NOT NULL CHECK (binding_id = btrim(binding_id) AND binding_id <> ''),
  connection_id text NOT NULL CHECK (connection_id = btrim(connection_id) AND connection_id <> ''),
  object_type text NOT NULL CHECK (object_type IN (
    'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL', 'CONTACT', 'ITEM', 'ATTACHMENT'
  )),
  operation text NOT NULL CHECK (operation IN ('CREATE_DRAFT', 'CREATE', 'UPDATE', 'UPLOAD')),
  target_xero_object_id text CHECK (
    target_xero_object_id IS NULL OR (
      target_xero_object_id = btrim(target_xero_object_id) AND target_xero_object_id <> ''
    )
  ),
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[a-f0-9]{64}$'),
  source_ref text CHECK (
    source_ref IS NULL OR (
      source_ref = btrim(source_ref) AND source_ref <> '' AND length(source_ref) <= 512
      AND source_ref !~ '[[:cntrl:]]' AND source_ref !~* '^https?://'
      AND strpos(source_ref, '?') = 0 AND strpos(source_ref, '#') = 0
    )
  ),
  source_unit_key text NOT NULL CHECK (
    source_unit_key = btrim(source_unit_key) AND source_unit_key <> ''
    AND length(source_unit_key) <= 256 AND source_unit_key !~ '[[:cntrl:]]'
  ),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_evidence_type text NOT NULL CHECK (source_evidence_type IN (
    'AGENT_ASSERTED_UNVERIFIED', 'SERVER_FINGERPRINTED_EXTRACTION', 'HOST_ATTESTED_FILE_RECEIPT'
  )),
  confirmation_summary_hash text NOT NULL CHECK (confirmation_summary_hash ~ '^[a-f0-9]{64}$'),
  confirmation_phrase_hash text NOT NULL CHECK (confirmation_phrase_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('PREPARED', 'CONSUMED', 'EXPIRED')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT xero_mutation_preparation_operation_check CHECK (
    (object_type IN ('QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL')
      AND operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
  ),
  CONSTRAINT xero_mutation_preparation_lifecycle_check CHECK (
    expires_at > created_at
    AND updated_at >= created_at
    AND (
      (state = 'PREPARED' AND consumed_at IS NULL)
      OR (state = 'EXPIRED' AND consumed_at IS NULL)
      OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND consumed_at >= created_at)
    )
  ),
  CONSTRAINT xero_mutation_preparation_exact_binding_unique UNIQUE (
    preparation_id, actor_id, workspace_id, tenant_id, oauth_installation_id, binding_id, connection_id,
    object_type, operation, canonical_payload_hash, source_unit_key, source_sha256,
    source_evidence_type, confirmation_summary_hash
  )
);

CREATE INDEX IF NOT EXISTS xero_mutation_preparations_expiry_idx
  ON xero_mutation_preparations (state, expires_at)
  WHERE state = 'PREPARED';

CREATE TABLE IF NOT EXISTS xero_mutation_requests (
  mutation_request_id text PRIMARY KEY CHECK (mutation_request_id ~ '^xmr_[a-f0-9]{32}$'),
  preparation_id text NOT NULL UNIQUE,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  actor_id text NOT NULL CHECK (actor_id = btrim(actor_id) AND actor_id <> ''),
  workspace_id text NOT NULL CHECK (workspace_id = btrim(workspace_id) AND workspace_id <> ''),
  tenant_id text NOT NULL CHECK (tenant_id = btrim(tenant_id) AND tenant_id <> ''),
  oauth_installation_id text NOT NULL CHECK (
    oauth_installation_id = btrim(oauth_installation_id) AND oauth_installation_id <> ''
  ),
  binding_id text NOT NULL CHECK (binding_id = btrim(binding_id) AND binding_id <> ''),
  connection_id text NOT NULL CHECK (connection_id = btrim(connection_id) AND connection_id <> ''),
  object_type text NOT NULL CHECK (object_type IN (
    'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL', 'CONTACT', 'ITEM', 'ATTACHMENT'
  )),
  operation text NOT NULL CHECK (operation IN ('CREATE_DRAFT', 'CREATE', 'UPDATE', 'UPLOAD')),
  target_xero_object_id text CHECK (
    target_xero_object_id IS NULL OR (
      target_xero_object_id = btrim(target_xero_object_id) AND target_xero_object_id <> ''
    )
  ),
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[a-f0-9]{64}$'),
  source_ref text CHECK (
    source_ref IS NULL OR (
      source_ref = btrim(source_ref) AND source_ref <> '' AND length(source_ref) <= 512
      AND source_ref !~ '[[:cntrl:]]' AND source_ref !~* '^https?://'
      AND strpos(source_ref, '?') = 0 AND strpos(source_ref, '#') = 0
    )
  ),
  source_unit_key text NOT NULL CHECK (
    source_unit_key = btrim(source_unit_key) AND source_unit_key <> ''
    AND length(source_unit_key) <= 256 AND source_unit_key !~ '[[:cntrl:]]'
  ),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_evidence_type text NOT NULL CHECK (source_evidence_type IN (
    'AGENT_ASSERTED_UNVERIFIED', 'SERVER_FINGERPRINTED_EXTRACTION', 'HOST_ATTESTED_FILE_RECEIPT'
  )),
  confirmation_summary_hash text NOT NULL CHECK (confirmation_summary_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'CONFIRMED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_VERIFIED',
    'READBACK_MISMATCH', 'FAILED_VALIDATION', 'PROVIDER_REJECTED'
  )),
  xero_object_id text CHECK (xero_object_id IS NULL OR (xero_object_id = btrim(xero_object_id) AND xero_object_id <> '')),
  write_receipt jsonb CHECK (write_receipt IS NULL OR jsonb_typeof(write_receipt) = 'object'),
  readback_snapshot jsonb CHECK (readback_snapshot IS NULL OR jsonb_typeof(readback_snapshot) = 'object'),
  readback_snapshot_hash text CHECK (
    readback_snapshot_hash IS NULL OR readback_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  readback_canonical_payload jsonb CHECK (
    readback_canonical_payload IS NULL OR jsonb_typeof(readback_canonical_payload) = 'object'
  ),
  readback_payload_hash text CHECK (
    readback_payload_hash IS NULL OR readback_payload_hash ~ '^[a-f0-9]{64}$'
  ),
  readback_status text CHECK (
    readback_status IS NULL OR (
      readback_status = btrim(readback_status) AND readback_status <> '' AND length(readback_status) <= 64
    )
  ),
  validation_receipt jsonb CHECK (
    validation_receipt IS NULL OR jsonb_typeof(validation_receipt) = 'object'
  ),
  provider_rejection_receipt jsonb CHECK (
    provider_rejection_receipt IS NULL OR (
      jsonb_typeof(provider_rejection_receipt) = 'object' AND provider_rejection_receipt <> '{}'::jsonb
    )
  ),
  confirmed_at timestamptz NOT NULL,
  write_started_at timestamptz,
  write_unknown_at timestamptz,
  verified_at timestamptz,
  validation_failed_at timestamptz,
  provider_rejected_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT xero_mutation_request_operation_check CHECK (
    (object_type IN ('QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL')
      AND operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
  ),
  CONSTRAINT xero_mutation_request_update_target_check CHECK (
    operation <> 'UPDATE' OR xero_object_id IS NULL OR xero_object_id = target_xero_object_id
  ),
  CONSTRAINT xero_mutation_request_preparation_binding_fk FOREIGN KEY (
    preparation_id, actor_id, workspace_id, tenant_id, oauth_installation_id, binding_id, connection_id,
    object_type, operation, canonical_payload_hash, source_unit_key, source_sha256,
    source_evidence_type, confirmation_summary_hash
  ) REFERENCES xero_mutation_preparations (
    preparation_id, actor_id, workspace_id, tenant_id, oauth_installation_id, binding_id, connection_id,
    object_type, operation, canonical_payload_hash, source_unit_key, source_sha256,
    source_evidence_type, confirmation_summary_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT xero_mutation_request_readback_binding_check CHECK (
    (readback_snapshot IS NULL AND readback_snapshot_hash IS NULL
      AND readback_canonical_payload IS NULL AND readback_payload_hash IS NULL AND readback_status IS NULL)
    OR (
      readback_snapshot IS NOT NULL AND readback_snapshot_hash IS NOT NULL
      AND readback_canonical_payload IS NOT NULL AND readback_payload_hash IS NOT NULL
      AND readback_status IS NOT NULL AND xero_object_id IS NOT NULL
      AND readback_snapshot ->> 'xeroObjectId' = xero_object_id
      AND readback_snapshot ->> 'status' = readback_status
      AND readback_snapshot -> 'canonicalPayload' = readback_canonical_payload
    )
  ),
  CONSTRAINT xero_mutation_request_lifecycle_check CHECK (
    updated_at >= created_at
    AND confirmed_at >= created_at
    AND (write_started_at IS NULL OR write_started_at >= confirmed_at)
    AND (write_unknown_at IS NULL OR (write_started_at IS NOT NULL AND write_unknown_at >= write_started_at))
    AND (verified_at IS NULL OR (write_started_at IS NOT NULL AND verified_at >= write_started_at))
    AND (validation_failed_at IS NULL OR validation_failed_at >= confirmed_at)
    AND (provider_rejected_at IS NULL OR (
      write_started_at IS NOT NULL AND provider_rejected_at >= write_started_at
    ))
    AND (
      (state = 'CONFIRMED'
        AND write_started_at IS NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND xero_object_id IS NULL
        AND readback_snapshot IS NULL AND validation_receipt IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_IN_FLIGHT'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_UNCERTAIN'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NOT NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'READBACK_VERIFIED'
        AND write_started_at IS NOT NULL AND verified_at IS NOT NULL AND validation_failed_at IS NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND write_receipt <> '{}'::jsonb
        AND readback_snapshot IS NOT NULL AND readback_payload_hash = canonical_payload_hash
        AND readback_status = CASE object_type
          WHEN 'QUOTE' THEN 'DRAFT'
          WHEN 'PURCHASE_ORDER' THEN 'DRAFT'
          WHEN 'CREDIT_NOTE' THEN 'DRAFT'
          WHEN 'MANUAL_JOURNAL' THEN 'DRAFT'
          WHEN 'CONTACT' THEN 'ACTIVE'
          WHEN 'ITEM' THEN 'UNTRACKED'
          WHEN 'ATTACHMENT' THEN 'UPLOADED'
        END
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'READBACK_MISMATCH'
        AND write_started_at IS NOT NULL AND verified_at IS NULL AND validation_failed_at IS NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND write_receipt <> '{}'::jsonb
        AND readback_snapshot IS NOT NULL
        AND readback_payload_hash IS NOT NULL AND (
          readback_payload_hash <> canonical_payload_hash
          OR readback_status <> CASE object_type
            WHEN 'QUOTE' THEN 'DRAFT'
            WHEN 'PURCHASE_ORDER' THEN 'DRAFT'
            WHEN 'CREDIT_NOTE' THEN 'DRAFT'
            WHEN 'MANUAL_JOURNAL' THEN 'DRAFT'
            WHEN 'CONTACT' THEN 'ACTIVE'
            WHEN 'ITEM' THEN 'UNTRACKED'
            WHEN 'ATTACHMENT' THEN 'UPLOADED'
          END
        )
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'FAILED_VALIDATION'
        AND write_started_at IS NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NOT NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'PROVIDER_REJECTED'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND provider_rejected_at IS NOT NULL
        AND xero_object_id IS NOT DISTINCT FROM (
          CASE WHEN operation = 'UPDATE' THEN target_xero_object_id ELSE NULL END
        )
        AND write_receipt IS NULL AND readback_snapshot IS NULL
        AND validation_receipt IS NULL AND provider_rejection_receipt IS NOT NULL)
    )
  )
);

-- Exact request replay is scoped exactly as the public mutation contract.
CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_idempotency_unique_idx
  ON xero_mutation_requests (actor_id, tenant_id, object_type, operation, request_id);

-- Uncertain and mismatched outcomes retain their source reservation. A locally
-- rejected validation may be corrected and prepared again.
CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_active_source_unique_idx
  ON xero_mutation_requests (tenant_id, object_type, operation, source_sha256, source_unit_key)
  WHERE state IN (
    'CONFIRMED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN',
    'READBACK_VERIFIED', 'READBACK_MISMATCH'
  );

-- A server fingerprint includes the canonical extraction, so content changes
-- intentionally change source_sha256. This independent opaque source+unit
-- guard prevents the same source row from being confirmed again merely by
-- altering the proposed payload.
CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_active_source_ref_unit_unique_idx
  ON xero_mutation_requests (tenant_id, object_type, operation, source_ref, source_unit_key)
  WHERE source_ref IS NOT NULL AND state IN (
    'CONFIRMED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN',
    'READBACK_VERIFIED', 'READBACK_MISMATCH'
  );

-- Provider-created object IDs are globally unambiguous within a Xero tenant
-- and object class. UPDATE targets may be reused only after the prior update
-- reaches a terminal state; concurrent or uncertain updates remain exclusive.
CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_exact_created_object_unique_idx
  ON xero_mutation_requests (tenant_id, object_type, xero_object_id)
  WHERE xero_object_id IS NOT NULL AND operation IN ('CREATE_DRAFT', 'CREATE', 'UPLOAD');

CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_exact_active_update_unique_idx
  ON xero_mutation_requests (tenant_id, object_type, xero_object_id)
  WHERE xero_object_id IS NOT NULL
    AND operation = 'UPDATE'
    AND state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH');

CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_active_object_unique_idx
  ON xero_mutation_requests (tenant_id, object_type, xero_object_id)
  WHERE xero_object_id IS NOT NULL
    AND state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH');

CREATE INDEX IF NOT EXISTS xero_mutation_requests_state_idx
  ON xero_mutation_requests (tenant_id, state, updated_at);

CREATE OR REPLACE FUNCTION xero_mutation_preparation_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.preparation_id, NEW.actor_id, NEW.workspace_id, NEW.tenant_id,
    NEW.oauth_installation_id, NEW.binding_id, NEW.connection_id,
    NEW.object_type, NEW.operation, NEW.target_xero_object_id, NEW.canonical_payload, NEW.canonical_payload_hash,
    NEW.source_ref, NEW.source_unit_key, NEW.source_sha256, NEW.source_evidence_type,
    NEW.confirmation_summary_hash, NEW.confirmation_phrase_hash,
    NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.preparation_id, OLD.actor_id, OLD.workspace_id, OLD.tenant_id,
    OLD.oauth_installation_id, OLD.binding_id, OLD.connection_id,
    OLD.object_type, OLD.operation, OLD.target_xero_object_id, OLD.canonical_payload, OLD.canonical_payload_hash,
    OLD.source_ref, OLD.source_unit_key, OLD.source_sha256, OLD.source_evidence_type,
    OLD.confirmation_summary_hash, OLD.confirmation_phrase_hash,
    OLD.expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'xero mutation preparation immutable fields cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xero_mutation_preparation_immutable_trigger ON xero_mutation_preparations;
CREATE TRIGGER xero_mutation_preparation_immutable_trigger
BEFORE UPDATE ON xero_mutation_preparations
FOR EACH ROW EXECUTE FUNCTION xero_mutation_preparation_immutable_guard();

CREATE OR REPLACE FUNCTION xero_mutation_request_preparation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM xero_mutation_preparations preparation
    WHERE preparation.preparation_id = NEW.preparation_id
      AND preparation.state = 'PREPARED'
      AND preparation.actor_id = NEW.actor_id
      AND preparation.workspace_id = NEW.workspace_id
      AND preparation.tenant_id = NEW.tenant_id
      AND preparation.oauth_installation_id = NEW.oauth_installation_id
      AND preparation.binding_id = NEW.binding_id
      AND preparation.connection_id = NEW.connection_id
      AND preparation.object_type = NEW.object_type
      AND preparation.operation = NEW.operation
      AND preparation.target_xero_object_id IS NOT DISTINCT FROM NEW.target_xero_object_id
      AND preparation.canonical_payload = NEW.canonical_payload
      AND preparation.canonical_payload_hash = NEW.canonical_payload_hash
      AND preparation.source_ref IS NOT DISTINCT FROM NEW.source_ref
      AND preparation.source_unit_key = NEW.source_unit_key
      AND preparation.source_sha256 = NEW.source_sha256
      AND preparation.source_evidence_type = NEW.source_evidence_type
      AND preparation.confirmation_summary_hash = NEW.confirmation_summary_hash
  ) THEN
    RAISE EXCEPTION 'xero mutation request does not match its immutable preparation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xero_mutation_request_preparation_trigger ON xero_mutation_requests;
CREATE TRIGGER xero_mutation_request_preparation_trigger
BEFORE INSERT ON xero_mutation_requests
FOR EACH ROW EXECUTE FUNCTION xero_mutation_request_preparation_guard();

CREATE OR REPLACE FUNCTION xero_mutation_request_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.mutation_request_id, NEW.preparation_id, NEW.request_id,
    NEW.actor_id, NEW.workspace_id, NEW.tenant_id, NEW.oauth_installation_id,
    NEW.binding_id, NEW.connection_id, NEW.object_type, NEW.operation, NEW.target_xero_object_id,
    NEW.canonical_payload, NEW.canonical_payload_hash, NEW.source_ref, NEW.source_unit_key, NEW.source_sha256,
    NEW.source_evidence_type,
    NEW.confirmation_summary_hash, NEW.confirmed_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mutation_request_id, OLD.preparation_id, OLD.request_id,
    OLD.actor_id, OLD.workspace_id, OLD.tenant_id, OLD.oauth_installation_id,
    OLD.binding_id, OLD.connection_id, OLD.object_type, OLD.operation, OLD.target_xero_object_id,
    OLD.canonical_payload, OLD.canonical_payload_hash, OLD.source_ref, OLD.source_unit_key, OLD.source_sha256,
    OLD.source_evidence_type,
    OLD.confirmation_summary_hash, OLD.confirmed_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'xero mutation request immutable fields cannot change' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'CONFIRMED' AND NEW.state IN ('WRITE_IN_FLIGHT', 'FAILED_VALIDATION'))
    OR (OLD.state = 'WRITE_IN_FLIGHT' AND NEW.state IN (
      'WRITE_UNCERTAIN', 'READBACK_VERIFIED', 'READBACK_MISMATCH', 'PROVIDER_REJECTED'
    ))
    OR (OLD.state = 'WRITE_UNCERTAIN' AND NEW.state IN ('READBACK_VERIFIED', 'READBACK_MISMATCH'))
    OR (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED')
  ) THEN
    RAISE EXCEPTION 'invalid xero mutation state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('READBACK_VERIFIED', 'FAILED_VALIDATION', 'PROVIDER_REJECTED')
    AND ROW(
      NEW.state, NEW.xero_object_id, NEW.write_receipt, NEW.readback_snapshot,
      NEW.readback_snapshot_hash, NEW.readback_canonical_payload, NEW.readback_payload_hash,
      NEW.readback_status, NEW.validation_receipt, NEW.provider_rejection_receipt,
      NEW.write_started_at, NEW.write_unknown_at, NEW.verified_at,
      NEW.validation_failed_at, NEW.provider_rejected_at, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.xero_object_id, OLD.write_receipt, OLD.readback_snapshot,
      OLD.readback_snapshot_hash, OLD.readback_canonical_payload, OLD.readback_payload_hash,
      OLD.readback_status, OLD.validation_receipt, OLD.provider_rejection_receipt,
      OLD.write_started_at, OLD.write_unknown_at, OLD.verified_at,
      OLD.validation_failed_at, OLD.provider_rejected_at, OLD.updated_at
    )
  THEN
    RAISE EXCEPTION 'terminal xero mutation evidence cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS xero_mutation_request_immutable_trigger ON xero_mutation_requests;
CREATE TRIGGER xero_mutation_request_immutable_trigger
BEFORE UPDATE ON xero_mutation_requests
FOR EACH ROW EXECUTE FUNCTION xero_mutation_request_immutable_guard();
