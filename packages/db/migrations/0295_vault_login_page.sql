-- Operator 4/11 16:33 BKK (nous_msg:cc5aba71f0364cf68a817b42): a login's login page, a plain address on one of the item's own
-- origins (Shopflix's origin answers 500; its login page is a path). Metadata, never a secret; NULL opens the first origin.
-- vault_pending carries it for a new login an agent saved until the dock files it as an item.
ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS login_page text;
ALTER TABLE vault_pending ADD COLUMN IF NOT EXISTS login_page text;
