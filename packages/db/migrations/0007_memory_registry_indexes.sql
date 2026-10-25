CREATE INDEX IF NOT EXISTS idx_memory_records_scope_created
  ON memory_records(scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_records_room_created
  ON memory_records(room_id, created_at DESC)
  WHERE room_id IS NOT NULL;
