-- Mail Copilot agent storage: the copilot's own memory (how the operator writes, who people are, reusable
-- replies, lessons), the activity feed doubling as its work queue, and one active run per pane.
CREATE TABLE IF NOT EXISTS mail_copilot_memory (
  id text PRIMARY KEY CHECK (id ~ '^mailmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('CONTACT','STYLE','TEMPLATE','FACT','LESSON','PREFERENCE')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  contact_email text CHECK (contact_email IS NULL OR char_length(contact_email) BETWEEN 3 AND 320),
  domain text CHECK (domain IS NULL OR char_length(domain) BETWEEN 1 AND 200),
  account_email text CHECK (account_email IS NULL OR char_length(account_email) BETWEEN 3 AND 320),
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 20),
  source text NOT NULL CHECK (source IN ('USER','AGENT','LEARNED')),
  confidence real NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  pinned boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scope text GENERATED ALWAYS AS (coalesce(contact_email, '') || '|' || coalesce(domain, '') || '|' || coalesce(account_email, '')) STORED,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(key, '') || ' ' || text || ' ' || coalesce(contact_email, '') || ' ' || coalesce(domain, ''))
  ) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_copilot_memory_owner_key_scope_idx ON mail_copilot_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_copilot_memory_owner_kind_idx ON mail_copilot_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS mail_copilot_memory_owner_contact_idx ON mail_copilot_memory(owner_user_id, lower(contact_email)) WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_copilot_memory_owner_domain_idx ON mail_copilot_memory(owner_user_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_copilot_memory_search_idx ON mail_copilot_memory USING GIN (search);

CREATE TABLE IF NOT EXISTS mail_copilot_events (
  id text PRIMARY KEY CHECK (id ~ '^mailevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  run_id text CHECK (run_id IS NULL OR run_id ~ '^mailrun:[A-Za-z0-9_-]{6,80}$'),
  account_email text CHECK (account_email IS NULL OR char_length(account_email) BETWEEN 3 AND 320),
  thread_id text CHECK (thread_id IS NULL OR char_length(thread_id) BETWEEN 1 AND 200),
  message_id text CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('MAIL_RECEIVED','USER_ACTION','TRIAGED','DRAFTED','REPLIED','SENT','ARCHIVED','TRASHED','LABELED','STARRED','SKIPPED',
    'NEEDS_USER','QUESTION','ANSWERED','REVIEW_REQUESTED','REVIEW_DECIDED','RULE_PROPOSED','RULE_DECIDED','RULE_APPLIED','SYNC_RESET','NOTE',
    'RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED','RUN_FINISHED','TRIAGE')),
  -- Work-item state for rows the agent handles (MAIL_RECEIVED, TRIAGE, USER_ACTION); null for plain activity.
  status text CHECK (status IS NULL OR status IN ('PENDING','TAKEN','DONE')),
  taken_by_pane_id text,
  taken_at timestamptz,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_copilot_events_received_idx ON mail_copilot_events(owner_user_id, account_email, message_id) WHERE type = 'MAIL_RECEIVED';
CREATE INDEX IF NOT EXISTS mail_copilot_events_owner_idx ON mail_copilot_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mail_copilot_events_pending_idx ON mail_copilot_events(owner_user_id, created_at) WHERE status IN ('PENDING','TAKEN');
CREATE INDEX IF NOT EXISTS mail_copilot_events_thread_idx ON mail_copilot_events(owner_user_id, account_email, thread_id) WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_copilot_runs (
  id text PRIMARY KEY CHECK (id ~ '^mailrun:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','PAUSED','STOPPED')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object'),
  current_event_id text,
  kickoff_sent_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  stopped_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_copilot_runs_active_pane_idx ON mail_copilot_runs(pane_id) WHERE status IN ('RUNNING','PAUSED');
CREATE INDEX IF NOT EXISTS mail_copilot_runs_owner_idx ON mail_copilot_runs(owner_user_id, created_at DESC);
