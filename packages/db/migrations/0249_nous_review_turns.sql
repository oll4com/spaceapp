-- Nous's daily self-review runs as a turn of its own (reason REVIEW, operator decision 2026-10-24: it replaces the scheduled task
-- "Nous: daily self-improvement review" that kept losing its pane). Its facts rows carry the new reason.
ALTER TABLE nous_turn_facts DROP CONSTRAINT IF EXISTS nous_turn_facts_reason_check;
ALTER TABLE nous_turn_facts ADD CONSTRAINT nous_turn_facts_reason_check CHECK (reason IN ('OPERATOR', 'INBOX', 'DECISION', 'HEARTBEAT', 'STANDING', 'REVIEW'));
