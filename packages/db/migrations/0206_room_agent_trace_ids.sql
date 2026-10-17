-- Room Agent missions and task runs keep the request trace that created them and a safe error code, so the
-- admin trace lookup can find them (docs/quality/observability.md "Not covered", 1.1.5 internal review).
ALTER TABLE room_agent_missions ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE room_agent_missions ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE room_agent_task_runs ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE room_agent_task_runs ADD COLUMN IF NOT EXISTS error_code text;

CREATE INDEX IF NOT EXISTS idx_room_agent_missions_trace
  ON room_agent_missions(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_room_agent_task_runs_trace
  ON room_agent_task_runs(trace_id) WHERE trace_id IS NOT NULL;

-- Background continuations keep their own trace (workflow ids embed it); the lookup follows them from the run
-- they continue.
CREATE INDEX IF NOT EXISTS idx_room_agent_requests_continuation_source
  ON room_agent_requests ((turn_payload->'turn'->'roomAgentContinuation'->>'sourceRunId'))
  WHERE turn_payload->'turn'->'roomAgentContinuation'->>'sourceRunId' IS NOT NULL;
