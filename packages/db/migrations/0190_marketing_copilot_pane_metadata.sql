-- Marketing Copilot pane settings and view; optional, so existing panes, identifiers and ordering stay intact.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS marketing_copilot_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_marketing_copilot_metadata_object
  CHECK (marketing_copilot_metadata IS NULL OR (jsonb_typeof(marketing_copilot_metadata) = 'object'
    AND marketing_copilot_metadata->>'version' = '1'));
