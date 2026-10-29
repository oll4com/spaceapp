-- Operator request 2026-10-21 (plan clipboard:SMcT__jALB6R): a Chrome passwords import tags each login with the Google
-- account the export came from (one of the owner's google_accounts; NULL = no account, so older items stay valid). login_key
-- is an HMAC the unlocked browser makes from the site and username under a VRK-derived key: equal keys mean the same login
-- under several accounts, so a fill prefers the pane browser's account. Neither column is secret.
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS google_account_id text;
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS login_key text;
