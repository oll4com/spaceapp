-- Space Dots Stage 3: tool gateway receipts and gateway-enabled native threads.
-- Additive only; old binaries ignore both the column and the table.
ALTER TABLE space_agent_sessions ADD COLUMN IF NOT EXISTS tool_gateway text;
ALTER TABLE space_agent_sessions DROP CONSTRAINT IF EXISTS space_agent_sessions_tool_gateway_check;
ALTER TABLE space_agent_sessions ADD CONSTRAINT space_agent_sessions_tool_gateway_check
  CHECK (tool_gateway IS NULL OR tool_gateway = 'space-dot-tools-v1');

CREATE TABLE IF NOT EXISTS dot_tool_invocations (
  invocation_id text PRIMARY KEY,
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  run_id text,
  call_id text,
  tool_id text NOT NULL CHECK (char_length(tool_id) BETWEEN 3 AND 200),
  source text NOT NULL CHECK (source IN ('SPACE_CONTROL','SPACE_RESOURCE','SPACE_NATIVE','BROWSER','MCP','INSTALLED_MCP')),
  risk text NOT NULL CHECK (risk IN ('READ','WRITE','DESTRUCTIVE')),
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','PENDING','FAILED','BLOCKED','APPROVAL_REQUIRED','DECLINED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 1000),
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^sha256:[a-f0-9]{64}$'),
  result_summary text CHECK (result_summary IS NULL OR char_length(result_summary) <= 2000),
  -- A sensitive action waits here, exactly as normalized, until its owner decides.
  approval_payload jsonb CHECK (approval_payload IS NULL OR jsonb_typeof(approval_payload) = 'object'),
  approval_summary text CHECK (approval_summary IS NULL OR char_length(approval_summary) <= 1000),
  decided_at timestamptz,
  decided_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- A retried native tool call (same session, Codex call id, tool and arguments) must not create a second receipt.
CREATE UNIQUE INDEX IF NOT EXISTS dot_tool_invocations_call_idx
  ON dot_tool_invocations(session_id, call_id, tool_id, arguments_hash) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dot_tool_invocations_pending_idx
  ON dot_tool_invocations(session_id, started_at DESC) WHERE status = 'APPROVAL_REQUIRED';
CREATE INDEX IF NOT EXISTS dot_tool_invocations_dot_idx ON dot_tool_invocations(dot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS dot_tool_invocations_run_idx ON dot_tool_invocations(run_id) WHERE run_id IS NOT NULL;

-- The receipt identity must match the session's Dot, room and owner.
CREATE OR REPLACE FUNCTION space_dot_tool_invocation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM space_agent_sessions s JOIN space_dots d ON d.dot_id=s.dot_id JOIN rooms r ON r.id=s.room_id
    WHERE s.session_id=NEW.session_id AND s.dot_id=NEW.dot_id AND s.room_id=NEW.room_id
      AND d.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Dot tool receipt does not match its session identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.dot_id IS DISTINCT FROM OLD.dot_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.tool_id IS DISTINCT FROM OLD.tool_id OR NEW.arguments_hash IS DISTINCT FROM OLD.arguments_hash
    OR (OLD.approval_payload IS NOT NULL AND NEW.approval_payload IS DISTINCT FROM OLD.approval_payload)) THEN
    RAISE EXCEPTION 'Dot tool receipt identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_tool_invocation_identity ON dot_tool_invocations;
CREATE TRIGGER space_dot_tool_invocation_identity BEFORE INSERT OR UPDATE ON dot_tool_invocations
  FOR EACH ROW EXECUTE FUNCTION space_dot_tool_invocation_identity();
