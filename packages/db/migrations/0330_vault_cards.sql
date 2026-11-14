-- Vault cards (plan clipboard:qf0P640vyLp2): a payment card's only non-secret metadata, {"brand","last4"}; null is a login.
-- The number, expiry, CVC and name stay in the item's browser-sealed fields like a login's.
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS card jsonb;
