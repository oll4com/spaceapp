-- Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw): bulk mail beside the Mail Copilot, per owner. Class A (explicit delete only):
-- senders, templates and their versions, lists, contacts, list members, suppressions, campaigns and the per-recipient send log (the
-- log is what stops a second mail). Class B: deliverability checks and the activity feed.
CREATE TABLE IF NOT EXISTS mail_campaign_senders (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address text NOT NULL,
  display_name text NOT NULL,
  domain text NOT NULL,
  config jsonb NOT NULL,
  reply_to text,
  footer_address text NOT NULL,
  status text NOT NULL CHECK (status IN ('SETUP', 'ACTIVE', 'PAUSED', 'DISABLED')),
  warmup jsonb NOT NULL,
  caps jsonb NOT NULL,
  bulk boolean NOT NULL,
  bulk_note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, address)
);

CREATE TABLE IF NOT EXISTS mail_campaign_templates (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  language text NOT NULL,
  current_version integer NOT NULL,
  pane_id text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_campaign_templates_owner ON mail_campaign_templates (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mail_campaign_template_versions (
  template_id text NOT NULL REFERENCES mail_campaign_templates(id) ON DELETE CASCADE,
  version integer NOT NULL,
  subject text NOT NULL,
  preheader text NOT NULL,
  html text NOT NULL,
  body_text text NOT NULL,
  variables jsonb NOT NULL,
  fingerprint text NOT NULL,
  made_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

CREATE TABLE IF NOT EXISTS mail_campaign_lists (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  source text NOT NULL,
  consent_basis text NOT NULL CHECK (consent_basis IN ('CONSENT', 'CUSTOMER', 'B2B', 'CONTACT', 'IMPORTED')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_campaign_lists_owner_name ON mail_campaign_lists (owner_user_id, lower(name));

CREATE TABLE IF NOT EXISTS mail_campaign_contacts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address text NOT NULL,
  domain text NOT NULL,
  name text NOT NULL,
  attributes jsonb NOT NULL,
  health text NOT NULL CHECK (health IN ('VALID', 'RISKY', 'UNKNOWN', 'INVALID', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED')),
  health_reasons jsonb NOT NULL,
  health_checked_at timestamptz,
  soft_bounces integer NOT NULL DEFAULT 0,
  last_engaged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, address)
);
CREATE INDEX IF NOT EXISTS mail_campaign_contacts_health ON mail_campaign_contacts (owner_user_id, health_checked_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS mail_campaign_list_members (
  list_id text NOT NULL REFERENCES mail_campaign_lists(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES mail_campaign_contacts(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX IF NOT EXISTS mail_campaign_list_members_contact ON mail_campaign_list_members (contact_id);

CREATE TABLE IF NOT EXISTS mail_campaign_suppressions (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('UNSUBSCRIBE', 'HARD_BOUNCE', 'COMPLAINT', 'DO_NOT_CONTACT', 'MANUAL')),
  source text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, pattern)
);

CREATE TABLE IF NOT EXISTS mail_campaigns (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  name text NOT NULL,
  goal text NOT NULL,
  template_id text NOT NULL REFERENCES mail_campaign_templates(id),
  template_version integer NOT NULL,
  sender_id text NOT NULL REFERENCES mail_campaign_senders(id),
  list_ids text[] NOT NULL,
  schedule jsonb NOT NULL,
  pacing jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'TESTING', 'IN_REVIEW', 'APPROVED', 'SENDING', 'PAUSED', 'DONE', 'STOPPED')),
  fingerprint text,
  approval jsonb,
  audience jsonb,
  test_seeds jsonb NOT NULL,
  pause_reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_campaigns_owner ON mail_campaigns (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS mail_campaigns_sending ON mail_campaigns (status) WHERE status = 'SENDING';

CREATE TABLE IF NOT EXISTS mail_campaign_sends (
  campaign_id text NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES mail_campaign_contacts(id),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED', 'UNKNOWN')),
  skip_reason text,
  message_id text,
  provider_id text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  error text,
  bounce jsonb,
  complained_at timestamptz,
  replied_at timestamptz,
  unsubscribed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS mail_campaign_sends_pending ON mail_campaign_sends (campaign_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS mail_campaign_sends_contact ON mail_campaign_sends (owner_user_id, contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS mail_campaign_sends_message ON mail_campaign_sends (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_campaign_checks (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id text REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  sender_id text REFERENCES mail_campaign_senders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS', 'WARN', 'FAIL')),
  score double precision,
  details jsonb NOT NULL,
  fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_campaign_checks_campaign ON mail_campaign_checks (owner_user_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mail_campaign_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id text REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  type text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_campaign_events_owner ON mail_campaign_events (owner_user_id, created_at DESC);
