CREATE INDEX IF NOT EXISTS review_csrf_session_idx
  ON review_csrf_tokens (session_hash);
