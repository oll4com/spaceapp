-- A goal's limit (operator 1/11 03:39 BKK, plan clipboard:ESIzQb7rHGQM): a deadline ({kind: DATE, until}) or a measurable bound
-- ({kind: TARGET, what}). A goal shows a progress percentage only when it has one. Nullable; nous_goals stays class A.
ALTER TABLE nous_goals ADD COLUMN IF NOT EXISTS limit_json jsonb;
ALTER TABLE nous_goal_events DROP CONSTRAINT IF EXISTS nous_goal_events_kind_check;
ALTER TABLE nous_goal_events ADD CONSTRAINT nous_goal_events_kind_check CHECK (kind IN ('CREATED', 'EDITED', 'PAUSED', 'RESUMED', 'DROPPED', 'REOPENED', 'PROGRESS', 'CRITERIA', 'PLANS', 'WAITS', 'NOTE', 'ACHIEVED', 'TURN', 'LIMIT'));
