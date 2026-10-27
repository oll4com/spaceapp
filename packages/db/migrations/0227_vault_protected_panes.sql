-- Vault protected browser panes (plan clipboard:vEYtT6-bEN0J step 3, ADR-012): a pane whose browser receives Vault
-- fills. Only its owner sees it; agents get no generic browser read, CDP or Playwright surface for it.
CREATE TABLE IF NOT EXISTS vault_protected_panes (
  pane_id text PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vault_protected_panes_owner_idx ON vault_protected_panes (owner_user_id);
