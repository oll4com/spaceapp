-- Job Applications tracker. VERIFIED needs evidence (confirmation page artifact and/or confirmation email);
-- a filled form is never counted as applied.
CREATE TABLE IF NOT EXISTS job_applications (
  id text PRIMARY KEY CHECK (id ~ '^jobapp:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  company text NOT NULL CHECK (char_length(company) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (char_length(role) BETWEEN 1 AND 300),
  ats text NOT NULL CHECK (ats IN ('linkedin','greenhouse','ashby','lever','workday','indeed','other')),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (status IN ('QUEUED','FILLING','NEEDS_USER','SUBMITTED','VERIFIED','FAILED')),
  evidence_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_artifact_ids) = 'array'),
  external_confirmation text CHECK (external_confirmation IS NULL OR char_length(external_confirmation) <= 500),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, url)
);
CREATE INDEX IF NOT EXISTS job_applications_owner_status_idx ON job_applications(owner_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS job_applications_owner_ats_applied_idx ON job_applications(owner_user_id, ats, applied_at DESC);
