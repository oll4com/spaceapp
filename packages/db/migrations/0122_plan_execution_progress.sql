-- 0122_plan_execution_progress.sql
-- Add granular progress tracking, execution status, active agent telemetry, and structured steps to clipboard_items.

ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'PLANNED',
  ADD COLUMN IF NOT EXISTS progress_percentage integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_agent text,
  ADD COLUMN IF NOT EXISTS steps_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_progress_at timestamp with time zone;

ALTER TABLE clipboard_items
  DROP CONSTRAINT IF EXISTS clipboard_items_execution_status_check;
ALTER TABLE clipboard_items
  ADD CONSTRAINT clipboard_items_execution_status_check
  CHECK (execution_status IN ('PLANNED', 'IN_PROGRESS', 'PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED'));

ALTER TABLE clipboard_items
  DROP CONSTRAINT IF EXISTS clipboard_items_progress_percentage_check;
ALTER TABLE clipboard_items
  ADD CONSTRAINT clipboard_items_progress_percentage_check
  CHECK (progress_percentage >= 0 AND progress_percentage <= 100);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_execution_status
  ON clipboard_items (owner_user_id, execution_status, last_used_at DESC);
