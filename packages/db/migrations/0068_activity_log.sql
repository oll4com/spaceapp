CREATE TABLE IF NOT EXISTS activity_log_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  enabled_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  disabled_at timestamptz,
  disabled_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO activity_log_settings (singleton_id, enabled)
VALUES (1, false)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS activity_log_events (
  id text PRIMARY KEY,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  reason text,
  trace_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_events_created_at
  ON activity_log_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_log_events_room
  ON activity_log_events (room_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_log_events_actor
  ON activity_log_events (actor_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activity_log_events_action
  ON activity_log_events (action, created_at DESC, id DESC);
