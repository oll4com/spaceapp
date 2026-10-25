-- Space Gateway: how many weekly limit reset credits the provider reports for an account (Codex), refreshed with usage.
ALTER TABLE space_gateway_accounts ADD COLUMN IF NOT EXISTS reset_credits_available integer
  CHECK (reset_credits_available IS NULL OR reset_credits_available >= 0);
