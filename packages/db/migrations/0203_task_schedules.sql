-- Scheduled tasks (operator request 2026-10-15): Space types a task's objective into its CLI pane at each occurrence.
-- recurrence is the Dot schedule recurrence (ONCE, DAILY, WEEKLY, INTERVAL); a task without a pane is a reminder.
ALTER TABLE task_items
  ADD COLUMN IF NOT EXISTS recurrence jsonb,
  ADD COLUMN IF NOT EXISTS time_zone text CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outcome text CHECK (last_outcome IS NULL OR char_length(last_outcome) <= 500);

ALTER TABLE task_items DROP CONSTRAINT IF EXISTS task_items_schedule_complete;
ALTER TABLE task_items ADD CONSTRAINT task_items_schedule_complete CHECK ((recurrence IS NULL) = (time_zone IS NULL));

CREATE INDEX IF NOT EXISTS idx_task_items_next_run ON task_items(next_run_at) WHERE next_run_at IS NOT NULL;
