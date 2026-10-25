-- Space Gateway parity with codex-lb and Headroom: account aliases, display preferences, prompt-cache TTL,
-- import policy, limit warm-up, LAN settings, and request-log columns for cache writes, clients, projects and
-- compression before/after. Additive only; older gateway workers keep writing the columns they know.
ALTER TABLE space_gateway_accounts
  ADD COLUMN IF NOT EXISTS alias text CHECK (alias IS NULL OR char_length(alias) BETWEEN 1 AND 80);

ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS display_time_format text NOT NULL DEFAULT '24H' CHECK (display_time_format IN ('12H','24H')),
  ADD COLUMN IF NOT EXISTS display_account_windows text NOT NULL DEFAULT 'BOTH' CHECK (display_account_windows IN ('PRIMARY','SECONDARY','BOTH')),
  ADD COLUMN IF NOT EXISTS display_burn_projection boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS upstream_stream_transport text NOT NULL DEFAULT 'DEFAULT' CHECK (upstream_stream_transport IN ('DEFAULT','HTTP','WEBSOCKET')),
  ADD COLUMN IF NOT EXISTS prompt_cache_ttl_seconds integer NOT NULL DEFAULT 1800 CHECK (prompt_cache_ttl_seconds BETWEEN 60 AND 604800),
  ADD COLUMN IF NOT EXISTS import_without_overwrite boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS warmup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warmup_windows text NOT NULL DEFAULT 'BOTH' CHECK (warmup_windows IN ('PRIMARY','SECONDARY','BOTH')),
  ADD COLUMN IF NOT EXISTS warmup_model text NOT NULL DEFAULT 'auto' CHECK (char_length(warmup_model) BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS warmup_prompt text NOT NULL DEFAULT 'Say OK.' CHECK (char_length(warmup_prompt) BETWEEN 1 AND 512),
  ADD COLUMN IF NOT EXISTS warmup_cooldown_seconds integer NOT NULL DEFAULT 3600 CHECK (warmup_cooldown_seconds BETWEEN 60 AND 604800),
  ADD COLUMN IF NOT EXISTS warmup_min_available_percent double precision NOT NULL DEFAULT 100 CHECK (warmup_min_available_percent > 0 AND warmup_min_available_percent <= 100),
  ADD COLUMN IF NOT EXISTS lan_mode text NOT NULL DEFAULT 'ENV' CHECK (lan_mode IN ('ENV','OFF','ON')),
  ADD COLUMN IF NOT EXISTS lan_host text CHECK (lan_host IS NULL OR char_length(lan_host) BETWEEN 7 AND 45),
  ADD COLUMN IF NOT EXISTS lan_port integer CHECK (lan_port IS NULL OR lan_port BETWEEN 1024 AND 65535),
  ADD COLUMN IF NOT EXISTS lan_allowed_sources text[] NOT NULL DEFAULT '{}' CHECK (cardinality(lan_allowed_sources) <= 20);

-- One limit warm-up attempt per account, window and reset (codex-lb account_limit_warmups).
CREATE TABLE IF NOT EXISTS space_gateway_warmups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES space_gateway_accounts(account_id) ON DELETE CASCADE,
  usage_window text NOT NULL CHECK (usage_window IN ('PRIMARY','SECONDARY')),
  reset_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED','SKIPPED')),
  model text CHECK (model IS NULL OR char_length(model) <= 160),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 120),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  UNIQUE (account_id, usage_window, reset_at)
);
CREATE INDEX IF NOT EXISTS space_gateway_warmups_account_idx ON space_gateway_warmups(account_id, attempted_at DESC);

-- source 'limit_warmup' marks warm-up requests; statistics leave them out.
ALTER TABLE space_gateway_request_logs
  ADD COLUMN IF NOT EXISTS source text CHECK (source IS NULL OR char_length(source) <= 40),
  ADD COLUMN IF NOT EXISTS cache_creation_tokens bigint CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  ADD COLUMN IF NOT EXISTS client_name text CHECK (client_name IS NULL OR char_length(client_name) <= 80),
  ADD COLUMN IF NOT EXISTS project text CHECK (project IS NULL OR char_length(project) <= 200),
  ADD COLUMN IF NOT EXISTS compression_tokens_before bigint CHECK (compression_tokens_before IS NULL OR compression_tokens_before >= 0),
  ADD COLUMN IF NOT EXISTS compression_tokens_after bigint CHECK (compression_tokens_after IS NULL OR compression_tokens_after >= 0);

-- Range queries of the dashboard, the request log filters and the per-key views.
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_model_idx ON space_gateway_request_logs(model, requested_at DESC);
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_errors_idx ON space_gateway_request_logs(requested_at DESC) WHERE status <> 'success';
CREATE INDEX IF NOT EXISTS space_gateway_usage_daily_account_idx ON space_gateway_usage_daily(account_id, day);
CREATE INDEX IF NOT EXISTS space_gateway_usage_daily_key_idx ON space_gateway_usage_daily(api_key_id, day);
