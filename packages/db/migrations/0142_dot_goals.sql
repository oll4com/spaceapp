-- Space Dots Stage 4: provider-neutral Goals driven by Temporal over Chat turns.
CREATE TABLE IF NOT EXISTS dot_goals (
  goal_id text PRIMARY KEY CHECK (goal_id ~ '^dot_goal:[A-Za-z0-9_-]{8,64}$'),
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  objective text NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 4000),
  milestones jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(milestones) = 'array'),
  criteria jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(criteria) = 'array'),
  budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
  usage jsonb NOT NULL DEFAULT '{"steps":0,"lastRunId":null,"lastStepAt":null,"consecutiveFailures":0}' CHECK (jsonb_typeof(usage) = 'object'),
  status text NOT NULL CHECK (status IN ('ACTIVE','PAUSED','COMPLETED','BLOCKED','CANCELLED','BUDGET_EXHAUSTED','FAILED')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) <= 1000),
  steering jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steering) = 'array'),
  evidence jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'array'),
  workflow_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- One open Goal per conversation (BLOCKED waits for the user's answer); finished Goals remain as history.
CREATE UNIQUE INDEX IF NOT EXISTS dot_goals_one_open_per_session ON dot_goals(session_id) WHERE status IN ('ACTIVE','PAUSED','BLOCKED');
CREATE INDEX IF NOT EXISTS dot_goals_dot_idx ON dot_goals(dot_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS dot_goals_active_idx ON dot_goals(status, updated_at) WHERE status IN ('ACTIVE','PAUSED','BLOCKED');

CREATE OR REPLACE FUNCTION space_dot_goal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM space_agent_sessions s JOIN space_dots d ON d.dot_id=s.dot_id JOIN rooms r ON r.id=s.room_id
    WHERE s.session_id=NEW.session_id AND s.dot_id=NEW.dot_id AND s.room_id=NEW.room_id
      AND d.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Dot goal does not match its session identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.dot_id IS DISTINCT FROM OLD.dot_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id) THEN
    RAISE EXCEPTION 'Dot goal identity is immutable' USING ERRCODE='23514';
  END IF;
  -- Finished Goals never reopen.
  IF TG_OP='UPDATE' AND OLD.status NOT IN ('ACTIVE','PAUSED','BLOCKED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A finished Dot goal cannot change status' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_goal_identity ON dot_goals;
CREATE TRIGGER space_dot_goal_identity BEFORE INSERT OR UPDATE ON dot_goals
  FOR EACH ROW EXECUTE FUNCTION space_dot_goal_identity();

ALTER TABLE dot_tool_invocations DROP CONSTRAINT IF EXISTS dot_tool_invocations_source_check;
ALTER TABLE dot_tool_invocations ADD CONSTRAINT dot_tool_invocations_source_check
  CHECK (source IN ('SPACE_CONTROL','SPACE_RESOURCE','SPACE_NATIVE','SPACE_GOAL','SPACE_SCHEDULE','BROWSER','MCP','INSTALLED_MCP'));
