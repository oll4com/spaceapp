-- Space Dots Stage 8: the user's Dot settings (SpaceApp Settings → Dots), notices a Dot
-- sends on its own, and the feed's read marker. Additive; no existing row changes.
CREATE TABLE IF NOT EXISTS dot_user_settings (
  owner_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_dot_id text REFERENCES space_dots(dot_id) ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dot_feed_entries (
  entry_id text PRIMARY KEY,
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'NOTICE'),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  link jsonb CHECK (link IS NULL OR jsonb_typeof(link) = 'object'),
  -- The source item (email, event) a notice is about; one notice per item and Dot.
  source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set once the notice was given to the model in a turn, so the Dot knows what it told the user.
  delivered_to_model_at timestamptz,
  UNIQUE (dot_id, source_hash)
);
CREATE INDEX IF NOT EXISTS dot_feed_entries_dot ON dot_feed_entries(dot_id, created_at DESC, entry_id DESC);
CREATE INDEX IF NOT EXISTS dot_feed_entries_undelivered ON dot_feed_entries(dot_id, created_at) WHERE delivered_to_model_at IS NULL;

CREATE TABLE IF NOT EXISTS dot_feed_state (
  dot_id text PRIMARY KEY REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The feed finds each message's run by its prompt or response message.
CREATE INDEX IF NOT EXISTS space_runs_prompt_message ON space_agent_runs(prompt_message_id);
CREATE INDEX IF NOT EXISTS space_runs_response_message ON space_agent_runs(response_message_id);
