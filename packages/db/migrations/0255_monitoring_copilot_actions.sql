-- Monitoring Copilot self-healing (clipboard PLAN clipboard:xkCJ9CeYZq4D Phase 4): the action log every change on a host goes through
-- (the gate's audit, never deleted, like the Security Copilot's), and the ACTION row type in the pane's feed.
CREATE TABLE IF NOT EXISTS monitoring_copilot_actions (
  id text PRIMARY KEY CHECK (id ~ '^monact:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL CHECK (pane_id ~ '^pane:[A-Za-z0-9_-]{6,80}$'),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 63),
  alert_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(alert_ids) <= 20),
  kind text NOT NULL CHECK (kind IN ('SERVICE_RESTART','GUEST_START','CONFIG_CHANGE','CACHE_CLEAR','HOST_REBOOT','DATA_DELETE','OTHER')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  commands text NOT NULL CHECK (char_length(commands) BETWEEN 1 AND 4000),
  backup text NOT NULL DEFAULT '' CHECK (char_length(backup) <= 1000),
  rollback text NOT NULL DEFAULT '' CHECK (char_length(rollback) <= 2000),
  gate text NOT NULL CHECK (gate IN ('GO','ASK')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  status text NOT NULL CHECK (status IN ('RUNNING','ASKED','APPROVED','DECLINED','VERIFIED','FAILED','ROLLED_BACK')),
  verification text CHECK (verification IS NULL OR char_length(verification) <= 4000),
  review_event_id text CHECK (review_event_id IS NULL OR review_event_id ~ '^monevt:[A-Za-z0-9_-]{6,80}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS monitoring_copilot_actions_owner_idx ON monitoring_copilot_actions(owner_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS monitoring_copilot_actions_target_idx ON monitoring_copilot_actions(owner_user_id, target, started_at DESC);

ALTER TABLE monitoring_copilot_events DROP CONSTRAINT IF EXISTS monitoring_copilot_events_type_check;
ALTER TABLE monitoring_copilot_events ADD CONSTRAINT monitoring_copilot_events_type_check
  CHECK (type IN ('BRIEF','QUESTION','REVIEW','ANSWERED','REVIEWED','BRIEF_DONE','BRIEF_FAILED','ALERT','GUARDIAN','ACTION','NOTE','DIGEST',
    'SETTINGS_CHANGED','RUN_STARTED','RUN_PAUSED','RUN_STOPPED'));
