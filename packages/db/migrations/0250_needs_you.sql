-- Needs you (operator request 2026-10-24): one attention request for every agent. A plain CLI pane's `space-progress needs-you`
-- raises an AGENT notification (source 'AGENT'), a Claude pane's "Question for you" prompt is its own Room Agent event kind
-- (QUESTION, routed to the operator even while Nous works), and the pane report status NEEDS_YOU joins the list.
ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'FREELANCE_COPILOT', 'DESIGN', 'APP_STUDIO', 'VIDEO', 'SECURITY_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'NOUS', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM', 'AGENT'));
ALTER TABLE room_agent_events DROP CONSTRAINT IF EXISTS room_agent_events_kind_check;
ALTER TABLE room_agent_events ADD CONSTRAINT room_agent_events_kind_check
  CHECK (kind IN ('FINISHED', 'WAITING', 'QUESTION', 'ERROR', 'USAGE_LIMIT', 'SIGN_IN', 'STUCK', 'OVERLAP'));
ALTER TABLE pane_reports DROP CONSTRAINT IF EXISTS pane_reports_status_check;
ALTER TABLE pane_reports ADD CONSTRAINT pane_reports_status_check
  CHECK (status IN ('STARTED', 'PROGRESS', 'BLOCKED', 'NEEDS_DECISION', 'NEEDS_YOU', 'WAITING', 'DONE', 'FAILED', 'TURN_END', 'TODO', 'HEARTBEAT', 'QUESTION'));
