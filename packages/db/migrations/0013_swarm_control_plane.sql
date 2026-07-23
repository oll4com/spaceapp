CREATE TABLE IF NOT EXISTS swarm_tasks (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  parent_task_id text REFERENCES swarm_tasks(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('PLANNER', 'WORKER', 'REVIEWER')),
  title text NOT NULL,
  goal text NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED', 'READY', 'RUNNING', 'BLOCKED', 'DONE', 'CANCELLED')),
  assignee text,
  depends_on_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  lock_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_swarm_tasks_room_status_updated ON swarm_tasks(room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_tasks_room_role_updated ON swarm_tasks(room_id, role, updated_at DESC);

CREATE TABLE IF NOT EXISTS swarm_locks (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id text REFERENCES swarm_tasks(id) ON DELETE SET NULL,
  resource text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
  holder text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_locks_active_resource
  ON swarm_locks(room_id, resource)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_swarm_locks_room_status_created ON swarm_locks(room_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS swarm_messages (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id text REFERENCES swarm_tasks(id) ON DELETE SET NULL,
  from_role text NOT NULL CHECK (from_role IN ('PLANNER', 'WORKER', 'REVIEWER')),
  to_role text CHECK (to_role IN ('PLANNER', 'WORKER', 'REVIEWER')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swarm_messages_room_created ON swarm_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_messages_task_created ON swarm_messages(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS swarm_reconciles (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_ids jsonb NOT NULL,
  decision text NOT NULL CHECK (decision IN ('MERGED', 'BLOCKED', 'NEEDS_HUMAN')),
  summary text NOT NULL,
  next_steps text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swarm_reconciles_room_created ON swarm_reconciles(room_id, created_at DESC);
