ALTER TABLE admin_operation_runs
  DROP CONSTRAINT IF EXISTS admin_operation_runs_operation_type_check;

ALTER TABLE admin_operation_runs
  ADD CONSTRAINT admin_operation_runs_operation_type_check
  CHECK (
    operation_type IN (
      'CLI_MAINTENANCE_CHECK',
      'CLI_MAINTENANCE_UPDATE',
      'CLI_MAINTENANCE_REPAIR',
      'SPACE_RELEASE'
    )
  );

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_kind_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_kind_check
  CHECK (kind IN ('WORKSPACE', 'AGENT_PROOF', 'CLI_RECOVERY'));

CREATE TABLE IF NOT EXISTS cli_maintenance_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES admin_operation_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  runtime_id text CHECK (
    runtime_id IS NULL OR runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek'
    )
  ),
  phase text NOT NULL CHECK (
    phase IN (
      'DISCOVER',
      'CHECK',
      'PLAN',
      'CONFIG_REPAIR',
      'STAGE',
      'VERIFY',
      'ACTIVATE',
      'POST_CHECK',
      'ROLLBACK',
      'AUTH_HANDOFF',
      'COMPLETE'
    )
  ),
  state text NOT NULL CHECK (
    state IN ('STARTED', 'PROGRESS', 'SUCCEEDED', 'WARNING', 'FAILED', 'SKIPPED', 'RETRYING')
  ),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,80}$'),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  installed_version text CHECK (installed_version IS NULL OR length(installed_version) BETWEEN 1 AND 160),
  available_version text CHECK (available_version IS NULL OR length(available_version) BETWEEN 1 AND 160),
  target_version text CHECK (target_version IS NULL OR length(target_version) BETWEEN 1 AND 160),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 3600000),
  outcome text CHECK (
    outcome IS NULL OR outcome IN (
      'HEALTHY',
      'REPAIRED',
      'DEGRADED',
      'ACTION_REQUIRED',
      'FAILED_ROLLED_BACK',
      'FAILED_UNSAFE'
    )
  ),
  rollback jsonb,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(diagnostics::text) <= 16384),
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_cli_maintenance_events_run_sequence
  ON cli_maintenance_events (run_id, sequence);

CREATE TABLE IF NOT EXISTS cli_maintenance_auth_handoffs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES admin_operation_runs(id) ON DELETE CASCADE,
  runtime_id text NOT NULL CHECK (
    runtime_id IN (
      'cli:codex',
      'cli:claude',
      'cli:gemini',
      'cli:opencode',
      'cli:qwen',
      'cli:kimi',
      'cli:grok',
      'cli:deepseek'
    )
  ),
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'OPENED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[A-Z0-9_]{1,80}$'
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (run_id, runtime_id)
);

CREATE INDEX IF NOT EXISTS idx_cli_maintenance_auth_handoffs_pending
  ON cli_maintenance_auth_handoffs (created_at ASC)
  WHERE status IN ('PENDING', 'OPENED', 'FAILED');
