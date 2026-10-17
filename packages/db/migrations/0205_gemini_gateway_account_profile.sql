-- Antigravity panes can pick Space Gateway, which balances model calls across its pooled Google accounts.
INSERT INTO cli_account_profiles (runtime_id, profile_id, display_name, updated_by)
VALUES ('cli:gemini', 'space-gateway', 'Space Gateway', NULL)
ON CONFLICT (runtime_id, profile_id) DO NOTHING;
