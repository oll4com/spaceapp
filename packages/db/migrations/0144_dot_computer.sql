-- Space Dots Stage 4: each Dot's own Browser pane per room, with an isolated profile.
-- A Dot drives its own pane freely within its permissions; changing the user's
-- other Browser panes always needs the owner's approval.
CREATE TABLE IF NOT EXISTS dot_browser_panes (
  dot_id text NOT NULL REFERENCES space_dots(dot_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text NOT NULL UNIQUE REFERENCES panes(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dot_id, room_id)
);

CREATE OR REPLACE FUNCTION space_dot_browser_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM space_dots d JOIN rooms r ON r.id=NEW.room_id JOIN panes p ON p.id=NEW.pane_id
    WHERE d.dot_id=NEW.dot_id AND d.owner_user_id=NEW.owner_user_id AND r.owner_user_id=NEW.owner_user_id
      AND p.room_id=NEW.room_id AND p.mode='BROWSER'
  ) THEN
    RAISE EXCEPTION 'Dot browser pane does not match its Dot, room and owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_dot_browser_identity ON dot_browser_panes;
CREATE TRIGGER space_dot_browser_identity BEFORE INSERT OR UPDATE ON dot_browser_panes
  FOR EACH ROW EXECUTE FUNCTION space_dot_browser_identity();

-- Reconcile before repeating: the latest identical call in a conversation.
CREATE INDEX IF NOT EXISTS dot_tool_invocations_identical_idx
  ON dot_tool_invocations(session_id, tool_id, arguments_hash, started_at DESC);

ALTER TABLE dot_tool_invocations DROP CONSTRAINT IF EXISTS dot_tool_invocations_source_check;
ALTER TABLE dot_tool_invocations ADD CONSTRAINT dot_tool_invocations_source_check
  CHECK (source IN ('SPACE_CONTROL','SPACE_RESOURCE','SPACE_NATIVE','SPACE_GOAL','SPACE_SCHEDULE','SPACE_COMPUTER','BROWSER','MCP','INSTALLED_MCP'));
