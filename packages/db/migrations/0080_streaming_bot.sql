CREATE TABLE IF NOT EXISTS streaming_bot_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  persona jsonb NOT NULL,
  platforms jsonb NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  faq jsonb NOT NULL DEFAULT '[]'::jsonb,
  instructions text NOT NULL DEFAULT '',
  guardrails jsonb NOT NULL,
  memory_enabled boolean NOT NULL DEFAULT true,
  overlay_ticker_enabled boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO streaming_bot_settings (singleton, version, enabled, persona, platforms, facts, faq, instructions, guardrails, memory_enabled, overlay_ticker_enabled)
VALUES (
  true,
  1,
  false,
  '{"name":"Live Assistant","tone":"Friendly, concise and helpful. Answer only questions about the stream."}'::jsonb,
  '{"YOUTUBE":{"enabled":false,"accountId":null},"TWITCH":{"enabled":false,"accountId":null}}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '',
  '{"cooldownSeconds":15,"maxRepliesPerMinute":5,"replyToQuestionsOnly":true}'::jsonb,
  true,
  false
)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS streaming_chat_state (
  platform text NOT NULL CHECK (platform IN ('YOUTUBE', 'TWITCH')),
  account_id text NOT NULL REFERENCES streaming_platform_accounts(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  cursor text,
  last_polled_at timestamptz,
  last_reply_at timestamptz,
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  PRIMARY KEY (platform, account_id, chat_id),
  CHECK (cursor IS NULL OR char_length(cursor) <= 500),
  CHECK (chat_id IS NULL OR char_length(chat_id) <= 300)
);

CREATE INDEX IF NOT EXISTS idx_streaming_chat_state_last_polled
  ON streaming_chat_state (last_polled_at DESC);

CREATE TABLE IF NOT EXISTS streaming_bot_activity (
  id text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('YOUTUBE', 'TWITCH')),
  direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  author text,
  message text NOT NULL,
  reply text,
  status text NOT NULL CHECK (status IN ('REPLIED', 'SKIPPED', 'ERROR', 'TEST')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (author IS NULL OR char_length(author) <= 300),
  CHECK (char_length(message) <= 2000),
  CHECK (reply IS NULL OR char_length(reply) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_streaming_bot_activity_created
  ON streaming_bot_activity (created_at DESC);

CREATE TABLE IF NOT EXISTS streaming_bot_quota (
  provider text NOT NULL CHECK (provider IN ('YOUTUBE')),
  day date NOT NULL,
  units_consumed integer NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  PRIMARY KEY (provider, day)
);