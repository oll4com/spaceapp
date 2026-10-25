CREATE TABLE IF NOT EXISTS managed_plan_executions (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 plan_id text NOT NULL,
 pane_id text NOT NULL,
 session_id text NOT NULL,
 request_id text NOT NULL,
 status text NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
 record jsonb NOT NULL,
 lease_owner text,
 lease_epoch integer NOT NULL DEFAULT 0,
 lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id, request_id),
 CHECK(status IN ('RUNNING','SWITCHING_MODEL','RESUMING_STAGE','WAITING_FOR_MODEL','WAITING_FOR_INPUT','PAUSED','BLOCKED','COMPLETED','FAILED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_plan_one_active_pane ON managed_plan_executions(pane_id) WHERE status NOT IN ('COMPLETED','FAILED');
CREATE UNIQUE INDEX IF NOT EXISTS managed_plan_one_active_plan ON managed_plan_executions(plan_id) WHERE status NOT IN ('COMPLETED','FAILED');
CREATE INDEX IF NOT EXISTS managed_plan_owner_pane ON managed_plan_executions(owner_user_id,pane_id,created_at DESC);
CREATE TABLE IF NOT EXISTS managed_plan_execution_commands (
 execution_id text NOT NULL REFERENCES managed_plan_executions(id),
 id text NOT NULL,
 record jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(execution_id,id)
);
