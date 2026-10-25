ALTER TABLE panes ADD COLUMN IF NOT EXISTS task_metadata jsonb;

CREATE TABLE task_title_states (
  task_key text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  state jsonb NOT NULL,
  due_at timestamptz,
  lease_id text,
  lease_until timestamptz
);
CREATE INDEX task_title_states_due_idx ON task_title_states(due_at) WHERE due_at IS NOT NULL;
CREATE TABLE task_title_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id), settings jsonb NOT NULL);
CREATE TABLE task_title_attempts (
  id bigserial PRIMARY KEY,
  task_key text NOT NULL,
  candidate_id text NOT NULL,
  batch_id text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_title_attempts_at_idx ON task_title_attempts(attempted_at);
CREATE INDEX task_title_attempts_task_at_idx ON task_title_attempts(task_key, attempted_at);
CREATE TABLE task_title_cooldowns (
  candidate_id text PRIMARY KEY,
  until_at timestamptz NOT NULL
);
