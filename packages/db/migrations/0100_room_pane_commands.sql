-- A claim is never committed without the complete pane batch response.
CREATE TABLE room_pane_commands (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, actor_id, request_id),
  CHECK (jsonb_typeof(result) = 'array')
);
