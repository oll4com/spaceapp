CREATE TABLE IF NOT EXISTS cli_account_profiles (
  runtime_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT cli_account_profiles_pkey PRIMARY KEY (runtime_id, profile_id),
  CONSTRAINT cli_account_profiles_runtime_id_check CHECK (runtime_id = 'cli:gemini'),
  CONSTRAINT cli_account_profiles_profile_id_check CHECK (
    profile_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
  )
);

INSERT INTO cli_account_profiles (runtime_id, profile_id, display_name, updated_by)
VALUES ('cli:gemini', 'main', 'Main account', NULL)
ON CONFLICT (runtime_id, profile_id) DO NOTHING;

ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS account_profile_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_account_profile
  ON pane_cli_sessions(runtime_id, account_profile_id);
