-- Appointments (operator 2/11 15:22 BKK, brief nous/briefs/20261102-appointments-pane.md): the operator's calls, interviews, webinars and
-- deadlines, reminded before each one (Settings → Notifications → Appointment reminders). Class A: cancelling is a status, never a delete.
CREATE TABLE IF NOT EXISTS appointments (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  time_zone text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CALL', 'INTERVIEW', 'WEBINAR', 'DEADLINE', 'OTHER')),
  location text,
  notes text,
  source_ref text,
  status text NOT NULL DEFAULT 'UPCOMING' CHECK (status IN ('UPCOMING', 'DONE', 'CANCELLED')),
  reminders_sent integer[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS appointments_owner_starts ON appointments (owner_user_id, starts_at);
-- One appointment per source (a mail thread, a task): an interview mail read again updates its appointment.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_owner_source ON appointments (owner_user_id, source_ref) WHERE source_ref IS NOT NULL;
