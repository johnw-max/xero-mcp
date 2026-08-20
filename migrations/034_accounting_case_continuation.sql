SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS accounting_case_version_lifecycle ON accounting_case_versions;

ALTER TABLE accounting_case_versions
  DROP CONSTRAINT IF EXISTS accounting_case_versions_state_check,
  DROP CONSTRAINT IF EXISTS accounting_case_version_lifecycle_shape_check;

ALTER TABLE accounting_case_versions
  ADD CONSTRAINT accounting_case_versions_state_check CHECK (state IN (
    'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
    'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS',
    'PREFLIGHTED', 'READY_TO_RESUME', 'EXECUTING', 'RECOVERY_REQUIRED',
    'AWAITING_CONTINUATION', 'PARTIALLY_COMMITTED', 'TERMINAL'
  )),
  ADD CONSTRAINT accounting_case_version_lifecycle_shape_check CHECK (
    updated_at >= created_at
    AND (
      (state IN (
        'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
        'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS'
      ) AND preflight_request_id IS NULL AND preflight_receipt IS NULL
        AND preflight_receipt_hash IS NULL AND preflighted_at IS NULL
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NULL AND terminal_summary IS NULL)
      OR (state = 'PREFLIGHTED'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NULL AND terminal_summary IS NULL)
      OR (state = 'READY_TO_RESUME'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NOT NULL AND terminal_summary IS NULL)
      OR (state = 'EXECUTING'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND terminal_summary IS NULL)
      OR (state = 'AWAITING_CONTINUATION'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND terminal_summary IS NULL)
      OR (state IN ('RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL')
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND terminal_summary IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION accounting_case_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.case_id, NEW.version, NEW.compiled_case, NEW.compiled_plan_hash,
    NEW.source_revision_hash, NEW.initial_state, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.case_id, OLD.version, OLD.compiled_case, OLD.compiled_plan_hash,
    OLD.source_revision_hash, OLD.initial_state, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Accounting Case compiled plan is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state IN ('PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS') AND NEW.state = 'PREFLIGHTED')
    OR (OLD.state = 'PREFLIGHTED' AND NEW.state = 'EXECUTING')
    OR (OLD.state = 'READY_TO_RESUME' AND NEW.state = 'EXECUTING')
    OR (OLD.state = 'EXECUTING' AND NEW.state IN (
      'READY_TO_RESUME', 'RECOVERY_REQUIRED', 'AWAITING_CONTINUATION',
      'PARTIALLY_COMMITTED', 'TERMINAL'
    ))
    OR (OLD.state = 'RECOVERY_REQUIRED' AND NEW.state IN (
      'READY_TO_RESUME', 'PARTIALLY_COMMITTED', 'TERMINAL'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid Accounting Case state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  IF OLD.preflight_request_id IS NOT NULL AND ROW(
    NEW.preflight_request_id, NEW.preflight_receipt,
    NEW.preflight_receipt_hash, NEW.preflighted_at
  ) IS DISTINCT FROM ROW(
    OLD.preflight_request_id, OLD.preflight_receipt,
    OLD.preflight_receipt_hash, OLD.preflighted_at
  ) THEN
    RAISE EXCEPTION 'Accounting Case preflight receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PREFLIGHTED' AND NEW.state = 'PREFLIGHTED' AND EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = NEW.case_id
      AND operation_row.case_version = NEW.version
      AND (
        operation_row.state NOT IN ('PREPARED', 'NO_WRITE_REQUIRED')
        OR (operation_row.state = 'PREPARED' AND (
          operation_row.preparation_id IS NULL
          OR operation_row.preparation_canonical_payload_hash IS NULL
          OR operation_row.operation_source_sha256 IS NULL
        ))
        OR (operation_row.state = 'NO_WRITE_REQUIRED' AND (
          operation_row.xero_object_id IS NULL OR operation_row.readback_snapshot IS NULL
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Accounting Case preflight requires complete prepared or no-write operation evidence'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_request_id IS NOT NULL
    AND ROW(NEW.execution_request_id, NEW.execution_started_at)
      IS DISTINCT FROM ROW(OLD.execution_request_id, OLD.execution_started_at)
    AND NEW.state <> 'READY_TO_RESUME' THEN
    RAISE EXCEPTION 'Accounting Case execution claim is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('PARTIALLY_COMMITTED', 'TERMINAL')
    AND NEW.state = OLD.state AND NEW.terminal_summary IS DISTINCT FROM OLD.terminal_summary THEN
    RAISE EXCEPTION 'Accounting Case terminal evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_execution_error_receipt IS DISTINCT FROM OLD.last_execution_error_receipt
    AND NEW.state <> 'READY_TO_RESUME' THEN
    RAISE EXCEPTION 'Accounting Case pause evidence may change only when entering ready-to-resume'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'READY_TO_RESUME' AND (
    NEW.execution_request_id IS NOT NULL OR NEW.execution_started_at IS NOT NULL
    OR NEW.last_execution_error_receipt IS NULL OR NEW.terminal_summary IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version AND operation_row.state = 'PREPARED'
    )
    OR EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
    )
  ) THEN
    RAISE EXCEPTION 'Accounting Case ready-to-resume requires prepared residual work and no recovery evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'AWAITING_CONTINUATION' AND (
    NEW.terminal_summary IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    )
    OR EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state NOT IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.compiled_case -> 'events') AS event_row
      WHERE event_row -> 'reasonCodes' ? 'PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION'
    )
  ) THEN
    RAISE EXCEPTION 'Accounting Case continuation requires verified writes and an explicit dependent residual event'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('PARTIALLY_COMMITTED', 'TERMINAL') AND EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
      AND operation_row.state IN (
        'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
      )
  ) THEN
    RAISE EXCEPTION 'Accounting Case cannot terminate with unfinished operations' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'PARTIALLY_COMMITTED' AND (
    NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    ) OR NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
    )
  ) THEN
    RAISE EXCEPTION 'Partially committed Accounting Case requires completed and definitely failed operations'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'TERMINAL'
    AND EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    ) AND EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
    ) THEN
    RAISE EXCEPTION 'Mixed completed and failed Accounting Case must be partially committed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'RECOVERY_REQUIRED' AND NEW.state = 'RECOVERY_REQUIRED' AND NOT EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = NEW.case_id AND operation_row.case_version = NEW.version
      AND operation_row.state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
  ) THEN
    RAISE EXCEPTION 'Accounting Case recovery requires in-flight, uncertain, or mismatched operation evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL')
    AND NEW.terminal_summary IS DISTINCT FROM accounting_case_terminal_state_projection(
      NEW.case_id, NEW.version, NEW.state
    ) THEN
    RAISE EXCEPTION 'Accounting Case terminal summary must be the deterministic operation projection'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_case_version_lifecycle
BEFORE UPDATE ON accounting_case_versions
FOR EACH ROW EXECUTE FUNCTION accounting_case_version_guard();
