-- Space Gateway: the kind and expiry of each Claude limit-reset grant ("cedar_ember"), refreshed with usage; the count stays in reset_credits_available.
ALTER TABLE space_gateway_accounts ADD COLUMN IF NOT EXISTS reset_credit_grants jsonb;
