ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS status_reason text NOT NULL DEFAULT 'MCP server metadata has not been discovered yet.',
  ADD COLUMN IF NOT EXISTS tool_count integer NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  ADD COLUMN IF NOT EXISTS last_discovered_at timestamptz;

ALTER TABLE mcp_tools
  ADD COLUMN IF NOT EXISTS status_reason text NOT NULL DEFAULT 'MCP tool execution remains disabled until approval policy passes.';

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status_updated
  ON mcp_servers(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_status
  ON mcp_tools(server_id, status, updated_at DESC);
