-- Job Copilot run supervisor: one active run per pane; the agent pulls the pane owner's QUEUED
-- applications in queue order (job_next) and reports each one (job_report).
CREATE TABLE IF NOT EXISTS job_apply_runs (
  id text PRIMARY KEY CHECK (id ~ '^jobrun:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','PAUSED','STOPPED')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object'),
  current_application_id text,
  kickoff_sent_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  stopped_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_apply_runs_active_pane_idx ON job_apply_runs(pane_id) WHERE status IN ('RUNNING','PAUSED');
CREATE INDEX IF NOT EXISTS job_apply_runs_owner_idx ON job_apply_runs(owner_user_id, created_at DESC);
-- Queue order of QUEUED applications; null once the copilot takes the row.
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS queue_position integer CHECK (queue_position IS NULL OR queue_position >= 0);
CREATE INDEX IF NOT EXISTS job_applications_owner_queue_idx ON job_applications(owner_user_id, queue_position) WHERE status = 'QUEUED';
