-- Job Copilot "Reset and start over": counting starts again from this moment. Nothing is deleted;
-- applications created before it are archived history (still guarding against applying twice).
-- NULL: no reset yet, counting from the first application.
ALTER TABLE job_apply_profiles ADD COLUMN IF NOT EXISTS campaign_started_at timestamptz;
