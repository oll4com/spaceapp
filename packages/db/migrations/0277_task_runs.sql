-- Task runs (operator 1/11 03:32 BKK, plan clipboard:GA__W4qBxSPR): every handled occurrence of a scheduled task, written by the
-- same statement that advances it (claimTaskSchedule), so nothing is counted twice. A typed run stays RUNNING until its pane's own
-- report decides it (done, failed/blocked, needs-you) or 6 h pass with none (NO_REPORT). Durable history (class A): never deleted by age.
-- No foreign key to task_items: the history outlives a deleted task, so its title is kept with each run.
CREATE TABLE IF NOT EXISTS task_runs (
  id bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  task_title text NOT NULL,
  room_id text,
  pane_id text,
  due_at timestamptz NOT NULL,
  at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING', 'NO_REPORT', 'SKIPPED', 'REMINDER')),
  typed boolean NOT NULL DEFAULT false,
  detail text NOT NULL CHECK (char_length(detail) <= 500),
  report_at timestamptz,
  report text CHECK (report IS NULL OR char_length(report) <= 500)
);
CREATE INDEX IF NOT EXISTS task_runs_owner ON task_runs (owner_user_id, id DESC);
CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs (owner_user_id, task_id, id DESC);
CREATE INDEX IF NOT EXISTS task_runs_pane ON task_runs (owner_user_id, pane_id, at DESC) WHERE typed;
CREATE INDEX IF NOT EXISTS task_runs_running ON task_runs (at) WHERE status = 'RUNNING';
