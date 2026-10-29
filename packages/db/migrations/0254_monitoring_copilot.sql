-- Monitoring Copilot pane (clipboard PLAN clipboard:xkCJ9CeYZq4D, operator request 2026-10-24): pane settings on the new
-- MONITORING_COPILOT mode (NULL reads as the defaults); the collector's alerts as the watcher last saw them (history: a resolved
-- alert is pruned 30 days after it ended); the copilot's own memory, separate from Space Memory; one feed per pane (briefs,
-- questions, reviews, the alert and guardian timeline); and the MONITORING_COPILOT notification source.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS monitoring_copilot_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_monitoring_copilot_metadata_object
  CHECK (monitoring_copilot_metadata IS NULL OR (jsonb_typeof(monitoring_copilot_metadata) = 'object' AND monitoring_copilot_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS monitoring_copilot_alerts (
  id text PRIMARY KEY CHECK (id ~ '^monalert:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  alertname text NOT NULL CHECK (char_length(alertname) BETWEEN 1 AND 200),
  severity text NOT NULL CHECK (severity IN ('CRITICAL','WARNING','INFO')),
  source text NOT NULL CHECK (source IN ('PROMETHEUS','LOKI')),
  instance text NOT NULL DEFAULT '' CHECK (char_length(instance) <= 300),
  job text NOT NULL DEFAULT '' CHECK (char_length(job) <= 200),
  labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  state text NOT NULL CHECK (state IN ('FIRING','RESOLVED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One row per firing episode: the same fingerprint firing again after it resolved starts a new row.
  episode integer NOT NULL DEFAULT 1 CHECK (episode >= 1),
  UNIQUE (owner_user_id, fingerprint, episode)
);
CREATE UNIQUE INDEX IF NOT EXISTS monitoring_copilot_alerts_firing_idx ON monitoring_copilot_alerts(owner_user_id, fingerprint) WHERE state = 'FIRING';
CREATE INDEX IF NOT EXISTS monitoring_copilot_alerts_owner_idx ON monitoring_copilot_alerts(owner_user_id, state, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_copilot_memory (
  id text PRIMARY KEY CHECK (id ~ '^monmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('HOST','RULE','FACT','LESSON','EXCEPTION','PLAYBOOK','PREFERENCE')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  target text CHECK (target IS NULL OR char_length(target) BETWEEN 1 AND 200),
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 20),
  source text NOT NULL CHECK (source IN ('USER','AGENT')),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  pinned boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scope text GENERATED ALWAYS AS (coalesce(target, '')) STORED,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(key, '') || ' ' || text)) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS monitoring_copilot_memory_owner_key_idx ON monitoring_copilot_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS monitoring_copilot_memory_owner_idx ON monitoring_copilot_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS monitoring_copilot_memory_search_idx ON monitoring_copilot_memory USING GIN (search);

CREATE TABLE IF NOT EXISTS monitoring_copilot_events (
  id text PRIMARY KEY CHECK (id ~ '^monevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('BRIEF','QUESTION','REVIEW','ANSWERED','REVIEWED','BRIEF_DONE','BRIEF_FAILED','ALERT','GUARDIAN','NOTE','DIGEST',
    'SETTINGS_CHANGED','RUN_STARTED','RUN_PAUSED','RUN_STOPPED')),
  status text,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'BRIEF' AND status IN ('PENDING','TAKEN','DONE','FAILED'))
    OR (type = 'QUESTION' AND status IN ('OPEN','ANSWERED'))
    OR (type = 'REVIEW' AND status IN ('OPEN','APPROVED','DECLINED'))
    OR (type NOT IN ('BRIEF','QUESTION','REVIEW') AND status IS NULL))
);
CREATE INDEX IF NOT EXISTS monitoring_copilot_events_pane_idx ON monitoring_copilot_events(owner_user_id, pane_id, created_at DESC);
CREATE INDEX IF NOT EXISTS monitoring_copilot_events_open_idx ON monitoring_copilot_events(pane_id, created_at) WHERE status IN ('PENDING','TAKEN','OPEN');
-- The watcher resumes the guardian cursor from the newest GUARDIAN row of the owner.
CREATE INDEX IF NOT EXISTS monitoring_copilot_events_guardian_idx ON monitoring_copilot_events(owner_user_id, created_at DESC) WHERE type = 'GUARDIAN';

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'APP_STUDIO', 'VIDEO', 'SECURITY_COPILOT', 'MONITORING_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM', 'AGENT'));
