-- Confirmed host dimensions survive API restarts; generation prevents reuse
-- after a process replacement. Resizing does not update task/activity times.
ALTER TABLE pane_cli_sessions ADD COLUMN IF NOT EXISTS terminal_geometry jsonb;
