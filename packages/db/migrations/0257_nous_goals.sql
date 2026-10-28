-- Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the operator's standing objectives, above plans. A goal is
-- the operator's exact words; Nous works it in GOAL turns of its own until it is ACHIEVED with evidence. Durable (class A): only the
-- operator's explicit delete removes a goal. Its events are its log (class B: pruned after 30 days).
CREATE TABLE IF NOT EXISTS nous_goals (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ACHIEVED', 'DROPPED')),
  priority integer NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  criteria text,
  plan_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  waits_on_json jsonb,
  note text,
  evidence text,
  last_worked_at timestamptz,
  next_turn_at timestamptz,
  fingerprint text,
  unchanged_turns integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  achieved_at timestamptz
);
CREATE INDEX IF NOT EXISTS nous_goals_owner_priority_idx ON nous_goals (owner_user_id, priority);
CREATE TABLE IF NOT EXISTS nous_goal_events (
  id bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id text NOT NULL REFERENCES nous_goals(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('CREATED', 'EDITED', 'PAUSED', 'RESUMED', 'DROPPED', 'REOPENED', 'PROGRESS', 'CRITERIA', 'PLANS', 'WAITS', 'NOTE', 'ACHIEVED', 'TURN')),
  text text NOT NULL,
  turn_id text
);
CREATE INDEX IF NOT EXISTS nous_goal_events_goal_at_idx ON nous_goal_events (goal_id, at DESC);
-- GOAL turns, and the goal each one worked, so the Goals view and space_nous_turn_costs show the cost per goal.
ALTER TABLE nous_turn_facts DROP CONSTRAINT IF EXISTS nous_turn_facts_reason_check;
ALTER TABLE nous_turn_facts ADD CONSTRAINT nous_turn_facts_reason_check CHECK (reason IN ('OPERATOR', 'INBOX', 'DECISION', 'HEARTBEAT', 'STANDING', 'REVIEW', 'GOAL'));
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS goal_id text;
