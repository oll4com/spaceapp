-- Space Dots Stage 5: email and calendar accounts a user connects to Space (Google, Microsoft).
-- Tokens are stored encrypted by the API; disconnecting deletes the row after revoking access.
CREATE TABLE IF NOT EXISTS connector_accounts (
  account_id text PRIMARY KEY CHECK (account_id ~ '^connector:[a-f0-9]{32}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('GOOGLE','MICROSOFT')),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  scopes text[] NOT NULL DEFAULT '{}',
  refresh_token_encrypted text NOT NULL CHECK (char_length(refresh_token_encrypted) BETWEEN 20 AND 8000),
  access_token_encrypted text CHECK (access_token_encrypted IS NULL OR char_length(access_token_encrypted) <= 16000),
  access_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, provider, email)
);
CREATE INDEX IF NOT EXISTS connector_accounts_owner_idx ON connector_accounts(owner_user_id, provider);

ALTER TABLE dot_tool_invocations DROP CONSTRAINT IF EXISTS dot_tool_invocations_source_check;
ALTER TABLE dot_tool_invocations ADD CONSTRAINT dot_tool_invocations_source_check
  CHECK (source IN ('SPACE_CONTROL','SPACE_RESOURCE','SPACE_NATIVE','SPACE_GOAL','SPACE_SCHEDULE','SPACE_COMPUTER','SPACE_MEMORY','CONNECTOR','BROWSER','MCP','INSTALLED_MCP'));
