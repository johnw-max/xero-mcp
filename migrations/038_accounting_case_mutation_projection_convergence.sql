-- A durable mutation can converge from WRITE_UNCERTAIN to READBACK_MISMATCH
-- after an exact recovery GET proves that a provider object exists but its
-- evidence does not match. The operation projection must replace only its
-- derived state receipt while preserving every provider observation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION accounting_case_operation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_row accounting_cases%ROWTYPE;
  preparation_row xero_mutation_preparations%ROWTYPE;
  request_row xero_mutation_requests%ROWTYPE;
  expected_operation_state text;
  expected_error_receipt jsonb;
  mutation_projection_error_convergence boolean;
BEGIN
  IF (SELECT state FROM accounting_case_versions
      WHERE case_id = OLD.case_id AND version = OLD.case_version) = 'PREFLIGHTED'
    AND ROW(
      NEW.state, NEW.preparation_id, NEW.preparation_canonical_payload_hash,
      NEW.operation_source_sha256, NEW.mutation_request_id, NEW.xero_object_id,
      NEW.write_receipt, NEW.readback_snapshot, NEW.error_receipt, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.preparation_id, OLD.preparation_canonical_payload_hash,
      OLD.operation_source_sha256, OLD.mutation_request_id, OLD.xero_object_id,
      OLD.write_receipt, OLD.readback_snapshot, OLD.error_receipt, OLD.updated_at
    ) THEN
    RAISE EXCEPTION 'Accounting Case preflight operation set is sealed until execution claim'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.case_id, NEW.case_version, NEW.operation_id, NEW.ordinal, NEW.event_id,
    NEW.action_id, NEW.native_route, NEW.dependency_event_keys, NEW.operation_json,
    NEW.canonical_payload, NEW.canonical_payload_hash, NEW.source_revision_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.case_id, OLD.case_version, OLD.operation_id, OLD.ordinal, OLD.event_id,
    OLD.action_id, OLD.native_route, OLD.dependency_event_keys, OLD.operation_json,
    OLD.canonical_payload, OLD.canonical_payload_hash, OLD.source_revision_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Accounting Case operation plan and payload are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_id IS NOT NULL AND NEW.preparation_id IS DISTINCT FROM OLD.preparation_id THEN
    RAISE EXCEPTION 'Accounting Case operation preparation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_canonical_payload_hash IS NOT NULL
    AND NEW.preparation_canonical_payload_hash IS DISTINCT FROM OLD.preparation_canonical_payload_hash THEN
    RAISE EXCEPTION 'Accounting Case operation preparation payload identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_source_sha256 IS NOT NULL
    AND NEW.operation_source_sha256 IS DISTINCT FROM OLD.operation_source_sha256 THEN
    RAISE EXCEPTION 'Accounting Case operation source identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.mutation_request_id IS NOT NULL AND NEW.mutation_request_id IS DISTINCT FROM OLD.mutation_request_id THEN
    RAISE EXCEPTION 'Accounting Case operation mutation request is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.xero_object_id IS NOT NULL AND NEW.xero_object_id IS DISTINCT FROM OLD.xero_object_id THEN
    RAISE EXCEPTION 'Accounting Case operation Xero object is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.write_receipt IS NOT NULL AND NEW.write_receipt IS DISTINCT FROM OLD.write_receipt THEN
    RAISE EXCEPTION 'Accounting Case operation write receipt is immutable' USING ERRCODE = '23514';
  END IF;

  mutation_projection_error_convergence :=
    OLD.state = 'WRITE_UNCERTAIN'
    AND NEW.state = 'READBACK_MISMATCH'
    AND OLD.mutation_request_id IS NOT NULL
    AND NEW.mutation_request_id IS NOT DISTINCT FROM OLD.mutation_request_id
    AND OLD.error_receipt IS NOT DISTINCT FROM jsonb_build_object(
      'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
      'mutationRequestId', OLD.mutation_request_id,
      'mutationState', 'WRITE_UNCERTAIN'
    )
    AND NEW.error_receipt IS NOT DISTINCT FROM jsonb_build_object(
      'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
      'mutationRequestId', OLD.mutation_request_id,
      'mutationState', 'READBACK_MISMATCH'
    );

  IF OLD.error_receipt IS NOT NULL AND NEW.error_receipt IS DISTINCT FROM OLD.error_receipt
    AND NOT (OLD.state IN ('WRITE_UNCERTAIN', 'READBACK_MISMATCH') AND NEW.state = 'READBACK_VERIFIED')
    AND NOT mutation_projection_error_convergence THEN
    RAISE EXCEPTION 'Accounting Case operation error receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.readback_snapshot IS NOT NULL AND NEW.readback_snapshot IS DISTINCT FROM OLD.readback_snapshot
    AND NOT (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED') THEN
    RAISE EXCEPTION 'Accounting Case operation readback evidence cannot be replaced'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'PENDING' AND NEW.state IN (
      'PREPARED', 'NO_WRITE_REQUIRED', 'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
    ))
    OR (OLD.state = 'PREPARED' AND NEW.state IN (
      'WRITE_IN_FLIGHT', 'NO_WRITE_REQUIRED', 'READBACK_VERIFIED', 'WRITE_UNCERTAIN',
      'READBACK_MISMATCH', 'PROVIDER_REJECTED', 'BLOCKED_VALIDATION',
      'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
    ))
    OR (OLD.state = 'WRITE_IN_FLIGHT' AND NEW.state IN (
      'READBACK_VERIFIED', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH', 'PROVIDER_REJECTED'
    ))
    OR (OLD.state = 'WRITE_UNCERTAIN' AND NEW.state IN ('READBACK_VERIFIED', 'READBACK_MISMATCH'))
    OR (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED')
  ) THEN
    RAISE EXCEPTION 'invalid Accounting Case operation state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO case_row FROM accounting_cases WHERE case_id = NEW.case_id;
  IF NEW.preparation_id IS NOT NULL THEN
    SELECT * INTO preparation_row FROM xero_mutation_preparations
    WHERE preparation_id = NEW.preparation_id;
    IF preparation_row.preparation_id IS NULL
      OR preparation_row.actor_id <> case_row.actor_id
      OR preparation_row.workspace_id <> case_row.workspace_id
      OR preparation_row.tenant_id <> case_row.tenant_id
      OR preparation_row.oauth_installation_id <> case_row.oauth_installation_id
      OR preparation_row.binding_id <> case_row.binding_id
      OR preparation_row.binding_revision IS DISTINCT FROM case_row.binding_revision
      OR preparation_row.connection_id <> case_row.connection_id
      OR preparation_row.target_session_id IS DISTINCT FROM case_row.target_session_id
      OR preparation_row.source_ref IS DISTINCT FROM ('case:' || NEW.case_id)
      OR preparation_row.source_unit_key <> NEW.operation_id
      OR preparation_row.source_sha256 IS DISTINCT FROM NEW.operation_source_sha256
      OR preparation_row.canonical_payload_hash IS DISTINCT FROM NEW.preparation_canonical_payload_hash
      OR (NEW.action_id = 'contact.create_basic'
        AND (preparation_row.object_type <> 'CONTACT' OR preparation_row.operation <> 'CREATE'))
      OR (NEW.action_id = 'customer_invoice.create_draft'
        AND (preparation_row.object_type <> 'SALES_INVOICE' OR preparation_row.operation <> 'CREATE_DRAFT'))
      OR (NEW.action_id = 'supplier_bill.create_draft'
        AND (preparation_row.object_type <> 'SUPPLIER_BILL' OR preparation_row.operation <> 'CREATE_DRAFT'))
      OR (NEW.action_id = 'credit_note.create_draft'
        AND (preparation_row.object_type <> 'CREDIT_NOTE' OR preparation_row.operation <> 'CREATE_DRAFT'))
      OR (NEW.state = 'PREPARED'
        AND (preparation_row.state <> 'PREPARED' OR preparation_row.expires_at <= NEW.updated_at))
    THEN
      RAISE EXCEPTION 'Accounting Case operation does not match its durable mutation preparation'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'NO_WRITE_REQUIRED' AND (
    NEW.action_id <> 'contact.create_basic'
    OR COALESCE(
      NEW.readback_snapshot ->> 'contactId', NEW.readback_snapshot ->> 'contactID',
      NEW.readback_snapshot ->> 'ContactID', NEW.readback_snapshot ->> 'id'
    ) IS DISTINCT FROM NEW.xero_object_id
    OR COALESCE(NEW.readback_snapshot ->> 'name', NEW.readback_snapshot ->> 'Name')
      IS DISTINCT FROM NEW.canonical_payload ->> 'name'
    OR COALESCE(NEW.readback_snapshot ->> 'status', NEW.readback_snapshot ->> 'Status', 'ACTIVE') <> 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Accounting Case no-write evidence must be an exact active contact match'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'NOT_EXECUTED_AFTER_PRIOR_FAILURE' AND NOT EXISTS (
    SELECT 1 FROM accounting_case_operations earlier
    WHERE earlier.case_id = NEW.case_id AND earlier.case_version = NEW.case_version
      AND earlier.ordinal < NEW.ordinal
      AND earlier.state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
  ) THEN
    RAISE EXCEPTION 'Accounting Case residual operation requires an earlier definite failure'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.mutation_request_id IS NOT NULL THEN
    SELECT * INTO request_row FROM xero_mutation_requests
    WHERE mutation_request_id = NEW.mutation_request_id;
    expected_operation_state := CASE request_row.state
      WHEN 'WRITE_IN_FLIGHT' THEN 'WRITE_IN_FLIGHT'
      WHEN 'WRITE_UNCERTAIN' THEN 'WRITE_UNCERTAIN'
      WHEN 'READBACK_VERIFIED' THEN 'READBACK_VERIFIED'
      WHEN 'READBACK_MISMATCH' THEN 'READBACK_MISMATCH'
      WHEN 'PROVIDER_REJECTED' THEN 'PROVIDER_REJECTED'
      WHEN 'FAILED_VALIDATION' THEN 'BLOCKED_VALIDATION'
      ELSE NULL
    END;
    expected_error_receipt := CASE request_row.state
      WHEN 'WRITE_UNCERTAIN' THEN jsonb_build_object(
        'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
        'mutationRequestId', request_row.mutation_request_id, 'mutationState', request_row.state
      )
      WHEN 'READBACK_MISMATCH' THEN jsonb_build_object(
        'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
        'mutationRequestId', request_row.mutation_request_id, 'mutationState', request_row.state
      )
      WHEN 'PROVIDER_REJECTED' THEN request_row.provider_rejection_receipt
      WHEN 'FAILED_VALIDATION' THEN COALESCE(request_row.validation_receipt, jsonb_build_object(
        'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
        'mutationRequestId', request_row.mutation_request_id, 'mutationState', request_row.state
      ))
      ELSE NULL
    END;
    IF request_row.mutation_request_id IS NULL OR expected_operation_state IS NULL
      OR NEW.state <> expected_operation_state
      OR request_row.preparation_id <> NEW.preparation_id
      OR request_row.actor_id <> case_row.actor_id
      OR request_row.workspace_id <> case_row.workspace_id
      OR request_row.tenant_id <> case_row.tenant_id
      OR request_row.oauth_installation_id <> case_row.oauth_installation_id
      OR request_row.binding_id <> case_row.binding_id
      OR request_row.binding_revision IS DISTINCT FROM case_row.binding_revision
      OR request_row.connection_id <> case_row.connection_id
      OR request_row.target_session_id IS DISTINCT FROM case_row.target_session_id
      OR request_row.canonical_payload_hash IS DISTINCT FROM NEW.preparation_canonical_payload_hash
      OR request_row.source_ref IS DISTINCT FROM ('case:' || NEW.case_id)
      OR request_row.source_unit_key <> NEW.operation_id
      OR request_row.source_sha256 IS DISTINCT FROM NEW.operation_source_sha256
      OR request_row.xero_object_id IS DISTINCT FROM NEW.xero_object_id
      OR request_row.write_receipt IS DISTINCT FROM NEW.write_receipt
      OR request_row.readback_snapshot IS DISTINCT FROM NEW.readback_snapshot
      OR expected_error_receipt IS DISTINCT FROM NEW.error_receipt
    THEN
      RAISE EXCEPTION 'Accounting Case mutation evidence must be projected from its durable mutation request'
        USING ERRCODE = '23514', DETAIL = concat_ws(',',
          CASE WHEN request_row.mutation_request_id IS NULL THEN 'REQUEST_MISSING' END,
          CASE WHEN expected_operation_state IS NULL THEN 'STATE_UNMAPPABLE' END,
          CASE WHEN NEW.state <> expected_operation_state THEN 'STATE' END,
          CASE WHEN request_row.preparation_id <> NEW.preparation_id THEN 'PREPARATION_ID' END,
          CASE WHEN request_row.actor_id <> case_row.actor_id THEN 'ACTOR_ID' END,
          CASE WHEN request_row.workspace_id <> case_row.workspace_id THEN 'WORKSPACE_ID' END,
          CASE WHEN request_row.tenant_id <> case_row.tenant_id THEN 'TENANT_ID' END,
          CASE WHEN request_row.oauth_installation_id <> case_row.oauth_installation_id THEN 'INSTALLATION_ID' END,
          CASE WHEN request_row.binding_id <> case_row.binding_id THEN 'BINDING_ID' END,
          CASE WHEN request_row.binding_revision IS DISTINCT FROM case_row.binding_revision THEN 'BINDING_REVISION' END,
          CASE WHEN request_row.connection_id <> case_row.connection_id THEN 'CONNECTION_ID' END,
          CASE WHEN request_row.target_session_id IS DISTINCT FROM case_row.target_session_id THEN 'TARGET_SESSION_ID' END,
          CASE WHEN request_row.canonical_payload_hash IS DISTINCT FROM NEW.preparation_canonical_payload_hash THEN 'CANONICAL_PAYLOAD_HASH' END,
          CASE WHEN request_row.source_ref IS DISTINCT FROM ('case:' || NEW.case_id) THEN 'SOURCE_REF' END,
          CASE WHEN request_row.source_unit_key <> NEW.operation_id THEN 'SOURCE_UNIT_KEY' END,
          CASE WHEN request_row.source_sha256 IS DISTINCT FROM NEW.operation_source_sha256 THEN 'SOURCE_SHA256' END,
          CASE WHEN request_row.xero_object_id IS DISTINCT FROM NEW.xero_object_id THEN 'XERO_OBJECT_ID' END,
          CASE WHEN request_row.write_receipt IS DISTINCT FROM NEW.write_receipt THEN 'WRITE_RECEIPT' END,
          CASE WHEN request_row.readback_snapshot IS DISTINCT FROM NEW.readback_snapshot THEN 'READBACK_SNAPSHOT' END,
          CASE WHEN expected_error_receipt IS DISTINCT FROM NEW.error_receipt THEN 'ERROR_RECEIPT' END
        );
    END IF;
  END IF;
  IF OLD.state IN (
    'NO_WRITE_REQUIRED', 'READBACK_VERIFIED', 'PROVIDER_REJECTED',
    'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
  ) AND ROW(
    NEW.state, NEW.preparation_id, NEW.preparation_canonical_payload_hash,
    NEW.operation_source_sha256, NEW.mutation_request_id, NEW.xero_object_id,
    NEW.write_receipt, NEW.readback_snapshot, NEW.error_receipt, NEW.updated_at
  ) IS DISTINCT FROM ROW(
    OLD.state, OLD.preparation_id, OLD.preparation_canonical_payload_hash,
    OLD.operation_source_sha256, OLD.mutation_request_id, OLD.xero_object_id,
    OLD.write_receipt, OLD.readback_snapshot, OLD.error_receipt, OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'Accounting Case terminal operation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
