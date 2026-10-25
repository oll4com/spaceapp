ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS pane_layout_columns smallint;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_pane_layout_columns_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_pane_layout_columns_check
  CHECK (pane_layout_columns IS NULL OR pane_layout_columns BETWEEN 1 AND 4);
