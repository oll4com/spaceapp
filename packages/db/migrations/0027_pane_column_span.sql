ALTER TABLE panes
ADD COLUMN IF NOT EXISTS column_span integer NOT NULL DEFAULT 1;

ALTER TABLE panes
DROP CONSTRAINT IF EXISTS panes_column_span_check;

ALTER TABLE panes
ADD CONSTRAINT panes_column_span_check CHECK (column_span BETWEEN 1 AND 3);
