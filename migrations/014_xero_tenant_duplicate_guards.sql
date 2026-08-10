-- Business-document identity belongs to the Xero organisation, not to the
-- individual actor who submitted it. Before adding either uniqueness guard,
-- fail closed on cross-actor history. Operators must investigate conflicts;
-- this migration never deletes, updates, merges, or selects a winning row.
--
-- This is an expand-only migration: the actor-scoped 012/013 indexes remain
-- intact for binary rollback. The new release requires the tenant indexes,
-- while the previous release can continue to verify its original indexes.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM posting_requests
    WHERE state IN (
      'VALIDATED',
      'APPROVAL_PENDING',
      'APPROVED',
      'AUTHORISING',
      'AUTHORISED_READBACK_VERIFIED',
      'WRITE_RESULT_UNKNOWN',
      'READBACK_MISMATCH',
      'REJECTED'
    )
    GROUP BY tenant_id, source_sha256
    HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1
  ) OR EXISTS (
    SELECT 1
    FROM posting_requests
    WHERE state IN (
      'VALIDATED',
      'APPROVAL_PENDING',
      'APPROVED',
      'AUTHORISING',
      'AUTHORISED_READBACK_VERIFIED',
      'WRITE_RESULT_UNKNOWN',
      'READBACK_MISMATCH',
      'REJECTED'
    )
      AND COALESCE(
        NULLIF(btrim(provider_payload->>'contactId'), ''),
        NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
      ) IS NOT NULL
      AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL
    GROUP BY
      tenant_id,
      lower(COALESCE(
        NULLIF(btrim(provider_payload->>'contactId'), ''),
        NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
      )),
      lower(btrim(provider_payload->>'reference'))
    HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'Xero tenant duplicate-guard migration blocked by historical cross-actor conflicts.',
      HINT = 'Run scripts/preflight_xero_duplicate_guards.sql and investigate every group; do not auto-delete or merge accounting records.';
  END IF;
END $$;

CREATE UNIQUE INDEX posting_requests_tenant_active_source_unique_idx
  ON posting_requests (tenant_id, source_sha256)
  WHERE state IN (
    'VALIDATED',
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
    'READBACK_MISMATCH',
    'REJECTED'
  )
    AND COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL;
