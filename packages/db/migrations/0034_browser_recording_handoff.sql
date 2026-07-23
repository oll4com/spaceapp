CREATE TABLE IF NOT EXISTS browser_capture_segments (
  segment_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES browser_capture_jobs(job_id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES pane_browser_sessions(session_id) ON DELETE CASCADE,
  segment_sequence integer NOT NULL CHECK (segment_sequence >= 0),
  status text NOT NULL CHECK (status IN ('OPEN', 'FINALIZED', 'FAILED', 'DISCARDED')),
  artifact_id text REFERENCES artifacts(id) ON DELETE SET NULL,
  storage_uri text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0 AND byte_size <= 1073741824),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0 AND duration_ms <= 1800000),
  frame_count integer NOT NULL DEFAULT 0 CHECK (frame_count >= 0),
  last_frame_sequence bigint CHECK (last_frame_sequence IS NULL OR last_frame_sequence >= 0),
  status_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (job_id, segment_sequence)
);

CREATE INDEX IF NOT EXISTS idx_browser_capture_segments_job_sequence
  ON browser_capture_segments(job_id, segment_sequence ASC);

CREATE INDEX IF NOT EXISTS idx_browser_capture_segments_open
  ON browser_capture_segments(job_id, updated_at DESC)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS browser_handoff_requests (
  handoff_request_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES pane_browser_sessions(session_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('AGENT', 'OPERATOR')),
  requested_by_id text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('REQUESTED', 'ACCEPTED', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  operator_user_id text REFERENCES users(id),
  operator_email text,
  operator_role text CHECK (operator_role IS NULL OR operator_role IN ('OPERATOR', 'ADMIN')),
  control_lease_id text REFERENCES browser_control_leases(lease_id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  completed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (operator_user_id IS NULL AND operator_email IS NULL AND operator_role IS NULL)
    OR
    (operator_user_id IS NOT NULL AND operator_email IS NOT NULL AND operator_role IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('ACCEPTED', 'COMPLETED')
    OR (operator_user_id IS NOT NULL AND operator_email IS NOT NULL AND operator_role IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_handoff_requests_one_active_per_session
  ON browser_handoff_requests(session_id)
  WHERE status IN ('REQUESTED', 'ACCEPTED');

CREATE INDEX IF NOT EXISTS idx_browser_handoff_requests_room_status
  ON browser_handoff_requests(room_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_browser_handoff_requests_expiry
  ON browser_handoff_requests(expires_at ASC)
  WHERE status IN ('REQUESTED', 'ACCEPTED');
