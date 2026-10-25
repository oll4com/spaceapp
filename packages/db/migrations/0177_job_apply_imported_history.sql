-- Job Copilot: truthful history for rows imported from an earlier campaign tracker (2026-10-12 import).
-- The import treated unknown outcomes as SUBMITTED and a note saying "verified" as VERIFIED without evidence.
-- An imported row keeps the earlier tracker's outcome in its synthetic URL
-- (https://space.local/imported/<board or outcome>/<id>), so it is corrected here without the CSV.

-- Attempts the earlier tracker recorded as not sent: no form, form not submitted, or an error.
UPDATE job_applications
SET status = 'FAILED',
    external_confirmation = NULL,
    notes = left(concat_ws(' | ', notes, 'earlier tracker: ' || CASE substring(url FROM '^https://space\.local/imported/([A-Z_]+)/')
      WHEN 'NO_FORM' THEN 'no application form found'
      WHEN 'FORM_NO_SUBMIT' THEN 'form filled, not submitted'
      WHEN 'FORM_DONE_NO_SUBMIT' THEN 'form completed, not submitted'
      ELSE 'the attempt ended in an error' END), 4000),
    updated_at = now()
WHERE url ~ '^https://space\.local/imported/(NO_FORM|FORM_NO_SUBMIT|FORM_DONE_NO_SUBMIT|ERR)/'
  AND status IN ('SUBMITTED', 'VERIFIED');

-- "verified" in the earlier tracker is a claim, not evidence: VERIFIED needs a confirmation page or email.
UPDATE job_applications
SET status = 'SUBMITTED',
    external_confirmation = NULL,
    notes = left(concat_ws(' | ', notes, 'earlier tracker said verified; no confirmation email checked yet'), 4000),
    updated_at = now()
WHERE status = 'VERIFIED'
  AND external_confirmation = 'imported: verified'
  AND evidence_artifact_ids = '[]'::jsonb;

-- Placeholder titles of the import ("Unknown role", "Job 8365685002") say what they are.
UPDATE job_applications
SET role = 'Title not recorded'
WHERE url LIKE 'https://space.local/imported/%'
  AND (role = 'Unknown role' OR role ~ '^Job [0-9]+$');

-- LinkedIn rows of the shifted-column run were filed under "other".
UPDATE job_applications
SET ats = 'linkedin'
WHERE url ~ '^https://space\.local/imported/[^/]+/linkedin_[0-9]+$'
  AND ats = 'other';
