ALTER TABLE streaming_bot_settings ADD COLUMN IF NOT EXISTS moderation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE streaming_bot_settings ADD COLUMN IF NOT EXISTS jev_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS streaming_moderation_actions (
  id text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('YOUTUBE', 'TWITCH', 'DISCORD')),
  account_id text NOT NULL,
  channel_id text NOT NULL,
  user_id text NOT NULL,
  message_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ALLOW','REVIEW','WARN','TIMEOUT_5M','TIMEOUT_30M')),
  reason text NOT NULL,
  duration_seconds integer,
  result text NOT NULL CHECK (result IN ('PENDING','SUCCEEDED','FAILED','UNAVAILABLE','REVIEW','UNDONE')),
  platform_action_id text,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_streaming_moderation_actions_user_time
  ON streaming_moderation_actions (platform, account_id, channel_id, user_id, created_at DESC);
