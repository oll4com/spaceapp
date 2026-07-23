CREATE TABLE IF NOT EXISTS provider_validation_checks (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  status text NOT NULL,
  code text NOT NULL,
  status_reason text NOT NULL,
  masked_key_prefix text,
  credential_label text,
  model_count integer CHECK (model_count IS NULL OR model_count >= 0),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_validation_checks_latest
  ON provider_validation_checks(provider_id, checked_at DESC, created_at DESC);
