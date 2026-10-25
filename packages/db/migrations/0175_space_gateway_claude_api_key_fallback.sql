-- Claude API key fallback (operator request 2026-10-13): when every pooled Claude account is out of quota, Space
-- Gateway may send requests through a Claude API-key account (paid per token); the accounts take over again at their
-- next reset. Off by default: the key is never used until the operator turns the setting on.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS claude_api_key_fallback boolean NOT NULL DEFAULT false;
