SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Upgrade an already-applied 027 schema without replacing original Case target
-- evidence. Provider-proposal and per-operation source identities are linked
-- from the durable mutation preparation, never synthesized from Case JSON.
ALTER TABLE accounting_case_versions
  ADD COLUMN IF NOT EXISTS last_execution_error_receipt jsonb;

ALTER TABLE accounting_case_operations
  ADD COLUMN IF NOT EXISTS preparation_canonical_payload_hash text,
  ADD COLUMN IF NOT EXISTS operation_source_sha256 text;

-- The upgrade touches legacy rows only to attach evidence that can be proved
-- from the mutation kernel. Disable the old 027 guards transactionally; every
-- row is validated below before the replacement guards are installed.
DROP TRIGGER IF EXISTS accounting_case_version_lifecycle ON accounting_case_versions;
DROP TRIGGER IF EXISTS accounting_case_operation_lifecycle ON accounting_case_operations;

UPDATE accounting_case_operations operation_row
SET preparation_canonical_payload_hash = preparation.canonical_payload_hash,
    operation_source_sha256 = preparation.source_sha256
FROM xero_mutation_preparations preparation
WHERE operation_row.preparation_id = preparation.preparation_id
  AND (
    operation_row.preparation_canonical_payload_hash IS NULL
    OR operation_row.operation_source_sha256 IS NULL
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.preparation_id IS NOT NULL
      AND (
        operation_row.preparation_canonical_payload_hash IS NULL
        OR operation_row.operation_source_sha256 IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: Accounting Case preparation evidence cannot be linked';
  END IF;
END
$$;

-- A verified mutation resolves any formerly-active uncertainty receipt. This
-- is the only upgrade repair: it is derived from the linked mutation request,
-- and every other mismatch below fails the migration closed.
UPDATE accounting_case_operations operation_row
SET error_receipt = NULL
FROM xero_mutation_requests request_row
WHERE operation_row.mutation_request_id = request_row.mutation_request_id
  AND operation_row.state = 'READBACK_VERIFIED'
  AND request_row.state = 'READBACK_VERIFIED'
  AND operation_row.error_receipt IS NOT NULL;

-- Existing 027 rows do not pass through the new UPDATE trigger. Revalidate
-- every durable preparation and request now, before rewriting any terminal
-- summary, so an upgrade cannot bless swapped or caller-authored evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    JOIN accounting_cases case_row ON case_row.case_id = operation_row.case_id
    LEFT JOIN xero_mutation_preparations preparation_row
      ON preparation_row.preparation_id = operation_row.preparation_id
    WHERE operation_row.preparation_id IS NOT NULL
      AND (
        preparation_row.preparation_id IS NULL
        OR preparation_row.actor_id IS DISTINCT FROM case_row.actor_id
        OR preparation_row.workspace_id IS DISTINCT FROM case_row.workspace_id
        OR preparation_row.tenant_id IS DISTINCT FROM case_row.tenant_id
        OR preparation_row.oauth_installation_id IS DISTINCT FROM case_row.oauth_installation_id
        OR preparation_row.binding_id IS DISTINCT FROM case_row.binding_id
        OR preparation_row.binding_revision IS DISTINCT FROM case_row.binding_revision
        OR preparation_row.connection_id IS DISTINCT FROM case_row.connection_id
        OR preparation_row.target_session_id IS DISTINCT FROM case_row.target_session_id
        OR preparation_row.source_ref IS DISTINCT FROM ('case:' || operation_row.case_id)
        OR preparation_row.source_unit_key IS DISTINCT FROM operation_row.operation_id
        OR preparation_row.source_sha256 IS DISTINCT FROM operation_row.operation_source_sha256
        OR preparation_row.canonical_payload_hash
          IS DISTINCT FROM operation_row.preparation_canonical_payload_hash
        OR ROW(preparation_row.object_type, preparation_row.operation) IS DISTINCT FROM ROW(
          CASE operation_row.action_id
            WHEN 'contact.create_basic' THEN 'CONTACT'
            WHEN 'customer_invoice.create_draft' THEN 'SALES_INVOICE'
            WHEN 'supplier_bill.create_draft' THEN 'SUPPLIER_BILL'
            WHEN 'credit_note.create_draft' THEN 'CREDIT_NOTE'
            ELSE NULL
          END,
          CASE operation_row.action_id
            WHEN 'contact.create_basic' THEN 'CREATE'
            WHEN 'customer_invoice.create_draft' THEN 'CREATE_DRAFT'
            WHEN 'supplier_bill.create_draft' THEN 'CREATE_DRAFT'
            WHEN 'credit_note.create_draft' THEN 'CREATE_DRAFT'
            ELSE NULL
          END
        )
        OR (operation_row.state = 'PREPARED' AND (
          preparation_row.state <> 'PREPARED'
          OR preparation_row.expires_at <= operation_row.updated_at
        ))
      )
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: existing Accounting Case preparation linkage is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    JOIN accounting_cases case_row ON case_row.case_id = operation_row.case_id
    LEFT JOIN xero_mutation_preparations preparation_row
      ON preparation_row.preparation_id = operation_row.preparation_id
    LEFT JOIN xero_mutation_requests request_row
      ON request_row.mutation_request_id = operation_row.mutation_request_id
    WHERE operation_row.mutation_request_id IS NOT NULL
      AND (
        request_row.mutation_request_id IS NULL
        OR request_row.preparation_id IS DISTINCT FROM operation_row.preparation_id
        OR request_row.actor_id IS DISTINCT FROM case_row.actor_id
        OR request_row.workspace_id IS DISTINCT FROM case_row.workspace_id
        OR request_row.tenant_id IS DISTINCT FROM case_row.tenant_id
        OR request_row.oauth_installation_id IS DISTINCT FROM case_row.oauth_installation_id
        OR request_row.binding_id IS DISTINCT FROM case_row.binding_id
        OR request_row.binding_revision IS DISTINCT FROM case_row.binding_revision
        OR request_row.connection_id IS DISTINCT FROM case_row.connection_id
        OR request_row.target_session_id IS DISTINCT FROM case_row.target_session_id
        OR request_row.object_type IS DISTINCT FROM preparation_row.object_type
        OR request_row.operation IS DISTINCT FROM preparation_row.operation
        OR request_row.canonical_payload IS DISTINCT FROM preparation_row.canonical_payload
        OR request_row.canonical_payload_hash
          IS DISTINCT FROM operation_row.preparation_canonical_payload_hash
        OR request_row.source_ref IS DISTINCT FROM ('case:' || operation_row.case_id)
        OR request_row.source_unit_key IS DISTINCT FROM operation_row.operation_id
        OR request_row.source_sha256 IS DISTINCT FROM operation_row.operation_source_sha256
        OR operation_row.state IS DISTINCT FROM CASE request_row.state
          WHEN 'WRITE_IN_FLIGHT' THEN 'WRITE_IN_FLIGHT'
          WHEN 'WRITE_UNCERTAIN' THEN 'WRITE_UNCERTAIN'
          WHEN 'READBACK_VERIFIED' THEN 'READBACK_VERIFIED'
          WHEN 'READBACK_MISMATCH' THEN 'READBACK_MISMATCH'
          WHEN 'PROVIDER_REJECTED' THEN 'PROVIDER_REJECTED'
          WHEN 'FAILED_VALIDATION' THEN 'BLOCKED_VALIDATION'
          ELSE NULL
        END
        OR request_row.xero_object_id IS DISTINCT FROM operation_row.xero_object_id
        OR request_row.write_receipt IS DISTINCT FROM operation_row.write_receipt
        OR request_row.readback_snapshot IS DISTINCT FROM operation_row.readback_snapshot
        OR operation_row.error_receipt IS DISTINCT FROM CASE request_row.state
          WHEN 'WRITE_UNCERTAIN' THEN jsonb_build_object(
            'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
            'mutationRequestId', request_row.mutation_request_id,
            'mutationState', request_row.state
          )
          WHEN 'READBACK_MISMATCH' THEN jsonb_build_object(
            'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
            'mutationRequestId', request_row.mutation_request_id,
            'mutationState', request_row.state
          )
          WHEN 'PROVIDER_REJECTED' THEN request_row.provider_rejection_receipt
          WHEN 'FAILED_VALIDATION' THEN COALESCE(
            request_row.validation_receipt,
            jsonb_build_object(
              'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
              'mutationRequestId', request_row.mutation_request_id,
              'mutationState', request_row.state
            )
          )
          ELSE NULL
        END
      )
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: existing Accounting Case mutation projection is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_case_versions version_row
    WHERE version_row.preflight_request_id IS NOT NULL
      AND (
        jsonb_typeof(version_row.preflight_receipt -> 'operations') IS DISTINCT FROM 'array'
        OR jsonb_array_length(version_row.preflight_receipt -> 'operations') <> (
          SELECT count(*) FROM accounting_case_operations operation_row
          WHERE operation_row.case_id = version_row.case_id
            AND operation_row.case_version = version_row.version
        )
        OR EXISTS (
          SELECT 1
          FROM accounting_case_operations operation_row
          WHERE operation_row.case_id = version_row.case_id
            AND operation_row.case_version = version_row.version
            AND (
              SELECT count(*)
              FROM jsonb_array_elements(version_row.preflight_receipt -> 'operations') evidence
              WHERE evidence ->> 'operationId' = operation_row.operation_id
                AND evidence ->> 'actionId' = operation_row.action_id
                AND evidence ->> 'operationCanonicalPayloadHash' = operation_row.canonical_payload_hash
                AND (
                  (operation_row.preparation_id IS NOT NULL
                    AND evidence ->> 'state' = 'PREPARED'
                    AND evidence ->> 'preparationId' = operation_row.preparation_id
                    AND evidence ->> 'preparationCanonicalPayloadHash'
                      = operation_row.preparation_canonical_payload_hash
                    AND evidence ->> 'sourceSha256' = operation_row.operation_source_sha256)
                  OR (operation_row.preparation_id IS NULL
                    AND operation_row.state = 'NO_WRITE_REQUIRED'
                    AND evidence ->> 'state' = 'NO_WRITE_REQUIRED'
                    AND evidence ->> 'xeroObjectId' = operation_row.xero_object_id)
                )
            ) <> 1
        )
      )
  ) THEN
    RAISE EXCEPTION 'migration 029 blocked: existing Accounting Case preflight receipt linkage is invalid';
  END IF;
END
$$;

ALTER TABLE accounting_case_versions
  DROP CONSTRAINT IF EXISTS accounting_case_versions_state_check,
  DROP CONSTRAINT IF EXISTS accounting_case_version_lifecycle_shape_check,
  DROP CONSTRAINT IF EXISTS accounting_case_versions_last_execution_error_receipt_check;

ALTER TABLE accounting_case_versions
  ADD CONSTRAINT accounting_case_versions_state_check CHECK (state IN (
    'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
    'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS',
    'PREFLIGHTED', 'READY_TO_RESUME', 'EXECUTING', 'RECOVERY_REQUIRED',
    'PARTIALLY_COMMITTED', 'TERMINAL'
  )),
  ADD CONSTRAINT accounting_case_versions_last_execution_error_receipt_check CHECK (
    last_execution_error_receipt IS NULL OR (
      jsonb_typeof(last_execution_error_receipt) = 'object'
      AND last_execution_error_receipt <> '{}'::jsonb
    )
  ),
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
      OR (state IN ('RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL')
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND terminal_summary IS NOT NULL)
    )
  );

ALTER TABLE accounting_case_operations
  DROP CONSTRAINT IF EXISTS accounting_case_operations_state_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operation_lifecycle_shape_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operations_preparation_canonical_payload_hash_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operations_operation_source_sha256_check;

ALTER TABLE accounting_case_operations
  ADD CONSTRAINT accounting_case_operations_state_check CHECK (state IN (
    'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'NO_WRITE_REQUIRED',
    'READBACK_VERIFIED', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH',
    'PROVIDER_REJECTED', 'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
  )),
  ADD CONSTRAINT accounting_case_operations_preparation_canonical_payload_hash_check CHECK (
    preparation_canonical_payload_hash IS NULL OR preparation_canonical_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT accounting_case_operations_operation_source_sha256_check CHECK (
    operation_source_sha256 IS NULL OR operation_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT accounting_case_operation_lifecycle_shape_check CHECK (
    updated_at >= created_at
    AND (preparation_id IS NULL OR (preparation_id = btrim(preparation_id) AND preparation_id <> ''))
    AND (mutation_request_id IS NULL OR (
      mutation_request_id = btrim(mutation_request_id) AND mutation_request_id <> ''
    ))
    AND (xero_object_id IS NULL OR (xero_object_id = btrim(xero_object_id) AND xero_object_id <> ''))
    AND (
      (state = 'PENDING'
        AND preparation_id IS NULL AND preparation_canonical_payload_hash IS NULL
        AND operation_source_sha256 IS NULL AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NULL)
      OR (state = 'PREPARED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NULL)
      OR (state = 'WRITE_IN_FLIGHT'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND readback_snapshot IS NULL AND error_receipt IS NULL)
      OR (state = 'NO_WRITE_REQUIRED'
        AND mutation_request_id IS NULL AND write_receipt IS NULL
        AND xero_object_id IS NOT NULL AND readback_snapshot IS NOT NULL AND error_receipt IS NULL)
      OR (state = 'READBACK_VERIFIED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND readback_snapshot IS NOT NULL
        AND error_receipt IS NULL)
      OR (state = 'WRITE_UNCERTAIN'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND readback_snapshot IS NULL AND error_receipt IS NOT NULL)
      OR (state = 'READBACK_MISMATCH'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL
        AND readback_snapshot IS NOT NULL AND error_receipt IS NOT NULL)
      OR (state = 'PROVIDER_REJECTED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NULL AND write_receipt IS NULL
        AND readback_snapshot IS NULL AND error_receipt IS NOT NULL)
      OR (state = 'BLOCKED_VALIDATION'
        AND xero_object_id IS NULL AND write_receipt IS NULL
        AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (mutation_request_id IS NULL OR (
          preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
          AND operation_source_sha256 IS NOT NULL
        )))
      OR (state = 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
        AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (
          (preparation_id IS NULL AND preparation_canonical_payload_hash IS NULL AND operation_source_sha256 IS NULL)
          OR (preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
            AND operation_source_sha256 IS NOT NULL)
        ))
    )
  );

CREATE OR REPLACE FUNCTION accounting_case_terminal_state_projection(
  selected_case_id text,
  selected_version bigint,
  selected_state text
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'receiptType', 'ACCOUNTING_CASE_TERMINAL_STATE_PROJECTION',
    'receiptVersion', 1,
    'caseId', selected_case_id,
    'caseVersion', selected_version,
    'state', selected_state,
    'operationStates', COALESCE(jsonb_agg(jsonb_build_object(
      'operationId', operation_id, 'state', state,
      'mutationRequestId', mutation_request_id, 'xeroObjectId', xero_object_id
    ) ORDER BY ordinal), '[]'::jsonb),
    'completedOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')), '[]'::jsonb),
    'definiteFailureOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')), '[]'::jsonb),
    'uncertainOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')), '[]'::jsonb),
    'residualOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('PENDING', 'PREPARED', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE')), '[]'::jsonb)
  ) FROM accounting_case_operations
  WHERE case_id = selected_case_id AND case_version = selected_version;
$$;

UPDATE accounting_case_versions version_row
SET terminal_summary = accounting_case_terminal_state_projection(
  version_row.case_id, version_row.version, version_row.state
)
WHERE version_row.state IN ('RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL');

CREATE OR REPLACE FUNCTION accounting_case_head_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.case_id, NEW.provider_id, NEW.actor_id, NEW.workspace_id, NEW.subject_type,
    NEW.subject_id, NEW.agent_id, NEW.oauth_installation_id, NEW.binding_id,
    NEW.binding_revision, NEW.connection_id, NEW.tenant_id, NEW.target_session_id,
    NEW.target_session_hash, NEW.target_session_expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.case_id, OLD.provider_id, OLD.actor_id, OLD.workspace_id, OLD.subject_type,
    OLD.subject_id, OLD.agent_id, OLD.oauth_installation_id, OLD.binding_id,
    OLD.binding_revision, OLD.connection_id, OLD.tenant_id, OLD.target_session_id,
    OLD.target_session_hash, OLD.target_session_expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Accounting Case binding identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_version <> OLD.current_version
    AND NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'Accounting Case current version must advance exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_version <> OLD.current_version AND EXISTS (
    SELECT 1 FROM accounting_case_versions current_row
    WHERE current_row.case_id = OLD.case_id
      AND current_row.version = OLD.current_version
      AND current_row.state IN ('PREFLIGHTED', 'READY_TO_RESUME', 'EXECUTING', 'RECOVERY_REQUIRED')
  ) THEN
    RAISE EXCEPTION 'Accounting Case cannot advance after preflight or while execution/recovery is active'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
      'READY_TO_RESUME', 'RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL'
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

CREATE OR REPLACE FUNCTION accounting_case_operation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_row accounting_cases%ROWTYPE;
  preparation_row xero_mutation_preparations%ROWTYPE;
  request_row xero_mutation_requests%ROWTYPE;
  expected_operation_state text;
  expected_error_receipt jsonb;
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
  IF OLD.error_receipt IS NOT NULL AND NEW.error_receipt IS DISTINCT FROM OLD.error_receipt
    AND NOT (OLD.state IN ('WRITE_UNCERTAIN', 'READBACK_MISMATCH') AND NEW.state = 'READBACK_VERIFIED') THEN
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
        USING ERRCODE = '23514';
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

CREATE TRIGGER accounting_case_version_lifecycle
BEFORE UPDATE ON accounting_case_versions
FOR EACH ROW EXECUTE FUNCTION accounting_case_version_guard();

CREATE TRIGGER accounting_case_operation_lifecycle
BEFORE UPDATE ON accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_operation_guard();
