SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A Case preflight receipt is permanent evidence. Short-lived mutation
-- preparations may be replaced only by appending a same-version reseal whose
-- receipt chains from the previously-effective seal.
ALTER TABLE accounting_case_versions
  ADD COLUMN IF NOT EXISTS original_preflight_receipt_hash text,
  ADD COLUMN IF NOT EXISTS effective_preflight_seal_hash text,
  ADD COLUMN IF NOT EXISTS effective_preflight_sealed_at timestamptz,
  ADD COLUMN IF NOT EXISTS preflight_reseal_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE accounting_case_operations
  ADD COLUMN IF NOT EXISTS original_preparation_id text;

UPDATE accounting_case_versions
SET original_preflight_receipt_hash = COALESCE(
      original_preflight_receipt_hash, preflight_receipt_hash
    ),
    effective_preflight_seal_hash = COALESCE(
      effective_preflight_seal_hash, preflight_receipt_hash
    ),
    effective_preflight_sealed_at = COALESCE(
      effective_preflight_sealed_at, preflighted_at
    )
WHERE preflight_receipt_hash IS NOT NULL
  AND (
    original_preflight_receipt_hash IS NULL
    OR effective_preflight_seal_hash IS NULL
    OR effective_preflight_sealed_at IS NULL
  );

UPDATE accounting_case_operations
SET original_preparation_id = preparation_id
WHERE preparation_id IS NOT NULL
  AND original_preparation_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounting_case_versions version_row
    WHERE (
      version_row.preflight_receipt_hash IS NULL
      AND (
        version_row.original_preflight_receipt_hash IS NOT NULL
        OR version_row.effective_preflight_seal_hash IS NOT NULL
        OR version_row.effective_preflight_sealed_at IS NOT NULL
        OR version_row.preflight_reseal_revision <> 0
      )
    ) OR (
      version_row.preflight_receipt_hash IS NOT NULL
      AND (
        version_row.original_preflight_receipt_hash
          IS DISTINCT FROM version_row.preflight_receipt_hash
        OR version_row.effective_preflight_seal_hash IS NULL
        OR version_row.effective_preflight_sealed_at IS NULL
        OR version_row.preflight_reseal_revision < 0
        OR (
          version_row.preflight_reseal_revision = 0
          AND (
            version_row.effective_preflight_seal_hash
              IS DISTINCT FROM version_row.preflight_receipt_hash
            OR version_row.effective_preflight_sealed_at
              IS DISTINCT FROM version_row.preflighted_at
          )
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'migration 030 blocked: existing Accounting Case preflight seal metadata is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_case_operations operation_row
    WHERE operation_row.preparation_id IS NOT NULL
      AND operation_row.original_preparation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 030 blocked: original Accounting Case preparation cannot be linked';
  END IF;

  -- Migration 029 compared the immutable original receipt to the then-current
  -- preparation. From 030 onward current preparation_id is an effective value,
  -- so the original receipt must instead remain linked to original_preparation_id.
  IF EXISTS (
    SELECT 1
    FROM accounting_case_versions version_row
    WHERE version_row.preflight_request_id IS NOT NULL
      AND (
        jsonb_typeof(version_row.preflight_receipt -> 'operations') IS DISTINCT FROM 'array'
        OR jsonb_array_length(version_row.preflight_receipt -> 'operations') <> (
          SELECT count(*)
          FROM accounting_case_operations operation_row
          WHERE operation_row.case_id = version_row.case_id
            AND operation_row.case_version = version_row.version
        )
        OR EXISTS (
          SELECT 1
          FROM accounting_case_operations operation_row
          LEFT JOIN xero_mutation_preparations original_preparation
            ON original_preparation.preparation_id = operation_row.original_preparation_id
          WHERE operation_row.case_id = version_row.case_id
            AND operation_row.case_version = version_row.version
            AND (
              SELECT count(*)
              FROM jsonb_array_elements(version_row.preflight_receipt -> 'operations') evidence
              WHERE evidence ->> 'operationId' = operation_row.operation_id
                AND evidence ->> 'actionId' = operation_row.action_id
                AND evidence ->> 'operationCanonicalPayloadHash'
                  = operation_row.canonical_payload_hash
                AND (
                  (operation_row.original_preparation_id IS NOT NULL
                    AND original_preparation.preparation_id IS NOT NULL
                    AND evidence ->> 'state' = 'PREPARED'
                    AND evidence ->> 'preparationId' = operation_row.original_preparation_id
                    AND evidence ->> 'preparationCanonicalPayloadHash'
                      = original_preparation.canonical_payload_hash
                    AND evidence ->> 'sourceSha256' = original_preparation.source_sha256)
                  OR (operation_row.original_preparation_id IS NULL
                    AND operation_row.preparation_id IS NULL
                    AND operation_row.state = 'NO_WRITE_REQUIRED'
                    AND evidence ->> 'state' = 'NO_WRITE_REQUIRED'
                    AND evidence ->> 'xeroObjectId' = operation_row.xero_object_id)
                )
            ) <> 1
        )
      )
  ) THEN
    RAISE EXCEPTION 'migration 030 blocked: original Accounting Case preflight receipt linkage is invalid';
  END IF;
END
$$;

ALTER TABLE accounting_case_versions
  DROP CONSTRAINT IF EXISTS accounting_case_preflight_seal_metadata_check;

ALTER TABLE accounting_case_versions
  ADD CONSTRAINT accounting_case_preflight_seal_metadata_check CHECK (
    (
      preflight_receipt_hash IS NULL
      AND original_preflight_receipt_hash IS NULL
      AND effective_preflight_seal_hash IS NULL
      AND effective_preflight_sealed_at IS NULL
      AND preflight_reseal_revision = 0
    ) OR (
      preflight_receipt_hash IS NOT NULL
      AND original_preflight_receipt_hash = preflight_receipt_hash
      AND effective_preflight_seal_hash ~ '^[0-9a-f]{64}$'
      AND effective_preflight_sealed_at IS NOT NULL
      AND effective_preflight_sealed_at >= preflighted_at
      AND preflight_reseal_revision >= 0
      AND (
        preflight_reseal_revision > 0
        OR (
          effective_preflight_seal_hash = original_preflight_receipt_hash
          AND effective_preflight_sealed_at = preflighted_at
        )
      )
    )
  );

ALTER TABLE accounting_case_operations
  DROP CONSTRAINT IF EXISTS accounting_case_operation_original_preparation_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operation_original_preparation_fk;

ALTER TABLE accounting_case_operations
  ADD CONSTRAINT accounting_case_operation_original_preparation_check CHECK (
    (preparation_id IS NULL AND original_preparation_id IS NULL)
    OR (
      preparation_id IS NOT NULL
      AND original_preparation_id = btrim(original_preparation_id)
      AND original_preparation_id <> ''
    )
  ),
  ADD CONSTRAINT accounting_case_operation_original_preparation_fk
    FOREIGN KEY (original_preparation_id)
    REFERENCES xero_mutation_preparations(preparation_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS accounting_case_preflight_reseals (
  case_id text NOT NULL,
  case_version bigint NOT NULL,
  reseal_revision bigint NOT NULL CHECK (reseal_revision > 0),
  request_id text NOT NULL CHECK (
    request_id = btrim(request_id) AND request_id <> ''
    AND length(request_id) <= 128 AND request_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  previous_effective_seal_hash text NOT NULL CHECK (
    previous_effective_seal_hash ~ '^[0-9a-f]{64}$'
  ),
  reseal_receipt jsonb NOT NULL CHECK (
    jsonb_typeof(reseal_receipt) = 'object' AND reseal_receipt <> '{}'::jsonb
  ),
  reseal_receipt_hash text NOT NULL CHECK (reseal_receipt_hash ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz NOT NULL,
  minimum_preparation_expires_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, case_version, reseal_revision),
  UNIQUE (case_id, case_version, reseal_receipt_hash),
  CONSTRAINT accounting_case_preflight_reseal_version_fk
    FOREIGN KEY (case_id, case_version)
    REFERENCES accounting_case_versions(case_id, version) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_preflight_reseal_runway_check CHECK (
    minimum_preparation_expires_at >= checked_at + interval '30 seconds'
  )
);

CREATE TABLE IF NOT EXISTS accounting_case_preflight_reseal_operations (
  case_id text NOT NULL,
  case_version bigint NOT NULL,
  reseal_revision bigint NOT NULL,
  operation_id text NOT NULL CHECK (
    operation_id = btrim(operation_id) AND operation_id <> '' AND length(operation_id) <= 128
  ),
  old_preparation_id text NOT NULL,
  new_preparation_id text NOT NULL,
  operation_canonical_payload_hash text NOT NULL CHECK (
    operation_canonical_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  preparation_canonical_payload_hash text NOT NULL CHECK (
    preparation_canonical_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  new_preparation_expires_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, case_version, reseal_revision, operation_id),
  UNIQUE (new_preparation_id),
  CONSTRAINT accounting_case_preflight_reseal_operation_header_fk
    FOREIGN KEY (case_id, case_version, reseal_revision)
    REFERENCES accounting_case_preflight_reseals(case_id, case_version, reseal_revision)
    ON DELETE RESTRICT,
  CONSTRAINT accounting_case_preflight_reseal_operation_case_fk
    FOREIGN KEY (case_id, case_version, operation_id)
    REFERENCES accounting_case_operations(case_id, case_version, operation_id)
    ON DELETE RESTRICT,
  CONSTRAINT accounting_case_preflight_reseal_old_preparation_fk
    FOREIGN KEY (old_preparation_id)
    REFERENCES xero_mutation_preparations(preparation_id) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_preflight_reseal_new_preparation_fk
    FOREIGN KEY (new_preparation_id)
    REFERENCES xero_mutation_preparations(preparation_id) ON DELETE RESTRICT,
  CONSTRAINT accounting_case_preflight_reseal_distinct_preparations_check CHECK (
    old_preparation_id <> new_preparation_id
  )
);

CREATE INDEX IF NOT EXISTS accounting_case_preflight_reseals_request_idx
  ON accounting_case_preflight_reseals(case_id, case_version, request_id);
CREATE INDEX IF NOT EXISTS accounting_case_preflight_reseal_operations_history_idx
  ON accounting_case_preflight_reseal_operations(case_id, case_version, operation_id, reseal_revision);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_case_operations_original_preparation_uq
  ON accounting_case_operations(original_preparation_id)
  WHERE original_preparation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION accounting_case_preflight_reseal_header_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_row accounting_case_versions%ROWTYPE;
BEGIN
  SELECT * INTO version_row
  FROM accounting_case_versions
  WHERE case_id = NEW.case_id AND version = NEW.case_version
  FOR UPDATE;

  IF version_row.case_id IS NULL
    OR version_row.state NOT IN ('PREFLIGHTED', 'READY_TO_RESUME')
    OR version_row.original_preflight_receipt_hash IS NULL
    OR version_row.effective_preflight_seal_hash IS NULL
    OR NEW.reseal_revision <> version_row.preflight_reseal_revision + 1
    OR NEW.previous_effective_seal_hash
      IS DISTINCT FROM version_row.effective_preflight_seal_hash
  THEN
    RAISE EXCEPTION 'Accounting Case reseal must append exactly once to the effective preflight seal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reseal_receipt ->> 'receiptType' <> 'XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL'
    OR NEW.reseal_receipt ->> 'receiptVersion' <> '1'
    OR NEW.reseal_receipt ->> 'caseId' IS DISTINCT FROM NEW.case_id
    OR NEW.reseal_receipt ->> 'caseVersion' IS DISTINCT FROM NEW.case_version::text
    OR NEW.reseal_receipt ->> 'requestId' IS DISTINCT FROM NEW.request_id
    OR NEW.reseal_receipt ->> 'compiledPlanHash'
      IS DISTINCT FROM version_row.compiled_plan_hash
    OR NEW.reseal_receipt ->> 'originalPreflightReceiptHash'
      IS DISTINCT FROM version_row.original_preflight_receipt_hash
    OR NEW.reseal_receipt ->> 'previousEffectiveSealHash'
      IS DISTINCT FROM NEW.previous_effective_seal_hash
    OR NEW.reseal_receipt ->> 'revision' IS DISTINCT FROM NEW.reseal_revision::text
    OR jsonb_typeof(NEW.reseal_receipt -> 'authorityReceipt') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.reseal_receipt -> 'operations') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.reseal_receipt -> 'operations') = 0
    OR (NEW.reseal_receipt ->> 'checkedAt')::timestamptz IS DISTINCT FROM NEW.checked_at
    OR (NEW.reseal_receipt ->> 'minimumPreparationExpiresAt')::timestamptz
      IS DISTINCT FROM NEW.minimum_preparation_expires_at
  THEN
    RAISE EXCEPTION 'Accounting Case reseal header does not match its canonical receipt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_case_preflight_reseal_operation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_row accounting_cases%ROWTYPE;
  operation_row accounting_case_operations%ROWTYPE;
  old_preparation_row xero_mutation_preparations%ROWTYPE;
  preparation_row xero_mutation_preparations%ROWTYPE;
  header_row accounting_case_preflight_reseals%ROWTYPE;
  receipt_matches bigint;
BEGIN
  SELECT * INTO header_row
  FROM accounting_case_preflight_reseals
  WHERE case_id = NEW.case_id
    AND case_version = NEW.case_version
    AND reseal_revision = NEW.reseal_revision;

  SELECT * INTO operation_row
  FROM accounting_case_operations
  WHERE case_id = NEW.case_id
    AND case_version = NEW.case_version
    AND operation_id = NEW.operation_id
  FOR UPDATE;

  SELECT * INTO case_row FROM accounting_cases WHERE case_id = NEW.case_id;
  SELECT * INTO old_preparation_row
  FROM xero_mutation_preparations
  WHERE preparation_id = NEW.old_preparation_id;
  SELECT * INTO preparation_row
  FROM xero_mutation_preparations
  WHERE preparation_id = NEW.new_preparation_id;

  IF header_row.case_id IS NULL
    OR operation_row.operation_id IS NULL
    OR operation_row.state <> 'PREPARED'
    OR operation_row.mutation_request_id IS NOT NULL
    OR operation_row.original_preparation_id IS NULL
    OR operation_row.preparation_id IS DISTINCT FROM NEW.old_preparation_id
    OR operation_row.canonical_payload_hash
      IS DISTINCT FROM NEW.operation_canonical_payload_hash
    OR operation_row.preparation_canonical_payload_hash
      IS DISTINCT FROM NEW.preparation_canonical_payload_hash
    OR operation_row.operation_source_sha256 IS DISTINCT FROM NEW.source_sha256
  THEN
    RAISE EXCEPTION 'Accounting Case reseal line does not replace the current prepared operation'
      USING ERRCODE = '23514';
  END IF;

  IF preparation_row.preparation_id IS NULL
    OR old_preparation_row.preparation_id IS NULL
    OR old_preparation_row.state NOT IN ('PREPARED', 'EXPIRED')
    OR (old_preparation_row.state = 'EXPIRED'
      AND old_preparation_row.expires_at > header_row.checked_at)
    OR EXISTS (
      SELECT 1 FROM xero_mutation_requests request_row
      WHERE request_row.preparation_id = NEW.old_preparation_id
    )
    OR old_preparation_row.actor_id IS DISTINCT FROM preparation_row.actor_id
    OR old_preparation_row.workspace_id IS DISTINCT FROM preparation_row.workspace_id
    OR old_preparation_row.tenant_id IS DISTINCT FROM preparation_row.tenant_id
    OR old_preparation_row.oauth_installation_id
      IS DISTINCT FROM preparation_row.oauth_installation_id
    OR old_preparation_row.binding_id IS DISTINCT FROM preparation_row.binding_id
    OR old_preparation_row.binding_revision IS DISTINCT FROM preparation_row.binding_revision
    OR old_preparation_row.connection_id IS DISTINCT FROM preparation_row.connection_id
    OR old_preparation_row.target_session_id IS DISTINCT FROM preparation_row.target_session_id
    OR old_preparation_row.object_type IS DISTINCT FROM preparation_row.object_type
    OR old_preparation_row.operation IS DISTINCT FROM preparation_row.operation
    OR old_preparation_row.target_xero_object_id
      IS DISTINCT FROM preparation_row.target_xero_object_id
    OR old_preparation_row.canonical_payload IS DISTINCT FROM preparation_row.canonical_payload
    OR old_preparation_row.canonical_payload_hash
      IS DISTINCT FROM preparation_row.canonical_payload_hash
    OR old_preparation_row.source_ref IS DISTINCT FROM preparation_row.source_ref
    OR old_preparation_row.source_unit_key IS DISTINCT FROM preparation_row.source_unit_key
    OR old_preparation_row.source_sha256 IS DISTINCT FROM preparation_row.source_sha256
    OR old_preparation_row.source_evidence_type
      IS DISTINCT FROM preparation_row.source_evidence_type
    OR preparation_row.state <> 'PREPARED'
    OR preparation_row.expires_at IS DISTINCT FROM NEW.new_preparation_expires_at
    OR preparation_row.expires_at < header_row.minimum_preparation_expires_at
    OR preparation_row.actor_id IS DISTINCT FROM case_row.actor_id
    OR preparation_row.workspace_id IS DISTINCT FROM case_row.workspace_id
    OR preparation_row.tenant_id IS DISTINCT FROM case_row.tenant_id
    OR preparation_row.oauth_installation_id IS DISTINCT FROM case_row.oauth_installation_id
    OR preparation_row.binding_id IS DISTINCT FROM case_row.binding_id
    OR preparation_row.binding_revision IS DISTINCT FROM case_row.binding_revision
    OR preparation_row.connection_id IS DISTINCT FROM case_row.connection_id
    OR preparation_row.target_session_id IS DISTINCT FROM case_row.target_session_id
    OR preparation_row.source_ref IS DISTINCT FROM ('case:' || NEW.case_id)
    OR preparation_row.source_unit_key IS DISTINCT FROM NEW.operation_id
    OR preparation_row.source_sha256 IS DISTINCT FROM NEW.source_sha256
    OR preparation_row.canonical_payload_hash
      IS DISTINCT FROM NEW.preparation_canonical_payload_hash
    OR EXISTS (
      SELECT 1
      FROM accounting_case_operations sealed_operation
      WHERE sealed_operation.original_preparation_id = NEW.new_preparation_id
        OR sealed_operation.preparation_id = NEW.new_preparation_id
    )
    OR (operation_row.action_id = 'contact.create_basic'
      AND (preparation_row.object_type <> 'CONTACT' OR preparation_row.operation <> 'CREATE'))
    OR (operation_row.action_id = 'customer_invoice.create_draft'
      AND (preparation_row.object_type <> 'SALES_INVOICE'
        OR preparation_row.operation <> 'CREATE_DRAFT'))
    OR (operation_row.action_id = 'supplier_bill.create_draft'
      AND (preparation_row.object_type <> 'SUPPLIER_BILL'
        OR preparation_row.operation <> 'CREATE_DRAFT'))
    OR (operation_row.action_id = 'credit_note.create_draft'
      AND (preparation_row.object_type <> 'CREDIT_NOTE'
        OR preparation_row.operation <> 'CREATE_DRAFT'))
  THEN
    RAISE EXCEPTION 'Accounting Case reseal replacement preparation is invalid or lacks required runway'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO receipt_matches
  FROM jsonb_array_elements(header_row.reseal_receipt -> 'operations') receipt_operation
  WHERE receipt_operation ->> 'operationId' = NEW.operation_id
    AND receipt_operation ->> 'oldPreparationId' = NEW.old_preparation_id
    AND receipt_operation ->> 'newPreparationId' = NEW.new_preparation_id
    AND receipt_operation ->> 'operationCanonicalPayloadHash'
      = NEW.operation_canonical_payload_hash
    AND receipt_operation ->> 'preparationCanonicalPayloadHash'
      = NEW.preparation_canonical_payload_hash
    AND receipt_operation ->> 'sourceSha256' = NEW.source_sha256
    AND (receipt_operation ->> 'newPreparationExpiresAt')::timestamptz
      = NEW.new_preparation_expires_at;

  IF receipt_matches <> 1 THEN
    RAISE EXCEPTION 'Accounting Case reseal line must have one exact receipt operation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_case_preflight_reseal_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Accounting Case preflight reseal evidence is append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_header_insert
  ON accounting_case_preflight_reseals;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_header_append_only
  ON accounting_case_preflight_reseals;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_header_no_truncate
  ON accounting_case_preflight_reseals;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_operation_insert
  ON accounting_case_preflight_reseal_operations;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_operation_append_only
  ON accounting_case_preflight_reseal_operations;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_operation_no_truncate
  ON accounting_case_preflight_reseal_operations;

CREATE TRIGGER accounting_case_preflight_reseal_header_insert
BEFORE INSERT ON accounting_case_preflight_reseals
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_header_guard();

CREATE TRIGGER accounting_case_preflight_reseal_header_append_only
BEFORE UPDATE OR DELETE ON accounting_case_preflight_reseals
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_append_only_guard();

CREATE TRIGGER accounting_case_preflight_reseal_header_no_truncate
BEFORE TRUNCATE ON accounting_case_preflight_reseals
FOR EACH STATEMENT EXECUTE FUNCTION accounting_case_preflight_reseal_append_only_guard();

CREATE TRIGGER accounting_case_preflight_reseal_operation_insert
BEFORE INSERT ON accounting_case_preflight_reseal_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_operation_guard();

CREATE TRIGGER accounting_case_preflight_reseal_operation_append_only
BEFORE UPDATE OR DELETE ON accounting_case_preflight_reseal_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_append_only_guard();

CREATE TRIGGER accounting_case_preflight_reseal_operation_no_truncate
BEFORE TRUNCATE ON accounting_case_preflight_reseal_operations
FOR EACH STATEMENT EXECUTE FUNCTION accounting_case_preflight_reseal_append_only_guard();

CREATE OR REPLACE FUNCTION accounting_case_operation_original_preparation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.preparation_id IS NOT NULL
      AND NEW.original_preparation_id IS DISTINCT FROM NEW.preparation_id THEN
      RAISE EXCEPTION 'Accounting Case original preparation must equal its first preparation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.original_preparation_id IS NOT NULL
    AND NEW.original_preparation_id IS DISTINCT FROM OLD.original_preparation_id THEN
    RAISE EXCEPTION 'Accounting Case original preparation is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_id IS NULL AND NEW.preparation_id IS NOT NULL
    AND NEW.original_preparation_id IS DISTINCT FROM NEW.preparation_id THEN
    RAISE EXCEPTION 'Accounting Case original preparation must equal its first preparation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.preparation_id IS NULL AND NEW.preparation_id IS NULL
    AND NEW.original_preparation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting Case original preparation requires a prepared operation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION accounting_case_operation_is_reseal_update(
  old_row accounting_case_operations,
  new_row accounting_case_operations
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    old_row.state = 'PREPARED'
    AND new_row.state = 'PREPARED'
    AND old_row.mutation_request_id IS NULL
    AND new_row.mutation_request_id IS NULL
    AND old_row.preparation_id IS NOT NULL
    AND new_row.preparation_id IS NOT NULL
    AND new_row.preparation_id IS DISTINCT FROM old_row.preparation_id
    AND old_row.original_preparation_id IS NOT NULL
    AND new_row.original_preparation_id = old_row.original_preparation_id
    AND (
      to_jsonb(new_row) - ARRAY[
        'preparation_id', 'preparation_canonical_payload_hash',
        'operation_source_sha256', 'updated_at'
      ]::text[]
    ) = (
      to_jsonb(old_row) - ARRAY[
        'preparation_id', 'preparation_canonical_payload_hash',
        'operation_source_sha256', 'updated_at'
      ]::text[]
    )
    AND EXISTS (
      SELECT 1
      FROM accounting_case_preflight_reseal_operations reseal_operation
      JOIN accounting_case_preflight_reseals reseal
        USING (case_id, case_version, reseal_revision)
      JOIN accounting_case_versions version_row
        ON version_row.case_id = reseal_operation.case_id
        AND version_row.version = reseal_operation.case_version
      WHERE reseal_operation.case_id = old_row.case_id
        AND reseal_operation.case_version = old_row.case_version
        AND reseal_operation.operation_id = old_row.operation_id
        AND reseal_operation.reseal_revision = version_row.preflight_reseal_revision + 1
        AND version_row.state IN ('PREFLIGHTED', 'READY_TO_RESUME')
        AND reseal_operation.old_preparation_id = old_row.preparation_id
        AND reseal_operation.new_preparation_id = new_row.preparation_id
        AND reseal_operation.operation_canonical_payload_hash = new_row.canonical_payload_hash
        AND reseal_operation.preparation_canonical_payload_hash
          = new_row.preparation_canonical_payload_hash
        AND reseal_operation.source_sha256 = new_row.operation_source_sha256
        AND reseal.checked_at = new_row.updated_at
    )
$$;

CREATE OR REPLACE FUNCTION accounting_case_operation_reseal_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  case_row accounting_cases%ROWTYPE;
  preparation_row xero_mutation_preparations%ROWTYPE;
  reseal_row record;
BEGIN
  IF NOT accounting_case_operation_is_reseal_update(OLD, NEW) THEN
    RAISE EXCEPTION 'Accounting Case operation reseal update lacks exact append-only evidence'
      USING ERRCODE = '23514';
  END IF;

  SELECT reseal_operation.*, reseal.minimum_preparation_expires_at
  INTO reseal_row
  FROM accounting_case_preflight_reseal_operations reseal_operation
  JOIN accounting_case_preflight_reseals reseal
    USING (case_id, case_version, reseal_revision)
  JOIN accounting_case_versions version_row
    ON version_row.case_id = reseal_operation.case_id
    AND version_row.version = reseal_operation.case_version
  WHERE reseal_operation.case_id = OLD.case_id
    AND reseal_operation.case_version = OLD.case_version
    AND reseal_operation.operation_id = OLD.operation_id
    AND reseal_operation.reseal_revision = version_row.preflight_reseal_revision + 1;

  SELECT * INTO case_row FROM accounting_cases WHERE case_id = NEW.case_id;
  SELECT * INTO preparation_row
  FROM xero_mutation_preparations
  WHERE preparation_id = NEW.preparation_id;

  IF preparation_row.preparation_id IS NULL
    OR preparation_row.state <> 'PREPARED'
    OR preparation_row.expires_at IS DISTINCT FROM reseal_row.new_preparation_expires_at
    OR preparation_row.expires_at < reseal_row.minimum_preparation_expires_at
    OR preparation_row.actor_id IS DISTINCT FROM case_row.actor_id
    OR preparation_row.workspace_id IS DISTINCT FROM case_row.workspace_id
    OR preparation_row.tenant_id IS DISTINCT FROM case_row.tenant_id
    OR preparation_row.oauth_installation_id IS DISTINCT FROM case_row.oauth_installation_id
    OR preparation_row.binding_id IS DISTINCT FROM case_row.binding_id
    OR preparation_row.binding_revision IS DISTINCT FROM case_row.binding_revision
    OR preparation_row.connection_id IS DISTINCT FROM case_row.connection_id
    OR preparation_row.target_session_id IS DISTINCT FROM case_row.target_session_id
    OR preparation_row.source_ref IS DISTINCT FROM ('case:' || NEW.case_id)
    OR preparation_row.source_unit_key IS DISTINCT FROM NEW.operation_id
    OR preparation_row.source_sha256 IS DISTINCT FROM NEW.operation_source_sha256
    OR preparation_row.canonical_payload_hash
      IS DISTINCT FROM NEW.preparation_canonical_payload_hash
  THEN
    RAISE EXCEPTION 'Accounting Case operation reseal preparation is not executable under exact authority'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_operation_original_preparation_lifecycle
  ON accounting_case_operations;
DROP TRIGGER IF EXISTS accounting_case_operation_reseal_lifecycle
  ON accounting_case_operations;
DROP TRIGGER IF EXISTS accounting_case_operation_lifecycle
  ON accounting_case_operations;

CREATE TRIGGER accounting_case_operation_original_preparation_lifecycle
BEFORE INSERT OR UPDATE ON accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_operation_original_preparation_guard();

CREATE TRIGGER accounting_case_operation_reseal_lifecycle
BEFORE UPDATE ON accounting_case_operations
FOR EACH ROW
WHEN (accounting_case_operation_is_reseal_update(OLD, NEW))
EXECUTE FUNCTION accounting_case_operation_reseal_update_guard();

CREATE TRIGGER accounting_case_operation_lifecycle
BEFORE UPDATE ON accounting_case_operations
FOR EACH ROW
WHEN (NOT accounting_case_operation_is_reseal_update(OLD, NEW))
EXECUTE FUNCTION accounting_case_operation_guard();

CREATE OR REPLACE FUNCTION accounting_case_preflight_effective_seal_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reseal_row accounting_case_preflight_reseals%ROWTYPE;
BEGIN
  IF OLD.original_preflight_receipt_hash IS NOT NULL
    AND NEW.original_preflight_receipt_hash
      IS DISTINCT FROM OLD.original_preflight_receipt_hash THEN
    RAISE EXCEPTION 'Accounting Case original preflight receipt hash is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.preflight_receipt_hash IS NULL AND NEW.preflight_receipt_hash IS NOT NULL
    AND (
      NEW.original_preflight_receipt_hash IS DISTINCT FROM NEW.preflight_receipt_hash
      OR NEW.effective_preflight_seal_hash IS DISTINCT FROM NEW.preflight_receipt_hash
      OR NEW.effective_preflight_sealed_at IS DISTINCT FROM NEW.preflighted_at
      OR NEW.preflight_reseal_revision <> 0
    )
  THEN
    RAISE EXCEPTION 'Accounting Case original preflight must establish revision zero seal metadata'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.preflight_receipt_hash IS NOT NULL
    AND ROW(
      NEW.effective_preflight_seal_hash,
      NEW.effective_preflight_sealed_at,
      NEW.preflight_reseal_revision
    ) IS DISTINCT FROM ROW(
      OLD.effective_preflight_seal_hash,
      OLD.effective_preflight_sealed_at,
      OLD.preflight_reseal_revision
    )
  THEN
    SELECT * INTO reseal_row
    FROM accounting_case_preflight_reseals
    WHERE case_id = NEW.case_id
      AND case_version = NEW.version
      AND reseal_revision = NEW.preflight_reseal_revision;

    IF OLD.state NOT IN ('PREFLIGHTED', 'READY_TO_RESUME')
      OR NEW.state <> 'EXECUTING'
      OR NEW.preflight_reseal_revision <> OLD.preflight_reseal_revision + 1
      OR reseal_row.case_id IS NULL
      OR reseal_row.previous_effective_seal_hash
        IS DISTINCT FROM OLD.effective_preflight_seal_hash
      OR NEW.effective_preflight_seal_hash
        IS DISTINCT FROM reseal_row.reseal_receipt_hash
      OR NEW.effective_preflight_sealed_at IS DISTINCT FROM reseal_row.checked_at
      OR NEW.execution_request_id IS DISTINCT FROM reseal_row.request_id
      OR NEW.execution_started_at IS DISTINCT FROM reseal_row.checked_at
      OR NEW.updated_at IS DISTINCT FROM reseal_row.checked_at
      OR EXISTS (
        SELECT 1
        FROM accounting_case_operations prepared_operation
        WHERE prepared_operation.case_id = NEW.case_id
          AND prepared_operation.case_version = NEW.version
          AND prepared_operation.state = 'PREPARED'
          AND NOT EXISTS (
            SELECT 1
            FROM accounting_case_preflight_reseal_operations reseal_operation
            WHERE reseal_operation.case_id = NEW.case_id
              AND reseal_operation.case_version = NEW.version
              AND reseal_operation.reseal_revision = NEW.preflight_reseal_revision
              AND reseal_operation.operation_id = prepared_operation.operation_id
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM accounting_case_preflight_reseal_operations reseal_operation
        JOIN xero_mutation_preparations old_preparation
          ON old_preparation.preparation_id = reseal_operation.old_preparation_id
        WHERE reseal_operation.case_id = NEW.case_id
          AND reseal_operation.case_version = NEW.version
          AND reseal_operation.reseal_revision = NEW.preflight_reseal_revision
          AND old_preparation.expires_at < reseal_row.minimum_preparation_expires_at
      )
    THEN
      RAISE EXCEPTION 'Accounting Case effective preflight seal may advance only with an atomic reseal claim'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_preflight_effective_seal_lifecycle
  ON accounting_case_versions;
CREATE TRIGGER accounting_case_preflight_effective_seal_lifecycle
BEFORE UPDATE ON accounting_case_versions
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_effective_seal_guard();

CREATE OR REPLACE FUNCTION accounting_case_preflight_reseal_consistency_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case_id text;
  target_case_version bigint;
  version_row accounting_case_versions%ROWTYPE;
  header_count bigint;
BEGIN
  target_case_id := NEW.case_id;
  IF TG_TABLE_NAME = 'accounting_case_versions' THEN
    target_case_version := NEW.version;
  ELSE
    target_case_version := NEW.case_version;
  END IF;

  SELECT * INTO version_row
  FROM accounting_case_versions
  WHERE case_id = target_case_id AND version = target_case_version;

  IF version_row.case_id IS NULL THEN
    RAISE EXCEPTION 'Accounting Case reseal points to a missing version' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO header_count
  FROM accounting_case_preflight_reseals reseal
  WHERE reseal.case_id = target_case_id
    AND reseal.case_version = target_case_version;

  IF version_row.preflight_receipt_hash IS NULL THEN
    IF header_count <> 0
      OR version_row.original_preflight_receipt_hash IS NOT NULL
      OR version_row.effective_preflight_seal_hash IS NOT NULL
      OR version_row.effective_preflight_sealed_at IS NOT NULL
      OR version_row.preflight_reseal_revision <> 0
    THEN
      RAISE EXCEPTION 'Accounting Case without preflight cannot have reseal evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF version_row.original_preflight_receipt_hash
      IS DISTINCT FROM version_row.preflight_receipt_hash THEN
    RAISE EXCEPTION 'Accounting Case original preflight receipt hash is not preserved'
      USING ERRCODE = '23514';
  END IF;

  IF version_row.preflight_reseal_revision = 0 THEN
    IF header_count <> 0
      OR version_row.effective_preflight_seal_hash
        IS DISTINCT FROM version_row.original_preflight_receipt_hash
      OR version_row.effective_preflight_sealed_at IS DISTINCT FROM version_row.preflighted_at
    THEN
      RAISE EXCEPTION 'Accounting Case revision zero must use its original preflight seal'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF header_count <> version_row.preflight_reseal_revision
    OR NOT EXISTS (
      SELECT 1
      FROM accounting_case_preflight_reseals latest
      WHERE latest.case_id = target_case_id
        AND latest.case_version = target_case_version
        AND latest.reseal_revision = version_row.preflight_reseal_revision
        AND latest.reseal_receipt_hash = version_row.effective_preflight_seal_hash
        AND latest.checked_at = version_row.effective_preflight_sealed_at
    )
    OR EXISTS (
      SELECT 1
      FROM accounting_case_preflight_reseals reseal
      LEFT JOIN accounting_case_preflight_reseals previous
        ON previous.case_id = reseal.case_id
        AND previous.case_version = reseal.case_version
        AND previous.reseal_revision = reseal.reseal_revision - 1
      WHERE reseal.case_id = target_case_id
        AND reseal.case_version = target_case_version
        AND reseal.previous_effective_seal_hash IS DISTINCT FROM CASE
          WHEN reseal.reseal_revision = 1
            THEN version_row.original_preflight_receipt_hash
          ELSE previous.reseal_receipt_hash
        END
    )
  THEN
    RAISE EXCEPTION 'Accounting Case preflight reseal revisions must be complete and hash-chained'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_case_preflight_reseals reseal
    WHERE reseal.case_id = target_case_id
      AND reseal.case_version = target_case_version
      AND (
        jsonb_array_length(reseal.reseal_receipt -> 'operations') <> (
          SELECT count(*)
          FROM accounting_case_preflight_reseal_operations reseal_operation
          WHERE reseal_operation.case_id = reseal.case_id
            AND reseal_operation.case_version = reseal.case_version
            AND reseal_operation.reseal_revision = reseal.reseal_revision
        )
        OR EXISTS (
          SELECT 1
          FROM accounting_case_preflight_reseal_operations reseal_operation
          WHERE reseal_operation.case_id = reseal.case_id
            AND reseal_operation.case_version = reseal.case_version
            AND reseal_operation.reseal_revision = reseal.reseal_revision
            AND (
              SELECT count(*)
              FROM jsonb_array_elements(reseal.reseal_receipt -> 'operations') receipt_operation
              WHERE receipt_operation ->> 'operationId' = reseal_operation.operation_id
                AND receipt_operation ->> 'oldPreparationId'
                  = reseal_operation.old_preparation_id
                AND receipt_operation ->> 'newPreparationId'
                  = reseal_operation.new_preparation_id
                AND receipt_operation ->> 'operationCanonicalPayloadHash'
                  = reseal_operation.operation_canonical_payload_hash
                AND receipt_operation ->> 'preparationCanonicalPayloadHash'
                  = reseal_operation.preparation_canonical_payload_hash
                AND receipt_operation ->> 'sourceSha256' = reseal_operation.source_sha256
                AND (receipt_operation ->> 'newPreparationExpiresAt')::timestamptz
                  = reseal_operation.new_preparation_expires_at
            ) <> 1
        )
      )
  ) THEN
    RAISE EXCEPTION 'Accounting Case reseal receipt must exactly project its append-only operations'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_case_preflight_reseal_operations reseal_operation
    JOIN accounting_case_operations operation_row
      ON operation_row.case_id = reseal_operation.case_id
      AND operation_row.case_version = reseal_operation.case_version
      AND operation_row.operation_id = reseal_operation.operation_id
    WHERE reseal_operation.case_id = target_case_id
      AND reseal_operation.case_version = target_case_version
      AND reseal_operation.old_preparation_id IS DISTINCT FROM COALESCE(
        (
          SELECT previous_operation.new_preparation_id
          FROM accounting_case_preflight_reseal_operations previous_operation
          WHERE previous_operation.case_id = reseal_operation.case_id
            AND previous_operation.case_version = reseal_operation.case_version
            AND previous_operation.operation_id = reseal_operation.operation_id
            AND previous_operation.reseal_revision < reseal_operation.reseal_revision
          ORDER BY previous_operation.reseal_revision DESC
          LIMIT 1
        ),
        operation_row.original_preparation_id
      )
  ) THEN
    RAISE EXCEPTION 'Accounting Case reseal operation preparation lineage is not continuous'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT ON (history.operation_id)
        history.operation_id,
        history.new_preparation_id,
        history.preparation_canonical_payload_hash,
        history.source_sha256
      FROM accounting_case_preflight_reseal_operations history
      WHERE history.case_id = target_case_id
        AND history.case_version = target_case_version
      ORDER BY history.operation_id, history.reseal_revision DESC
    ) latest_operation
    JOIN accounting_case_operations operation_row
      ON operation_row.case_id = target_case_id
      AND operation_row.case_version = target_case_version
      AND operation_row.operation_id = latest_operation.operation_id
    WHERE operation_row.preparation_id IS DISTINCT FROM latest_operation.new_preparation_id
      OR operation_row.preparation_canonical_payload_hash
        IS DISTINCT FROM latest_operation.preparation_canonical_payload_hash
      OR operation_row.operation_source_sha256 IS DISTINCT FROM latest_operation.source_sha256
  ) THEN
    RAISE EXCEPTION 'Accounting Case effective preparations must match the latest reseal revision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_header_consistency
  ON accounting_case_preflight_reseals;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_operation_consistency
  ON accounting_case_preflight_reseal_operations;
DROP TRIGGER IF EXISTS accounting_case_preflight_reseal_version_consistency
  ON accounting_case_versions;

CREATE CONSTRAINT TRIGGER accounting_case_preflight_reseal_header_consistency
AFTER INSERT ON accounting_case_preflight_reseals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_consistency_guard();

CREATE CONSTRAINT TRIGGER accounting_case_preflight_reseal_operation_consistency
AFTER INSERT ON accounting_case_preflight_reseal_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_consistency_guard();

CREATE CONSTRAINT TRIGGER accounting_case_preflight_reseal_version_consistency
AFTER INSERT OR UPDATE ON accounting_case_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting_case_preflight_reseal_consistency_guard();
