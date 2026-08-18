-- Reserve the immutable business identity of every governed Accounting Case
-- write across Case IDs and versions.  Case/request/source identities are
-- provenance and replay coordinates; they must never be usable to recreate an
-- already reserved accounting transaction.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_cases_case_tenant_unique'
      AND conrelid = 'accounting_cases'::regclass
  ) THEN
    ALTER TABLE accounting_cases
      ADD CONSTRAINT accounting_cases_case_tenant_unique UNIQUE (case_id, tenant_id);
  END IF;
END $$;

ALTER TABLE accounting_case_operations
  ADD COLUMN IF NOT EXISTS tenant_id text,
  ADD COLUMN IF NOT EXISTS business_identity jsonb,
  ADD COLUMN IF NOT EXISTS business_identity_hash text;

UPDATE accounting_case_operations operation_row
SET tenant_id = case_row.tenant_id
FROM accounting_cases case_row
WHERE case_row.case_id = operation_row.case_id
  AND operation_row.tenant_id IS NULL;

-- Existing rows predate the provider-owned business-identity contract.  They
-- retain the conservative exact-payload identity rather than being silently
-- reclassified by a migration.  New rows carry the v1 projection in their
-- immutable operation JSON.
UPDATE accounting_case_operations
SET business_identity = COALESCE(
      operation_json -> 'businessIdentity',
      jsonb_build_object(
        'schemaVersion', 'accounting-case-business-identity:legacy-exact-payload-v0',
        'providerId', 'xero',
        'kind', 'LEGACY_EXACT_PAYLOAD',
        'canonicalFields', jsonb_build_object('canonicalPayloadHash', canonical_payload_hash)
      )
    ),
    business_identity_hash = COALESCE(
      operation_json ->> 'businessIdentityHash',
      canonical_payload_hash
    )
WHERE business_identity IS NULL OR business_identity_hash IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_case_operations WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'Accounting Case business-reservation migration found operations without a tenant.';
  END IF;
END $$;

ALTER TABLE accounting_case_operations
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN business_identity SET NOT NULL,
  ALTER COLUMN business_identity_hash SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_case_operation_business_identity_check'
      AND conrelid = 'accounting_case_operations'::regclass
  ) THEN
    ALTER TABLE accounting_case_operations
      ADD CONSTRAINT accounting_case_operation_business_identity_check CHECK (
        jsonb_typeof(business_identity) = 'object'
        AND business_identity <> '{}'::jsonb
        AND business_identity_hash ~ '^[0-9a-f]{64}$'
        AND (
          (
            operation_json -> 'businessIdentity' = business_identity
            AND operation_json ->> 'businessIdentityHash' = business_identity_hash
          )
          OR business_identity ->> 'schemaVersion'
            = 'accounting-case-business-identity:legacy-exact-payload-v0'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_case_operations_case_tenant_fk'
      AND conrelid = 'accounting_case_operations'::regclass
  ) THEN
    ALTER TABLE accounting_case_operations
      ADD CONSTRAINT accounting_case_operations_case_tenant_fk
      FOREIGN KEY (case_id, tenant_id)
      REFERENCES accounting_cases(case_id, tenant_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_case_active_business_write_unique_idx
  ON accounting_case_operations (tenant_id, action_id, business_identity_hash)
  WHERE state IN (
    'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
    'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
  );

CREATE UNIQUE INDEX IF NOT EXISTS accounting_case_active_exact_payload_write_unique_idx
  ON accounting_case_operations (tenant_id, action_id, canonical_payload_hash)
  WHERE state IN (
    'PREPARED', 'WRITE_IN_FLIGHT', 'READBACK_VERIFIED',
    'WRITE_UNCERTAIN', 'READBACK_MISMATCH'
  );

-- Historical contact+free-form-reference indexes overblock legitimate
-- recurring supplier documents. The exact semantic payload/source claims
-- below replace them; Reference remains a collision signal, not a hard key.
DROP INDEX IF EXISTS posting_requests_active_supplier_reference_unique_idx;
DROP INDEX IF EXISTS posting_requests_tenant_active_supplier_reference_unique_idx;
DROP INDEX IF EXISTS posting_requests_active_supplier_ref_v030_unique_idx;
DROP INDEX IF EXISTS posting_requests_tenant_active_supplier_ref_v030_unique_idx;

-- Defence in depth for governed mutation callers outside the public Case
-- composition.  Strip only provenance/confirmation coordinates; the
-- remaining canonical JSON is the provider business payload.  A definite
-- validation/provider rejection releases the identity, while an uncertain,
-- mismatched, or verified write remains reserved.
CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_active_business_payload_unique_idx
  ON xero_mutation_requests (
    tenant_id,
    object_type,
    operation,
    ((canonical_payload - ARRAY[
      'source_ref', 'source_sha256', 'source_evidence_type', 'user_confirmation',
      'request_id', 'externalReference',
      'sourceRef', 'sourceSha256', 'sourceEvidenceType', 'userConfirmation', 'requestId'
    ]))
  )
  WHERE operation IN ('CREATE_DRAFT', 'CREATE', 'UPLOAD')
    AND state IN (
      'CONFIRMED', 'WRITE_IN_FLIGHT', 'WRITE_UNCERTAIN',
      'READBACK_VERIFIED', 'READBACK_MISMATCH'
    );

-- Bare Xero company/account numbers have no issuer or uniqueness namespace.
-- They must never be permanent cross-Case identities.  The governed Case
-- operation's provider-owned business_identity_hash reserves the explicit
-- LEGAL_REGISTRY or PROVIDER_TENANT_ACCOUNT tuple instead.
DROP INDEX IF EXISTS xero_mutation_requests_active_contact_company_unique_idx;
DROP INDEX IF EXISTS xero_mutation_requests_active_contact_account_unique_idx;
