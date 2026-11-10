-- Team knowledge is class A. Explicit admin deletes keep seed tombstones; no automatic pruning.
CREATE TABLE nous_shared_memory (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('SEED','NOUS','ADMIN')),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED','ACTIVE','RETIRED')),
  introduced_version TEXT NOT NULL, seed_key TEXT, seed_hash TEXT, content_hash TEXT NOT NULL,
  admin_modified BOOLEAN NOT NULL DEFAULT FALSE, deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, seed_key)
);
CREATE UNIQUE INDEX nous_shared_memory_content ON nous_shared_memory(team_id, content_hash) WHERE seed_key IS NULL;
CREATE INDEX nous_shared_memory_team_status ON nous_shared_memory(team_id, status) WHERE NOT deleted;
CREATE TABLE nous_shared_memory_policy (
  team_id TEXT PRIMARY KEY, auto_approve BOOLEAN NOT NULL DEFAULT FALSE, daily_upgrade BOOLEAN NOT NULL DEFAULT TRUE,
  last_daily_day TEXT
);
