ALTER TABLE pane_agent_bindings
  ADD COLUMN IF NOT EXISTS selected_provider_name text,
  ADD COLUMN IF NOT EXISTS selected_model_name text,
  ADD COLUMN IF NOT EXISTS selected_reasoning_key text;

CREATE INDEX IF NOT EXISTS idx_pane_agent_bindings_updated_at
  ON pane_agent_bindings(updated_at DESC);
