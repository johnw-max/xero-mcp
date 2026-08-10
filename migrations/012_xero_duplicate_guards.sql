-- Scope Xero create idempotency to the trusted actor as well as the bound
-- organisation. OAuth actor IDs are workspace + subject identities, so the
-- same user is protected across Agents without one user blocking another.
ALTER TABLE posting_requests
  DROP CONSTRAINT IF EXISTS posting_requests_tenant_id_request_id_create_operation_key;

CREATE UNIQUE INDEX IF NOT EXISTS posting_requests_actor_tenant_request_create_unique_idx
  ON posting_requests (actor_id, tenant_id, request_id, create_operation);

-- A rejected or validation-blocked request may be corrected and tried again.
-- Every state that may already represent a Xero write, including ambiguous
-- readback, remains active for duplicate prevention.
CREATE UNIQUE INDEX IF NOT EXISTS posting_requests_active_source_unique_idx
  ON posting_requests (actor_id, tenant_id, source_sha256)
  WHERE state IN (
    'VALIDATED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH'
  );

-- provider_payload is the canonical request while VALIDATED and the exact
-- Xero readback afterwards. Support both shapes so the identity is stable
-- across the posting state machine.
CREATE UNIQUE INDEX IF NOT EXISTS posting_requests_active_supplier_reference_unique_idx
  ON posting_requests (
    actor_id,
    tenant_id,
    (lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ))),
    (lower(btrim(provider_payload->>'reference')))
  )
  WHERE state IN (
    'VALIDATED',
    'APPROVAL_PENDING',
    'APPROVED',
    'AUTHORISING',
    'AUTHORISED_READBACK_VERIFIED',
    'WRITE_RESULT_UNKNOWN',
    'READBACK_MISMATCH'
  )
    AND COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL;
