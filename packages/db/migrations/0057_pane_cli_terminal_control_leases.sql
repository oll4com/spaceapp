CREATE TABLE IF NOT EXISTS pane_cli_terminal_control_leases (
  lease_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_cli_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  browser_client_id uuid NOT NULL,
  tab_lineage_id uuid NOT NULL,
  page_client_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_cli_terminal_control_leases_one_active_per_session
  ON pane_cli_terminal_control_leases(session_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_pane_cli_terminal_control_leases_session_expires_at
  ON pane_cli_terminal_control_leases(session_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_pane_cli_terminal_control_leases_page_status
  ON pane_cli_terminal_control_leases(page_client_id, status);

CREATE INDEX IF NOT EXISTS idx_pane_cli_terminal_control_leases_browser_status
  ON pane_cli_terminal_control_leases(browser_client_id, status);
