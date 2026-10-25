-- Mail Copilot pane settings, agent and view; optional, so existing panes, identifiers and ordering stay intact.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS mail_copilot_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_mail_copilot_metadata_object
  CHECK (mail_copilot_metadata IS NULL OR (jsonb_typeof(mail_copilot_metadata) = 'object'
    AND mail_copilot_metadata->>'version' = '1'));
