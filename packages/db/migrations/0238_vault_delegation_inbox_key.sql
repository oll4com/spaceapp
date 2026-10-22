-- Operator request 2026-10-20: agents never wait for an unlock. The dock hands the inbox key to the broker with each
-- delegation (wrapped under that generation's ARK-derived key, like key_envelope), so a login agents save, create or change
-- joins the active delegation at once. Null for delegations signed before, and once revoked.
ALTER TABLE vault_delegations ADD COLUMN IF NOT EXISTS inbox_key_envelope jsonb;
