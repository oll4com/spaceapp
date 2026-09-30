CREATE TABLE IF NOT EXISTS live_conversation_sessions (
  owner_user_id text NOT NULL,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, session_id)
);
CREATE TABLE IF NOT EXISTS live_conversation_rooms (
  owner_user_id text NOT NULL,
  room_id text NOT NULL,
  epoch integer NOT NULL DEFAULT 0,
  legacy_imported boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, room_id)
);
CREATE TABLE IF NOT EXISTS live_conversation_turns (
  owner_user_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  room_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  item jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, session_id, turn_id),
  FOREIGN KEY (owner_user_id, session_id) REFERENCES live_conversation_sessions(owner_user_id, session_id)
);
CREATE INDEX IF NOT EXISTS live_conversation_turns_room ON live_conversation_turns(owner_user_id, room_id, created_at DESC);
