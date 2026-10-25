-- Research Council runs: one row per question, owned by a user. The plan and every stage's output live in jsonb
-- and are rewritten after each answer and review, so a resumed run never pays twice. One active run per owner.
CREATE TABLE IF NOT EXISTS council_runs (
  id text PRIMARY KEY CHECK (id ~ '^council_run:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  coordinator_model_id text NOT NULL CHECK (char_length(coordinator_model_id) BETWEEN 3 AND 200),
  status text NOT NULL CHECK (status IN ('PLANNING', 'NEEDS_INPUT', 'AWAITING_APPROVAL', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED')),
  stage text NOT NULL CHECK (stage IN ('PLAN', 'RESEARCH', 'ANSWERS', 'MERGE', 'REVIEW', 'FINAL', 'DONE')),
  plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS council_runs_one_active_idx ON council_runs (owner_user_id)
  WHERE status IN ('PLANNING', 'NEEDS_INPUT', 'AWAITING_APPROVAL', 'RUNNING');
CREATE INDEX IF NOT EXISTS council_runs_owner_created_idx ON council_runs (owner_user_id, created_at DESC);
