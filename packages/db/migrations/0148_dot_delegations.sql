-- Space Dots Stage 4: explicit delegation between a user's Dots. The delegate works on a Goal in
-- its own Chat pane with only the task and context it was given, and reports back once per outcome.
CREATE TABLE IF NOT EXISTS dot_delegations (
  delegation_id text PRIMARY KEY CHECK (delegation_id ~ '^dot_delegation:[a-f0-9]{32}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  from_session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  to_dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  to_session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  goal_id text NOT NULL UNIQUE REFERENCES dot_goals(goal_id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 4000),
  reported_status text,
  reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_dot_id <> to_dot_id)
);
CREATE INDEX IF NOT EXISTS dot_delegations_owner_idx ON dot_delegations(owner_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION space_dot_delegation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM space_dots f JOIN space_dots t ON t.owner_user_id=f.owner_user_id JOIN rooms r ON r.id=NEW.room_id
    WHERE f.dot_id=NEW.from_dot_id AND t.dot_id=NEW.to_dot_id AND f.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'Dot delegation does not match its owner, Dots and room' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.goal_id IS DISTINCT FROM OLD.goal_id OR NEW.from_session_id IS DISTINCT FROM OLD.from_session_id
    OR NEW.to_session_id IS DISTINCT FROM OLD.to_session_id OR NEW.task IS DISTINCT FROM OLD.task) THEN
    RAISE EXCEPTION 'A delegation keeps its Dots, sessions, Goal and task' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_delegation_identity ON dot_delegations;
CREATE TRIGGER space_dot_delegation_identity BEFORE INSERT OR UPDATE ON dot_delegations
  FOR EACH ROW EXECUTE FUNCTION space_dot_delegation_identity();
