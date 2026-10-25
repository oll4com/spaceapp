CREATE TABLE IF NOT EXISTS cli_runtime_settings (
  runtime_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,
  CONSTRAINT cli_runtime_settings_runtime_id_check CHECK (
    runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek'
    )
  )
);

INSERT INTO cli_runtime_settings (runtime_id, enabled, updated_at, updated_by)
VALUES
  ('cli:codex', true, now(), NULL),
  ('cli:claude', true, now(), NULL),
  ('cli:gemini', true, now(), NULL),
  ('cli:opencode', true, now(), NULL),
  ('cli:qwen', true, now(), NULL),
  ('cli:kimi', true, now(), NULL),
  ('cli:grok', true, now(), NULL),
  ('cli:deepseek', true, now(), NULL)
ON CONFLICT (runtime_id) DO NOTHING;
