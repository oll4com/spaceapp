-- Demo Projects: catalog selections, isolated demo runs, connector operations.
-- Secrets never land here: only credential references and non-sensitive metadata.

CREATE TABLE demo_preferences (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  variant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SAMPLE','LIVE')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id)
);

CREATE TABLE demo_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  variant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SAMPLE','LIVE')),
  status text NOT NULL CHECK (status IN ('STOPPED','STARTING','RUNNING','FAILED','CONNECTION_REQUIRED')),
  port integer CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
  pid integer,
  preview_token text NOT NULL,
  run_token_hash text NOT NULL,
  workspace_path text NOT NULL,
  data_path text NOT NULL,
  log_path text NOT NULL,
  health jsonb,
  last_error text,
  started_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX demo_runs_owner_idx ON demo_runs (owner_user_id, project_id, created_at DESC);
CREATE INDEX demo_runs_active_idx ON demo_runs (status) WHERE status IN ('STARTING','RUNNING');

CREATE TABLE demo_connections (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('salesforce','google-sheets')),
  status text NOT NULL CHECK (status IN ('UNCONFIGURED','CONNECTED','NEEDS_RECONNECT','ERROR')),
  label text NOT NULL DEFAULT '',
  detail text,
  client_id text,
  login_url text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_ref text,
  connected_at timestamptz,
  last_refreshed_at timestamptz,
  last_checked_at timestamptz,
  safe_error_code text,
  safe_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, provider)
);

CREATE TABLE demo_oauth_attempts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('salesforce','google-sheets')),
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  verifier_ref text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX demo_oauth_attempts_expiry_idx ON demo_oauth_attempts (expires_at);

CREATE TABLE demo_sheets_targets (
  owner_user_id text PRIMARY KEY,
  spreadsheet_id text NOT NULL,
  spreadsheet_url text,
  title text,
  tab text NOT NULL DEFAULT 'Sheet1',
  header_present boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demo_operations (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  operation_key text NOT NULL,
  project_id text NOT NULL,
  variant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SAMPLE','LIVE')),
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','SYNCED','FAILED','PARTIAL')),
  account_name text NOT NULL,
  contact_last_name text NOT NULL,
  first_name text,
  email text,
  phone text,
  website text,
  salesforce_account_id text,
  salesforce_contact_id text,
  salesforce_instance_url text,
  sheets_row integer,
  sheets_verified_at timestamptz,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, operation_key)
);

CREATE INDEX demo_operations_queue_idx ON demo_operations (status, next_attempt_at);
CREATE INDEX demo_operations_owner_idx ON demo_operations (owner_user_id, project_id, created_at DESC);

CREATE TABLE demo_test_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  variant_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('SAMPLE','LIVE')),
  status text NOT NULL CHECK (status IN ('PASSED','FAILED')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX demo_test_runs_owner_idx ON demo_test_runs (owner_user_id, project_id, created_at DESC);
