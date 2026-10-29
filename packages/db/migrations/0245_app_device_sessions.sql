-- Device sessions of Space's own mobile apps (plan clipboard:VLBu2ge110ho step 4, Nous decision 2026-10-23): one row per app sign-in,
-- listed in Settings > Account > Devices with Revoke. Only the SHA-256 of the session id is kept, never the token; revoking also
-- puts that hash into the session revocations. Expired or revoked rows go 30 days after their end (class B, like sessions).
CREATE TABLE IF NOT EXISTS app_device_sessions (
  id text PRIMARY KEY CHECK (id ~ '^appdev:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app text NOT NULL CHECK (app ~ '^[a-z][a-z0-9-]{1,40}$'),
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 80),
  sid_sha256 text NOT NULL UNIQUE CHECK (sid_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS app_device_sessions_owner_idx ON app_device_sessions (owner_user_id, app, created_at);
