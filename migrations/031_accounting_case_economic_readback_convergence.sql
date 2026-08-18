-- A provider proposal can be canonically identical while its observed money
-- fields differ from the immutable Accounting Case. Permit one narrowly
-- scoped VERIFIED -> MISMATCH convergence so the Case and mutation state
-- machines agree before recovery. Provider evidence is never replaced here;
-- the existing MISMATCH -> VERIFIED transition remains the only correction
-- path and is driven by an exact provider GET.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE xero_mutation_requests
  ADD COLUMN IF NOT EXISTS readback_mismatch_receipt jsonb;

-- Existing mismatch rows predate the discriminator and, by migration 028's
-- validated constraint, can only be payload/status mismatches. Preserve their
-- evidence and add the missing audit classification without changing time or
-- provider observations.
UPDATE xero_mutation_requests
SET readback_mismatch_receipt = jsonb_build_object(
  'receiptType', 'XERO_READBACK_MISMATCH',
  'mismatchType', 'PAYLOAD_OR_STATUS',
  'reasonCodes', CASE
    WHEN readback_payload_hash <> canonical_payload_hash
      AND readback_status <> CASE object_type
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
      THEN jsonb_build_array('CANONICAL_PAYLOAD_HASH_MISMATCH', 'READBACK_STATUS_MISMATCH')
    WHEN readback_payload_hash <> canonical_payload_hash
      THEN jsonb_build_array('CANONICAL_PAYLOAD_HASH_MISMATCH')
    ELSE jsonb_build_array('READBACK_STATUS_MISMATCH')
  END
)
WHERE state = 'READBACK_MISMATCH'
  AND readback_mismatch_receipt IS NULL;

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_request_readback_mismatch_receipt_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_request_lifecycle_check;

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_request_readback_mismatch_receipt_check CHECK (
    readback_mismatch_receipt IS NULL OR (
      jsonb_typeof(readback_mismatch_receipt) = 'object'
      AND readback_mismatch_receipt <> '{}'::jsonb
      AND readback_mismatch_receipt ->> 'receiptType' IN (
        'XERO_READBACK_MISMATCH', 'ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH'
      )
      AND readback_mismatch_receipt ->> 'mismatchType' IN (
        'PAYLOAD_OR_STATUS', 'ACCOUNTING_CASE_ECONOMICS'
      )
      AND jsonb_typeof(readback_mismatch_receipt -> 'reasonCodes') = 'array'
      AND jsonb_array_length(readback_mismatch_receipt -> 'reasonCodes') > 0
    )
  ),
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
        AND readback_mismatch_receipt IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_IN_FLIGHT'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND readback_mismatch_receipt IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_UNCERTAIN'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NOT NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND readback_mismatch_receipt IS NULL
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
        AND readback_mismatch_receipt IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'READBACK_MISMATCH'
        AND write_started_at IS NOT NULL AND verified_at IS NULL AND validation_failed_at IS NULL
        AND xero_object_id IS NOT NULL AND write_receipt IS NOT NULL AND write_receipt <> '{}'::jsonb
        AND readback_snapshot IS NOT NULL AND readback_payload_hash IS NOT NULL
        AND readback_mismatch_receipt IS NOT NULL
        AND (
          (readback_mismatch_receipt ->> 'mismatchType' = 'PAYLOAD_OR_STATUS'
            AND readback_mismatch_receipt ->> 'receiptType' = 'XERO_READBACK_MISMATCH'
            AND (readback_mismatch_receipt -> 'reasonCodes') <@ jsonb_build_array(
              'CANONICAL_PAYLOAD_HASH_MISMATCH', 'READBACK_STATUS_MISMATCH'
            )
            AND (readback_payload_hash <> canonical_payload_hash) =
              ((readback_mismatch_receipt -> 'reasonCodes') ? 'CANONICAL_PAYLOAD_HASH_MISMATCH')
            AND (readback_status <> CASE object_type
                WHEN 'SUPPLIER_BILL' THEN 'DRAFT'
                WHEN 'SALES_INVOICE' THEN 'DRAFT'
                WHEN 'QUOTE' THEN 'DRAFT'
                WHEN 'PURCHASE_ORDER' THEN 'DRAFT'
                WHEN 'CREDIT_NOTE' THEN 'DRAFT'
                WHEN 'MANUAL_JOURNAL' THEN 'DRAFT'
                WHEN 'CONTACT' THEN 'ACTIVE'
                WHEN 'ITEM' THEN 'UNTRACKED'
                WHEN 'ATTACHMENT' THEN 'UPLOADED'
              END) = ((readback_mismatch_receipt -> 'reasonCodes') ? 'READBACK_STATUS_MISMATCH'))
          OR (readback_mismatch_receipt ->> 'mismatchType' = 'ACCOUNTING_CASE_ECONOMICS'
            AND readback_mismatch_receipt ->> 'receiptType' = 'ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH'
            AND source_ref LIKE 'case:%'
            AND object_type IN ('SUPPLIER_BILL', 'SALES_INVOICE', 'CREDIT_NOTE')
            AND readback_payload_hash = canonical_payload_hash
            AND readback_status = 'DRAFT')
        )
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'FAILED_VALIDATION'
        AND write_started_at IS NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NOT NULL AND xero_object_id IS NULL
        AND write_receipt IS NULL AND readback_snapshot IS NULL
        AND readback_mismatch_receipt IS NULL
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'PROVIDER_REJECTED'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND provider_rejected_at IS NOT NULL
        AND xero_object_id IS NOT DISTINCT FROM (
          CASE WHEN operation = 'UPDATE' THEN target_xero_object_id ELSE NULL END
        )
        AND write_receipt IS NULL AND readback_snapshot IS NULL
        AND readback_mismatch_receipt IS NULL
        AND provider_rejection_receipt IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION xero_mutation_request_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_economics_demotion boolean;
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

  case_economics_demotion :=
    OLD.state = 'READBACK_VERIFIED'
    AND NEW.state = 'READBACK_MISMATCH'
    AND OLD.source_ref LIKE 'case:%'
    AND NEW.xero_object_id IS NOT DISTINCT FROM OLD.xero_object_id
    AND NEW.write_receipt IS NOT DISTINCT FROM OLD.write_receipt
    AND NEW.readback_snapshot IS NOT DISTINCT FROM OLD.readback_snapshot
    AND NEW.readback_snapshot_hash IS NOT DISTINCT FROM OLD.readback_snapshot_hash
    AND NEW.readback_canonical_payload IS NOT DISTINCT FROM OLD.readback_canonical_payload
    AND NEW.readback_payload_hash IS NOT DISTINCT FROM OLD.readback_payload_hash
    AND NEW.readback_status IS NOT DISTINCT FROM OLD.readback_status
    AND NEW.validation_receipt IS NOT DISTINCT FROM OLD.validation_receipt
    AND NEW.provider_rejection_receipt IS NOT DISTINCT FROM OLD.provider_rejection_receipt
    AND OLD.readback_mismatch_receipt IS NULL
    AND NEW.readback_mismatch_receipt ->> 'receiptType' = 'ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH'
    AND NEW.readback_mismatch_receipt ->> 'mismatchType' = 'ACCOUNTING_CASE_ECONOMICS'
    AND NEW.write_started_at IS NOT DISTINCT FROM OLD.write_started_at
    AND NEW.write_unknown_at IS NOT DISTINCT FROM OLD.write_unknown_at
    AND NEW.verified_at IS NULL
    AND NEW.validation_failed_at IS NOT DISTINCT FROM OLD.validation_failed_at
    AND NEW.provider_rejected_at IS NOT DISTINCT FROM OLD.provider_rejected_at
    AND NEW.updated_at >= OLD.updated_at
    AND EXISTS (
      SELECT 1
      FROM accounting_case_operations operation_row
      JOIN accounting_case_versions version_row
        ON version_row.case_id = operation_row.case_id
       AND version_row.version = operation_row.case_version
      WHERE ('case:' || operation_row.case_id) = OLD.source_ref
        AND operation_row.operation_id = OLD.source_unit_key
        AND operation_row.preparation_id = OLD.preparation_id
        AND (operation_row.mutation_request_id IS NULL
          OR operation_row.mutation_request_id = OLD.mutation_request_id)
        AND operation_row.action_id IN (
          'customer_invoice.create_draft', 'supplier_bill.create_draft', 'credit_note.create_draft'
        )
        AND operation_row.state IN ('PREPARED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN', 'READBACK_MISMATCH')
        AND version_row.state IN ('EXECUTING', 'RECOVERY_REQUIRED')
        AND version_row.execution_request_id IS NOT NULL
    );

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'CONFIRMED' AND NEW.state IN ('WRITE_IN_FLIGHT', 'FAILED_VALIDATION'))
    OR (OLD.state = 'WRITE_IN_FLIGHT' AND NEW.state IN (
      'WRITE_UNCERTAIN', 'READBACK_VERIFIED', 'READBACK_MISMATCH', 'PROVIDER_REJECTED'
    ))
    OR (OLD.state = 'WRITE_UNCERTAIN' AND NEW.state IN ('READBACK_VERIFIED', 'READBACK_MISMATCH'))
    OR (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED')
    OR case_economics_demotion
  ) THEN
    RAISE EXCEPTION 'invalid xero mutation state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  IF NEW.readback_mismatch_receipt ->> 'mismatchType' = 'ACCOUNTING_CASE_ECONOMICS'
    AND NOT (
      case_economics_demotion
      OR (OLD.state = 'READBACK_MISMATCH'
        AND NEW.state = 'READBACK_MISMATCH'
        AND NEW.readback_mismatch_receipt IS NOT DISTINCT FROM OLD.readback_mismatch_receipt)
    )
  THEN
    RAISE EXCEPTION 'Accounting Case economic mismatch must originate from the verified projection gate'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('READBACK_VERIFIED', 'READBACK_MISMATCH', 'FAILED_VALIDATION', 'PROVIDER_REJECTED')
    AND NOT case_economics_demotion
    AND NOT (OLD.state = 'READBACK_MISMATCH' AND NEW.state = 'READBACK_VERIFIED')
    AND ROW(
      NEW.state, NEW.xero_object_id, NEW.write_receipt, NEW.readback_snapshot,
      NEW.readback_snapshot_hash, NEW.readback_canonical_payload, NEW.readback_payload_hash,
      NEW.readback_status, NEW.readback_mismatch_receipt,
      NEW.validation_receipt, NEW.provider_rejection_receipt,
      NEW.write_started_at, NEW.write_unknown_at, NEW.verified_at,
      NEW.validation_failed_at, NEW.provider_rejected_at, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.xero_object_id, OLD.write_receipt, OLD.readback_snapshot,
      OLD.readback_snapshot_hash, OLD.readback_canonical_payload, OLD.readback_payload_hash,
      OLD.readback_status, OLD.readback_mismatch_receipt,
      OLD.validation_receipt, OLD.provider_rejection_receipt,
      OLD.write_started_at, OLD.write_unknown_at, OLD.verified_at,
      OLD.validation_failed_at, OLD.provider_rejected_at, OLD.updated_at
    )
  THEN
    RAISE EXCEPTION 'terminal xero mutation evidence cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
