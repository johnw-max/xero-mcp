SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Durable Accounting Cases are the only long-lived source of executable
-- accounting operations. The opaque target capability remains in
-- ledger_target_sessions; this table stores only its server-side HMAC and ID.
ALTER TABLE agent_connection_bindings
  ADD CONSTRAINT accounting_case_binding_identity_unique UNIQUE (
    binding_id, oauth_installation_id, connection_id,
    workspace_id, subject_type, subject_id, agent_id
  );

ALTER TABLE provider_connections
  ADD CONSTRAINT accounting_case_connection_tenant_unique UNIQUE (connection_id, tenant_id);

ALTER TABLE ledger_target_sessions
  ADD CONSTRAINT accounting_case_target_tuple_unique UNIQUE (
    session_hash, session_id, oauth_installation_id, binding_id,
    connection_id, binding_revision, expires_at
  );

CREATE TABLE accounting_cases (
  case_id text PRIMARY KEY CHECK (
    case_id = btrim(case_id) AND case_id <> '' AND length(case_id) <= 128
    AND case_id ~ '^[A-Za-z0-9._:/-]+$'
  ),
  provider_id text NOT NULL CHECK (provider_id = 'xero'),
  actor_id text NOT NULL CHECK (actor_id = btrim(actor_id) AND actor_id <> ''),
  workspace_id text NOT NULL CHECK (workspace_id = btrim(workspace_id) AND workspace_id <> ''),
  subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM')),
  subject_id text NOT NULL CHECK (subject_id = btrim(subject_id) AND subject_id <> ''),
  agent_id text NOT NULL CHECK (agent_id = btrim(agent_id) AND agent_id <> ''),
  oauth_installation_id text NOT NULL CHECK (
    oauth_installation_id = btrim(oauth_installation_id) AND oauth_installation_id <> ''
  ),
  binding_id text NOT NULL CHECK (binding_id = btrim(binding_id) AND binding_id <> ''),
  binding_revision bigint NOT NULL CHECK (binding_revision > 0),
  connection_id text NOT NULL CHECK (connection_id = btrim(connection_id) AND connection_id <> ''),
  tenant_id text NOT NULL CHECK (tenant_id = btrim(tenant_id) AND tenant_id <> ''),
  target_session_id text NOT NULL CHECK (
    target_session_id = btrim(target_session_id) AND target_session_id <> ''
  ),
  target_session_hash text NOT NULL CHECK (target_session_hash ~ '^[0-9a-f]{64}$'),
  target_session_expires_at timestamptz NOT NULL,
  current_version bigint NOT NULL CHECK (current_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT accounting_cases_actor_identity_check CHECK (
    actor_id = workspace_id || ':' || lower(subject_type) || ':' || subject_id
  ),
  CONSTRAINT accounting_cases_time_check CHECK (
    target_session_expires_at > created_at AND updated_at >= created_at
  ),
  CONSTRAINT accounting_cases_binding_fk FOREIGN KEY (
    binding_id, oauth_installation_id, connection_id,
    workspace_id, subject_type, subject_id, agent_id
  ) REFERENCES agent_connection_bindings (
    binding_id, oauth_installation_id, connection_id,
    workspace_id, subject_type, subject_id, agent_id
  ) ON DELETE RESTRICT,
  CONSTRAINT accounting_cases_connection_tenant_fk FOREIGN KEY (connection_id, tenant_id)
    REFERENCES provider_connections(connection_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT accounting_cases_target_fk FOREIGN KEY (
    target_session_hash, target_session_id, oauth_installation_id, binding_id,
    connection_id, binding_revision, target_session_expires_at
  ) REFERENCES ledger_target_sessions (
    session_hash, session_id, oauth_installation_id, binding_id,
    connection_id, binding_revision, expires_at
  ) ON DELETE RESTRICT
);

CREATE INDEX accounting_cases_exact_binding_idx ON accounting_cases (
  workspace_id, subject_type, subject_id, agent_id, oauth_installation_id,
  binding_id, binding_revision, connection_id, tenant_id, target_session_id
);

CREATE TABLE accounting_case_versions (
  case_id text NOT NULL REFERENCES accounting_cases(case_id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  compiled_case jsonb NOT NULL CHECK (jsonb_typeof(compiled_case) = 'object'),
  compiled_plan_hash text NOT NULL CHECK (compiled_plan_hash ~ '^[0-9a-f]{64}$'),
  source_revision_hash text NOT NULL CHECK (source_revision_hash ~ '^[0-9a-f]{64}$'),
  initial_state text NOT NULL CHECK (initial_state IN (
    'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
    'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS'
  )),
  state text NOT NULL CHECK (state IN (
    'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
    'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS',
    'PREFLIGHTED', 'READY_TO_RESUME', 'EXECUTING', 'RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL'
  )),
  preflight_request_id text CHECK (
    preflight_request_id IS NULL OR (
      preflight_request_id = btrim(preflight_request_id)
      AND preflight_request_id <> '' AND length(preflight_request_id) <= 128
      AND preflight_request_id ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  preflight_receipt jsonb CHECK (
    preflight_receipt IS NULL OR (
      jsonb_typeof(preflight_receipt) = 'object' AND preflight_receipt <> '{}'::jsonb
    )
  ),
  preflight_receipt_hash text CHECK (
    preflight_receipt_hash IS NULL OR preflight_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  preflighted_at timestamptz,
  execution_request_id text CHECK (
    execution_request_id IS NULL OR (
      execution_request_id = btrim(execution_request_id)
      AND execution_request_id <> '' AND length(execution_request_id) <= 128
      AND execution_request_id ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  execution_started_at timestamptz,
  last_execution_error_receipt jsonb CHECK (
    last_execution_error_receipt IS NULL OR (
      jsonb_typeof(last_execution_error_receipt) = 'object'
      AND last_execution_error_receipt <> '{}'::jsonb
    )
  ),
  terminal_summary jsonb CHECK (
    terminal_summary IS NULL OR (
      jsonb_typeof(terminal_summary) = 'object' AND terminal_summary <> '{}'::jsonb
    )
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, version),
  CONSTRAINT accounting_case_version_compiled_identity_check CHECK (
    compiled_case ->> 'caseId' = case_id
    AND compiled_case ->> 'providerId' = 'xero'
    AND compiled_case ->> 'sourceRevisionHash' = source_revision_hash
    AND compiled_case ->> 'status' = initial_state
    AND CASE
      WHEN compiled_case ->> 'version' ~ '^[1-9][0-9]*$'
      THEN (compiled_case ->> 'version')::numeric = version
      ELSE false
    END
  ),
  CONSTRAINT accounting_case_version_lifecycle_shape_check CHECK (
    updated_at >= created_at
    AND (
      (state IN (
        'BLOCKED_COVERAGE', 'BLOCKED_VALIDATION',
        'PLANNED_NEEDS_PREFLIGHT', 'PLANNED_WITH_EXCEPTIONS'
      ) AND preflight_request_id IS NULL AND preflight_receipt IS NULL
        AND preflight_receipt_hash IS NULL AND preflighted_at IS NULL
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NULL AND terminal_summary IS NULL)
      OR
      (state = 'PREFLIGHTED'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND preflighted_at >= created_at
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NULL AND terminal_summary IS NULL)
      OR
      (state = 'READY_TO_RESUME'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NULL AND execution_started_at IS NULL
        AND last_execution_error_receipt IS NOT NULL AND terminal_summary IS NULL)
      OR
      (state = 'EXECUTING'
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND preflighted_at >= created_at
        AND execution_started_at >= created_at AND terminal_summary IS NULL)
      OR
      (state IN ('RECOVERY_REQUIRED', 'PARTIALLY_COMMITTED', 'TERMINAL')
        AND preflight_request_id IS NOT NULL AND preflight_receipt IS NOT NULL
        AND preflight_receipt_hash IS NOT NULL AND preflighted_at IS NOT NULL
        AND execution_request_id IS NOT NULL AND execution_started_at IS NOT NULL
        AND (execution_request_id = preflight_request_id OR last_execution_error_receipt IS NOT NULL)
        AND preflighted_at >= created_at
        AND execution_started_at >= created_at AND terminal_summary IS NOT NULL)
    )
  )
);

CREATE TABLE accounting_case_operations (
  case_id text NOT NULL,
  case_version bigint NOT NULL,
  operation_id text NOT NULL CHECK (
    operation_id = btrim(operation_id) AND operation_id <> '' AND length(operation_id) <= 128
  ),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  event_id text NOT NULL CHECK (event_id = btrim(event_id) AND event_id <> ''),
  action_id text NOT NULL CHECK (action_id IN (
    'contact.create_basic', 'customer_invoice.create_draft',
    'supplier_bill.create_draft', 'credit_note.create_draft'
  )),
  native_route text NOT NULL CHECK (native_route IN (
    'CONTACT_CREATE', 'SALES_INVOICE', 'SUPPLIER_BILL',
    'CUSTOMER_CREDIT', 'SUPPLIER_CREDIT'
  )),
  dependency_event_keys text[] NOT NULL DEFAULT '{}',
  operation_json jsonb NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload) = 'object'),
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  source_revision_hash text NOT NULL CHECK (source_revision_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN (
    'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'NO_WRITE_REQUIRED',
    'READBACK_VERIFIED', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH',
    'PROVIDER_REJECTED', 'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
  )),
  preparation_id text,
  preparation_canonical_payload_hash text CHECK (
    preparation_canonical_payload_hash IS NULL OR preparation_canonical_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  operation_source_sha256 text CHECK (
    operation_source_sha256 IS NULL OR operation_source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  mutation_request_id text,
  xero_object_id text,
  write_receipt jsonb CHECK (
    write_receipt IS NULL OR (jsonb_typeof(write_receipt) = 'object' AND write_receipt <> '{}'::jsonb)
  ),
  readback_snapshot jsonb CHECK (
    readback_snapshot IS NULL OR (jsonb_typeof(readback_snapshot) = 'object' AND readback_snapshot <> '{}'::jsonb)
  ),
  error_receipt jsonb CHECK (
    error_receipt IS NULL OR (jsonb_typeof(error_receipt) = 'object' AND error_receipt <> '{}'::jsonb)
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, case_version, operation_id),
  UNIQUE (case_id, case_version, ordinal),
  CONSTRAINT accounting_case_operation_version_fk FOREIGN KEY (case_id, case_version)
    REFERENCES accounting_case_versions(case_id, version) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_operation_json_identity_check CHECK (
    operation_json ->> 'caseId' = case_id
    AND operation_json ->> 'operationId' = operation_id
    AND operation_json ->> 'eventId' = event_id
    AND operation_json ->> 'actionId' = action_id
    AND operation_json ->> 'nativeRoute' = native_route
    AND operation_json ->> 'canonicalPayloadHash' = canonical_payload_hash
    AND operation_json ->> 'sourceRevisionHash' = source_revision_hash
    AND operation_json -> 'canonicalPayload' = canonical_payload
    AND operation_json -> 'dependencyEventKeys' = to_jsonb(dependency_event_keys)
    AND CASE
      WHEN operation_json ->> 'caseVersion' ~ '^[1-9][0-9]*$'
      THEN (operation_json ->> 'caseVersion')::numeric = case_version
      ELSE false
    END
  ),
  CONSTRAINT accounting_case_operation_lifecycle_shape_check CHECK (
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
      OR
      (state = 'PREPARED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NULL)
      OR
      (state = 'WRITE_IN_FLIGHT'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND readback_snapshot IS NULL AND error_receipt IS NULL)
      OR
      (state = 'NO_WRITE_REQUIRED'
        AND mutation_request_id IS NULL AND write_receipt IS NULL
        AND xero_object_id IS NOT NULL AND readback_snapshot IS NOT NULL AND error_receipt IS NULL)
      OR
      (state = 'READBACK_VERIFIED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND readback_snapshot IS NOT NULL
        AND error_receipt IS NULL)
      OR
      (state = 'WRITE_UNCERTAIN'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND readback_snapshot IS NULL AND error_receipt IS NOT NULL)
      OR
      (state = 'READBACK_MISMATCH'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL
        AND readback_snapshot IS NOT NULL AND error_receipt IS NOT NULL)
      OR
      (state = 'PROVIDER_REJECTED'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NOT NULL
        AND xero_object_id IS NULL AND write_receipt IS NULL
        AND readback_snapshot IS NULL AND error_receipt IS NOT NULL)
      OR
      (state = 'BLOCKED_VALIDATION'
        AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (
          mutation_request_id IS NULL
          OR (preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
            AND operation_source_sha256 IS NOT NULL)
        ))
      OR
      (state = 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
        AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (
          (preparation_id IS NULL AND preparation_canonical_payload_hash IS NULL AND operation_source_sha256 IS NULL)
          OR (preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
            AND operation_source_sha256 IS NOT NULL)
        ))
    )
  )
);

CREATE UNIQUE INDEX accounting_case_operations_preparation_uq
  ON accounting_case_operations(preparation_id) WHERE preparation_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_case_operations_mutation_request_uq
  ON accounting_case_operations(mutation_request_id) WHERE mutation_request_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_case_operations_xero_object_uq
  ON accounting_case_operations(case_id, case_version, action_id, xero_object_id)
  WHERE xero_object_id IS NOT NULL;

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

CREATE TRIGGER accounting_case_head_immutable
BEFORE UPDATE ON accounting_cases
FOR EACH ROW EXECUTE FUNCTION accounting_case_head_immutable_guard();

CREATE OR REPLACE FUNCTION accounting_case_current_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM accounting_case_versions version_row
    WHERE version_row.case_id = NEW.case_id
      AND version_row.version = NEW.current_version
  ) THEN
    RAISE EXCEPTION 'Accounting Case head points to a missing version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounting_case_current_version_exists
AFTER INSERT OR UPDATE OF current_version ON accounting_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting_case_current_version_guard();

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
      'operationId', operation_id,
      'state', state,
      'mutationRequestId', mutation_request_id,
      'xeroObjectId', xero_object_id
    ) ORDER BY ordinal), '[]'::jsonb),
    'completedOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')), '[]'::jsonb),
    'definiteFailureOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')), '[]'::jsonb),
    'uncertainOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')), '[]'::jsonb),
    'residualOperationIds', COALESCE(jsonb_agg(operation_id ORDER BY ordinal)
      FILTER (WHERE state IN ('PENDING', 'PREPARED', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE')), '[]'::jsonb)
  )
  FROM accounting_case_operations
  WHERE case_id = selected_case_id AND case_version = selected_version;
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
  IF OLD.preflight_request_id IS NOT NULL
    AND ROW(
      NEW.preflight_request_id, NEW.preflight_receipt,
      NEW.preflight_receipt_hash, NEW.preflighted_at
    ) IS DISTINCT FROM ROW(
      OLD.preflight_request_id, OLD.preflight_receipt,
      OLD.preflight_receipt_hash, OLD.preflighted_at
    ) THEN
    RAISE EXCEPTION 'Accounting Case preflight receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'PREFLIGHTED' AND NEW.state = 'PREFLIGHTED' AND (
    EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state NOT IN ('PREPARED', 'NO_WRITE_REQUIRED')
    )
    OR EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND (
          (operation_row.state = 'PREPARED' AND (
            operation_row.preparation_id IS NULL
            OR operation_row.preparation_canonical_payload_hash IS NULL
            OR operation_row.operation_source_sha256 IS NULL
          ))
          OR
          (operation_row.state = 'NO_WRITE_REQUIRED' AND (
            operation_row.xero_object_id IS NULL OR operation_row.readback_snapshot IS NULL
          ))
        )
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
    AND NEW.state = OLD.state
    AND NEW.terminal_summary IS DISTINCT FROM OLD.terminal_summary THEN
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
        AND operation_row.case_version = NEW.version
        AND operation_row.state = 'PREPARED'
    )
    OR EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
    )
  ) THEN
    RAISE EXCEPTION 'Accounting Case ready-to-resume requires prepared residual work and no recovery evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('PARTIALLY_COMMITTED', 'TERMINAL') AND EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = NEW.case_id
      AND operation_row.case_version = NEW.version
      AND operation_row.state IN (
        'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
      )
  ) THEN
    RAISE EXCEPTION 'Accounting Case cannot terminate with unfinished operations' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'PARTIALLY_COMMITTED' AND (
    NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    )
    OR NOT EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
    )
  ) THEN
    RAISE EXCEPTION 'Partially committed Accounting Case requires completed and definitely failed operations'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'TERMINAL'
    AND EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
    )
    AND EXISTS (
      SELECT 1 FROM accounting_case_operations operation_row
      WHERE operation_row.case_id = NEW.case_id
        AND operation_row.case_version = NEW.version
        AND operation_row.state IN ('PROVIDER_REJECTED', 'BLOCKED_VALIDATION')
    ) THEN
    RAISE EXCEPTION 'Mixed completed and failed Accounting Case must be partially committed'
      USING ERRCODE = '23514';
  END IF;
  -- Require concrete uncertain/mismatch evidence when entering recovery. Once
  -- the last operation is repaired, the Case remains recovery-owned only for
  -- the short CAS interval before finalizeAccountingCase seals TERMINAL.
  IF OLD.state <> 'RECOVERY_REQUIRED' AND NEW.state = 'RECOVERY_REQUIRED' AND NOT EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = NEW.case_id
      AND operation_row.case_version = NEW.version
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

CREATE OR REPLACE FUNCTION accounting_case_operation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_row accounting_cases%ROWTYPE;
  preparation_row xero_mutation_preparations%ROWTYPE;
  request_row xero_mutation_requests%ROWTYPE;
  expected_operation_state text;
  expected_error_receipt jsonb;
BEGIN
  IF (SELECT version_row.state FROM accounting_case_versions version_row
      WHERE version_row.case_id = OLD.case_id AND version_row.version = OLD.case_version) = 'PREFLIGHTED'
    AND ROW(
      NEW.state, NEW.preparation_id, NEW.mutation_request_id, NEW.xero_object_id,
      NEW.preparation_canonical_payload_hash, NEW.operation_source_sha256,
      NEW.write_receipt, NEW.readback_snapshot, NEW.error_receipt, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.preparation_id, OLD.mutation_request_id, OLD.xero_object_id,
      OLD.preparation_canonical_payload_hash, OLD.operation_source_sha256,
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
  IF OLD.readback_snapshot IS NOT NULL
    AND NEW.readback_snapshot IS DISTINCT FROM OLD.readback_snapshot
    AND NOT (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED') THEN
    RAISE EXCEPTION 'Accounting Case operation readback evidence cannot be replaced'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'PENDING' AND NEW.state IN (
      'PREPARED', 'NO_WRITE_REQUIRED', 'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
    ))
    -- The provider mutation kernel owns its own WRITE_IN_FLIGHT CAS. Once it
    -- returns complete provider and exact-readback evidence, the enclosing
    -- Case operation may durably collapse PREPARED -> READBACK_VERIFIED.
    OR (OLD.state = 'PREPARED' AND NEW.state IN (
      'WRITE_IN_FLIGHT', 'NO_WRITE_REQUIRED', 'READBACK_VERIFIED',
      'WRITE_UNCERTAIN', 'READBACK_MISMATCH', 'PROVIDER_REJECTED', 'BLOCKED_VALIDATION',
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
    SELECT * INTO preparation_row
    FROM xero_mutation_preparations
    WHERE preparation_id = NEW.preparation_id;
    IF NOT FOUND
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
      OR (NEW.state = 'PREPARED' AND (
        preparation_row.state <> 'PREPARED' OR preparation_row.expires_at <= NEW.updated_at
      ))
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
    SELECT * INTO request_row
    FROM xero_mutation_requests
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
        'mutationRequestId', request_row.mutation_request_id,
        'mutationState', request_row.state
      )
      WHEN 'READBACK_MISMATCH' THEN jsonb_build_object(
        'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
        'mutationRequestId', request_row.mutation_request_id,
        'mutationState', request_row.state
      )
      WHEN 'PROVIDER_REJECTED' THEN request_row.provider_rejection_receipt
      WHEN 'FAILED_VALIDATION' THEN COALESCE(request_row.validation_receipt, jsonb_build_object(
        'receiptType', 'XERO_MUTATION_STATE_PROJECTION',
        'mutationRequestId', request_row.mutation_request_id,
        'mutationState', request_row.state
      ))
      ELSE NULL
    END;
    IF NOT FOUND OR expected_operation_state IS NULL OR NEW.state <> expected_operation_state
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
  )
    AND ROW(
      NEW.state, NEW.preparation_id, NEW.mutation_request_id, NEW.xero_object_id,
      NEW.preparation_canonical_payload_hash, NEW.operation_source_sha256,
      NEW.write_receipt, NEW.readback_snapshot, NEW.error_receipt, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.preparation_id, OLD.mutation_request_id, OLD.xero_object_id,
      OLD.preparation_canonical_payload_hash, OLD.operation_source_sha256,
      OLD.write_receipt, OLD.readback_snapshot, OLD.error_receipt, OLD.updated_at
    ) THEN
    RAISE EXCEPTION 'Accounting Case terminal operation evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_case_operation_lifecycle
BEFORE UPDATE ON accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_operation_guard();
