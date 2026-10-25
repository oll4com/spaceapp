-- Job Copilot mail triage: application emails filed under Gmail labels show up in the activity timeline as MAIL events.
ALTER TABLE job_apply_events DROP CONSTRAINT IF EXISTS job_apply_events_type_check;
ALTER TABLE job_apply_events ADD CONSTRAINT job_apply_events_type_check CHECK (type IN ('STARTED','STEP','FIELD_FILLED','UPLOAD','SUBMITTED','VERIFIED','FAILED',
  'HANDOFF_REQUESTED','HANDOFF_RESOLVED','QUESTION','ANSWERED','REVIEW_REQUESTED','REVIEW_DECIDED','NOTE','SCREENSHOT','RUN_STARTED','RUN_PAUSED',
  'RUN_RESUMED','RUN_STOPPED','RUN_FINISHED','MAIL'));
