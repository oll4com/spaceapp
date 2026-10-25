ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS launch_mode text NOT NULL DEFAULT 'FRESH';

ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_launch_mode_check;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_launch_mode_check
  CHECK (launch_mode IN ('FRESH', 'RESUME'));
