ALTER TABLE cli_account_profiles
  DROP CONSTRAINT IF EXISTS cli_account_profiles_runtime_id_check;

ALTER TABLE cli_account_profiles
  ADD CONSTRAINT cli_account_profiles_runtime_id_check
  CHECK (runtime_id IN ('cli:gemini', 'cli:copilot'));

INSERT INTO cli_account_profiles (runtime_id, profile_id, display_name, updated_by)
VALUES ('cli:copilot', 'main', 'Main account', NULL)
ON CONFLICT (runtime_id, profile_id) DO NOTHING;
