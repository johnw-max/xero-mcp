-- Add a provider-neutral collision coordinate and overlap scope without
-- rewriting migration 033.  This gives already-applied 033 databases the same
-- formal/generic classification-flip protection as fresh installations.
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounting_case_operations
  ADD COLUMN IF NOT EXISTS business_reservation jsonb,
  ADD COLUMN IF NOT EXISTS business_reservation_coordinate jsonb,
  ADD COLUMN IF NOT EXISTS business_reservation_coordinate_hash text,
  ADD COLUMN IF NOT EXISTS business_reservation_scope text,
  ADD COLUMN IF NOT EXISTS business_reservation_occurrence_date date;

-- Current operation JSON is authoritative. Older 033 rows are conservatively
-- projected from their provider payload: a typed counterparty tuple is only
-- resolution evidence, so the resolved provider contact ID is always the
-- document coordinate.
UPDATE accounting_case_operations
SET business_reservation = COALESCE(
  operation_json -> 'businessReservation',
  CASE WHEN action_id = 'contact.create_basic' THEN
    jsonb_build_object(
      'schemaVersion', 'accounting-case-business-reservation:v1',
      'providerId', COALESCE(business_identity ->> 'providerId', 'xero'),
      'kind', business_identity ->> 'kind',
      'canonicalFields', business_identity -> 'canonicalFields',
      'coordinateHash', business_identity_hash,
      'scope', 'ALL_OCCURRENCES'
    )
  ELSE
    jsonb_strip_nulls(jsonb_build_object(
      'schemaVersion', 'accounting-case-business-reservation:v1',
      'providerId', COALESCE(business_identity ->> 'providerId', 'xero'),
      'kind', 'LEDGER_DOCUMENT_OCCURRENCE',
      'canonicalFields', jsonb_build_object(
        'route', COALESCE(business_identity -> 'canonicalFields' -> 'route', to_jsonb(native_route)),
        'contactId', CASE WHEN canonical_payload ? 'xeroContactId'
          THEN canonical_payload -> 'xeroContactId' ELSE to_jsonb(NULL::text) END,
        'reference', COALESCE(
          business_identity -> 'canonicalFields' -> 'reference',
          to_jsonb(upper(btrim(canonical_payload ->> 'reference')))
        )
      ),
      -- Historical rows have no reservation hash. It remains an integrity
      -- field, while overlap and advisory locking use the canonical JSON below.
      'coordinateHash', business_identity_hash,
      'scope', CASE WHEN
        business_identity ->> 'kind' = 'LEDGER_RECURRING_REFERENCE_OCCURRENCE'
        OR canonical_payload ->> 'referenceKind' = 'GENERIC_RECURRING_REFERENCE'
        THEN 'DATED_OCCURRENCE' ELSE 'ALL_OCCURRENCES' END,
      'occurrenceDate', CASE WHEN
        business_identity ->> 'kind' = 'LEDGER_RECURRING_REFERENCE_OCCURRENCE'
        OR canonical_payload ->> 'referenceKind' = 'GENERIC_RECURRING_REFERENCE'
        THEN canonical_payload ->> 'documentDate' ELSE NULL END
    ))
  END
)
WHERE business_reservation IS NULL;

UPDATE accounting_case_operations
SET business_reservation_coordinate = jsonb_build_object(
      'schemaVersion', business_reservation -> 'schemaVersion',
      'providerId', business_reservation -> 'providerId',
      'kind', business_reservation -> 'kind',
      'canonicalFields', business_reservation -> 'canonicalFields'
    ),
    business_reservation_coordinate_hash = business_reservation ->> 'coordinateHash',
    business_reservation_scope = business_reservation ->> 'scope',
    business_reservation_occurrence_date = CASE
      WHEN business_reservation ->> 'scope' = 'DATED_OCCURRENCE'
      THEN (business_reservation ->> 'occurrenceDate')::date
      ELSE NULL
    END
WHERE business_reservation_coordinate IS NULL
   OR business_reservation_coordinate_hash IS NULL
   OR business_reservation_scope IS NULL;

ALTER TABLE accounting_case_operations
  ALTER COLUMN business_reservation SET NOT NULL,
  ALTER COLUMN business_reservation_coordinate SET NOT NULL,
  ALTER COLUMN business_reservation_coordinate_hash SET NOT NULL,
  ALTER COLUMN business_reservation_scope SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_case_business_reservation_check'
      AND conrelid = 'accounting_case_operations'::regclass
  ) THEN
    ALTER TABLE accounting_case_operations
      ADD CONSTRAINT accounting_case_business_reservation_check CHECK (
        jsonb_typeof(business_reservation) = 'object'
        AND jsonb_typeof(business_reservation_coordinate) = 'object'
        AND business_reservation_coordinate_hash ~ '^[0-9a-f]{64}$'
        AND business_reservation_scope IN ('ALL_OCCURRENCES', 'DATED_OCCURRENCE')
        AND business_reservation_coordinate = jsonb_build_object(
          'schemaVersion', business_reservation -> 'schemaVersion',
          'providerId', business_reservation -> 'providerId',
          'kind', business_reservation -> 'kind',
          'canonicalFields', business_reservation -> 'canonicalFields'
        )
        AND business_reservation ->> 'coordinateHash' = business_reservation_coordinate_hash
        AND business_reservation ->> 'scope' = business_reservation_scope
        AND (
          (business_reservation_scope = 'ALL_OCCURRENCES'
            AND business_reservation_occurrence_date IS NULL
            AND NOT (business_reservation ? 'occurrenceDate'))
          OR
          (business_reservation_scope = 'DATED_OCCURRENCE'
            AND business_reservation_occurrence_date IS NOT NULL
            AND (business_reservation ->> 'occurrenceDate')::date = business_reservation_occurrence_date)
        )
        AND (
          operation_json -> 'businessReservation' IS NULL
          OR operation_json -> 'businessReservation' = business_reservation
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS accounting_case_business_reservation_lookup_idx
  ON accounting_case_operations (
    tenant_id, action_id, business_reservation_coordinate,
    business_reservation_scope, business_reservation_occurrence_date
  )
  WHERE state IN (
    'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
    'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
  );

CREATE OR REPLACE FUNCTION enforce_accounting_case_business_reservation_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state NOT IN (
    'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
    'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
  ) THEN
    RETURN NEW;
  END IF;

  -- JSONB text has a deterministic key order. Lock the actual coordinate, not
  -- a legacy hash, so pre-035 and current rows serialize on the same key.
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
  state, tenant_id, action_id, business_reservation_coordinate,
  business_reservation_coordinate_hash, business_reservation_scope,
  business_reservation_occurrence_date
ON accounting_case_operations
FOR EACH ROW
EXECUTE FUNCTION enforce_accounting_case_business_reservation_overlap();

-- Replication-role writes must not be able to bypass ledger reservations.
ALTER TABLE accounting_case_operations
  ENABLE ALWAYS TRIGGER accounting_case_business_reservation_overlap_trigger;
