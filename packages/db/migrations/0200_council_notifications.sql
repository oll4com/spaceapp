-- The Research Council raises Space notifications (it needs the operator's answers or approval, a run finished or failed).
ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'ROOM_AGENT', 'COUNCIL', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
