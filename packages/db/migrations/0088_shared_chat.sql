CREATE TABLE IF NOT EXISTS shared_chat_messages (
  id text PRIMARY KEY,
  sender_type text NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
  sender_id text,
  sender_label text NOT NULL,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('message', 'reaction', 'system')),
  content text NOT NULL,
  reply_to_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shared_chat_created
  ON shared_chat_messages (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_shared_chat_sender
  ON shared_chat_messages (sender_type, sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_chat_room
  ON shared_chat_messages (room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_chat_kind
  ON shared_chat_messages (kind, created_at DESC);
