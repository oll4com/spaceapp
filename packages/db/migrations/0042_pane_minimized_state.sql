ALTER TABLE panes
  ADD COLUMN IF NOT EXISTS is_minimized boolean NOT NULL DEFAULT false;

ALTER TABLE panes
  DROP CONSTRAINT IF EXISTS panes_maximized_minimized_exclusive;

ALTER TABLE panes
  ADD CONSTRAINT panes_maximized_minimized_exclusive
  CHECK (NOT (is_maximized AND is_minimized));
