ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS canonical_memory_id text,
  ADD COLUMN IF NOT EXISTS canonical_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS canonical_link_source text;

ALTER TABLE memory_records
  ADD CONSTRAINT memory_records_canonical_memory_id_check
    CHECK (canonical_memory_id IS NULL OR char_length(canonical_memory_id) BETWEEN 8 AND 240),
  ADD CONSTRAINT memory_records_canonical_link_source_check
    CHECK (canonical_link_source IS NULL OR canonical_link_source IN ('CANONICAL_SAVE', 'EXACT_BACKFILL', 'REPAIR')),
  ADD CONSTRAINT memory_records_canonical_link_complete_check
    CHECK (
      (canonical_memory_id IS NULL AND canonical_linked_at IS NULL AND canonical_link_source IS NULL)
      OR
      (canonical_memory_id IS NOT NULL AND canonical_linked_at IS NOT NULL AND canonical_link_source IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_memory_records_canonical_memory_id
  ON memory_records(canonical_memory_id)
  WHERE canonical_memory_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_graph_issue_states (
  issue_id text PRIMARY KEY CHECK (char_length(issue_id) BETWEEN 8 AND 240),
  issue_type text NOT NULL CHECK (issue_type IN ('MISSING_TIMESTAMP', 'INVALID_MARKER', 'EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'CONFLICT', 'STALE', 'CACHE_MISMATCH')),
  record_id text CHECK (record_id IS NULL OR char_length(record_id) BETWEEN 8 AND 240),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('OPEN', 'IGNORED', 'RESOLVED')),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_issue_states_status_updated
  ON memory_graph_issue_states(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_graph_issue_states_record
  ON memory_graph_issue_states(record_id, updated_at DESC)
  WHERE record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 128),
  mode text NOT NULL CHECK (mode IN ('AUDIT', 'REPAIR')),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('OPERATOR', 'SCHEDULED')),
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  workflow_id text NOT NULL UNIQUE CHECK (char_length(workflow_id) BETWEEN 8 AND 240),
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 8 AND 240),
  source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  progress_completed integer NOT NULL DEFAULT 0 CHECK (progress_completed >= 0),
  progress_total integer NOT NULL DEFAULT 0 CHECK (progress_total >= 0 AND progress_completed <= progress_total),
  finding_count integer NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  applied_operation_count integer NOT NULL DEFAULT 0 CHECK (applied_operation_count >= 0),
  skipped_operation_count integer NOT NULL DEFAULT 0 CHECK (skipped_operation_count >= 0),
  failed_operation_count integer NOT NULL DEFAULT 0 CHECK (failed_operation_count >= 0),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 65536),
  model_id text CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 240),
  ai_verified boolean NOT NULL DEFAULT false,
  ai_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ai_evidence) = 'object' AND pg_column_size(ai_evidence) <= 65536),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((trigger_kind = 'OPERATOR' AND actor_user_id IS NOT NULL) OR trigger_kind = 'SCHEDULED'),
  CHECK (status <> 'RUNNING' OR started_at IS NOT NULL),
  CHECK (status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') OR completed_at IS NOT NULL),
  CHECK (status <> 'FAILED' OR status_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_status_created
  ON memory_consolidation_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_consolidation_findings (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 128),
  run_id text NOT NULL REFERENCES memory_consolidation_runs(id) ON DELETE CASCADE,
  issue_id text CHECK (issue_id IS NULL OR char_length(issue_id) BETWEEN 8 AND 240),
  finding_type text NOT NULL CHECK (finding_type IN ('MISSING_TIMESTAMP', 'INVALID_MARKER', 'EXACT_DUPLICATE', 'NEAR_DUPLICATE', 'CONFLICT', 'STALE', 'CACHE_MISMATCH')),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
  status text NOT NULL CHECK (status IN ('OPEN', 'APPLIED', 'SKIPPED')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  record_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(record_ids) = 'array' AND jsonb_array_length(record_ids) <= 100),
  source_path text NOT NULL CHECK (char_length(source_path) BETWEEN 1 AND 1000),
  evidence text NOT NULL CHECK (char_length(evidence) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_consolidation_findings_run_status
  ON memory_consolidation_findings(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS memory_consolidation_operations (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 8 AND 128),
  run_id text NOT NULL REFERENCES memory_consolidation_runs(id) ON DELETE CASCADE,
  finding_id text REFERENCES memory_consolidation_findings(id) ON DELETE SET NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('LINK_CACHE', 'NORMALIZE_MARKER', 'ARCHIVE_EXACT_DUPLICATE', 'ARCHIVE_SUPERSEDED', 'REPORT_ISSUE')),
  status text NOT NULL CHECK (status IN ('PROPOSED', 'APPLYING', 'APPLIED', 'SKIPPED', 'FAILED')),
  record_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(record_ids) = 'array' AND jsonb_array_length(record_ids) BETWEEN 1 AND 100),
  change_set_id text REFERENCES memory_graph_change_sets(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (status <> 'APPLIED' OR applied_at IS NOT NULL),
  CHECK (status <> 'FAILED' OR status_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_memory_consolidation_operations_run_status
  ON memory_consolidation_operations(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS memory_command_idempotency (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_scope text NOT NULL CHECK (char_length(command_scope) BETWEEN 3 AND 120),
  actor_key text NOT NULL CHECK (char_length(actor_key) BETWEEN 3 AND 240),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 3 AND 120),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 8 AND 240),
  workflow_id text CHECK (workflow_id IS NULL OR char_length(workflow_id) BETWEEN 8 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (command_scope, actor_key, idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_command_idempotency_resource
  ON memory_command_idempotency(resource_type, resource_id);
