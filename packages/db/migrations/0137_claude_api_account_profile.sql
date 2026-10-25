-- The installation API key is a separate Claude account; subscription logins stay per profile.
INSERT INTO cli_account_profiles (runtime_id, profile_id, display_name, updated_by)
VALUES ('cli:claude', 'api', 'API', NULL)
ON CONFLICT (runtime_id, profile_id) DO NOTHING;
