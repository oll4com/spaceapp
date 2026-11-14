-- Parked plans (operator 13/11 nous_msg:4080b166, plan clipboard:7S_jA46vDkU9): why a plan is parked and the conditions that resume it.
-- Additive: old rows read as not parked.
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS parked_json jsonb;
