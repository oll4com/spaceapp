-- A release train is product-wide (one per product), not part of a room. Since 0202 its row carried the captain's room, and deleting
-- that room deleted the train through room_id's ON DELETE CASCADE (stable 2026-10-28 08:49 UTC: run-spaceapp 1.1.9, its candidate and
-- the operator's approval gone with the captain pane's old room). Release trains keep no room; every other kind stays room-scoped.
ALTER TABLE space_control_records ALTER COLUMN room_id DROP NOT NULL;
UPDATE space_control_records SET room_id = NULL WHERE kind = 'release_train';
ALTER TABLE space_control_records DROP CONSTRAINT IF EXISTS space_control_records_room_check;
ALTER TABLE space_control_records ADD CONSTRAINT space_control_records_room_check CHECK (room_id IS NOT NULL OR kind = 'release_train');
