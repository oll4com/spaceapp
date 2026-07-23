CREATE TABLE IF NOT EXISTS codex_app_server_turn_smoke_checks (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISABLED', 'ERROR', 'VERIFIED')),
  code text NOT NULL,
  message text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('stdio', 'unix', 'websocket', 'off')),
  schemas_generated boolean NOT NULL,
  schema_manifest jsonb,
  model text,
  thread_id text,
  turn_id text,
  turn_status text CHECK (turn_status IS NULL OR turn_status IN ('completed', 'interrupted', 'failed', 'inProgress')),
  notification_count integer NOT NULL CHECK (notification_count >= 0),
  completed_notification_seen boolean NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_codex_app_server_turn_smoke_checks_latest
  ON codex_app_server_turn_smoke_checks(checked_at DESC, created_at DESC);
