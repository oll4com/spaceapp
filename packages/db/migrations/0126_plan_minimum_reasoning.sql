-- Nullable for existing plans and clients; recommendations are PLAN metadata.
ALTER TABLE clipboard_items ADD COLUMN IF NOT EXISTS minimum_reasoning text;
ALTER TABLE clipboard_items ADD CONSTRAINT clipboard_items_minimum_reasoning_check
  CHECK (minimum_reasoning IS NULL OR (minimum_reasoning IN
    ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')));
