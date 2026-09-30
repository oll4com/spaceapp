CREATE TABLE IF NOT EXISTS streaming_bot_message_receipts (
  platform text NOT NULL CHECK (platform IN ('YOUTUBE', 'TWITCH', 'DISCORD')),
  account_id text NOT NULL,
  message_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_streaming_bot_message_receipts_claimed_at
  ON streaming_bot_message_receipts (claimed_at);
