-- Anthropic credits (operator request 2026-10-24): the organization's Claude Console credit grants in total; the API
-- providers tab shows them minus Anthropic's recorded bill (migration 0229), as the Console's remaining balance.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS anthropic_credits_usd double precision CHECK (anthropic_credits_usd IS NULL OR anthropic_credits_usd > 0);
