-- Space Gateway: per-model default speed for Codex requests that do not ask for one (fast goes upstream as priority).
-- Replaces the speed map the local codex-lb route proxy applied.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS speed_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS speed_defaults_updated_at timestamptz;
