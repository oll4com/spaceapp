-- Database connections registry for SpaceApp native database manager.
CREATE TABLE IF NOT EXISTS database_connections (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_path text,
  name text NOT NULL,
  engine text NOT NULL CHECK (engine IN ('POSTGRES', 'MYSQL', 'SQLITE')),
  host text,
  port integer,
  database text,
  username text,
  encrypted_credentials text,
  ssl boolean NOT NULL DEFAULT false,
  filename text,
  is_internal boolean NOT NULL DEFAULT false,
  is_read_only boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_database_connections_owner ON database_connections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_database_connections_project ON database_connections(project_path);
