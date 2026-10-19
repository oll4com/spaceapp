-- Nous Away mode (operator request 2026-10-17, plan clipboard:B7eTUHTJYg3X): while the operator is away Nous keeps working
-- by a set procedure. One open away session per owner (the operator's mandate, the categories their grant covers, the chat
-- message that started it) and its log: what Nous did meanwhile, read back as the return briefing.
CREATE TABLE IF NOT EXISTS nous_away_sessions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  until_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('RETURN', 'UNTIL', 'SWITCH', 'NOUS')),
  reason text NOT NULL,
  mandate text NOT NULL,
  grant_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  operator_message_id text,
  operator_quote text
);
CREATE UNIQUE INDEX IF NOT EXISTS nous_away_sessions_open ON nous_away_sessions (owner_user_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS nous_away_log (
  id bigserial PRIMARY KEY,
  away_id text NOT NULL REFERENCES nous_away_sessions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  source text NOT NULL,
  what text NOT NULL,
  result text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS nous_away_log_session ON nous_away_log (away_id, id);
