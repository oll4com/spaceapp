CREATE TABLE IF NOT EXISTS codex_app_server_handshake_checks (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISABLED', 'ERROR', 'VERIFIED')),
  code text NOT NULL,
  message text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('stdio', 'unix', 'websocket', 'off')),
  schemas_generated boolean NOT NULL,
  schema_manifest jsonb,
  server_info jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_codex_app_server_handshake_checks_latest
  ON codex_app_server_handshake_checks(checked_at DESC, created_at DESC);
