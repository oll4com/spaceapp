-- Additive SSO registry. Only verified legacy google_id links are migrated;
-- Gemini CLI profiles and email matches do not confer login rights.
-- Serialize legacy link/unlink writes with backfill and guard installation.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS google_accounts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_sub text NOT NULL UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  email text NOT NULL,
  display_name text,
  avatar_url text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_google_accounts_owner ON google_accounts(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_accounts_primary ON google_accounts(owner_user_id) WHERE is_primary;

INSERT INTO google_accounts(id, owner_user_id, google_sub, email, avatar_url, is_primary, created_at, updated_at)
SELECT 'google_account:' || gen_random_uuid()::text, id, google_id, email, avatar_url, true, created_at, updated_at
FROM users WHERE google_id IS NOT NULL
ON CONFLICT (google_sub) DO NOTHING;

-- Old binaries can still read/login with the primary identity and upsert users.
-- Block legacy link/unlink writes on rollback: silently accepting them would
-- leave stale SSO authorization in the retained registry on the next rollout.
CREATE OR REPLACE FUNCTION enforce_google_primary_registry() RETURNS trigger AS $$
BEGIN
  IF NEW.google_id IS DISTINCT FROM (
    SELECT google_sub FROM google_accounts WHERE owner_user_id=NEW.id AND is_primary
  ) THEN
    RAISE EXCEPTION 'Google account changes require the Google account registry API' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_google_primary_registry ON users;
CREATE TRIGGER users_google_primary_registry BEFORE UPDATE OF google_id ON users
FOR EACH ROW WHEN (OLD.google_id IS DISTINCT FROM NEW.google_id)
EXECUTE FUNCTION enforce_google_primary_registry();
