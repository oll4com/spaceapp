ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS is_completed boolean NOT NULL DEFAULT FALSE;