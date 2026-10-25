-- Track whether a user's starter room has already been initialized / opened once
ALTER TABLE users ADD COLUMN IF NOT EXISTS starter_room_initialized boolean NOT NULL DEFAULT false;

-- Backfill existing users as initialized so their rooms are not recreated if deleted
UPDATE users SET starter_room_initialized = true;
