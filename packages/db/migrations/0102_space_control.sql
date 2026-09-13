CREATE TABLE space_control_records (
  kind text NOT NULL CHECK(kind IN ('operation','layout','snapshot','schedule','grant','pane_state')),
  actor_id text NOT NULL,
  record_key text NOT NULL,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(kind,actor_id,record_key)
);
CREATE INDEX space_control_records_room ON space_control_records(room_id,kind);

ALTER TABLE room_agent_actions DROP CONSTRAINT IF EXISTS room_agent_actions_action_type_check;
ALTER TABLE room_agent_actions ADD CONSTRAINT room_agent_actions_action_type_check CHECK (
  action_type IN ('INSPECT','ORCHESTRATE','SEND','INTERRUPT','RESTART','CREATE_PANE','CLOSE_PANE','REOPEN_PANE','CATALOG','FIND','CONFIGURE_PANE','LAYOUT','CLI_COMMAND','START','RESUME','OPEN_TYPES','CONTROL')
);
