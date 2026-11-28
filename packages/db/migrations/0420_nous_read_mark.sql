-- Operator nous_msg:443bb5d5: the Conversation's last-read mark, one per owner, shared by the web dock and the Nous app. A row made by a
-- read mark alone has no Clear (cleared_at NULL); Clear conversation still sets it to now().
ALTER TABLE nous_conversation_marks ADD COLUMN IF NOT EXISTS read_up_to TIMESTAMPTZ;
ALTER TABLE nous_conversation_marks ALTER COLUMN cleared_at DROP NOT NULL;
