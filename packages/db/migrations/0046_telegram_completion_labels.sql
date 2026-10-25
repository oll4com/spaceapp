ALTER TABLE telegram_notification_outbox
  ADD COLUMN agent_label text,
  ADD COLUMN task_title text;

UPDATE telegram_notification_outbox
SET agent_label = CASE source_type
      WHEN 'ROOM_AGENT' THEN 'Room Agent'
      WHEN 'TERMINAL' THEN 'Codex Terminal'
      WHEN 'CHAT' THEN 'Codex Chat'
      ELSE 'Space'
    END,
    task_title = left(pane_title, 120)
WHERE agent_label IS NULL OR task_title IS NULL;

ALTER TABLE telegram_notification_outbox
  ALTER COLUMN agent_label SET DEFAULT 'Agent 1',
  ALTER COLUMN task_title SET DEFAULT 'Untitled task',
  ALTER COLUMN agent_label SET NOT NULL,
  ALTER COLUMN task_title SET NOT NULL;

ALTER TABLE telegram_notification_outbox
  ADD CONSTRAINT telegram_notification_outbox_agent_label_check
    CHECK (char_length(agent_label) BETWEEN 1 AND 160),
  ADD CONSTRAINT telegram_notification_outbox_task_title_check
    CHECK (char_length(task_title) BETWEEN 1 AND 120);
