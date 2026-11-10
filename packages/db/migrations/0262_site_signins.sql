-- Class A: the sign-in recipe survives age, success/failure and browser/pane deletion.
-- Class B: bounded metadata-only change history inside record (newest 100, at most 180 days).
CREATE TABLE IF NOT EXISTS site_sign_ins (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site text NOT NULL,
  account_label text NOT NULL DEFAULT 'main',
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, site, account_label)
);
