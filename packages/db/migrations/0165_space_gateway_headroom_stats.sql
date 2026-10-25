-- Space Gateway statistics for the Headroom views (session, lifetime, historical): waste signals and pipeline stage
-- timings per hour, prompt-cache busts and compression detail per request, and daily savings by provider, model,
-- client and project that outlive request-log retention. Additive only.
ALTER TABLE space_gateway_request_logs
  ADD COLUMN IF NOT EXISTS cache_bust boolean,
  ADD COLUMN IF NOT EXISTS compression_detail jsonb CHECK (compression_detail IS NULL OR pg_column_size(compression_detail) <= 4096);

-- kind 'waste': value = tokens of a waste signal; kind 'stage': value = milliseconds of a pipeline stage, count = runs.
CREATE TABLE IF NOT EXISTS space_gateway_compression_signals (
  hour timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SHADOW','ON')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('waste','stage')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  count bigint NOT NULL DEFAULT 0,
  value double precision NOT NULL DEFAULT 0,
  max_value double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, mode, provider, kind, name)
);
CREATE INDEX IF NOT EXISTS space_gateway_compression_signals_hour_idx ON space_gateway_compression_signals(hour);

-- Daily totals for Headroom's lifetime and historical views. Empty strings stand for "unknown client/project".
CREATE TABLE IF NOT EXISTS space_gateway_savings_daily (
  day date NOT NULL,
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  client text NOT NULL DEFAULT '' CHECK (char_length(client) <= 80),
  project text NOT NULL DEFAULT '' CHECK (char_length(project) <= 200),
  requests bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  rate_limited bigint NOT NULL DEFAULT 0,
  cached_requests bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_creation_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  compression_before bigint NOT NULL DEFAULT 0,
  compression_after bigint NOT NULL DEFAULT 0,
  compression_saved bigint NOT NULL DEFAULT 0,
  shadow_saved bigint NOT NULL DEFAULT 0,
  cache_busts bigint NOT NULL DEFAULT 0,
  cache_bust_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model, client, project)
);
CREATE INDEX IF NOT EXISTS space_gateway_savings_daily_day_idx ON space_gateway_savings_daily(day);

-- Days before this table existed come from the daily usage totals (no client, project or cache detail).
INSERT INTO space_gateway_savings_daily(day, provider, model, client, project, requests, failed, input_tokens, cached_input_tokens, output_tokens,
    cost_usd, compression_saved)
  SELECT day, provider, model, '', '', sum(requests), sum(errors), sum(input_tokens), sum(cached_input_tokens), sum(output_tokens), sum(cost_usd),
    sum(compression_tokens_saved)
  FROM space_gateway_usage_daily GROUP BY day, provider, model
  ON CONFLICT (day, provider, model, client, project) DO NOTHING;
