-- Space Gateway: the native account load balancer that replaces the external codex-lb and Headroom services.
-- Accounts hold provider credentials encrypted by the gateway (AES-256-GCM); nothing else in Space reads them.
-- Request logs keep token counts and costs only, never prompts or responses.
CREATE TABLE IF NOT EXISTS space_gateway_accounts (
  account_id text PRIMARY KEY CHECK (account_id ~ '^gw_account:[a-f0-9]{32}$'),
  provider text NOT NULL CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK','OPENROUTER','GOOGLE_AI','KIMI','QWEN')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  -- The provider's own account id (ChatGPT account id, Google project, ...); one gateway account per upstream account.
  external_account_id text CHECK (external_account_id IS NULL OR char_length(external_account_id) BETWEEN 1 AND 200),
  plan_type text CHECK (plan_type IS NULL OR char_length(plan_type) <= 40),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RATE_LIMITED','QUOTA_EXCEEDED','PAUSED','DEACTIVATED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 500),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  warmup_enabled boolean NOT NULL DEFAULT false,
  credentials_encrypted text NOT NULL CHECK (char_length(credentials_encrypted) BETWEEN 1 AND 65536),
  credentials_expires_at timestamptz,
  source text NOT NULL CHECK (source IN ('OAUTH','IMPORT_AUTH_JSON','IMPORT_CODEX_LB','PROFILE_ADOPTION','API_KEY')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  last_refresh_at timestamptz,
  blocked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS space_gateway_accounts_external_idx
  ON space_gateway_accounts(provider, external_account_id) WHERE external_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS space_gateway_accounts_provider_idx ON space_gateway_accounts(provider, status);

-- Latest known usage per account window. quota_key separates quota groups of one account (Antigravity: gemini/claude).
CREATE TABLE IF NOT EXISTS space_gateway_usage_windows (
  account_id text NOT NULL REFERENCES space_gateway_accounts(account_id) ON DELETE CASCADE,
  quota_key text NOT NULL DEFAULT '' CHECK (char_length(quota_key) <= 80),
  usage_window text NOT NULL CHECK (usage_window IN ('PRIMARY','SECONDARY')),
  used_percent double precision CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
  reset_at timestamptz,
  window_minutes integer CHECK (window_minutes IS NULL OR window_minutes BETWEEN 1 AND 44640),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, quota_key, usage_window)
);

CREATE TABLE IF NOT EXISTS space_gateway_usage_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES space_gateway_accounts(account_id) ON DELETE CASCADE,
  quota_key text NOT NULL DEFAULT '' CHECK (char_length(quota_key) <= 80),
  usage_window text NOT NULL CHECK (usage_window IN ('PRIMARY','SECONDARY')),
  used_percent double precision NOT NULL CHECK (used_percent >= 0 AND used_percent <= 100),
  reset_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS space_gateway_usage_history_account_idx ON space_gateway_usage_history(account_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS space_gateway_usage_history_recorded_idx ON space_gateway_usage_history(recorded_at);

CREATE TABLE IF NOT EXISTS space_gateway_api_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^gw_key:[a-f0-9]{32}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 4 AND 20),
  is_active boolean NOT NULL DEFAULT true,
  traffic_class text NOT NULL DEFAULT 'INTERACTIVE' CHECK (traffic_class IN ('INTERACTIVE','BACKGROUND','TRANSLATION')),
  allowed_models text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_models) <= 100),
  enforced_model text CHECK (enforced_model IS NULL OR char_length(enforced_model) BETWEEN 1 AND 120),
  allowed_reasoning_efforts text[] NOT NULL DEFAULT '{}' CHECK (allowed_reasoning_efforts <@ ARRAY['none','minimal','low','medium','high','xhigh','max','ultra']::text[]),
  enforced_reasoning_effort text CHECK (enforced_reasoning_effort IS NULL OR enforced_reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra')),
  account_scope_enabled boolean NOT NULL DEFAULT false,
  compression_override text CHECK (compression_override IS NULL OR compression_override IN ('OFF','SHADOW','ON')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by text CHECK (created_by IS NULL OR char_length(created_by) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS space_gateway_api_key_accounts (
  key_id text NOT NULL REFERENCES space_gateway_api_keys(key_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES space_gateway_accounts(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, account_id)
);
CREATE INDEX IF NOT EXISTS space_gateway_api_key_accounts_account_idx ON space_gateway_api_key_accounts(account_id);

CREATE TABLE IF NOT EXISTS space_gateway_api_key_limits (
  limit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id text NOT NULL REFERENCES space_gateway_api_keys(key_id) ON DELETE CASCADE,
  limit_type text NOT NULL CHECK (limit_type IN ('TOTAL_TOKENS','INPUT_TOKENS','OUTPUT_TOKENS','COST_USD')),
  limit_window text NOT NULL CHECK (limit_window IN ('DAILY','WEEKLY','MONTHLY')),
  max_value bigint NOT NULL CHECK (max_value > 0),
  current_value bigint NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  model_filter text CHECK (model_filter IS NULL OR char_length(model_filter) BETWEEN 1 AND 120),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS space_gateway_api_key_limits_key_idx ON space_gateway_api_key_limits(key_id);

-- One row of routing and compression settings.
CREATE TABLE IF NOT EXISTS space_gateway_settings (
  settings_id smallint PRIMARY KEY DEFAULT 1 CHECK (settings_id = 1),
  routing_strategy text NOT NULL DEFAULT 'CAPACITY_WEIGHTED' CHECK (routing_strategy IN
    ('CAPACITY_WEIGHTED','RELATIVE_AVAILABILITY','USAGE_WEIGHTED','ROUND_ROBIN','FILL_FIRST','SEQUENTIAL_DRAIN','RESET_DRAIN','SINGLE_ACCOUNT')),
  sticky_threads_enabled boolean NOT NULL DEFAULT true,
  prefer_earlier_reset boolean NOT NULL DEFAULT false,
  plan_priority text[] NOT NULL DEFAULT ARRAY['plus','prolite','pro']::text[] CHECK (cardinality(plan_priority) <= 20),
  sticky_reallocation_budget_threshold_percent double precision NOT NULL DEFAULT 95 CHECK (sticky_reallocation_budget_threshold_percent BETWEEN 0 AND 100),
  exhaustion_floor_percent double precision NOT NULL DEFAULT 3 CHECK (exhaustion_floor_percent BETWEEN 0 AND 50),
  compression_mode text NOT NULL DEFAULT 'OFF' CHECK (compression_mode IN ('OFF','SHADOW','ON')),
  compression_profile text NOT NULL DEFAULT 'TOKEN' CHECK (compression_profile IN ('CACHE','TOKEN')),
  compression_time_budget_ms integer NOT NULL DEFAULT 250 CHECK (compression_time_budget_ms BETWEEN 10 AND 5000),
  request_log_retention_days integer NOT NULL DEFAULT 30 CHECK (request_log_retention_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO space_gateway_settings(settings_id) VALUES (1) ON CONFLICT (settings_id) DO NOTHING;

-- Which account owns a conversation, thread or prompt cache. Keys are SHA-256 hashes; raw keys are never stored.
CREATE TABLE IF NOT EXISTS space_gateway_sticky_bindings (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('CODEX_SESSION','STICKY_THREAD','PROMPT_CACHE','CONTINUATION')),
  provider text NOT NULL CHECK (provider IN ('CODEX','CLAUDE','ANTIGRAVITY','COPILOT','OPENAI_API','ANTHROPIC_API','DEEPSEEK','OPENROUTER','GOOGLE_AI','KIMI','QWEN')),
  account_id text NOT NULL REFERENCES space_gateway_accounts(account_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS space_gateway_sticky_bindings_account_idx ON space_gateway_sticky_bindings(account_id);
CREATE INDEX IF NOT EXISTS space_gateway_sticky_bindings_expires_idx ON space_gateway_sticky_bindings(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS space_gateway_request_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 120),
  requested_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  account_id text REFERENCES space_gateway_accounts(account_id) ON DELETE SET NULL,
  api_key_id text REFERENCES space_gateway_api_keys(key_id) ON DELETE SET NULL,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  plan_type text CHECK (plan_type IS NULL OR char_length(plan_type) <= 40),
  reasoning_effort text CHECK (reasoning_effort IS NULL OR char_length(reasoning_effort) <= 20),
  requested_service_tier text CHECK (requested_service_tier IS NULL OR char_length(requested_service_tier) <= 40),
  service_tier text CHECK (service_tier IS NULL OR char_length(service_tier) <= 40),
  transport text CHECK (transport IS NULL OR char_length(transport) <= 40),
  upstream_transport text CHECK (upstream_transport IS NULL OR char_length(upstream_transport) <= 40),
  status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 40),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 120),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 1000),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  first_token_ms integer CHECK (first_token_ms IS NULL OR first_token_ms >= 0),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_usd double precision CHECK (cost_usd IS NULL OR cost_usd >= 0),
  compression_tokens_saved bigint CHECK (compression_tokens_saved IS NULL OR compression_tokens_saved >= 0),
  sticky_key_source text CHECK (sticky_key_source IS NULL OR char_length(sticky_key_source) <= 40),
  sticky_kind text CHECK (sticky_kind IS NULL OR char_length(sticky_kind) <= 40),
  sticky_key_hash text CHECK (sticky_key_hash IS NULL OR sticky_key_hash ~ '^[a-f0-9]{16}$')
);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_requested_idx ON space_gateway_request_logs(requested_at DESC);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_account_idx ON space_gateway_request_logs(account_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_key_idx ON space_gateway_request_logs(api_key_id, requested_at DESC);

-- Daily rollups survive request-log retention. Empty strings stand for "no account" / "no key".
CREATE TABLE IF NOT EXISTS space_gateway_usage_daily (
  day date NOT NULL,
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  account_id text NOT NULL DEFAULT '',
  api_key_id text NOT NULL DEFAULT '',
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  requests bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  reasoning_reported bigint NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  compression_tokens_saved bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, account_id, api_key_id, model)
);
