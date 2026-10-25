ALTER TABLE space_owner_setup
  ADD COLUMN IF NOT EXISTS onboarding_version integer NOT NULL DEFAULT 1
    CHECK (onboarding_version > 0),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS starter_room_id text REFERENCES rooms(id) ON DELETE SET NULL;

INSERT INTO space_owner_setup (
  singleton,
  setup_token_hash,
  setup_token_expires_at,
  owner_user_id,
  claimed_at,
  onboarding_version,
  onboarding_completed_at,
  created_at,
  updated_at
)
SELECT
  true,
  NULL,
  NULL,
  id,
  now(),
  1,
  now(),
  now(),
  now()
FROM users
WHERE role = 'ADMIN'
ORDER BY CASE WHEN id = 'user:operator' THEN 0 ELSE 1 END, id
LIMIT 1
ON CONFLICT (singleton) DO NOTHING;

UPDATE space_owner_setup
SET onboarding_completed_at = COALESCE(onboarding_completed_at, claimed_at, now())
WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS space_setup_connection_verifications (
  connection_id text PRIMARY KEY CHECK (connection_id ~ '^[a-z0-9][a-z0-9:_-]{0,159}$'),
  state text NOT NULL CHECK (state IN ('CONNECTED', 'NEEDS_SETUP', 'UNAVAILABLE')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$'),
  fingerprint_hash text CHECK (fingerprint_hash IS NULL OR fingerprint_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
