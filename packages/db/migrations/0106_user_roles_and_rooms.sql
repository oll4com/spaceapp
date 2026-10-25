-- User roles expansion ('OPERATOR', 'ADMIN', 'USER') and per-user rooms

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('OPERATOR', 'ADMIN', 'USER'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_rooms_owner_user_id ON rooms(owner_user_id);

-- Backfill existing rooms to primary operator/admin
UPDATE rooms
SET owner_user_id = (SELECT id FROM users WHERE role IN ('OPERATOR', 'ADMIN') ORDER BY created_at ASC LIMIT 1)
WHERE owner_user_id IS NULL;
