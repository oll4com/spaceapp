-- Vault API key handoff (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): the operator pastes a key, gets an id and
-- gives it to an agent; the agent's space_vault_key_install writes the key into the file it belongs in, and the value is
-- deleted here once that succeeded. The value is sealed with the API's connector key (server-readable by design: an agent's
-- own file must receive it, unlike a login); the row keeps the label, times and panes as the operator's receipt until they
-- delete it. An expired key loses its value when it is next listed or asked for.
CREATE TABLE IF NOT EXISTS vault_handoff_keys (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  value_sealed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  taken_at timestamptz,
  taken_by_pane_id text,
  used_at timestamptz,
  used_by_pane_id text
);
CREATE INDEX IF NOT EXISTS vault_handoff_keys_owner_idx ON vault_handoff_keys (owner_user_id, created_at);
