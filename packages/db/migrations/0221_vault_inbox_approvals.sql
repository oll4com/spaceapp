-- Vault inbox and approvals (plan clipboard:vEYtT6-bEN0J steps 3-4). The inbox key lets a fill seal a generated password
-- while the Vault is locked: its public half is here, its private half only under the VRK. Pending rows hold those sealed
-- passwords until the operator's dock turns them into PENDING items. Approvals are Assist requests the operator decides.
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS inbox_public_key text;
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS inbox_private_envelope jsonb;

CREATE TABLE IF NOT EXISTS vault_pending (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('NEW_ACCOUNT', 'CHANGE_PASSWORD')),
  handle text NOT NULL,
  label text NOT NULL,
  origin text NOT NULL,
  sealed_username jsonb,
  sealed_password jsonb NOT NULL,
  pane_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vault_pending_owner_idx ON vault_pending (owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS vault_approvals (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  fields text[] NOT NULL,
  pane_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'USED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS vault_approvals_owner_idx ON vault_approvals (owner_user_id, status, created_at DESC);
