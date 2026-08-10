-- Forward hardening for databases that applied the first version of migration
-- 012 before REJECTED was recognized as an active business-document identity.
-- Never clean up conflicting history automatically: fail before replacing any
-- index and require an operator to investigate the reported groups using the
-- read-only deployment preflight.
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
    GROUP BY actor_id, tenant_id, source_sha256
    HAVING count(*) > 1
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
      actor_id,
      tenant_id,
      lower(COALESCE(
        NULLIF(btrim(provider_payload->>'contactId'), ''),
        NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
      )),
      lower(btrim(provider_payload->>'reference'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'Xero duplicate-guard migration blocked by historical active duplicate groups.',
      HINT = 'Run scripts/preflight_xero_duplicate_guards.sql and investigate every group; do not auto-delete or merge accounting records.';
  END IF;
END $$;

DROP INDEX IF EXISTS posting_requests_active_source_unique_idx;
DROP INDEX IF EXISTS posting_requests_active_supplier_reference_unique_idx;

CREATE UNIQUE INDEX posting_requests_active_source_unique_idx
  ON posting_requests (actor_id, tenant_id, source_sha256)
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

CREATE UNIQUE INDEX posting_requests_active_supplier_reference_unique_idx
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
    'READBACK_MISMATCH',
    'REJECTED'
  )
    AND COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload->>'reference'), '') IS NOT NULL;
