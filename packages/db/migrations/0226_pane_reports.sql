-- Pane reports to Nous (operator request 2026-10-17, plan clipboard:ot6-jLKOWDNC): what each CLI pane reports about its work,
-- pushed by the agent (space-progress) or recorded by Space itself (AUTO: a turn's last answer, todo progress, heartbeats,
-- questions), so Nous sees every pane's progress without reading screens. Pane text is untrusted data; kept 14 days.
CREATE TABLE IF NOT EXISTS pane_reports (
  id bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL,
  pane_id text NOT NULL,
  at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('AGENT', 'AUTO')),
  status text NOT NULL CHECK (status IN ('STARTED', 'PROGRESS', 'BLOCKED', 'NEEDS_DECISION', 'WAITING', 'DONE', 'FAILED', 'TURN_END', 'TODO', 'HEARTBEAT', 'QUESTION')),
  summary text NOT NULL,
  plan_id text,
  step integer,
  percent integer CHECK (percent BETWEEN 0 AND 100),
  ticket text,
  next_step text,
  needs text,
  body text
);
CREATE INDEX IF NOT EXISTS pane_reports_pane ON pane_reports (owner_user_id, pane_id, at DESC);
CREATE INDEX IF NOT EXISTS pane_reports_at ON pane_reports (at);
