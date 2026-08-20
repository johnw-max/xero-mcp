-- Trust-on-first-use, many-to-one binding between an upstream (cross-MCP)
-- source case -- for example a Google Drive case -- and exactly one Xero
-- tenant, scoped per workspace. One source case may bind to only one
-- tenant; one tenant may be cited by many source cases (a client has many
-- engagements). This is the only guarantee this migration adds: consistency
-- of the source-case/tenant pairing, never that the upstream material is
-- correct. The raw upstream case reference is never stored here, only its
-- sha256 digest.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS accounting_case_source_case_bindings (
  workspace_id text NOT NULL CHECK (workspace_id = btrim(workspace_id) AND workspace_id <> ''),
  source_system text NOT NULL CHECK (source_system IN ('GOOGLE_DRIVE')),
  source_case_ref_hash text NOT NULL CHECK (source_case_ref_hash ~ '^[0-9a-f]{64}$'),
  tenant_id text NOT NULL CHECK (tenant_id = btrim(tenant_id) AND tenant_id <> ''),
  first_bound_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  case_count bigint NOT NULL CHECK (case_count > 0),
  PRIMARY KEY (workspace_id, source_system, source_case_ref_hash),
  CONSTRAINT accounting_case_source_case_binding_time_check CHECK (last_seen_at >= first_bound_at)
);

-- Case-head identity: the upstream source case a Case cites (if any) is
-- fixed forever by whichever version first prepared that case_id, exactly
-- like its tenant. A later version citing a different source case -- or
-- newly citing/dropping one entirely -- is a change to Case identity and is
-- refused by the service before any write, never silently reinterpreted.
ALTER TABLE accounting_cases
  ADD COLUMN IF NOT EXISTS source_case_system text,
  ADD COLUMN IF NOT EXISTS source_case_ref_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_cases_source_case_shape_check'
      AND conrelid = 'accounting_cases'::regclass
  ) THEN
    ALTER TABLE accounting_cases
      ADD CONSTRAINT accounting_cases_source_case_shape_check CHECK (
        (source_case_system IS NULL) = (source_case_ref_hash IS NULL)
        AND (source_case_system IS NULL OR source_case_system IN ('GOOGLE_DRIVE'))
        AND (source_case_ref_hash IS NULL OR source_case_ref_hash ~ '^[0-9a-f]{64}$')
      );
  END IF;
END $$;

-- Per-version evidence: the binding state this exact prepared version
-- observed. It is sealed at preparation time and never recomputed on a
-- later read, so a status/execute call for an old version keeps reporting
-- what was true when that version was created. Existing rows predate this
-- feature and cited no upstream case, so they default to the honest
-- absent claim -- never a degraded or suspicious one.
ALTER TABLE accounting_case_versions
  ADD COLUMN IF NOT EXISTS source_case_claim text NOT NULL DEFAULT 'SOURCE_CASE_ABSENT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_case_versions_source_case_claim_check'
      AND conrelid = 'accounting_case_versions'::regclass
  ) THEN
    ALTER TABLE accounting_case_versions
      ADD CONSTRAINT accounting_case_versions_source_case_claim_check CHECK (
        source_case_claim IN (
          'SOURCE_CASE_ABSENT', 'SOURCE_CASE_BOUND_FIRST_USE', 'SOURCE_CASE_BOUND_CONFIRMED'
        )
      );
  END IF;
END $$;
