ALTER TABLE room_agent_actions DROP CONSTRAINT IF EXISTS room_agent_actions_action_type_check;
ALTER TABLE room_agent_actions ADD CONSTRAINT room_agent_actions_action_type_check CHECK (
  action_type IN ('INSPECT', 'ORCHESTRATE', 'SEND', 'INTERRUPT', 'RESTART', 'CREATE_PANE',
    'CLOSE_PANE', 'REOPEN_PANE', 'CATALOG', 'FIND', 'CONFIGURE_PANE', 'LAYOUT', 'CLI_COMMAND',
    'START', 'RESUME', 'OPEN_TYPES')
);
