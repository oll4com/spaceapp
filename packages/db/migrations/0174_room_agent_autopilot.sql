-- Room Agent autopilot: whether the Room Agent answers its panes' prompts by itself (no row = on).
ALTER TABLE room_agent_monitor_settings ADD COLUMN IF NOT EXISTS autopilot_enabled boolean NOT NULL DEFAULT true;
