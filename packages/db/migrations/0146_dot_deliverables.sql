-- Space Dots Stage 5: deliverables. A file from a Dot's workspace published to Agent Files
-- becomes a numbered version of that deliverable; republishing unchanged content adds nothing.
CREATE TABLE IF NOT EXISTS dot_deliverables (
  deliverable_id text PRIMARY KEY CHECK (deliverable_id ~ '^dot_deliverable:[a-f0-9]{32}$'),
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  -- Kept when the Agent File is deleted, so a version number is never reused.
  artifact_id text REFERENCES artifacts(id) ON DELETE SET NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- The workspace file's own hash: Agent Files may rebuild a file (DOCX), so this is what "unchanged" compares.
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 120),
  published_by text NOT NULL CHECK (published_by IN ('USER','DOT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dot_id, name, version)
);
CREATE INDEX IF NOT EXISTS dot_deliverables_dot_idx ON dot_deliverables(owner_user_id, dot_id, created_at DESC);
-- Identical content is published once while its Agent File exists.
CREATE UNIQUE INDEX IF NOT EXISTS dot_deliverables_source_idx ON dot_deliverables(dot_id, name, source_sha256) WHERE artifact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION space_dot_deliverable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM space_dots d JOIN rooms r ON r.id=NEW.room_id
    WHERE d.dot_id=NEW.dot_id AND d.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'Dot deliverable does not match its Dot, room and owner' USING ERRCODE='23514';
  END IF;
  -- Only the artifact link may be cleared (when the Agent File is deleted); a version is otherwise immutable.
  IF TG_OP='UPDATE' AND (NEW.artifact_id IS NOT NULL OR NEW.deliverable_id IS DISTINCT FROM OLD.deliverable_id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.name IS DISTINCT FROM OLD.name OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
    OR NEW.dot_id IS DISTINCT FROM OLD.dot_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id) THEN
    RAISE EXCEPTION 'A published deliverable version is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_deliverable_identity ON dot_deliverables;
CREATE TRIGGER space_dot_deliverable_identity BEFORE INSERT OR UPDATE ON dot_deliverables
  FOR EACH ROW EXECUTE FUNCTION space_dot_deliverable_identity();
