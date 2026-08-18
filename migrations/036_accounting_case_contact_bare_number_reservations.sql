-- Atomically reserve the provider-visible bare company/account number before
-- any contact scan, provider preparation, write permit, or create can run.
-- Typed jurisdiction/scheme/namespace remains immutable business identity
-- evidence; it is deliberately not treated as external namespace authority.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION accounting_case_contact_bare_number_coordinate(
  contact_business_identity jsonb,
  contact_canonical_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  identity_kind text := contact_business_identity ->> 'kind';
  provider_id text := COALESCE(NULLIF(contact_business_identity ->> 'providerId', ''), 'xero');
  field_kind text;
  bare_number text;
  company_number text;
  account_number text;
BEGIN
  IF identity_kind = 'LEGAL_REGISTRY_CONTACT' THEN
    field_kind := 'COMPANY_NUMBER';
    bare_number := NULLIF(upper(btrim(contact_business_identity -> 'canonicalFields' ->> 'number')), '');
  ELSIF identity_kind = 'PROVIDER_TENANT_CONTACT_ACCOUNT' THEN
    field_kind := 'ACCOUNT_NUMBER';
    bare_number := NULLIF(upper(btrim(contact_business_identity -> 'canonicalFields' ->> 'number')), '');
  ELSIF identity_kind = 'LEGACY_EXACT_PAYLOAD' THEN
    company_number := NULLIF(upper(btrim(COALESCE(
      contact_canonical_payload ->> 'companyNumber',
      contact_canonical_payload #>> '{target,companyNumber}'
    ))), '');
    account_number := NULLIF(upper(btrim(COALESCE(
      contact_canonical_payload ->> 'accountNumber',
      contact_canonical_payload #>> '{target,accountNumber}'
    ))), '');
    -- A legacy row with both or neither provider fields has no safe single
    -- collision coordinate. Migration readiness must fail for such a live
    -- claim instead of inventing an issuer or namespace.
    IF (company_number IS NULL) = (account_number IS NULL) THEN
      RETURN NULL;
    END IF;
    IF company_number IS NOT NULL THEN
      field_kind := 'COMPANY_NUMBER';
      bare_number := company_number;
    ELSE
      field_kind := 'ACCOUNT_NUMBER';
      bare_number := account_number;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  IF bare_number IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'schemaVersion', 'accounting-case-business-reservation:v1',
    'providerId', provider_id,
    'kind', 'PROVIDER_CONTACT_BARE_NUMBER',
    'canonicalFields', jsonb_build_object(
      'fieldKind', field_kind,
      'number', bare_number
    )
  );
END;
$$;

LOCK TABLE accounting_case_operations IN SHARE ROW EXCLUSIVE MODE;

-- PENDING is a lease-bound contact claim owned only by the current Case
-- version and its still-live target session. PREPARED/unknown/mismatched/
-- verified claims remain occupied until a deterministic terminal release;
-- WRITE_UNCERTAIN, READBACK_MISMATCH, and READBACK_VERIFIED never expire.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    LEFT JOIN accounting_cases case_head ON case_head.case_id = operation_row.case_id
    WHERE operation_row.action_id = 'contact.create_basic'
      AND (
        operation_row.state IN (
          'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
          'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
        )
        OR (
          operation_row.state = 'PENDING'
          AND case_head.current_version = operation_row.case_version
          AND case_head.target_session_expires_at > statement_timestamp()
        )
      )
      AND accounting_case_contact_bare_number_coordinate(
        operation_row.business_identity,
        operation_row.canonical_payload
      ) IS NULL
  ) THEN
    RAISE EXCEPTION 'Live Accounting Case contact claim has no safe provider bare-number coordinate'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT claimed.tenant_id, claimed.coordinate
    FROM (
      SELECT
        operation_row.tenant_id,
        accounting_case_contact_bare_number_coordinate(
          operation_row.business_identity,
          operation_row.canonical_payload
        ) AS coordinate
      FROM accounting_case_operations operation_row
      LEFT JOIN accounting_cases case_head ON case_head.case_id = operation_row.case_id
      WHERE operation_row.action_id = 'contact.create_basic'
        AND (
          operation_row.state IN (
            'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
            'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
          )
          OR (
            operation_row.state = 'PENDING'
            AND case_head.current_version = operation_row.case_version
            AND case_head.target_session_expires_at > statement_timestamp()
          )
        )
    ) claimed
    WHERE claimed.coordinate IS NOT NULL
    GROUP BY claimed.tenant_id, claimed.coordinate
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Existing Accounting Case contact claims collide on one provider bare number'
      USING ERRCODE = '23505',
      CONSTRAINT = 'accounting_case_contact_bare_number_reservation_overlap';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS accounting_case_contact_bare_number_reservation_lookup_idx
  ON accounting_case_operations (
    tenant_id,
    (accounting_case_contact_bare_number_coordinate(business_identity, canonical_payload))
  )
  WHERE action_id = 'contact.create_basic'
    AND state IN (
      'PENDING', 'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
      'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
    );

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
        contact_head_expires_at <= NEW.updated_at
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
                AND existing_head.target_session_expires_at > NEW.updated_at
              )
            )
          )
        )
        AND NOT (
          existing.case_id = NEW.case_id
          AND existing.case_version = NEW.case_version
          AND existing.operation_id = NEW.operation_id
        )
        -- Advancing one Case transfers its unexpired current PENDING lease to
        -- the next version atomically with the Case-head compare-and-swap.
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
END $$;

DROP TRIGGER IF EXISTS accounting_case_business_reservation_overlap_trigger
  ON accounting_case_operations;
CREATE TRIGGER accounting_case_business_reservation_overlap_trigger
BEFORE INSERT OR UPDATE OF
  state, tenant_id, action_id, business_identity, canonical_payload,
  business_reservation_coordinate, business_reservation_coordinate_hash,
  business_reservation_scope, business_reservation_occurrence_date
ON accounting_case_operations
FOR EACH ROW
EXECUTE FUNCTION enforce_accounting_case_business_reservation_overlap();

ALTER TABLE accounting_case_operations
  ENABLE ALWAYS TRIGGER accounting_case_business_reservation_overlap_trigger;
