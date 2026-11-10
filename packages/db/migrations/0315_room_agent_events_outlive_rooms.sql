-- Nous upgrade 2026-W46 step 1 (weekly audit 9/11): a deleted room no longer takes its monitor events with it, so the scorecard's
-- unblocking still sees the week's waits (W46: about 188 waits reached Nous, the scorecard found none in the 2 rooms still open).
-- Events keep their owner; the class-B 30-day prune (pruneEvents) still removes them.
ALTER TABLE room_agent_events ADD COLUMN IF NOT EXISTS owner_user_id text;
UPDATE room_agent_events e SET owner_user_id = r.owner_user_id FROM rooms r WHERE r.id = e.room_id AND e.owner_user_id IS NULL;
ALTER TABLE room_agent_events DROP CONSTRAINT IF EXISTS room_agent_events_room_id_fkey;
CREATE INDEX IF NOT EXISTS room_agent_events_owner_created_idx ON room_agent_events (owner_user_id, created_at DESC);

-- A wait still open when its room is deleted ends there, not at "now" forever.
CREATE OR REPLACE FUNCTION space_room_agent_events_room_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE room_agent_events SET status = 'RESOLVED', decision = COALESCE(decision, 'The room was deleted.'), updated_at = now()
    WHERE room_id = OLD.id AND status = 'OPEN';
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS room_agent_events_room_deleted ON rooms;
CREATE TRIGGER room_agent_events_room_deleted BEFORE DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION space_room_agent_events_room_deleted();
