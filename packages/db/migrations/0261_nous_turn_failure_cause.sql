-- R11-1 (Space Gateway down 28/10 23:22 to 29/10 01:16 UTC: about 70 Nous turns failed "Connection refused" and their facts rows kept no
-- cause): a failed or timed-out turn keeps its short error, so the scorecard and the daily review count failures by cause.
ALTER TABLE nous_turn_facts ADD COLUMN IF NOT EXISTS error text CHECK (error IS NULL OR char_length(error) <= 300);
