-- Mail Copilot learns from what the operator does to mail, per Gmail account: one row per action (archive, trash,
-- move to a label, star, spam, reply…) seen in the pane, in Gmail's history (web, phone) or inferred from the
-- mailbox at the start. The copilot's own writes and Job Copilot's are recorded too, so history does not count them twice.
CREATE TABLE IF NOT EXISTS mail_copilot_actions (
  id text PRIMARY KEY CHECK (id ~ '^mailact:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_email text NOT NULL CHECK (char_length(account_email) BETWEEN 3 AND 320),
  thread_id text NOT NULL CHECK (char_length(thread_id) BETWEEN 1 AND 200),
  message_id text CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('ARCHIVE','UNARCHIVE','TRASH','UNTRASH','DELETE','MOVE','LABEL','UNLABEL','STAR','UNSTAR','SPAM','NOT_SPAM','REPLY','FORWARD')),
  label_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(label_ids) <= 20),
  from_address text CHECK (from_address IS NULL OR char_length(from_address) <= 320),
  from_domain text CHECK (from_domain IS NULL OR char_length(from_domain) <= 200),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 1000),
  subject_key text CHECK (subject_key IS NULL OR char_length(subject_key) <= 200),
  actor text NOT NULL CHECK (actor IN ('OPERATOR','AGENT','SPACE')),
  source text NOT NULL CHECK (source IN ('PANE','GMAIL','BACKFILL','SPACE')),
  rule_id text CHECK (rule_id IS NULL OR char_length(rule_id) <= 100),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_copilot_actions_sender_idx ON mail_copilot_actions(owner_user_id, account_email, from_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS mail_copilot_actions_domain_idx ON mail_copilot_actions(owner_user_id, account_email, from_domain, occurred_at DESC);
CREATE INDEX IF NOT EXISTS mail_copilot_actions_thread_idx ON mail_copilot_actions(owner_user_id, account_email, thread_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS mail_copilot_actions_owner_idx ON mail_copilot_actions(owner_user_id, occurred_at DESC);

-- The first look at an account's mailbox (the last 30 days) runs in budgeted steps.
ALTER TABLE mail_copilot_sync ADD COLUMN IF NOT EXISTS backfill_page_token text CHECK (backfill_page_token IS NULL OR char_length(backfill_page_token) <= 4000);
ALTER TABLE mail_copilot_sync ADD COLUMN IF NOT EXISTS backfill_done_at timestamptz;

-- Rules the server learns from consistent operator actions, and their lifecycle in the activity feed.
ALTER TABLE mail_copilot_rules DROP CONSTRAINT IF EXISTS mail_copilot_rules_proposed_by_check;
ALTER TABLE mail_copilot_rules ADD CONSTRAINT mail_copilot_rules_proposed_by_check CHECK (proposed_by IN ('AGENT','USER','LEARNED'));
ALTER TABLE mail_copilot_events DROP CONSTRAINT IF EXISTS mail_copilot_events_type_check;
ALTER TABLE mail_copilot_events ADD CONSTRAINT mail_copilot_events_type_check CHECK (type IN ('MAIL_RECEIVED','USER_ACTION','TRIAGED','DRAFTED','REPLIED','SENT','ARCHIVED','TRASHED','LABELED','STARRED','SKIPPED',
  'NEEDS_USER','QUESTION','ANSWERED','REVIEW_REQUESTED','REVIEW_DECIDED','RULE_PROPOSED','RULE_DECIDED','RULE_APPLIED','SYNC_RESET','NOTE',
  'RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED','RUN_FINISHED','TRIAGE','RULE_LEARNED','RULE_RETIRED'));
