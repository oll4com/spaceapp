-- A Space Gateway key's providers (plan clipboard:yw_pvUb_616N): empty means every provider.
ALTER TABLE space_gateway_api_keys
  ADD COLUMN IF NOT EXISTS allowed_providers text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_providers) <= 100);
