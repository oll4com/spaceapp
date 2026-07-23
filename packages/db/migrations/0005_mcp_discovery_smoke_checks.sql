CREATE TABLE IF NOT EXISTS mcp_discovery_smoke_checks (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISABLED', 'ERROR', 'VERIFIED')),
  code text NOT NULL CHECK (code IN (
    'CONFIG_INVALID',
    'DISCOVERY_SMOKE_DISABLED',
    'NO_CONFIGURED_SERVERS',
    'DISCOVERY_NOT_IMPLEMENTED',
    'DISCOVERY_FAILED',
    'DISCOVERY_OK'
  )),
  message text NOT NULL,
  target_spec_version text NOT NULL,
  discovery_enabled boolean NOT NULL,
  server_count integer NOT NULL CHECK (server_count >= 0),
  tool_count integer NOT NULL CHECK (tool_count >= 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_discovery_smoke_checks_latest
  ON mcp_discovery_smoke_checks(checked_at DESC, created_at DESC);
