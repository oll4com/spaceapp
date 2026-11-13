-- Space Link (ADR-014, plan clipboard:lYFQqqbYp4xr): the SpaceApps this one's Nous manages, each paired as a spaceapp-link device of
-- that SpaceApp. Its keys as the pairing code gave them, the device id it answered, and this side's Noise private key sealed with the
-- connector key. Class A: a row goes only when its person removes the link.
CREATE TABLE IF NOT EXISTS instance_links (
  id text PRIMARY KEY CHECK (id ~ '^link:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  origins jsonb NOT NULL,
  noise_public text NOT NULL,
  identity_public text NOT NULL,
  device_id text NOT NULL,
  sealed_device_private text NOT NULL,
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS instance_links_owner_idx ON instance_links (owner_user_id, created_at);
