-- Agent Tools: per-tool assignment of MCP servers and skills to CLI runtimes.
-- Scope semantics:
--   COMMON   -> enabled for every writable CLI runtime
--   SPECIFIC -> enabled only for the runtimes listed in runtime_ids
--   NONE     -> explicitly disabled everywhere
CREATE TABLE IF NOT EXISTS agent_tool_assignments (
  tool_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('MCP', 'SKILL')),
  scope text NOT NULL CHECK (scope IN ('COMMON', 'SPECIFIC', 'NONE')),
  runtime_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE INDEX IF NOT EXISTS agent_tool_assignments_kind_idx ON agent_tool_assignments (kind);
