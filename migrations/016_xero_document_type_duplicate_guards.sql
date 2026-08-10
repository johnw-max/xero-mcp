-- Generalise the controlled-draft idempotency model from AP-only to explicit
-- ACCPAY/ACCREC operation kinds. Legacy rows are AP supplier bills.
--
-- Source hashes intentionally remain tenant-global: one source document must
-- never be interpreted once as AP and once as AR. Request IDs are type-scoped.
-- Contact + supplier reference remains a hard identity only for ACCPAY: Xero's
-- ACCREC Reference is an additional customer reference and may be reused across
-- distinct sales invoices.
SET LOCAL lock_timeout = '5s';

ALTER TABLE posting_requests
  ADD COLUMN document_type text NOT NULL DEFAULT 'ACCPAY'
  CONSTRAINT posting_requests_document_type_check
  CHECK (document_type IN ('ACCPAY', 'ACCREC'));

ALTER TABLE posting_requests
  DROP CONSTRAINT posting_requests_state_check,
  ADD CONSTRAINT posting_requests_state_check CHECK (state IN (
    'VALIDATED', 'DRAFT_READBACK_VERIFIED', 'APPROVAL_PENDING', 'APPROVED', 'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED', 'REJECTED', 'BLOCKED_VALIDATION',
    'WRITE_RESULT_UNKNOWN', 'READBACK_MISMATCH'
  ));

DROP INDEX IF EXISTS posting_requests_actor_tenant_request_create_unique_idx;
DROP INDEX IF EXISTS posting_requests_active_source_unique_idx;
DROP INDEX IF EXISTS posting_requests_active_supplier_reference_unique_idx;
DROP INDEX IF EXISTS posting_requests_tenant_active_source_unique_idx;
DROP INDEX IF EXISTS posting_requests_tenant_active_supplier_reference_unique_idx;

CREATE UNIQUE INDEX posting_requests_actor_tenant_request_create_unique_idx
  ON posting_requests (actor_id, tenant_id, document_type, request_id, create_operation);

CREATE UNIQUE INDEX posting_requests_active_source_unique_idx
  ON posting_requests (actor_id, tenant_id, source_sha256)
  WHERE state IN (
    'VALIDATED',
    'DRAFT_READBACK_VERIFIED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH',
    'REJECTED'
  );

CREATE UNIQUE INDEX posting_requests_active_supplier_reference_unique_idx
  ON posting_requests (
    actor_id,
    tenant_id,
    document_type,
    (lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ))),
    (lower(btrim(provider_payload->>'reference')))
  )
  WHERE state IN (
    'VALIDATED',
    'DRAFT_READBACK_VERIFIED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH',
    'REJECTED'
  )
    AND document_type = 'ACCPAY'
    AND COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL;

CREATE UNIQUE INDEX posting_requests_tenant_active_source_unique_idx
  ON posting_requests (tenant_id, source_sha256)
  WHERE state IN (
    'VALIDATED',
    'DRAFT_READBACK_VERIFIED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH',
    'REJECTED'
  );

CREATE UNIQUE INDEX posting_requests_tenant_active_supplier_reference_unique_idx
  ON posting_requests (
    tenant_id,
    document_type,
    (lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ))),
    (lower(btrim(provider_payload->>'reference')))
  )
  WHERE state IN (
    'VALIDATED',
    'DRAFT_READBACK_VERIFIED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH',
    'REJECTED'
  )
    AND document_type = 'ACCPAY'
    AND COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL;
