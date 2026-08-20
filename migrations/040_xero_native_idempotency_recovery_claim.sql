ALTER TABLE xero_mutation_requests
  ADD COLUMN IF NOT EXISTS native_recovery_claim jsonb;

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_request_native_recovery_claim_shape_check;

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_request_native_recovery_claim_independent_check;

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_request_native_recovery_claim_shape_check CHECK (
    native_recovery_claim IS NULL OR (
      jsonb_typeof(native_recovery_claim) = 'object'
      AND native_recovery_claim ->> 'receiptType' = 'XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM'
      AND native_recovery_claim ? 'claimId'
      AND native_recovery_claim ? 'mutationRequestId'
      AND native_recovery_claim ? 'claimedAt'
      AND native_recovery_claim ? 'expiresAt'
      AND NOT (COALESCE(write_receipt, '{}'::jsonb) ? 'nativeRecoveryClaim')
    )
  );

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_request_native_recovery_claim_independent_check CHECK (
    native_recovery_claim IS NULL OR NOT (COALESCE(write_receipt, '{}'::jsonb) ? 'nativeRecoveryClaim')
  );

CREATE UNIQUE INDEX IF NOT EXISTS xero_mutation_requests_native_recovery_claim_uq
  ON xero_mutation_requests (mutation_request_id)
  WHERE native_recovery_claim IS NOT NULL;
