-- nous_msg:cb10eefe6cc544e7af63ff64 (14/11): an agent sets an existing item's authenticator key from the setup QR in its own browser
-- page; the Browser Host seals it to the inbox key (sealed_otp) and the dock files it into the item (kind SET_OTP).
ALTER TABLE vault_pending ADD COLUMN IF NOT EXISTS sealed_otp jsonb;
ALTER TABLE vault_pending DROP CONSTRAINT IF EXISTS vault_pending_kind_check;
ALTER TABLE vault_pending ADD CONSTRAINT vault_pending_kind_check CHECK (kind IN ('NEW_ACCOUNT', 'CHANGE_PASSWORD', 'SET_OTP'));
