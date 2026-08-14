DROP INDEX IF EXISTS idx_pane_cli_sessions_account_profile;

ALTER TABLE pane_cli_sessions
  DROP COLUMN IF EXISTS account_profile_id;

DROP TABLE IF EXISTS cli_account_profiles;
