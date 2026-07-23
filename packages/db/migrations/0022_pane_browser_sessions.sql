CREATE TABLE IF NOT EXISTS pane_browser_sessions (
  session_id text PRIMARY KEY,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_agent_id text,
  agent_number integer NOT NULL CHECK (agent_number >= 1 AND agent_number <= 99),
  profile_id text NOT NULL,
  profile_path text NOT NULL,
  viewport text NOT NULL CHECK (viewport IN ('mobile', 'tablet', 'desktop')),
  target_url text,
  current_url text,
  title text,
  status text NOT NULL CHECK (status IN ('STARTING', 'READY', 'NAVIGATING', 'ERROR', 'CLOSED')),
  status_reason text,
  last_frame_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_browser_sessions_one_active_per_pane
  ON pane_browser_sessions(pane_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pane_browser_sessions_room_active
  ON pane_browser_sessions(room_id, is_active, updated_at DESC);
