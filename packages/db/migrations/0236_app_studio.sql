-- App Studio pane (clipboard PLAN clipboard:v7hyZ76ThCyv): mobile apps (Expo) built by a CLI agent, with an image preview per
-- device type. Pane settings on the new APP_STUDIO mode (NULL reads as the defaults); one feed for briefs (operator or Nous →
-- agent), questions (agent → operator) and the activity timeline; the latest preview per pane, device and route (a room
-- SCREENSHOT artifact, never Agent Files); and the APP_STUDIO notification source.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS app_studio_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_app_studio_metadata_object
  CHECK (app_studio_metadata IS NULL OR (jsonb_typeof(app_studio_metadata) = 'object' AND app_studio_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS app_studio_events (
  id text PRIMARY KEY CHECK (id ~ '^asevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('BRIEF','QUESTION','ANSWERED','PREVIEW','NOTE','BRIEF_DONE','BRIEF_FAILED','SETTINGS_CHANGED',
    'RUN_STARTED','RUN_PAUSED','RUN_STOPPED')),
  status text,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'BRIEF' AND status IN ('PENDING','TAKEN','DONE','FAILED'))
    OR (type = 'QUESTION' AND status IN ('OPEN','ANSWERED'))
    OR (type NOT IN ('BRIEF','QUESTION') AND status IS NULL))
);
CREATE INDEX IF NOT EXISTS app_studio_events_pane_idx ON app_studio_events(owner_user_id, pane_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_studio_events_open_idx ON app_studio_events(pane_id, created_at) WHERE status IN ('PENDING','TAKEN','OPEN');

CREATE TABLE IF NOT EXISTS app_studio_previews (
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK (device_id ~ '^(android|iphone)-[0-9]{3}x[0-9]{3}$'),
  route text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 200 AND left(route, 1) = '/'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id text NOT NULL CHECK (artifact_id ~ '^artifact:[A-Za-z0-9_-]{6,80}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pane_id, device_id, route)
);

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'APP_STUDIO', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
