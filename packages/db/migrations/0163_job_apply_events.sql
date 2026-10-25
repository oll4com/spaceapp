-- Job Copilot activity: what the agent did, asked and found, per application and per run.
CREATE TABLE IF NOT EXISTS job_apply_events (
  id text PRIMARY KEY CHECK (id ~ '^jobevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  application_id text REFERENCES job_applications(id) ON DELETE CASCADE,
  run_id text CHECK (run_id IS NULL OR run_id ~ '^jobrun:[A-Za-z0-9_-]{6,80}$'),
  type text NOT NULL CHECK (type IN ('STARTED','STEP','FIELD_FILLED','UPLOAD','SUBMITTED','VERIFIED','FAILED','HANDOFF_REQUESTED','HANDOFF_RESOLVED',
    'QUESTION','ANSWERED','REVIEW_REQUESTED','REVIEW_DECIDED','NOTE','SCREENSHOT','RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED','RUN_FINISHED')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  artifact_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_apply_events_owner_idx ON job_apply_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_apply_events_application_idx ON job_apply_events(application_id, created_at DESC) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_apply_events_run_idx ON job_apply_events(run_id, created_at DESC) WHERE run_id IS NOT NULL;
