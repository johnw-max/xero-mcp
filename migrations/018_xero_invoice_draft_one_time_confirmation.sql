-- Bring Supplier Bill and Sales Invoice DRAFT creation under the same
-- tenant/source/payload-bound, one-time preparation control plane as the
-- other controlled Xero mutations.
SET LOCAL lock_timeout = '5s';

ALTER TABLE xero_mutation_preparations
  DROP CONSTRAINT IF EXISTS xero_mutation_preparations_object_type_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_preparation_operation_check;

ALTER TABLE xero_mutation_preparations
  ADD CONSTRAINT xero_mutation_preparations_object_type_check CHECK (object_type IN (
    'SUPPLIER_BILL', 'SALES_INVOICE', 'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE',
    'MANUAL_JOURNAL', 'CONTACT', 'ITEM', 'ATTACHMENT'
  )),
  ADD CONSTRAINT xero_mutation_preparation_operation_check CHECK (
    (object_type IN (
      'SUPPLIER_BILL', 'SALES_INVOICE', 'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL'
    ) AND operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
  );

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_requests_object_type_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_request_operation_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_request_lifecycle_check;

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_requests_object_type_check CHECK (object_type IN (
    'SUPPLIER_BILL', 'SALES_INVOICE', 'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE',
    'MANUAL_JOURNAL', 'CONTACT', 'ITEM', 'ATTACHMENT'
  )),
  ADD CONSTRAINT xero_mutation_request_operation_check CHECK (
    (object_type IN (
      'SUPPLIER_BILL', 'SALES_INVOICE', 'QUOTE', 'PURCHASE_ORDER', 'CREDIT_NOTE', 'MANUAL_JOURNAL'
    ) AND operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
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
        AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_IN_FLIGHT'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
      OR (state = 'WRITE_UNCERTAIN'
        AND write_started_at IS NOT NULL AND write_unknown_at IS NOT NULL AND verified_at IS NULL
        AND validation_failed_at IS NULL AND readback_snapshot IS NULL AND readback_payload_hash IS NULL
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
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
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
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
        AND validation_receipt IS NULL AND provider_rejected_at IS NULL AND provider_rejection_receipt IS NULL)
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
        AND validation_receipt IS NULL AND provider_rejection_receipt IS NOT NULL)
    )
  );
