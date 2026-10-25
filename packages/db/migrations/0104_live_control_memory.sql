ALTER TABLE space_control_records DROP CONSTRAINT IF EXISTS space_control_records_kind_check;
ALTER TABLE space_control_records ADD CONSTRAINT space_control_records_kind_check
  CHECK (kind IN ('operation','layout','snapshot','schedule','grant','pane_state','watch','audit','settings_snapshot'));

CREATE TABLE live_personal_memory (
  owner_user_id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE live_personal_memory_changes (
  owner_user_id text NOT NULL REFERENCES live_personal_memory(owner_user_id) ON DELETE CASCADE,
  revision integer NOT NULL,
  change jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, revision)
);
