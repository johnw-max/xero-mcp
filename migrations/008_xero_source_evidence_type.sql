ALTER TABLE posting_requests
  ADD COLUMN IF NOT EXISTS source_evidence_type text;

UPDATE posting_requests
SET source_evidence_type = 'LEGACY_UNVERIFIED'
WHERE source_evidence_type IS NULL;

ALTER TABLE posting_requests
  ALTER COLUMN source_evidence_type DROP DEFAULT,
  ALTER COLUMN source_evidence_type SET NOT NULL;

ALTER TABLE posting_requests
  DROP CONSTRAINT IF EXISTS posting_requests_source_evidence_type_check;

ALTER TABLE posting_requests
  ADD CONSTRAINT posting_requests_source_evidence_type_check
  CHECK (source_evidence_type IN (
    'LEGACY_UNVERIFIED',
    'AGENT_ASSERTED_UNVERIFIED',
    'SERVER_FINGERPRINTED_EXTRACTION'
  )) NOT VALID;

ALTER TABLE posting_requests
  VALIDATE CONSTRAINT posting_requests_source_evidence_type_check;
