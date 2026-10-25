CREATE TABLE IF NOT EXISTS task_items (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND title ~ '[^[:space:]]'),
  objective text NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 10000 AND objective ~ '[^[:space:]]'),
  status text NOT NULL CHECK (status IN ('OPEN', 'RUNNING', 'DONE', 'ARCHIVED')),
  source text NOT NULL CHECK (source IN ('MANUAL', 'AGENT')),
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  pane_title text CHECK (pane_title IS NULL OR char_length(pane_title) BETWEEN 1 AND 160),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  character_count integer NOT NULL CHECK (character_count = char_length(objective)),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_task_items_owner_recent
  ON task_items(owner_user_id, last_used_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_items_owner_status
  ON task_items(owner_user_id, status, last_used_at DESC, id DESC);
