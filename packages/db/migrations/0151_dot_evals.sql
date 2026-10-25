-- Space Dots Stage 7: evaluation runs of a frozen dataset on the real runtime. Each case runs in its own
-- conversation; receipts are rebuilt from what Space recorded for that conversation.
CREATE TABLE IF NOT EXISTS dot_eval_cases (
  eval_run_id text NOT NULL CHECK (eval_run_id ~ '^dot_eval:[a-f0-9]{16}$'),
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9-]{3,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  dataset_version text NOT NULL CHECK (char_length(dataset_version) BETWEEN 1 AND 40),
  model_config_id text CHECK (model_config_id IS NULL OR char_length(model_config_id) <= 500),
  position integer NOT NULL CHECK (position >= 0),
  -- The API process that runs the case; a restarted process closes only cases of processes that are gone.
  runner_id text NOT NULL CHECK (char_length(runner_id) BETWEEN 8 AND 80),
  session_id text REFERENCES space_agent_sessions(session_id) ON DELETE SET NULL,
  goal_id text REFERENCES dot_goals(goal_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','SKIPPED','FAILED','CANCELLED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 500),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (eval_run_id, case_id)
);
CREATE INDEX IF NOT EXISTS dot_eval_cases_owner_idx ON dot_eval_cases(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dot_eval_cases_session_idx ON dot_eval_cases(session_id) WHERE status = 'RUNNING';
-- At most one running case per owner: evaluation runs are sequential and never overlap.
CREATE UNIQUE INDEX IF NOT EXISTS dot_eval_cases_one_running ON dot_eval_cases(owner_user_id) WHERE status = 'RUNNING';
