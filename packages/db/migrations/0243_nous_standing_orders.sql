-- Nous standing orders (operator orders 2026-10-21): Space finds the finished CLI panes and the stalled plans every tick and
-- brings them to Nous in a STANDING turn until each is handled; Nous asks a finished pane to save to memory and closes it.
-- One row per pane with where its close-out stands (what Nous asked, what Space verified, when it closed).
CREATE TABLE IF NOT EXISTS nous_pane_closeouts (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  room_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('SAVE_REQUESTED', 'SAVE_RETRIED', 'VERIFIED', 'CLOSED')),
  requested_at timestamptz NOT NULL,
  retried_at timestamptz,
  verified_memory_id text,
  closed_at timestamptz,
  reason text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, pane_id)
);
-- A plan's steps count as movement too, and when a STANDING turn last nudged it (one nudge per plan per stalled window).
ALTER TABLE nous_plan_marks ADD COLUMN IF NOT EXISTS steps_fingerprint text;
ALTER TABLE nous_plan_marks ADD COLUMN IF NOT EXISTS last_nudged_at timestamptz;
-- KEEP_OPEN: a finished pane Nous keeps open until its next check (waits on the operator, a date or a promote).
ALTER TABLE nous_pane_checks DROP CONSTRAINT IF EXISTS nous_pane_checks_verdict_check;
ALTER TABLE nous_pane_checks ADD CONSTRAINT nous_pane_checks_verdict_check
  CHECK (verdict IN ('OK_WORKING', 'WAITING_OPERATOR', 'WAITING_DATE', 'NEEDS_ACTION', 'BLOCKED', 'OPERATOR_TEST', 'KEEP_OPEN'));
-- STANDING turns, and what each turn ran on and cost (Claude Code's total_cost_usd and modelUsage), for the model study.
ALTER TABLE nous_turn_facts DROP CONSTRAINT IF EXISTS nous_turn_facts_reason_check;
ALTER TABLE nous_turn_facts ADD CONSTRAINT nous_turn_facts_reason_check CHECK (reason IN ('OPERATOR', 'INBOX', 'DECISION', 'HEARTBEAT', 'STANDING'));
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS effort text;
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 6);
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS tokens jsonb;
