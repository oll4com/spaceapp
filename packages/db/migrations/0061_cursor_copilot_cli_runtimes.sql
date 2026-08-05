ALTER TABLE cli_runtime_settings
  DROP CONSTRAINT IF EXISTS cli_runtime_settings_runtime_id_check;

ALTER TABLE cli_runtime_settings
  ADD CONSTRAINT cli_runtime_settings_runtime_id_check
  CHECK (
    runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek',
      'cli:cursor',
      'cli:copilot'
    )
  );

INSERT INTO cli_runtime_settings (runtime_id, enabled, updated_at, updated_by)
VALUES
  ('cli:cursor', true, now(), NULL),
  ('cli:copilot', true, now(), NULL)
ON CONFLICT (runtime_id) DO NOTHING;

ALTER TABLE cli_maintenance_events
  DROP CONSTRAINT IF EXISTS cli_maintenance_events_runtime_id_check;

ALTER TABLE cli_maintenance_events
  ADD CONSTRAINT cli_maintenance_events_runtime_id_check
  CHECK (
    runtime_id IS NULL OR runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek',
      'cli:cursor',
      'cli:copilot'
    )
  );

ALTER TABLE cli_maintenance_auth_handoffs
  DROP CONSTRAINT IF EXISTS cli_maintenance_auth_handoffs_runtime_id_check;

ALTER TABLE cli_maintenance_auth_handoffs
  ADD CONSTRAINT cli_maintenance_auth_handoffs_runtime_id_check
  CHECK (
    runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek',
      'cli:cursor',
      'cli:copilot'
    )
  );
