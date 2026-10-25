CREATE TABLE IF NOT EXISTS pane_agent_bindings (
  pane_id text PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('CODER')),
  coder_chat_id text,
  status text NOT NULL CHECK (status IN ('UNBOUND', 'READY', 'SYNCING', 'RUNNING', 'BLOCKED', 'ERROR')),
  title text NOT NULL,
  selected_model_config_id text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pane_agent_bindings_coder_chat_id
  ON pane_agent_bindings(coder_chat_id)
  WHERE coder_chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pane_agent_bindings_status
  ON pane_agent_bindings(status, updated_at);
