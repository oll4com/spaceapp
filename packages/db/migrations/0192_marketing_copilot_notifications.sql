-- Marketing Copilot raises Space notifications (reviews, questions, proposals, failed and published posts).
ALTER TABLE space_notifications DROP CONSTRAINT IF EXISTS space_notifications_source_check;
ALTER TABLE space_notifications ADD CONSTRAINT space_notifications_source_check
  CHECK (source IN ('MAIL_COPILOT', 'JOB_COPILOT', 'MARKETING_COPILOT', 'ROOM_AGENT', 'BROWSER_HANDOFF', 'ROOM_WATCHDOG', 'SYSTEM'));
