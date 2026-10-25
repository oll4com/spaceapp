ALTER TABLE pane_cli_transcript_chunks
  ADD COLUMN IF NOT EXISTS host_generation_id uuid;

ALTER TABLE pane_cli_transcript_chunks
  ADD COLUMN IF NOT EXISTS host_output_sequence bigint;

ALTER TABLE pane_cli_transcript_chunks
  DROP CONSTRAINT IF EXISTS pane_cli_transcript_chunks_host_cursor_check;

ALTER TABLE pane_cli_transcript_chunks
  ADD CONSTRAINT pane_cli_transcript_chunks_host_cursor_check
  CHECK (
    (host_generation_id IS NULL AND host_output_sequence IS NULL)
    OR (host_generation_id IS NOT NULL AND host_output_sequence >= 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_cli_transcript_host_output
  ON pane_cli_transcript_chunks(session_id, host_generation_id, host_output_sequence)
  WHERE host_generation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pane_cli_codex_thread_ownerships (
  thread_id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  cli_session_id text NOT NULL REFERENCES pane_cli_sessions(session_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('AUTO', 'HISTORY_TRANSFER', 'MIGRATION')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pane_cli_codex_thread_ownerships_thread_uuid_check CHECK (
    thread_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_pane_cli_codex_thread_ownerships_session
  ON pane_cli_codex_thread_ownerships(cli_session_id);

INSERT INTO pane_cli_codex_thread_ownerships (
  thread_id,
  room_id,
  pane_id,
  cli_session_id,
  source,
  created_at,
  updated_at
)
SELECT
  codex_thread_id,
  room_id,
  pane_id,
  session_id,
  'MIGRATION',
  started_at,
  now()
FROM pane_cli_sessions
WHERE is_active = true
  AND codex_thread_id IS NOT NULL
ON CONFLICT (thread_id) DO NOTHING;
