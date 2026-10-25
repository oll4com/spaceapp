CREATE TABLE IF NOT EXISTS room_agent_task_runs (
  run_id text PRIMARY KEY,
  mission_id text NOT NULL REFERENCES room_agent_missions(mission_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  step_id text NOT NULL,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE RESTRICT,
  label text NOT NULL,
  instruction text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'VERIFYING', 'COMPLETED', 'LOW_QUALITY', 'BLOCKED')),
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  first_response_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_room_agent_task_runs_mission_queued
  ON room_agent_task_runs(mission_id, queued_at ASC, step_id ASC);

CREATE INDEX IF NOT EXISTS idx_room_agent_task_runs_room_status
  ON room_agent_task_runs(room_id, status, updated_at DESC);
