-- Vault sign-up grants (plan clipboard:vEYtT6-bEN0J, NEW_ACCOUNT option B, operator decision 2026-10-18): the exact sites
-- where agents may create new accounts, signed by the operator's unlock key and certified by the broker. The broker
-- counts the uses per day itself; this table only lists, revokes and hands the certificate to the fill path.
CREATE TABLE IF NOT EXISTS vault_signup_grants (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sites text[] NOT NULL,
  daily_cap integer NOT NULL CHECK (daily_cap BETWEEN 1 AND 10),
  certificate jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS vault_signup_grants_owner_idx ON vault_signup_grants (owner_user_id, revoked_at, expires_at);
