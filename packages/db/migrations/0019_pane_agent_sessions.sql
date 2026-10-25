CREATE TABLE IF NOT EXISTS pane_agent_sessions (
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('CODER')),
  coder_chat_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('UNBOUND', 'READY', 'SYNCING', 'RUNNING', 'BLOCKED', 'ERROR')),
  title text NOT NULL,
  selected_model_config_id text,
  selected_provider_name text,
  selected_model_name text,
  selected_reasoning_key text,
  selected_tool_ids text[],
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pane_id, coder_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_pane_agent_sessions_room_updated_at
  ON pane_agent_sessions(room_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pane_agent_sessions_coder_chat_id
  ON pane_agent_sessions(coder_chat_id);
