-- An expired target cannot resume its immutable Case binding. After every
-- potentially-written operation is reconciled by exact GET, close zero-write
-- residual preparations and reserve their business intent for one target-bound
-- successor Case that must compile and preflight from public facts again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE accounting_case_operations
  DROP CONSTRAINT IF EXISTS accounting_case_operations_state_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operation_lifecycle_shape_check;

ALTER TABLE accounting_case_operations
  ADD CONSTRAINT accounting_case_operations_state_check CHECK (state IN (
    'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'NO_WRITE_REQUIRED',
    'READBACK_VERIFIED', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH',
    'PROVIDER_REJECTED', 'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE',
    'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
  )),
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
        AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (
          mutation_request_id IS NULL
          OR (preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
            AND operation_source_sha256 IS NOT NULL)
        ))
      OR (state = 'NOT_EXECUTED_AFTER_PRIOR_FAILURE'
        AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL
        AND (
          (preparation_id IS NULL AND preparation_canonical_payload_hash IS NULL AND operation_source_sha256 IS NULL)
          OR (preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
            AND operation_source_sha256 IS NOT NULL)
        ))
      OR (state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
        AND preparation_id IS NOT NULL AND preparation_canonical_payload_hash IS NOT NULL
        AND operation_source_sha256 IS NOT NULL AND mutation_request_id IS NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL AND error_receipt IS NOT NULL)
    )
  );

CREATE TABLE accounting_case_recovery_residual_grants (
  grant_id text PRIMARY KEY CHECK (grant_id ~ '^acrg_[0-9a-f]{64}$'),
  source_case_id text NOT NULL,
  source_case_version bigint NOT NULL CHECK (source_case_version > 0),
  source_plan_hash text NOT NULL CHECK (source_plan_hash ~ '^[0-9a-f]{64}$'),
  issued_request_id text NOT NULL CHECK (
    issued_request_id = btrim(issued_request_id) AND issued_request_id <> ''
    AND length(issued_request_id) <= 128 AND issued_request_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  successor_case_id text NOT NULL UNIQUE CHECK (
    successor_case_id ~ '^recovery-[0-9a-f]{64}$'
  ),
  residual_operation_ids text[] NOT NULL CHECK (
    cardinality(residual_operation_ids) > 0 AND array_position(residual_operation_ids, NULL) IS NULL
  ),
  continuation_template jsonb NOT NULL CHECK (
    jsonb_typeof(continuation_template) = 'object'
    AND continuation_template ->> 'case_id' = successor_case_id
    AND continuation_template ->> 'expected_version' = '0'
    AND continuation_template -> 'source_set_complete' = 'true'::jsonb
    AND jsonb_typeof(continuation_template -> 'source_label') = 'string'
    AND btrim(continuation_template ->> 'source_label') <> ''
    AND jsonb_typeof(continuation_template -> 'documents') = 'array'
    AND (
      NOT (continuation_template ? 'new_contacts')
      OR jsonb_typeof(continuation_template -> 'new_contacts') = 'array'
    )
    AND jsonb_array_length(continuation_template -> 'documents')
      + COALESCE(jsonb_array_length(continuation_template -> 'new_contacts'), 0) > 0
  ),
  template_hash text NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
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
  state text NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED')),
  consumed_plan_hash text CHECK (
    consumed_plan_hash IS NULL OR consumed_plan_hash ~ '^[0-9a-f]{64}$'
  ),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (source_case_id, source_case_version),
  CONSTRAINT accounting_case_recovery_residual_grant_actor_check CHECK (
    actor_id = workspace_id || ':' || lower(subject_type) || ':' || subject_id
  ),
  CONSTRAINT accounting_case_recovery_residual_grant_state_shape_check CHECK (
    updated_at >= created_at AND target_session_expires_at > created_at
    AND (
      (state = 'ISSUED' AND consumed_plan_hash IS NULL AND consumed_at IS NULL)
      OR (state = 'CONSUMED' AND consumed_plan_hash IS NOT NULL
        AND consumed_at IS NOT NULL AND consumed_at >= created_at AND updated_at >= consumed_at)
    )
  ),
  CONSTRAINT accounting_case_recovery_residual_grant_source_fk
    FOREIGN KEY (source_case_id, source_case_version)
    REFERENCES accounting_case_versions(case_id, version) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_recovery_residual_grant_binding_fk FOREIGN KEY (
    binding_id, oauth_installation_id, connection_id,
    workspace_id, subject_type, subject_id, agent_id
  ) REFERENCES agent_connection_bindings (
    binding_id, oauth_installation_id, connection_id,
    workspace_id, subject_type, subject_id, agent_id
  ) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_recovery_residual_grant_connection_tenant_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES provider_connections(connection_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_recovery_residual_grant_target_fk FOREIGN KEY (
    target_session_hash, target_session_id, oauth_installation_id, binding_id,
    connection_id, binding_revision, target_session_expires_at
  ) REFERENCES ledger_target_sessions (
    session_hash, session_id, oauth_installation_id, binding_id,
    connection_id, binding_revision, expires_at
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION accounting_case_recovery_residual_grant_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_head accounting_cases%ROWTYPE;
  source_version accounting_case_versions%ROWTYPE;
  successor_head accounting_cases%ROWTYPE;
  successor_version accounting_case_versions%ROWTYPE;
  expected_residual_ids text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ISSUED' OR NEW.consumed_plan_hash IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Recovery residual grant must start issued and unconsumed' USING ERRCODE = '23514';
    END IF;
    -- Match the repository-wide lock order used by execution projection and
    -- recovery adoption: Case head -> version -> operations -> preparations
    -- -> mutation requests. Direct SQL cannot invert the first two locks and
    -- deadlock the normal completion transaction.
    SELECT * INTO source_head FROM accounting_cases
    WHERE case_id = NEW.source_case_id FOR UPDATE;
    SELECT * INTO source_version
    FROM accounting_case_versions
    WHERE case_id = NEW.source_case_id AND version = NEW.source_case_version
    FOR UPDATE;
    PERFORM 1 FROM accounting_case_operations
    WHERE case_id = NEW.source_case_id AND case_version = NEW.source_case_version
    ORDER BY ordinal FOR UPDATE;
    PERFORM preparation.preparation_id
    FROM xero_mutation_preparations preparation
    JOIN accounting_case_operations operation_row
      ON operation_row.preparation_id = preparation.preparation_id
    WHERE operation_row.case_id = NEW.source_case_id
      AND operation_row.case_version = NEW.source_case_version
      AND operation_row.state = 'PREPARED'
    ORDER BY preparation.preparation_id FOR UPDATE OF preparation;
    PERFORM mutation_record.mutation_request_id
    FROM xero_mutation_requests mutation_record
    JOIN accounting_case_operations operation_row
      ON operation_row.preparation_id = mutation_record.preparation_id
    WHERE operation_row.case_id = NEW.source_case_id
      AND operation_row.case_version = NEW.source_case_version
    ORDER BY mutation_record.mutation_request_id FOR UPDATE OF mutation_record;

    SELECT array_agg(operation_id ORDER BY ordinal)
    INTO expected_residual_ids
    FROM accounting_case_operations
    WHERE case_id = NEW.source_case_id AND case_version = NEW.source_case_version
      AND state = 'PREPARED';

    IF source_version.case_id IS NULL OR source_head.case_id IS NULL
      OR source_version.state <> 'RECOVERY_REQUIRED'
      OR source_version.execution_request_id IS DISTINCT FROM NEW.issued_request_id
      OR source_version.compiled_plan_hash <> NEW.source_plan_hash
      OR source_head.current_version <> NEW.source_case_version
      OR source_head.actor_id <> NEW.actor_id
      OR source_head.workspace_id <> NEW.workspace_id
      OR source_head.subject_type <> NEW.subject_type
      OR source_head.subject_id <> NEW.subject_id
      OR source_head.agent_id <> NEW.agent_id
      OR source_head.oauth_installation_id <> NEW.oauth_installation_id
      OR source_head.binding_id <> NEW.binding_id
      OR source_head.binding_revision <> NEW.binding_revision
      OR source_head.connection_id <> NEW.connection_id
      OR source_head.tenant_id <> NEW.tenant_id
      OR source_head.target_session_hash = NEW.target_session_hash
      OR source_head.target_session_expires_at > statement_timestamp()
      OR expected_residual_ids IS DISTINCT FROM NEW.residual_operation_ids
      OR cardinality(NEW.residual_operation_ids) <> (
        SELECT count(DISTINCT operation_id)
        FROM unnest(NEW.residual_operation_ids) operation_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM accounting_case_operations
        WHERE case_id = NEW.source_case_id AND case_version = NEW.source_case_version
          AND state = 'READBACK_VERIFIED'
      )
      OR EXISTS (
        SELECT 1 FROM accounting_case_operations operation_row
        WHERE operation_row.case_id = NEW.source_case_id
          AND operation_row.case_version = NEW.source_case_version
          AND operation_row.state NOT IN ('PREPARED', 'READBACK_VERIFIED', 'NO_WRITE_REQUIRED')
      )
      OR EXISTS (
        SELECT 1
        FROM accounting_case_operations operation_row
        LEFT JOIN xero_mutation_preparations preparation
          ON preparation.preparation_id = operation_row.preparation_id
        WHERE operation_row.case_id = NEW.source_case_id
          AND operation_row.case_version = NEW.source_case_version
          AND operation_row.state = 'PREPARED'
          AND (
            preparation.preparation_id IS NULL
            OR preparation.state NOT IN ('PREPARED', 'EXPIRED')
            OR operation_row.mutation_request_id IS NOT NULL
            OR EXISTS (
          SELECT 1 FROM xero_mutation_requests mutation_record
          WHERE mutation_record.preparation_id = operation_row.preparation_id
            )
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM ledger_target_sessions target_session
        JOIN agent_connection_bindings successor_binding
          ON successor_binding.binding_id = target_session.binding_id
         AND successor_binding.oauth_installation_id = target_session.oauth_installation_id
         AND successor_binding.connection_id = target_session.connection_id
        JOIN oauth_installations successor_installation
          ON successor_installation.installation_id = successor_binding.oauth_installation_id
         AND successor_installation.workspace_id = successor_binding.workspace_id
         AND successor_installation.subject_type = successor_binding.subject_type
         AND successor_installation.subject_id = successor_binding.subject_id
         AND successor_installation.agent_id = successor_binding.agent_id
        JOIN oauth_installation_active_bindings active_binding
          ON active_binding.oauth_installation_id = target_session.oauth_installation_id
         AND active_binding.binding_id = target_session.binding_id
         AND active_binding.connection_id = target_session.connection_id
         AND active_binding.binding_revision = target_session.binding_revision
        JOIN provider_connections successor_connection
          ON successor_connection.connection_id = target_session.connection_id
        WHERE target_session.session_hash = NEW.target_session_hash
          AND target_session.session_id = NEW.target_session_id
          AND target_session.oauth_installation_id = NEW.oauth_installation_id
          AND target_session.binding_id = NEW.binding_id
          AND target_session.connection_id = NEW.connection_id
          AND target_session.binding_revision = NEW.binding_revision
          AND target_session.expires_at = NEW.target_session_expires_at
          AND target_session.revoked_at IS NULL
          AND target_session.expires_at > statement_timestamp()
          AND successor_binding.workspace_id = NEW.workspace_id
          AND successor_binding.subject_type = NEW.subject_type
          AND successor_binding.subject_id = NEW.subject_id
          AND successor_binding.agent_id = NEW.agent_id
          AND successor_binding.binding_status = 'ACTIVE'
          AND successor_installation.installation_status = 'ACTIVE'
          AND successor_connection.connection_status = 'ACTIVE'
          AND successor_connection.tenant_id = NEW.tenant_id
      )
    THEN
      RAISE EXCEPTION 'Recovery residual grant does not match an expired recovered Case and live successor target'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.grant_id, NEW.source_case_id, NEW.source_case_version, NEW.source_plan_hash,
    NEW.issued_request_id, NEW.successor_case_id, NEW.residual_operation_ids,
    NEW.continuation_template, NEW.template_hash, NEW.actor_id, NEW.workspace_id,
    NEW.subject_type, NEW.subject_id, NEW.agent_id, NEW.oauth_installation_id,
    NEW.binding_id, NEW.binding_revision, NEW.connection_id, NEW.tenant_id,
    NEW.target_session_id, NEW.target_session_hash, NEW.target_session_expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.grant_id, OLD.source_case_id, OLD.source_case_version, OLD.source_plan_hash,
    OLD.issued_request_id, OLD.successor_case_id, OLD.residual_operation_ids,
    OLD.continuation_template, OLD.template_hash, OLD.actor_id, OLD.workspace_id,
    OLD.subject_type, OLD.subject_id, OLD.agent_id, OLD.oauth_installation_id,
    OLD.binding_id, OLD.binding_revision, OLD.connection_id, OLD.tenant_id,
    OLD.target_session_id, OLD.target_session_hash, OLD.target_session_expires_at, OLD.created_at
  ) OR OLD.state <> 'ISSUED' OR NEW.state <> 'CONSUMED'
    OR OLD.consumed_plan_hash IS NOT NULL OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_plan_hash IS NULL OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'Recovery residual grant is append-only and one-time consumable'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO successor_head FROM accounting_cases
  WHERE case_id = NEW.successor_case_id FOR UPDATE;
  SELECT * INTO successor_version FROM accounting_case_versions
  WHERE case_id = NEW.successor_case_id AND version = 1 FOR UPDATE;
  IF successor_head.case_id IS NULL OR successor_version.case_id IS NULL
    OR successor_head.current_version <> 1
    OR successor_version.compiled_plan_hash <> NEW.consumed_plan_hash
    OR successor_head.actor_id <> NEW.actor_id
    OR successor_head.workspace_id <> NEW.workspace_id
    OR successor_head.subject_type <> NEW.subject_type
    OR successor_head.subject_id <> NEW.subject_id
    OR successor_head.agent_id <> NEW.agent_id
    OR successor_head.oauth_installation_id <> NEW.oauth_installation_id
    OR successor_head.binding_id <> NEW.binding_id
    OR successor_head.binding_revision <> NEW.binding_revision
    OR successor_head.connection_id <> NEW.connection_id
    OR successor_head.tenant_id <> NEW.tenant_id
    OR successor_head.target_session_id <> NEW.target_session_id
    OR successor_head.target_session_hash <> NEW.target_session_hash
    OR successor_head.target_session_expires_at <> NEW.target_session_expires_at
  THEN
    RAISE EXCEPTION 'Recovery residual grant consumption requires its exact successor Case v1'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_case_recovery_residual_grant_lifecycle
BEFORE INSERT OR UPDATE ON accounting_case_recovery_residual_grants
FOR EACH ROW EXECUTE FUNCTION accounting_case_recovery_residual_grant_guard();

CREATE OR REPLACE FUNCTION reject_accounting_case_recovery_residual_grant_removal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Recovery residual grants are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER accounting_case_recovery_residual_grant_no_delete
BEFORE DELETE ON accounting_case_recovery_residual_grants
FOR EACH ROW EXECUTE FUNCTION reject_accounting_case_recovery_residual_grant_removal();

CREATE TRIGGER accounting_case_recovery_residual_grant_no_truncate
BEFORE TRUNCATE ON accounting_case_recovery_residual_grants
FOR EACH STATEMENT EXECUTE FUNCTION reject_accounting_case_recovery_residual_grant_removal();

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
      FILTER (WHERE state IN (
        'PENDING', 'PREPARED', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE',
        'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
      )), '[]'::jsonb)
  )
  FROM accounting_case_operations
  WHERE case_id = selected_case_id AND case_version = selected_version;
$$;

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
      'NOT_EXECUTED_AFTER_PRIOR_FAILURE', 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
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
  IF NEW.state = 'NO_WRITE_REQUIRED' THEN
    IF NEW.action_id = 'contact.create_basic' THEN
      IF COALESCE(
        NEW.readback_snapshot ->> 'contactId', NEW.readback_snapshot ->> 'contactID',
        NEW.readback_snapshot ->> 'ContactID', NEW.readback_snapshot ->> 'id'
      ) IS DISTINCT FROM NEW.xero_object_id
        OR COALESCE(NEW.readback_snapshot ->> 'name', NEW.readback_snapshot ->> 'Name')
          IS DISTINCT FROM NEW.canonical_payload ->> 'name'
        OR COALESCE(NEW.readback_snapshot ->> 'status', NEW.readback_snapshot ->> 'Status', 'ACTIVE') <> 'ACTIVE'
      THEN
        RAISE EXCEPTION 'Accounting Case no-write evidence must be an exact active contact match'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.readback_snapshot ->> 'schemaVersion'
          IS DISTINCT FROM 'xero-accounting-case-existing-document-evidence:v1'
        OR NEW.readback_snapshot ->> 'decision' IS DISTINCT FROM 'NO_WRITE_REQUIRED_EXISTING'
        OR NEW.readback_snapshot ->> 'actionId' IS DISTINCT FROM NEW.action_id
        OR NEW.readback_snapshot ->> 'nativeRoute' IS DISTINCT FROM NEW.native_route
        OR NEW.readback_snapshot ->> 'operationCanonicalPayloadHash'
          IS DISTINCT FROM NEW.canonical_payload_hash
        OR NEW.readback_snapshot -> 'businessReservation' IS DISTINCT FROM NEW.business_reservation
        OR NEW.readback_snapshot ->> 'providerObjectId' IS DISTINCT FROM NEW.xero_object_id
        OR jsonb_typeof(NEW.readback_snapshot -> 'providerHistory') IS DISTINCT FROM 'object'
        OR NEW.readback_snapshot #>> '{providerHistory,state}' IS DISTINCT FROM 'EXACT_ONE'
        OR NEW.readback_snapshot #> '{providerHistory,complete}' IS DISTINCT FROM 'true'::jsonb
        OR COALESCE(NEW.readback_snapshot #>> '{providerHistory,checkedObjectCount}', '')
          !~ '^[1-9][0-9]*$'
        OR NEW.readback_snapshot #> '{providerHistory,canonicalEconomicMatch}'
          IS DISTINCT FROM 'true'::jsonb
        OR NEW.readback_snapshot #> '{providerHistory,mismatchReasons}' IS DISTINCT FROM '[]'::jsonb
        OR jsonb_typeof(NEW.readback_snapshot -> 'exactReadback') IS DISTINCT FROM 'object'
      THEN
        RAISE EXCEPTION 'Accounting Case native no-write evidence is not exact provider history'
          USING ERRCODE = '23514';
      END IF;

      IF NOT COALESCE((
        (NEW.action_id = 'customer_invoice.create_draft'
          AND NEW.native_route = 'SALES_INVOICE'
          AND NEW.readback_snapshot #>> '{exactReadback,type}' = 'ACCREC'
          AND lower(NEW.readback_snapshot #>> '{exactReadback,invoiceId}') = lower(NEW.xero_object_id))
        OR (NEW.action_id = 'supplier_bill.create_draft'
          AND NEW.native_route = 'SUPPLIER_BILL'
          AND NEW.readback_snapshot #>> '{exactReadback,type}' = 'ACCPAY'
          AND lower(NEW.readback_snapshot #>> '{exactReadback,invoiceId}') = lower(NEW.xero_object_id))
        OR (NEW.action_id = 'credit_note.create_draft'
          AND NEW.native_route = 'CUSTOMER_CREDIT'
          AND NEW.readback_snapshot #>> '{exactReadback,type}' = 'ACCRECCREDIT'
          AND lower(NEW.readback_snapshot #>> '{exactReadback,creditNoteId}') = lower(NEW.xero_object_id))
        OR (NEW.action_id = 'credit_note.create_draft'
          AND NEW.native_route = 'SUPPLIER_CREDIT'
          AND NEW.readback_snapshot #>> '{exactReadback,type}' = 'ACCPAYCREDIT'
          AND lower(NEW.readback_snapshot #>> '{exactReadback,creditNoteId}') = lower(NEW.xero_object_id))
      ), false) THEN
        RAISE EXCEPTION 'Accounting Case native no-write evidence action or provider object is mismatched'
          USING ERRCODE = '23514';
      END IF;

      IF COALESCE(NEW.readback_snapshot #>> '{exactReadback,status}', '') = ''
        OR NEW.readback_snapshot #>> '{exactReadback,tenantId}' IS DISTINCT FROM NEW.tenant_id
        OR lower(NEW.readback_snapshot #>> '{exactReadback,contact,contactId}')
          IS DISTINCT FROM lower(NEW.canonical_payload ->> 'xeroContactId')
        OR NEW.readback_snapshot #>> '{exactReadback,reference}'
          IS DISTINCT FROM NEW.canonical_payload ->> 'reference'
        OR COALESCE(
          NEW.readback_snapshot #>> '{exactReadback,invoiceDate}',
          NEW.readback_snapshot #>> '{exactReadback,creditNoteDate}'
        ) IS DISTINCT FROM NEW.canonical_payload ->> 'documentDate'
        OR NEW.readback_snapshot #>> '{exactReadback,currency}'
          IS DISTINCT FROM NEW.canonical_payload ->> 'currency'
        OR (NEW.native_route IN ('SALES_INVOICE', 'SUPPLIER_BILL')
          AND NEW.readback_snapshot #>> '{exactReadback,dueDate}'
            IS DISTINCT FROM NEW.canonical_payload ->> 'dueDate')
        OR (NEW.canonical_payload ? 'invoiceRate'
          AND NEW.readback_snapshot #>> '{exactReadback,currencyRate}'
            IS DISTINCT FROM NEW.canonical_payload ->> 'invoiceRate')
        OR NEW.readback_snapshot #>> '{exactReadback,subTotal}'
          IS DISTINCT FROM NEW.canonical_payload ->> 'net'
        OR NEW.readback_snapshot #>> '{exactReadback,totalTax}'
          IS DISTINCT FROM NEW.canonical_payload ->> 'tax'
        OR NEW.readback_snapshot #>> '{exactReadback,total}'
          IS DISTINCT FROM NEW.canonical_payload ->> 'gross'
        OR upper(regexp_replace(
          COALESCE(NEW.readback_snapshot #>> '{exactReadback,lineAmountType}', ''),
          '[^A-Za-z]', '', 'g'
        )) IS DISTINCT FROM upper(regexp_replace(
          COALESCE(NEW.canonical_payload ->> 'lineAmountType', ''),
          '[^A-Za-z]', '', 'g'
        ))
        OR jsonb_typeof(NEW.canonical_payload -> 'lines') IS DISTINCT FROM 'array'
        OR jsonb_typeof(NEW.readback_snapshot #> '{exactReadback,lines}') IS DISTINCT FROM 'array'
        OR NEW.readback_snapshot #> '{exactReadback,linesTruncated}' IS DISTINCT FROM 'false'::jsonb
        OR NEW.readback_snapshot #> '{exactReadback,lineItemCount}' IS DISTINCT FROM
          to_jsonb(jsonb_array_length(NEW.readback_snapshot #> '{exactReadback,lines}'))
        OR jsonb_array_length(NEW.readback_snapshot #> '{exactReadback,lines}') <>
          jsonb_array_length(NEW.canonical_payload -> 'lines')
      THEN
        RAISE EXCEPTION 'Accounting Case native no-write evidence economics are mismatched or incomplete'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.canonical_payload -> 'lines')
          WITH ORDINALITY expected_line(value, ordinal)
        FULL JOIN jsonb_array_elements(NEW.readback_snapshot #> '{exactReadback,lines}')
          WITH ORDINALITY actual_line(value, ordinal)
          USING (ordinal)
        WHERE expected_line.value IS NULL
          OR actual_line.value IS NULL
          OR expected_line.value ->> 'description' IS DISTINCT FROM actual_line.value ->> 'description'
          OR expected_line.value ->> 'quantity' IS DISTINCT FROM actual_line.value ->> 'quantity'
          OR expected_line.value ->> 'unitAmount' IS DISTINCT FROM actual_line.value ->> 'unitAmount'
          OR expected_line.value ->> 'net' IS DISTINCT FROM actual_line.value ->> 'lineAmount'
          OR expected_line.value ->> 'tax' IS DISTINCT FROM actual_line.value ->> 'taxAmount'
          OR expected_line.value ->> 'accountId' IS DISTINCT FROM actual_line.value ->> 'accountId'
          OR expected_line.value ->> 'accountCode' IS DISTINCT FROM actual_line.value ->> 'accountCode'
          OR expected_line.value ->> 'taxType' IS DISTINCT FROM actual_line.value ->> 'taxType'
      ) THEN
        RAISE EXCEPTION 'Accounting Case native no-write evidence lines are not exact'
          USING ERRCODE = '23514';
      END IF;
    END IF;
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
  IF NEW.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY' AND (
    OLD.state <> 'PREPARED'
    OR case_row.target_session_expires_at > statement_timestamp()
    OR preparation_row.state <> 'EXPIRED'
    OR NEW.mutation_request_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM xero_mutation_requests mutation_record
      WHERE mutation_record.preparation_id = NEW.preparation_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM accounting_case_versions version_row
      WHERE version_row.case_id = NEW.case_id AND version_row.version = NEW.case_version
        AND version_row.state = 'RECOVERY_REQUIRED'
        AND version_row.execution_request_id IS NOT NULL
    )
    OR NEW.error_receipt ->> 'receiptType' <> 'ACCOUNTING_CASE_EXPIRED_TARGET_RESIDUAL_NO_WRITE'
    OR NEW.error_receipt -> 'providerMutationPossible' IS DISTINCT FROM 'false'::jsonb
    OR NEW.error_receipt -> 'mutationRequestAbsent' IS DISTINCT FROM 'true'::jsonb
    OR NEW.error_receipt -> 'providerCallAbsentByPermitInvariant' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(NEW.error_receipt -> 'reasonCodes') <> 'array'
    OR jsonb_array_length(NEW.error_receipt -> 'reasonCodes') <> 1
    OR jsonb_typeof(NEW.error_receipt -> 'reason') <> 'object'
    OR NEW.error_receipt -> 'reason' = '{}'::jsonb
    OR (
      NEW.error_receipt ->> 'recoveryAction' = 'PREPARE_RECOVERY_SUCCESSOR_CASE'
      AND (
        NEW.error_receipt ->> 'grantId' IS NULL
        OR NEW.error_receipt ->> 'successorCaseId' IS NULL
        OR NOT (NEW.error_receipt -> 'reasonCodes' ? 'EXPIRED_TARGET_RECOVERY_CONTINUED_TO_SUCCESSOR')
        OR NOT EXISTS (
          SELECT 1 FROM accounting_case_recovery_residual_grants grant_row
          WHERE grant_row.grant_id = NEW.error_receipt ->> 'grantId'
            AND grant_row.source_case_id = NEW.case_id
            AND grant_row.source_case_version = NEW.case_version
            AND grant_row.successor_case_id = NEW.error_receipt ->> 'successorCaseId'
            AND grant_row.residual_operation_ids @> ARRAY[NEW.operation_id]
        )
      )
    )
    OR (
      NEW.error_receipt ->> 'recoveryAction' = 'PREPARE_NEW_ACCOUNTING_CASE'
      AND (
        NOT (NEW.error_receipt -> 'reasonCodes' ? 'EXPIRED_TARGET_RECOVERY_REQUIRES_MANUAL_REPREPARATION')
        OR EXISTS (
          SELECT 1 FROM accounting_case_recovery_residual_grants grant_row
          WHERE grant_row.source_case_id = NEW.case_id
            AND grant_row.source_case_version = NEW.case_version
        )
      )
    )
    OR NEW.error_receipt ->> 'recoveryAction' NOT IN (
      'PREPARE_RECOVERY_SUCCESSOR_CASE', 'PREPARE_NEW_ACCOUNTING_CASE'
    )
  ) THEN
    RAISE EXCEPTION 'Expired-target residual requires exact zero-write closure and typed continuation evidence'
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
    'BLOCKED_VALIDATION', 'NOT_EXECUTED_AFTER_PRIOR_FAILURE',
    'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
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

CREATE OR REPLACE FUNCTION accounting_case_recovery_residual_claim_active(
  selected_case_id text,
  selected_case_version bigint,
  selected_operation_id text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM accounting_case_recovery_residual_grants grant_row
    JOIN ledger_target_sessions target_session
      ON target_session.session_hash = grant_row.target_session_hash
     AND target_session.session_id = grant_row.target_session_id
     AND target_session.oauth_installation_id = grant_row.oauth_installation_id
     AND target_session.binding_id = grant_row.binding_id
     AND target_session.connection_id = grant_row.connection_id
     AND target_session.binding_revision = grant_row.binding_revision
     AND target_session.expires_at = grant_row.target_session_expires_at
    WHERE grant_row.source_case_id = selected_case_id
      AND grant_row.source_case_version = selected_case_version
      AND selected_operation_id = ANY(grant_row.residual_operation_ids)
      AND grant_row.state IN ('ISSUED', 'CONSUMED')
      AND target_session.revoked_at IS NULL
      AND target_session.expires_at > statement_timestamp()
  );
$$;

CREATE OR REPLACE FUNCTION accounting_case_recovery_successor_owns_residual(
  selected_case_id text,
  selected_case_version bigint,
  selected_operation_id text,
  selected_successor_case_id text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM accounting_case_recovery_residual_grants grant_row
    JOIN ledger_target_sessions target_session
      ON target_session.session_hash = grant_row.target_session_hash
     AND target_session.session_id = grant_row.target_session_id
     AND target_session.oauth_installation_id = grant_row.oauth_installation_id
     AND target_session.binding_id = grant_row.binding_id
     AND target_session.connection_id = grant_row.connection_id
     AND target_session.binding_revision = grant_row.binding_revision
     AND target_session.expires_at = grant_row.target_session_expires_at
    WHERE grant_row.source_case_id = selected_case_id
      AND grant_row.source_case_version = selected_case_version
      AND selected_operation_id = ANY(grant_row.residual_operation_ids)
      AND grant_row.successor_case_id = selected_successor_case_id
      AND grant_row.state IN ('ISSUED', 'CONSUMED')
      AND target_session.revoked_at IS NULL
      AND target_session.expires_at > statement_timestamp()
  );
$$;

-- The source operation keeps the collision coordinate, while the grant makes
-- it active only for the lifetime of the exact successor target. This closes
-- the release-before-successor race without copying an old preparation or
-- rebinding the old Case. The one authorized successor is exempt from its own
-- source claim and must acquire a fresh ordinary operation reservation.
CREATE OR REPLACE FUNCTION enforce_accounting_case_business_reservation_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  contact_coordinate jsonb;
  contact_head_current_version bigint;
  contact_head_expires_at timestamptz;
  business_head_current_version bigint;
  business_head_expires_at timestamptz;
BEGIN
  IF NEW.action_id = 'contact.create_basic' THEN
    IF NEW.state = 'PENDING' THEN
      SELECT current_version, target_session_expires_at
      INTO contact_head_current_version, contact_head_expires_at
      FROM accounting_cases
      WHERE case_id = NEW.case_id;

      IF FOUND AND (
        contact_head_expires_at <= statement_timestamp()
        OR NEW.case_version NOT IN (
          contact_head_current_version,
          contact_head_current_version + 1
        )
      ) THEN
        RAISE EXCEPTION 'PENDING contact claim has no live current-version target lease'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state NOT IN (
      'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
      'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
    ) THEN
      RETURN NEW;
    END IF;

    contact_coordinate := accounting_case_contact_bare_number_coordinate(
      NEW.business_identity,
      NEW.canonical_payload
    );
    IF contact_coordinate IS NULL THEN
      RAISE EXCEPTION 'Contact claim has no safe provider bare-number coordinate'
        USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.tenant_id || ':' || NEW.action_id || ':' || contact_coordinate::text,
      0
    ));

    IF EXISTS (
      SELECT 1
      FROM accounting_case_operations existing
      LEFT JOIN accounting_cases existing_head ON existing_head.case_id = existing.case_id
      WHERE existing.tenant_id = NEW.tenant_id
        AND existing.action_id = 'contact.create_basic'
        AND accounting_case_contact_bare_number_coordinate(
          existing.business_identity,
          existing.canonical_payload
        ) = contact_coordinate
        AND (
          existing.state IN (
            'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
            'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
          )
          OR (
            existing.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
            AND accounting_case_recovery_residual_claim_active(
              existing.case_id, existing.case_version, existing.operation_id
            )
          )
          OR (
            existing.state = 'PENDING'
            AND (
              existing_head.case_id IS NULL
              OR (
                existing_head.current_version = existing.case_version
                AND existing_head.target_session_expires_at > statement_timestamp()
              )
            )
          )
        )
        AND NOT (
          existing.case_id = NEW.case_id
          AND existing.case_version = NEW.case_version
          AND existing.operation_id = NEW.operation_id
        )
        AND NOT (
          existing.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
          AND accounting_case_recovery_successor_owns_residual(
            existing.case_id, existing.case_version, existing.operation_id, NEW.case_id
          )
        )
        AND NOT (
          NEW.state = 'PENDING'
          AND existing.state = 'PENDING'
          AND existing.case_id = NEW.case_id
          AND NEW.case_version = existing.case_version + 1
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        CONSTRAINT = 'accounting_case_contact_bare_number_reservation_overlap';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state = 'PENDING' THEN
    SELECT current_version, target_session_expires_at
    INTO business_head_current_version, business_head_expires_at
    FROM accounting_cases
    WHERE case_id = NEW.case_id;

    IF NOT FOUND OR (
      business_head_expires_at <= statement_timestamp()
      OR NEW.case_version NOT IN (
        business_head_current_version,
        business_head_current_version + 1
      )
    ) THEN
      RAISE EXCEPTION 'PENDING business-coordinate claim has no live current-version target lease'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state NOT IN (
    'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
    'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id || ':' || NEW.action_id || ':' || NEW.business_reservation_coordinate::text,
    0
  ));

  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations existing
    LEFT JOIN accounting_cases existing_head ON existing_head.case_id = existing.case_id
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.action_id = NEW.action_id
      AND existing.business_reservation_coordinate = NEW.business_reservation_coordinate
      AND (
        existing.state IN (
          'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
          'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
        )
        OR (
          existing.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
          AND accounting_case_recovery_residual_claim_active(
            existing.case_id, existing.case_version, existing.operation_id
          )
        )
        OR (
          existing.state = 'PENDING'
          AND (
            existing_head.case_id IS NULL
            OR (
              existing_head.current_version = existing.case_version
              AND existing_head.target_session_expires_at > statement_timestamp()
            )
          )
        )
      )
      AND NOT (
        existing.case_id = NEW.case_id
        AND existing.case_version = NEW.case_version
        AND existing.operation_id = NEW.operation_id
      )
      AND NOT (
        existing.state = 'NOT_EXECUTED_AFTER_TARGET_EXPIRY'
        AND accounting_case_recovery_successor_owns_residual(
          existing.case_id, existing.case_version, existing.operation_id, NEW.case_id
        )
      )
      AND NOT (
        NEW.state = 'PENDING'
        AND existing.state = 'PENDING'
        AND existing.case_id = NEW.case_id
        AND NEW.case_version = existing.case_version + 1
      )
      AND (
        existing.business_reservation_scope = 'ALL_OCCURRENCES'
        OR NEW.business_reservation_scope = 'ALL_OCCURRENCES'
        OR existing.business_reservation_occurrence_date = NEW.business_reservation_occurrence_date
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      CONSTRAINT = 'accounting_case_active_business_reservation_overlap';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION accounting_case_recovery_residual_grant_guard()
SET search_path = public, pg_temp;
ALTER FUNCTION accounting_case_recovery_residual_claim_active(text, bigint, text)
SET search_path = public, pg_temp;
ALTER FUNCTION accounting_case_recovery_successor_owns_residual(text, bigint, text, text)
SET search_path = public, pg_temp;
