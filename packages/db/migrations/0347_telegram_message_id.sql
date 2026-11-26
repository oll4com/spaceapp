-- «Εισερχόμενα» v2 step 4b (plan clipboard:aE7U1J_gU9OV): the chat message a delivery became (its last part), so a Thread answered
-- in SpaceApp edits it to "✓ Answered" (its buttons go with the old text).
ALTER TABLE telegram_notification_outbox ADD COLUMN IF NOT EXISTS message_id text;
