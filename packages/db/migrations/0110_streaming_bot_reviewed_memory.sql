CREATE TABLE IF NOT EXISTS streaming_bot_memory (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED')),
  source text NOT NULL CHECK (source IN ('OPERATOR', 'BOT', 'LEGACY')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_streaming_bot_memory_status_updated
  ON streaming_bot_memory (status, updated_at DESC);

INSERT INTO streaming_bot_memory (id, title, body, status, source, created_at, updated_at)
SELECT id, left(title, 160), left(body, 10000), 'PENDING', 'LEGACY', created_at, created_at
FROM memory_records
WHERE room_id = 'streaming-bot' AND provenance = 'streaming-bot'
  AND char_length(title) > 0 AND char_length(body) > 0
ON CONFLICT (id) DO NOTHING;
