-- Security Copilot pane (clipboard PLAN clipboard:8ce8_URHW9Dk, operator request 2026-10-24): pane settings on the new
-- SECURITY_COPILOT mode (NULL reads as the defaults); the fleet's hosts with their latest inventory; findings (an advisory that
-- applies to a host, with the structured advisory fields only); the action log every root change goes through (the gate's
-- audit, never deleted, no cascade from hosts); the copilot's own memory, separate from Space Memory; one feed per pane
-- (briefs, questions, reviews, timeline); and the SECURITY_COPILOT notification source.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS security_copilot_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_security_copilot_metadata_object
  CHECK (security_copilot_metadata IS NULL OR (jsonb_typeof(security_copilot_metadata) = 'object' AND security_copilot_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS security_copilot_hosts (
  id text PRIMARY KEY CHECK (id ~ '^sechost:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 63),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  reach text NOT NULL CHECK (reach IN ('LOCAL','SSH','PVE_SHELL','QM_GUEST_EXEC','PCT_EXEC','NONE')),
  os_family text NOT NULL CHECK (os_family IN ('DEBIAN','UBUNTU','ALMALINUX','PROXMOX','OPENWRT','WINDOWS','MACOS','UNKNOWN')),
  os_version text NOT NULL DEFAULT '' CHECK (char_length(os_version) <= 40),
  kernel text NOT NULL DEFAULT '' CHECK (char_length(kernel) <= 80),
  status text NOT NULL CHECK (status IN ('ACTIVE','STOPPED','UNREACHABLE')),
  inventory jsonb CHECK (inventory IS NULL OR jsonb_typeof(inventory) = 'object'),
  inventory_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, alias)
);

CREATE TABLE IF NOT EXISTS security_copilot_findings (
  id text PRIMARY KEY CHECK (id ~ '^secfind:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id text NOT NULL REFERENCES security_copilot_hosts(id),
  advisory_id text NOT NULL CHECK (char_length(advisory_id) BETWEEN 3 AND 120),
  advisory jsonb NOT NULL CHECK (jsonb_typeof(advisory) = 'object'),
  package text NOT NULL CHECK (char_length(package) BETWEEN 1 AND 200),
  installed_version text NOT NULL CHECK (char_length(installed_version) <= 120),
  fixed_version text CHECK (fixed_version IS NULL OR char_length(fixed_version) <= 120),
  priority text NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  status text NOT NULL CHECK (status IN ('NEW','TRIAGING','FIXING','FIXED','MITIGATED','NOT_AFFECTED','ACCEPTED','FAILED')),
  confirmed_by text CHECK (confirmed_by IS NULL OR char_length(confirmed_by) <= 500),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (owner_user_id, host_id, advisory_id, package)
);
CREATE INDEX IF NOT EXISTS security_copilot_findings_open_idx ON security_copilot_findings(owner_user_id, priority, last_seen_at DESC)
  WHERE status IN ('NEW','TRIAGING','FIXING','FAILED');

CREATE TABLE IF NOT EXISTS security_copilot_actions (
  id text PRIMARY KEY CHECK (id ~ '^secact:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL CHECK (pane_id ~ '^pane:[A-Za-z0-9_-]{6,80}$'),
  host_id text CHECK (host_id IS NULL OR host_id ~ '^sechost:[A-Za-z0-9_-]{6,80}$'),
  finding_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(finding_ids) <= 50),
  kind text NOT NULL CHECK (kind IN ('PACKAGE_UPGRADE','SERVICE_RESTART','CONFIG_CHANGE','WAF_RULE','CONTAINER_UPDATE','CODE_FIX',
    'HOST_REBOOT','SESSION_ENDING_RESTART','DATA_DELETE','OTHER')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  commands text NOT NULL CHECK (char_length(commands) BETWEEN 1 AND 4000),
  backup text NOT NULL DEFAULT '' CHECK (char_length(backup) <= 1000),
  rollback text NOT NULL DEFAULT '' CHECK (char_length(rollback) <= 2000),
  gate text NOT NULL CHECK (gate IN ('GO','ASK')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  status text NOT NULL CHECK (status IN ('RUNNING','ASKED','APPROVED','DECLINED','VERIFIED','FAILED','ROLLED_BACK')),
  verification text CHECK (verification IS NULL OR char_length(verification) <= 4000),
  review_event_id text CHECK (review_event_id IS NULL OR review_event_id ~ '^secevt:[A-Za-z0-9_-]{6,80}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS security_copilot_actions_owner_idx ON security_copilot_actions(owner_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS security_copilot_actions_host_idx ON security_copilot_actions(owner_user_id, host_id, started_at DESC);

CREATE TABLE IF NOT EXISTS security_copilot_memory (
  id text PRIMARY KEY CHECK (id ~ '^secmem:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('HOST','RULE','FACT','LESSON','EXCEPTION','PLAYBOOK','PREFERENCE')),
  key text CHECK (key IS NULL OR char_length(key) BETWEEN 1 AND 300),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  host_id text CHECK (host_id IS NULL OR host_id ~ '^sechost:[A-Za-z0-9_-]{6,80}$'),
  tags text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(tags) <= 20),
  source text NOT NULL CHECK (source IN ('USER','AGENT')),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  pinned boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scope text GENERATED ALWAYS AS (coalesce(host_id, '')) STORED,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(key, '') || ' ' || text)) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS security_copilot_memory_owner_key_idx ON security_copilot_memory(owner_user_id, kind, key, scope) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_copilot_memory_owner_idx ON security_copilot_memory(owner_user_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS security_copilot_memory_search_idx ON security_copilot_memory USING GIN (search);

CREATE TABLE IF NOT EXISTS security_copilot_events (
  id text PRIMARY KEY CHECK (id ~ '^secevt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('BRIEF','QUESTION','REVIEW','ANSWERED','REVIEWED','BRIEF_DONE','BRIEF_FAILED','FINDINGS','ACTION','NOTE','DIGEST',
    'SETTINGS_CHANGED','RUN_STARTED','RUN_PAUSED','RUN_STOPPED')),
  status text,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'BRIEF' AND status IN ('PENDING','TAKEN','DONE','FAILED'))
    OR (type = 'QUESTION' AND status IN ('OPEN','ANSWERED'))
    OR (type = 'REVIEW' AND status IN ('OPEN','APPROVED','DECLINED'))
    OR (type NOT IN ('BRIEF','QUESTION','REVIEW') AND status IS NULL))
);
CREATE INDEX IF NOT EXISTS security_copilot_events_pane_idx ON security_copilot_events(owner_user_id, pane_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_copilot_events_open_idx ON security_copilot_events(pane_id, created_at) WHERE status IN ('PENDING','TAKEN','OPEN');

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'APP_STUDIO', 'VIDEO', 'SECURITY_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
