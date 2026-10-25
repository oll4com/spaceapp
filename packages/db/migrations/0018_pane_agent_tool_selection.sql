ALTER TABLE pane_agent_bindings
  ADD COLUMN IF NOT EXISTS selected_tool_ids text[];
