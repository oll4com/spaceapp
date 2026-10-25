-- Space Dots Stage 8: when each user's proactive check runs next, what it has already read
-- (a cursor per connected account) and how many notices it sent today. Additive.
CREATE TABLE IF NOT EXISTS dot_proactive_state (
  owner_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_check_at timestamptz,
  cursors jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cursors) = 'object'),
  notices_day date,
  notices_today integer NOT NULL DEFAULT 0 CHECK (notices_today >= 0),
  last_checked_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dot_proactive_state_due ON dot_proactive_state(next_check_at);
