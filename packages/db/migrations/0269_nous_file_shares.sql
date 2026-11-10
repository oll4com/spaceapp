-- Plan clipboard:RQSrp1EczBbV (operator 31/10 00:25 BKK): an Agent File Nous shares to the Nous app for a short time, for approvals
-- the operator makes there. Class B: a share past expires_at goes; removing a share never touches the Agent File.
CREATE TABLE nous_file_shares (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, artifact_id TEXT NOT NULL, note TEXT CHECK (char_length(note) <= 500),
  shared_by TEXT NOT NULL, shared_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > shared_at),
  UNIQUE (owner_user_id, artifact_id)
);
