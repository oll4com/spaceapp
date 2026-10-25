CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('OPERATOR', 'ADMIN')),
  password_hash text,
  totp_secret_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  pane_cap integer NOT NULL DEFAULT 16 CHECK (pane_cap BETWEEN 1 AND 16),
  trace_id text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS panes (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  provider_id text,
  model_id text,
  reasoning_effort text NOT NULL DEFAULT 'medium',
  cwd text,
  pane_order integer NOT NULL,
  is_maximized boolean NOT NULL DEFAULT false,
  is_closed boolean NOT NULL DEFAULT false,
  split jsonb NOT NULL DEFAULT '{"parentId": null, "direction": null, "size": null}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id text PRIMARY KEY,
  run_id text,
  type text NOT NULL,
  task_queue text NOT NULL,
  status text NOT NULL,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS turns (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  workflow_id text REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  provider_id text,
  model_id text,
  status text NOT NULL,
  prompt_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  room_id text REFERENCES rooms(id) ON DELETE CASCADE,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  turn_id text REFERENCES turns(id) ON DELETE SET NULL,
  workflow_id text REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  event_type text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS providers (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  provider_type text NOT NULL,
  status text NOT NULL,
  status_reason text,
  masked_key_prefix text,
  base_url text,
  health_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  status text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  transport text NOT NULL,
  status text NOT NULL,
  schema_version text NOT NULL,
  config_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  schema_hash text NOT NULL,
  approval_required boolean NOT NULL DEFAULT true,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skills (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  version text NOT NULL,
  status text NOT NULL,
  trigger_description text NOT NULL,
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_records (
  id text PRIMARY KEY,
  scope text NOT NULL,
  room_id text REFERENCES rooms(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  provenance text NOT NULL,
  confidence numeric(4, 3),
  sensitivity text NOT NULL DEFAULT 'internal',
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  turn_id text REFERENCES turns(id) ON DELETE SET NULL,
  workflow_id text REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  kind text NOT NULL,
  mime_type text NOT NULL,
  storage_uri text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  pane_id text REFERENCES panes(id) ON DELETE SET NULL,
  workflow_id text REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  tool_id text,
  risk_level text NOT NULL,
  status text NOT NULL,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  workflow_id text REFERENCES workflows(workflow_id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('SHIP', 'BLOCK', 'NEEDS_HUMAN')),
  summary text NOT NULL,
  evidence_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rollback_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trace_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_panes_room_open ON panes(room_id, is_closed, pane_order);
CREATE INDEX IF NOT EXISTS idx_events_room_created ON events(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status, started_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_trace ON artifacts(room_id, workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;
