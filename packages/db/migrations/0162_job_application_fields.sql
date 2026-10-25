-- Every filled control of every application step (never passwords or codes; file fields keep the
-- file name), so a submission always has its form snapshot and repeated questions auto-fill.
CREATE TABLE IF NOT EXISTS job_application_fields (
  id text PRIMARY KEY CHECK (id ~ '^jobfield:[A-Za-z0-9_-]{6,80}$'),
  application_id text NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_index integer NOT NULL DEFAULT 0 CHECK (step_index BETWEEN 0 AND 50),
  step_title text CHECK (step_title IS NULL OR char_length(step_title) BETWEEN 1 AND 200),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 300),
  field_type text NOT NULL CHECK (field_type IN ('text','select','radio','checkbox','file','textarea','date')),
  ref_hint text CHECK (ref_hint IS NULL OR char_length(ref_hint) BETWEEN 1 AND 200),
  value text CHECK (value IS NULL OR char_length(value) <= 4000),
  source text NOT NULL CHECK (source IN ('PROFILE','CV','USER','AGENT')),
  filled_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, step_index, label)
);
CREATE INDEX IF NOT EXISTS job_application_fields_owner_idx ON job_application_fields(owner_user_id, application_id, step_index);
