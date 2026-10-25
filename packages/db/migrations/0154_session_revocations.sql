-- SEC-011: session revocations survive API restarts. Only a SHA-256 of the token signature is
-- stored, never a token; rows expire with the revoked token.
CREATE TABLE IF NOT EXISTS session_revocations (
  signature_sha256 TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_revocations_expires_at ON session_revocations(expires_at);

-- "Log out everywhere": sessions issued before revoked_before are rejected for this user.
CREATE TABLE IF NOT EXISTS user_session_epochs (
  user_id TEXT PRIMARY KEY,
  revoked_before TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
