ALTER TABLE provider_settings
  ADD COLUMN IF NOT EXISTS title_generation_model_id text,
  ADD COLUMN IF NOT EXISTS title_generation_reasoning_effort text NOT NULL DEFAULT 'low';

ALTER TABLE provider_settings
  DROP CONSTRAINT IF EXISTS provider_settings_title_generation_reasoning_effort_check;

ALTER TABLE provider_settings
  ADD CONSTRAINT provider_settings_title_generation_reasoning_effort_check
  CHECK (title_generation_reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
