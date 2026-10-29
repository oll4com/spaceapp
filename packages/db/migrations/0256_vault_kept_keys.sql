-- Kept keys and passwords (operator request 2026-10-26): every password agents need (a server's, a VM's admin account, an
-- API key) lives in the Vault, and agents find it there instead of asking the operator. A kept key stays after an agent wrote
-- it (any of the owner's panes, any number of times) and may never expire; agents list kept keys by label and save the
-- passwords that reach them (a mail, a service) as kept keys. saved_by names the pane (or "nous") that saved one; NULL: the operator.
ALTER TABLE vault_handoff_keys ADD COLUMN IF NOT EXISTS kept boolean NOT NULL DEFAULT false;
ALTER TABLE vault_handoff_keys ADD COLUMN IF NOT EXISTS saved_by text;
ALTER TABLE vault_handoff_keys ALTER COLUMN expires_at DROP NOT NULL;
