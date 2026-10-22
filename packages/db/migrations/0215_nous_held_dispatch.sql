-- Nous's held dispatch (plan clipboard:VZEewZRaodZR R2): one queue per pane of texts held for a calm server.
ALTER TABLE space_control_records DROP CONSTRAINT IF EXISTS space_control_records_kind_check;
ALTER TABLE space_control_records ADD CONSTRAINT space_control_records_kind_check
  CHECK (kind IN ('operation','layout','snapshot','schedule','grant','pane_state','watch','audit','settings_snapshot','release_train','nous_held'));
