ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_reasoning_effort_check;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_reasoning_effort_check
  CHECK (
    char_length(reasoning_effort) BETWEEN 1 AND 80
    AND reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  );
