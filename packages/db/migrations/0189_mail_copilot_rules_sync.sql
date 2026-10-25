-- Mail Copilot rules (what the agent may do alone once the operator approved) and per-account Gmail sync state.
CREATE TABLE IF NOT EXISTS mail_copilot_rules (
  id text PRIMARY KEY CHECK (id ~ '^mailrule:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_email text CHECK (account_email IS NULL OR char_length(account_email) BETWEEN 3 AND 320),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  condition jsonb NOT NULL CHECK (jsonb_typeof(condition) = 'object'),
  action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','RETIRED')),
  confidence real NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  proposed_by text NOT NULL CHECK (proposed_by IN ('AGENT','USER')),
  decided_at timestamptz,
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  last_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_copilot_rules_owner_idx ON mail_copilot_rules(owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_copilot_sync (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_email text NOT NULL CHECK (char_length(account_email) BETWEEN 3 AND 320),
  history_id text CHECK (history_id IS NULL OR char_length(history_id) BETWEEN 1 AND 40),
  last_synced_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, account_email)
);
