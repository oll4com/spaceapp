CREATE TABLE IF NOT EXISTS space_agent_sessions (
  session_id text PRIMARY KEY,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'SPACE' CHECK (source IN ('SPACE')),
  status text NOT NULL CHECK (status IN ('UNBOUND', 'READY', 'SYNCING', 'RUNNING', 'BLOCKED', 'ERROR')),
  title text NOT NULL,
  thread_id text,
  selected_provider_id text,
  selected_model_id text,
  selected_model_config_id text,
  selected_provider_name text,
  selected_model_name text,
  selected_reasoning_key text,
  selected_tool_ids text[],
  is_active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agent_sessions_one_active_per_pane
  ON space_agent_sessions(pane_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_space_agent_sessions_room_updated_at
  ON space_agent_sessions(room_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_space_agent_sessions_pane_updated_at
  ON space_agent_sessions(pane_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS space_agent_messages (
  message_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  run_id text,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_space_agent_messages_session_created_at
  ON space_agent_messages(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS space_agent_runs (
  run_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  temporal_run_id text,
  codex_thread_id text,
  codex_turn_id text,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
  prompt_message_id text NOT NULL REFERENCES space_agent_messages(message_id) ON DELETE CASCADE,
  response_message_id text NOT NULL REFERENCES space_agent_messages(message_id) ON DELETE CASCADE,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agent_runs_workflow_id
  ON space_agent_runs(workflow_id);

CREATE INDEX IF NOT EXISTS idx_space_agent_runs_session_updated_at
  ON space_agent_runs(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_space_agent_runs_room_updated_at
  ON space_agent_runs(room_id, updated_at DESC);
