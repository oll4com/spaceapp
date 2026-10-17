-- Multi-user accounts (plan clipboard:VrMJ14wJPmVs step 2), used only with SPACE_MULTI_USER_ENABLED=true.
-- A disabled user cannot sign in, and the API rejects the sessions it still holds.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- One-time invites: only a SHA-256 of the token is stored; an invite is used once, expires and can be revoked.
CREATE TABLE IF NOT EXISTS user_invites (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('USER', 'OPERATOR')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id TEXT,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_invites_created_at ON user_invites(created_at DESC);
