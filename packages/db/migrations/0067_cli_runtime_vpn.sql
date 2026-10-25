ALTER TABLE cli_runtime_settings
  ADD COLUMN IF NOT EXISTS vpn_enabled boolean NOT NULL DEFAULT false;
