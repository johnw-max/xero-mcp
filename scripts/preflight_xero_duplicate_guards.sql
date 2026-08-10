\set ON_ERROR_STOP on
\pset pager off

-- This deployment gate is intentionally read-only. It reports every active
-- Xero cross-actor business-identity collision that would block migration 016,
-- every exact legacy-index conflict that would block migration 020, and every
-- duplicate ACTIVE MCP refresh family that would block migration 019. It never
-- deletes, changes, merges, or chooses a winning row.
SELECT (to_regclass('public.posting_requests') IS NOT NULL) AS xero_posting_requests_exists
\gset

\if :xero_posting_requests_exists
BEGIN TRANSACTION READ ONLY;

\echo 'Xero duplicate-guard preflight: historical cross-actor active duplicate groups'
WITH active_rows AS (
  SELECT
    posting_request_id,
    actor_id,
    tenant_id,
    source_sha256,
    state,
    created_at,
    lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    )) AS contact_id,
    lower(NULLIF(btrim(provider_payload->>'reference'), '')) AS normalized_reference
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
), duplicate_groups AS (
  SELECT
    'SOURCE_SHA256'::text AS identity_type,
    tenant_id,
    source_sha256 AS identity_fingerprint,
    count(*)::integer AS row_count,
    array_agg(DISTINCT actor_id ORDER BY actor_id) AS actor_ids,
    array_agg(posting_request_id ORDER BY created_at, posting_request_id) AS posting_request_ids,
    array_agg(state ORDER BY created_at, posting_request_id) AS states
  FROM active_rows
  GROUP BY tenant_id, source_sha256
  HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1

  UNION ALL

  SELECT
    'CONTACT_REFERENCE'::text AS identity_type,
    tenant_id,
    md5(contact_id || chr(31) || normalized_reference) AS identity_fingerprint,
    count(*)::integer AS row_count,
    array_agg(DISTINCT actor_id ORDER BY actor_id) AS actor_ids,
    array_agg(posting_request_id ORDER BY created_at, posting_request_id) AS posting_request_ids,
    array_agg(state ORDER BY created_at, posting_request_id) AS states
  FROM active_rows
  WHERE contact_id IS NOT NULL AND normalized_reference IS NOT NULL
  GROUP BY tenant_id, contact_id, normalized_reference
  HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1
)
SELECT
  identity_type,
  tenant_id,
  identity_fingerprint,
  row_count,
  actor_ids,
  posting_request_ids,
  states
FROM duplicate_groups
ORDER BY identity_type, tenant_id, identity_fingerprint;

WITH active_rows AS (
  SELECT
    actor_id,
    tenant_id,
    source_sha256,
    lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    )) AS contact_id,
    lower(NULLIF(btrim(provider_payload->>'reference'), '')) AS normalized_reference
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
), duplicate_groups AS (
  SELECT 1
  FROM active_rows
  GROUP BY tenant_id, source_sha256
  HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1

  UNION ALL

  SELECT 1
  FROM active_rows
  WHERE contact_id IS NOT NULL AND normalized_reference IS NOT NULL
  GROUP BY tenant_id, contact_id, normalized_reference
  HAVING count(*) > 1 AND count(DISTINCT actor_id) > 1
)
SELECT
  (count(*) = 0) AS xero_duplicate_preflight_safe,
  count(*) AS xero_duplicate_preflight_group_count
FROM duplicate_groups
\gset

ROLLBACK;

\if :xero_duplicate_preflight_safe
  \echo 'PASS: no historical cross-actor active Xero duplicate groups; migration may proceed.'
\else
  \echo 'BLOCKED: found' :xero_duplicate_preflight_group_count 'historical active Xero duplicate group(s).'
  \echo 'Do not deploy migration 016 and do not auto-delete or merge accounting records.'
  -- ON_ERROR_STOP converts this deliberate read-only error into psql exit 3.
  -- PostgreSQL 17's \quit command does not accept an exit-code argument.
  SELECT 1 / 0 AS xero_duplicate_preflight_blocked;
\endif
\else
  \echo 'PASS: posting_requests does not exist yet; there is no historical Xero data to collide.'
\endif

SELECT (to_regclass('public.posting_requests') IS NOT NULL) AS xero_migration_020_table_exists
\gset

\if :xero_migration_020_table_exists
BEGIN TRANSACTION READ ONLY;

\echo 'Migration 020 exact-legacy-index preflight: every conflict, including same-actor, ACCREC, and cross-document-type rows'
WITH all_rows AS (
  SELECT
    posting_request_id,
    actor_id,
    tenant_id,
    request_id,
    create_operation,
    source_sha256,
    state,
    created_at,
    COALESCE(to_jsonb(posting_requests)->>'document_type', 'ACCPAY') AS document_type,
    lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    )) AS contact_id,
    lower(NULLIF(btrim(provider_payload->>'reference'), '')) AS normalized_reference
  FROM posting_requests
), legacy_active_rows AS (
  SELECT *
  FROM all_rows
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
), duplicate_groups AS (
  SELECT
    'ACTOR_TENANT_REQUEST_CREATE'::text AS identity_type,
    actor_id AS scoped_actor_id,
    tenant_id,
    md5(request_id || chr(31) || create_operation) AS identity_fingerprint,
    count(*)::integer AS row_count,
    array_agg(DISTINCT actor_id ORDER BY actor_id) AS actor_ids,
    array_agg(DISTINCT document_type ORDER BY document_type) AS document_types,
    array_agg(posting_request_id ORDER BY created_at, posting_request_id) AS posting_request_ids,
    array_agg(state ORDER BY created_at, posting_request_id) AS states
  FROM all_rows
  GROUP BY actor_id, tenant_id, request_id, create_operation
  HAVING count(*) > 1

  UNION ALL

  SELECT
    'LEGACY_TENANT_SOURCE_SHA256'::text AS identity_type,
    NULL::text AS scoped_actor_id,
    tenant_id,
    source_sha256 AS identity_fingerprint,
    count(*)::integer AS row_count,
    array_agg(DISTINCT actor_id ORDER BY actor_id) AS actor_ids,
    array_agg(DISTINCT document_type ORDER BY document_type) AS document_types,
    array_agg(posting_request_id ORDER BY created_at, posting_request_id) AS posting_request_ids,
    array_agg(state ORDER BY created_at, posting_request_id) AS states
  FROM legacy_active_rows
  GROUP BY tenant_id, source_sha256
  HAVING count(*) > 1

  UNION ALL

  SELECT
    'LEGACY_TENANT_CONTACT_REFERENCE'::text AS identity_type,
    NULL::text AS scoped_actor_id,
    tenant_id,
    md5(contact_id || chr(31) || normalized_reference) AS identity_fingerprint,
    count(*)::integer AS row_count,
    array_agg(DISTINCT actor_id ORDER BY actor_id) AS actor_ids,
    array_agg(DISTINCT document_type ORDER BY document_type) AS document_types,
    array_agg(posting_request_id ORDER BY created_at, posting_request_id) AS posting_request_ids,
    array_agg(state ORDER BY created_at, posting_request_id) AS states
  FROM legacy_active_rows
  WHERE contact_id IS NOT NULL AND normalized_reference IS NOT NULL
  GROUP BY tenant_id, contact_id, normalized_reference
  HAVING count(*) > 1
)
SELECT
  identity_type,
  scoped_actor_id,
  tenant_id,
  identity_fingerprint,
  row_count,
  actor_ids,
  document_types,
  posting_request_ids,
  states
FROM duplicate_groups
ORDER BY identity_type, tenant_id, scoped_actor_id NULLS FIRST, identity_fingerprint;

WITH all_rows AS (
  SELECT
    actor_id,
    tenant_id,
    request_id,
    create_operation,
    source_sha256,
    state,
    lower(COALESCE(
      NULLIF(btrim(provider_payload->>'contactId'), ''),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'), '')
    )) AS contact_id,
    lower(NULLIF(btrim(provider_payload->>'reference'), '')) AS normalized_reference
  FROM posting_requests
), legacy_active_rows AS (
  SELECT *
  FROM all_rows
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
), duplicate_groups AS (
  SELECT 1
  FROM all_rows
  GROUP BY actor_id, tenant_id, request_id, create_operation
  HAVING count(*) > 1

  UNION ALL

  SELECT 1
  FROM legacy_active_rows
  GROUP BY tenant_id, source_sha256
  HAVING count(*) > 1

  UNION ALL

  SELECT 1
  FROM legacy_active_rows
  WHERE contact_id IS NOT NULL AND normalized_reference IS NOT NULL
  GROUP BY tenant_id, contact_id, normalized_reference
  HAVING count(*) > 1
)
SELECT
  (count(*) = 0) AS xero_migration_020_preflight_safe,
  count(*) AS xero_migration_020_preflight_group_count
FROM duplicate_groups
\gset

ROLLBACK;

\if :xero_migration_020_preflight_safe
  \echo 'PASS: exact migration 020 legacy index definitions have zero historical conflict groups.'
\else
  \echo 'BLOCKED: found' :xero_migration_020_preflight_group_count 'exact legacy-index conflict group(s).'
  \echo 'Do not deploy migration 020 and do not auto-delete, merge, reclassify, or choose a winning accounting record.'
  SELECT 1 / 0 AS xero_migration_020_preflight_blocked;
\endif
\else
  \echo 'PASS: posting_requests does not exist yet; migration 020 has no historical legacy-index conflict.'
\endif

SELECT (to_regclass('public.mcp_refresh_token_families') IS NOT NULL) AS mcp_refresh_token_families_exists
\gset

\if :mcp_refresh_token_families_exists
BEGIN TRANSACTION READ ONLY;

\echo 'MCP refresh-family preflight: multiple ACTIVE families for one OAuth installation'
SELECT
  oauth_installation_id,
  count(*)::integer AS active_family_count,
  array_agg(family_id ORDER BY family_id) AS active_family_ids
FROM mcp_refresh_token_families
WHERE family_status = 'ACTIVE'
GROUP BY oauth_installation_id
HAVING count(*) > 1
ORDER BY oauth_installation_id;

SELECT
  (count(*) = 0) AS refresh_family_preflight_safe,
  count(*) AS refresh_family_conflict_count
FROM (
  SELECT 1
  FROM mcp_refresh_token_families
  WHERE family_status = 'ACTIVE'
  GROUP BY oauth_installation_id
  HAVING count(*) > 1
) AS conflicts
\gset

ROLLBACK;

\if :refresh_family_preflight_safe
  \echo 'PASS: no OAuth installation has multiple ACTIVE refresh families; migration 019 may proceed.'
\else
  \echo 'BLOCKED: found' :refresh_family_conflict_count 'OAuth installation(s) with multiple ACTIVE refresh families.'
  \echo 'Do not deploy migration 019 and do not auto-delete, revoke, or choose a winning family.'
  SELECT 1 / 0 AS refresh_family_preflight_blocked;
\endif
\else
  \echo 'PASS: mcp_refresh_token_families does not exist yet; migration 019 has no historical family conflict.'
\endif
