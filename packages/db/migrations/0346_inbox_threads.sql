-- «Εισερχόμενα» v2 (spec v2 §2.1, plan clipboard:aE7U1J_gU9OV): one Thread per request, plan or item, and its append-only events, each pointing
-- at the source record that still executes (space_notifications, nous_decisions, the operator's messages). Durable: never deleted automatically.
CREATE TABLE IF NOT EXISTS space_inbox_threads (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('OPERATOR', 'NOUS', 'AGENT', 'COPILOT', 'SYSTEM')),
  origin_label text NOT NULL,
  waiting_for text NOT NULL CHECK (waiting_for IN ('OPERATOR', 'NOUS', 'AGENT', 'NOBODY')),
  unseen boolean NOT NULL DEFAULT false,
  closed_at timestamptz,
  closed_by text CHECK (closed_by IN ('OPERATOR', 'SOURCE')),
  priority text NOT NULL CHECK (priority IN ('URGENT', 'ATTENTION', 'INFO')),
  now text NOT NULL DEFAULT '',
  progress integer CHECK (progress BETWEEN 0 AND 100),
  refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  UNIQUE (owner_user_id, key)
);
CREATE INDEX IF NOT EXISTS space_inbox_threads_recent ON space_inbox_threads (owner_user_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS space_inbox_threads_plan ON space_inbox_threads (owner_user_id, (refs->>'planId'));

CREATE TABLE IF NOT EXISTS space_inbox_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES space_inbox_threads(id) ON DELETE CASCADE,
  -- What the event mirrors (<ref>:<TYPE>:<n>): a source change is recorded once however often it is synced.
  source_key text NOT NULL,
  seq bigserial,
  at timestamptz NOT NULL,
  type text NOT NULL CHECK (type IN ('REQUEST', 'ASK', 'ANSWER', 'PROGRESS', 'REPORT', 'UPDATE', 'ALERT', 'NOTE', 'CLOSED', 'REOPENED')),
  actor text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  priority text NOT NULL CHECK (priority IN ('URGENT', 'ATTENTION', 'INFO')),
  ref text,
  ask jsonb,
  UNIQUE (owner_user_id, source_key)
);
CREATE INDEX IF NOT EXISTS space_inbox_events_thread ON space_inbox_events (thread_id, seq);
CREATE INDEX IF NOT EXISTS space_inbox_events_ref ON space_inbox_events (owner_user_id, ref);
