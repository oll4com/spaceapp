ALTER TABLE cli_tasks
  ADD COLUMN IF NOT EXISTS history_hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cli_tasks_visible_history
  ON cli_tasks(updated_at DESC, task_id DESC)
  WHERE history_hidden_at IS NULL;
