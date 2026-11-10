-- Fill-first Claude reserve for Nous (operator 4/11): % of the last available Claude subscription account's
-- 5-hour window kept for Nous's OPERATOR and DECISION turns (default 20, 0 off).
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS claude_reserve_percent double precision NOT NULL DEFAULT 20 CHECK (claude_reserve_percent BETWEEN 0 AND 100);
