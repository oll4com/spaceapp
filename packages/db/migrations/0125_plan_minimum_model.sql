-- 0125_plan_minimum_model.sql
-- Add minimum model requirement to clipboard_items for PLAN items.

ALTER TABLE clipboard_items
  ADD COLUMN IF NOT EXISTS minimum_model text;

ALTER TABLE clipboard_items
  DROP CONSTRAINT IF EXISTS clipboard_items_minimum_model_check;

ALTER TABLE clipboard_items
  ADD CONSTRAINT clipboard_items_minimum_model_check
  CHECK (minimum_model IS NULL OR (char_length(minimum_model) BETWEEN 1 AND 160));
