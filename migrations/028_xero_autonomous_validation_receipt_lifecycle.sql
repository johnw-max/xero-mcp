SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Upgrade already-migrated databases where 026 was recorded before the
-- autonomous validation receipt lifecycle was corrected. A successful kernel
-- receipt is written at the atomic WRITE_IN_FLIGHT claim and remains immutable
-- evidence through provider/recovery/readback states.
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
