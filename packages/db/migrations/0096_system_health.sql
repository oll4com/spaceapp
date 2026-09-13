CREATE TABLE IF NOT EXISTS system_health_metric_buckets (
  metric_id text NOT NULL,
  label text NOT NULL,
  unit text NOT NULL,
  resolution_seconds integer NOT NULL CHECK (resolution_seconds IN (10, 60, 900)),
  bucket_at timestamptz NOT NULL,
  sample_count integer NOT NULL,
  value_min double precision NOT NULL,
  value_sum double precision NOT NULL,
  value_max double precision NOT NULL,
  PRIMARY KEY (resolution_seconds, bucket_at, metric_id)
);
