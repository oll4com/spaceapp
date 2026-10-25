-- Freelance Copilot (clipboard PLAN clipboard:EFWug5E7pVln): pane settings and view; leads found on freelance
-- platforms, the proposals and messages exchanged with clients (review state and sending evidence), each
-- platform account's registration state, the copilot's memory, its activity feed (operator briefs and new mails
-- are the agent's work items), one active run per pane, the rules RULES autonomy sends under, the owner's IMAP
-- mailbox (password sealed by the API) and the FREELANCE_COPILOT notification source.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS freelance_copilot_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_freelance_copilot_metadata_object
  CHECK (freelance_copilot_metadata IS NULL OR (jsonb_typeof(freelance_copilot_metadata) = 'object'
    AND freelance_copilot_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS freelance_copilot_leads (
  id text PRIMARY KEY CHECK (id ~ '^fllead:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  channel text NOT NULL CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST')),
  url text CHECK (url IS NULL OR char_length(url) <= 2000),
  external_id text CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  client text CHECK (client IS NULL OR char_length(client) <= 300),
  description text CHECK (description IS NULL OR char_length(description) <= 20000),
  budget text CHECK (budget IS NULL OR char_length(budget) <= 200),
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('NEW','QUALIFIED','SKIPPED','PROPOSED','TALKING','CLIENT_READY','WON','LOST')),
  next_action_at timestamptz,
  contract_value numeric CHECK (contract_value IS NULL OR contract_value >= 0),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freelance_copilot_leads_owner_idx ON freelance_copilot_leads(owner_user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS freelance_copilot_leads_external_idx ON freelance_copilot_leads(owner_user_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS freelance_copilot_leads_due_idx ON freelance_copilot_leads(owner_user_id, next_action_at) WHERE next_action_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS freelance_copilot_messages (
  id text PRIMARY KEY CHECK (id ~ '^flmsg:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  lead_id text NOT NULL REFERENCES freelance_copilot_leads(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST')),
  direction text NOT NULL CHECK (direction IN ('OUT','IN')),
  kind text NOT NULL CHECK (kind IN ('PROPOSAL','MESSAGE','FOLLOW_UP','APPLICATION')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  bid jsonb CHECK (bid IS NULL OR jsonb_typeof(bid) = 'object'),
  connects integer CHECK (connects IS NULL OR connects BETWEEN 0 AND 1000),
  status text NOT NULL CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','SENDING','SENT','FAILED','REJECTED','RECEIVED')),
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  rule_id text,
  sent_url text CHECK (sent_url IS NULL OR char_length(sent_url) <= 2000),
  sent_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freelance_copilot_messages_lead_idx ON freelance_copilot_messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS freelance_copilot_messages_owner_idx ON freelance_copilot_messages(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS freelance_copilot_messages_sent_idx ON freelance_copilot_messages(owner_user_id, channel, sent_at DESC) WHERE status IN ('SENDING','SENT');

CREATE TABLE IF NOT EXISTS freelance_copilot_accounts (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST')),
  status text NOT NULL CHECK (status IN ('NOT_STARTED','IN_PROGRESS','NEEDS_OPERATOR','ACTIVE','BLOCKED')),
  email text CHECK (email IS NULL OR char_length(email) <= 200),
  profile_url text CHECK (profile_url IS NULL OR char_length(profile_url) <= 2000),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, channel)
);

CREATE TABLE IF NOT EXISTS freelance_copilot_memory (
  id text PRIMARY KEY CHECK (id ~ '^flmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('PROFILE','FACT','CASE_STUDY','PRICING','CHANNEL_RULE','TEMPLATE','LESSON','PREFERENCE','CLIENT')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  channel text CHECK (channel IS NULL OR channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST')),
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 20),
  source text NOT NULL CHECK (source IN ('USER','AGENT','LEARNED')),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  pinned boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scope text GENERATED ALWAYS AS (coalesce(channel, '')) STORED,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(key, '') || ' ' || text)) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS freelance_copilot_memory_owner_key_idx ON freelance_copilot_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS freelance_copilot_memory_owner_idx ON freelance_copilot_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS freelance_copilot_memory_search_idx ON freelance_copilot_memory USING GIN (search);

CREATE TABLE IF NOT EXISTS freelance_copilot_events (
  id text PRIMARY KEY CHECK (id ~ '^flevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  run_id text CHECK (run_id IS NULL OR run_id ~ '^flrun:[A-Za-z0-9_-]{6,80}$'),
  lead_id text CHECK (lead_id IS NULL OR lead_id ~ '^fllead:[A-Za-z0-9_-]{6,80}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^flmsg:[A-Za-z0-9_-]{6,80}$'),
  type text NOT NULL CHECK (type IN ('BRIEF','MAIL','LEAD_ADDED','LEAD_UPDATED','MESSAGE_DRAFTED','MESSAGE_RECEIVED','REVIEW_REQUESTED','REVIEW_DECIDED',
    'SENDING','SENT','SEND_FAILED','CLIENT_READY','LEAD_DECIDED','ACCOUNT_UPDATED','QUESTION','ANSWERED','NEEDS_USER','RULE_PROPOSED','RULE_DECIDED',
    'RULE_APPLIED','DIGEST','NOTE','RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED')),
  status text CHECK (status IS NULL OR status IN ('PENDING','TAKEN','DONE')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freelance_copilot_events_owner_idx ON freelance_copilot_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS freelance_copilot_events_pending_idx ON freelance_copilot_events(owner_user_id, created_at) WHERE status IN ('PENDING','TAKEN');

CREATE TABLE IF NOT EXISTS freelance_copilot_runs (
  id text PRIMARY KEY CHECK (id ~ '^flrun:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','PAUSED','STOPPED')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object'),
  kickoff_sent_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS freelance_copilot_runs_active_pane_idx ON freelance_copilot_runs(pane_id) WHERE status IN ('RUNNING','PAUSED');

CREATE TABLE IF NOT EXISTS freelance_copilot_rules (
  id text PRIMARY KEY CHECK (id ~ '^flrule:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  channel text NOT NULL CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST')),
  kinds text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','RETIRED')),
  evidence text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(evidence) <= 20),
  proposed_by text NOT NULL CHECK (proposed_by IN ('AGENT','USER')),
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  last_applied_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freelance_copilot_rules_owner_idx ON freelance_copilot_rules(owner_user_id, status);

-- One IMAP mailbox per owner (work@example.invalid); the password is sealed by the API and never leaves the server.
-- last_uid: the newest message the scheduler turned into a work item.
CREATE TABLE IF NOT EXISTS freelance_copilot_mailboxes (
  owner_user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  password_sealed text NOT NULL,
  last_uid bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
