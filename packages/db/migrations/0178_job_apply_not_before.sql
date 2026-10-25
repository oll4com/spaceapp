-- Job Copilot: a posting deferred until an employer-side limit expires ("not more than 5 times in any 180 day span").
-- space_job_next skips a QUEUED row whose not_before is still in the future, and every other queued posting of the
-- same company, then serves them once the date has passed.
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS not_before timestamptz;
