ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS pane_layout_height smallint NOT NULL DEFAULT 1;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_pane_layout_height_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_pane_layout_height_check
  CHECK (pane_layout_height BETWEEN 1 AND 4);

UPDATE rooms
SET
  pane_layout_columns = 1,
  pane_layout_height = 2
WHERE pane_layout_columns = 5;

UPDATE rooms
SET
  pane_layout_columns = 1,
  pane_layout_height = 3
WHERE pane_layout_columns = 6;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_pane_layout_columns_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_pane_layout_columns_check
  CHECK (pane_layout_columns IS NULL OR pane_layout_columns BETWEEN 0 AND 4);
