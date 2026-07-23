CREATE TABLE IF NOT EXISTS space_owner_setup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  setup_token_hash text CHECK (setup_token_hash IS NULL OR setup_token_hash ~ '^[a-f0-9]{64}$'),
  setup_token_expires_at timestamptz,
  owner_user_id text UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (owner_user_id IS NULL AND setup_token_hash IS NOT NULL AND setup_token_expires_at IS NOT NULL AND claimed_at IS NULL)
    OR
    (owner_user_id IS NOT NULL AND setup_token_hash IS NULL AND setup_token_expires_at IS NULL AND claimed_at IS NOT NULL)
  )
);
