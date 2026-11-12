-- Settings → Login password stores the .env operator's new password as the owner's (operator 12/11, nous_msg:ab7d29cfda7e438b8bbb1e9a).
-- SHA-256 of the SPACE_OPERATOR_PASSWORD_HASH it replaced: a different hash set later on the host becomes the password again (recovery).
ALTER TABLE space_owner_setup
  ADD COLUMN IF NOT EXISTS env_password_sha256 text CHECK (env_password_sha256 IS NULL OR env_password_sha256 ~ '^[a-f0-9]{64}$');
