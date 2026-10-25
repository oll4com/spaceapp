CREATE TABLE IF NOT EXISTS audit_chain_entries (
  seq bigint PRIMARY KEY,
  action text NOT NULL,
  actor text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  chain_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_created
  ON audit_chain_entries (created_at DESC, seq DESC);

CREATE INDEX IF NOT EXISTS idx_audit_chain_action
  ON audit_chain_entries (action, created_at DESC);
