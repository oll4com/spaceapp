-- Anthropic billing (operator request 2026-10-18, plan clipboard:1uiLgPcnGg4P): the operator's Anthropic Admin API key,
-- sealed by Space Gateway (AES-256-GCM, its encryption key file) and never returned, and the organization's daily
-- cost and usage reports it reads, so Token usage shows the real charge and the daily COST_USD caps count it.
CREATE TABLE IF NOT EXISTS space_gateway_anthropic_admin (
  settings_id smallint PRIMARY KEY DEFAULT 1 CHECK (settings_id = 1),
  key_encrypted text NOT NULL,
  key_hint text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  last_error text,
  -- The Anthropic API keys behind the gateway's Claude API-key accounts: [{accountId, apiKeyId, keyName, workspaceId}].
  upstream jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- One row per UTC day and cell. COST rows hold cents (cost_report, grouped by workspace and description), USAGE rows
-- tokens or web search requests (usage_report/messages, grouped by workspace, API key, model, context window, speed).
-- An empty workspace_id is the default workspace; COST rows have an empty api_key_id.
CREATE TABLE IF NOT EXISTS space_gateway_anthropic_usage (
  day date NOT NULL,
  source text NOT NULL CHECK (source IN ('COST', 'USAGE')),
  workspace_id text NOT NULL DEFAULT '',
  api_key_id text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  context_window text NOT NULL DEFAULT '',
  speed text NOT NULL DEFAULT '',
  item text NOT NULL,
  value double precision NOT NULL,
  PRIMARY KEY (day, source, workspace_id, api_key_id, model, context_window, speed, item)
);
