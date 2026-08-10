-- Agent2 can issue concurrent refresh requests after one 401. Keep the exact
-- successor token response encrypted for a very short retry-coalescing window
-- so the same browser event is idempotent without weakening later replay
-- detection.
SET LOCAL lock_timeout = '5s';

ALTER TABLE mcp_refresh_tokens
  ADD COLUMN IF NOT EXISTS retry_access_token_hash text,
  ADD COLUMN IF NOT EXISTS retry_response_ciphertext text,
  ADD COLUMN IF NOT EXISTS retry_expires_at timestamptz;

ALTER TABLE mcp_refresh_tokens
  DROP CONSTRAINT IF EXISTS mcp_refresh_tokens_retry_all_or_none_ck;

ALTER TABLE mcp_refresh_tokens
  ADD CONSTRAINT mcp_refresh_tokens_retry_all_or_none_ck CHECK (
    (retry_access_token_hash IS NULL AND retry_response_ciphertext IS NULL AND retry_expires_at IS NULL)
    OR
    (retry_access_token_hash IS NOT NULL AND retry_response_ciphertext IS NOT NULL AND retry_expires_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS mcp_refresh_tokens_retry_expiry_idx
  ON mcp_refresh_tokens (retry_expires_at)
  WHERE retry_expires_at IS NOT NULL;
