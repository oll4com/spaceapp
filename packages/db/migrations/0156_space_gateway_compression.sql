-- Space Gateway compression statistics (the Headroom rewrite), per hour, mode, provider and strategy.
-- Strategy '' rows count evaluated requests; other rows count compressed blocks. SHADOW rows are what
-- compression would have saved without changing the request; ON rows were applied.
CREATE TABLE IF NOT EXISTS space_gateway_compression_rollups (
  hour timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SHADOW','ON')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  strategy text NOT NULL CHECK (char_length(strategy) <= 40),
  requests bigint NOT NULL DEFAULT 0,
  modified_requests bigint NOT NULL DEFAULT 0,
  blocks bigint NOT NULL DEFAULT 0,
  rejected_blocks bigint NOT NULL DEFAULT 0,
  error_blocks bigint NOT NULL DEFAULT 0,
  timed_out bigint NOT NULL DEFAULT 0,
  original_tokens bigint NOT NULL DEFAULT 0,
  compressed_tokens bigint NOT NULL DEFAULT 0,
  overhead_ms double precision NOT NULL DEFAULT 0,
  max_overhead_ms double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, mode, provider, strategy)
);
CREATE INDEX IF NOT EXISTS space_gateway_compression_rollups_hour_idx ON space_gateway_compression_rollups(hour);
