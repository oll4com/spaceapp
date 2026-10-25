ALTER TABLE pane_browser_sessions
  ADD COLUMN IF NOT EXISTS stream_mode text NOT NULL DEFAULT 'AUTO'
    CHECK (stream_mode IN ('AUTO', 'SILENT', 'PREVIEW', 'INTERACTIVE', 'REALTIME')),
  ADD COLUMN IF NOT EXISTS resolved_stream_mode text NOT NULL DEFAULT 'PREVIEW'
    CHECK (resolved_stream_mode IN ('SILENT', 'PREVIEW', 'INTERACTIVE', 'REALTIME')),
  ADD COLUMN IF NOT EXISTS runtime_state text NOT NULL DEFAULT 'STARTING'
    CHECK (runtime_state IN ('STARTING', 'READY', 'DEGRADED', 'STOPPED', 'ERROR')),
  ADD COLUMN IF NOT EXISTS capacity_state text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (capacity_state IN ('AVAILABLE', 'QUEUED', 'LIMITED')),
  ADD COLUMN IF NOT EXISTS control_state text NOT NULL DEFAULT 'UNCONTROLLED'
    CHECK (control_state IN ('UNCONTROLLED', 'AGENT', 'OPERATOR')),
  ADD COLUMN IF NOT EXISTS pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_page_id text,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS queue_position integer CHECK (queue_position IS NULL OR queue_position >= 1);

CREATE TABLE IF NOT EXISTS browser_control_leases (
  lease_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_browser_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  holder_type text NOT NULL CHECK (holder_type IN ('AGENT', 'OPERATOR')),
  holder_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED')),
  reason text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_control_leases_one_active_per_session
  ON browser_control_leases(session_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_browser_control_leases_session_status
  ON browser_control_leases(session_id, status, acquired_at DESC);

CREATE TABLE IF NOT EXISTS browser_capture_jobs (
  job_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_browser_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('AGENT', 'OPERATOR')),
  requested_by_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  capture_options jsonb NOT NULL,
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  status_reason text,
  artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_browser_capture_jobs_session_status
  ON browser_capture_jobs(session_id, status, queued_at DESC);

CREATE INDEX IF NOT EXISTS idx_browser_capture_jobs_queue
  ON browser_capture_jobs(status, queued_at ASC)
  WHERE status IN ('QUEUED', 'RUNNING');

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_artifacts_retention_due
  ON artifacts(expires_at)
  WHERE expires_at IS NOT NULL AND pinned_at IS NULL AND deleted_at IS NULL;
