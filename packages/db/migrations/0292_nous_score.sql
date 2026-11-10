-- Plan clipboard:1NF6u6gcCwtj (operator 3/11 23:11 BKK): the Nous Score view. One row per owner every 10 minutes with the score and each
-- tile's points (class B: pruned after 30 days).
CREATE TABLE nous_score_snapshots (
  owner_user_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, score DOUBLE PRECISION NOT NULL, parts JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (owner_user_id, at)
);
