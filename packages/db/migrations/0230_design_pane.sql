-- Design pane (clipboard PLAN clipboard:URdc3U314lUH): pane settings and view on the existing DESIGN mode; the operator's own
-- brand kits (the SpaceApp kit is a code constant); requests from other agents and panes (a queue a Design pane takes and
-- delivers); the assets it made (a Media artifact each, pinned while in the library); its activity feed; and the DESIGN
-- notification source. A NULL design_metadata reads as the defaults, so old DESIGN rows stay valid.
ALTER TABLE panes ADD COLUMN IF NOT EXISTS design_metadata jsonb;
ALTER TABLE panes ADD CONSTRAINT panes_design_metadata_object
  CHECK (design_metadata IS NULL OR (jsonb_typeof(design_metadata) = 'object' AND design_metadata->>'version' = '1'));

CREATE TABLE IF NOT EXISTS design_brand_kits (
  id text PRIMARY KEY CHECK (id ~ '^dbrand:[A-Za-z0-9_-]{6,80}$' AND id <> 'dbrand:spaceapp'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  colors jsonb NOT NULL CHECK (jsonb_typeof(colors) = 'object'),
  fonts jsonb NOT NULL CHECK (jsonb_typeof(fonts) = 'object'),
  logos text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(logos) <= 4),
  voice text CHECK (voice IS NULL OR char_length(voice) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_brand_kits_owner_idx ON design_brand_kits(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS design_requests (
  id text PRIMARY KEY CHECK (id ~ '^dreq:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  design_pane_id text,
  requester jsonb NOT NULL CHECK (jsonb_typeof(requester) = 'object'),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 1 AND 4000),
  format_ids text[] NOT NULL CHECK (cardinality(format_ids) BETWEEN 1 AND 8),
  engine text CHECK (engine IS NULL OR engine IN ('NANO_BANANA','NANO_BANANA_PRO','GPT_IMAGE','TEMPLATE','MOTION')),
  brand_kit_id text,
  reference_artifact_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(reference_artifact_ids) <= 3),
  callback jsonb CHECK (callback IS NULL OR jsonb_typeof(callback) = 'object'),
  status text NOT NULL CHECK (status IN ('QUEUED','TAKEN','IN_PROGRESS','NEEDS_APPROVAL','DELIVERED','FAILED','CANCELLED')),
  result_asset_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(result_asset_ids) <= 32),
  question text CHECK (question IS NULL OR char_length(question) <= 2000),
  answer text CHECK (answer IS NULL OR char_length(answer) <= 2000),
  message text CHECK (message IS NULL OR char_length(message) <= 2000),
  taken_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_requests_owner_idx ON design_requests(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS design_requests_open_idx ON design_requests(owner_user_id, created_at)
  WHERE status IN ('QUEUED','TAKEN','IN_PROGRESS','NEEDS_APPROVAL');

CREATE TABLE IF NOT EXISTS design_assets (
  id text PRIMARY KEY CHECK (id ~ '^dasset:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  request_id text REFERENCES design_requests(id) ON DELETE SET NULL,
  artifact_id text NOT NULL CHECK (artifact_id ~ '^artifact:[A-Za-z0-9_-]{6,80}$'),
  format_id text NOT NULL CHECK (char_length(format_id) BETWEEN 1 AND 40),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif','video/mp4')),
  engine text NOT NULL CHECK (engine IN ('NANO_BANANA','NANO_BANANA_PRO','GPT_IMAGE','TEMPLATE','MOTION','UPLOAD')),
  model text CHECK (model IS NULL OR char_length(model) <= 120),
  label text CHECK (label IS NULL OR char_length(label) <= 200),
  prompt text CHECK (prompt IS NULL OR char_length(prompt) <= 4000),
  template_id text CHECK (template_id IS NULL OR char_length(template_id) <= 60),
  params jsonb CHECK (params IS NULL OR jsonb_typeof(params) = 'object'),
  brand_kit_id text,
  parent_asset_id text REFERENCES design_assets(id) ON DELETE SET NULL,
  pinned boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_assets_owner_idx ON design_assets(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS design_assets_request_idx ON design_assets(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS design_assets_parent_idx ON design_assets(parent_asset_id) WHERE parent_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS design_events (
  id text PRIMARY KEY CHECK (id ~ '^devt:[A-Za-z0-9_-]{6,80}$'),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pane_id text,
  request_id text,
  asset_id text,
  type text NOT NULL CHECK (type IN ('REQUEST_CREATED','REQUEST_TAKEN','IMAGE_GENERATED','RENDERED','ASSET_SAVED','ASSET_DELETED','QUESTION','ANSWER',
    'APPROVAL_REQUESTED','APPROVED','DELIVERED','FAILED','CANCELLED','SETTINGS_CHANGED','BRAND_KIT_CHANGED','RUN_STARTED','NOTE')),
  message text NOT NULL CHECK (char_length(message) <= 2000),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS design_events_owner_idx ON design_events(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS design_events_request_idx ON design_events(request_id, created_at) WHERE request_id IS NOT NULL;

ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
