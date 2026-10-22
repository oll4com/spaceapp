-- Keep a durable receipt before dispatching a browser's local composer draft.
-- Incomplete receipts are never replayed after an API or CLI host restart.
ALTER TABLE space_control_records DROP CONSTRAINT IF EXISTS space_control_records_kind_check;
ALTER TABLE space_control_records ADD CONSTRAINT space_control_records_kind_check
  CHECK (kind IN ('operation','layout','snapshot','schedule','grant','pane_state','watch','audit','settings_snapshot','release_train','nous_held','cli_composer_submission'));
