ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS account_profile_id text;

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_account_profile
  ON pane_cli_sessions(runtime_id, account_profile_id);