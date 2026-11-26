-- Mail open tracking (operator order 22/11): one random token per tracked mail and each fetch of its 1x1 pixel. Class A (explicit delete
-- only): the operator's read receipts. A hit's token names a tracked mail; an unknown token stores nothing.
CREATE TABLE IF NOT EXISTS mail_open_messages (
  token text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_open_messages_owner ON mail_open_messages (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_open_hits (
  id bigserial PRIMARY KEY,
  token text NOT NULL REFERENCES mail_open_messages(token) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS mail_open_hits_token ON mail_open_hits (token, opened_at);
