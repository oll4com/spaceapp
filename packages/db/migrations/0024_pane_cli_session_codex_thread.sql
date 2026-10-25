ALTER TABLE pane_cli_sessions
  ADD COLUMN IF NOT EXISTS codex_thread_id text;

ALTER TABLE pane_cli_sessions
  DROP CONSTRAINT IF EXISTS pane_cli_sessions_codex_thread_id_uuid_check;

ALTER TABLE pane_cli_sessions
  ADD CONSTRAINT pane_cli_sessions_codex_thread_id_uuid_check
  CHECK (
    codex_thread_id IS NULL
    OR codex_thread_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_codex_thread_id
  ON pane_cli_sessions (codex_thread_id)
  WHERE codex_thread_id IS NOT NULL;
