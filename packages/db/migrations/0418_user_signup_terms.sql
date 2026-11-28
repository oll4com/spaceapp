-- K2 §4.2 (plan clipboard:ZGz1LnD51ELH step 7): a headless Google sign-up stores the terms version the person accepted and when they
-- confirmed they are 18 or older. Self-hosted users leave both null.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz;
