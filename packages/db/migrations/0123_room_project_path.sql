-- 0123_room_project_path.sql
-- Add project_path to rooms for associating a room with a specific project root directory.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS project_path text;
