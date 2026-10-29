-- Anthropic monthly budget (operator request 2026-10-24): what the operator may spend on the Anthropic API each month;
-- the Claude API-key account shows this month's Anthropic bill (Admin API key, migration 0229) as a share of it.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS anthropic_monthly_budget_usd double precision CHECK (anthropic_monthly_budget_usd IS NULL OR anthropic_monthly_budget_usd > 0);
