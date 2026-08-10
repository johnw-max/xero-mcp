-- An OAuth installation is one MCP refresh grant boundary. Multiple ACTIVE
-- families under the same installation make replay/expiry revocation
-- ambiguous, so fail closed on any historical conflict before enforcing the
-- invariant. Operators must investigate; this migration never picks a winner.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mcp_refresh_token_families
    WHERE family_status = 'ACTIVE'
    GROUP BY oauth_installation_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = 'MCP refresh-family lifecycle migration blocked by multiple ACTIVE families for one OAuth installation.',
      HINT = 'Inspect every conflicting installation and revoke stale grants explicitly; do not auto-delete tokens or choose a winning family.';
  END IF;
END $$;

CREATE UNIQUE INDEX mcp_refresh_token_families_active_installation_uq
  ON mcp_refresh_token_families (oauth_installation_id)
  WHERE family_status = 'ACTIVE';
