-- Nous's turn facts (plan clipboard:L7RgHsveHbcR step 2): one row per turn with what it did, kept when the operator clears
-- the conversation, so Nous's progress can be measured against its 2026-10-17 baseline.
CREATE TABLE IF NOT EXISTS nous_turn_facts (
  turn_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('OPERATOR', 'INBOX', 'DECISION', 'HEARTBEAT')),
  status text NOT NULL CHECK (status IN ('DONE', 'FAILED', 'STOPPED', 'TIMEOUT')),
  tools jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_points integer NOT NULL DEFAULT 0,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS nous_turn_facts_owner_started_idx ON nous_turn_facts (owner_user_id, started_at DESC);
