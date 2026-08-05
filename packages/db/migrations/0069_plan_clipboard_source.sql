ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS title text;

ALTER TABLE clipboard_items
  DROP CONSTRAINT IF EXISTS clipboard_items_source_check;

ALTER TABLE clipboard_items
  ADD CONSTRAINT clipboard_items_source_check
  CHECK (source IN ('COPY', 'PASTE', 'MANUAL_NOTE', 'AGENT_NOTE', 'PLAN'));

ALTER TABLE clipboard_items
  DROP CONSTRAINT IF EXISTS clipboard_items_title_check;

ALTER TABLE clipboard_items
  ADD CONSTRAINT clipboard_items_title_check
  CHECK (title IS NULL OR (char_length(title) BETWEEN 1 AND 160));
