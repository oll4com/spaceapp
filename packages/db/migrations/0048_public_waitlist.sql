CREATE TABLE IF NOT EXISTS public_waitlist_signups (
  email text PRIMARY KEY,
  consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (source IN ('HOMEPAGE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT public_waitlist_signups_email_length_check
    CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT public_waitlist_signups_email_normalization_check
    CHECK (email = lower(btrim(email)))
);
