CREATE TABLE IF NOT EXISTS review_checks (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  review_decision_id text REFERENCES review_decisions(id) ON DELETE SET NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS', 'WARN', 'FAIL', 'SKIPPED', 'RUNNING')),
  command text,
  summary text NOT NULL,
  artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_checks_room_created
  ON review_checks(room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_checks_decision_created
  ON review_checks(review_decision_id, created_at DESC)
  WHERE review_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_checks_status_created
  ON review_checks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS review_diff_summaries (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  review_decision_id text REFERENCES review_decisions(id) ON DELETE SET NULL,
  title text NOT NULL,
  file_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('ADDED', 'MODIFIED', 'DELETED', 'RENAMED')),
  additions integer NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions integer NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  patch_artifact_id text REFERENCES artifacts(id) ON DELETE SET NULL,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_diff_summaries_room_created
  ON review_diff_summaries(room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_diff_summaries_decision_created
  ON review_diff_summaries(review_decision_id, created_at DESC)
  WHERE review_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_diff_summaries_status_created
  ON review_diff_summaries(status, created_at DESC);
