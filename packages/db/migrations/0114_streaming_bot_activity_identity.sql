ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS author_id text;
ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE streaming_bot_activity ADD COLUMN IF NOT EXISTS protected_account boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_streaming_bot_activity_identity
  ON streaming_bot_activity (platform, account_id, channel_id, author_id, created_at DESC);
