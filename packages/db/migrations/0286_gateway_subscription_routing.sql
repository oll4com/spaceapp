-- Fill-first subscription routing (operator 3/11 13:09 BKK, token audit): one Claude Max or Codex account until about 93% of its
-- 5-hour window, then the next, so the windows reset at different times. WEEKLY_PACE keeps the routing of 2026-10-27.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS subscription_routing text NOT NULL DEFAULT 'FILL_FIRST' CHECK (subscription_routing IN ('FILL_FIRST', 'WEEKLY_PACE'));
