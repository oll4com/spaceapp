-- Optional metadata leaves all existing panes, identifiers and ordering intact.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS t3code_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_t3code_metadata_object
  CHECK (t3code_metadata IS NULL OR (jsonb_typeof(t3code_metadata) = 'object'
    AND t3code_metadata->>'version' = '1'));
