-- Preserve evidence for each irreversible provider phase independently. The
-- legacy write_receipt/readback_snapshot columns remain as the latest view so
-- the previous binary can still run during rollback.
SET LOCAL lock_timeout = '5s';

ALTER TABLE posting_requests
  ADD COLUMN IF NOT EXISTS draft_write_receipt jsonb,
  ADD COLUMN IF NOT EXISTS draft_readback_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS authorise_write_receipt jsonb,
  ADD COLUMN IF NOT EXISTS authorise_readback_snapshot jsonb;

-- Before terminal authorisation, the legacy evidence can only be draft-phase
-- evidence: older code persisted authorisation evidence only at completion.
UPDATE posting_requests
SET draft_write_receipt = COALESCE(draft_write_receipt, write_receipt),
    draft_readback_snapshot = COALESCE(draft_readback_snapshot, readback_snapshot)
WHERE state <> 'AUTHORISED_READBACK_VERIFIED';

-- For historical terminal rows the latest evidence is authorisation evidence.
-- The overwritten draft receipt cannot be reconstructed, so leave it NULL
-- rather than mislabelling the authorisation receipt as a draft receipt.
UPDATE posting_requests
SET authorise_write_receipt = COALESCE(authorise_write_receipt, write_receipt),
    authorise_readback_snapshot = COALESCE(authorise_readback_snapshot, readback_snapshot)
WHERE state = 'AUTHORISED_READBACK_VERIFIED';
