CREATE TABLE IF NOT EXISTS admin_operation_runs (
  id text PRIMARY KEY,
  operation_type text NOT NULL CHECK (
    operation_type IN ('CLI_MAINTENANCE_CHECK', 'CLI_MAINTENANCE_UPDATE', 'SPACE_RELEASE')
  ),
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_operation_runs_type_created
  ON admin_operation_runs (operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_operation_runs_active
  ON admin_operation_runs (created_at ASC)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS source_control_connections (
  provider text PRIMARY KEY CHECK (provider IN ('gitea', 'github')),
  repository_owner text NOT NULL CHECK (repository_owner = 'oll4com'),
  repository_name text NOT NULL CHECK (
    (provider = 'gitea' AND repository_name = 'spaceapp-rooms')
    OR (provider = 'github' AND repository_name = 'space')
  ),
  account_login text,
  connection_status text NOT NULL CHECK (connection_status IN ('DISCONNECTED', 'CONNECTED', 'ERROR')),
  secret_ref text,
  last_verified_at timestamptz,
  last_verification_code text NOT NULL CHECK (
    last_verification_code IN (
      'NOT_VERIFIED',
      'VERIFIED',
      'INVALID_TOKEN',
      'INSUFFICIENT_PERMISSION',
      'PROVIDER_UNAVAILABLE'
    )
  ),
  updated_at timestamptz NOT NULL
);

INSERT INTO source_control_connections (
  provider,
  repository_owner,
  repository_name,
  account_login,
  connection_status,
  secret_ref,
  last_verified_at,
  last_verification_code,
  updated_at
)
VALUES
  ('gitea', 'oll4com', 'spaceapp-rooms', NULL, 'DISCONNECTED', NULL, NULL, 'NOT_VERIFIED', now()),
  ('github', 'oll4com', 'space', NULL, 'DISCONNECTED', NULL, NULL, 'NOT_VERIFIED', now())
ON CONFLICT (provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS release_previews (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  tag text NOT NULL CHECK (tag ~ '^v20[0-9]{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[1-9][0-9]*$'),
  notes text NOT NULL CHECK (length(notes) BETWEEN 1 AND 20000),
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  previous_tag text,
  remote_main_commits jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_previews_expires_at ON release_previews (expires_at);
