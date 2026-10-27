-- Nous's follow-ups (plan clipboard:8s0ZNiO3q5ZT S3): a reminder back into its inbox when a time comes, a merge-queue
-- ticket ends (DEPLOYED, FAILED, CONFLICT or CANCELLED) or a pane finishes its turn. Rows are never deleted: the status,
-- outcome and times are the audit of what Nous asked to be reminded of and what fired it.
CREATE TABLE IF NOT EXISTS nous_followups (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('TIME', 'TICKET', 'PANE')),
  due_at timestamptz,
  ticket_id text,
  pane_id text,
  pane_label text,
  status text NOT NULL CHECK (status IN ('OPEN', 'FIRED', 'CANCELLED')),
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS nous_followups_owner_status_idx ON nous_followups (owner_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS nous_followups_open_idx ON nous_followups (status, trigger_kind) WHERE status = 'OPEN';
