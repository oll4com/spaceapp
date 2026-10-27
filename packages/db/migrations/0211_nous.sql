-- Nous, the mind of SpaceApp (operator decision 2026-10-17): one Claude Opus 5.5 per owner over every room, copilot and plan.
-- Its conversation (operator messages, inbox summaries, tool rows, answers), the critical decisions it brings to the
-- operator (with the action the server runs on a yes) and its own notes (the plan map, standing instructions).
CREATE TABLE IF NOT EXISTS nous_messages (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id text,
  kind text NOT NULL CHECK (kind IN ('OPERATOR', 'INBOX', 'ANSWER', 'TOOL', 'DECISION', 'ERROR')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED', 'REFUSED')),
  content text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nous_messages_owner_created_idx ON nous_messages (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nous_decisions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('RELEASE', 'DESTRUCTIVE', 'EXTERNAL', 'DIRECTION')),
  title text NOT NULL,
  body text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text,
  refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  action jsonb,
  status text NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'DECLINED', 'ANSWERED', 'CANCELLED')),
  answer text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS nous_decisions_owner_status_idx ON nous_decisions (owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS nous_notes (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, key)
);

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
