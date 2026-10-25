ALTER TABLE room_agent_requests
  ADD COLUMN request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN direct_action jsonb CHECK (direct_action IS NULL OR jsonb_typeof(direct_action) = 'object');
