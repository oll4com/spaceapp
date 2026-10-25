-- Nous's pane watch (operator request 2026-10-17, plan clipboard:MAongwnxq9Ro): when Nous last checked each pane, its verdict
-- and when it checks again, so no pane is forgotten. A closed pane's row stays as history; the lists show open panes only.
CREATE TABLE IF NOT EXISTS nous_pane_checks (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  room_id text NOT NULL,
  checked_at timestamptz NOT NULL,
  verdict text CHECK (verdict IN ('OK_WORKING', 'WAITING_OPERATOR', 'WAITING_DATE', 'NEEDS_ACTION', 'BLOCKED', 'OPERATOR_TEST')),
  note text,
  next_check_at timestamptz,
  PRIMARY KEY (owner_user_id, pane_id)
);
