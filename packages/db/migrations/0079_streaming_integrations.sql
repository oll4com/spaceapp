CREATE TABLE IF NOT EXISTS streaming_oauth_authorizations (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK')),
  external_grant_id text NOT NULL,
  credential_ref text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKE_PENDING', 'REVOKED', 'ERROR')),
  scopes text[] NOT NULL DEFAULT '{}',
  safe_error_code text,
  safe_error_message text,
  last_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_grant_id),
  CHECK (char_length(credential_ref) BETWEEN 1 AND 500),
  CHECK (safe_error_code IS NULL OR char_length(safe_error_code) <= 100),
  CHECK (safe_error_message IS NULL OR char_length(safe_error_message) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_streaming_oauth_authorizations_provider_status
  ON streaming_oauth_authorizations (provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS streaming_platform_accounts (
  id text PRIMARY KEY,
  authorization_id text NOT NULL REFERENCES streaming_oauth_authorizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK')),
  external_account_id text NOT NULL,
  display_name text NOT NULL,
  badge text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ERROR', 'DISCONNECTED')),
  analytics_period smallint NOT NULL DEFAULT 28 CHECK (analytics_period IN (7, 28, 90)),
  verified_at timestamptz,
  safe_error_code text,
  safe_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_id),
  CHECK (char_length(display_name) BETWEEN 1 AND 300),
  CHECK (char_length(badge) BETWEEN 1 AND 160),
  CHECK (safe_error_code IS NULL OR char_length(safe_error_code) <= 100),
  CHECK (safe_error_message IS NULL OR char_length(safe_error_message) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_streaming_platform_accounts_authorization
  ON streaming_platform_accounts (authorization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS streaming_oauth_attempts (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK')),
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  verifier_credential_ref text NOT NULL UNIQUE,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(state_hash) = 64),
  CHECK (char_length(session_hash) = 64),
  CHECK (expires_at <= created_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_streaming_oauth_attempts_expiry
  ON streaming_oauth_attempts (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS streaming_overlay_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version > 0),
  tiles jsonb NOT NULL CHECK (jsonb_typeof(tiles) = 'array' AND jsonb_array_length(tiles) <= 12),
  custom_text_enabled boolean NOT NULL DEFAULT false,
  custom_text text NOT NULL DEFAULT '' CHECK (char_length(custom_text) <= 160),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO streaming_overlay_settings (singleton, version, tiles, custom_text_enabled, custom_text)
VALUES (
  true,
  1,
  '[{"metricKey":"space.rooms","accountId":null},{"metricKey":"space.active_agents","accountId":null},{"metricKey":"space.active_cli_sessions","accountId":null}]'::jsonb,
  false,
  ''
)
ON CONFLICT (singleton) DO NOTHING;
