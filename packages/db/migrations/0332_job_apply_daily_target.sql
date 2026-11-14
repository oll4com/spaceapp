-- Job Copilot daily application target (operator 13/11: 200 a day; 0 is off) and why each day fell behind it ({"YYYY-MM-DD": ["CLI_BUSY", ...]}).
ALTER TABLE job_apply_profiles ADD COLUMN IF NOT EXISTS daily_target integer NOT NULL DEFAULT 0 CHECK (daily_target >= 0);
ALTER TABLE job_apply_profiles ADD COLUMN IF NOT EXISTS target_misses jsonb NOT NULL DEFAULT '{}'::jsonb;
