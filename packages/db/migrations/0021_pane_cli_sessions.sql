CREATE TABLE IF NOT EXISTS pane_cli_sessions (
  session_id text PRIMARY KEY,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  runtime_id text NOT NULL,
  provider_id text NOT NULL,
  agent_id text NOT NULL,
  model_id text,
  reasoning_effort text NOT NULL CHECK (reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
  cwd text,
  status text NOT NULL CHECK (status IN ('IDLE', 'RUNNING', 'INTERRUPTING', 'EXITED', 'ERROR')),
  status_reason text,
  exit_code integer,
  is_active boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_cli_sessions_one_active_per_pane
  ON pane_cli_sessions(pane_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_room_updated_at
  ON pane_cli_sessions(room_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pane_cli_sessions_pane_updated_at
  ON pane_cli_sessions(pane_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pane_cli_transcript_chunks (
  chunk_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_cli_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  stream text NOT NULL CHECK (stream IN ('stdin', 'stdout', 'stderr', 'system')),
  content text NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_cli_transcript_chunks_session_sequence
  ON pane_cli_transcript_chunks(session_id, sequence);

CREATE INDEX IF NOT EXISTS idx_pane_cli_transcript_chunks_session_created_at
  ON pane_cli_transcript_chunks(session_id, created_at DESC);
