ALTER TABLE pane_browser_sessions
  ADD COLUMN IF NOT EXISTS restore_scroll_x integer;

ALTER TABLE pane_browser_sessions
  ADD COLUMN IF NOT EXISTS restore_scroll_y integer;

ALTER TABLE pane_browser_sessions
  ADD COLUMN IF NOT EXISTS restore_video_paused boolean;
