CREATE TABLE IF NOT EXISTS import_candidates (
  id text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('CODEX_MEMORY', 'CODEX_SKILL', 'OPERATOR_NOTE', 'MARKDOWN')),
  target_kind text NOT NULL CHECK (target_kind IN ('MEMORY', 'SKILL')),
  status text NOT NULL CHECK (status IN ('PENDING', 'IMPORTED', 'REJECTED')),
  status_reason text,
  source_ref text NOT NULL,
  room_id text REFERENCES rooms(id) ON DELETE SET NULL,
  memory_scope text NOT NULL CHECK (memory_scope IN ('ROOM', 'PROJECT', 'SYSTEM')),
  title text NOT NULL,
  body text NOT NULL,
  provenance text NOT NULL,
  skill_version text,
  skill_trigger_description text,
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_memory_id text REFERENCES memory_records(id) ON DELETE SET NULL,
  imported_skill_id text REFERENCES skills(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_import_candidates_status_created ON import_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_candidates_target_created ON import_candidates(target_kind, created_at DESC);
