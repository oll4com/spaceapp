ALTER TABLE room_agent_bindings
  ADD COLUMN IF NOT EXISTS transcript_cleared_at timestamptz;

ALTER TABLE room_agent_requests
  ADD COLUMN IF NOT EXISTS mission_id text REFERENCES room_agent_missions(mission_id) ON DELETE CASCADE;

ALTER TABLE room_agent_requests
  ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'MISSION'
    CHECK (request_kind IN ('MISSION', 'FOLLOW_UP'));

UPDATE room_agent_requests requests
SET mission_id = missions.mission_id
FROM room_agent_missions missions
WHERE missions.request_id = requests.request_id
  AND requests.mission_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_room_agent_requests_mission_created
  ON room_agent_requests(mission_id, created_at ASC)
  WHERE mission_id IS NOT NULL;

ALTER TABLE room_agent_missions
  DROP CONSTRAINT IF EXISTS room_agent_missions_status_check;

ALTER TABLE room_agent_missions
  ADD CONSTRAINT room_agent_missions_status_check
  CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'INTERRUPTED'));

ALTER TABLE room_agent_missions
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

ALTER TABLE room_agent_missions
  ADD COLUMN IF NOT EXISTS total_paused_ms bigint NOT NULL DEFAULT 0 CHECK (total_paused_ms >= 0);

ALTER TABLE room_agent_missions
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;

ALTER TABLE room_agent_missions
  ADD COLUMN IF NOT EXISTS execution_state jsonb NOT NULL DEFAULT '{}'::jsonb;
