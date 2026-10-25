CREATE TABLE IF NOT EXISTS memory_graph_change_sets (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('EDIT', 'MERGE', 'ARCHIVE', 'ROLLBACK')),
  status text NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'APPLYING', 'APPLIED', 'FAILED', 'ROLLED_BACK', 'REJECTED')),
  source_path text NOT NULL CHECK (char_length(source_path) BETWEEN 1 AND 1000),
  record_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(record_ids) = 'array' AND jsonb_array_length(record_ids) BETWEEN 1 AND 500),
  resolves_issue_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(resolves_issue_ids) = 'array' AND jsonb_array_length(resolves_issue_ids) <= 500),
  expected_source_hash text NOT NULL CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
  resulting_source_hash text CHECK (resulting_source_hash IS NULL OR resulting_source_hash ~ '^[a-f0-9]{64}$'),
  before_content_hash text NOT NULL CHECK (before_content_hash ~ '^[a-f0-9]{64}$'),
  after_content_hash text NOT NULL CHECK (after_content_hash ~ '^[a-f0-9]{64}$'),
  before_snapshot text NOT NULL CHECK (char_length(before_snapshot) <= 2000000),
  after_snapshot text NOT NULL CHECK (char_length(after_snapshot) <= 2000000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 2000),
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  trace_id text NOT NULL CHECK (char_length(trace_id) BETWEEN 8 AND 128),
  rollback_of_change_set_id text REFERENCES memory_graph_change_sets(id) ON DELETE RESTRICT,
  rolled_back_by_change_set_id text REFERENCES memory_graph_change_sets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  failed_at timestamptz,
  rolled_back_at timestamptz,
  CHECK (
    (kind = 'ROLLBACK' AND rollback_of_change_set_id IS NOT NULL)
    OR (kind <> 'ROLLBACK' AND rollback_of_change_set_id IS NULL)
  ),
  CHECK (rollback_of_change_set_id IS NULL OR rollback_of_change_set_id <> id),
  CHECK (rolled_back_by_change_set_id IS NULL OR rolled_back_by_change_set_id <> id),
  CHECK (status NOT IN ('APPLIED', 'ROLLED_BACK') OR (resulting_source_hash IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK (status <> 'FAILED' OR (status_reason IS NOT NULL AND failed_at IS NOT NULL)),
  CHECK (status <> 'ROLLED_BACK' OR (rolled_back_by_change_set_id IS NOT NULL AND rolled_back_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_change_sets_status_created
  ON memory_graph_change_sets(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_graph_change_sets_source_created
  ON memory_graph_change_sets(source_path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_graph_change_sets_rollback_target
  ON memory_graph_change_sets(rollback_of_change_set_id, created_at DESC)
  WHERE rollback_of_change_set_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_graph_change_sets_record_ids
  ON memory_graph_change_sets USING gin(record_ids);

CREATE INDEX IF NOT EXISTS idx_memory_graph_change_sets_issue_ids
  ON memory_graph_change_sets USING gin(resolves_issue_ids);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_graph_change_sets_one_rollback_link
  ON memory_graph_change_sets(rolled_back_by_change_set_id)
  WHERE rolled_back_by_change_set_id IS NOT NULL;
