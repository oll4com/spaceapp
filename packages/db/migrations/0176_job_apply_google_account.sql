-- Job Copilot: the Google account (email) whose Gmail and Calendar the copilot uses. Access goes through the
-- owner's Google connector (connector_accounts holds the sealed tokens); this column only names the account.
ALTER TABLE job_apply_profiles ADD COLUMN IF NOT EXISTS google_email text
  CHECK (google_email IS NULL OR char_length(google_email) BETWEEN 3 AND 320);
