CREATE TABLE IF NOT EXISTS space_setup_connection_check_runs (
  id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('ALL', 'SINGLE')),
  connection_ids text[] NOT NULL CHECK (cardinality(connection_ids) BETWEEN 1 AND 11),
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED')),
  total_count integer NOT NULL CHECK (total_count BETWEEN 1 AND 11),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count BETWEEN 0 AND 11),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK (completed_count <= total_count),
  CHECK (total_count = cardinality(connection_ids)),
  CHECK (scope <> 'SINGLE' OR cardinality(connection_ids) = 1),
  CHECK (
    (status = 'RUNNING' AND finished_at IS NULL)
    OR (status = 'COMPLETED' AND finished_at IS NOT NULL AND completed_count = total_count)
  )
);

CREATE INDEX IF NOT EXISTS idx_setup_connection_check_runs_status_created
  ON space_setup_connection_check_runs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS space_setup_connection_check_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES space_setup_connection_check_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  connection_id text NOT NULL CHECK (connection_id ~ '^[a-z0-9][a-z0-9:_-]{0,159}$'),
  stage text NOT NULL CHECK (
    stage IN (
      'Detecting CLI',
      'Checking saved credential',
      'Sending live provider challenge',
      'Confirming credential identity',
      'Saving result',
      'Verified',
      'Quota limited',
      'Timed out',
      'Needs setup',
      'Provider failed',
      'Credential changed',
      'CLI unavailable'
    )
  ),
  state text NOT NULL CHECK (state IN ('RUNNING', 'COMPLETED')),
  functional_state text CHECK (
    functional_state IS NULL
    OR functional_state IN ('FUNCTIONAL', 'NEEDS_SETUP', 'UNAVAILABLE')
  ),
  live_verification_state text CHECK (
    live_verification_state IS NULL
    OR live_verification_state IN ('VERIFIED', 'QUOTA_LIMITED', 'NOT_CHECKED', 'PROVIDER_FAILED', 'TIMED_OUT', 'CREDENTIAL_CHANGED')
  ),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_setup_connection_check_events_run_sequence
  ON space_setup_connection_check_events (run_id, sequence);
