-- Video pane (clipboard PLAN clipboard:-HpLbbtWKj53, operator request 2026-10-21): pane settings and view on the new VIDEO mode;
-- requests from other agents, panes, Nous, Dots, Live and the operator (a queue a Video pane takes and delivers); the assets it
-- made (a Media artifact each, pinned while in the library; outputs keep their timeline); its activity feed; and the VIDEO
-- notification source. A NULL video_metadata reads as the defaults.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS video_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_video_metadata_object
  CHECK (video_metadata IS NULL OR (jsonb_typeof(video_metadata) = 'object' AND video_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS video_requests (
  id text PRIMARY KEY CHECK (id ~ '^vreq:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_pane_id text,
  requester jsonb NOT NULL CHECK (jsonb_typeof(requester) = 'object'),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 4000),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 8),
  format_ids text[] NOT NULL CHECK (cardinality(format_ids) BETWEEN 1 AND 8),
  options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  callback jsonb CHECK (callback IS NULL OR jsonb_typeof(callback) = 'object'),
  status text NOT NULL CHECK (status IN ('QUEUED','TAKEN','IN_PROGRESS','NEEDS_APPROVAL','DELIVERED','FAILED','CANCELLED')),
  result_asset_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(result_asset_ids) <= 32),
  question text CHECK (question IS NULL OR char_length(question) <= 2000),
  answer text CHECK (answer IS NULL OR char_length(answer) <= 2000),
  message text CHECK (message IS NULL OR char_length(message) <= 2000),
  taken_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_requests_owner_idx ON video_requests(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS video_requests_open_idx ON video_requests(owner_user_id, created_at)
  WHERE status IN ('QUEUED','TAKEN','IN_PROGRESS','NEEDS_APPROVAL');

CREATE TABLE IF NOT EXISTS video_assets (
  id text PRIMARY KEY CHECK (id ~ '^vasset:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  request_id text REFERENCES video_requests(id) ON DELETE SET NULL,
  artifact_id text NOT NULL CHECK (artifact_id ~ '^artifact:[A-Za-z0-9_-]{6,80}$'),
  thumbnail_artifact_id text CHECK (thumbnail_artifact_id IS NULL OR thumbnail_artifact_id ~ '^artifact:[A-Za-z0-9_-]{6,80}$'),
  format_id text CHECK (format_id IS NULL OR char_length(format_id) BETWEEN 1 AND 40),
  width integer CHECK (width IS NULL OR width BETWEEN 1 AND 8192),
  height integer CHECK (height IS NULL OR height BETWEEN 1 AND 8192),
  duration_sec double precision CHECK (duration_sec IS NULL OR duration_sec BETWEEN 0 AND 86400),
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4','video/webm','image/png','audio/mpeg','audio/wav')),
  kind text NOT NULL CHECK (kind IN ('OUTPUT','UPLOAD','RECORDING','NARRATION','MUSIC')),
  label text CHECK (label IS NULL OR char_length(label) <= 200),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  made_by jsonb CHECK (made_by IS NULL OR jsonb_typeof(made_by) = 'object'),
  credits text CHECK (credits IS NULL OR char_length(credits) <= 1000),
  timeline jsonb CHECK (timeline IS NULL OR jsonb_typeof(timeline) = 'object'),
  parent_asset_id text REFERENCES video_assets(id) ON DELETE SET NULL,
  pinned boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_assets_owner_idx ON video_assets(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_assets_request_idx ON video_assets(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_assets_parent_idx ON video_assets(parent_asset_id) WHERE parent_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS video_events (
  id text PRIMARY KEY CHECK (id ~ '^vevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  request_id text,
  asset_id text,
  type text NOT NULL CHECK (type IN ('REQUEST_CREATED','REQUEST_TAKEN','SOURCE_ADDED','RECORDING_SAVED','JOB_STARTED','JOB_DONE','JOB_FAILED','ASSET_SAVED','ASSET_DELETED',
    'QUESTION','ANSWER','APPROVAL_REQUESTED','APPROVED','DELIVERED','FAILED','CANCELLED','SETTINGS_CHANGED','RUN_STARTED','NOTE')),
  message text NOT NULL CHECK (char_length(message) <= 2000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_events_owner_idx ON video_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_events_request_idx ON video_events(request_id, created_at) WHERE request_id IS NOT NULL;

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'APP_STUDIO', 'VIDEO', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
