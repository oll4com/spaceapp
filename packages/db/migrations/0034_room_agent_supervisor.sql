CREATE TABLE IF NOT EXISTS room_agent_bindings (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text UNIQUE NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_agent_requests (
  request_id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  client_request_id text NOT NULL,
  prompt_message_id text NOT NULL REFERENCES space_agent_messages(message_id) ON DELETE CASCADE,
  response_message_id text NOT NULL REFERENCES space_agent_messages(message_id) ON DELETE CASCADE,
  turn_payload jsonb,
  signaled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_room_agent_requests_room_created
  ON room_agent_requests(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_agent_missions (
  mission_id text PRIMARY KEY,
  request_id text UNIQUE NOT NULL REFERENCES room_agent_requests(request_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES space_agent_sessions(session_id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED')),
  current_pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  status_reason text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_agent_missions_room_status
  ON room_agent_missions(room_id, status, queued_at ASC);

CREATE TABLE IF NOT EXISTS room_agent_actions (
  action_id text PRIMARY KEY,
  mission_id text NOT NULL REFERENCES room_agent_missions(mission_id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE NOT NULL,
  action_type text NOT NULL CHECK (
    action_type IN ('INSPECT', 'ORCHESTRATE', 'SEND', 'INTERRUPT', 'RESTART', 'CREATE_PANE', 'CLOSE_PANE', 'REOPEN_PANE')
  ),
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED')),
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  status_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_room_agent_actions_mission_created
  ON room_agent_actions(mission_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_room_agent_actions_room_status
  ON room_agent_actions(room_id, status, created_at ASC);
