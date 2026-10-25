-- Space Dots Stage 4: reminders and recurring work for a Dot conversation.
CREATE TABLE IF NOT EXISTS dot_schedules (
  schedule_id text PRIMARY KEY CHECK (schedule_id ~ '^dot_schedule:[a-f0-9]{32}$'),
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 4000),
  recurrence jsonb NOT NULL CHECK (jsonb_typeof(recurrence) = 'object' AND recurrence->>'kind' IN ('ONCE','DAILY','WEEKLY','INTERVAL')),
  time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('PENDING_CONFIRMATION','ACTIVE','PAUSED','COMPLETED','CANCELLED')),
  created_by text NOT NULL CHECK (created_by IN ('USER','DOT')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR char_length(last_outcome) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An active schedule always knows when it runs next.
  CHECK (status <> 'ACTIVE' OR next_run_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS dot_schedules_due_idx ON dot_schedules(next_run_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS dot_schedules_dot_idx ON dot_schedules(dot_id, updated_at DESC);

CREATE OR REPLACE FUNCTION space_dot_schedule_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM space_agent_sessions s JOIN space_dots d ON d.dot_id=s.dot_id JOIN rooms r ON r.id=s.room_id
    WHERE s.session_id=NEW.session_id AND s.dot_id=NEW.dot_id AND s.room_id=NEW.room_id
      AND d.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Dot schedule does not match its session identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.dot_id IS DISTINCT FROM OLD.dot_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.recurrence IS DISTINCT FROM OLD.recurrence OR NEW.time_zone IS DISTINCT FROM OLD.time_zone) THEN
    RAISE EXCEPTION 'A confirmed Dot schedule is immutable; create a new one' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status IN ('COMPLETED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A finished Dot schedule cannot change status' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_schedule_identity ON dot_schedules;
CREATE TRIGGER space_dot_schedule_identity BEFORE INSERT OR UPDATE ON dot_schedules
  FOR EACH ROW EXECUTE FUNCTION space_dot_schedule_identity();
