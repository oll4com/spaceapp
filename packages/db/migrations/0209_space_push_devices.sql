-- Android devices that receive Space notifications as FCM pushes, also with the app closed. One row per FCM
-- token (a token moves to the user who registered it last); a token FCM reports as unregistered is disabled.
CREATE TABLE IF NOT EXISTS space_push_devices (
  token text PRIMARY KEY CHECK (char_length(token) BETWEEN 20 AND 4096),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'ANDROID' CHECK (platform IN ('ANDROID')),
  app_version text CHECK (app_version IS NULL OR char_length(app_version) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE INDEX IF NOT EXISTS space_push_devices_user_active_idx ON space_push_devices (user_id) WHERE disabled_at IS NULL;
