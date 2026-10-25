-- Room Agent monitor: per-room switch (no row = on), last seen activity per pane
-- (so a restart does not repeat transitions) and the Room Agent's activity feed.
CREATE TABLE IF NOT EXISTS room_agent_monitor_settings (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_pane_activity (
  pane_id text PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  activity text NOT NULL CHECK (activity IN ('WORKING', 'WAITING', 'DONE', 'IDLE', 'UNKNOWN', 'NONE')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 80),
  since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_pane_activity_room_idx ON room_pane_activity (room_id);

CREATE TABLE IF NOT EXISTS room_agent_events (
  event_id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  pane_name text CHECK (pane_name IS NULL OR char_length(pane_name) <= 60),
  kind text NOT NULL CHECK (kind IN ('FINISHED', 'WAITING', 'ERROR', 'USAGE_LIMIT', 'SIGN_IN', 'STUCK')),
  severity text NOT NULL CHECK (severity IN ('INFO', 'ATTENTION')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'HANDLED', 'ESCALATED', 'RESOLVED', 'ACKED')),
  decision text CHECK (decision IS NULL OR char_length(decision) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_agent_events_room_created_idx ON room_agent_events (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_agent_events_pending_idx ON room_agent_events (room_id) WHERE status IN ('OPEN', 'ESCALATED');
