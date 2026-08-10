ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS tenant_short_code text;
