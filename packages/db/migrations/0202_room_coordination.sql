-- Room Agent coordination (2026-10-15): the monitor reports panes whose work overlaps, and every product has one
-- live release train that the panes join (a space_control_records row per product).
ALTER TABLE room_agent_events DROP CONSTRAINT IF EXISTS room_agent_events_kind_check;
ALTER TABLE room_agent_events ADD CONSTRAINT room_agent_events_kind_check
  CHECK (kind IN ('FINISHED', 'WAITING', 'ERROR', 'USAGE_LIMIT', 'SIGN_IN', 'STUCK', 'OVERLAP'));
ALTER TABLE space_control_records DROP CONSTRAINT IF EXISTS space_control_records_kind_check;
ALTER TABLE space_control_records ADD CONSTRAINT space_control_records_kind_check
  CHECK (kind IN ('operation','layout','snapshot','schedule','grant','pane_state','watch','audit','settings_snapshot','release_train'));
