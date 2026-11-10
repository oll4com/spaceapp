-- Many saved signatures per owner (operator 6/11 01:15 BKK «να αποθηκεύω μια ή περισσότερες υπογραφές», nous_msg:781819c5ba0440fbbee8682c).
-- Class A: a signature goes only by the owner's explicit delete. One default per owner; its Agent File copy (Agent Files › Signatures) is artifact_id.
CREATE TABLE IF NOT EXISTS saved_signatures (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  label text NOT NULL,
  png bytea NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  artifact_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_signatures_one_default ON saved_signatures (owner_user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS saved_signatures_owner ON saved_signatures (owner_user_id, created_at);
-- The one signature stored so far becomes the first saved one and the default. owner_signatures keeps its PNG as it was (and the phone).
INSERT INTO saved_signatures (id, owner_user_id, label, png, width, height, is_default, created_at, updated_at)
SELECT 'sig:' || substr(md5(owner_user_id), 1, 16), owner_user_id, 'Signature', png, width, height, true, updated_at, updated_at
FROM owner_signatures WHERE png IS NOT NULL
ON CONFLICT (id) DO NOTHING;
