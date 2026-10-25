-- Allow X and DISCORD in streaming oauth authorizations, platform accounts, and attempts
ALTER TABLE streaming_oauth_authorizations DROP CONSTRAINT IF EXISTS streaming_oauth_authorizations_provider_check;
ALTER TABLE streaming_oauth_authorizations ADD CONSTRAINT streaming_oauth_authorizations_provider_check CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK', 'X', 'DISCORD'));

ALTER TABLE streaming_platform_accounts DROP CONSTRAINT IF EXISTS streaming_platform_accounts_provider_check;
ALTER TABLE streaming_platform_accounts ADD CONSTRAINT streaming_platform_accounts_provider_check CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK', 'X', 'DISCORD'));

ALTER TABLE streaming_oauth_attempts DROP CONSTRAINT IF EXISTS streaming_oauth_attempts_provider_check;
ALTER TABLE streaming_oauth_attempts ADD CONSTRAINT streaming_oauth_attempts_provider_check CHECK (provider IN ('YOUTUBE', 'TWITCH', 'TIKTOK', 'X', 'DISCORD'));
