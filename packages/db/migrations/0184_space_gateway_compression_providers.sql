-- Space Gateway per-provider compression (PLAN clipboard:1QB_tqacF15X, B1): Claude, Codex and Antigravity may each
-- override the global compression mode, profile, code-and-prose and time budget, and carry their own output policy.
-- A missing field inherits the global setting; '{}' keeps today's behaviour for every provider.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS compression_providers jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE space_gateway_settings DROP CONSTRAINT IF EXISTS space_gateway_settings_compression_providers_check;
ALTER TABLE space_gateway_settings
  ADD CONSTRAINT space_gateway_settings_compression_providers_check
  CHECK (jsonb_typeof(compression_providers) = 'object' AND pg_column_size(compression_providers) <= 8192);
