ALTER TABLE panes
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'auto';

ALTER TABLE panes
  ADD CONSTRAINT panes_title_source_check CHECK (title_source IN ('auto', 'manual', 'ai'));