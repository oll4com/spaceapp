CREATE TABLE IF NOT EXISTS clipboard_items (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 100000 AND text ~ '[^[:space:]]'),
  source text NOT NULL CHECK (source IN ('COPY', 'PASTE', 'MANUAL_NOTE', 'AGENT_NOTE')),
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  pane_title text CHECK (pane_title IS NULL OR char_length(pane_title) BETWEEN 1 AND 160),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  character_count integer NOT NULL CHECK (character_count = char_length(text)),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_clipboard_items_owner_recent
  ON clipboard_items(owner_user_id, last_used_at DESC, id DESC);
