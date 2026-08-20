SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Keep authority evidence distinct from both model-visible confirmation text
-- and validation-failure evidence. Existing rows are retained as historical
-- legacy operations; every new autonomous request receives a kernel receipt.
ALTER TABLE xero_mutation_requests
  ADD COLUMN IF NOT EXISTS authorization_receipt jsonb;

UPDATE xero_mutation_requests
SET authorization_receipt = jsonb_build_object(
  'receiptType', 'LEGACY_CONFIRMATION_AUTHORITY',
  'migration', '026_xero_autonomous_authorization_receipts',
  'preparationId', preparation_id,
  'canonicalPayloadHash', canonical_payload_hash
)
WHERE authorization_receipt IS NULL;

ALTER TABLE xero_mutation_requests
  ALTER COLUMN authorization_receipt SET NOT NULL;

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_requests_authorization_receipt_check;
ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_requests_authorization_receipt_check
  CHECK (
    jsonb_typeof(authorization_receipt) = 'object'
    AND authorization_receipt ? 'receiptType'
  );

-- Migration 018 treated validation_receipt only as deterministic failure
-- evidence. Autonomous authorization now persists a successful kernel
-- validation receipt before claiming WRITE_IN_FLIGHT, and that immutable
-- receipt remains attached through recovery/readback states. Replace the old
-- lifecycle constraint instead of weakening the writer or dropping evidence.
ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_request_lifecycle_check;

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_request_lifecycle_check CHECK (
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
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_UNCERTAIN'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NOT NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'READBACK_VERIFIED'
        AND write_started_at IS NOT NULL AND verified_at IS NOT NULL AND validation_failed_at IS NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND write_receipt <> '{}'::jsonb
        AND readback_snapshot IS NOT NULL AND readback_payload_hash = canonical_payload_hash
        AND readback_status = CASE object_type
          WHEN 'SUPPLIER_BILL' THEN 'DRAFT'
          WHEN 'SALES_INVOICE' THEN 'DRAFT'
          WHEN 'QUOTE' THEN 'DRAFT'
          WHEN 'PURCHASE_ORDER' THEN 'DRAFT'
          WHEN 'CREDIT_NOTE' THEN 'DRAFT'
          WHEN 'MANUAL_JOURNAL' THEN 'DRAFT'
          WHEN 'CONTACT' THEN 'ACTIVE'
          WHEN 'ITEM' THEN 'UNTRACKED'
          WHEN 'ATTACHMENT' THEN 'UPLOADED'
        END
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'READBACK_MISMATCH'
        AND write_started_at IS NOT NULL AND verified_at IS NULL AND validation_failed_at IS NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND write_receipt <> '{}'::jsonb
        AND readback_snapshot IS NOT NULL
        AND readback_payload_hash IS NOT NULL AND (
          readback_payload_hash <> canonical_payload_hash
          OR readback_status <> CASE object_type
            WHEN 'SUPPLIER_BILL' THEN 'DRAFT'
            WHEN 'SALES_INVOICE' THEN 'DRAFT'
            WHEN 'QUOTE' THEN 'DRAFT'
            WHEN 'PURCHASE_ORDER' THEN 'DRAFT'
            WHEN 'CREDIT_NOTE' THEN 'DRAFT'
            WHEN 'MANUAL_JOURNAL' THEN 'DRAFT'
            WHEN 'CONTACT' THEN 'ACTIVE'
            WHEN 'ITEM' THEN 'UNTRACKED'
            WHEN 'ATTACHMENT' THEN 'UPLOADED'
          END
        )
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
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
        AND provider_rejection_receipt IS NOT NULL)
    )
  );

-- Migration 025 introduced target/binding fields after the original immutable
-- guards. Rebuild the guards so those fields and the authority receipt cannot
-- be changed after preparation/authorization.
CREATE OR REPLACE FUNCTION xero_mutation_preparation_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.preparation_id, NEW.actor_id, NEW.workspace_id, NEW.tenant_id,
    NEW.oauth_installation_id, NEW.binding_id, NEW.connection_id,
    NEW.binding_revision, NEW.target_session_id,
    NEW.object_type, NEW.operation, NEW.target_xero_object_id, NEW.canonical_payload, NEW.canonical_payload_hash,
    NEW.source_ref, NEW.source_unit_key, NEW.source_sha256, NEW.source_evidence_type,
    NEW.confirmation_summary_hash, NEW.confirmation_phrase_hash,
    NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.preparation_id, OLD.actor_id, OLD.workspace_id, OLD.tenant_id,
    OLD.oauth_installation_id, OLD.binding_id, OLD.connection_id,
    OLD.binding_revision, OLD.target_session_id,
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
      AND preparation.binding_revision IS NOT DISTINCT FROM NEW.binding_revision
      AND preparation.target_session_id IS NOT DISTINCT FROM NEW.target_session_id
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

CREATE OR REPLACE FUNCTION xero_mutation_request_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.mutation_request_id, NEW.preparation_id, NEW.request_id,
    NEW.actor_id, NEW.workspace_id, NEW.tenant_id, NEW.oauth_installation_id,
    NEW.binding_id, NEW.connection_id, NEW.binding_revision, NEW.target_session_id,
    NEW.object_type, NEW.operation, NEW.target_xero_object_id,
    NEW.canonical_payload, NEW.canonical_payload_hash, NEW.source_ref, NEW.source_unit_key, NEW.source_sha256,
    NEW.source_evidence_type, NEW.confirmation_summary_hash, NEW.authorization_receipt,
    NEW.confirmed_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.mutation_request_id, OLD.preparation_id, OLD.request_id,
    OLD.actor_id, OLD.workspace_id, OLD.tenant_id, OLD.oauth_installation_id,
    OLD.binding_id, OLD.connection_id, OLD.binding_revision, OLD.target_session_id,
    OLD.object_type, OLD.operation, OLD.target_xero_object_id,
    OLD.canonical_payload, OLD.canonical_payload_hash, OLD.source_ref, OLD.source_unit_key, OLD.source_sha256,
    OLD.source_evidence_type, OLD.confirmation_summary_hash, OLD.authorization_receipt,
    OLD.confirmed_at, OLD.created_at
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
