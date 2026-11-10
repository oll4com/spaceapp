-- Plan clipboard:f4SH36t3fJ6c (operator 31/10 13:58 BKK): the Nous Load tab. One row per owner and minute with the share of the server and
-- token capacity in use (class B: pruned after 30 days), and the hour and day sums those minutes add to, which the averages come from
-- (class A: durable). HOUR buckets are UTC hours ('2026-10-31T07'), DAY buckets the owner's local date ('2026-10-31').
CREATE TABLE nous_load_samples (
  owner_user_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, overall REAL NOT NULL CHECK (overall >= 0 AND overall <= 100), parts JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (owner_user_id, at)
);
CREATE TABLE nous_load_rollups (
  owner_user_id TEXT NOT NULL, period TEXT NOT NULL CHECK (period IN ('HOUR', 'DAY')), bucket TEXT NOT NULL CHECK (char_length(bucket) <= 13),
  total DOUBLE PRECISION NOT NULL, samples INTEGER NOT NULL CHECK (samples > 0), peak REAL NOT NULL,
  PRIMARY KEY (owner_user_id, period, bucket)
);
