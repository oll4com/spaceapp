-- The operator's per-room "Nous off" switch (rooms dock): Nous neither reads nor acts in such a room.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS nous_excluded boolean NOT NULL DEFAULT false;
