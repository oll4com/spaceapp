-- A CLI session keeps the request trace that allocated it, so the admin trace lookup links a request to its CLI
-- session, logical task and revision (docs/quality/observability.md, OBS-001). Older rows stay NULL.
ALTER TABLE pane_cli_sessions ADD COLUMN IF NOT EXISTS trace_id text;

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_trace
  ON pane_cli_sessions(trace_id) WHERE trace_id IS NOT NULL;
