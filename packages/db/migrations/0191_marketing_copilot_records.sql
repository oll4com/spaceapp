-- Marketing Copilot storage: campaigns, the posts the copilot drafts and publishes (with their review state and
-- publication evidence), its own memory, the activity feed (operator briefs double as work items), one active
-- run per pane, and the rules under which RULES autonomy may publish alone.
CREATE TABLE IF NOT EXISTS marketing_copilot_campaigns (
  id text PRIMARY KEY CHECK (id ~ '^mktcamp:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  goal text CHECK (goal IS NULL OR char_length(goal) <= 2000),
  channels text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(channels) <= 9),
  status text NOT NULL CHECK (status IN ('PROPOSED','ACTIVE','DONE','CANCELLED')),
  starts_at timestamptz,
  ends_at timestamptz,
  proposed_by text NOT NULL CHECK (proposed_by IN ('AGENT','USER','RELEASE')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_copilot_campaigns_owner_idx ON marketing_copilot_campaigns(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing_copilot_posts (
  id text PRIMARY KEY CHECK (id ~ '^mktpost:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  campaign_id text REFERENCES marketing_copilot_campaigns(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('X','LINKEDIN','REDDIT','HACKER_NEWS','PRODUCT_HUNT','DEVTO','BLOG','YOUTUBE','GITHUB')),
  kind text NOT NULL CHECK (kind IN ('POST','THREAD','ARTICLE','VIDEO','LAUNCH','REPLY','RELEASE_NOTE')),
  target text CHECK (target IS NULL OR char_length(target) BETWEEN 1 AND 300),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 300),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 40000),
  assets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assets) = 'array'),
  status text NOT NULL CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','PUBLISHING','PUBLISHED','FAILED','REJECTED')),
  scheduled_at timestamptz,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  rule_id text,
  published_url text CHECK (published_url IS NULL OR char_length(published_url) <= 2000),
  published_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_copilot_posts_owner_idx ON marketing_copilot_posts(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS marketing_copilot_posts_due_idx ON marketing_copilot_posts(owner_user_id, scheduled_at) WHERE status = 'APPROVED';
CREATE INDEX IF NOT EXISTS marketing_copilot_posts_published_idx ON marketing_copilot_posts(owner_user_id, channel, published_at DESC) WHERE status IN ('PUBLISHING','PUBLISHED');

CREATE TABLE IF NOT EXISTS marketing_copilot_memory (
  id text PRIMARY KEY CHECK (id ~ '^mktmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('BRAND_VOICE','FACT','AUDIENCE','CHANNEL_RULE','TEMPLATE','LESSON','PREFERENCE')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  channel text CHECK (channel IS NULL OR channel IN ('X','LINKEDIN','REDDIT','HACKER_NEWS','PRODUCT_HUNT','DEVTO','BLOG','YOUTUBE','GITHUB')),
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
CREATE UNIQUE INDEX IF NOT EXISTS marketing_copilot_memory_owner_key_idx ON marketing_copilot_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_copilot_memory_owner_idx ON marketing_copilot_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS marketing_copilot_memory_search_idx ON marketing_copilot_memory USING GIN (search);

CREATE TABLE IF NOT EXISTS marketing_copilot_events (
  id text PRIMARY KEY CHECK (id ~ '^mktevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  run_id text CHECK (run_id IS NULL OR run_id ~ '^mktrun:[A-Za-z0-9_-]{6,80}$'),
  post_id text CHECK (post_id IS NULL OR post_id ~ '^mktpost:[A-Za-z0-9_-]{6,80}$'),
  campaign_id text CHECK (campaign_id IS NULL OR campaign_id ~ '^mktcamp:[A-Za-z0-9_-]{6,80}$'),
  type text NOT NULL CHECK (type IN ('BRIEF','POST_DRAFTED','REVIEW_REQUESTED','REVIEW_DECIDED','PUBLISHING','PUBLISHED','PUBLISH_FAILED',
    'QUESTION','ANSWERED','NEEDS_USER','CAMPAIGN_PROPOSED','CAMPAIGN_DECIDED','RULE_PROPOSED','RULE_DECIDED','RULE_APPLIED',
    'METRICS','NOTE','RUN_STARTED','RUN_PAUSED','RUN_RESUMED','RUN_STOPPED')),
  status text CHECK (status IS NULL OR status IN ('PENDING','TAKEN','DONE')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_copilot_events_owner_idx ON marketing_copilot_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_copilot_events_pending_idx ON marketing_copilot_events(owner_user_id, created_at) WHERE status IN ('PENDING','TAKEN');

CREATE TABLE IF NOT EXISTS marketing_copilot_runs (
  id text PRIMARY KEY CHECK (id ~ '^mktrun:[A-Za-z0-9_-]{6,80}$'),
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
CREATE UNIQUE INDEX IF NOT EXISTS marketing_copilot_runs_active_pane_idx ON marketing_copilot_runs(pane_id) WHERE status IN ('RUNNING','PAUSED');

CREATE TABLE IF NOT EXISTS marketing_copilot_rules (
  id text PRIMARY KEY CHECK (id ~ '^mktrule:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  channel text NOT NULL CHECK (channel IN ('X','LINKEDIN','REDDIT','HACKER_NEWS','PRODUCT_HUNT','DEVTO','BLOG','YOUTUBE','GITHUB')),
  kinds text[] NOT NULL DEFAULT '{}'::text[],
  campaign_id text,
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','RETIRED')),
  evidence text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(evidence) <= 20),
  proposed_by text NOT NULL CHECK (proposed_by IN ('AGENT','USER')),
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  last_applied_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_copilot_rules_owner_idx ON marketing_copilot_rules(owner_user_id, status);
