-- Additive identity migration. No session/thread/workflow IDs or execution state change.
CREATE TABLE space_dots (
  dot_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 6),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  appearance jsonb NOT NULL CHECK (jsonb_typeof(appearance) = 'object'),
  preferences jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(preferences) = 'object'),
  permissions jsonb NOT NULL DEFAULT '{"mode":"INHERIT_USER"}' CHECK (permissions = '{"mode":"INHERIT_USER"}'::jsonb),
  work_limits jsonb NOT NULL DEFAULT '{"maxConcurrentTasks":1,"dailyBudgetUsd":null}' CHECK (jsonb_typeof(work_limits) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, slot)
);

CREATE FUNCTION space_seed_dots(owner_id text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO space_dots(dot_id,owner_user_id,slot,name,appearance)
  SELECT 'dot:' || md5(owner_id || ':' || defaults.slot::text), owner_id, defaults.slot, defaults.name,
    jsonb_build_object('character', defaults.character, 'accent', defaults.accent)
  FROM (VALUES (1,'Orbit','astronaut','slate'),(2,'Nova','star','amber'),(3,'Byte','robot','cyan'),
    (4,'Comet','comet','coral'),(5,'Luna','moon','silver'),(6,'Cosmo','planet','violet')) AS defaults(slot,name,character,accent)
  ON CONFLICT (owner_user_id,slot) DO NOTHING;
$$;
SELECT space_seed_dots(id) FROM users;
CREATE FUNCTION space_seed_user_dots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM space_seed_dots(NEW.id); RETURN NEW; END;
$$;
CREATE TRIGGER space_user_dots AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION space_seed_user_dots();
CREATE FUNCTION space_first_dot(owner_id text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT dot_id FROM space_dots WHERE owner_user_id=owner_id AND slot=1;
$$;

ALTER TABLE space_agent_sessions ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE space_agent_messages ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE space_agent_runs ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE room_agent_missions ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE memory_records ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE space_control_records ADD COLUMN dot_id text REFERENCES space_dots(dot_id);
ALTER TABLE live_personal_memory ADD COLUMN dot_id text REFERENCES space_dots(dot_id);

UPDATE space_agent_sessions s SET dot_id=space_first_dot(r.owner_user_id) FROM rooms r WHERE s.room_id=r.id;
UPDATE space_agent_messages m SET dot_id=s.dot_id FROM space_agent_sessions s WHERE m.session_id=s.session_id;
UPDATE space_agent_runs t SET dot_id=s.dot_id FROM space_agent_sessions s WHERE t.session_id=s.session_id;
UPDATE room_agent_missions t SET dot_id=s.dot_id FROM space_agent_sessions s WHERE t.session_id=s.session_id;
UPDATE memory_records m SET dot_id=space_first_dot(r.owner_user_id) FROM rooms r WHERE m.room_id=r.id;
UPDATE space_control_records SET dot_id=space_first_dot(actor_id) WHERE kind IN ('schedule','operation','audit');
UPDATE live_personal_memory SET dot_id=space_first_dot(owner_user_id);

-- Old binaries omit dot_id. Defaults are resolved from actual ownership, never a global user.
CREATE FUNCTION space_dot_room_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.dot_id IS NOT NULL AND NEW.dot_id IS DISTINCT FROM OLD.dot_id THEN
    RAISE EXCEPTION 'Dot identity is immutable' USING ERRCODE='23514';
  END IF;
  SELECT owner_user_id INTO owner_id FROM rooms WHERE id=NEW.room_id;
  NEW.dot_id := COALESCE(NEW.dot_id,space_first_dot(owner_id));
  IF NEW.dot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_dots WHERE dot_id=NEW.dot_id AND owner_user_id=owner_id) THEN
    RAISE EXCEPTION 'Dot does not belong to room owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_session_dot BEFORE INSERT OR UPDATE ON space_agent_sessions FOR EACH ROW EXECUTE FUNCTION space_dot_room_identity();
CREATE TRIGGER space_memory_dot BEFORE INSERT OR UPDATE ON memory_records FOR EACH ROW EXECUTE FUNCTION space_dot_room_identity();

CREATE FUNCTION space_dot_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_dot text; parent_room text;
BEGIN
  SELECT dot_id,room_id INTO parent_dot,parent_room FROM space_agent_sessions WHERE session_id=NEW.session_id;
  IF NEW.dot_id IS NOT NULL AND NEW.dot_id IS DISTINCT FROM parent_dot THEN
    RAISE EXCEPTION 'Dot must match session' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.dot_id IS NOT NULL AND parent_dot IS DISTINCT FROM OLD.dot_id THEN
    RAISE EXCEPTION 'Dot identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME <> 'space_agent_messages' AND to_jsonb(NEW)->>'room_id' IS DISTINCT FROM parent_room THEN
    RAISE EXCEPTION 'Room must match session' USING ERRCODE='23514';
  END IF;
  NEW.dot_id := parent_dot;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_message_dot BEFORE INSERT OR UPDATE ON space_agent_messages FOR EACH ROW EXECUTE FUNCTION space_dot_session_identity();
CREATE TRIGGER space_run_dot BEFORE INSERT OR UPDATE ON space_agent_runs FOR EACH ROW EXECUTE FUNCTION space_dot_session_identity();
CREATE TRIGGER space_mission_dot BEFORE INSERT OR UPDATE ON room_agent_missions FOR EACH ROW EXECUTE FUNCTION space_dot_session_identity();

CREATE FUNCTION space_dot_actor_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  IF TG_TABLE_NAME='space_control_records' THEN
    IF NEW.kind NOT IN ('schedule','operation','audit') THEN RETURN NEW; END IF;
    owner_id := NEW.actor_id;
    IF NEW.value ? 'dotId' THEN
      IF NEW.dot_id IS NOT NULL AND NEW.dot_id IS DISTINCT FROM NEW.value->>'dotId' THEN
        RAISE EXCEPTION 'Dot must match record' USING ERRCODE='23514';
      END IF;
      NEW.dot_id := NEW.value->>'dotId';
    END IF;
  ELSE owner_id := NEW.owner_user_id;
  END IF;
  IF TG_OP='UPDATE' AND OLD.dot_id IS NOT NULL AND NEW.dot_id IS DISTINCT FROM OLD.dot_id THEN
    RAISE EXCEPTION 'Dot identity is immutable' USING ERRCODE='23514';
  END IF;
  NEW.dot_id := COALESCE(NEW.dot_id,space_first_dot(owner_id));
  IF NEW.dot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_dots WHERE dot_id=NEW.dot_id AND owner_user_id=owner_id) THEN
    RAISE EXCEPTION 'Dot does not belong to actor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_control_dot BEFORE INSERT OR UPDATE ON space_control_records FOR EACH ROW EXECUTE FUNCTION space_dot_actor_identity();
CREATE TRIGGER space_live_memory_dot BEFORE INSERT OR UPDATE ON live_personal_memory FOR EACH ROW EXECUTE FUNCTION space_dot_actor_identity();

CREATE INDEX space_sessions_dot ON space_agent_sessions(dot_id,updated_at DESC,session_id);
CREATE INDEX space_messages_dot ON space_agent_messages(dot_id,created_at DESC,message_id);
CREATE INDEX space_runs_dot ON space_agent_runs(dot_id,updated_at DESC,run_id);
CREATE INDEX space_missions_dot ON room_agent_missions(dot_id,updated_at DESC,mission_id);
CREATE INDEX space_memory_dot ON memory_records(dot_id,created_at DESC,id);
CREATE INDEX space_control_dot ON space_control_records(dot_id,kind,updated_at DESC,record_key);
