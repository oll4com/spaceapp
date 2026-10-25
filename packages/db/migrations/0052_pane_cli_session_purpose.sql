ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'NORMAL';

ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_purpose_check;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_purpose_check
  CHECK (purpose IN ('NORMAL', 'LOGIN'));
