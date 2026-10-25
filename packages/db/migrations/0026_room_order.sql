ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS room_order integer;

WITH ordered AS (
  SELECT
    id,
    row_number() OVER (ORDER BY updated_at DESC, created_at DESC, id ASC) - 1 AS next_order
  FROM rooms
)
UPDATE rooms
SET room_order = ordered.next_order
FROM ordered
WHERE rooms.id = ordered.id
  AND rooms.room_order IS NULL;

ALTER TABLE rooms
  ALTER COLUMN room_order SET DEFAULT 0;

ALTER TABLE rooms
  ALTER COLUMN room_order SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_order ON rooms(room_order);
