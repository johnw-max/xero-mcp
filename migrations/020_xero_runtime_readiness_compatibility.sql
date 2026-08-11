-- Preserve the document-type/DRAFT-aware 0.3 duplicate guards under explicit
-- versioned names, then restore the five distinct catalog definitions checked
-- by Xero 0.2.13. Both generations remain valid and enforced so a rolling
-- Xero deployment can run either binary.
--
-- Migration execution is transactional. If any legacy definition conflicts
-- with rows admitted since 016, index creation fails closed and all preceding
-- renames roll back; this migration never selects or rewrites accounting data.
SET LOCAL lock_timeout = '5s';

-- Do not turn unknown catalog drift into a successfully recorded compatibility
-- migration. The five names below must still be the exact 016 definitions
-- before any rename occurs; otherwise an operator must investigate explicitly.
DO $migration$
DECLARE
  v030_active_predicate text := $predicate$
    state = ANY (ARRAY[
      'VALIDATED'::text,
      'DRAFT_READBACK_VERIFIED'::text,
      'APPROVAL_PENDING'::text,
      'APPROVED'::text,
      'AUTHORISING'::text,
      'AUTHORISED_READBACK_VERIFIED'::text,
      'WRITE_RESULT_UNKNOWN'::text,
      'READBACK_MISMATCH'::text,
      'REJECTED'::text
    ])
  $predicate$;
  v030_supplier_predicate text := $predicate$
    (state = ANY (ARRAY[
      'VALIDATED'::text,
      'DRAFT_READBACK_VERIFIED'::text,
      'APPROVAL_PENDING'::text,
      'APPROVED'::text,
      'AUTHORISING'::text,
      'AUTHORISED_READBACK_VERIFIED'::text,
      'WRITE_RESULT_UNKNOWN'::text,
      'READBACK_MISMATCH'::text,
      'REJECTED'::text
    ]))
    AND document_type = 'ACCPAY'::text
    AND COALESCE(
      NULLIF(btrim(provider_payload ->> 'contactId'::text), ''::text),
      NULLIF(btrim(provider_payload #>> '{contact,contactId}'::text[]), ''::text)
    ) IS NOT NULL
    AND NULLIF(btrim(provider_payload ->> 'reference'::text), ''::text) IS NOT NULL
  $predicate$;
  exact_source_index_count integer;
BEGIN
  WITH source_indexes AS (
    SELECT
      index_class.relname AS index_name,
      ARRAY(
        SELECT regexp_replace(
          lower(pg_get_indexdef(index_meta.indexrelid, key_position, true)),
          '[[:space:]]+',
          '',
          'g'
        )
        FROM generate_series(1, index_meta.indnatts) AS key_position
        ORDER BY key_position
      ) AS normalized_keys,
      regexp_replace(
        lower(pg_get_expr(index_meta.indpred, index_meta.indrelid, true)),
        '[[:space:]]+',
        '',
        'g'
      ) AS normalized_predicate
    FROM pg_index index_meta
    JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
    JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    WHERE table_class.oid = 'posting_requests'::regclass
      AND table_namespace.nspname = current_schema()
      AND index_class.relname IN (
        'posting_requests_actor_tenant_request_create_unique_idx',
        'posting_requests_active_source_unique_idx',
        'posting_requests_active_supplier_reference_unique_idx',
        'posting_requests_tenant_active_source_unique_idx',
        'posting_requests_tenant_active_supplier_reference_unique_idx'
      )
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND access_method.amname = 'btree'
  )
  SELECT count(*)::integer
  INTO exact_source_index_count
  FROM source_indexes
  WHERE CASE index_name
    WHEN 'posting_requests_actor_tenant_request_create_unique_idx' THEN
      normalized_keys = ARRAY[
        'actor_id', 'tenant_id', 'document_type', 'request_id', 'create_operation'
      ]
      AND normalized_predicate IS NULL
    WHEN 'posting_requests_active_source_unique_idx' THEN
      normalized_keys = ARRAY['actor_id', 'tenant_id', 'source_sha256']
      AND normalized_predicate = regexp_replace(
        lower(v030_active_predicate), '[[:space:]]+', '', 'g'
      )
    WHEN 'posting_requests_active_supplier_reference_unique_idx' THEN
      normalized_keys = ARRAY[
        'actor_id',
        'tenant_id',
        'document_type',
        'lower(coalesce(nullif(btrim(provider_payload->>''contactid''::text),''''::text),nullif(btrim(provider_payload#>>''{contact,contactid}''::text[]),''''::text)))',
        'lower(btrim(provider_payload->>''reference''::text))'
      ]
      AND normalized_predicate = regexp_replace(
        lower(v030_supplier_predicate), '[[:space:]]+', '', 'g'
      )
    WHEN 'posting_requests_tenant_active_source_unique_idx' THEN
      normalized_keys = ARRAY['tenant_id', 'source_sha256']
      AND normalized_predicate = regexp_replace(
        lower(v030_active_predicate), '[[:space:]]+', '', 'g'
      )
    WHEN 'posting_requests_tenant_active_supplier_reference_unique_idx' THEN
      normalized_keys = ARRAY[
        'tenant_id',
        'document_type',
        'lower(coalesce(nullif(btrim(provider_payload->>''contactid''::text),''''::text),nullif(btrim(provider_payload#>>''{contact,contactid}''::text[]),''''::text)))',
        'lower(btrim(provider_payload->>''reference''::text))'
      ]
      AND normalized_predicate = regexp_replace(
        lower(v030_supplier_predicate), '[[:space:]]+', '', 'g'
      )
    ELSE false
  END;

  IF exact_source_index_count <> 5 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'object_not_in_prerequisite_state',
      MESSAGE = 'Xero migration 020 requires the exact migration 016 source indexes before compatibility expansion.',
      HINT = 'Stop deployment and inspect pg_index/pg_get_indexdef; do not auto-rename, drop, or rebuild drifted accounting indexes.';
  END IF;
END
$migration$;

ALTER INDEX posting_requests_actor_tenant_request_create_unique_idx
  RENAME TO posting_requests_actor_tenant_request_create_v030_unique_idx;
ALTER INDEX posting_requests_active_source_unique_idx
  RENAME TO posting_requests_active_source_v030_unique_idx;
ALTER INDEX posting_requests_active_supplier_reference_unique_idx
  RENAME TO posting_requests_active_supplier_ref_v030_unique_idx;
ALTER INDEX posting_requests_tenant_active_source_unique_idx
  RENAME TO posting_requests_tenant_active_source_v030_unique_idx;
ALTER INDEX posting_requests_tenant_active_supplier_reference_unique_idx
  RENAME TO posting_requests_tenant_active_supplier_ref_v030_unique_idx;

CREATE UNIQUE INDEX posting_requests_actor_tenant_request_create_unique_idx
  ON posting_requests (actor_id, tenant_id, request_id, create_operation);

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
