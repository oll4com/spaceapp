-- Every design carries what it shows (with its exact text) and who made it (operator request 2026-10-19), so a pane that
-- asked for it can check it got the right graphic. Rows from before stay NULL.
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR char_length(description) <= 2000);
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS made_by jsonb CHECK (made_by IS NULL OR jsonb_typeof(made_by) = 'object');
