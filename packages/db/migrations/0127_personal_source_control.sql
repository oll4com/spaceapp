-- Personal Git connections deliberately never inherit installation release credentials.
CREATE TABLE IF NOT EXISTS personal_git_connections (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github','gitea')),
  data jsonb NOT NULL,
  PRIMARY KEY (owner_user_id,provider)
);
CREATE TABLE IF NOT EXISTS project_repository_bindings (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_path text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS project_repository_bindings_owner ON project_repository_bindings(owner_user_id);
