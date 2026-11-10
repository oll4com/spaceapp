-- The operator's hand signature and the signature requests agents raise (operator 4/11 18:38 BKK, plan clipboard:2qSLIT_csvPm).
-- Class A: the stored signature goes only by the owner's explicit delete; a request is cancelled by status, never deleted.
CREATE TABLE IF NOT EXISTS owner_signatures (
  owner_user_id text PRIMARY KEY,
  -- The drawn signature (null until drawn) and the phone a PHONE field of a signing starts with.
  png bytea,
  width integer,
  height integer,
  phone text,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS signature_requests (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  artifact_id text NOT NULL,
  title text NOT NULL,
  note text,
  placements jsonb NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  room_id text,
  pane_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SIGNED', 'CANCELLED')),
  signed_artifact_id text,
  signed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS signature_requests_owner_status ON signature_requests (owner_user_id, status, created_at DESC);
