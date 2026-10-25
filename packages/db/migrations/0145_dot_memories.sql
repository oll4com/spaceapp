-- Space Dots Stage 5: memory per Dot and per project, with source, edits and real deletion.
-- DOT memories belong to one Dot; PROJECT memories to one Dot and one project; SHARED
-- memories are visible to all of the owner's Dots and exist only when explicitly shared.
-- Deleting a row deletes its text and its embedding from memory storage. Conversations, approval records and
-- model history that quoted a memory keep their own copies.
CREATE TABLE IF NOT EXISTS dot_memories (
  memory_id text PRIMARY KEY CHECK (memory_id ~ '^dot_memory:[a-f0-9]{32}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dot_id text REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('DOT','PROJECT','SHARED')),
  project_key text CHECK (project_key IS NULL OR char_length(project_key) BETWEEN 1 AND 500),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  source text NOT NULL CHECK (source IN ('USER','DOT')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) <= 300),
  embedding vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'DOT' AND dot_id IS NOT NULL AND project_key IS NULL)
    OR (scope = 'PROJECT' AND dot_id IS NOT NULL AND project_key IS NOT NULL)
    OR (scope = 'SHARED' AND dot_id IS NULL AND project_key IS NULL))
);
CREATE INDEX IF NOT EXISTS dot_memories_owner_idx ON dot_memories(owner_user_id, dot_id, updated_at DESC);

CREATE OR REPLACE FUNCTION space_dot_memory_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM space_dots d WHERE d.dot_id=NEW.dot_id AND d.owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'Dot memory does not match its owner' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.dot_id IS DISTINCT FROM OLD.dot_id
    OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.project_key IS DISTINCT FROM OLD.project_key) THEN
    RAISE EXCEPTION 'A Dot memory keeps its owner, Dot and scope; create a new one instead' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_memory_identity ON dot_memories;
CREATE TRIGGER space_dot_memory_identity BEFORE INSERT OR UPDATE ON dot_memories
  FOR EACH ROW EXECUTE FUNCTION space_dot_memory_identity();

ALTER TABLE dot_tool_invocations DROP CONSTRAINT IF EXISTS dot_tool_invocations_source_check;
ALTER TABLE dot_tool_invocations ADD CONSTRAINT dot_tool_invocations_source_check
  CHECK (source IN ('SPACE_CONTROL','SPACE_RESOURCE','SPACE_NATIVE','SPACE_GOAL','SPACE_SCHEDULE','SPACE_COMPUTER','SPACE_MEMORY','BROWSER','MCP','INSTALLED_MCP'));
