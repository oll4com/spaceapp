-- Optional metadata leaves all existing panes, identifiers and ordering intact.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS job_apply_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_job_apply_metadata_object
  CHECK (job_apply_metadata IS NULL OR (jsonb_typeof(job_apply_metadata) = 'object'
    AND job_apply_metadata->>'version' = '1'));
