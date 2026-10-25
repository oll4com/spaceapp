CREATE TABLE IF NOT EXISTS event_relay_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

INSERT INTO event_relay_state (singleton, last_sequence)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS relay_sequence bigint;

LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;

UPDATE event_relay_state
SET last_sequence = GREATEST(
  last_sequence,
  COALESCE((SELECT max(relay_sequence) FROM events), 0)
)
WHERE singleton = true;

WITH sequence_base AS (
  SELECT last_sequence
  FROM event_relay_state
  WHERE singleton = true
), ordered_events AS (
  SELECT
    events.id,
    sequence_base.last_sequence + row_number() OVER (ORDER BY events.created_at, events.id) AS relay_sequence
  FROM events
  CROSS JOIN sequence_base
  WHERE events.relay_sequence IS NULL
)
UPDATE events
SET relay_sequence = ordered_events.relay_sequence
FROM ordered_events
WHERE events.id = ordered_events.id;

UPDATE event_relay_state
SET last_sequence = COALESCE((SELECT max(relay_sequence) FROM events), 0)
WHERE singleton = true;

CREATE OR REPLACE FUNCTION assign_event_relay_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE event_relay_state
  SET last_sequence = last_sequence + 1
  WHERE singleton = true
  RETURNING last_sequence INTO NEW.relay_sequence;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_event_relay_sequence ON events;
CREATE TRIGGER set_event_relay_sequence
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION assign_event_relay_sequence();

ALTER TABLE events
  ALTER COLUMN relay_sequence SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_relay_sequence
  ON events (relay_sequence);

CREATE INDEX IF NOT EXISTS idx_events_created_at_id
  ON events (created_at, id);
