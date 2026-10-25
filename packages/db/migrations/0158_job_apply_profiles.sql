-- Job Applications pane: one candidate profile per owner. The mailbox password is sealed by the API
-- (AES-256-GCM) and never leaves it; the CV text is the extracted attachment used to answer forms.
CREATE TABLE IF NOT EXISTS job_apply_profiles (
  owner_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  candidate jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candidate) = 'object'),
  qa_bank jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qa_bank) = 'array'),
  cv_artifact_id text,
  cover_letter_artifact_id text,
  cv_text text CHECK (cv_text IS NULL OR char_length(cv_text) <= 200000),
  mailbox jsonb CHECK (mailbox IS NULL OR jsonb_typeof(mailbox) = 'object'),
  mailbox_password_encrypted text CHECK (mailbox_password_encrypted IS NULL OR char_length(mailbox_password_encrypted) BETWEEN 20 AND 8000),
  mailbox_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
