CREATE TABLE IF NOT EXISTS system_analytics_model_events (
  event_key text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('codex', 'opencode', 'session')),
  runtime_id text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  room_id text,
  pane_id text,
  session_id text,
  turn_id text,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'ABORTED', 'SESSION')),
  coverage text NOT NULL CHECK (coverage IN ('NATIVE', 'SESSION_ONLY', 'UNAVAILABLE')),
  turn_count integer NOT NULL DEFAULT 1 CHECK (turn_count >= 0),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  tokens_in bigint,
  tokens_out bigint,
  tokens_reasoning bigint,
  ttft_ms double precision,
  duration_ms double precision,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (tokens_in IS NULL OR tokens_in >= 0),
  CHECK (tokens_out IS NULL OR tokens_out >= 0),
  CHECK (tokens_reasoning IS NULL OR tokens_reasoning >= 0)
);

CREATE INDEX IF NOT EXISTS idx_system_analytics_model_events_range
  ON system_analytics_model_events (started_at DESC, provider_id, model_id);

CREATE INDEX IF NOT EXISTS idx_system_analytics_model_events_session
  ON system_analytics_model_events (session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS system_analytics_resource_buckets (
  resolution_seconds integer NOT NULL CHECK (resolution_seconds IN (10, 60, 900)),
  bucket_at timestamptz NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('HOST', 'CLI_SESSION', 'SHARED_RUNTIME')),
  entity_id text NOT NULL,
  room_id text,
  room_name text,
  pane_id text,
  pane_title text,
  session_id text,
  runtime_id text,
  runtime_name text,
  provider_id text,
  model_id text,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  process_count integer NOT NULL DEFAULT 0 CHECK (process_count >= 0),
  cpu_min double precision NOT NULL CHECK (cpu_min >= 0),
  cpu_sum double precision NOT NULL CHECK (cpu_sum >= 0),
  cpu_max double precision NOT NULL CHECK (cpu_max >= 0),
  rss_min bigint NOT NULL CHECK (rss_min >= 0),
  rss_sum numeric(30, 0) NOT NULL CHECK (rss_sum >= 0),
  rss_max bigint NOT NULL CHECK (rss_max >= 0),
  memory_total_bytes bigint,
  memory_available_bytes bigint,
  swap_total_bytes bigint,
  swap_used_bytes bigint,
  page_cache_bytes bigint,
  pressure boolean,
  PRIMARY KEY (resolution_seconds, bucket_at, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_system_analytics_resource_buckets_range
  ON system_analytics_resource_buckets (resolution_seconds, bucket_at DESC, entity_type);

CREATE INDEX IF NOT EXISTS idx_system_analytics_resource_buckets_session
  ON system_analytics_resource_buckets (session_id, resolution_seconds, bucket_at DESC)
  WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system_analytics_ingest_cursors (
  source_key text PRIMARY KEY,
  cursor_value text,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED')),
  earliest_at timestamptz,
  latest_at timestamptz,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_analytics_ingest_cursors (source_key, status)
VALUES ('backfill', 'PENDING')
ON CONFLICT (source_key) DO NOTHING;
