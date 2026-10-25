ALTER TABLE space_agent_sessions
  ADD COLUMN IF NOT EXISTS permission_mode text;

ALTER TABLE space_agent_sessions
  ADD COLUMN IF NOT EXISTS collaboration_mode text;

ALTER TABLE space_agent_sessions
  DROP CONSTRAINT IF EXISTS space_agent_sessions_permission_mode_check;

ALTER TABLE space_agent_sessions
  ADD CONSTRAINT space_agent_sessions_permission_mode_check
  CHECK (permission_mode IS NULL OR permission_mode IN ('ask_for_approval', 'approve_for_me', 'full_access'));

ALTER TABLE space_agent_sessions
  DROP CONSTRAINT IF EXISTS space_agent_sessions_collaboration_mode_check;

ALTER TABLE space_agent_sessions
  ADD CONSTRAINT space_agent_sessions_collaboration_mode_check
  CHECK (collaboration_mode IS NULL OR collaboration_mode IN ('default', 'plan'));
