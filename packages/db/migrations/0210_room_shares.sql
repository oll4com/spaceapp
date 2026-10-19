-- Room sharing (multi-user step 3, plan clipboard:evAaFYqrgDfd), used only with SPACE_MULTI_USER_ENABLED=true.
-- A room's owner shares it with VIEW (read only) or COLLABORATE (own panes in the room).
CREATE TABLE IF NOT EXISTS room_shares (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('VIEW', 'COLLABORATE')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_shares_user ON room_shares(user_id);

-- The user who opened a pane in a room they do not own; NULL means the room's owner. Only a pane's owner types into it.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
