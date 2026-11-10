-- Mobile channel (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013, design §4.1). The installation's Noise static and identity keys, sealed
-- with the connector key (purpose mobile-instance-key, AAD = id). Class A: only an explicit rotate or delete changes a row, because losing
-- the keys makes every paired device pair again. A routine rotation keeps the old pair RETIRING for 30 days; a compromise retires it at once.
CREATE TABLE IF NOT EXISTS mobile_instance_keys (
  id text PRIMARY KEY CHECK (id ~ '^mobkey:[A-Za-z0-9_-]{6,80}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRING', 'RETIRED')),
  noise_public text NOT NULL CHECK (noise_public ~ '^[A-Za-z0-9_-]{43}$'),
  identity_public text NOT NULL CHECK (identity_public ~ '^[A-Za-z0-9_-]{43}$'),
  sealed_private text NOT NULL CHECK (char_length(sealed_private) BETWEEN 40 AND 4000),
  rotation_statement text CHECK (rotation_statement IS NULL OR char_length(rotation_statement) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  retiring_until timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_instance_keys_one_active ON mobile_instance_keys ((status)) WHERE status = 'ACTIVE';

-- Paired devices are device sessions too: one Devices list, one revoke (which also revokes their session id). Sign-in rows keep these
-- null. A new device holds read only until the owner allows it in the web (security review P1-5): confirmed_at, then scopes = requested.
-- The relay's transport, rendezvous id and push handle come with phase 2b.
ALTER TABLE app_device_sessions
  ADD COLUMN IF NOT EXISTS noise_public text UNIQUE CHECK (noise_public IS NULL OR noise_public ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN IF NOT EXISTS decide_public_spki text CHECK (decide_public_spki IS NULL OR decide_public_spki ~ '^[A-Za-z0-9_-]{80,200}$'),
  ADD COLUMN IF NOT EXISTS decide_security_level text CHECK (decide_security_level IS NULL OR decide_security_level IN ('TRUSTED_ENVIRONMENT', 'STRONGBOX')),
  ADD COLUMN IF NOT EXISTS scopes text[] CHECK (scopes IS NULL OR scopes <@ ARRAY['read', 'act', 'decide']::text[]),
  ADD COLUMN IF NOT EXISTS requested_scopes text[] CHECK (requested_scopes IS NULL OR requested_scopes <@ ARRAY['read', 'act', 'decide']::text[]),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE INDEX IF NOT EXISTS app_device_sessions_paired_idx ON app_device_sessions (owner_user_id, created_at) WHERE noise_public IS NOT NULL;
