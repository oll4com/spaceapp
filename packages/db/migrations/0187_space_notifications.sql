-- Space notifications: what panes and services want the operator to see, per user, kept until read or
-- acknowledged and pruned after 30 days. One open notification per dedupe key.
CREATE TABLE IF NOT EXISTS space_notifications (
  id text PRIMARY KEY CHECK (id ~ '^notification:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'ROOM_AGENT', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM')),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  severity text NOT NULL CHECK (severity IN ('INFO', 'ATTENTION', 'URGENT')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  link jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(link) = 'object'),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'READ', 'ACKED', 'RESOLVED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  acked_at timestamptz,
  resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS space_notifications_open_dedupe_idx ON space_notifications (owner_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('OPEN', 'READ');
CREATE INDEX IF NOT EXISTS space_notifications_owner_created_idx ON space_notifications (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS space_notifications_owner_pending_idx ON space_notifications (owner_user_id) WHERE status = 'OPEN';

-- Notifications reach Telegram through the same outbox as task completions and Room Agent notices.
ALTER TABLE telegram_notification_outbox DROP CONSTRAINT IF EXISTS telegram_notification_outbox_source_type_check;
ALTER TABLE telegram_notification_outbox ADD CONSTRAINT telegram_notification_outbox_source_type_check
  CHECK (source_type IN ('CHAT', 'ROOM_AGENT', 'TERMINAL', 'TEST', 'NOTIFICATION'));
