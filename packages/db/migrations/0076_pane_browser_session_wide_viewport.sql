ALTER TABLE pane_browser_sessions
  DROP CONSTRAINT IF EXISTS pane_browser_sessions_viewport_check;

ALTER TABLE pane_browser_sessions
  ADD CONSTRAINT pane_browser_sessions_viewport_check
  CHECK (viewport IN ('mobile', 'tablet', 'desktop', 'wide'));
