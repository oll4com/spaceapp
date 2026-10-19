-- Vault items (plan clipboard:vEYtT6-bEN0J step 5): PENDING marks an item an agent's generated password created or
-- changed until the operator keeps or discards it; history keeps earlier field envelopes (ciphertext under the same item
-- key) after a password change until the operator confirms the new one.
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING'));
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]'::jsonb;
