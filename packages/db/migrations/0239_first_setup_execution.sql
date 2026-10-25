-- Versioned first-run execution state. One small bounded owner document permits
-- atomic compare-and-swap of draft, plan, run, task and receipt revisions.
-- The application validates the complete strict document before each write.
CREATE TABLE IF NOT EXISTS space_first_setup_states (
  owner_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT space_first_setup_states_revision_matches_payload
    CHECK ((payload->>'revision')::integer = revision),
  CONSTRAINT space_first_setup_states_bounded_payload
    CHECK (octet_length(payload::text) <= 2097152)
);
CREATE INDEX IF NOT EXISTS space_first_setup_states_updated_idx
  ON space_first_setup_states (updated_at DESC);
