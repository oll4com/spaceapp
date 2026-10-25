CREATE TABLE IF NOT EXISTS memory_embedding_smoke_checks (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISABLED', 'ERROR', 'VERIFIED')),
  code text NOT NULL CHECK (code IN (
    'EMBEDDING_SMOKE_DISABLED',
    'RUNTIME_STORE_NOT_POSTGRES',
    'PGVECTOR_UNAVAILABLE',
    'EMBEDDING_PROVIDER_MISSING',
    'EMBEDDING_PROVIDER_UNVERIFIED',
    'EMBEDDING_SMOKE_OK'
  )),
  message text NOT NULL,
  smoke_enabled boolean NOT NULL,
  provider text,
  model text,
  dimensions integer NOT NULL CHECK (dimensions > 0 AND dimensions <= 4096),
  pgvector_ready boolean NOT NULL,
  embedding_provider_ready boolean NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_smoke_checks_latest
  ON memory_embedding_smoke_checks(checked_at DESC, created_at DESC);
