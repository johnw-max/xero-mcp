-- Recover a contact bare-number reservation only when the old Case has no
-- durable mutation claim and therefore could not have received a provider
-- write permit. The transfer and the successor Case insert share one
-- transaction and one coordinate advisory lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A caller timestamp can never extend or revive a preparation.  This trigger
-- is the bottom-most write boundary, including callers that bypass the
-- TypeScript repository.
CREATE OR REPLACE FUNCTION xero_mutation_request_preparation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM xero_mutation_preparations preparation
    WHERE preparation.preparation_id = NEW.preparation_id
      AND preparation.state = 'PREPARED'
      AND preparation.expires_at > statement_timestamp()
      AND (
        preparation.target_session_id IS NULL
        OR EXISTS (
          SELECT 1 FROM ledger_target_sessions target_session
          WHERE target_session.session_id = preparation.target_session_id
            AND target_session.oauth_installation_id = preparation.oauth_installation_id
            AND target_session.binding_id = preparation.binding_id
            AND target_session.connection_id = preparation.connection_id
            AND target_session.binding_revision = preparation.binding_revision
            AND target_session.revoked_at IS NULL
            AND target_session.expires_at > statement_timestamp()
        )
      )
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
    RAISE EXCEPTION 'xero mutation request does not match a live immutable preparation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- PREPARED is a live lease, not a caller-authored timestamp label.  The older
-- operation lifecycle guard compares against NEW.updated_at for immutable
-- evidence ordering; this independent bottom-layer guard additionally uses the
-- database clock and the exact durable target session for liveness.
CREATE OR REPLACE FUNCTION accounting_case_prepared_liveness_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'PREPARED' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM accounting_cases case_head
    JOIN xero_mutation_preparations preparation
      ON preparation.preparation_id = NEW.preparation_id
    JOIN ledger_target_sessions target_session
      ON target_session.session_id = case_head.target_session_id
     AND target_session.session_hash = case_head.target_session_hash
     AND target_session.oauth_installation_id = case_head.oauth_installation_id
     AND target_session.binding_id = case_head.binding_id
     AND target_session.connection_id = case_head.connection_id
     AND target_session.binding_revision = case_head.binding_revision
    WHERE case_head.case_id = NEW.case_id
      AND preparation.state = 'PREPARED'
      AND preparation.expires_at > statement_timestamp()
      AND preparation.target_session_id = target_session.session_id
      AND target_session.revoked_at IS NULL
      AND target_session.expires_at = case_head.target_session_expires_at
      AND target_session.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION 'Accounting Case PREPARED operation requires a live preparation and target lease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_prepared_liveness
  ON accounting_case_operations;
CREATE TRIGGER accounting_case_prepared_liveness
BEFORE INSERT OR UPDATE ON accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_prepared_liveness_guard();

-- Returns the number of PREPARED operations durably closed. A zero result is
-- fail-closed: the ordinary reservation trigger will retain the old claim and
-- reject the successor insert.
CREATE OR REPLACE FUNCTION abandon_expired_accounting_case_contact_reservation(
  successor_tenant_id text,
  successor_business_identity jsonb,
  successor_canonical_payload jsonb,
  successor_case_id text,
  successor_case_version bigint,
  successor_operation_id text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  coordinate jsonb;
  candidate record;
  database_now timestamptz := statement_timestamp();
  abandoned_count integer := 0;
  terminal_state text;
BEGIN
  coordinate := accounting_case_contact_bare_number_coordinate(
    successor_business_identity,
    successor_canonical_payload
  );
  IF coordinate IS NULL THEN
    RETURN 0;
  END IF;

  -- Find only a committed PREPARED candidate before taking any lock.  This
  -- first read is advisory; every safety predicate is repeated after locks.
  SELECT
    operation_row.case_id,
    operation_row.case_version,
    operation_row.operation_id,
    operation_row.preparation_id,
    version_row.state AS version_state,
    case_head.target_session_expires_at,
    target_session.expires_at AS durable_target_session_expires_at,
    target_session.revoked_at AS target_session_revoked_at,
    preparation.expires_at AS preparation_expires_at
  INTO candidate
  FROM accounting_case_operations operation_row
  JOIN accounting_case_versions version_row
    ON version_row.case_id = operation_row.case_id
   AND version_row.version = operation_row.case_version
  JOIN accounting_cases case_head ON case_head.case_id = operation_row.case_id
  JOIN xero_mutation_preparations preparation
    ON preparation.preparation_id = operation_row.preparation_id
  LEFT JOIN ledger_target_sessions target_session
    ON target_session.session_id = case_head.target_session_id
   AND target_session.session_hash = case_head.target_session_hash
   AND target_session.oauth_installation_id = case_head.oauth_installation_id
   AND target_session.binding_id = case_head.binding_id
   AND target_session.connection_id = case_head.connection_id
   AND target_session.binding_revision = case_head.binding_revision
   AND target_session.expires_at = case_head.target_session_expires_at
  WHERE operation_row.tenant_id = successor_tenant_id
    AND operation_row.action_id = 'contact.create_basic'
    AND operation_row.state = 'PREPARED'
    -- A committed begin-write has already consumed the preparation. Exclude it
    -- before taking the Case-version lock so its later operation projection
    -- cannot form a coordinate-lock/version-lock cycle with cleanup.
    AND preparation.state IN ('PREPARED', 'EXPIRED')
    AND accounting_case_contact_bare_number_coordinate(
      operation_row.business_identity,
      operation_row.canonical_payload
    ) = coordinate
    AND NOT (
      operation_row.case_id = successor_case_id
      AND operation_row.case_version = successor_case_version
      AND operation_row.operation_id = successor_operation_id
    )
  ORDER BY operation_row.case_id, operation_row.case_version, operation_row.operation_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Match every Accounting Case execution/reseal path: version first, then the
  -- business coordinate, then every immutable preparation in deterministic
  -- order.  In particular, reseal already owns the version before its
  -- PREPARED update reaches the overlap trigger.  Taking the advisory lock
  -- before the version here would invert that order and permit a 40P01 cycle.
  PERFORM 1
  FROM accounting_case_versions
  WHERE case_id = candidate.case_id AND version = candidate.case_version
  FOR UPDATE;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    successor_tenant_id || ':contact.create_basic:' || coordinate::text,
    0
  ));

  PERFORM preparation.preparation_id
  FROM xero_mutation_preparations preparation
  JOIN accounting_case_operations operation_row
    ON operation_row.preparation_id = preparation.preparation_id
  WHERE operation_row.case_id = candidate.case_id
    AND operation_row.case_version = candidate.case_version
    AND operation_row.state = 'PREPARED'
  ORDER BY preparation.preparation_id
  FOR UPDATE OF preparation;

  -- Re-read after all locks. The competing write claim may have consumed the
  -- preparation while this transaction waited.
  SELECT
    operation_row.case_id,
    operation_row.case_version,
    operation_row.operation_id,
    operation_row.preparation_id,
    version_row.state AS version_state,
    case_head.target_session_expires_at,
    target_session.expires_at AS durable_target_session_expires_at,
    target_session.revoked_at AS target_session_revoked_at,
    preparation.expires_at AS preparation_expires_at
  INTO candidate
  FROM accounting_case_operations operation_row
  JOIN accounting_case_versions version_row
    ON version_row.case_id = operation_row.case_id
   AND version_row.version = operation_row.case_version
  JOIN accounting_cases case_head ON case_head.case_id = operation_row.case_id
  JOIN xero_mutation_preparations preparation
    ON preparation.preparation_id = operation_row.preparation_id
  LEFT JOIN ledger_target_sessions target_session
    ON target_session.session_id = case_head.target_session_id
   AND target_session.session_hash = case_head.target_session_hash
   AND target_session.oauth_installation_id = case_head.oauth_installation_id
   AND target_session.binding_id = case_head.binding_id
   AND target_session.connection_id = case_head.connection_id
   AND target_session.binding_revision = case_head.binding_revision
   AND target_session.expires_at = case_head.target_session_expires_at
  WHERE operation_row.case_id = candidate.case_id
    AND operation_row.case_version = candidate.case_version
    AND operation_row.operation_id = candidate.operation_id
    AND operation_row.state = 'PREPARED'
    AND preparation.state IN ('PREPARED', 'EXPIRED');

  IF NOT FOUND
    OR candidate.version_state NOT IN ('PREFLIGHTED', 'READY_TO_RESUME', 'EXECUTING')
    OR (
      candidate.preparation_expires_at > database_now
      AND COALESCE(candidate.durable_target_session_expires_at > database_now, false)
      AND candidate.target_session_revoked_at IS NULL
    )
  THEN
    RETURN 0;
  END IF;

  -- Abandon the whole immutable preflight, not one operation inside a plan
  -- that could later resume. Every PREPARED operation must independently prove
  -- that no request, write claim, permit, provider call, or receipt can exist.
  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = candidate.case_id
      AND operation_row.case_version = candidate.case_version
      AND operation_row.state NOT IN ('PREPARED', 'NO_WRITE_REQUIRED')
  ) OR EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    LEFT JOIN xero_mutation_preparations preparation
      ON preparation.preparation_id = operation_row.preparation_id
    WHERE operation_row.case_id = candidate.case_id
      AND operation_row.case_version = candidate.case_version
      AND operation_row.state = 'PREPARED'
      AND (
        preparation.preparation_id IS NULL
        OR preparation.state NOT IN ('PREPARED', 'EXPIRED')
        OR operation_row.mutation_request_id IS NOT NULL
        OR operation_row.xero_object_id IS NOT NULL
        OR operation_row.write_receipt IS NOT NULL
        OR operation_row.readback_snapshot IS NOT NULL
        OR operation_row.error_receipt IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM xero_mutation_requests request_row
          WHERE request_row.preparation_id = operation_row.preparation_id
        )
      )
  ) THEN
    RETURN 0;
  END IF;

  -- Reuse the normal Case lifecycle: claim the preflight request only as a
  -- local abandonment transaction, close every zero-request operation, then
  -- seal the deterministic terminal projection. No provider permit is issued.
  IF candidate.version_state IN ('PREFLIGHTED', 'READY_TO_RESUME') THEN
    UPDATE accounting_case_versions
    SET state = 'EXECUTING',
        execution_request_id = preflight_request_id,
        execution_started_at = GREATEST(created_at, database_now),
        updated_at = GREATEST(updated_at, database_now)
    WHERE case_id = candidate.case_id
      AND version = candidate.case_version
      AND state = candidate.version_state;
  END IF;

  UPDATE xero_mutation_preparations preparation
  SET state = 'EXPIRED',
      updated_at = GREATEST(preparation.updated_at, database_now)
  FROM accounting_case_operations operation_row
  WHERE operation_row.case_id = candidate.case_id
    AND operation_row.case_version = candidate.case_version
    AND operation_row.state = 'PREPARED'
    AND operation_row.preparation_id = preparation.preparation_id
    AND preparation.state = 'PREPARED';

  UPDATE accounting_case_operations operation_row
  SET state = 'BLOCKED_VALIDATION',
      error_receipt = jsonb_build_object(
        'receiptType', 'ACCOUNTING_CASE_NO_WRITE_STARTED',
        'receiptVersion', 1,
        'disposition', 'ABANDONED',
        'reasonCode', 'EXPIRED_PREPARATION_OR_TARGET_LEASE',
        'caseId', operation_row.case_id,
        'caseVersion', operation_row.case_version,
        'operationId', operation_row.operation_id,
        'preparationId', operation_row.preparation_id,
        'abandonmentTriggerPreparationId', candidate.preparation_id,
        'successorCaseId', successor_case_id,
        'successorCaseVersion', successor_case_version,
        'successorOperationId', successor_operation_id,
        'preparationExpiresAt', preparation.expires_at,
        'targetSessionExpiresAt', case_head.target_session_expires_at,
        'targetSessionRevokedAt', candidate.target_session_revoked_at,
        'abandonedAt', database_now,
        'mutationRequestAbsent', true,
        'writeClaimAbsent', true,
        'providerPermitAbsentByDurableClaimInvariant', true,
        'providerCallAbsentByPermitInvariant', true,
        'writeReceiptAbsent', true,
        'readbackReceiptAbsent', true
      ),
      updated_at = GREATEST(operation_row.updated_at, database_now)
  FROM xero_mutation_preparations preparation, accounting_cases case_head
  WHERE operation_row.case_id = candidate.case_id
    AND operation_row.case_version = candidate.case_version
    AND operation_row.state = 'PREPARED'
    AND operation_row.preparation_id = preparation.preparation_id
    AND case_head.case_id = operation_row.case_id
    AND NOT EXISTS (
      SELECT 1 FROM xero_mutation_requests request_row
      WHERE request_row.preparation_id = operation_row.preparation_id
    )
    AND operation_row.mutation_request_id IS NULL
    AND operation_row.xero_object_id IS NULL
    AND operation_row.write_receipt IS NULL
    AND operation_row.readback_snapshot IS NULL
    AND operation_row.error_receipt IS NULL;
  GET DIAGNOSTICS abandoned_count = ROW_COUNT;

  IF abandoned_count = 0 THEN
    RAISE EXCEPTION 'Accounting Case zero-write abandonment lost its compare-and-swap'
      USING ERRCODE = '40001';
  END IF;

  terminal_state := CASE WHEN EXISTS (
    SELECT 1 FROM accounting_case_operations operation_row
    WHERE operation_row.case_id = candidate.case_id
      AND operation_row.case_version = candidate.case_version
      AND operation_row.state = 'NO_WRITE_REQUIRED'
  ) THEN 'PARTIALLY_COMMITTED' ELSE 'TERMINAL' END;

  UPDATE accounting_case_versions
  SET state = terminal_state,
      terminal_summary = accounting_case_terminal_state_projection(
        candidate.case_id,
        candidate.case_version,
        terminal_state
      ),
      updated_at = GREATEST(updated_at, database_now)
  WHERE case_id = candidate.case_id
    AND version = candidate.case_version
    AND state = 'EXECUTING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting Case zero-write abandonment could not seal its terminal receipt'
      USING ERRCODE = '40001';
  END IF;
  RETURN abandoned_count;
END;
$$;

-- Rebuild the overlap guard so neither incoming nor existing PENDING lease
-- validity can be forged through NEW.updated_at. PREPARED rows remain active
-- until the atomic function above writes the durable abandonment receipt.
CREATE OR REPLACE FUNCTION enforce_accounting_case_business_reservation_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  contact_coordinate jsonb;
  contact_head_current_version bigint;
  contact_head_expires_at timestamptz;
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

  IF NEW.state NOT IN (
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
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.action_id = NEW.action_id
      AND existing.business_reservation_coordinate = NEW.business_reservation_coordinate
      AND existing.state IN (
        'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
        'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
      )
      AND NOT (
        existing.case_id = NEW.case_id
        AND existing.case_version = NEW.case_version
        AND existing.operation_id = NEW.operation_id
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

ALTER FUNCTION abandon_expired_accounting_case_contact_reservation(
  text, jsonb, jsonb, text, bigint, text
) SET search_path = public, pg_temp;

ALTER FUNCTION accounting_case_prepared_liveness_guard()
SET search_path = public, pg_temp;
